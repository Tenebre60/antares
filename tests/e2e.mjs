// Automated end-to-end tests for Antares (packaged Linux build), driven like a user:
// keyboard via xdotool, state read through the DevTools protocol.
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';

const PORT = 9333;
const APP = '/tmp/distlinux/linux-unpacked/antares';
const A = 'http://127.0.0.1:8766/a.html', B = 'http://127.0.0.1:8766/b.html', EVIL = 'http://127.0.0.1:8765/';
const env = { ...process.env, DISPLAY: ':99', NO_PROXY: '*', no_proxy: '*' };
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, t = 20000) => { try { return execSync(c, { env, timeout: t }).toString(); } catch { return ''; } };
const key = (k) => sh(`xdotool key --delay 70 ${k}`);
const type = (s) => sh(`xdotool type --delay 12 ${JSON.stringify(s)}`);
let proc = null;

function check(name, ok, detail = '') { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${name}${detail ? '  — ' + detail : ''}`); }
async function targets() { try { return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { return []; } }
async function cdp(pred, method, params = {}, timeout = 8000) {
  const list = await targets();
  const t = typeof pred === 'function' ? list.find(pred) : list.find((x) => x.type === 'page' && x.url.startsWith(pred));
  if (!t) throw new Error('sem alvo ' + pred);
  return new Promise((res, rej) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    const to = setTimeout(() => { try { ws.close(); } catch {} rej(new Error('timeout')); }, timeout);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id !== 1) return; clearTimeout(to); ws.close(); res(d); };
    ws.onerror = () => { clearTimeout(to); rej(new Error('ws')); };
  });
}
async function ev(pred, expression, gesture = false) {
  const d = await cdp(pred, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture });
  if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description || 'exception');
  return d.result?.result?.value;
}
const UI = (priv = false) => (x) => x.url.startsWith('antares-ui://chrome/index.html') && x.url.includes(`private=${priv ? 1 : 0}`);
const uiState = (priv = false) => ev(UI(priv), 'JSON.stringify({tabs: state.tabs.map(t=>({id:t.id,url:t.url,title:t.title,zoom:t.zoom,sleeping:t.sleeping,bookmarked:t.bookmarked})), active: state.activeId, bm: state.bookmarks.length})').then(JSON.parse);
const activeTab = async (priv = false) => { const s = await uiState(priv); return s.tabs.find((t) => t.id === s.active); };
async function waitFor(fn, ms = 8000, step = 250) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return null; }
function focusMain(priv = false) {
  const ids = sh(`xdotool search --name '— Antares${priv ? ' \\(Privado\\)' : ''}$'`).trim().split('\n').filter(Boolean);
  // with a window manager (CI uses openbox) the window must be activated, not only focused
  for (const id of ids.reverse()) { try { execSync(`xdotool windowactivate --sync ${id}`, { env, timeout: 3000, stdio: 'ignore' }); return; } catch {} }
  if (ids.length) sh(`xdotool windowfocus --sync ${ids[0]}`, 5000);
}
async function go(url, priv = false) {
  focusMain(priv); key('ctrl+l'); await sleep(150); type(url); key('Return');
  return waitFor(async () => { const t = await activeTab(priv); return t && t.url.startsWith(url.split('#')[0]) && t; }, 10000);
}
function start(extraEnv = {}, args = []) {
  proc = spawn(APP, ['--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`, ...args], { env: { ...env, ...extraEnv }, stdio: ['ignore', fs.openSync('/tmp/e2e-app.log', 'a'), fs.openSync('/tmp/e2e-app.log', 'a')] });
  return waitFor(async () => (await targets()).some(UI()), 20000);
}
async function stop() { if (proc) { proc.kill('SIGTERM'); await sleep(2500); try { proc.kill('SIGKILL'); } catch {} proc = null; } sh('pkill -f linux-unpacked'); await sleep(800); }
const renderers = () => Number(sh("pgrep -fc 'linux-unpacked/antares --type=renderer'").trim() || 0);
const cfg = `${os.homedir()}/.config/Antares`;

