/**
 * 云书签 · Cloud Bookmark — 前端逻辑（原生 JS，无框架）
 *
 * 页面两种状态：
 *  - 未登录：认证页（登录 / 注册 / 找回密码）
 *  - 已登录：书签应用（列表 / 添加 / 编辑 / 删除 / 搜索；管理员另有用户管理）
 *
 * 所有用户数据均用 DOM API / textContent 渲染，防 XSS。
 */
'use strict';

/* ------------------------------ 工具 ------------------------------ */

const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 注入内置静态 SVG（内容为代码内置，不含任何用户数据） */
function svgIcon(markup) {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup;
  return tpl.content.firstElementChild;
}

const ICON_EDIT =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_COPY =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_EXTERNAL =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^https?:\/\//i;

/* ------------------------------ 分类字典 ------------------------------ */
// 与 src/category.js 同源；部署 Worker 时随前端一起发版。
// 任何 id/label/颜色变更需两端同步。
const CATEGORIES = [
  { id: 'tech', label: '技术', color: '#3b82f6' },
  { id: 'ai', label: 'AI', color: '#a855f7' },
  { id: 'design', label: '设计', color: '#ec4899' },
  { id: 'tools', label: '工具', color: '#10b981' },
  { id: 'news', label: '新闻', color: '#f59e0b' },
  { id: 'life', label: '生活', color: '#f97316' },
  { id: 'study', label: '学习', color: '#0ea5e9' },
  { id: 'shopping', label: '购物', color: '#ef4444' },
  { id: 'video', label: '视频', color: '#dc2626' },
  { id: 'social', label: '社交', color: '#22c55e' },
  { id: 'reading', label: '阅读', color: '#8b5cf6' },
  { id: 'other', label: '其他', color: '#64748b' },
];
const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

/** 客户端轻量校验（服务端会再次严格校验） */
function guessUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return null;
  if (!URL_RE.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    return u;
  } catch {
    return null;
  }
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  } catch {
    throw new Error('网络请求失败，请检查连接后重试');
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok || !body || body.ok !== true) {
    const err = new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return body.data;
}

/** 转义 HTML 用于高亮显示 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 在文本中高亮子串（用于搜索命中），返回安全的 HTML 字符串 */
function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const q = query.trim();
  if (!q) return safe;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return safe.replace(re, (m) => `<mark class="search-hit">${m}</mark>`);
}

/** 异步复制文本到剪贴板 */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 退化方案 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 判断 mac 用户（用于快捷键提示） */
const IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/* ------------------------------ 元素与状态 ------------------------------ */

const els = {
  boot: $('#boot'),
  authView: $('#authView'),
  appView: $('#appView'),
  // 认证
  tabLogin: $('#tabLogin'),
  tabRegister: $('#tabRegister'),
  loginForm: $('#loginForm'),
  loginEmail: $('#loginEmail'),
  loginPassword: $('#loginPassword'),
  loginError: $('#loginError'),
  loginSubmit: $('#loginSubmit'),
  registerForm: $('#registerForm'),
  regEmail: $('#regEmail'),
  regSendBtn: $('#regSendBtn'),
  regCode: $('#regCode'),
  regPassword: $('#regPassword'),
  regConfirm: $('#regConfirm'),
  regHint: $('#regHint'),
  regError: $('#regError'),
  regSubmit: $('#regSubmit'),
  resetForm: $('#resetForm'),
  resetEmail: $('#resetEmail'),
  resetSendBtn: $('#resetSendBtn'),
  resetCode: $('#resetCode'),
  resetPassword: $('#resetPassword'),
  resetConfirm: $('#resetConfirm'),
  resetHint: $('#resetHint'),
  resetError: $('#resetError'),
  resetSubmit: $('#resetSubmit'),
  forgotLink: $('#forgotLink'),
  toRegisterLink: $('#toRegisterLink'),
  toLoginLink: $('#toLoginLink'),
  backToLoginLink: $('#backToLoginLink'),
  // 应用
  searchInput: $('#searchInput'),
  searchbox: $('#searchbox'),
  searchClear: $('#searchClear'),
  addBtn: $('#addBtn'),
  emptyAddBtn: $('#emptyAddBtn'),
  noMatchClearBtn: $('#noMatchClearBtn'),
  grid: $('#grid'),
  emptyState: $('#emptyState'),
  noMatch: $('#noMatch'),
  noMatchTitle: $('#noMatchTitle'),
  noMatchDesc: $('#noMatchDesc'),
  loading: $('#loading'),
  stats: $('#stats'),
  userEmail: $('#userEmail'),
  userMenuBtn: $('#userMenuBtn'),
  sortSelect: $('#sortSelect'),
  viewBtns: document.querySelectorAll('.view-btn'),
  // 分类
  categorySelect: $('#categorySelect'),
  classifyAllBtn: $('#classifyAllBtn'),
  categorySelectInForm: $('#categorySelectInForm'),
  // 对话框
  dialog: $('#bookmarkDialog'),
  dialogTitle: $('#dialogTitle'),
  form: $('#bookmarkForm'),
  urlInput: $('#urlInput'),
  fetchBtn: $('#fetchBtn'),
  fetchBtnLabel: $('#fetchBtn span'),
  titleInput: $('#titleInput'),
  descInput: $('#descInput'),
  iconPreviewWrap: $('#iconPreviewWrap'),
  iconPreview: $('#iconPreview'),
  iconPreviewText: $('#iconPreviewText'),
  formError: $('#formError'),
  cancelBtn: $('#cancelBtn'),
  saveBtn: $('#saveBtn'),
  usersDialog: $('#usersDialog'),
  usersList: $('#usersList'),
  usersCloseBtn: $('#usersCloseBtn'),
  confirmDialog: $('#confirmDialog'),
  confirmText: $('#confirmText'),
  confirmOk: $('#confirmOk'),
  confirmCancel: $('#confirmCancel'),
  // 用户菜单
  userMenu: $('#userMenu'),
  userMenuEmail: $('#userMenuEmail'),
  userMenuAdmin: $('#userMenuAdmin'),
  userMenuLogout: $('#userMenuLogout'),
  userMenuClose: $('#userMenuClose'),
  // 命令面板
  commandPanel: $('#commandPanel'),
  commandInput: $('#commandInput'),
  commandList: $('#commandList'),
  // 移动端抽屉
  mobileMenuBtn: $('#mobileMenuBtn'),
  mobileDrawer: $('#mobileDrawer'),
  mobileDrawerEmail: $('#mobileDrawerEmail'),
  mobileAddBtn: $('#mobileAddBtn'),
  mobileAdminBtn: $('#mobileAdminBtn'),
  mobileLogoutBtn: $('#mobileLogoutBtn'),
  // 提示
  toast: $('#toast'),
};

