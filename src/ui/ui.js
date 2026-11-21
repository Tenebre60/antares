'use strict';
const api = window.chrome2;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { tabs: [], activeId: null, bookmarks: [], settings: {}, isPrivate: false };
const tabEls = new Map();
const header = $('#chrome');
const address = $('#address');
const omnibox = $('#omnibox');
const suggestEl = $('#suggest');

const ICONS = {
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5S9.5 6.1 12 3.5z"/></svg>',
  aurora: '<svg viewBox="0 0 24 24"><path d="M4 18c3-9 13-9 16 0"/><path d="M8 18c1.6-4.6 6.4-4.6 8 0"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M7 7l5 5-5 5M13 7l5 5-5 5"/></svg>',
};

/* ------------------------------------------------------------ heights */
function sendHeights() {
  const chrome = Math.ceil(header.getBoundingClientRect().height);
  let total = chrome;
  if (!suggestEl.hidden) total = Math.max(total, Math.ceil(suggestEl.getBoundingClientRect().bottom) + 14);
  api.heights(chrome, total);
}
new ResizeObserver(sendHeights).observe(header);

/* ------------------------------------------------------------ tabs */
function faviconHtml(t) {
  if (t.loading) return '<div class="spinner"></div>';
  if (t.url && t.url.startsWith('aurora://')) return ICONS.aurora;
  if (t.favicon) return `<img src="${esc(t.favicon)}" alt="">`;
  return ICONS.globe;
}

function makeTabEl(t) {
  const el = document.createElement('div');
  el.className = 'tab'; el.draggable = true; el.dataset.id = t.id; el.setAttribute('role', 'tab');
  el.innerHTML = '<span class="fav"></span><span class="title"></span><span class="audio" hidden></span><button class="close" title="Fechar aba (Ctrl+W)">' + ICONS.close + '</button>';
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.close, .audio')) api.activate(t.id);
    if (e.button === 1) e.preventDefault();
  });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) api.closeTab(t.id); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); api.tabMenu(t.id); });
  el.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); api.closeTab(t.id); });
  el.querySelector('.audio').addEventListener('click', (e) => { e.stopPropagation(); api.mute(t.id); });
  el.addEventListener('dragstart', (e) => { el.classList.add('dragging'); e.dataTransfer.setData('text/aurora-tab', String(t.id)); e.dataTransfer.effectAllowed = 'move'; });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); clearDrop(); });
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('text/aurora-tab')) return;
    e.preventDefault(); clearDrop();
    const r = el.getBoundingClientRect();
    el.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
  });
  el.addEventListener('drop', (e) => {
    const id = Number(e.dataTransfer.getData('text/aurora-tab')); if (!id) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    let to = state.tabs.findIndex((x) => x.id === t.id) + (e.clientX < r.left + r.width / 2 ? 0 : 1);
    const from = state.tabs.findIndex((x) => x.id === id);
    if (from < to) to--;
    clearDrop(); api.moveTab(id, to);
  });
  return el;
}
function clearDrop() { document.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); }

function updateTabEl(el, t) {
  el.classList.toggle('active', t.id === state.activeId);
  el.classList.toggle('sleeping', !!t.sleeping);
  const title = t.title || (t.display ? t.display : 'Nova aba');
  const titleEl = el.querySelector('.title');
  if (titleEl.textContent !== title) titleEl.textContent = title;
  el.title = t.sleeping ? `${title}\n(Em repouso para economizar memória — clique para reativar)` : title;
  const favKey = `${t.loading}|${t.favicon}|${(t.url || '').startsWith('aurora://')}`;
  if (el.dataset.fav !== favKey) {
    const fav = el.querySelector('.fav'); fav.innerHTML = faviconHtml(t); el.dataset.fav = favKey;
    const img = fav.querySelector('img'); if (img) img.onerror = () => { fav.innerHTML = ICONS.globe; };
  }
  const audio = el.querySelector('.audio');
  audio.hidden = !(t.audible || t.muted);
  audio.innerHTML = t.muted ? ICONS.muted : ICONS.sound;
  audio.title = t.muted ? 'Ativar som' : 'Silenciar aba';
}

