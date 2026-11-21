let all = [];
async function load() { all = await aurora.bookmarks(); render(); }
function render() {
  const q = $('#q').value.toLowerCase();
  const items = q ? all.filter((b) => b.url.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q)) : all;
  if (!items.length) { $('#list').innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/></svg><div>${q ? 'Nenhum favorito encontrado.' : 'Você ainda não tem favoritos. Clique na estrela da barra de endereço para adicionar.'}</div></div>`; return; }
  $('#list').innerHTML = '<div class="card">' + items.map((b) => `
    <div class="row" data-id="${esc(b.id)}" data-url="${esc(b.url)}" draggable="${!q}">
      ${favHtml(b.favicon, b.url)}
      <div class="main"><div class="title">${esc(b.title || b.url)}</div><div class="sub">${esc(b.url)}</div></div>
      <div class="actions"><button class="icon edit" title="Editar">${ICON.edit}</button><button class="icon del" title="Remover">${ICON.trash}</button></div>
    </div>`).join('') + '</div>';
  fixFavs();
}
$('#list').addEventListener('click', async (e) => {
  const row = e.target.closest('.row'); if (!row) return;
  const id = row.dataset.id; const b = all.find((x) => x.id === id);
  if (e.target.closest('.del')) { all = await aurora.removeBookmark(id); render(); toast('Favorito removido'); return; }
  if (e.target.closest('.edit')) {
    row.classList.add('edit');
    row.querySelector('.main').innerHTML = `<input type="text" class="et" value="${esc(b.title)}"><input type="text" class="eu" value="${esc(b.url)}">`;
    row.querySelector('.actions').innerHTML = '<button class="primary save">Salvar</button>';
    row.querySelector('.et').focus(); return;
  }
  if (e.target.closest('.save')) { all = await aurora.editBookmark(id, { title: row.querySelector('.et').value, url: row.querySelector('.eu').value }); render(); return; }
  if (e.target.closest('.title')) location.href = row.dataset.url;
});
$('#list').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('.edit')) e.target.closest('.row').querySelector('.save').click(); });
let dragId = null;
$('#list').addEventListener('dragstart', (e) => { const r = e.target.closest('.row'); if (r) dragId = r.dataset.id; });
$('#list').addEventListener('dragover', (e) => { const r = e.target.closest('.row'); if (!r || !dragId) return; e.preventDefault(); document.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); r.classList.add('over'); });
$('#list').addEventListener('drop', async (e) => {
  const r = e.target.closest('.row'); if (!r || !dragId) return; e.preventDefault();
  let to = all.findIndex((x) => x.id === r.dataset.id); const from = all.findIndex((x) => x.id === dragId);
  if (from < to) to--; all = await aurora.moveBookmark(dragId, to); dragId = null; render();
});
$('#q').addEventListener('input', render);
$('#import').onclick = async () => { const n = await aurora.importBookmarks(); if (n) { toast(`${n} favoritos importados`); load(); } };
$('#export').onclick = async () => { if (await aurora.exportBookmarks()) toast('Favoritos exportados'); };
load();
