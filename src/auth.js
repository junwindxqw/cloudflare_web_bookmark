/**
 * 多用户认证：
 *  - 邮箱 + 4 位验证码注册（首个注册用户自动成为管理员）
 *  - 邮箱 + 密码登录 / 登出 / 找回密码
 *  - D1 会话（HttpOnly Cookie，30 天）
 *  - 安全限制：验证码 10 分钟有效、错 5 次作废、同邮箱 60s 冷却、同 IP 每小时限发 10 封、
 *    登录连续失败 5 次锁定 15 分钟
 *
 * 密码哈希：PBKDF2-SHA256，格式 pbkdf2_sha256$iterations$salt$hash。
 * 免费版 Worker 有 10ms CPU 限制，默认 1 万次迭代（原生实现约几毫秒）；
 * 付费版可通过环境变量 PBKDF2_ITERATIONS 提高。
 */

import {
  ApiError,
  ok,
  readJsonObject,
  cleanStr,
  getCookie,
  isHttps,
  sessionCookie,
  clearSessionCookie,
  randomHex,
  sha256Hex,
  isValidEmail,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from './util.js';
import { sendVerificationEmail } from './mail.js';

const CODE_TTL_MS = 10 * 60 * 1000; // 验证码有效期
const CODE_RESEND_COOLDOWN_MS = 60 * 1000; // 同邮箱重发冷却
const CODE_MAX_ATTEMPTS = 5; // 验证码最大试错次数
const LOGIN_MAX_FAILS = 5; // 登录连续失败锁定阈值
const LOGIN_LOCK_MS = 15 * 60 * 1000; // 登录锁定时长
const SEND_CODE_LIMIT_PER_HOUR = 10; // 同 IP 每小时发码上限
const PASSWORD_MAX = 128;

function pbkdf2Iterations(env) {
  // 免费版 Worker 有 10ms CPU 限制，默认 1 万次迭代；付费版可通过环境变量调高
  const n = Number(env.PBKDF2_ITERATIONS);
  return Number.isInteger(n) && n >= 1000 ? n : 10_000;
}

function publicUser(row) {
  return { id: row.id, email: row.email, role: row.role, created_at: row.created_at };
}

/* --------------------------- 密码哈希与校验 --------------------------- */

function bytesToB64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function pbkdf2(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    keyMaterial,
    256,
  );
  return bytesToB64(new Uint8Array(bits));
}

