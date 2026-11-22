'use strict';
const api = window.chrome2;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TAB_MIME = 'text/antares-tab';

const state = {
  tabs: [], activeId: null, space: null, spaces: [], spaceCounts: {}, split: null, panes: null,
  bookmarks: [], settings: {}, isPrivate: false, collections: { orbits: [], missions: [], readLater: 0 }, recents: [],
  maximized: false, platform: '',
};
const tabEls = new Map();
const address = $('#address');
const omnibox = $('#omnibox');
const suggestEl = $('#suggest');

const P = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const ICONS = {
  globe: P('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5S9.5 6.1 12 3.5z"/>'),
  antares: P('<circle cx="12" cy="12" r="4.5"/><ellipse cx="12" cy="12" rx="10" ry="3.6" transform="rotate(-24 12 12)"/>'),
  close: P('<path d="M6 6l12 12M18 6L6 18"/>'),
  sound: P('<path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'),
  muted: P('<path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/>'),
  search: P('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  star: P('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>'),
  clock: P('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  more: P('<path d="M7 7l5 5-5 5M13 7l5 5-5 5"/>'),
  home: P('<path d="M4 11l8-7 8 7M6 9.5V20h4.5v-5.5h3V20H18V9.5"/>'),
  spaces: P('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><circle cx="17" cy="17" r="3.5"/>'),
  orbit: P('<circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="9.5" ry="4" transform="rotate(-30 12 12)"/><circle cx="19.5" cy="7.8" r="1.2"/>'),
  mission: P('<path d="M12 3c3 2.2 4.5 5.3 4.5 9l-1.8 4h-5.4L7.5 12c0-3.7 1.5-6.8 4.5-9z"/><circle cx="12" cy="10" r="1.6"/><path d="M9.3 16l-2.3 4 3-1M14.7 16l2.3 4-3-1"/>'),
  download: P('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  bookmark: P('<path d="M6 4h12v16l-6-4-6 4z"/>'),
  map: P('<circle cx="6" cy="7" r="1.6"/><circle cx="17" cy="5" r="1.6"/><circle cx="12" cy="13" r="1.6"/><circle cx="19" cy="17" r="1.6"/><circle cx="6" cy="19" r="1.6"/><path d="M7.4 7.7l3.4 4.2M13.4 12.2l2.6-5.8M13.3 14l4.4 2.3M10.8 14l-3.6 3.8"/>'),
  gear: P('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.6M12 18.6v2.6M4.2 7.5l2.3 1.3M17.5 15.2l2.3 1.3M4.2 16.5l2.3-1.3M17.5 8.8l2.3-1.3"/><circle cx="12" cy="12" r="6.6"/>'),
  link: P('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  camera: P('<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  split: P('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M12 4.5v15"/>'),
  media: P('<circle cx="12" cy="12" r="8.5"/><path d="M10 8.8v6.4l5.2-3.2z"/>'),
  devices: P('<rect x="2.5" y="5" width="13" height="10" rx="1.5"/><path d="M6 18.5h6"/><rect x="17" y="8" width="5" height="11" rx="1.2"/>'),
  perf: P('<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-5"/><path d="M4 19h16"/>'),
  grid: P('<circle cx="6" cy="6" r="1.5"/><circle cx="12" cy="6" r="1.5"/><circle cx="18" cy="6" r="1.5"/><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/><circle cx="6" cy="18" r="1.5"/><circle cx="12" cy="18" r="1.5"/><circle cx="18" cy="18" r="1.5"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  phone: P('<rect x="7" y="2.8" width="10" height="18.4" rx="2"/><path d="M11 18h2"/>'),
  tablet: P('<rect x="4.5" y="2.8" width="15" height="18.4" rx="2"/><path d="M11 18h2"/>'),
  desktop: P('<rect x="2.5" y="4" width="19" height="12.5" rx="1.5"/><path d="M8.5 20h7M12 16.5V20"/>'),
  rotate: P('<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>'),
  play: P('<path d="M8 5.5v13l10.5-6.5z"/>'),
  pause: P('<path d="M8 5.5v13M16 5.5v13"/>'),
  moon: P('<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>'),
  max: P('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  focusMode: P('<rect x="5" y="5" width="14" height="14" rx="1.5"/><path d="M9 9h6v6H9z"/>'),
  orbitMode: P('<rect x="2.5" y="4" width="19" height="16" rx="1.5"/><path d="M7 4v16M17 4v16M7 17h10"/>'),
  restore: P('<rect x="5.5" y="8.5" width="10" height="10" rx="1"/><path d="M8.5 8.5V5.5h10v10h-3"/>'),
  maximize: P('<rect x="6.5" y="6.5" width="11" height="11" rx="1"/>'),
  enter: P('<path d="M20 5v7H6M10 8l-4 4 4 4"/>'),
};
const ic = (name) => ICONS[name] || '';
function fillIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((el) => { if (!el.dataset.filled) { el.innerHTML = ic(el.dataset.icon); el.dataset.filled = '1'; } }); }
fillIcons();

/* ============================================================ background starfield */
const stars = $('#stars');
function drawStars() {
  const dpr = window.devicePixelRatio || 1;
  const w = innerWidth, h = innerHeight;
  stars.width = w * dpr; stars.height = h * dpr;
  const g = stars.getContext('2d'); g.scale(dpr, dpr);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = Math.round((w * h) / 2600);
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, r = rnd() < 0.92 ? rnd() * 0.9 + 0.2 : rnd() * 1.4 + 0.8;
    const warm = rnd() < 0.35;
    g.globalAlpha = 0.25 + rnd() * 0.65;
    g.fillStyle = warm ? '#ffcf9a' : '#f4ece2';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // faint orbital arcs
  g.globalAlpha = 0.09; g.strokeStyle = state.isPrivate ? '#a98bff' : '#ff8a34'; g.lineWidth = 1;
  for (const k of [0.55, 0.75, 0.95]) { g.beginPath(); g.ellipse(w / 2, h * 1.08, w * k, h * k * 0.55, 0, Math.PI, Math.PI * 2); g.stroke(); }
}

/* ============================================================ layout: tell the browser where the pages go */
const hole = $('#hole');
let overlays = new Set();
let lastLayout = '';
function setOverlay(name, on) { if (on) overlays.add(name); else overlays.delete(name); reportLayout(); }
function reportLayout() {
  const r = hole.getBoundingClientRect();
  const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  const onTop = overlays.size > 0;
  document.body.classList.toggle('on-top', onTop);
  // background everywhere except the hole (so pages show through when the frame is on top)
  const { x, y, width: w, height: h } = rect;
  const holePts = `${x}px ${y}px, ${x}px ${y + h}px, ${x + w}px ${y + h}px, ${x + w}px ${y}px, ${x}px ${y}px`;
  $('#bg').style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${holePts})`;
  // the light Órbita shell: an octagon with the same hole
  const sh = $('#shell'); const sr = sh.getBoundingClientRect();
  if (sr.width) {
    const c = Math.min(46, sr.width / 6, sr.height / 6); const W = sr.width, H = sr.height; const ox = sr.left, oy = sr.top;
    // octagon with a rounded hole where the page sits (the page itself has rounded corners)
    const oct = `M${c} 0H${W - c}L${W} ${c}V${H - c}L${W - c} ${H}H${c}L0 ${H - c}V${c}Z`;
    const hx = x - ox, hy = y - oy, r = Math.min(16, w / 2, h / 2);
    const hole = w > 0 && h > 0 ? `M${hx + r} ${hy}H${hx + w - r}A${r} ${r} 0 0 1 ${hx + w} ${hy + r}V${hy + h - r}A${r} ${r} 0 0 1 ${hx + w - r} ${hy + h}H${hx + r}A${r} ${r} 0 0 1 ${hx} ${hy + h - r}V${hy + r}A${r} ${r} 0 0 1 ${hx + r} ${hy}Z` : '';
    sh.style.clipPath = `path(evenodd, '${oct}${hole}')`;
  }
  Object.assign($('#hole-fill').style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  const key = JSON.stringify([rect, onTop, document.body.className.includes('mode-orbit')]);
  if (key === lastLayout) return;
  lastLayout = key;
  api.layout(rect, onTop, document.body.classList.contains('mode-orbit') ? 16 : 0);
}
new ResizeObserver(() => reportLayout()).observe(hole);
window.addEventListener('resize', () => { applyMode(); drawStars(); fitTabs(); renderBookmarks(); closePop(); if (!suggestEl.hidden) positionSuggest(); reportLayout(); });

/* ============================================================ modes (Órbita / Foco) */
function currentMode() {
  const m = state.settings.layoutMode;
  if (m === 'orbit' || m === 'focus') return m;
  // Modo Órbita while the window floats on the desktop; Modo Foco when it is maximized
  return state.maximized ? 'focus' : 'orbit';
}
function applyMode() {
  const m = currentMode();
  document.body.classList.toggle('mode-orbit', m === 'orbit');
  document.body.classList.toggle('mode-focus', m === 'focus');
  document.body.classList.toggle('no-panel', m === 'orbit' && state.settings.rightPanel === false);
  const b = $('#mode-btn');
  b.innerHTML = m === 'orbit' ? ic('focusMode') : ic('orbitMode');
  b.title = m === 'orbit' ? 'Mudar para o Modo Foco (interface compacta)' : 'Mudar para o Modo Órbita (painéis completos)';
  $('#panel-btn').classList.toggle('on', state.settings.rightPanel !== false);
  requestAnimationFrame(() => { fitTabs(); reportLayout(); });
}
function toggleMode() { api.setSetting('layoutMode', currentMode() === 'orbit' ? 'focus' : 'orbit'); }
$('#mode-btn').onclick = toggleMode;
$('#pod-orb').onclick = toggleMode;
$('#panel-btn').onclick = () => api.setSetting('rightPanel', state.settings.rightPanel === false);

/* ============================================================ window controls */
$('#w-min').onclick = () => api.win('min');
$('#w-max').onclick = () => api.win('max');
$('#w-close').onclick = () => api.win('close');
$('#top').addEventListener('dblclick', (e) => { if (!e.target.closest('button, .space, #brand')) api.win('max'); });
function renderWinState() {
  $('#w-max').innerHTML = state.maximized ? ic('restore') : ic('maximize');
  $('#w-max').title = state.maximized ? 'Restaurar' : 'Maximizar';
}

/* ============================================================ spaces */
function renderSpaces() {
  const box = $('#spaces');
  box.innerHTML = '';
  for (const sp of state.spaces) {
    const b = document.createElement('button');
    b.className = 'space' + (sp.id === state.space ? ' active' : '');
    b.style.setProperty('--c', sp.color || 'var(--accent)');
    const n = state.spaceCounts[sp.id] || 0;
    b.innerHTML = `<span class="sw"></span><span>${esc(sp.name)}</span>${n && sp.id !== state.space ? `<span class="n">${n}</span>` : ''}`;
    b.title = state.isPrivate ? 'Janela privada' : `${sp.name} — ${n} aba(s). Clique com o botão direito para opções. Ctrl+Alt+número troca de Space.`;
    if (!state.isPrivate) {
      b.onclick = () => api.space('switch', sp.id);
      b.oncontextmenu = (e) => { e.preventDefault(); api.space('menu', sp.id); };
      b.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(TAB_MIME)) { e.preventDefault(); b.classList.add('drop'); } });
      b.addEventListener('dragleave', () => b.classList.remove('drop'));
      b.addEventListener('drop', (e) => { b.classList.remove('drop'); const id = e.dataTransfer.getData(TAB_MIME); if (id) { e.preventDefault(); api.space('move', sp.id, id); } });
    }
    box.appendChild(b);
  }
  if (!state.isPrivate) {
    const add = document.createElement('button');
    add.className = 'space add'; add.title = 'Nova Space'; add.innerHTML = ic('plus');
    add.onclick = () => ask('Nome da nova Space', '', (v) => api.space('add', null, v));
    box.appendChild(add);
  }
  $('#compass-txt').textContent = (state.spaces.find((x) => x.id === state.space) || {}).name || '';
  tickPod();
}

/* ============================================================ tabs */
function faviconHtml(t) {
  if (t.loading) return '<div class="spinner"></div>';
  if (t.url && t.url.startsWith('antares://')) return '<img src="logo.png" alt="">';
  if (t.favicon) return `<img src="${esc(t.favicon)}" alt="">`;
  return ICONS.globe;
}
const visibleTabs = () => state.tabs.filter((t) => !t.space || t.space === state.space);

function makeTabEl(t) {
  const el = document.createElement('div');
  el.className = 'tab'; el.draggable = true; el.dataset.id = t.id; el.setAttribute('role', 'tab');
  el.innerHTML = '<span class="fav"></span><span class="title"></span><button class="audio" hidden></button><button class="close" title="Fechar aba (Ctrl+W)">' + ICONS.close + '</button>';
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.close, .audio')) api.activate(t.id);
    if (e.button === 1) e.preventDefault();
  });
  el.addEventListener('auxclick', (e) => { if (e.button === 1) api.closeTab(t.id); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); api.tabMenu(t.id); });
  el.querySelector('.close').addEventListener('click', (e) => { e.stopPropagation(); api.closeTab(t.id); });
  el.querySelector('.audio').addEventListener('click', (e) => { e.stopPropagation(); api.mute(t.id); });
  el.addEventListener('dragstart', (e) => { el.classList.add('dragging'); e.dataTransfer.setData(TAB_MIME, String(t.id)); e.dataTransfer.effectAllowed = 'move'; });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); clearDrop(); });
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault(); clearDrop();
    const r = el.getBoundingClientRect();
    el.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
  });
  el.addEventListener('drop', (e) => {
    const id = Number(e.dataTransfer.getData(TAB_MIME)); if (!id) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    // indexes are global (all spaces): place relative to the target tab
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
  el.classList.toggle('in-split', !!(state.split && state.split.includes(t.id)));
  const title = t.title || (t.display ? t.display : 'Nova aba');
  const titleEl = el.querySelector('.title');
  if (titleEl.textContent !== title) titleEl.textContent = title;
  el.title = t.sleeping ? `${title}\n(Em repouso para economizar memória — clique para reativar)` : title;
  const favKey = `${t.loading}|${t.favicon}|${(t.url || '').startsWith('antares://')}`;
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
  const vis = visibleTabs();
  const ids = new Set(vis.map((t) => t.id));
  for (const [id, el] of tabEls) if (!ids.has(id)) { el.remove(); tabEls.delete(id); }
  vis.forEach((t, i) => {
    let el = tabEls.get(t.id);
    if (!el) { el = makeTabEl(t); tabEls.set(t.id, el); }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    updateTabEl(el, t);
  });
  fitTabs();
}
function fitTabs() {
  const row = $('#tabsrow');
  const avail = row.clientWidth - 24 - 40 - 80;
  const n = Math.max(1, tabEls.size);
  const w = Math.max(44, Math.min(220, Math.floor(avail / n) - 4));
  for (const el of tabEls.values()) { el.style.width = w + 'px'; el.style.flexBasis = w + 'px'; el.classList.toggle('narrow', w < 90); }
}

/* ============================================================ toolbar */
function activeTab() { return state.tabs.find((t) => t.id === state.activeId); }
let dirty = false;

function renderToolbar() {
  const t = activeTab();
  renderSidebarActive(t);
  if (!t) return;
  $('#back').disabled = !t.canBack;
  $('#forward').disabled = !t.canForward;
  const rl = $('#reload');
  rl.classList.toggle('loading', !!t.loading);
  rl.title = t.loading ? 'Parar (Esc)' : 'Recarregar (F5)';
  const web = /^(https?|file):/.test(t.url || '');
  const star = $('#star');
  star.classList.toggle('on', !!t.bookmarked);
  star.title = t.bookmarked ? 'Remover dos favoritos (Ctrl+D)' : 'Adicionar aos favoritos (Ctrl+D)';
  star.hidden = !web;
  $('#readlater').disabled = !/^https?:/.test(t.url || '') || state.isPrivate;
  $('#mission-add').disabled = !/^https?:/.test(t.url || '') || state.isPrivate;
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
  const di = $('#device-ind'); di.hidden = !t.device || t.device === 'desktop'; di.textContent = t.device === 'phone' ? 'Celular' : 'Tablet';
}
function setSiteIcon(kind) {
  const s = $('#site-icon');
  s.className = kind;
  s.title = { secure: 'A conexão é segura (HTTPS)', insecure: 'A conexão não é segura', file: 'Arquivo local', internal: 'Página do Antares', search: '' }[kind] || '';
}

$('#back').onclick = () => api.back();
$('#forward').onclick = () => api.forward();
$('#reload').onclick = (e) => { const t = activeTab(); if (t && t.loading) api.stop(); else api.reload(e.shiftKey || e.ctrlKey); };
$('#home').onclick = () => api.home();
$('#star').onclick = () => api.bookmark();
$('#readlater').onclick = () => api.readLater();
$('#mission-add').onclick = () => api.missionMenu();
$('#zoom-ind').onclick = () => api.zoom(0);
$('#device-ind').onclick = () => api.device('desktop');
$('#shield').onclick = () => { const t = activeTab(); if (t) api.shieldMenu(t.id); };
$('#popups').onclick = () => { const t = activeTab(); if (t) api.popupMenu(t.id); };
$('#site-icon').addEventListener('mousedown', (e) => {
  if (dirty) return;
  e.preventDefault();
  const t = activeTab(); if (t && t.display) api.siteMenu(t.id);
});
$('#infobar-more').onclick = () => api.updateAction();
$('#infobar-close').onclick = () => api.dismissUpdate();
$('#newtab').onclick = () => api.newTab();
$('#downloads').onclick = () => api.internal('downloads');
$('#menu').onclick = () => { const r = $('#menu').getBoundingClientRect(); api.menu(r.right - 260, r.bottom + 2); };
$('#tabsrow').addEventListener('dblclick', (e) => { if (e.target === $('#tabsrow') || e.target.classList.contains('flex')) api.newTab(); });
for (const id of ['back', 'forward']) $('#' + id).addEventListener('auxclick', (e) => { if (e.button === 1) api[id](); });

/* drag links/text onto the frame: open in a new tab */
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes(TAB_MIME)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; document.body.classList.add('dragover');
});
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragover'); });
document.addEventListener('drop', (e) => {
  document.body.classList.remove('dragover');
  if (e.dataTransfer.types.includes(TAB_MIME)) return;
  e.preventDefault();
  if (e.target.closest && e.target.closest('input')) {
    const txt = e.dataTransfer.getData('text/plain'); if (txt && e.target === address) { address.value = txt; address.focus(); }
    return;
  }
  const u = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
  if (/^https?:\/\//i.test(u)) api.newTab(u);
});

/* ============================================================ omnibox */
let suggestions = []; let sel = -1; let typed = ''; let reqSeq = 0; let lastInputType = ''; let inline = null;
address.addEventListener('focus', () => { omnibox.classList.add('focused'); requestAnimationFrame(() => { if (document.activeElement === address) address.select(); }); });
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
    e.preventDefault(); address.setSelectionRange(address.value.length, address.value.length);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const s = suggestEl.hidden ? null : rowAt(sel);
    go(s && s.kind !== 'search' ? s.url : address.value, e.altKey);
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
function rowAt(i) { if (i < 0) return null; if (i === 0) return { kind: 'search', url: typed }; return suggestions[i - 1]; }
async function refreshSuggest() {
  const q = typed.trim();
  if (!q) { hideSuggest(); return; }
  const my = ++reqSeq;
  const res = await api.suggest(q);
  if (my !== reqSeq || document.activeElement !== address) return;
  suggestions = res || []; sel = 0;
  inline = null;
  const ql = q.toLowerCase();
  if (lastInputType === 'insertText' && address.value === typed && address.selectionEnd === typed.length && !/[\s/]/.test(ql)) {
    for (const s of suggestions) {
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
function engineName() { return (state.settings.searchEngines || {})[state.settings.searchEngine] || 'Google'; }
function paintSuggest() {
  const q = typed.trim();
  const shown = inline && sel === 0 ? address.value : q;
  const looksUrl = !!(inline && sel === 0) || /^[^\s]+\.[a-z]{2,}(\/|$)|^https?:|^localhost/i.test(q);
  let html = `<div class="row ${sel === 0 ? 'sel' : ''}" data-i="0"><span class="ic">${looksUrl ? ICONS.globe : ICONS.search}</span><span class="t">${esc(shown)}</span><span class="u" style="color:var(--muted)">${looksUrl ? 'Abrir endereço' : 'Pesquisar no ' + esc(engineName())}</span></div>`;
  suggestions.forEach((s, i) => {
    const icon = s.favicon ? `<img src="${esc(s.favicon)}" alt="">` : (s.type === 'bookmark' ? ICONS.star : ICONS.clock);
    html += `<div class="row ${sel === i + 1 ? 'sel' : ''}" data-i="${i + 1}"><span class="ic">${icon}</span><span class="t">${hl(s.title || s.url, q)}</span><span class="u">${hl(s.url.replace(/^https?:\/\/(www\.)?/, ''), q)}</span></div>`;
  });
  suggestEl.innerHTML = html;
  suggestEl.querySelectorAll('img').forEach((img) => { img.onerror = () => img.remove(); });
  if (suggestEl.hidden) { suggestEl.hidden = false; omnibox.classList.add('open'); setOverlay('suggest', true); }
}
function positionSuggest() {
  const r = omnibox.getBoundingClientRect();
  Object.assign(suggestEl.style, { left: r.left + 'px', top: (r.bottom - 1) + 'px', width: r.width + 'px' });
}
function hideSuggest() {
  if (suggestEl.hidden) return;
  suggestEl.hidden = true; omnibox.classList.remove('open'); suggestions = []; sel = -1; setOverlay('suggest', false);
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

/* ============================================================ bookmarks bar */
function renderBookmarks() {
  const bar = $('#bookmarksbar');
  bar.classList.toggle('hidden', !state.settings.showBookmarksBar);
  if (!state.settings.showBookmarksBar) { requestAnimationFrame(reportLayout); return; }
  if (!state.bookmarks.length) {
    bar.innerHTML = '<span class="empty">Para acessar rapidamente, adicione favoritos aqui clicando na estrela ☆ na barra de endereço.</span>';
    requestAnimationFrame(reportLayout); return;
  }
  bar.innerHTML = '';
  const maxW = bar.clientWidth - 70; let used = 0;
  for (const b of state.bookmarks) {
    const a = document.createElement('div');
    a.className = 'bm'; a.title = `${b.title}\n${b.url}`;
    let host = ''; try { host = new URL(b.url).hostname.replace(/^www\./, ''); } catch {}
    a.innerHTML = (b.favicon ? `<img src="${esc(b.favicon)}" alt="">` : `<span class="dot">${esc(host[0] || '?')}</span>`) + `<span>${esc(b.title || host)}</span>`;
    const img = a.querySelector('img');
    if (img) img.onerror = () => { img.outerHTML = `<span class="dot">${esc(host[0] || '?')}</span>`; };
    a.addEventListener('click', (e) => api.open(b.url, e.ctrlKey || e.metaKey));
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
  requestAnimationFrame(reportLayout);
}

/* ============================================================ find bar */
const findbar = $('#findbar'); const findInput = $('#find-input');
function openFind() {
  findbar.hidden = false; findInput.focus(); findInput.select(); requestAnimationFrame(reportLayout);
  if (findInput.value) api.find(findInput.value, { findNext: false });
}
function closeFind() { findbar.hidden = true; $('#find-count').textContent = ''; api.stopFind(); api.focusPage(); requestAnimationFrame(reportLayout); }
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

/* ============================================================ downloads */
function renderDownloads(s) {
  const b = $('#downloads');
  b.classList.toggle('active', s.active > 0);
  b.classList.toggle('indeterminate', s.active > 0 && s.progress < 0);
  b.title = s.active ? `${s.active} download(s) em andamento` : 'Downloads (Ctrl+J)';
  if (s.progress >= 0) b.querySelector('.ring circle').style.strokeDasharray = `${Math.round(s.progress * 100)} 100`;
}

/* ============================================================ sidebar */
document.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => api.internal(b.dataset.go); });
function renderSidebarActive(t) {
  let key = '';
  try {
    const u = new URL((t && t.url) || '');
    if (u.protocol === 'antares:') key = u.hostname + (u.hostname === 'universe' ? (u.hash || '#spaces') : '');
  } catch {}
  document.querySelectorAll('.side-item[data-go]').forEach((b) => b.classList.toggle('active', b.dataset.go === key));
}
function renderCollections() {
  const c = state.collections || {};
  const set = (id, n) => { $(id).textContent = n ? String(n) : ''; };
  set('#c-orbits', (c.orbits || []).length); set('#c-missions', (c.missions || []).length); set('#c-read', c.readLater || 0);
  const box = $('#side-missions'); box.innerHTML = '';
  for (const m of (c.missions || []).slice(0, 3)) {
    const b = document.createElement('button');
    b.textContent = m.title; b.title = `Abrir as ${m.pages} página(s) da missão “${m.title}”`;
    b.onclick = () => api.mission('open', m.id);
    box.appendChild(b);
  }
}

/* ============================================================ right panel */
$('#rsearch').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#rsearch-in').value.trim(); if (!v) return;
  api.navigate(v); $('#rsearch-in').value = ''; $('#rsearch-in').blur();
});
$('#links-edit').onclick = () => api.internal('newtab#editar');
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function favFor(url) {
  const b = state.bookmarks.find((x) => x.favicon && hostOf(x.url) === hostOf(url));
  const r = state.recents.find((x) => x.favicon && hostOf(x.url) === hostOf(url));
  return (b && b.favicon) || (r && r.favicon) || '';
}
function renderRightPanel() {
  $('#rsearch-eng').textContent = `Pesquisando com ${engineName()}`;
  const links = $('#links'); links.innerHTML = '';
  for (const s of (state.settings.shortcuts || []).slice(0, 9)) {
    const a = document.createElement('button');
    a.className = 'qlink'; a.title = s.url;
    const f = favFor(s.url);
    a.innerHTML = `<span class="fi">${f ? `<img src="${esc(f)}" alt="">` : esc((s.title || hostOf(s.url))[0] || '?')}</span><span>${esc(s.title)}</span>`;
    const img = a.querySelector('img'); if (img) img.onerror = () => { img.parentNode.textContent = (s.title || '?')[0]; };
    a.onclick = (e) => api.open(s.url, e.ctrlKey || e.metaKey);
    a.onauxclick = (e) => { if (e.button === 1) api.open(s.url, true); };
    links.appendChild(a);
  }
  const rec = $('#recents'); rec.innerHTML = '';
  if (state.isPrivate) { rec.innerHTML = '<div class="empty-note">Nada é guardado em janelas privadas.</div>'; return; }
  if (!state.recents.length) { rec.innerHTML = '<div class="empty-note">As páginas que você visitar aparecerão aqui.</div>'; return; }
  for (const r of state.recents) {
    const a = document.createElement('button');
    a.className = 'recent'; a.title = `${r.title}\n${r.url}`;
    a.innerHTML = `<span class="th"${r.thumb ? ` style="background-image:url('${esc(r.thumb)}')"` : ''}>${r.thumb ? '' : (r.favicon ? `<img src="${esc(r.favicon)}" alt="">` : ICONS.globe)}</span><span class="tx"><b>${esc(r.title)}</b><small>${esc(hostOf(r.url))}</small></span>`;
    const im = a.querySelector('.th img'); if (im) im.onerror = () => { im.outerHTML = ICONS.globe; };
    a.onclick = (e) => api.open(r.url, e.ctrlKey || e.metaKey);
    a.onauxclick = (e) => { if (e.button === 1) api.open(r.url, true); };
    rec.appendChild(a);
  }
}

/* ============================================================ split view pane headers */
function renderPanes() {
  const box = $('#panes'); box.innerHTML = '';
  $('#d-split').classList.toggle('on', !!state.panes);
  if (!state.panes) return;
  for (const p of state.panes.panes) {
    const t = state.tabs.find((x) => x.id === p.id); if (!t) continue;
    const h = document.createElement('div');
    h.className = 'pane-head' + (p.id === state.activeId ? ' active' : '');
    Object.assign(h.style, { left: p.head.x + 'px', top: p.head.y + 'px', width: p.head.width + 'px', height: p.head.height + 'px' });
    // the real address of every pane is always visible (titles are chosen by the site and could imitate another one)
    let where = ''; try { const u = new URL(t.url); where = u.protocol === 'antares:' ? 'Antares' : u.host; } catch {}
    const lock = t.secure === 'insecure' ? `<span class="ph-warn" title="Conexão não segura">Não seguro</span>` : '';
    h.innerHTML = `${t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : ICONS.globe}${lock}<span class="ph-host">${esc(where)}</span><span class="t">${esc(t.title || t.display || 'Nova aba')}</span>
      <button data-a="max" title="Mostrar só esta página">${ICONS.max}</button><button data-a="close" title="Tirar do Split View">${ICONS.close}</button>`;
    const img = h.querySelector('img'); if (img) img.onerror = () => img.remove();
    h.onmousedown = (e) => { if (!e.target.closest('button')) api.split('focus', p.id); };
    h.querySelector('[data-a=max]').onclick = () => api.split('exit', p.id);
    h.querySelector('[data-a=close]').onclick = () => api.split('remove', p.id);
    box.appendChild(h);
  }
}

/* ============================================================ popovers (dock) */
const pop = $('#pop');
let popFor = null;
function openPop(btn, html, onReady) {
  if (popFor === btn && !pop.hidden) { closePop(); return; }
  popFor = btn;
  pop.innerHTML = html; fillIcons(pop);
  pop.hidden = false; setOverlay('pop', true);
  const r = btn.getBoundingClientRect(); const pr = pop.getBoundingClientRect();
  const left = Math.max(10, Math.min(innerWidth - pr.width - 10, r.left + r.width / 2 - pr.width / 2));
  Object.assign(pop.style, { left: left + 'px', top: Math.max(10, r.top - pr.height - 10) + 'px' });
  if (onReady) onReady(pop);
}
function closePop() { if (pop.hidden) return; pop.hidden = true; popFor = null; setOverlay('pop', false); }
document.addEventListener('mousedown', (e) => {
  if (!pop.hidden && !e.target.closest('#pop') && !e.target.closest('.dock-btn')) closePop();
  if (!suggestEl.hidden && !e.target.closest('#suggest, #omnibox')) hideSuggest();
});

$('#d-capture').onclick = () => api.capture();

function splitPop() {
  const btn = $('#d-split');
  const inSplit = state.split || [];
  const others = visibleTabs().filter((t) => !inSplit.includes(t.id) && t.id !== state.activeId);
  const rows = others.slice(0, 12).map((t) => `<div class="row" data-id="${t.id}">${t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : ICONS.globe}<span class="t">${esc(t.title || t.display || 'Nova aba')}</span><small>Adicionar</small></div>`).join('');
  openPop(btn, `<h3><span data-icon="split"></span>Split View</h3>
    <div class="note">${inSplit.length ? `Mostrando ${inSplit.length} páginas lado a lado (máximo 4).` : 'Veja até 4 páginas ao mesmo tempo. Escolha uma aba para dividir a tela com a atual:'}</div>
    <div style="margin-top:8px">${rows || '<div class="note" style="opacity:.7">Nenhuma outra aba nesta Space.</div>'}</div>
    <div class="btns"><button class="btn primary" data-a="new">Dividir com nova aba</button>${inSplit.length ? '<button class="btn" data-a="exit">Sair do Split View</button>' : ''}</div>`, (p) => {
    p.querySelectorAll('.row').forEach((r) => { r.onclick = () => { closePop(); api.split('add', r.dataset.id); }; });
    p.querySelector('[data-a=new]').onclick = () => { closePop(); api.split('add'); };
    const ex = p.querySelector('[data-a=exit]'); if (ex) ex.onclick = () => { closePop(); api.split('exit'); };
    p.querySelectorAll('img').forEach((img) => { img.onerror = () => img.remove(); });
  });
}
$('#d-split').onclick = splitPop;

async function mediaPop(refresh) {
  const list = (await api.media()) || [];
  $('#d-media .dot').hidden = !list.some((x) => x.playing);
  const html = `<h3><span data-icon="media"></span>Mídia</h3>` + (list.length
    ? list.map((m) => `<div class="row" data-id="${m.id}">${m.favicon ? `<img src="${esc(m.favicon)}" alt="">` : ICONS.media}<span class="t" title="${esc(m.title)}">${esc(m.title)}</span>
        <button class="mini-btn" data-a="toggle" title="${m.playing ? 'Pausar' : 'Tocar'}">${m.playing ? ICONS.pause : ICONS.play}</button>
        <button class="mini-btn" data-a="mute" title="${m.muted ? 'Ativar som' : 'Silenciar'}">${m.muted ? ICONS.muted : ICONS.sound}</button>
        <button class="mini-btn" data-a="go" title="Ir para a aba">${ICONS.enter}</button></div>`).join('')
    : '<div class="note">Nenhuma aba está tocando áudio ou vídeo agora.</div>');
  const wire = (p) => {
    p.querySelectorAll('.row').forEach((r) => r.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = async () => { const a = b.dataset.a; if (a === 'go') closePop(); await api.mediaAction(r.dataset.id, a); if (a !== 'go') setTimeout(() => mediaPop(true), 250); };
    }));
    p.querySelectorAll('img').forEach((img) => { img.onerror = () => img.remove(); });
  };
  if (refresh) { if (popFor !== $('#d-media') || pop.hidden) return; pop.innerHTML = html; fillIcons(pop); wire(pop); return; }
  openPop($('#d-media'), html, wire);
}
$('#d-media').onclick = () => mediaPop(false);

function devicesPop() {
  const t = activeTab(); const cur = (t && t.device) || 'desktop';
  const d = (id, name, icon) => `<button class="dev ${cur === id ? 'on' : ''}" data-d="${id}">${ICONS[icon]}<span>${name}</span></button>`;
  openPop($('#d-devices'), `<h3><span data-icon="devices"></span>Dispositivos</h3>
    <div class="note" style="margin-bottom:10px">Veja como esta página fica em outras telas (só nesta aba).</div>
    <div class="devs">${d('desktop', 'Computador', 'desktop')}${d('phone', 'Celular', 'phone')}${d('tablet', 'Tablet', 'tablet')}</div>
    <div class="btns"><button class="btn" data-a="rotate" ${cur === 'desktop' ? 'disabled' : ''}>Girar a tela</button></div>`, (p) => {
    p.querySelectorAll('[data-d]').forEach((b) => { b.onclick = () => { closePop(); api.device(b.dataset.d); }; });
    p.querySelector('[data-a=rotate]').onclick = () => { closePop(); api.device(cur, true); };
  });
}
$('#d-devices').onclick = devicesPop;

async function perfPop(refresh) {
  const info = await api.perf(); if (!info) return;
  const max = Math.max(1, ...info.tabs.map((x) => x.mb));
  const html = `<h3><span data-icon="perf"></span>Desempenho</h3>
    <div class="stats"><div class="stat"><small>Memória</small><span class="big">${info.totalMb}</span> MB</div>
    <div class="stat"><small>CPU</small><span class="big">${info.cpu}</span>%</div>
    <div class="stat"><small>Bloqueados</small><span class="big">${info.blocked > 999 ? Math.round(info.blocked / 1000) + 'k' : info.blocked}</span></div></div>
    ${info.tabs.slice(0, 8).map((t) => `<div class="row" data-id="${t.id}">${t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : ICONS.globe}<span class="t" title="${esc(t.title)}">${esc(t.title || 'Aba')}<span class="bar"><i style="width:${t.sleeping ? 0 : Math.round((t.mb / max) * 100)}%"></i></span></span>
      <small>${t.sleeping ? 'em repouso' : t.mb + ' MB'}</small>${!t.active && !t.sleeping ? `<button class="mini-btn" data-a="sleep" title="Pôr em repouso">${ICONS.moon}</button>` : ''}</div>`).join('')}
    <div class="note" style="margin-top:8px">${info.sleeping} aba(s) em repouso. Repouso automático após 30 min: <b>${info.tabSleep ? 'ativado' : 'desativado'}</b>.</div>
    <div class="btns"><button class="btn primary" data-a="sleep-all">Pôr abas em segundo plano em repouso</button><button class="btn" data-a="toggle-sleep">${info.tabSleep ? 'Desativar' : 'Ativar'} repouso automático</button></div>`;
  const wire = (p) => {
    p.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = async () => { const row = b.closest('.row'); await api.perfAction(b.dataset.a, row ? row.dataset.id : 0); perfPop(true); };
    });
    p.querySelectorAll('img').forEach((img) => { img.onerror = () => img.remove(); });
  };
  if (refresh) { if (popFor !== $('#d-perf') || pop.hidden) return; pop.innerHTML = html; fillIcons(pop); wire(pop); return; }
  openPop($('#d-perf'), html, wire);
}
$('#d-perf').onclick = () => perfPop(false);
$('#d-more').onclick = () => { closePop(); const r = $('#d-more').getBoundingClientRect(); api.menu(Math.min(r.left, innerWidth - 270), r.top - 8); };

/* ============================================================ command palette (orb) */
const palWrap = $('#palette-wrap'); const palIn = $('#pal-input'); const palList = $('#pal-list');
let palItems = []; let palSel = 0; let palSeq = 0;
function openPalette() {
  if (!palWrap.hidden) { palIn.select(); return; }
  closePop(); hideSuggest();
  palWrap.hidden = false; setOverlay('palette', true);
  palIn.value = ''; palIn.focus(); queryPalette();
}
function closePalette(focusPage = true) { if (palWrap.hidden) return; palWrap.hidden = true; setOverlay('palette', false); if (focusPage) api.focusPage(); }
async function queryPalette() {
  const my = ++palSeq;
  const items = (await api.palette(palIn.value)) || [];
  if (my !== palSeq) return;
  palItems = items; palSel = 0; paintPalette();
}
function paintPalette() {
  if (!palItems.length) { palList.innerHTML = '<div class="pal-empty">Nada encontrado.</div>'; return; }
  let html = ''; let g = '';
  palItems.forEach((it, i) => {
    if (it.group !== g) { g = it.group; html += `<div class="pal-g">${esc(g)}</div>`; }
    const icon = it.kind === 'space' ? `<span class="sw" style="background:${esc(it.color || 'var(--accent)')}"></span>`
      : it.favicon ? `<img src="${esc(it.favicon)}" alt="">`
      : ic({ tab: 'globe', orbit: 'orbit', mission: 'mission', url: 'clock', search: 'search', cmd: 'grid' }[it.kind] || 'grid');
    html += `<div class="pal-row ${i === palSel ? 'sel' : ''}" data-i="${i}"><span class="ic">${icon}</span><span class="t">${esc(it.title)}</span><small>${esc(it.sub || '')}</small></div>`;
  });
  palList.innerHTML = html;
  palList.querySelectorAll('img').forEach((img) => { img.onerror = () => img.remove(); });
  const s = palList.querySelector('.pal-row.sel'); if (s) s.scrollIntoView({ block: 'nearest' });
}
function runPalette(i) { const it = palItems[i]; if (!it) return; closePalette(it.kind !== 'cmd'); api.paletteRun(it); }
palIn.addEventListener('input', queryPalette);
palIn.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!palItems.length) return; palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % palItems.length; paintPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(palSel); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
palList.addEventListener('mousemove', (e) => { const r = e.target.closest('.pal-row'); if (r && Number(r.dataset.i) !== palSel) { palSel = Number(r.dataset.i); paintPalette(); } });
palList.addEventListener('click', (e) => { const r = e.target.closest('.pal-row'); if (r) runPalette(Number(r.dataset.i)); });
palWrap.addEventListener('mousedown', (e) => { if (e.target === palWrap) closePalette(); });
$('#orb').onclick = openPalette;

/* ============================================================ small prompt (names) */
const prWrap = $('#prompt-wrap'); let prCb = null;
function ask(title, value, cb) {
  closePop(); prCb = cb;
  $('#prompt-t').textContent = title; $('#prompt-in').value = value || '';
  prWrap.hidden = false; setOverlay('prompt', true);
  setTimeout(() => { $('#prompt-in').focus(); $('#prompt-in').select(); }, 0);
}
function closeAsk() { if (prWrap.hidden) return; prWrap.hidden = true; prCb = null; setOverlay('prompt', false); api.focusPage(); }
$('#prompt').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#prompt-in').value.trim(); const cb = prCb; closeAsk(); if (v && cb) cb(v); });
$('#prompt-cancel').onclick = closeAsk;
$('#prompt-in').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAsk(); });
prWrap.addEventListener('mousedown', (e) => { if (e.target === prWrap) closeAsk(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!pop.hidden) closePop(); }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
});

/* ============================================================ events from the browser */
api.on('init', (d) => {
  state.isPrivate = d.isPrivate; state.bookmarks = d.bookmarks; state.settings = d.settings; state.platform = d.platform;
  state.collections = d.collections || state.collections; state.recents = d.recents || [];
  document.body.classList.toggle('private', d.isPrivate);
  document.body.classList.toggle('mac', d.platform === 'darwin');
  $('#private-badge').hidden = !d.isPrivate;
  for (const id of ['#readlater', '#mission-add', '#links-edit']) $(id).hidden = d.isPrivate;
  applyMode(); drawStars(); renderBookmarks(); renderDownloads(d.downloads); renderCollections(); renderRightPanel(); renderWinState();
  reportLayout();
});
api.on('tabs', (d) => {
  if (d.activeId !== state.activeId) dirty = false;
  state.tabs = d.tabs; state.activeId = d.activeId; state.split = d.split || null;
  if (d.space) state.space = d.space;
  renderTabs(); renderToolbar(); renderPanes();
  $('#d-media .dot').hidden = !state.tabs.some((t) => t.playing || t.audible);
});
api.on('tab', (t) => {
  const i = state.tabs.findIndex((x) => x.id === t.id);
  if (i < 0) return;
  state.tabs[i] = t;
  const el = tabEls.get(t.id); if (el) updateTabEl(el, t);
  if (t.id === state.activeId) renderToolbar();
  if (state.panes && state.panes.panes.some((p) => p.id === t.id)) renderPanes();
  $('#d-media .dot').hidden = !state.tabs.some((x) => x.playing || x.audible);
});
api.on('spaces', (d) => { state.spaces = d.spaces; state.space = d.current; state.spaceCounts = d.counts || {}; renderSpaces(); renderTabs(); });
api.on('split', (d) => { state.panes = d; renderPanes(); });
api.on('device-frame', (d) => {
  const f = $('#device-frame'); f.hidden = !d; if (!d) return;
  const pad = d.device === 'tablet' ? 14 : 12;
  f.className = d.device === 'tablet' ? 'tablet' : '';
  Object.assign(f.style, { left: d.x - pad + 'px', top: d.y - pad - 6 + 'px', width: d.width + pad * 2 + 'px', height: d.height + pad * 2 + 12 + 'px' });
});
api.on('collections', (c) => { state.collections = c; renderCollections(); });
api.on('recents', (r) => { state.recents = r || []; renderRightPanel(); });
api.on('bookmarks', (b) => { state.bookmarks = b; renderBookmarks(); renderRightPanel(); });
api.on('settings', (s) => { state.settings = s; applyMode(); renderBookmarks(); renderRightPanel(); });
api.on('downloads', renderDownloads);
api.on('update', (d) => {
  $('#infobar').hidden = !d;
  if (d) { $('#infobar-text').textContent = d.msg; $('#infobar-more').textContent = { restart: 'Reiniciar agora', download: 'Baixar' }[d.action] || 'Saiba mais'; $('#infobar').classList.toggle('good', d.action === 'restart'); }
  requestAnimationFrame(reportLayout);
});
api.on('download-started', () => { const b = $('#downloads'); b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); });
api.on('focus-address', () => { closePalette(false); address.focus(); address.select(); });
api.on('show-find', openFind);
api.on('find-result', (r) => {
  $('#find-count').textContent = r.total ? `${r.active} de ${r.total}` : (findInput.value ? 'Nenhum resultado' : '');
  findInput.classList.toggle('nomatch', !!findInput.value && !r.total);
});
api.on('fullscreen', (on) => { document.body.classList.toggle('fullscreen', !!on); });
api.on('win-state', (s) => { state.maximized = !!(s.maximized || s.fullscreen); renderWinState(); applyMode(); });
api.on('win-focus', (f) => document.body.classList.toggle('win-blur', !f));
api.on('palette', () => openPalette());
api.on('toggle-mode', toggleMode);
api.on('space-rename', (id) => { const sp = state.spaces.find((x) => x.id === id); if (sp) ask('Novo nome da Space', sp.name, (v) => api.space('rename', id, v)); });

if (new URLSearchParams(location.search).get('private') === '1') document.body.classList.add('private');
function tickPod() {
  const d = new Date();
  $('#pod-time').textContent = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  $('#pod-date').textContent = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
  $('#pod-space').textContent = ((state.spaces.find((x) => x.id === state.space) || {}).name || '').toUpperCase();
}
setInterval(tickPod, 15000); tickPod();
applyMode(); drawStars(); reportLayout();