const state = {
  currentUser: null,
  bookmarks: [],
  editingId: null, // null = 新增模式
  iconUrl: '', // 对话框内当前已获取到的图标
  titleDirty: false,
  descDirty: false,
  lastFetchedUrl: '',
  fetching: false,
  confirmAction: null,
  view: loadPref('view', 'grid'),
  sort: loadPref('sort', 'created_desc'),
  categoryFilter: loadPref('cat', 'all'), // 'all' 或分类 id
};

/* ------------------------------ 偏好持久化 ------------------------------ */

function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem('cb.' + key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function savePref(key, value) {
  try {
    localStorage.setItem('cb.' + key, String(value));
  } catch { /* 忽略隐私模式 */ }
}

/* ------------------------------ 提示 ------------------------------ */

let toastTimer = null;
function toast(message, type = 'info') {
  els.toast.textContent = message;
  els.toast.className = `toast show${type === 'info' ? '' : ' ' + type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast';
  }, 2600);
}

function setFormError(el, message) {
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

/* ------------------------------ 认证 ------------------------------ */

function showBoot() {
  els.boot.classList.remove('hidden');
  els.authView.classList.add('hidden');
  els.appView.classList.add('hidden');
}

function showAuth(tab = 'login') {
  els.boot.classList.add('hidden');
  els.appView.classList.add('hidden');
  els.authView.classList.remove('hidden');
  switchAuthTab(tab);
}

function switchAuthTab(tab) {
  const forms = { login: els.loginForm, register: els.registerForm, reset: els.resetForm };
  for (const [name, form] of Object.entries(forms)) {
    form.classList.toggle('hidden', name !== tab);
    setFormError(form.querySelector('.form-error'), '');
  }
  els.tabLogin.classList.toggle('active', tab === 'login');
  els.tabRegister.classList.toggle('active', tab === 'register');
}

function enterApp(user) {
  state.currentUser = user;
  els.boot.classList.add('hidden');
  els.authView.classList.add('hidden');
  els.appView.classList.remove('hidden');
  els.userEmail.textContent = user.email;
  els.userEmail.title = user.email;
  els.userMenuBtn.textContent = (user.email[0] || '?').toUpperCase();
  els.userMenuBtn.title = user.email;
  els.userMenuEmail.textContent = user.email;
  els.mobileDrawerEmail.textContent = user.email;
  els.mobileAdminBtn.classList.toggle('hidden', user.role !== 'admin');
  applyView();
  els.sortSelect.value = state.sort;
  populateCategorySelect();
  els.loading.classList.remove('hidden');
  load();
}

/** 用词典填充「按分类筛选」下拉 + 「编辑对话框」下拉 */
function populateCategorySelect() {
  if (els.categorySelect) {
    els.categorySelect.replaceChildren(
      h('option', { value: 'all', text: '全部分类' }),
      ...CATEGORIES.map((c) =>
        h('option', { value: c.id, text: c.label }),
      ),
    );
    els.categorySelect.value = state.categoryFilter;
  }
  if (els.categorySelectInForm) {
    els.categorySelectInForm.replaceChildren(
      h('option', { value: '', text: '自动（按域名/关键词）' }),
      ...CATEGORIES.map((c) =>
        h('option', { value: c.id, text: c.label }),
      ),
    );
  }
}

function resetAuthForms() {
  els.loginForm.reset();
  els.registerForm.reset();
  els.resetForm.reset();
  for (const id of ['regHint', 'resetHint']) {
    const el = document.getElementById(id);
    el.textContent = '';
    el.classList.add('hidden');
  }
  stopAllCooldowns();
}

async function handleLogout() {
  closeUserMenu();
  closeMobileDrawer();
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* 退出登录失败也照样回登录页 */
  }
  state.currentUser = null;
  state.bookmarks = [];
  resetAuthForms();
  showAuth('login');
  toast('已退出登录');
}

/** 发送验证码按钮 60 秒冷却 */
const cooldowns = new Map();
function startCooldown(button, seconds = 60) {
  stopCooldown(button);
  let left = seconds;
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = `${left}s`;
  const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      stopCooldown(button);
    } else {
      button.textContent = `${left}s`;
    }
  }, 1000);
  cooldowns.set(button, timer);
}
function stopCooldown(button) {
  const timer = cooldowns.get(button);
  if (timer) {
    clearInterval(timer);
    cooldowns.delete(button);
  }
  button.disabled = false;
  if (button.dataset.label) button.textContent = button.dataset.label;
}
function stopAllCooldowns() {
  for (const button of cooldowns.keys()) stopCooldown(button);
}

async function sendCode(kind) {
  const isReg = kind === 'register';
  const input = isReg ? els.regEmail : els.resetEmail;
  const button = isReg ? els.regSendBtn : els.resetSendBtn;
  const hint = isReg ? els.regHint : els.resetHint;
  const email = input.value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    toast('请先输入正确的邮箱地址', 'error');
    input.focus();
    return;
  }
  button.disabled = true;
  try {
    const res = await api(`/api/auth/${kind}/start`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    hint.textContent = res.devCode
      ? `【开发模式】验证码：${res.devCode}（配置 RESEND_API_KEY 后将发送真实邮件）`
      : '验证码已发送，请查收邮箱（10 分钟内有效，注意垃圾邮件文件夹）';
    hint.classList.remove('hidden');
    toast('验证码已发送', 'success');
    startCooldown(button, 60);
  } catch (err) {
    button.disabled = false;
    toast(err.message, 'error');
  }
}

/* ------------------------------ 视图 / 排序 ------------------------------ */

function applyView() {
  const isList = state.view === 'list';
  els.grid.classList.toggle('grid', !isList);
  els.grid.classList.toggle('list', isList);
  els.grid.setAttribute('aria-label', isList ? '书签列表（列表视图）' : '书签列表（网格视图）');
  for (const btn of els.viewBtns) {
    btn.classList.toggle('active', btn.dataset.view === state.view);
  }
}

function applySort(list) {
  const sorted = list.slice();
  switch (state.sort) {
    case 'created_asc':
      sorted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      break;
    case 'title_asc':
      sorted.sort((a, b) => (a.title || hostOf(a.url)).localeCompare(b.title || hostOf(b.url), 'zh-Hans-CN'));
      break;
    case 'title_desc':
      sorted.sort((a, b) => (b.title || hostOf(b.url)).localeCompare(a.title || hostOf(a.url), 'zh-Hans-CN'));
      break;
    case 'host_asc':
      sorted.sort((a, b) => hostOf(a.url).localeCompare(hostOf(b.url)));
      break;
    case 'created_desc':
    default:
      sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  return sorted;
}

/* ------------------------------ 渲染 ------------------------------ */

function letterAvatar(host) {
  const clean = host.replace(/^www\./, '');
  const letter = (clean[0] || '?').toUpperCase();
  let hue = 0;
  for (const ch of clean) hue = (hue * 31 + ch.codePointAt(0)) % 360;
  return h('span', {
    class: 'bm-avatar',
    style: `background:hsl(${hue} 70% 88%);color:hsl(${hue} 65% 34%)`,
    text: letter,
  });
}

function iconNode(bm, query) {
  const host = hostOf(bm.url);
  const a = h('a', {
    class: 'bm-icon',
    href: bm.url,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: '在新标签页打开',
    'aria-label': `打开 ${bm.title || host}`,
  });
  if (bm.icon_url) {
    const img = h('img', { src: bm.icon_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(letterAvatar(host)));
    a.append(img);
  } else {
    a.append(letterAvatar(host));
  }
  return a;
}

function cardNode(bm, query) {
  const host = hostOf(bm.url);
  const card = h('article', { class: 'card' });
  const titleText = bm.title || host;
  const cardTitle = h('a', {
    class: 'card-title',
    href: bm.url,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: bm.title || bm.url,
  });
  // 用 innerHTML 一次性插入含高亮的标题（已转义安全）
  cardTitle.innerHTML = highlight(titleText, query) + (bm.title ? ' ' : '') +
    '<span style="display:inline-block;vertical-align:middle;opacity:0.55;margin-left:2px">' + ICON_EXTERNAL + '</span>';

  const metaParts = [];
  if (query) {
    metaParts.push('<span>' + highlight(host, query) + '</span>');
  } else {
    metaParts.push('<span>' + escapeHtml(host) + '</span>');
  }
  metaParts.push('<span class="dot">·</span>');
  metaParts.push('<span>' + escapeHtml(formatDate(bm.created_at)) + '</span>');

  const cardMeta = h('div', { class: 'card-meta' });
  cardMeta.innerHTML = metaParts.join(' ');

  // 分类标签：固定在卡片右上角，未分类则不渲染（空字符串视为未分类）
  const catId = bm.category && CATEGORY_MAP[bm.category] ? bm.category : '';
  const catLabel = catId ? CATEGORY_MAP[catId].label : '';

  // 复制链接反馈浮层
  const feedback = h('span', { class: 'copy-feedback', text: '已复制链接' });

  card.append(
    h('div', { class: 'card-head' },
      iconNode(bm, query),
      h('div', { class: 'card-text' },
        cardTitle,
        cardMeta,
      ),
      catId
        ? h('span', {
            class: 'card-category',
            'data-category': catId,
            title: `分类：${catLabel}`,
            text: catLabel,
          })
        : null,
    ),
    h('div', { class: 'card-actions' },
      h('button', {
        class: 'icon-btn',
        type: 'button',
        title: '复制链接',
        'aria-label': `复制 ${bm.title || host} 的链接`,
        onclick: async (ev) => {
          ev.stopPropagation();
          const ok = await copyToClipboard(bm.url);
          if (ok) {
            feedback.classList.add('show');
            clearTimeout(feedback._t);
            feedback._t = setTimeout(() => feedback.classList.remove('show'), 1400);
            toast('链接已复制', 'success');
          } else {
            toast('复制失败，请手动选择复制', 'error');
          }
        },
      }, svgIcon(ICON_COPY)),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        title: '编辑',
        'aria-label': '编辑书签',
        onclick: (ev) => { ev.stopPropagation(); openEditDialog(bm); },
      }, svgIcon(ICON_EDIT)),
      h('button', {
        class: 'icon-btn danger',
        type: 'button',
        title: '删除',
        'aria-label': '删除书签',
        onclick: (ev) => { ev.stopPropagation(); confirmDelete(bm); },
      }, svgIcon(ICON_TRASH)),
    ),
    feedback,
  );
  if (bm.description) {
    const desc = h('p', { class: 'card-desc' });
    desc.innerHTML = highlight(bm.description, query);
    card.append(desc);
  }
  return card;
}

function render() {
  const q = els.searchInput.value.trim().toLowerCase();
  let filtered = q
    ? state.bookmarks.filter((b) =>
        `${b.title} ${b.description} ${hostOf(b.url)}`.toLowerCase().includes(q),
      )
    : state.bookmarks;
  if (state.categoryFilter && state.categoryFilter !== 'all') {
    filtered = filtered.filter((b) => (b.category || 'other') === state.categoryFilter);
  }
  const list = applySort(filtered);

  els.grid.replaceChildren(...list.map((bm) => cardNode(bm, q)));

  const total = state.bookmarks.length;
  els.emptyState.classList.toggle('hidden', total > 0);
  els.noMatch.classList.toggle('hidden', !(total > 0 && filtered.length === 0));

  // 根据当前激活的过滤条件，动态改写"无匹配"提示与清空按钮文案
  if (total > 0 && filtered.length === 0) {
    const catActive = state.categoryFilter && state.categoryFilter !== 'all';
    if (q && catActive) {
      els.noMatchTitle.textContent = '没有同时匹配的书签';
      els.noMatchDesc.textContent = '当前关键词与分类下没有书签，试试清空其中一项。';
      els.noMatchClearBtn.textContent = '清空搜索与分类';
    } else if (catActive) {
      const lbl = CATEGORY_MAP[state.categoryFilter]?.label || '';
      els.noMatchTitle.textContent = `「${lbl}」下还没有书签`;
      els.noMatchDesc.textContent = '换个分类试试，或清空当前筛选。';
      els.noMatchClearBtn.textContent = '清空分类筛选';
    } else {
      els.noMatchTitle.textContent = '没有匹配的书签';
      els.noMatchDesc.textContent = '换个关键词试试，或清空搜索条件。';
      els.noMatchClearBtn.textContent = '清空搜索';
    }
  }

  const catLabel = state.categoryFilter !== 'all' && CATEGORY_MAP[state.categoryFilter]
    ? CATEGORY_MAP[state.categoryFilter].label
    : '';
  if (total === 0) {
    els.stats.innerHTML = '';
  } else if (q || catLabel) {
    els.stats.innerHTML =
      `匹配 <strong>${filtered.length}</strong> / 共 <strong>${total}</strong> 个书签` +
      (catLabel ? ` · 分类 <strong>${escapeHtml(catLabel)}</strong>` : '');
  } else {
    els.stats.innerHTML = `共 <strong>${total}</strong> 个书签`;
  }
}

async function load() {
  try {
    state.bookmarks = await api('/api/bookmarks');
  } catch (err) {
    state.bookmarks = [];
    if (err.status === 401) {
      // 会话过期，回到登录页
      state.currentUser = null;
      resetAuthForms();
      showAuth('login');
      toast('登录已过期，请重新登录', 'error');
      return;
    }
    toast(err.message, 'error');
  }
  render();
  els.loading.classList.add('hidden');
}

/* ------------------------------ 添加 / 编辑对话框 ------------------------------ */

function updateIconPreview() {
  const url = guessUrl(els.urlInput.value);
  const host = url ? url.hostname : '';
  if (state.iconUrl) {
    const img = h('img', { src: state.iconUrl, alt: '网站图标预览' });
    img.addEventListener('error', () => els.iconPreview.replaceChildren(letterAvatar(host)));
    els.iconPreview.replaceChildren(img);
    els.iconPreviewText.textContent = '将使用左侧网站图标';
  } else {
    els.iconPreview.replaceChildren(letterAvatar(host));
    els.iconPreviewText.textContent = '未获取到图标，保存后将用首字母头像代替';
  }
  els.iconPreviewWrap.classList.remove('hidden');
}

function resetDialogState() {
  state.iconUrl = '';
  state.titleDirty = false;
  state.descDirty = false;
  state.lastFetchedUrl = '';
  setFormError(els.formError, '');
  if (els.categorySelectInForm) els.categorySelectInForm.value = '';
}

function openAddDialog() {
  closeCommandPanel();
  resetDialogState();
  state.editingId = null;
  els.dialogTitle.childNodes[0].nodeValue = '添加书签';
  els.form.reset();
  els.saveBtn.textContent = '保存';
  els.iconPreviewWrap.classList.add('hidden');
  els.dialog.showModal();
  els.urlInput.focus();
}

function openEditDialog(bm) {
  resetDialogState();
  state.editingId = bm.id;
  state.iconUrl = bm.icon_url || '';
  state.lastFetchedUrl = bm.url;
  els.dialogTitle.childNodes[0].nodeValue = '编辑书签';
  els.urlInput.value = bm.url;
  els.titleInput.value = bm.title || '';
  els.descInput.value = bm.description || '';
  if (els.categorySelectInForm) {
    els.categorySelectInForm.value = bm.category || '';
  }
  els.saveBtn.textContent = '保存修改';
  if (state.iconUrl) updateIconPreview();
  else els.iconPreviewWrap.classList.add('hidden');
  els.dialog.showModal();
  els.urlInput.focus();
}

async function fetchMetaForDialog() {
  if (state.fetching) return;
  const raw = els.urlInput.value.trim();
  if (!raw) {
    setFormError(els.formError, '请先输入网址');
    els.urlInput.focus();
    return;
  }
  if (!guessUrl(raw)) {
    setFormError(els.formError, '网址格式不正确，请检查后重试');
    return;
  }
  state.fetching = true;
  els.fetchBtn.disabled = true;
  const original = els.fetchBtnLabel ? els.fetchBtnLabel.textContent : '获取信息';
  if (els.fetchBtnLabel) els.fetchBtnLabel.textContent = '获取中…';
  setFormError(els.formError, '');
  try {
    const meta = await api('/api/metadata', { method: 'POST', body: JSON.stringify({ url: raw }) });
    state.lastFetchedUrl = meta.url || raw;
    state.iconUrl = meta.icon_url || '';
    if (!state.titleDirty && meta.title) els.titleInput.value = meta.title;
    if (!state.descDirty) els.descInput.value = meta.description || '';
    updateIconPreview();
    toast('已获取网站信息', 'success');
  } catch (err) {
    updateIconPreview();
    toast(err.message, 'error');
  } finally {
    state.fetching = false;
    els.fetchBtn.disabled = false;
    if (els.fetchBtnLabel) els.fetchBtnLabel.textContent = original;
  }
}

// 输入网址后自动抓取（防抖），也可点击「获取信息」手动触发
let urlDebounce = null;
els.urlInput.addEventListener('input', () => {
  clearTimeout(urlDebounce);
  urlDebounce = setTimeout(() => {
    const url = guessUrl(els.urlInput.value);
    if (url && url.href !== state.lastFetchedUrl) fetchMetaForDialog();
  }, 900);
});

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const rawUrl = els.urlInput.value.trim();
  if (!rawUrl) {
    setFormError(els.formError, '请输入网址');
    els.urlInput.focus();
    return;
  }
  const payload = {
    url: rawUrl,
    title: els.titleInput.value.trim(),
    description: els.descInput.value.trim(),
    icon_url: state.iconUrl,
    category: els.categorySelectInForm ? els.categorySelectInForm.value : '',
    refetch: !state.iconUrl, // 没拿到图标时让服务端再尝试一次
  };
  els.saveBtn.disabled = true;
  try {
    if (state.editingId === null) {
      await api('/api/bookmarks', { method: 'POST', body: JSON.stringify(payload) });
      toast('书签已添加', 'success');
    } else {
      await api(`/api/bookmarks/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('书签已更新', 'success');
    }
    els.dialog.close();
    await load();
  } catch (err) {
    setFormError(els.formError, err.message);
  } finally {
    els.saveBtn.disabled = false;
  }
});

