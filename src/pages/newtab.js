'use strict';
/* ---------------------------------------------------------------- sky and sun */
const space = $('#space');
function drawSpace() {
  const dpr = devicePixelRatio || 1; const w = innerWidth, h = innerHeight;
  space.width = w * dpr; space.height = h * dpr;
  const g = space.getContext('2d'); g.scale(dpr, dpr);
  const bg = g.createRadialGradient(w / 2, h * 1.15, 0, w / 2, h * 1.15, Math.max(w, h) * 0.9);
  bg.addColorStop(0, 'rgba(255,110,20,.45)'); bg.addColorStop(0.35, 'rgba(120,40,8,.18)'); bg.addColorStop(1, 'rgba(7,6,8,0)');
  g.fillStyle = '#070608'; g.fillRect(0, 0, w, h); g.fillStyle = bg; g.fillRect(0, 0, w, h);
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0, n = Math.round((w * h) / 2200); i < n; i++) {
    g.globalAlpha = 0.2 + rnd() * 0.7; g.fillStyle = rnd() < 0.3 ? '#ffd2a1' : '#f4ece2';
    g.beginPath(); g.arc(rnd() * w, rnd() * h, rnd() < 0.93 ? rnd() * 0.9 + 0.2 : rnd() * 1.5 + 0.8, 0, 7); g.fill();
  }
  g.globalAlpha = 0.1; g.strokeStyle = '#ff8a34';
  for (const k of [0.5, 0.7, 0.9]) { g.beginPath(); g.ellipse(w / 2, h * 1.1, w * k, h * k * 0.5, 0, Math.PI, 2 * Math.PI); g.stroke(); }
  g.globalAlpha = 1;
}
let priv = false;
addEventListener('resize', drawSpace);
drawSpace();

/* ---------------------------------------------------------------- clock / greeting */
function tick() {
  const d = new Date(); const h = d.getHours();
  const g = h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  $('#greet').textContent = `${g} · ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · ${d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}`;
}
tick(); setInterval(tick, 10000);

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#q').value.trim(); if (!v) return;
  const url = await antares.resolve(v);
  if (url) location.href = url;
});

/* ---------------------------------------------------------------- shortcuts */
let shortcuts = []; let favs = {}; let editing = false;
const letter = (s) => esc(((s.title || host(s.url) || '?')[0]));
function renderTiles() {
  const box = $('#tiles');
  $('#shortcuts-box').classList.toggle('editing', editing);
  $('#edit').textContent = editing ? 'Concluir' : 'Editar';
  box.innerHTML = shortcuts.map((s, i) => {
    const f = favs[host(s.url)];
    return `<a class="tile" href="${esc(s.url)}" title="${esc(s.url)}" data-i="${i}" draggable="${editing}"><div class="ic" data-l="${letter(s)}">${f ? `<img src="${esc(f)}" alt="">` : letter(s)}</div><span>${esc(s.title)}</span><button class="del" title="Remover" data-del="${i}">${ICON.x}</button></a>`;
  }).join('') + (editing || !shortcuts.length ? '<a class="tile add" href="#" id="addtile"><div class="ic">+</div><span>Adicionar</span></a>' : '');
  box.querySelectorAll('.tile img').forEach((img) => { img.onerror = () => { img.parentElement.textContent = img.parentElement.dataset.l; }; });
  box.querySelectorAll('[data-del]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); shortcuts.splice(Number(b.dataset.del), 1); saveShortcuts(); }; });
  const add = $('#addtile'); if (add) add.onclick = (e) => { e.preventDefault(); $('#addform').hidden = false; $('#add-title').focus(); };
  if (editing) {
    box.querySelectorAll('.tile:not(.add)').forEach((t) => {
      t.onclick = (e) => e.preventDefault();
      t.ondragstart = (e) => e.dataTransfer.setData('text/x-sc', t.dataset.i);
      t.ondragover = (e) => e.preventDefault();
      t.ondrop = (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/x-sc')); const to = Number(t.dataset.i);
        if (Number.isNaN(from) || from === to) return;
        const [x] = shortcuts.splice(from, 1); shortcuts.splice(to, 0, x); saveShortcuts();
      };
    });
  }
}
async function saveShortcuts() { shortcuts = await antares.shortcuts(shortcuts); renderTiles(); }
$('#edit').onclick = () => { editing = !editing; if (!editing) $('#addform').hidden = true; renderTiles(); };
$('#add-cancel').onclick = () => { $('#addform').hidden = true; };
$('#addform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = await antares.resolve($('#add-url').value.trim());
  if (!url || !/^https?:/.test(url)) { toast('Digite um endereço válido'); return; }
  if (shortcuts.length >= 12) { toast('Máximo de 12 links rápidos'); return; }
  shortcuts.push({ title: $('#add-title').value.trim() || host(url), url });
  $('#add-title').value = ''; $('#add-url').value = ''; $('#addform').hidden = true;
  saveShortcuts();
});

