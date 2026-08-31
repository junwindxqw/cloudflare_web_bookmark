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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
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
  registerForm: $('#registerForm'),
  regEmail: $('#regEmail'),
  regSendBtn: $('#regSendBtn'),
  regCode: $('#regCode'),
  regPassword: $('#regPassword'),
  regConfirm: $('#regConfirm'),
  regHint: $('#regHint'),
  regError: $('#regError'),
  resetForm: $('#resetForm'),
  resetEmail: $('#resetEmail'),
  resetSendBtn: $('#resetSendBtn'),
  resetCode: $('#resetCode'),
  resetPassword: $('#resetPassword'),
  resetConfirm: $('#resetConfirm'),
  resetHint: $('#resetHint'),
  resetError: $('#resetError'),
  forgotLink: $('#forgotLink'),
  toRegisterLink: $('#toRegisterLink'),
  toLoginLink: $('#toLoginLink'),
  backToLoginLink: $('#backToLoginLink'),
  // 应用
  searchInput: $('#searchInput'),
  addBtn: $('#addBtn'),
  emptyAddBtn: $('#emptyAddBtn'),
  grid: $('#grid'),
  emptyState: $('#emptyState'),
  noMatch: $('#noMatch'),
  loading: $('#loading'),
  stats: $('#stats'),
  userEmail: $('#userEmail'),
  adminBtn: $('#adminBtn'),
  logoutBtn: $('#logoutBtn'),
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
};

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
  els.adminBtn.classList.toggle('hidden', user.role !== 'admin');
  els.loading.classList.remove('hidden');
  load();
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

function iconNode(bm) {
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

function cardNode(bm) {
  const host = hostOf(bm.url);
  const card = h('article', { class: 'card' });
  card.append(
    h('div', { class: 'card-head' },
      iconNode(bm),
      h('div', { class: 'card-text' },
        h('a', {
          class: 'card-title',
          href: bm.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: bm.title || bm.url,
          text: bm.title || host,
        }),
        h('div', { class: 'card-meta', text: [host, formatDate(bm.created_at)].filter(Boolean).join(' · ') }),
      ),
    ),
    h('div', { class: 'card-actions' },
      h('button', { class: 'icon-btn', type: 'button', title: '编辑', 'aria-label': '编辑书签', onclick: () => openEditDialog(bm) }, svgIcon(ICON_EDIT)),
      h('button', { class: 'icon-btn danger', type: 'button', title: '删除', 'aria-label': '删除书签', onclick: () => confirmDelete(bm) }, svgIcon(ICON_TRASH)),
    ),
  );
  if (bm.description) card.append(h('p', { class: 'card-desc', text: bm.description }));
  return card;
}

function render() {
  const q = els.searchInput.value.trim().toLowerCase();
  const list = q
    ? state.bookmarks.filter((b) =>
        `${b.title} ${b.description} ${hostOf(b.url)}`.toLowerCase().includes(q),
      )
    : state.bookmarks;

  els.grid.replaceChildren(...list.map(cardNode));
  els.emptyState.classList.toggle('hidden', state.bookmarks.length > 0);
  els.noMatch.classList.toggle('hidden', !(state.bookmarks.length > 0 && list.length === 0));
  els.stats.textContent = q
    ? `匹配 ${list.length} / 共 ${state.bookmarks.length} 个书签`
    : `共 ${state.bookmarks.length} 个书签`;
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
}

function openAddDialog() {
  resetDialogState();
  state.editingId = null;
  els.dialogTitle.textContent = '添加书签';
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
  els.dialogTitle.textContent = '编辑书签';
  els.urlInput.value = bm.url;
  els.titleInput.value = bm.title || '';
  els.descInput.value = bm.description || '';
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
  const original = els.fetchBtnLabel.textContent;
  els.fetchBtnLabel.textContent = '获取中…';
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
    els.fetchBtnLabel.textContent = original;
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
els.fetchBtn.addEventListener('click', fetchMetaForDialog);
els.cancelBtn.addEventListener('click', () => els.dialog.close());
els.titleInput.addEventListener('input', () => {
  state.titleDirty = true;
});
els.descInput.addEventListener('input', () => {
  state.descDirty = true;
});
els.searchInput.addEventListener('input', render);
els.logoutBtn.addEventListener('click', handleLogout);
els.adminBtn.addEventListener('click', openUsersDialog);
els.usersCloseBtn.addEventListener('click', () => els.usersDialog.close());
els.confirmCancel.addEventListener('click', () => els.confirmDialog.close());

// 点击对话框遮罩区域关闭
for (const dlg of [els.dialog, els.confirmDialog, els.usersDialog]) {
  dlg.addEventListener('click', (event) => {
    if (event.target === dlg) dlg.close();
  });
}

// 登录提交按钮引用（els 里没集中声明，这里补挂）
els.loginSubmit = $('#loginSubmit');
els.regSubmit = $('#regSubmit');
els.resetSubmit = $('#resetSubmit');

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