/* ------------------------------ 删除与确认 ------------------------------ */

function confirmAction(text, action) {
  els.confirmText.textContent = text;
  state.confirmAction = action;
  els.confirmDialog.showModal();
}

function confirmDelete(bm) {
  confirmAction(`确定要删除「${bm.title || hostOf(bm.url)}」吗？此操作无法撤销。`, async () => {
    await api(`/api/bookmarks/${bm.id}`, { method: 'DELETE' });
    toast('书签已删除', 'success');
    await load();
  });
}

els.confirmOk.addEventListener('click', async () => {
  const action = state.confirmAction;
  state.confirmAction = null;
  els.confirmDialog.close();
  if (!action) return;
  try {
    await action();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ------------------------------ 用户管理（管理员） ------------------------------ */

async function openUsersDialog() {
  closeUserMenu();
  els.usersDialog.showModal();
  els.usersList.replaceChildren(h('p', { class: 'user-row-meta', text: '加载中…' }));
  await renderUsers();
}

async function renderUsers() {
  try {
    const { users } = await api('/api/admin/users');
    els.usersList.replaceChildren(
      ...users.map((u) =>
        h('div', { class: 'user-row' },
          h('div', { class: 'user-row-main' },
            h('span', { class: 'user-row-email', text: u.email }),
            h('span', {
              class: 'user-row-meta',
              text: `${u.bookmark_count} 条书签 · 注册于 ${formatDate(u.created_at)}`,
            }),
          ),
          u.role === 'admin'
            ? h('span', { class: `role-badge${u.id === state.currentUser?.id ? ' owner' : ''}`, text: u.id === state.currentUser?.id ? '我（管理员）' : '管理员' })
            : h('span', { class: 'role-badge', style: 'background:var(--surface-2);color:var(--text-3)', text: '成员' }),
          u.id !== state.currentUser?.id
            ? h('button', {
                class: 'icon-btn danger',
                type: 'button',
                title: '删除该用户及其全部书签',
                'aria-label': `删除用户 ${u.email}`,
                onclick: () =>
                  confirmAction(
                    `确定要删除用户「${u.email}」吗？其全部书签将一并删除，此操作无法撤销。`,
                    async () => {
                      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
                      toast('用户已删除', 'success');
                      await renderUsers();
                    },
                  ),
              }, svgIcon(ICON_TRASH))
            : null,
        ),
      ),
    );
  } catch (err) {
    els.usersList.replaceChildren(h('p', { class: 'user-row-meta', text: err.message }));
  }
}

/* ------------------------------ 用户菜单 ------------------------------ */

function openUserMenu() {
  els.userMenu.classList.add('show');
  els.userMenu.setAttribute('aria-hidden', 'false');
  els.userMenuAdmin.classList.toggle('hidden', state.currentUser?.role !== 'admin');
}
function closeUserMenu() {
  els.userMenu.classList.remove('show');
  els.userMenu.setAttribute('aria-hidden', 'true');
}

/* ------------------------------ 命令面板 ------------------------------ */

const commands = [
  {
    id: 'add',
    title: '添加新书签',
    desc: '打开添加对话框',
    icon: 'plus',
    keys: 'n',
    run: () => openAddDialog(),
  },
  {
    id: 'search',
    title: '聚焦搜索框',
    desc: '快速搜索书签',
    icon: 'search',
    keys: '/',
    run: () => els.searchInput.focus(),
  },
  {
    id: 'list',
    title: '切换列表视图',
    desc: '更紧凑的单列展示',
    icon: 'list',
    run: () => { state.view = 'list'; savePref('view', state.view); applyView(); toast('已切换到列表视图'); },
  },
  {
    id: 'grid',
    title: '切换网格视图',
    desc: '默认的卡片墙',
    icon: 'grid',
    run: () => { state.view = 'grid'; savePref('view', state.view); applyView(); toast('已切换到网格视图'); },
  },
  {
    id: 'sort_new',
    title: '排序：最新添加',
    desc: '按创建时间倒序',
    icon: 'sort',
    run: () => { state.sort = 'created_desc'; els.sortSelect.value = state.sort; savePref('sort', state.sort); render(); },
  },
  {
    id: 'sort_old',
    title: '排序：最早添加',
    desc: '按创建时间正序',
    icon: 'sort',
    run: () => { state.sort = 'created_asc'; els.sortSelect.value = state.sort; savePref('sort', state.sort); render(); },
  },
  {
    id: 'sort_title',
    title: '排序：按标题',
    desc: 'A → Z 字母序',
    icon: 'sort',
    run: () => { state.sort = 'title_asc'; els.sortSelect.value = state.sort; savePref('sort', state.sort); render(); },
  },
  {
    id: 'sort_host',
    title: '排序：按域名',
    desc: '域名 A → Z',
    icon: 'sort',
    run: () => { state.sort = 'host_asc'; els.sortSelect.value = state.sort; savePref('sort', state.sort); render(); },
  },
  {
    id: 'admin',
    title: '用户管理',
    desc: '查看、删除成员（仅管理员）',
    icon: 'users',
    adminOnly: true,
    run: () => openUsersDialog(),
  },
  {
    id: 'classify_all',
    title: '一键自动分类',
    desc: '为所有未分类的书签自动指定分类',
    icon: 'magic',
    keys: 'c',
    run: () => els.classifyAllBtn?.click(),
  },
  {
    id: 'logout',
    title: '退出登录',
    desc: '清除当前会话',
    icon: 'logout',
    run: () => handleLogout(),
  },
];

const CMD_ICONS = {
  plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  list: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  grid: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  sort: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h13M3 12h9M3 18h5"/><path d="m17 8 4 4-4 4M21 12h-9"/></svg>',
  users: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 11h-6M19 8v6"/></svg>',
  logout: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  magic: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 4.6L19 9l-3.7 3.2.9 4.8L12 14.8 7.8 17l.9-4.8L5 9l5.1-1.4Z"/><path d="M5 3v3M19 17v3M3 5h4M17 19h4"/></svg>',
};

let cmdIndex = 0;
let cmdList = [];

function openCommandPanel() {
  els.commandPanel.classList.add('show');
  els.commandPanel.setAttribute('aria-hidden', 'false');
  els.commandInput.value = '';
  renderCommandList('');
  setTimeout(() => els.commandInput.focus(), 30);
}

function closeCommandPanel() {
  els.commandPanel.classList.remove('show');
  els.commandPanel.setAttribute('aria-hidden', 'true');
}

function renderCommandList(query) {
  const isAdmin = state.currentUser?.role === 'admin';
  cmdList = commands.filter((c) => !c.adminOnly || isAdmin)
    .filter((c) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return c.title.toLowerCase().includes(q) || (c.desc || '').toLowerCase().includes(q);
    });
  cmdIndex = 0;
  if (!cmdList.length) {
    els.commandList.replaceChildren(
      h('div', { class: 'command-empty', text: '没有匹配的命令' }),
    );
    return;
  }
  els.commandList.replaceChildren(
    ...cmdList.map((c, i) => {
      const item = h('div', {
        class: 'command-item' + (i === 0 ? ' active' : ''),
        'data-id': c.id,
        onclick: () => { c.run(); closeCommandPanel(); },
        onmouseenter: () => setActiveCommand(i),
      },
        h('span', { class: 'command-item-icon', html: CMD_ICONS[c.icon] || '' }),
        h('div', { class: 'command-item-main' },
          h('span', { class: 'command-item-title', text: c.title }),
          h('span', { class: 'command-item-desc', text: c.desc || '' }),
        ),
        c.keys ? h('span', { class: 'command-item-kbd', text: c.keys }) : null,
      );
      return item;
    }),
  );
}

function setActiveCommand(i) {
  const items = els.commandList.querySelectorAll('.command-item');
  items.forEach((el, idx) => el.classList.toggle('active', idx === i));
  cmdIndex = i;
  items[i]?.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------ 移动端抽屉 ------------------------------ */

function openMobileDrawer() {
  els.mobileDrawer.classList.add('show');
  els.mobileDrawer.setAttribute('aria-hidden', 'false');
  els.mobileAdminBtn.classList.toggle('hidden', state.currentUser?.role !== 'admin');
}

function closeMobileDrawer() {
  els.mobileDrawer.classList.remove('show');
  els.mobileDrawer.setAttribute('aria-hidden', 'true');
}

/* ------------------------------ 搜索框辅助 ------------------------------ */

function updateSearchAffordance() {
  const hasValue = els.searchInput.value.length > 0;
  els.searchbox.classList.toggle('has-value', hasValue);
  els.searchClear.classList.toggle('show', hasValue);
}

function clearSearch() {
  els.searchInput.value = '';
  updateSearchAffordance();
  render();
  els.searchInput.focus();
}

/* ------------------------------ 事件绑定 ------------------------------ */

// 认证页
els.tabLogin.addEventListener('click', () => switchAuthTab('login'));
els.tabRegister.addEventListener('click', () => switchAuthTab('register'));
els.forgotLink.addEventListener('click', (e) => {
  e.preventDefault();
  switchAuthTab('reset');
});
els.toRegisterLink.addEventListener('click', (e) => {
  e.preventDefault();
  switchAuthTab('register');
});
els.toLoginLink.addEventListener('click', (e) => {
  e.preventDefault();
  switchAuthTab('login');
});
els.backToLoginLink.addEventListener('click', (e) => {
  e.preventDefault();
  switchAuthTab('login');
});

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = els.loginEmail.value.trim().toLowerCase();
  const password = els.loginPassword.value;
  if (!EMAIL_RE.test(email)) return setFormError(els.loginError, '请输入正确的邮箱地址');
  if (!password) return setFormError(els.loginError, '请输入密码');
  els.loginSubmit.disabled = true;
  try {
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    enterApp(user);
    toast(`欢迎回来，${user.email}`, 'success');
  } catch (err) {
    setFormError(els.loginError, err.message);
  } finally {
    els.loginSubmit.disabled = false;
  }
});

els.regSendBtn.addEventListener('click', () => sendCode('register'));
els.resetSendBtn.addEventListener('click', () => sendCode('reset'));

els.registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = els.regEmail.value.trim().toLowerCase();
  const code = els.regCode.value.trim();
  const password = els.regPassword.value;
  const confirm = els.regConfirm.value;
  if (!EMAIL_RE.test(email)) return setFormError(els.regError, '请输入正确的邮箱地址');
  if (!/^\d{4}$/.test(code)) return setFormError(els.regError, '请输入 4 位数字验证码');
  if (password.length < 8) return setFormError(els.regError, '密码至少需要 8 位');
  if (password !== confirm) return setFormError(els.regError, '两次输入的密码不一致');
  els.regSubmit.disabled = true;
  try {
    const { user } = await api('/api/auth/register/finish', {
      method: 'POST',
      body: JSON.stringify({ email, code, password }),
    });
    enterApp(user);
    toast(user.role === 'admin' ? '注册成功，你已成为管理员！' : '注册成功，欢迎！', 'success');
  } catch (err) {
    setFormError(els.regError, err.message);
  } finally {
    els.regSubmit.disabled = false;
  }
});