function renderTabs() {
  const box = $('#tabs');
  const ids = new Set(state.tabs.map((t) => t.id));
  for (const [id, el] of tabEls) if (!ids.has(id)) { el.remove(); tabEls.delete(id); }
  state.tabs.forEach((t, i) => {
    let el = tabEls.get(t.id);
    if (!el) { el = makeTabEl(t); tabEls.set(t.id, el); }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    updateTabEl(el, t);
  });
  fitTabs();
}
function fitTabs() {
  const strip = $('#tabstrip');
  const avail = strip.clientWidth - 12 - 40 - ($('#private-badge').hidden ? 0 : 100) - 60;
  const w = Math.max(44, Math.min(230, Math.floor(avail / Math.max(1, state.tabs.length))));
  for (const el of tabEls.values()) { el.style.width = w + 'px'; el.style.flexBasis = w + 'px'; el.classList.toggle('narrow', w < 90); }
}
window.addEventListener('resize', () => { fitTabs(); renderBookmarks(); if (!suggestEl.hidden) positionSuggest(); });

/* ------------------------------------------------------------ toolbar */
function activeTab() { return state.tabs.find((t) => t.id === state.activeId); }
let dirty = false;

function renderToolbar() {
  const t = activeTab();
  if (!t) return;
  $('#back').disabled = !t.canBack;
  $('#forward').disabled = !t.canForward;
  const rl = $('#reload');
  rl.classList.toggle('loading', !!t.loading);
  rl.title = t.loading ? 'Parar (Esc)' : 'Recarregar (F5)';
  const star = $('#star');
  star.classList.toggle('on', !!t.bookmarked);
  star.title = t.bookmarked ? 'Remover dos favoritos (Ctrl+D)' : 'Adicionar aos favoritos (Ctrl+D)';
  star.hidden = !/^(https?|file):/.test(t.url || '');
  if (!dirty) address.value = t.display || '';
  setSiteIcon(dirty || !t.display ? 'search' : t.secure);
  const sh = $('#shield');
  sh.hidden = !/^https?:/.test(t.url || '') || !state.settings.blockTrackers;
  sh.classList.toggle('active', t.blocked > 0 && !t.adblockOff);
  sh.classList.toggle('off', !!t.adblockOff);
  $('#shield-n').textContent = t.blocked > 0 && !t.adblockOff ? (t.blocked > 99 ? '99+' : String(t.blocked)) : '';
  sh.title = t.adblockOff ? 'Bloqueio desativado neste site' : `${t.blocked || 0} anúncio(s) e rastreador(es) bloqueado(s) nesta página`;
  const pp = $('#popups'); pp.hidden = !t.blockedPopups; pp.title = `${t.blockedPopups} pop-up(s) bloqueado(s) — clique para ver`;
  if (t.warn && !dirty) $('#site-icon').title = t.warn;
  const z = Math.round((t.zoom || 1) * 100);
  const zi = $('#zoom-ind'); zi.hidden = z === 100; zi.textContent = z + '%';
}
function setSiteIcon(kind) {
  const s = $('#site-icon');
  s.className = kind;
  s.title = { secure: 'A conexão é segura (HTTPS)', insecure: 'A conexão não é segura', file: 'Arquivo local', internal: 'Página do Aurora', search: '' }[kind] || '';
}

$('#back').onclick = () => api.back();
$('#forward').onclick = () => api.forward();
$('#reload').onclick = (e) => { const t = activeTab(); if (t && t.loading) api.stop(); else api.reload(e.shiftKey || e.ctrlKey); };
$('#home').onclick = () => api.home();
$('#star').onclick = () => api.bookmark();
$('#zoom-ind').onclick = () => api.zoom(0);
$('#shield').onclick = () => { const t = activeTab(); if (t) api.shieldMenu(t.id); };
$('#popups').onclick = () => { const t = activeTab(); if (t) api.popupMenu(t.id); };
$('#site-icon').addEventListener('mousedown', (e) => {
  // site information: connection, certificate and permissions for this site
  if (dirty) return;
  e.preventDefault();
  const t = activeTab(); if (t && t.display) api.siteMenu(t.id);
});
$('#infobar-more').onclick = () => api.openUpdate();
$('#infobar-close').onclick = () => api.dismissUpdate();

