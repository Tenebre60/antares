// Each attack runs in a fresh browser started directly on the attacking page (no keyboard interaction with it)
import { execSync, spawn } from 'child_process'; import fs from 'fs';
const env = { ...process.env, DISPLAY: ':99', NO_PROXY: '*', no_proxy: '*' };
const sh = (c, t = 20000) => { try { return execSync(c, { env, timeout: t }).toString(); } catch (e) { return String(e.stdout || ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => { try { return await (await fetch('http://127.0.0.1:9333/json')).json(); } catch { return []; } };
async function ev(pred, expression) { const t = (await targets()).find(typeof pred === 'string' ? (x) => x.url.startsWith(pred) : pred); if (!t) return 'sem alvo'; return new Promise((res) => { const ws = new WebSocket(t.webSocketDebuggerUrl); const to = setTimeout(() => res('timeout'), 6000); ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(to); ws.close(); res(d.result?.result?.value); } }; }); }
const r = (name, ok, d = '') => console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${name}${d ? '  — ' + d : ''}`);
const dialogs = () => Number(sh("xdotool search --name '' getwindowname %@ 2>/dev/null | grep -ciE 'abrir|vários|download|certificado|permiss'").trim() || 0);
async function run(url, fn) { sh('pkill -9 -f linux-unpacked'); await sleep(800); spawn('/tmp/distlinux/linux-unpacked/antares', ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333', url], { env, stdio: 'ignore' }); await sleep(9000); await fn(); }
const B = 'http://127.0.0.1:8767/';
for (const f of fs.readdirSync(process.env.HOME)) if (/^nota.*\.txt$/.test(f)) fs.rmSync(process.env.HOME + '/' + f);

await run(B + 'extflood.html', async () => {
  await sleep(4000);
  const tries = await ev(B + 'extflood.html', 'document.title');
  const shot = '/tmp/x1.png'; sh(`import -window root ${shot}`);
  const mbox = sh("xdotool search --name '' getwindowname %@ 2>/dev/null").includes('Abrir');
  r('Site não abre pedido de programa externo sem clique', !mbox && (await ev((x) => x.url.startsWith('antares-ui'), "1")) === 1, `${tries}, nenhum diálogo`);
});
await run(B + 'popspawn.html', async () => {
  const id = sh("xdotool search --name '— Antares$'").trim().split('\n').pop(); sh(`xdotool windowfocus --sync ${id}`);
  { const g = sh(`xdotool getwindowgeometry --shell ${id}`); const X = +g.match(/X=(-?\d+)/)[1], Y = +g.match(/Y=(-?\d+)/)[1], W = +g.match(/WIDTH=(\d+)/)[1], H = +g.match(/HEIGHT=(\d+)/)[1]; sh(`xdotool mousemove ${X + Math.round(W / 2)} ${Y + Math.round(H / 2)} click 1`); } await sleep(5500);
  const n = await ev((x) => x.url.startsWith('antares-ui://chrome/index'), 'state.tabs.length');
  r('Pop-up não abre abas sozinho', n === 1, `${n} aba(s)`);
  const w = sh("xdotool search --name 'Não seguro'").trim().split('\n')[0];
  r('Pop-up foi aberto normalmente pelo clique', !!w);
});
await run(B + 'offscreen.html', async () => {
  const id = sh("xdotool search --name '— Antares$'").trim().split('\n').pop(); sh(`xdotool windowfocus --sync ${id}`);
  { const g = sh(`xdotool getwindowgeometry --shell ${id}`); const X = +g.match(/X=(-?\d+)/)[1], Y = +g.match(/Y=(-?\d+)/)[1], W = +g.match(/WIDTH=(\d+)/)[1], H = +g.match(/HEIGHT=(\d+)/)[1]; sh(`xdotool mousemove ${X + Math.round(W / 2)} ${Y + Math.round(H / 2)} click 1`); } await sleep(3000);
  const w = sh("xdotool search --name 'Não seguro'").trim().split('\n')[0];
  const g = w ? sh(`xdotool getwindowgeometry ${w}`) : '';
  const m = g.match(/Position: (-?\d+),(-?\d+)/); const sz = g.match(/Geometry: (\d+)x(\d+)/);
  r('Pop-up não fica escondido fora da tela', m && Number(m[1]) >= 0 && Number(m[2]) >= 0 && Number(sz[1]) >= 300, g.replace(/\s+/g, ' ').trim());
});
await run(B + 'multidl.html', async () => {
  await sleep(4000);
  const files = fs.readdirSync(process.env.HOME).filter((f) => /^nota.*\.txt$/.test(f));
  const asked = sh("xdotool search --name '' getwindowname %@ 2>/dev/null");
  sh('import -window root /tmp/x4.png');
  r('Downloads em massa sem clique pedem permissão', files.length <= 1, `${files.length} arquivo(s) salvo(s) antes de perguntar`);
});
sh('pkill -9 -f linux-unpacked');
