/**
 * 云书签 · Cloud Bookmark — Worker 入口（多用户版）
 *
 * 职责：
 *  - /api/auth/*   注册（邮箱验证码）/ 登录 / 登出 / 找回密码        —— 公开
 *  - /api/admin/*  用户管理（仅管理员）
 *  - /api/bookmarks、/api/metadata                              —— 需登录，数据按用户隔离
 *  - 其余请求交给 Workers 静态资源（见 wrangler.jsonc 的 assets 配置）
 *
 * 环境变量（可选）：
 *  - RESEND_API_KEY / MAIL_FROM  邮件发送（见 src/mail.js 与 README）
 *  - MAIL_DEV_MODE               本地调试：验证码直接随 API 返回，不真实发信
 *  - PBKDF2_ITERATIONS           密码哈希迭代次数（默认 10000，免费版 CPU 限制下的保守值）
 */

import { ApiError, ok, fail, readJsonObject, cleanStr } from './util.js';
import { requireUser, handleAuthApi, handleAdminApi } from './auth.js';
import { fetchMetadata, tryFetchMetadata, normalizeUrlInput } from './metadata.js';

const LIMITS = { title: 300, description: 1000, icon_url: 2048 };

// 建表语句全部幂等；老库（v1 单用户版）通过 ALTER 补 user_id 列自动迁移
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'user',
    created_at    TEXT    NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at TEXT    NOT NULL,
    created_at TEXT    NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS email_codes (
    email      TEXT PRIMARY KEY,
    code       TEXT NOT NULL,
    purpose    TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_throttle (
    key          TEXT    PRIMARY KEY,
    count        INTEGER NOT NULL,
    window_start TEXT    NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL DEFAULT 0,
    url         TEXT    NOT NULL,
    title       TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    icon_url    TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    UNIQUE (user_id, url)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks (user_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)',
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of SCHEMA_STATEMENTS) {
        await env.DB.prepare(sql).run();
      }
      // v1 单用户库迁移：补 user_id 列（已存在时忽略报错）
      try {
        await env.DB.prepare('ALTER TABLE bookmarks ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0').run();
      } catch {
        /* 列已存在 */
      }
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/* ------------------------------ 书签 CRUD ------------------------------ */

function toBookmark(row) {
  return {
    id: row.id,
    url: row.url,
    title: row.title || '',
    description: row.description || '',
    icon_url: row.icon_url || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listBookmarks(env, user) {
  const { results } = await env.DB.prepare('SELECT * FROM bookmarks WHERE user_id = ? ORDER BY id DESC')
    .bind(user.id)
    .all();
  return results.map(toBookmark);
}

async function createBookmark(request, env, user) {
  const body = await readJsonObject(request);
  const url = normalizeUrlInput(body.url);
  if (!url) throw new ApiError('网址无效：请输入公网 http/https 地址', 400);

  const existing = await env.DB.prepare('SELECT id FROM bookmarks WHERE url = ? AND user_id = ?')
    .bind(url.href, user.id)
    .first();
  if (existing) throw new ApiError('该书签已存在', 409);

  const inputTitle = cleanStr(body.title, LIMITS.title);
  const inputDesc = cleanStr(body.description, LIMITS.description);
  const inputIcon = cleanStr(body.icon_url, LIMITS.icon_url);

  let meta = null;
  if (!inputTitle || !inputDesc || !inputIcon) meta = await tryFetchMetadata(url.href);

  const now = new Date().toISOString();
  const record = {
    url: url.href,
    title: inputTitle || meta?.title || url.hostname.replace(/^www\./, ''),
    description: inputDesc || meta?.description || '',
    icon_url: inputIcon || meta?.icon_url || '',
  };
  const res = await env.DB.prepare(
    'INSERT INTO bookmarks (user_id, url, title, description, icon_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(user.id, record.url, record.title, record.description, record.icon_url, now, now)
    .run();
  return { id: res.meta.last_row_id, ...record, created_at: now, updated_at: now };
}

/** 取书签并校验权限：本人或管理员 */
async function getOwnedBookmark(env, user, id) {
  const row = await env.DB.prepare('SELECT * FROM bookmarks WHERE id = ?').bind(id).first();
  if (!row) throw new ApiError('书签不存在', 404);
  if (row.user_id !== user.id && user.role !== 'admin') {
    throw new ApiError('无权操作其他用户的书签', 403);
  }
  return row;
}

async function updateBookmark(request, env, user, id) {
  const body = await readJsonObject(request);
  const row = await getOwnedBookmark(env, user, id);

  let url = row.url;
  if (body.url !== undefined) {
    const normalized = normalizeUrlInput(body.url);
    if (!normalized) throw new ApiError('网址无效：请输入公网 http/https 地址', 400);
    url = normalized.href;
    if (url !== row.url) {
      const dup = await env.DB.prepare('SELECT id FROM bookmarks WHERE url = ? AND user_id = ? AND id != ?')
        .bind(url, row.user_id, id)
        .first();
      if (dup) throw new ApiError('已存在相同网址的书签', 409);
    }
  }
  const urlChanged = url !== row.url;

  // refetch=true 或网址变更且未显式给出标题/描述时，用抓取结果补全留空/缺失的字段
  let meta = null;
  if (body.refetch === true || (urlChanged && body.title === undefined && body.description === undefined)) {
    meta = await tryFetchMetadata(url);
  }

  // 前端对话框总是显式提交三个字段（可能为空串），因此合并规则是"提交值优先、抓取结果补空"；
  // 标题为空或仍是裸域名兜底（之前抓取失败的痕迹）时，refetch 成功即可用真实标题覆盖
  const host = new URL(url).hostname.replace(/^www\./, '');
  let title = body.title !== undefined ? cleanStr(body.title, LIMITS.title) : row.title;
  const description =
    (body.description !== undefined
      ? cleanStr(body.description, LIMITS.description)
      : row.description) || meta?.description || '';
  const iconUrl =
    (body.icon_url !== undefined ? cleanStr(body.icon_url, LIMITS.icon_url) : row.icon_url) || meta?.icon_url || '';
  if (meta?.title && (!title || title === host)) title = meta.title;

  const record = {
    url,
    title: title || host,
    description,
    icon_url: iconUrl,
  };
  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE bookmarks SET url = ?, title = ?, description = ?, icon_url = ?, updated_at = ? WHERE id = ?',
  )
    .bind(record.url, record.title, record.description, record.icon_url, now, id)
    .run();
  return { id, ...record, created_at: row.created_at, updated_at: now };
}

async function deleteBookmark(env, user, id) {
  await getOwnedBookmark(env, user, id);
  const res = await env.DB.prepare('DELETE FROM bookmarks WHERE id = ?').bind(id).run();
  if (!res.meta.changes) throw new ApiError('书签不存在', 404);
  return { id };
}

/* ------------------------------- 路由 ------------------------------- */

async function route(request, env, url) {
  const method = request.method;
  const { pathname } = url;

  // 公开接口：认证
  if (pathname.startsWith('/api/auth/')) {
    return handleAuthApi(request, env, url);
  }

  // 以下接口全部需要登录
  const user = await requireUser(request, env);

  if (pathname === '/api/bookmarks' && method === 'GET') {
    return ok(await listBookmarks(env, user));
  }
  if (pathname === '/api/bookmarks' && method === 'POST') {
    return ok(await createBookmark(request, env, user));
  }

  const match = pathname.match(/^\/api\/bookmarks\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    if (method === 'PUT' || method === 'PATCH') return ok(await updateBookmark(request, env, user, id));
    if (method === 'DELETE') return ok(await deleteBookmark(env, user, id));
  }

  if (pathname === '/api/metadata' && method === 'POST') {
    const body = await readJsonObject(request);
    const target = normalizeUrlInput(body.url);
    if (!target) throw new ApiError('网址无效：请输入公网 http/https 地址', 400);
    return ok(await fetchMetadata(target.href));
  }

  if (pathname.startsWith('/api/admin/')) {
    return handleAdminApi(request, env, url);
  }

  throw new ApiError('接口不存在', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    try {
      await ensureSchema(env);
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof ApiError) return fail(err.message, err.status);
      if (err?.name === 'AbortError') return fail('抓取目标网站超时，请稍后重试', 504);
      console.error('API error:', err);
      return fail('服务器内部错误', 500);
    }
  },
};
