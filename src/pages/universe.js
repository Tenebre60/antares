'use strict';
const COLORS = ['#ff7a1a', '#ffb020', '#4fa3ff', '#3ad29f', '#ff5c8a', '#a98bff', '#e8e2d6'];
let U = { spaces: [], orbits: [], missions: [], readLater: [], tabs: [] };

function section() {
  const s = (location.hash || '#spaces').slice(1);
  const id = ['spaces', 'orbits', 'missions', 'ler-depois'].includes(s) ? s : 'spaces';
  document.querySelectorAll('.sect').forEach((x) => { x.hidden = x.id !== 's-' + id; });
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.s === id));
  document.title = { spaces: 'Spaces', orbits: 'Orbits', missions: 'Missions', 'ler-depois': 'Ler depois' }[id] + ' — Antares';
}
addEventListener('hashchange', section);

function link(url, title, fav, { onOpen, onRemove } = {}) {
  const el = document.createElement('div');
  el.className = 'lk'; el.title = `${title || url}\n${url}`;
  el.innerHTML = `${favHtml(fav, url)}<span class="t">${esc(title || url)}</span>` + (onRemove ? `<button class="icon" title="Remover">${ICON.x}</button>` : '');
  el.onclick = (e) => { if (e.target.closest('button')) return; if (onOpen) onOpen(e); else antares.open(url, true); };
  el.onauxclick = (e) => { if (e.button === 1) antares.open(url, true); };
  if (onRemove) el.querySelector('button').onclick = onRemove;
  fixFavs(el);
  return el;
}
function nameInput(value, onSave, max) {
  const i = document.createElement('input');
  i.type = 'text'; i.className = 'name'; i.value = value; i.maxLength = max; i.title = 'Clique para renomear';
  i.onkeydown = (e) => { if (e.key === 'Enter') i.blur(); if (e.key === 'Escape') { i.value = value; i.blur(); } };
  i.onchange = () => { const v = i.value.trim(); if (v && v !== value) onSave(v); else i.value = value; };
  return i;
}
function btn(label, fn, cls = '') { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b; }
async function confirmClick(b, label, fn) {
  if (b.dataset.armed) { fn(); return; }
  const old = b.textContent; b.dataset.armed = '1'; b.textContent = label; b.classList.add('danger');
  setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = old; } }, 3000);
}

/* ---------------------------------------------------------------- spaces */
function renderSpaces() {
  const box = $('#spaces'); box.innerHTML = '';
  const here = U.tabs.find((t) => t.active && t.url.startsWith('antares://universe'));
  for (const sp of U.spaces) {
    const tabs = U.tabs.filter((t) => t.space === sp.id);
    const el = document.createElement('div');
    el.className = 'box cut' + (here && here.space === sp.id ? ' current' : '');
    el.style.setProperty('--c', sp.color);
    const h = document.createElement('div'); h.className = 'box-h';
    h.innerHTML = '<span class="sw"></span>';
    h.appendChild(nameInput(sp.name, async (v) => { U.spaces = await antares.spaceAction('rename', sp.id, v); toast('Space renomeada'); }, 24));
    if (here && here.space === sp.id) h.insertAdjacentHTML('beforeend', '<span class="badge">atual</span>');
    el.appendChild(h);
    const colors = document.createElement('div'); colors.className = 'colors';
    for (const c of COLORS) {
      const b = document.createElement('button'); b.style.setProperty('--c', c); b.title = 'Cor'; if (c === sp.color) b.className = 'on';
      b.onclick = async () => { U.spaces = await antares.spaceAction('color', sp.id, c); renderSpaces(); };
      colors.appendChild(b);
    }
    el.appendChild(colors);
    el.insertAdjacentHTML('beforeend', `<div class="meta">${tabs.length ? `${tabs.length} aba(s) aberta(s)` : 'Nenhuma aba aberta'}</div>`);
    const links = document.createElement('div'); links.className = 'links';
    for (const t of tabs) links.appendChild(link(t.url, t.title, t.favicon, { onOpen: () => antares.spaceAction('go-tab', t.id) }));
    el.appendChild(links);
    const bs = document.createElement('div'); bs.className = 'btns';
    bs.appendChild(btn('Abrir Space', () => antares.spaceAction('open', sp.id), 'primary'));
    bs.appendChild(btn('Salvar como Órbita', async () => { await antares.spaceAction('orbit', sp.id); await load(); toast('Órbita salva'); }));
    if (U.spaces.length > 1) {
      const del = btn('Excluir', () => {});
      del.onclick = () => confirmClick(del, 'Fecha as abas — confirmar?', async () => { U.spaces = await antares.spaceAction('delete', sp.id); await load(); });
      bs.appendChild(del);
    }
    el.appendChild(bs);
    box.appendChild(el);
  }
}
$('#space-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#space-name').value.trim(); if (!v) return;
  U.spaces = await antares.spaceAction('add', null, v); $('#space-name').value = ''; renderSpaces(); toast('Space criada');
});

