/**
 * 云书签 · Cloud Bookmark — 前端逻辑（原生 JS，无框架）
 *
 * 数据交互全部通过 /api/*；所有用户数据均用 DOM API / textContent 渲染，防 XSS。
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
    throw new Error((body && body.error) || `请求失败（HTTP ${res.status}）`);
  }
  return body.data;
}

/* ------------------------------ 元素与状态 ------------------------------ */

const els = {
  searchInput: $('#searchInput'),
  addBtn: $('#addBtn'),
  emptyAddBtn: $('#emptyAddBtn'),
  grid: $('#grid'),
  emptyState: $('#emptyState'),
  noMatch: $('#noMatch'),
  loading: $('#loading'),
  stats: $('#stats'),
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
  confirmDialog: $('#confirmDialog'),
  confirmText: $('#confirmText'),
  confirmOk: $('#confirmOk'),
  confirmCancel: $('#confirmCancel'),
  toast: $('#toast'),
};

const state = {
  bookmarks: [],
  editingId: null, // null = 新增模式
  iconUrl: '', // 对话框内当前已获取到的图标
  titleDirty: false,
  descDirty: false,
  lastFetchedUrl: '',
  fetching: false,
  confirmAction: null,
};

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
    toast(err.message, 'error');
  }
  render();
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

/* ------------------------------ 添加 / 编辑对话框 ------------------------------ */

function setFormError(message) {
  els.formError.textContent = message || '';
  els.formError.classList.toggle('hidden', !message);
}

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
  setFormError('');
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
    setFormError('请先输入网址');
    els.urlInput.focus();
    return;
  }
  if (!guessUrl(raw)) {
    setFormError('网址格式不正确，请检查后重试');
    return;
  }
  state.fetching = true;
  els.fetchBtn.disabled = true;
  const original = els.fetchBtnLabel.textContent;
  els.fetchBtnLabel.textContent = '获取中…';
  setFormError('');
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
    setFormError('请输入网址');
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
    setFormError(err.message);
  } finally {
    els.saveBtn.disabled = false;
  }
});

/* ------------------------------ 删除 ------------------------------ */

function confirmDelete(bm) {
  els.confirmText.textContent = `确定要删除「${bm.title || hostOf(bm.url)}」吗？此操作无法撤销。`;
  state.confirmAction = async () => {
    await api(`/api/bookmarks/${bm.id}`, { method: 'DELETE' });
    toast('书签已删除', 'success');
    await load();
  };
  els.confirmDialog.showModal();
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

/* ------------------------------ 全局事件 ------------------------------ */

els.addBtn.addEventListener('click', openAddDialog);
els.emptyAddBtn.addEventListener('click', openAddDialog);
els.fetchBtn.addEventListener('click', fetchMetaForDialog);
els.cancelBtn.addEventListener('click', () => els.dialog.close());
els.confirmCancel.addEventListener('click', () => els.confirmDialog.close());
els.titleInput.addEventListener('input', () => {
  state.titleDirty = true;
});
els.descInput.addEventListener('input', () => {
  state.descDirty = true;
});
els.searchInput.addEventListener('input', render);

// 点击对话框遮罩区域关闭
for (const dlg of [els.dialog, els.confirmDialog]) {
  dlg.addEventListener('click', (event) => {
    if (event.target === dlg) dlg.close();
  });
}

load().finally(() => {
  els.loading.classList.add('hidden');
});