els.resetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = els.resetEmail.value.trim().toLowerCase();
  const code = els.resetCode.value.trim();
  const password = els.resetPassword.value;
  const confirm = els.resetConfirm.value;
  if (!EMAIL_RE.test(email)) return setFormError(els.resetError, '请输入正确的邮箱地址');
  if (!/^\d{4}$/.test(code)) return setFormError(els.resetError, '请输入 4 位数字验证码');
  if (password.length < 8) return setFormError(els.resetError, '密码至少需要 8 位');
  if (password !== confirm) return setFormError(els.resetError, '两次输入的密码不一致');
  els.resetSubmit.disabled = true;
  try {
    await api('/api/auth/reset/finish', {
      method: 'POST',
      body: JSON.stringify({ email, code, password }),
    });
    resetAuthForms();
    switchAuthTab('login');
    toast('密码已重置，请用新密码登录', 'success');
  } catch (err) {
    setFormError(els.resetError, err.message);
  } finally {
    els.resetSubmit.disabled = false;
  }
});

// 应用
els.addBtn.addEventListener('click', openAddDialog);
els.emptyAddBtn.addEventListener('click', openAddDialog);
els.noMatchClearBtn.addEventListener('click', () => {
  const q = els.searchInput.value.trim();
  const catActive = state.categoryFilter && state.categoryFilter !== 'all';
  if (q && catActive) {
    els.searchInput.value = '';
    updateSearchAffordance();
    state.categoryFilter = 'all';
    if (els.categorySelect) els.categorySelect.value = 'all';
    savePref('cat', state.categoryFilter);
  } else if (catActive) {
    state.categoryFilter = 'all';
    if (els.categorySelect) els.categorySelect.value = 'all';
    savePref('cat', state.categoryFilter);
  } else {
    clearSearch();
    return; // clearSearch already re-renders
  }
  render();
});
els.fetchBtn.addEventListener('click', fetchMetaForDialog);
els.cancelBtn.addEventListener('click', () => els.dialog.close());
els.titleInput.addEventListener('input', () => {
  state.titleDirty = true;
});
els.descInput.addEventListener('input', () => {
  state.descDirty = true;
});