/* ---------------------------------------------------------------- cards */
function item({ url, title, fav, thumb, sub, onClick, onRemove }) {
  const el = document.createElement('div');
  el.className = 'item'; el.title = `${title}\n${url}`;
  const l = esc((host(url) || '?')[0]);
  el.innerHTML = (thumb !== undefined
    ? `<span class="th"${thumb ? ` style="background-image:url('${esc(thumb)}')"` : ''}>${thumb ? '' : (fav ? `<img src="${esc(fav)}" alt="">` : '')}</span>`
    : `<span class="fv" data-l="${l}">${fav ? `<img src="${esc(fav)}" alt="">` : l}</span>`)
    + `<span class="tx"><b>${esc(title || url)}</b><small>${esc(sub || host(url))}</small></span>` + (onRemove ? `<button class="x" title="Remover">${ICON.x}</button>` : '');
  el.querySelectorAll('img').forEach((img) => { img.onerror = () => { const p = img.parentElement; p.textContent = p.dataset.l || ''; }; });
  el.onclick = (e) => { if (!e.target.closest('.x')) onClick(e); };
  el.onauxclick = (e) => { if (e.button === 1) antares.open(url, true); };
  if (onRemove) el.querySelector('.x').onclick = onRemove;
  return el;
}
function fill(id, els, none) { const box = $(id); box.innerHTML = ''; if (!els.length) box.innerHTML = `<div class="none">${none}</div>`; else els.forEach((x) => box.appendChild(x)); }

async function load() {
  const u = await antares.universe();
  if (u.private) return;
  shortcuts = u.shortcuts || [];
  for (const r of u.recents || []) if (r.favicon) favs[host(r.url)] = r.favicon;
  for (const t of u.tabs || []) if (t.favicon) favs[host(t.url)] = t.favicon;
  renderTiles();
  const spaceName = (id) => (u.spaces.find((s) => s.id === id) || {}).name || '';
  const me = (u.tabs || []).find((t) => t.active && t.url.startsWith('antares://newtab'));
  const cont = (u.tabs || []).filter((t) => /^https?:/.test(t.url) && (!me || t.space !== me.space || !t.active)).slice(0, 5);
  fill('#continue', cont.map((t) => item({ url: t.url, title: t.title, fav: t.favicon, sub: `${spaceName(t.space)}${t.sleeping ? ' · em repouso' : ''}`, onClick: () => antares.spaceAction('go-tab', t.id) })), 'Nenhuma outra página aberta. As abas das suas Spaces aparecem aqui.');
  fill('#recent', (u.recents || []).slice(0, 5).map((r) => item({ url: r.url, title: r.title, fav: r.favicon, thumb: r.thumb || '', onClick: (e) => (e.ctrlKey ? antares.open(r.url, true) : (location.href = r.url)) })), 'As páginas que você visitar aparecerão aqui.');
  fill('#later', (u.readLater || []).slice(0, 5).map((r) => item({ url: r.url, title: r.title, fav: r.favicon, sub: host(r.url),
    onClick: (e) => (e.ctrlKey ? antares.open(r.url, true) : (location.href = r.url)),
    onRemove: async (e) => { e.stopPropagation(); await antares.readLaterAction('remove', r.url); load(); } })), 'Use o botão “Ler depois” na barra para guardar páginas aqui.');
}

(async () => {
  const [s, isPriv] = await Promise.all([antares.settings(), antares.isPrivate()]);
  priv = isPriv;
  if (priv) { document.body.classList.add('priv'); $('#privnote').hidden = false; $('.word').textContent = 'PRIVADO'; }
  if (s.blockTrackers && s.blocked) $('#foot').textContent = `${s.blocked.toLocaleString('pt-BR')} anúncios e rastreadores bloqueados nesta sessão`;
  $('#q').placeholder = `Pesquise no ${s.searchEngines[s.searchEngine]} ou digite um endereço`;
  if (location.hash === '#editar' && !priv) { editing = true; }
  await load();
  if (location.hash === '#editar') $('#shortcuts-box').scrollIntoView();
  addEventListener('hashchange', () => { if (location.hash === '#editar') { editing = true; renderTiles(); } });
  addEventListener('focus', () => { if (!priv) load(); });
})();
