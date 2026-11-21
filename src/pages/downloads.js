const fmt = (b) => { if (!b) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(b) / Math.log(1024))); return (b / 1024 ** i).toFixed(i ? 1 : 0).replace('.', ',') + ' ' + u[i]; };
let last = '';
async function render() {
  const items = await aurora.downloads();
  const sig = JSON.stringify(items); if (sig === last) return; last = sig;
  if (!items.length) { $('#list').innerHTML = '<div class="empty"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg><div>Os arquivos que você baixar aparecem aqui.</div></div>'; return; }
  $('#list').innerHTML = '<div class="card">' + items.map((d) => {
    const ext = (d.filename.split('.').pop() || '').slice(0, 4);
    let sub = '', act = '', bar = '';
    if (d.state === 'progressing') {
      const pct = d.total ? Math.round(d.received / d.total * 100) : 0;
      const el = (Date.now() - d.start) / 1000; const speed = el > 0 ? d.received / el : 0;
      sub = d.paused ? `Pausado — ${fmt(d.received)}${d.total ? ' de ' + fmt(d.total) : ''}` : `${fmt(d.received)}${d.total ? ' de ' + fmt(d.total) : ''} · ${fmt(speed)}/s`;
      bar = `<div class="bar"><i style="width:${d.total ? pct : 30}%"></i></div>`;
      act = (d.paused ? `<button class="icon" data-a="resume" title="Continuar">${ICON.play}</button>` : `<button class="icon" data-a="pause" title="Pausar">${ICON.pause}</button>`) + `<button class="icon" data-a="cancel" title="Cancelar">${ICON.x}</button>`;
    } else if (d.state === 'completed') {
      sub = `${fmt(d.total || d.received)} · ${host(d.url)}${d.exists ? '' : ' · Arquivo excluído'}`;
      act = (d.exists ? `<button class="icon" data-a="show" title="Mostrar na pasta">${ICON.folder}</button>` : '') + `<button class="icon" data-a="remove" title="Remover da lista">${ICON.x}</button>`;
    } else {
      sub = (d.state === 'cancelled' ? 'Cancelado' : 'Falhou') + ' · ' + host(d.url);
      act = `<button class="icon" data-a="retry" title="Tentar novamente">${ICON.retry}</button><button class="icon" data-a="remove" title="Remover da lista">${ICON.x}</button>`;
    }
    const canOpen = d.state === 'completed' && d.exists;
    return `<div class="row" data-id="${d.id}"><span class="ftype">${esc(ext)}</span><div class="main"><div class="title ${canOpen ? 'open' : d.state === 'progressing' ? '' : 'gone'}">${esc(d.filename)}</div><div class="sub">${esc(sub)}</div>${bar}</div><div class="actions">${act}</div></div>`;
  }).join('') + '</div>';
}
$('#list').addEventListener('click', async (e) => {
  const row = e.target.closest('.row'); if (!row) return; const id = Number(row.dataset.id);
  const b = e.target.closest('[data-a]'); if (b) { await aurora.downloadAction(id, b.dataset.a); last = ''; render(); return; }
  if (e.target.closest('.title.open')) aurora.downloadAction(id, 'open');
});
$('#folder').onclick = () => aurora.openDownloadsFolder();
$('#clear').onclick = async () => { await aurora.clearDownloads(); last = ''; render(); };
render(); setInterval(render, 700);