els.searchInput.addEventListener('input', () => {
  updateSearchAffordance();
  render();
});
els.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.searchInput.value) {
    e.preventDefault();
    clearSearch();
  }
});
els.searchClear.addEventListener('click', clearSearch);

els.sortSelect.addEventListener('change', () => {
  state.sort = els.sortSelect.value;
  savePref('sort', state.sort);
  render();
});

els.categorySelect.addEventListener('change', () => {
  state.categoryFilter = els.categorySelect.value;
  savePref('cat', state.categoryFilter);
  render();
});

els.classifyAllBtn.addEventListener('click', () => {
  const todo = state.bookmarks.filter((b) => !b.category).length;
  const isAdmin = state.currentUser?.role === 'admin';
  const text = todo > 0
    ? `将自动为 ${todo} 个未分类书签指定分类，已分类的书签不会被覆盖。是否继续？`
    : isAdmin
      ? '当前没有未分类的书签。作为管理员，是否全部重判？（已分类的书签也会被覆盖）'
      : '当前没有未分类的书签。';
  if (todo === 0 && !isAdmin) {
    toast('当前没有未分类的书签', 'info');
    return;
  }
  confirmAction(text, async () => {
    const force = todo === 0 && isAdmin;
    try {
      els.classifyAllBtn.disabled = true;
      const { updated } = await api('/api/bookmarks/classify-all', {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      toast(updated > 0 ? `已自动分类 ${updated} 个书签` : '没有需要更新的书签', 'success');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      els.classifyAllBtn.disabled = false;
    }
  });
});

for (const btn of els.viewBtns) {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    savePref('view', state.view);
    applyView();
  });
}

