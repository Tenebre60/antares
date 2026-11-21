const q = new URLSearchParams(location.search);
const raw = q.get('u') || '';
// only ever act on ordinary web/file addresses
const u = /^(https?|file):/i.test(raw) ? raw : ''; const code = q.get('c') || ''; const d = q.get('d') || '';
const msgs = {
  '-105': ['Não foi possível encontrar o servidor', 'Verifique se o endereço está digitado corretamente ou se você está conectado à internet.'],
  '-106': ['Sem conexão com a internet', 'Verifique os cabos de rede, o modem e o roteador, ou reconecte-se ao Wi-Fi.'],
  '-102': ['Conexão recusada', 'O site recusou a conexão.'],
  '-118': ['O site demorou demais para responder', 'Tente novamente em alguns instantes.'],
  '-7': ['O site demorou demais para responder', 'Tente novamente em alguns instantes.'],
  '-200': ['Sua conexão não é particular', 'O certificado de segurança do site não é confiável. Invasores podem estar tentando roubar suas informações.'],
  '-202': ['Sua conexão não é particular', 'O certificado de segurança do site não é confiável.'],
  '-201': ['Sua conexão não é particular', 'O certificado de segurança do site expirou ou o relógio do seu computador está errado.'],
  crash: ['Ops! Algo deu errado', 'A página parou de funcionar. Tente recarregar.'],
  https: ['Este site não oferece conexão segura', 'Ele não funciona com HTTPS. Se continuar, outras pessoas na sua rede (Wi-Fi público, por exemplo) podem ver ou alterar o que você envia e recebe. Não digite senhas nem dados de cartão.'],
};
const m = msgs[code] || (location.hostname === 'error' ? ['Não foi possível acessar esta página', ''] : ['Página não encontrada', 'Esta página interna do Aurora não existe.']);
$('#h').textContent = m[0];
$('#p').textContent = (u ? host(u) + ' — ' : '') + m[1];
$('#c').textContent = d ? `${d}${code && code !== 'crash' ? ' (' + code + ')' : ''}` : '';
document.title = u ? host(u) : 'Erro';
if (code === 'https' && u.startsWith('http:')) {
  document.body.classList.add('warn');
  $('#retry').textContent = 'Voltar para a segurança';
  $('#retry').onclick = () => location.replace('aurora://newtab');
  $('#back').textContent = 'Continuar para o site (não seguro)';
  $('#back').onclick = async () => { if (await aurora.allowHttp(u)) location.replace(u); };
} else {
  $('#retry').onclick = () => { if (u) location.replace(u); else location.reload(); };
  $('#back').onclick = () => history.back();
}
