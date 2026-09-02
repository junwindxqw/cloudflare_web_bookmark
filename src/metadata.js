/**
 * 网站元信息抓取：图标 / 标题 / 描述
 *
 * 安全约定：
 *  - 服务端仅抓取公网 http/https 地址，拒绝本地回环、内网与保留 IP（防 SSRF）
 *  - 重定向逐跳重新校验，避免公网地址 302 跳内网
 *  - 所有 HTML 解析均使用静态正则 + match/matchAll，避免字符串拼接进 RegExp 构造器
 */

import { ApiError } from './util.js';

const LIMITS = { url: 2048, title: 300, description: 1000, icon_url: 2048 };
const FETCH_TIMEOUT_MS = 10_000;
const ICON_TIMEOUT_MS = 6_000;
const MAX_HTML_BYTES = 400 * 1024;
const MAX_REDIRECTS = 4;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 CloudBookmark/1.0';

/* ------------------------- URL 校验（防 SSRF） ------------------------- */

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // 本网络 / 私网 / 回环
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24、TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // 组播与保留段
  return false;
}

function isPrivateIPv6(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 链路本地
  const dotted = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) return isPrivateIPv4(dotted[1]);
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return isPrivateIPv4(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
  }
  if (/^64:ff9b:/.test(h)) return true; // NAT64（最终映射 IPv4）
  return false;
}

export function isPrivateHost(hostname) {
  const h = (hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'localhost.localdomain') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (h.includes(':')) return isPrivateIPv6(h);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIPv4(h);
  // 纯数字 / 十六进制形式的 IP（如 2130706433、0x7f000001）一律按内网处理
  if (/^0x[0-9a-f]+$/i.test(h) || /^\d+$/.test(h)) return true;
  return false;
}

/**
 * 解析并校验“仅公网 http/https”的 URL。
 * @returns {URL|null} 合法返回 URL 对象，否则返回 null
 */
export function parsePublicHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  if (isPrivateHost(url.hostname)) return null;
  return url;
}

/** 归一化用户输入的网址：补协议、去 hash、去默认端口 */
export function normalizeUrlInput(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s; // 显式带协议时不再补 https://（否则 ftp:// 等会被误拼）
  if (s.length > LIMITS.url) return null;
  const url = parsePublicHttpUrl(s);
  if (!url) return null;
  url.hash = '';
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  const path = url.pathname === '/' ? '' : url.pathname;
  try {
    return new URL(url.origin + path + url.search);
  } catch {
    return null;
  }
}

/* ----------------------------- 安全抓取 ----------------------------- */

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抓取公网地址：仅 http/https，逐跳校验重定向目标，防止被重定向到内网。
 * @returns {{ res: Response, finalUrl: string }}
 */
async function safeFetch(urlStr, { timeoutMs = FETCH_TIMEOUT_MS, maxRedirects = MAX_REDIRECTS, headers = {} } = {}) {
  let current = urlStr;
  for (let i = 0; i <= maxRedirects; i++) {
    const url = parsePublicHttpUrl(current);
    if (!url) {
      throw new ApiError('仅允许抓取公网 http/https 地址，已拒绝本地、内网与保留地址', 400);
    }
    const res = await fetchWithTimeout(
      url,
      {
        redirect: 'manual',
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers },
      },
      timeoutMs,
    );
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (location) {
        try {
          current = new URL(location, url).href;
        } catch {
          throw new ApiError('目标网站返回了无效的重定向地址', 502);
        }
        continue;
      }
    }
    return { res, finalUrl: url.href };
  }
  throw new ApiError('目标网站重定向次数过多', 502);
}

/** 读取响应体前 maxBytes 字节（避免为一个大页面浪费流量） */
async function readBytesLimited(res, maxBytes) {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 忽略 */
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function sniffCharset(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048));
  const m =
    head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i) ||
    head.match(/encoding\s*=\s*["']\s*([\w-]+)/i); // XML 声明
  return m ? m[1].toLowerCase() : '';
}

function decodeBytes(bytes, label) {
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return ''; // 运行时不支持该编码
  }
}