async function main() {
  fs.writeFileSync('/tmp/e2e-app.log', '');
  sh('pkill -f linux-unpacked');
  // clean profile so results are reproducible
  fs.rmSync(cfg, { recursive: true, force: true });
  for (const f of fs.readdirSync(os.homedir())) if (/^(nota|relatorio).*\.(txt|pdf)$/.test(f)) fs.rmSync(`${os.homedir()}/${f}`);

  /* ---------------- startup & navigation */
  check('Inicia e abre a página Nova aba', await start() && (await waitFor(async () => (await targets()).some((x) => x.url.startsWith('antares://newtab')), 8000)));
  check('Nova aba mostra atalhos e relógio', (await waitFor(() => ev('antares://newtab', "document.querySelectorAll('.tile').length >= 4 && /\\d\\d:\\d\\d/.test(document.getElementById('greet').textContent)"))) === true);
  const tA = await go(A); check('Digitar endereço na barra navega', !!tA, tA && tA.url);
  await waitFor(async () => (await activeTab()).title === 'PaginaA', 5000);
  check('Título da aba atualiza', (await activeTab()).title === 'PaginaA');
  focusMain(); key('ctrl+l'); type('teste antares navegador'); key('Return');
  const srch = await waitFor(async () => { const t = await activeTab(); return /google\.com\/search\?q=teste/.test(t.url + decodeURIComponent(t.url)) && t; }, 8000);
  check('Texto na barra vira pesquisa no Google', !!srch, srch && srch.url.slice(0, 80));
  await go(A); await go(B);
  focusMain(); key('alt+Left');
  check('Voltar (Alt+←)', !!(await waitFor(async () => (await activeTab()).url === A)));
  focusMain(); key('alt+Right');
  check('Avançar (Alt+→)', !!(await waitFor(async () => (await activeTab()).url === B)));
  focusMain(); key('F5'); await sleep(800);
  check('Recarregar (F5) mantém a página', (await activeTab()).url === B);

  /* ---------------- tabs */
  let n0 = (await uiState()).tabs.length;
  focusMain(); key('ctrl+t');
  check('Ctrl+T abre aba', !!(await waitFor(async () => (await uiState()).tabs.length === n0 + 1)));
  focusMain(); key('ctrl+w');
  check('Ctrl+W fecha aba', !!(await waitFor(async () => (await uiState()).tabs.length === n0)));
  focusMain(); key('ctrl+t'); await sleep(500); await go(A); focusMain(); key('ctrl+w');
  await waitFor(async () => (await uiState()).tabs.length === n0);
  focusMain(); key('ctrl+shift+t');
  check('Ctrl+Shift+T reabre aba fechada', !!(await waitFor(async () => { const s = await uiState(); return s.tabs.length === n0 + 1 && s.tabs.some((t) => t.url === A); })));
  focusMain(); key('ctrl+1');
  check('Ctrl+1 vai para a primeira aba', !!(await waitFor(async () => { const s = await uiState(); return s.active === s.tabs[0].id; })));
  focusMain(); key('ctrl+Tab');
  check('Ctrl+Tab vai para a próxima aba', !!(await waitFor(async () => { const s = await uiState(); return s.active === s.tabs[1].id; })));

  /* ---------------- bookmarks & history */
  await go(A);
  focusMain(); key('ctrl+d');
  check('Ctrl+D adiciona favorito', !!(await waitFor(async () => (await activeTab()).bookmarked)));
  focusMain(); key('ctrl+shift+b'); await sleep(600); // the bookmarks bar is off by default in Antares
  check('Favorito aparece na barra', (await waitFor(() => ev(UI(), "document.querySelectorAll('#bookmarksbar .bm').length === 1"))) === true);
  focusMain(); key('ctrl+d');
  check('Ctrl+D de novo remove favorito', !!(await waitFor(async () => !(await activeTab()).bookmarked)));
  focusMain(); key('ctrl+d'); await sleep(600);
  focusMain(); key('ctrl+h');
  const hist = await waitFor(() => ev('antares://history', "antares.history('127.0.0.1',50).then(r=>r.items.map(h=>h.url))"));
  check('Histórico registra as visitas', hist && hist.includes(A) && hist.includes(B), hist && `${hist.length} itens`);
  check('Página Histórico lista itens', (await waitFor(() => ev('antares://history', "document.querySelectorAll('.row').length"))) >= 2);
  check('API interna NÃO existe em sites comuns', (await ev(A, 'typeof window.antares')) === 'undefined');

  /* ---------------- find & zoom */
  await go(A);
  focusMain(); key('ctrl+f'); await sleep(400); type('antares'); await sleep(900);
  const fc = await ev(UI(), "document.getElementById('find-count').textContent");
  check('Localizar na página (Ctrl+F)', /1 de 3/.test(fc), fc);
  key('Escape'); await sleep(300);
  focusMain(); key('ctrl+equal');
  check('Zoom + (Ctrl+=)', !!(await waitFor(async () => Math.abs((await activeTab()).zoom - 1.1) < 0.01)));
  await go(B);
  check('Zoom lembrado no mesmo site', !!(await waitFor(async () => Math.abs((await activeTab()).zoom - 1.1) < 0.01)));
  focusMain(); key('ctrl+0');
  check('Zoom volta a 100% (Ctrl+0)', !!(await waitFor(async () => Math.abs((await activeTab()).zoom - 1) < 0.01)));

  /* ---------------- downloads */
  await go(A);
  await ev(A, "(()=>{const a=document.createElement('a');a.href='http://127.0.0.1:8766/small';a.download='';document.body.appendChild(a);a.click();return 1})()");
  const fileOk = await waitFor(() => fs.existsSync(`${os.homedir()}/nota.txt`) && fs.readFileSync(`${os.homedir()}/nota.txt`, 'utf8') === 'conteudo de teste', 8000);
  check('Download comum é salvo', !!fileOk);
  focusMain(); key('ctrl+j');
  const dl = await waitFor(() => ev('antares://downloads', "antares.downloads().then(d=>d.filter(x=>x.filename==='nota.txt'&&x.state==='completed'&&x.exists).length)"));
  check('Download aparece na página Downloads', dl === 1);

  /* ---------------- settings */
  const s0 = await waitFor(() => ev('antares://downloads', 'antares.settings().then(s=>s.showBookmarksBar)'));
  await ev('antares://downloads', 'antares.setSettings({showBookmarksBar:false})');
  check('Configuração oculta a barra de favoritos', !!(await waitFor(() => ev(UI(), "document.getElementById('bookmarksbar').classList.contains('hidden')"))));
  await ev('antares://downloads', `antares.setSettings({showBookmarksBar:${s0 !== false}})`);
  const bad = await ev('antares://downloads', "antares.setSettings({homepage:'javascript:alert(1)'}).then(s=>s.homepage)");
  check('Configurações rejeitam página inicial javascript:', bad !== 'javascript:alert(1)', bad);
  focusMain(); key('ctrl+l'); type('antares://settings'); key('Return');
  check('Página Configurações carrega valores', (await waitFor(() => ev('antares://settings', "document.getElementById('engine').options.length >= 5 && document.getElementById('ver').textContent.includes('Chromium')"))) === true);

  /* ---------------- security */
  focusMain(); key('ctrl+t'); await sleep(400); await go(EVIL); await sleep(2500);
  const tl = (await targets()).map((x) => x.url);
  check('Site não abre página interna (antares://)', (await activeTab()).url.startsWith(EVIL));
  check('Site não abre aba data: falsa', !tl.some((u) => u.startsWith('data:')));
  check('Pop-up automático bloqueado (ícone aparece)', (await ev(UI(), "!document.getElementById('popups').hidden")) === true);
  check('Bloqueador barrou anúncios/rastreadores', Number(await ev(UI(), "document.getElementById('shield-n').textContent")) >= 2);
  await ev(EVIL, "location.href='/redir'; 1"); await sleep(2500);
  check('Redirecionamento para página interna bloqueado', (await activeTab()).url.startsWith(EVIL));
  check('Notificações não são liberadas sem perguntar', (await ev(EVIL, 'Notification.permission')) === 'denied');
  check('Geolocalização não é liberada sem perguntar', (await ev(EVIL, "navigator.permissions.query({name:'geolocation'}).then(p=>p.state)")) !== 'granted');

  /* ---------------- private window */
  await go(A); await ev(A, "document.cookie='normal=1; path=/'; 1");
  focusMain(); key('ctrl+shift+n');
  check('Ctrl+Shift+N abre janela privada', !!(await waitFor(async () => (await targets()).some(UI(true)), 8000)));
  await sleep(800);
  await go('http://127.0.0.1:8766/cookie.html', true);
  const privCookie = await ev((x) => x.type === 'page' && x.url.startsWith('http://127.0.0.1:8766/cookie.html'), "document.cookie='priv=1; path=/'; document.cookie");
  const normCookie = await ev(A, 'document.cookie');
  check('Janela privada não vê cookies da normal', !/normal=1/.test(privCookie || ''), privCookie);
  check('Janela normal não vê cookies da privada', !/priv=1/.test(normCookie || ''), normCookie);
  check('Janela privada não grava histórico', !((await ev('antares://settings', "antares.history('cookie.html',5).then(r=>r.items.length)")) > 0));
  sh(`python3 xclose.py 'Antares \\(Privado\\)$'`);
  check('Janela privada fecha', !!(await waitFor(async () => !(await targets()).some(UI(true)), 8000)));

  /* ---------------- crash recovery */
  await go(A);
  { // crash the tab that is on screen (other tabs may have the same address)
    const cands = (await targets()).filter((x) => x.type === 'page' && x.url === A);
    let target = cands[0];
    for (const c of cands) { const r = await cdp((x) => x.id === c.id, 'Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }).catch(() => null); if (r && r.result && r.result.result && r.result.result.value === 'visible') { target = c; break; } }
    if (target) await cdp((x) => x.id === target.id, 'Page.crash').catch(() => {});
  }
  const crashed = await waitFor(async () => { const t = await activeTab(); return t.url.startsWith('antares://error') && t; }, 8000);
  check('Página que trava mostra aviso de erro', !!crashed);
  focusMain(); await go(B);
  check('Aba continua utilizável após travamento', (await activeTab()).url === B);

  const log = fs.readFileSync('/tmp/e2e-app.log', 'utf8');
  const errs = log.split('\n').filter((l) => /uncaught|unhandled/i.test(l));
  check('Nenhum erro interno escondido no log', errs.length === 0, errs.slice(0, 3).join(' | '));
  await stop();

  console.log(`\nRESUMO: ${results.filter((r) => r.ok).length}/${results.length} passaram`);
  fs.writeFileSync('/tmp/e2e-results.json', JSON.stringify(results, null, 1));
}
main().catch(async (e) => { console.error('ERRO NO TESTE', e); await stop(); process.exit(1); });