/* drag links/text onto the browser chrome: open in a new tab (never inside the chrome itself) */
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('text/aurora-tab')) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; document.body.classList.add('dragover');
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragover'); });
document.addEventListener('drop', (e) => {
  document.body.classList.remove('dragover');
  if (e.dataTransfer.types.includes('text/aurora-tab')) return;
  e.preventDefault();
  if (e.target.closest && e.target.closest('input')) {
    const txt = e.dataTransfer.getData('text/plain'); if (txt && e.target === address) { address.value = txt; address.focus(); }
    return;
  }
  const u = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
  if (/^https?:\/\//i.test(u)) api.newTab(u);
});
$('#newtab').onclick = () => api.newTab();
$('#downloads').onclick = () => api.internal('downloads');
$('#menu').onclick = () => { const r = $('#menu').getBoundingClientRect(); api.menu(r.right - 260, r.bottom + 2); };
$('#tabstrip .drag-space').addEventListener('dblclick', () => api.newTab());
for (const id of ['back', 'forward']) {
  $('#' + id).addEventListener('auxclick', (e) => { if (e.button === 1) api[id](); });
}

/* ------------------------------------------------------------ omnibox */
let suggestions = []; let sel = -1; let typed = ''; let reqSeq = 0; let lastInputType = ''; let inline = null;

address.addEventListener('focus', () => {
  omnibox.classList.add('focused');
  requestAnimationFrame(() => address.select());
});
address.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement === address) return;
    dirty = false; omnibox.classList.remove('focused'); hideSuggest(); renderToolbar();
  }, 120);
});
address.addEventListener('input', (e) => { dirty = true; lastInputType = e.inputType || ''; inline = null; typed = address.value; refreshSuggest(); });
address.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (suggestEl.hidden) return;
    e.preventDefault();
    const n = suggestions.length + 1;
    sel = (Math.max(0, sel) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    paintSuggest();
    const s = rowAt(sel); if (s) address.value = s.kind === 'search' ? typed : s.url;
  } else if (e.key === 'Tab' && inline && address.selectionEnd > address.selectionStart) {
    e.preventDefault(); address.setSelectionRange(address.value.length, address.value.length); // accept the completion
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const s = suggestEl.hidden ? null : rowAt(sel);
    const value = s && s.kind !== 'search' ? s.url : address.value;
    go(value, e.altKey);
  } else if (e.key === 'Escape') {
    if (!suggestEl.hidden || inline) { hideSuggest(); address.value = typed; inline = null; return; }
    dirty = false; const t = activeTab(); address.value = t ? t.display : ''; address.blur(); api.focusPage();
  }
});
function go(value, newTab) {
  if (!value.trim()) return;
  hideSuggest(); dirty = false; inline = null; address.blur();
  if (newTab) api.newTab(value); else api.navigate(value);
}
function rowAt(i) {
  if (i < 0) return null;
  if (i === 0) return { kind: 'search', url: typed };
  return suggestions[i - 1];
}
async function refreshSuggest() {
  const q = typed.trim();
  if (!q) { hideSuggest(); return; }
  const my = ++reqSeq;
  const res = await api.suggest(q);
  if (my !== reqSeq || document.activeElement !== address) return;
  suggestions = res; sel = 0;
  // inline completion: "goo" -> "google.com" (the completed part stays selected; keep typing to override)
  inline = null;
  const ql = q.toLowerCase();
  if (lastInputType === 'insertText' && address.value === typed && address.selectionEnd === typed.length && !/[\s/]/.test(ql)) {
    for (const s of res) {
      const h = s.url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/)[0].toLowerCase();
      if (h.startsWith(ql) && h.length > ql.length) { inline = h; break; }
    }
    if (inline) { address.value = typed + inline.slice(typed.length); address.setSelectionRange(typed.length, address.value.length); }
  }
  paintSuggest(); positionSuggest();
}
function hl(text, q) {
  const s = String(text || ''); const i = s.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return esc(s);
  return esc(s.slice(0, i)) + '<b>' + esc(s.slice(i, i + q.length)) + '</b>' + esc(s.slice(i + q.length));
}
function paintSuggest() {
  const q = typed.trim();
  const eng = (state.settings.searchEngines || {})[state.settings.searchEngine] || 'Google';
  const shown = inline && sel === 0 ? address.value : q;
  const looksUrl = !!(inline && sel === 0) || /^[^\s]+\.[a-z]{2,}(\/|$)|^https?:|^localhost/i.test(q);
  let html = `<div class="row ${sel === 0 ? 'sel' : ''}" data-i="0"><span class="ic">${looksUrl ? ICONS.globe : ICONS.search}</span><span class="t">${esc(shown)}</span><span class="u" style="color:var(--muted)">${looksUrl ? 'Abrir endereço' : 'Pesquisar no ' + esc(eng)}</span></div>`;
  suggestions.forEach((s, i) => {
    const ic = s.favicon ? `<img src="${esc(s.favicon)}" alt="">` : (s.type === 'bookmark' ? ICONS.star : ICONS.clock);
    html += `<div class="row ${sel === i + 1 ? 'sel' : ''}" data-i="${i + 1}"><span class="ic">${ic}</span><span class="t">${hl(s.title || s.url, q)}</span><span class="u">${hl(s.url.replace(/^https?:\/\/(www\.)?/, ''), q)}</span></div>`;
  });
  suggestEl.innerHTML = html;
  suggestEl.querySelectorAll('img').forEach((img) => { img.onerror = () => img.remove(); });
  suggestEl.hidden = false; omnibox.classList.add('open');
}
function positionSuggest() {
  const r = omnibox.getBoundingClientRect();
  Object.assign(suggestEl.style, { left: (r.left) + 'px', top: (r.bottom - 1) + 'px', width: r.width + 'px' });
  sendHeights();
}
function hideSuggest() {
  if (suggestEl.hidden) return;
  suggestEl.hidden = true; omnibox.classList.remove('open'); suggestions = []; sel = -1; sendHeights();
}
suggestEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.row'); if (!row) return;
  e.preventDefault();
  const s = rowAt(Number(row.dataset.i));
  if (s) go(s.kind === 'search' ? (inline ? address.value : typed) : s.url, e.button === 1 || e.ctrlKey);
});
suggestEl.addEventListener('mousemove', (e) => {
  const row = e.target.closest('.row'); if (!row) return;
  const i = Number(row.dataset.i); if (i !== sel) { sel = i; paintSuggest(); }
});
document.addEventListener('mousedown', (e) => {
  if (!suggestEl.hidden && !e.target.closest('#suggest, #omnibox')) { hideSuggest(); }
});