/* ---------------------------------------------------------------- orbits */
function renderOrbits() {
  const box = $('#orbits'); box.innerHTML = '';
  if (!U.orbits.length) { box.innerHTML = '<div class="empty-box">Nenhuma Órbita ainda. Abra as páginas de um assunto numa Space e salve-as aqui.</div>'; return; }
  for (const o of U.orbits) {
    const sp = U.spaces.find((x) => x.id === o.space);
    const el = document.createElement('div'); el.className = 'box cut';
    el.style.setProperty('--c', sp ? sp.color : '#ff7a1a');
    const h = document.createElement('div'); h.className = 'box-h'; h.innerHTML = '<span class="sw"></span>';
    h.appendChild(nameInput(o.name, async (v) => { U.orbits = await antares.orbitAction('rename', o.id, v); toast('Órbita renomeada'); }, 60));
    el.appendChild(h);
    el.insertAdjacentHTML('beforeend', `<div class="meta">${(o.tabs || []).length} página(s) · salva em ${new Date(o.created).toLocaleDateString('pt-BR')}${sp ? ' · ' + esc(sp.name) : ''}</div>`);
    const links = document.createElement('div'); links.className = 'links';
    for (const t of o.tabs || []) links.appendChild(link(t.url, t.title, t.favicon, { onRemove: async () => { U.orbits = await antares.orbitAction('remove-page', o.id, t.url); renderOrbits(); } }));
    el.appendChild(links);
    const bs = document.createElement('div'); bs.className = 'btns';
    bs.appendChild(btn('Abrir todas', () => antares.orbitAction('open', o.id), 'primary'));
    const del = btn('Excluir', () => {});
    del.onclick = () => confirmClick(del, 'Confirmar exclusão', async () => { U.orbits = await antares.orbitAction('delete', o.id); renderOrbits(); });
    bs.appendChild(del);
    el.appendChild(bs);
    box.appendChild(el);
  }
}
$('#orbit-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  U.orbits = await antares.orbitAction('save', null, $('#orbit-name').value.trim());
  $('#orbit-name').value = ''; renderOrbits();
});

