const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function tick() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const h = d.getHours();
  const g = h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  $('#greet').textContent = `${g} · ${d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}`;
}
tick(); setInterval(tick, 10000);

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#q').value.trim(); if (!v) return;
  const url = await window.aurora.resolve(v);
  if (url) location.href = url;
});

(async () => {
  const [sites, s, priv] = await Promise.all([window.aurora.topSites(), window.aurora.settings(), window.aurora.isPrivate()]);
  if (priv) {
    document.body.classList.add('priv');
    $('#tiles').outerHTML = '<p class="privnote"><b>Você está navegando no modo privado.</b><br>O Aurora não vai salvar histórico, cookies nem dados de sites desta janela depois que ela for fechada. Downloads e favoritos criados aqui continuam salvos. Seu provedor de internet e os sites visitados ainda podem ver sua atividade.</p>';
    $('.brand').lastChild.textContent = 'Aurora · Privado';
  }
  if (!priv) $('#tiles').innerHTML = sites.map((x) => {
    const letter = esc((x.title || '?')[0]);
    const ic = x.favicon ? `<img src="${esc(x.favicon)}" alt="">` : letter;
    return `<a class="tile" href="${esc(x.url)}" title="${esc(x.url)}"><div class="ic" data-l="${letter}">${ic}</div><span>${esc(x.title)}</span></a>`;
  }).join('');
  document.querySelectorAll('.tile img').forEach((img) => { img.onerror = () => { img.parentElement.textContent = img.parentElement.dataset.l; }; });
  if (s.blockTrackers && s.blocked) $('#foot').textContent = `🛡 ${s.blocked.toLocaleString('pt-BR')} rastreadores bloqueados nesta sessão`;
  $('#q').placeholder = `Pesquise no ${s.searchEngines[s.searchEngine]} ou digite um endereço`;
})();