export async function hashPassword(env, password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const iterations = pbkdf2Iterations(env);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${bytesToB64(salt)}$${hash}`;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, stored) {
  const parts = (stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  let actual;
  try {
    actual = await pbkdf2(password, b64ToBytes(parts[2]), iterations);
  } catch {
    return false;
  }
  return timingSafeEqual(actual, parts[3]);
}

/* ------------------------------- 会话 ------------------------------- */

async function createSession(env, userId) {
  const token = randomHex(32);
  const now = new Date();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(await sha256Hex(token), userId, new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(), now.toISOString())
    .run();
  return token;
}

/** 从 Cookie 解析当前登录用户；未登录或会话过期抛 401 */
export async function requireUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) throw new ApiError('未登录', 401);
  const row = await env.DB.prepare(
    'SELECT u.id, u.email, u.role, u.created_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
  )
    .bind(await sha256Hex(token))
    .first();
  if (!row || row.expires_at <= new Date().toISOString()) {
    throw new ApiError('未登录或登录已过期', 401);
  }
  return { id: row.id, email: row.email, role: row.role, created_at: row.created_at };
}

function authResponse(data, request, token) {
  return ok(data, { 'set-cookie': sessionCookie(token, SESSION_TTL_SECONDS, isHttps(request)) });
}

/* --------------------------- 验证码与限流 --------------------------- */

function fourDigitCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += String(b % 10);
  return out;
}

async function issueEmailCode(env, email, purpose) {
  const now = Date.now();
  const existing = await env.DB.prepare('SELECT * FROM email_codes WHERE email = ?').bind(email).first();
  if (existing && now - Date.parse(existing.created_at) < CODE_RESEND_COOLDOWN_MS) {
    throw new ApiError('验证码发送过于频繁，请 1 分钟后再试', 429);
  }
  const code = fourDigitCode();
  await env.DB.prepare(
    'INSERT INTO email_codes (email, code, purpose, expires_at, attempts, created_at) VALUES (?, ?, ?, ?, 0, ?) ' +
      'ON CONFLICT(email) DO UPDATE SET code = excluded.code, purpose = excluded.purpose, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at',
  )
    .bind(email, code, purpose, new Date(now + CODE_TTL_MS).toISOString(), new Date(now).toISOString())
    .run();
  return code;
}

/** 校验并消费验证码；不匹配递增试错计数 */
async function consumeEmailCode(env, email, purpose, code) {
  const row = await env.DB.prepare('SELECT * FROM email_codes WHERE email = ?').bind(email).first();
  if (!row || row.purpose !== purpose) throw new ApiError('请先获取验证码', 400);
  if (Date.parse(row.expires_at) < Date.now()) {
    await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
    throw new ApiError('验证码已过期，请重新获取', 400);
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) throw new ApiError('错误次数过多，请重新获取验证码', 429);
  if (row.code !== code) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    throw new ApiError('验证码错误', 400);
  }
  await env.DB.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
}

/** 计数式限流（如按 IP 限发码）。返回 { limited } */
async function throttleHit(env, key, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT * FROM auth_throttle WHERE key = ?').bind(key).first();
  const fresh = row && now - Date.parse(row.window_start) < windowMs;
  const count = fresh ? row.count + 1 : 1;
  const windowStart = fresh ? row.window_start : new Date(now).toISOString();
  await env.DB.prepare(
    'INSERT INTO auth_throttle (key, count, window_start) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start',
  )
    .bind(key, count, windowStart)
    .run();
  return { limited: count > limit };
}

async function loginLocked(env, email) {
  const row = await env.DB.prepare('SELECT * FROM auth_throttle WHERE key = ?').bind('login:' + email).first();
  return Boolean(row && row.count >= LOGIN_MAX_FAILS && Date.now() - Date.parse(row.window_start) < LOGIN_LOCK_MS);
}

async function recordLoginFail(env, email) {
  const key = 'login:' + email;
  const now = Date.now();
  const row = await env.DB.prepare('SELECT * FROM auth_throttle WHERE key = ?').bind(key).first();
  const fresh = row && now - Date.parse(row.window_start) < LOGIN_LOCK_MS;
  const count = fresh ? row.count + 1 : 1;
  const windowStart = fresh ? row.window_start : new Date(now).toISOString();
  await env.DB.prepare(
    'INSERT INTO auth_throttle (key, count, window_start) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start',
  )
    .bind(key, count, windowStart)
    .run();
}

async function clearLoginFails(env, email) {
  await env.DB.prepare('DELETE FROM auth_throttle WHERE key = ?').bind('login:' + email).run();
}

function normalizeEmail(value) {
  return cleanStr(value, 200).toLowerCase();
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new ApiError('密码至少需要 8 位', 400);
  }
  if (password.length > PASSWORD_MAX) {
    throw new ApiError(`密码最多 ${PASSWORD_MAX} 位`, 400);
  }
}

/* ------------------------------- 路由 ------------------------------- */

export async function handleAuthApi(request, env, url) {
  const method = request.method;
  const path = url.pathname;

  if (method === 'POST' && path === '/api/auth/register/start') return registerStart(request, env);
  if (method === 'POST' && path === '/api/auth/register/finish') return registerFinish(request, env);
  if (method === 'POST' && path === '/api/auth/login') return login(request, env);
  if (method === 'POST' && path === '/api/auth/logout') return logout(request, env);
  if (method === 'GET' && path === '/api/auth/me') return me(request, env);
  if (method === 'POST' && path === '/api/auth/reset/start') return resetStart(request, env);
  if (method === 'POST' && path === '/api/auth/reset/finish') return resetFinish(request, env);
  throw new ApiError('接口不存在', 404);
}

async function registerStart(request, env) {
  const body = await readJsonObject(request);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) throw new ApiError('邮箱格式不正确', 400);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) throw new ApiError('该邮箱已注册，请直接登录', 409);

  // 同 IP 限发（本地开发没有 CF 头，跳过）
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) {
    const t = await throttleHit(env, 'sendip:' + ip, SEND_CODE_LIMIT_PER_HOUR, 60 * 60 * 1000);
    if (t.limited) throw new ApiError('发送过于频繁，请稍后再试', 429);
  }

  const code = await issueEmailCode(env, email, 'register');
  const { dev } = await sendVerificationEmail(env, email, code, 'register');
  await env.DB.prepare('DELETE FROM email_codes WHERE expires_at < ?').bind(new Date().toISOString()).run();
  return ok({ sent: true, ...(dev ? { devCode: code } : {}) });
}

async function registerFinish(request, env) {
  const body = await readJsonObject(request);
  const email = normalizeEmail(body.email);
  const code = cleanStr(body.code, 8);
  assertPassword(body.password);
  if (!isValidEmail(email)) throw new ApiError('邮箱格式不正确', 400);
  if (!/^\d{4}$/.test(code)) throw new ApiError('请输入 4 位数字验证码', 400);

  await consumeEmailCode(env, email, 'register', code);

  const dup = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (dup) throw new ApiError('该邮箱已被注册，请直接登录', 409);

  const countRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  const isFirst = (countRow?.n ?? 0) === 0;
  const role = isFirst ? 'admin' : 'user';
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    'INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(email, await hashPassword(env, body.password), role, now)
    .run();
  const userId = res.meta.last_row_id;

  // 从旧版单用户升级而来时，首个（管理员）用户自动认领历史书签
  if (isFirst) {
    await env.DB.prepare('UPDATE bookmarks SET user_id = ? WHERE user_id = 0').bind(userId).run();
  }

  const token = await createSession(env, userId);
  return authResponse({ user: { id: userId, email, role, created_at: now } }, request, token);
}

async function login(request, env) {
  const body = await readJsonObject(request);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) throw new ApiError('请输入邮箱和密码', 400);

  if (await loginLocked(env, email)) {
    throw new ApiError('登录失败次数过多，请 15 分钟后再试', 429);
  }
  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const valid = row ? await verifyPassword(password, row.password_hash) : false;
  if (!valid) {
    await recordLoginFail(env, email);
    throw new ApiError('邮箱或密码错误', 401);
  }
  await clearLoginFails(env, email);
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run();

  const token = await createSession(env, row.id);
  return authResponse({ user: publicUser(row) }, request, token);
}

async function logout(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  return ok({}, { 'set-cookie': clearSessionCookie(isHttps(request)) });
}

async function me(request, env) {
  try {
    const user = await requireUser(request, env);
    return ok({ user });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return ok({ user: null });
    throw err;
  }
}

async function resetStart(request, env) {
  const body = await readJsonObject(request);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) throw new ApiError('邮箱格式不正确', 400);

  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!row) {
    // 不泄露邮箱是否存在
    return ok({ sent: true });
  }

  const ip = request.headers.get('cf-connecting-ip');
  if (ip) {
    const t = await throttleHit(env, 'sendip:' + ip, SEND_CODE_LIMIT_PER_HOUR, 60 * 60 * 1000);
    if (t.limited) throw new ApiError('发送过于频繁，请稍后再试', 429);
  }

  const code = await issueEmailCode(env, email, 'reset');
  const { dev } = await sendVerificationEmail(env, email, code, 'reset');
  return ok({ sent: true, ...(dev ? { devCode: code } : {}) });
}

async function resetFinish(request, env) {
  const body = await readJsonObject(request);
  const email = normalizeEmail(body.email);
  const code = cleanStr(body.code, 8);
  assertPassword(body.password);
  if (!isValidEmail(email)) throw new ApiError('邮箱格式不正确', 400);
  if (!/^\d{4}$/.test(code)) throw new ApiError('请输入 4 位数字验证码', 400);

  await consumeEmailCode(env, email, 'reset', code);
  const row = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (!row) throw new ApiError('验证码错误或已失效', 400);

  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(env, body.password), row.id)
    .run();
  // 密码重置后强制所有设备重新登录，并解除登录失败锁定（已通过邮箱验证身份）
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.id).run();
  await clearLoginFails(env, email);
  return ok({});
}

/* ------------------------------ 管理员 ------------------------------ */

export async function handleAdminApi(request, env, url) {
  const user = await requireUser(request, env);
  if (user.role !== 'admin') throw new ApiError('需要管理员权限', 403);

  if (request.method === 'GET' && url.pathname === '/api/admin/users') {
    const { results } = await env.DB.prepare(
      'SELECT u.id, u.email, u.role, u.created_at, COUNT(b.id) AS bookmark_count ' +
        'FROM users u LEFT JOIN bookmarks b ON b.user_id = u.id GROUP BY u.id ORDER BY u.id',
    ).all();
    return ok({ users: results });
  }

  const m = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (m && request.method === 'DELETE') {
    const id = Number(m[1]);
    if (id === user.id) throw new ApiError('不能删除当前登录的账号', 400);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
    ]);
    return ok({ id });
  }
  throw new ApiError('接口不存在', 404);
}
