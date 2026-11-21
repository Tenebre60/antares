const PAGE = 300;
let items = []; let total = 0;
async function load(reset) {
  if (reset) items = [];
  const r = await antares.history($('#q').value, PAGE, items.length);
  items = items.concat(r.items); total = r.total;
  render();
}
function render() {
  const list = $('#list');
  if (!items.length) { list.innerHTML = '<div class="empty"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg><div>Nada por aqui ainda.</div></div>'; return; }
  const groups = new Map();
  const today = new Date().toDateString(); const yest = new Date(Date.now() - 864e5).toDateString();
  for (const h of items) {
    const d = new Date(h.time); const ds = d.toDateString();
    const label = ds === today ? 'Hoje' : ds === yest ? 'Ontem' : d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (!groups.has(label)) groups.set(label, []); groups.get(label).push(h);
  }
  list.innerHTML = [...groups].map(([label, hs]) => `<div class="group-title">${esc(label)}</div><div class="card">${hs.map((h) => `
    <div class="row" data-url="${esc(h.url)}" data-time="${h.time}">
      <span class="time">${new Date(h.time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
      ${favHtml(h.favicon, h.url)}
      <div class="main"><div class="title">${esc(h.title || h.url)}</div><div class="sub">${esc(host(h.url))}</div></div>
      <button class="icon del" title="Remover do histórico">${ICON.x}</button>
    </div>`).join('')}</div>`).join('') +
    (items.length < total ? `<div style="text-align:center;margin:20px"><button id="more">Mostrar mais (${(total - items.length).toLocaleString('pt-BR')} restantes)</button></div>` : '');
  fixFavs();
}
$('#list').addEventListener('click', async (e) => {
  if (e.target.id === 'more') { e.target.disabled = true; load(false); return; }
  const row = e.target.closest('.row'); if (!row) return;
  if (e.target.closest('.del')) {
    const time = Number(row.dataset.time); const url = row.dataset.url;
    await antares.removeHistory(time, url);
    items = items.filter((h) => !(h.time === time && h.url === url)); total--; render(); return;
  }
  if (e.target.closest('.title')) location.href = row.dataset.url;
});
let t; $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(true), 150); });
$('#clear').onclick = () => { location.href = 'antares://settings#limpar'; };
load(true);