// 退出/管理入口已迁移到点头像弹出的用户菜单，无需单独绑定
els.usersCloseBtn.addEventListener('click', () => els.usersDialog.close());
els.confirmCancel.addEventListener('click', () => els.confirmDialog.close());

// 用户菜单
els.userMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (els.userMenu.classList.contains('show')) closeUserMenu();
  else openUserMenu();
});
els.userMenuClose.addEventListener('click', closeUserMenu);
els.userMenu.addEventListener('click', (e) => {
  if (e.target === els.userMenu) closeUserMenu();
});
els.userMenuAdmin.addEventListener('click', () => { closeUserMenu(); openUsersDialog(); });
els.userMenuLogout.addEventListener('click', () => { closeUserMenu(); handleLogout(); });

// 命令面板
els.commandPanel.addEventListener('click', (e) => {
  if (e.target === els.commandPanel) closeCommandPanel();
});
els.commandInput.addEventListener('input', () => renderCommandList(els.commandInput.value));
els.commandInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeCommandPanel(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActiveCommand(Math.min(cmdIndex + 1, cmdList.length - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActiveCommand(Math.max(cmdIndex - 1, 0));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const c = cmdList[cmdIndex];
    if (c) { c.run(); closeCommandPanel(); }
  }
});

// 移动端抽屉
els.mobileMenuBtn.addEventListener('click', openMobileDrawer);
els.mobileAddBtn.addEventListener('click', () => { closeMobileDrawer(); openAddDialog(); });
els.mobileAdminBtn.addEventListener('click', () => { closeMobileDrawer(); openUsersDialog(); });
els.mobileLogoutBtn.addEventListener('click', () => { closeMobileDrawer(); handleLogout(); });
els.mobileDrawer.addEventListener('click', (e) => {
  if (e.target.dataset.close !== undefined || e.target.classList.contains('mobile-drawer-backdrop')) {
    closeMobileDrawer();
  }
});

