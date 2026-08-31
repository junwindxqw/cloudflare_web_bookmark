/**
 * 通用工具：响应包装、请求体解析、会话 Cookie、哈希与随机数
 */

export const SESSION_COOKIE = 'cb_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 会话有效期 30 天

export class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function ok(data, extraHeaders = {}) {
  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

export function fail(message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function readJsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new ApiError('请求体必须是 JSON', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError('请求体必须是 JSON 对象', 400);
  }
  return body;
}

export function cleanStr(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/** 从请求头解析 Cookie 值 */
export function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return '';
}

export function isHttps(request) {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function sessionCookie(token, maxAgeSec = SESSION_TTL_SECONDS, secure = true) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure = true) {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function randomHex(byteLength) {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out;
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