/* ------------------------------------------------------------ bookmarks bar */
function renderBookmarks() {
  const bar = $('#bookmarksbar');
  bar.classList.toggle('hidden', !state.settings.showBookmarksBar);
  if (!state.settings.showBookmarksBar) return;
  if (!state.bookmarks.length) {
    bar.innerHTML = '<span class="empty">Para acessar rapidamente, adicione favoritos aqui clicando na estrela ☆ na barra de endereço.</span>';
    return;
  }
  bar.innerHTML = '';
  const maxW = bar.clientWidth - 50; let used = 0;
  for (const b of state.bookmarks) {
    const a = document.createElement('div');
    a.className = 'bm'; a.title = `${b.title}\n${b.url}`;
    let host = ''; try { host = new URL(b.url).hostname.replace(/^www\./, ''); } catch {}
    a.innerHTML = (b.favicon ? `<img src="${esc(b.favicon)}" alt="">` : `<span class="dot">${esc(host[0] || '?')}</span>`) + `<span>${esc(b.title || host)}</span>`;
    const img = a.querySelector('img');
    if (img) img.onerror = () => { img.outerHTML = `<span class="dot">${esc(host[0] || '?')}</span>`; };
    a.addEventListener('click', (e) => (e.ctrlKey || e.metaKey ? api.open(b.url, true) : api.open(b.url, false)));
    a.addEventListener('auxclick', (e) => { if (e.button === 1) api.open(b.url, true); });
    a.addEventListener('contextmenu', (e) => { e.preventDefault(); api.bookmarkMenu(b.id); });
    bar.appendChild(a);
    used += a.offsetWidth + 2;
    if (used > maxW) { a.remove(); break; }
  }
  const more = document.createElement('button');
  more.className = 'icon-btn small more'; more.title = 'Todos os favoritos (Ctrl+Shift+O)'; more.innerHTML = ICONS.more;
  more.onclick = () => api.internal('bookmarks');
  bar.appendChild(more);
}