/* ---------------------------------------------------------------- missions */
function renderMissions() {
  const box = $('#missions'); box.innerHTML = '';
  if (!U.missions.length) { box.innerHTML = '<div class="empty-box">Nenhuma missão ainda. Crie uma acima — por exemplo “Comprar notebook” ou “Trabalho de faculdade”.</div>'; return; }
  for (const m of U.missions) {
    const tasks = m.tasks || []; const done = tasks.filter((x) => x.done).length;
    const el = document.createElement('div'); el.className = 'box cut' + (m.done ? ' done' : '');
    const h = document.createElement('div'); h.className = 'box-h';
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.checked = !!m.done; chk.title = 'Missão cumprida';
    chk.style.accentColor = 'var(--accent)';
    chk.onchange = async () => { U.missions = await antares.missionAction('update', m.id, { done: chk.checked }); renderMissions(); };
    h.appendChild(chk);
    h.appendChild(nameInput(m.title, async (v) => { U.missions = await antares.missionAction('update', m.id, { title: v }); }, 80));
    if (m.done) h.insertAdjacentHTML('beforeend', '<span class="badge">cumprida</span>');
    el.appendChild(h);
    if (tasks.length) el.insertAdjacentHTML('beforeend', `<div class="progress"><i style="width:${Math.round((done / tasks.length) * 100)}%"></i></div><div class="meta">${done} de ${tasks.length} tarefa(s)</div>`);
    const notes = document.createElement('textarea'); notes.className = 'notes'; notes.placeholder = 'Anotações…'; notes.value = m.notes || ''; notes.maxLength = 2000;
    notes.onchange = async () => { U.missions = await antares.missionAction('update', m.id, { notes: notes.value }); toast('Anotações salvas'); };
    el.appendChild(notes);
    el.insertAdjacentHTML('beforeend', '<div class="sub-h">Tarefas</div>');
    const tl = document.createElement('div'); tl.className = 'tasks';
    for (const t of tasks) {
      const r = document.createElement('label'); r.className = 'task' + (t.done ? ' done' : '');
      r.innerHTML = `<input type="checkbox" ${t.done ? 'checked' : ''}><span>${esc(t.text)}</span><button class="icon" title="Remover">${ICON.x}</button>`;
      r.querySelector('input').onchange = async () => { U.missions = await antares.missionAction('toggle-task', m.id, t.id); renderMissions(); };
      r.querySelector('button').onclick = async (e) => { e.preventDefault(); U.missions = await antares.missionAction('remove-task', m.id, t.id); renderMissions(); };
      tl.appendChild(r);
    }
    el.appendChild(tl);
    const tf = document.createElement('form'); tf.className = 'mini-form'; tf.autocomplete = 'off';
    tf.innerHTML = '<input type="text" placeholder="Nova tarefa" maxlength="140"><button>Adicionar</button>';
    tf.onsubmit = async (e) => { e.preventDefault(); const v = tf.querySelector('input').value.trim(); if (!v) return; U.missions = await antares.missionAction('add-task', m.id, v); renderMissions(); };
    el.appendChild(tf);
    el.insertAdjacentHTML('beforeend', `<div class="sub-h">Páginas (${(m.pages || []).length})</div>`);
    const links = document.createElement('div'); links.className = 'links';
    for (const p of m.pages || []) links.appendChild(link(p.url, p.title, p.favicon, { onRemove: async () => { U.missions = await antares.missionAction('remove-page', m.id, p.url); renderMissions(); } }));
    el.appendChild(links);
    const pf = document.createElement('form'); pf.className = 'mini-form'; pf.autocomplete = 'off';
    pf.innerHTML = '<input type="text" placeholder="Endereço de uma página"><button>Adicionar</button>';
    pf.onsubmit = async (e) => {
      e.preventDefault();
      const url = await antares.resolve(pf.querySelector('input').value.trim());
      if (!url || !/^https?:/.test(url)) { toast('Digite um endereço válido'); return; }
      U.missions = await antares.missionAction('add-page', m.id, { url, title: host(url) }); renderMissions();
    };
    el.appendChild(pf);
    const bs = document.createElement('div'); bs.className = 'btns';
    if ((m.pages || []).length) bs.appendChild(btn('Abrir páginas', () => antares.missionAction('open', m.id), 'primary'));
    const del = btn('Excluir', () => {});
    del.onclick = () => confirmClick(del, 'Confirmar exclusão', async () => { U.missions = await antares.missionAction('delete', m.id); renderMissions(); });
    bs.appendChild(del);
    el.appendChild(bs);
    box.appendChild(el);
  }
}
$('#mission-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#mission-title').value.trim(); if (!title) return;
  U.missions = await antares.missionAction('create', null, { title }); $('#mission-title').value = ''; renderMissions(); toast('Missão criada');
});

/* ---------------------------------------------------------------- read later */
function renderLater() {
  const box = $('#later'); box.innerHTML = '';
  $('#later-clear').hidden = !U.readLater.length;
  if (!U.readLater.length) { box.innerHTML = '<div class="empty">Nada guardado para ler depois.</div>'; return; }
  for (const r of U.readLater) {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `${favHtml(r.favicon, r.url)}<div class="main"><div class="title">${esc(r.title)}</div><div class="sub">${esc(host(r.url))} · ${new Date(r.added).toLocaleDateString('pt-BR')}</div></div><div class="actions"><button class="icon" title="Remover">${ICON.trash}</button></div>`;
    row.querySelector('.title').onclick = (e) => (e.ctrlKey ? antares.open(r.url, true) : (location.href = r.url));
    row.querySelector('button').onclick = async () => { U.readLater = await antares.readLaterAction('remove', r.url); renderLater(); };
    box.appendChild(row);
  }
  fixFavs(box);
}
$('#later-clear').onclick = () => confirmClick($('#later-clear'), 'Clique de novo para limpar', async () => { U.readLater = await antares.readLaterAction('clear'); renderLater(); });

async function load() {
  U = await antares.universe();
  if (U.private) { document.querySelector('.page').innerHTML = '<div class="empty">Spaces, Orbits e Missions não ficam disponíveis em janelas privadas.</div>'; return; }
  renderSpaces(); renderOrbits(); renderMissions(); renderLater();
}
section(); load();
addEventListener('focus', () => { if (!document.activeElement || !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) load(); });
