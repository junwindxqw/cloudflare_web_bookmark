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
import { classifyBookmark } from './category.js';

const LIMITS = { title: 300, description: 1000, icon_url: 2048, category: 32 };

/** 服务端分类白名单：与 src/category.js 的 CATEGORIES 同步；非白名单视为"自动" */
const VALID_CATEGORY_IDS = new Set([
  'tech', 'ai', 'ai-chat', 'ai-image', 'ai-dev',
  'design', 'tools', 'news', 'finance', 'life', 'study',
  'shopping', 'video', 'social', 'reading', 'career', 'cloud', 'other',
]);

/** 清洗用户提交的 category：白名单外的值视为空（→ 后端自动分类） */
function sanitizeCategory(value) {
  const s = cleanStr(value, LIMITS.category);
  return VALID_CATEGORY_IDS.has(s) ? s : '';
}

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
    category    TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    UNIQUE (user_id, url)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)',
];

// 列补充与依赖这些列的索引分开：先 ALTER TABLE 加上列，再尝试建索引，
// 这样老库（v1 单用户版 / 中途升级版）缺少 user_id / category 列时，
// 索引创建不会因为 "no such column" 整体失败。
const POST_ALTER_INDEX_STATEMENTS = [
  'CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks (user_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_bookmarks_category ON bookmarks (user_id, category)',
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
      // 自动分类：补 category 列（已存在时忽略报错）
      try {
        await env.DB.prepare("ALTER TABLE bookmarks ADD COLUMN category TEXT NOT NULL DEFAULT ''").run();
      } catch {
        /* 列已存在 */
      }
      // 列补齐后再尝试建依赖列的索引；个别极端情况下若仍未成功也不致命
      for (const sql of POST_ALTER_INDEX_STATEMENTS) {
        try {
          await env.DB.prepare(sql).run();
        } catch {
          /* 列缺失等极端情况静默 */
        }
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
    category: row.category || '',
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
  const inputCategory = sanitizeCategory(body.category);

  let meta = null;
  if (!inputTitle || !inputDesc || !inputIcon) meta = await tryFetchMetadata(url.href);

  const now = new Date().toISOString();
  const host = url.hostname.replace(/^www\./, '');
  const resolvedTitle = inputTitle || meta?.title || host;
  const record = {
    url: url.href,
    title: resolvedTitle,
    description: inputDesc || meta?.description || '',
    icon_url: inputIcon || meta?.icon_url || '',
    category: inputCategory || classifyBookmark({ url: url.href, title: resolvedTitle, description: inputDesc || meta?.description || '' }),
  };
  const res = await env.DB.prepare(
    'INSERT INTO bookmarks (user_id, url, title, description, icon_url, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(user.id, record.url, record.title, record.description, record.icon_url, record.category, now, now)
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

  // 分类：显式提交非空 → 用提交值；空串 → 视为"自动"，按当前 url/title/desc 重判；未提交 → 保留原值
  const finalTitle = title || host;
  let category;
  if (body.category !== undefined) {
    const submitted = sanitizeCategory(body.category);
    if (submitted) category = submitted;
    else category = classifyBookmark({ url, title: finalTitle, description });
  } else {
    category = row.category || classifyBookmark({ url, title: finalTitle, description });
  }

  const record = {
    url,
    title: finalTitle,
    description,
    icon_url: iconUrl,
    category,
  };
  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE bookmarks SET url = ?, title = ?, description = ?, icon_url = ?, category = ?, updated_at = ? WHERE id = ?',
  )
    .bind(record.url, record.title, record.description, record.icon_url, record.category, now, id)
    .run();
  return { id, ...record, created_at: row.created_at, updated_at: now };
}

async function deleteBookmark(env, user, id) {
  await getOwnedBookmark(env, user, id);
  const res = await env.DB.prepare('DELETE FROM bookmarks WHERE id = ?').bind(id).run();
  if (!res.meta.changes) throw new ApiError('书签不存在', 404);
  return { id };
}

/**
 * 一键自动分类：把当前用户尚未分类（category=''）的书签按词典重判并写回。
 * 管理员可显式传 body.force=true 覆盖已有分类；普通用户无视 force，避免越权覆盖。
 */
async function classifyAllBookmarks(request, env, user) {
  let body = {};
  try {
    body = await readJsonObject(request);
  } catch {
    /* body 可选，空对象也合法 */
  }
  const force = body?.force === true && user.role === 'admin';

  const where = force
    ? 'SELECT id, url, title, description, category FROM bookmarks WHERE user_id = ?'
    : "SELECT id, url, title, description, category FROM bookmarks WHERE user_id = ? AND (category = '' OR category IS NULL)";
  const { results } = await env.DB.prepare(where).bind(user.id).all();
  if (!results.length) return { updated: 0, results: [] };

  const statements = [];
  const changes = [];
  for (const row of results) {
    const next = classifyBookmark({ url: row.url, title: row.title, description: row.description });
    if (!force && next === (row.category || '')) continue;
    statements.push(
      env.DB.prepare('UPDATE bookmarks SET category = ? WHERE id = ? AND user_id = ?').bind(next, row.id, user.id),
    );
    changes.push({ id: row.id, category: next });
  }

  // D1 batch 一次最多 50 条；超过则分批
  for (let i = 0; i < statements.length; i += 50) {
    const slice = statements.slice(i, i + 50);
    if (slice.length) await env.DB.batch(slice);
  }
  return { updated: changes.length, results: changes };
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
  if (pathname === '/api/bookmarks/classify-all' && method === 'POST') {
    return ok(await classifyAllBookmarks(request, env, user));
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