// 点击对话框遮罩区域关闭 + Esc 关闭兜底（兼容所有浏览器对 dialog Esc 的差异处理）
for (const dlg of [els.dialog, els.confirmDialog, els.usersDialog]) {
  dlg.addEventListener('click', (event) => {
    if (event.target === dlg) dlg.close();
  });
  dlg.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && dlg.open) {
      event.preventDefault();
      dlg.close();
    }
  });
}

/* ------------------------------ 全局键盘快捷键 ------------------------------ */

document.addEventListener('keydown', (e) => {
  // 命令面板已打开时：Esc 关掉，↑/↓ 切换选择，Enter 执行；其它键由面板内 input 处理
  if (els.commandPanel.classList.contains('show')) {
    if (e.key === 'Escape') { e.preventDefault(); closeCommandPanel(); }
    return;
  }

  const target = e.target;
  const isTyping =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);

  // Esc 优先级：任何对话框/菜单 → 关闭它
  if (e.key === 'Escape') {
    if (els.userMenu.classList.contains('show')) { closeUserMenu(); return; }
    if (els.mobileDrawer.classList.contains('show')) { closeMobileDrawer(); return; }
  }

  // 在输入框里时不触发全局快捷键
  if (isTyping) return;

  // 只在已登录应用页生效
  if (els.appView.classList.contains('hidden')) return;

  // Cmd/Ctrl + K → 命令面板
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openCommandPanel();
    return;
  }

  // / → 聚焦搜索
  if (e.key === '/') {
    e.preventDefault();
    els.searchInput.focus();
    els.searchInput.select();
    return;
  }

  // n → 新建
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    openAddDialog();
    return;
  }

  // c → 一键自动分类
  if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    els.classifyAllBtn?.click();
    return;
  }

  // g → 切换网格视图；l → 列表视图（Vim 风）
  if (e.key === 'g') {
    state.view = 'grid'; savePref('view', state.view); applyView();
    toast('网格视图');
    return;
  }
  if (e.key === 'l') {
    state.view = 'list'; savePref('view', state.view); applyView();
    toast('列表视图');
    return;
  }
});

// 点击空白处关闭用户菜单
document.addEventListener('click', (e) => {
  if (!els.userMenu.classList.contains('show')) return;
  if (e.target === els.userMenuBtn || els.userMenuBtn.contains(e.target)) return;
  if (e.target.closest('.command-panel-inner')) return;
  closeUserMenu();
});

/* ------------------------------ 启动 ------------------------------ */

(async function init() {
  try {
    const { user } = await api('/api/auth/me');
    if (user) {
      enterApp(user);
      return;
    }
  } catch {
    /* 网络异常时也显示登录页 */
  }
  els.boot.classList.add('hidden');
  showAuth('login');
})();
