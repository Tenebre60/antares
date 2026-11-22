'use strict';
const NS = 'http://www.w3.org/2000/svg';
const svg = $('#map'); const world = $('#world'); const tip = $('#tip');
let view = { x: 0, y: 0, k: 1 };

function sky() {
  const c = $('#sky'); const dpr = devicePixelRatio || 1; const w = innerWidth, h = innerHeight;
  c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d'); g.scale(dpr, dpr);
  const bg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
  bg.addColorStop(0, '#1a0e07'); bg.addColorStop(1, '#050406'); g.fillStyle = bg; g.fillRect(0, 0, w, h);
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0, n = Math.round((w * h) / 1500); i < n; i++) { g.globalAlpha = 0.15 + rnd() * 0.6; g.fillStyle = rnd() < 0.3 ? '#ffd2a1' : '#e8e2d6'; g.beginPath(); g.arc(rnd() * w, rnd() * h, rnd() * 0.9 + 0.2, 0, 7); g.fill(); }
}
const el = (tag, attrs = {}, parent = world) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); parent.appendChild(e); return e; };
function apply() { world.setAttribute('transform', `translate(${innerWidth / 2 + view.x} ${innerHeight / 2 + view.y}) scale(${view.k})`); }

function showTip(e, title, sub) {
  tip.innerHTML = `<b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}`; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(innerWidth - r.width - 10, e.clientX + 14) + 'px';
  tip.style.top = Math.min(innerHeight - r.height - 10, e.clientY + 14) + 'px';
}
function node(x, y, r, color, opts) {
  const { title, sub, onClick, label, labelClass = '', faded = false, glow = true } = opts;
  const g = el('g', { class: 'node', transform: `translate(${x} ${y})` });
  if (glow) el('circle', { r: r * 2.6, fill: color, opacity: faded ? 0.05 : 0.12 }, g);
  el('circle', { class: 'core', r, fill: color, opacity: faded ? 0.55 : 1, filter: glow ? 'url(#glow)' : '' }, g);
  if (label) {
    // labels point away from their constellation so neighbours do not overlap
    const ang = opts.angle;
    let attrs = { y: r + 16, 'text-anchor': 'middle', class: labelClass };
    if (ang !== undefined) {
      const c = Math.cos(ang), s2 = Math.sin(ang);
      attrs = { x: c * (r + 8), y: s2 * (r + 8) + 4 + (Math.abs(c) < 0.4 ? (s2 > 0 ? 10 : -6) : 0), 'text-anchor': c > 0.4 ? 'start' : c < -0.4 ? 'end' : 'middle', class: labelClass };
    }
    const t = el('text', attrs, g); t.textContent = label;
  }
  g.addEventListener('mousemove', (e) => showTip(e, title, sub));
  g.addEventListener('mouseleave', () => { tip.hidden = true; });
  if (onClick) g.addEventListener('click', (e) => { e.stopPropagation(); if (!moved) onClick(e); });
  return g;
}
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function render() {
  const d = await antares.starMap();
  world.innerHTML = '';
  if (d.private) { $('.hud p').textContent = 'O Mapa Estelar não está disponível em janelas privadas.'; return; }
  const R = Math.min(innerWidth, innerHeight) * 0.3;
  // distant stars: visited sites on an outer ring
  const maxN = Math.max(1, ...d.sites.map((s) => s.n));
  d.sites.forEach((s, i) => {
    const a = (i / d.sites.length) * Math.PI * 2 + 0.3;
    const rr = R * (1.75 + ((i * 37) % 10) / 22);
    const size = 1.6 + (s.n / maxN) * 5;
    node(Math.cos(a) * rr, Math.sin(a) * rr * 0.78, size, '#e8e2d6', { title: s.host, sub: `${s.n} visita(s) — clique para abrir`, onClick: () => antares.open(s.url, true), label: size > 4 ? s.host : '', faded: true, glow: size > 3 });
  });
  // orbit paths
  for (const k of [0.45, 1, 1.75]) el('ellipse', { rx: R * k, ry: R * k * 0.78, fill: 'none', stroke: '#ff8a34', 'stroke-opacity': 0.12, 'stroke-dasharray': k === 1 ? '' : '3 6' });
  // central star (Antares)
  el('circle', { r: 46, fill: '#ff7a1a', opacity: 0.1, filter: 'url(#glow2)' });
  const sun = node(0, 0, 22, 'url(#sunG)', { title: 'Antares', sub: `${d.tabs.length} aba(s) abertas em ${d.spaces.length} Space(s)`, label: 'ANTARES', labelClass: 'space-label', glow: false });
  sun.querySelector('text').setAttribute('y', 50);
  { const c = sun.querySelector('circle.core'); c.setAttribute('opacity', '0'); el('image', { href: 'logo.png', x: -34, y: -34, width: 68, height: 68 }, sun); }
  // constellations: one per space
  const spaces = d.spaces;
  const pos = new Map();
  spaces.forEach((sp, i) => {
    const a = (i / spaces.length) * Math.PI * 2 - Math.PI / 2;
    const cx = Math.cos(a) * R, cy = Math.sin(a) * R * 0.78;
    const tabs = d.tabs.filter((t) => t.space === sp.id);
    el('line', { x1: 0, y1: 0, x2: cx, y2: cy, stroke: sp.color, 'stroke-opacity': 0.25 });
    tabs.forEach((t, j) => {
      const ring = 1 + Math.floor(j / 8); const per = Math.min(8, tabs.length - (ring - 1) * 8);
      const b = ((j % 8) / per) * Math.PI * 2 + i;
      const tr = 34 + ring * 30;
      const x = cx + Math.cos(b) * tr, y = cy + Math.sin(b) * tr;
      pos.set(t.id, { x, y, a: b });
      el('line', { x1: cx, y1: cy, x2: x, y2: y, stroke: sp.color, 'stroke-opacity': 0.35 });
    });
    for (const t of tabs) if (t.opener && pos.has(t.opener)) { const p1 = pos.get(t.opener), p2 = pos.get(t.id); el('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: '#ffd9a3', 'stroke-opacity': 0.5, 'stroke-dasharray': '2 3' }); }
    for (const t of tabs) {
      const p = pos.get(t.id);
      node(p.x, p.y, t.active ? 6 : 4.5, t.sleeping ? '#7d6d60' : (t.active ? '#fff2dc' : '#ffb347'), {
        title: t.title || t.url, sub: `${sp.name}${t.sleeping ? ' · em repouso' : ''}${t.active ? ' · aberta agora' : ''} — clique para ir`,
        onClick: () => antares.spaceAction('go-tab', t.id), label: tabs.length <= 8 ? short(t.title || host(t.url), 20) : '', faded: t.sleeping, angle: p.a,
      });
    }
    const orbs = d.orbits.filter((o) => o.space === sp.id).length;
    node(cx, cy, 11, sp.color, { title: sp.name, sub: `${tabs.length} aba(s)${orbs ? ` · ${orbs} Órbita(s) salva(s)` : ''} — clique para abrir a Space`, onClick: () => antares.spaceAction('open', sp.id), label: sp.name, labelClass: 'space-label' }).querySelector('text').setAttribute('y', -20);
  });
  const sleeping = d.tabs.filter((t) => t.sleeping).length;
  $('#stats').innerHTML = `<b>${d.tabs.length}</b> abas abertas<br><b>${sleeping}</b> em repouso<br><b>${d.orbits.length}</b> Orbits · <b>${d.missions.filter((m) => !m.done).length}</b> Missions ativas<br><b>${d.sites.length}</b> sites no seu céu`;
  apply();
}

/* pan & zoom */
let drag = null; let moved = false;
svg.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; moved = false; });
addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; svg.classList.add('drag'); }
  view.x = drag.vx + dx; view.y = drag.vy + dy; apply();
});
addEventListener('mouseup', () => { drag = null; svg.classList.remove('drag'); setTimeout(() => { moved = false; }, 0); });
function zoom(f, cx = innerWidth / 2, cy = innerHeight / 2) {
  const k = Math.max(0.3, Math.min(4, view.k * f)); const r = k / view.k;
  const ox = cx - innerWidth / 2, oy = cy - innerHeight / 2;
  view.x = ox - (ox - view.x) * r; view.y = oy - (oy - view.y) * r; view.k = k; apply();
}
svg.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
$('#zin').onclick = () => zoom(1.25); $('#zout').onclick = () => zoom(0.8);
$('#zreset').onclick = () => { view = { x: 0, y: 0, k: 1 }; apply(); };
$('#reload').onclick = render;
addEventListener('resize', () => { sky(); render(); });
addEventListener('focus', render);
sky(); render();