/* ------------------------------------------------------------ find bar */
const findbar = $('#findbar'); const findInput = $('#find-input');
function openFind() {
  findbar.hidden = false; findInput.focus(); findInput.select();
  if (findInput.value) api.find(findInput.value, { findNext: false });
}
function closeFind() { findbar.hidden = true; $('#find-count').textContent = ''; api.stopFind(); api.focusPage(); }
findInput.addEventListener('input', () => {
  if (findInput.value) api.find(findInput.value, { findNext: false });
  else { api.stopFind(); $('#find-count').textContent = ''; findInput.classList.remove('nomatch'); }
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (findInput.value) api.find(findInput.value, { findNext: true, forward: !e.shiftKey }); }
  if (e.key === 'Escape') closeFind();
});
$('#find-next').onclick = () => findInput.value && api.find(findInput.value, { findNext: true, forward: true });
$('#find-prev').onclick = () => findInput.value && api.find(findInput.value, { findNext: true, forward: false });
$('#find-close').onclick = closeFind;

/* ------------------------------------------------------------ downloads */
function renderDownloads(s) {
  const b = $('#downloads');
  b.classList.toggle('active', s.active > 0);
  b.classList.toggle('indeterminate', s.active > 0 && s.progress < 0);
  b.title = s.active ? `${s.active} download(s) em andamento` : 'Downloads (Ctrl+J)';
  if (s.progress >= 0) b.querySelector('.ring circle').style.strokeDasharray = `${Math.round(s.progress * 100)} 100`;
}

/* ------------------------------------------------------------ events */
api.on('init', (d) => {
  state.isPrivate = d.isPrivate; state.bookmarks = d.bookmarks; state.settings = d.settings;
  document.body.classList.toggle('private', d.isPrivate);
  $('#private-badge').hidden = !d.isPrivate;
  renderBookmarks(); renderDownloads(d.downloads); sendHeights();
});
api.on('tabs', (d) => { if (d.activeId !== state.activeId) dirty = false; state.tabs = d.tabs; state.activeId = d.activeId; renderTabs(); renderToolbar(); });
api.on('tab', (t) => {
  const i = state.tabs.findIndex((x) => x.id === t.id);
  if (i < 0) return;
  state.tabs[i] = t;
  const el = tabEls.get(t.id); if (el) updateTabEl(el, t);
  if (t.id === state.activeId) renderToolbar();
});
api.on('bookmarks', (b) => { state.bookmarks = b; renderBookmarks(); });
api.on('settings', (s) => { state.settings = s; renderBookmarks(); });
api.on('downloads', renderDownloads);
api.on('update', (d) => {
  $('#infobar').hidden = !d;
  if (d) $('#infobar-text').textContent = d.msg;
});
api.on('download-started', () => { const b = $('#downloads'); b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); });
api.on('focus-address', () => { address.focus(); address.select(); });
api.on('show-find', openFind);
api.on('find-result', (r) => {
  $('#find-count').textContent = r.total ? `${r.active} de ${r.total}` : (findInput.value ? 'Nenhum resultado' : '');
  findInput.classList.toggle('nomatch', !!findInput.value && !r.total);
});

if (new URLSearchParams(location.search).get('private') === '1') document.body.classList.add('private');
sendHeights();