function countReplacement(s) {
  return (s.match(/\uFFFD/g) || []).length;
}

async function readHtmlLimited(res, maxBytes) {
  const bytes = await readBytesLimited(res, maxBytes);
  const utf8 = decodeBytes(bytes, 'utf-8');
  const declared = sniffCharset(bytes);
  if (!declared || declared === 'utf-8' || declared === 'utf8') return utf8;
  const alt = decodeBytes(bytes, declared);
  if (!alt) return utf8;
  // 以“替换符更少”的解码结果为准（charset 声明与实际编码不符时兜底）
  return countReplacement(alt) < countReplacement(utf8) ? alt : utf8;
}

/* --------------------------- HTML 元信息解析 --------------------------- */

// 所有正则均为静态定义；扫描标签用 match/matchAll，不使用可变 lastIndex 的循环方式
const ATTR_RE = /(?<![\w-])([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const META_TAG_RE = /<meta\b[^>]*>/gi;
const LINK_TAG_RE = /<link\b[^>]*>/gi;

export function decodeEntities(s) {
  if (!s) return '';
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function safeFromCodePoint(num) {
  if (!Number.isFinite(num) || num < 0 || num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff)) return '';
  try {
    return String.fromCodePoint(num);
  } catch {
    return '';
  }
}

/** 从单个标签字符串中按属性名取值（属性名大小写不敏感） */
function getAttr(tag, name) {
  const target = name.toLowerCase();
  for (const m of tag.matchAll(ATTR_RE)) {
    if (m[1].toLowerCase() === target) return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return '';
}

/** 收集页面里全部 <meta> 的 name/property → content */
function collectMetas(html) {
  const metas = [];
  for (const tag of html.match(META_TAG_RE) ?? []) {
    const name = getAttr(tag, 'name') || getAttr(tag, 'property') || getAttr(tag, 'itemprop');
    if (name) metas.push({ name: name.toLowerCase(), content: getAttr(tag, 'content') });
  }
  return metas;
}

function metaByName(metas, name) {
  const found = metas.find((m) => m.name === name);
  return found ? found.content : '';
}

export function collectIconCandidates(html) {
  const links = [];
  for (const tag of html.match(LINK_TAG_RE) ?? []) {
    const rel = getAttr(tag, 'rel').toLowerCase();
    const href = getAttr(tag, 'href');
    if (!href || !rel) continue;
    const isIcon = /(^|\s)icon(\s|$)/.test(rel) || rel.includes('apple-touch-icon');
    if (!isIcon) continue;
    const sizes = getAttr(tag, 'sizes');
    const sizeMatch = sizes.match(/(\d+)\s*x\s*(\d+)/i);
    let px = 0;
    if (sizeMatch) {
      px = Math.max(Number(sizeMatch[1]), Number(sizeMatch[2]));
    } else if (rel.includes('apple-touch-icon')) {
      px = 180;
    } else if (/\.svg($|[?#])/i.test(href) || getAttr(tag, 'type').includes('svg')) {
      px = 64;
    }
    // 得分：apple-touch-icon / 大尺寸优先，明确的 icon 高于 shortcut icon
    let score = 1;
    if (px >= 64) score = 3;
    else if (px >= 24) score = 2;
    links.push({ href, px, score });
  }
  links.sort((a, b) => b.score - a.score || b.px - a.px);
  const seen = new Set();
  const out = [];
  for (const l of links) {
    if (!seen.has(l.href)) {
      seen.add(l.href);
      out.push(l.href);
    }
  }
  return out;
}

export function extractMeta(html, baseUrl) {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]{0,500}?)<\/title>/i);
  const metas = collectMetas(html);
  const title =
    decodeEntities(titleMatch ? titleMatch[1] : '') ||
    metaByName(metas, 'og:title') ||
    metaByName(metas, 'twitter:title');

  const description =
    metaByName(metas, 'description') ||
    metaByName(metas, 'og:description') ||
    metaByName(metas, 'twitter:description');

  const candidates = collectIconCandidates(html)
    .map((href) => {
      try {
        return new URL(href, baseUrl).href;
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  return { title: title.slice(0, LIMITS.title), description: description.slice(0, LIMITS.description), candidates };
}

/* ------------------------------ 图标解析 ------------------------------ */

async function looksLikeImage(res) {
  if (!res.ok) return false;
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!type) return true; // 个别站点不给 content-type，保守放行
  return type.startsWith('image/') || type.includes('octet-stream');
}

async function resolveIcon(candidates, pageUrl) {
  // 1. 页面里声明的 data:image 内联图标（体积小才收录）
  for (const href of candidates) {
    if (/^data:image\//i.test(href) && href.length <= 8192) return href;
  }
  // 2. 候选图标逐个验证（最多 3 个）
  const abs = [];
  for (const href of candidates) {
    if (abs.length >= 3) break;
    if (/^data:/i.test(href)) continue;
    const url = parsePublicHttpUrl(href);
    if (url) abs.push(url.href);
  }
  // 3. 站点根路径 /favicon.ico 兜底
  const fallback = parsePublicHttpUrl(pageUrl.origin + '/favicon.ico');
  if (fallback && !abs.includes(fallback.href)) abs.push(fallback.href);

  for (const candidate of abs) {
    try {
      const { res } = await safeFetch(candidate, {
        timeoutMs: ICON_TIMEOUT_MS,
        headers: { accept: 'image/*,*/*;q=0.8' },
      });
      if (!(await looksLikeImage(res))) continue;
      const len = Number(res.headers.get('content-length') || '0');
      if (len === 0) {
        const head = await readBytesLimited(res, 16);
        if (head.length === 0) continue;
      } else if (len > 512 * 1024) {
        continue; // 太大，放弃
      }
      return candidate;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return '';
}

/* ---------------------------- 元信息抓取 ---------------------------- */

export async function fetchMetadata(urlStr) {
  const { res, finalUrl } = await safeFetch(urlStr, {
    headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  const pageUrl = new URL(finalUrl);
  const result = { url: finalUrl, title: '', description: '', icon_url: '' };

  // 非 2xx 一律显式报错：静默兜底会让"获取失败"在前端伪装成成功（如 Cloudflare 挑战页）
  if (!res.ok) {
    const cfChallenge = (res.headers.get('cf-mitigated') || '').toLowerCase() === 'challenge';
    const err = new ApiError(
      cfChallenge
        ? '目标站点开启了 Cloudflare 人机验证，无法自动抓取，请手动填写标题与描述'
        : `目标网站返回 HTTP ${res.status}，无法自动抓取`,
      502,
    );
    // 部分站点（如 GitHub）对数据中心出口的 bot 拦截是间歇性的，这类状态码值得重试
    err.retryable = !cfChallenge && (res.status === 403 || res.status === 429 || res.status >= 500);
    throw err;
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('xhtml')) {
    const html = await readHtmlLimited(res, MAX_HTML_BYTES);
    const meta = extractMeta(html, pageUrl);
    result.title = meta.title;
    result.description = meta.description;
    result.icon_url = await resolveIcon(meta.candidates, pageUrl);
  }

  if (!result.title) {
    // 非 HTML 或无标题时，用域名兜底
    result.title = pageUrl.hostname.replace(/^www\./, '');
  }
  return result;
}

export async function tryFetchMetadata(urlStr) {
  // 最多 3 次：403/429 等拦截往往是间歇性的，短暂退避后大概率能命中放行窗口
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchMetadata(urlStr);
    } catch (err) {
      if (!err?.retryable || attempt >= 2) return null; // 抓取失败不阻塞书签的保存
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
}
