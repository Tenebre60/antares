import { execSync, spawn } from 'child_process'; import fs from 'fs';
const env = { ...process.env, DISPLAY: ':99', NO_PROXY: '*', no_proxy: '*' };
const sh = (c) => { try { return execSync(c, { env, timeout: 20000 }).toString(); } catch (e) { return String(e.stdout || ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => { try { return await (await fetch('http://127.0.0.1:9333/json')).json(); } catch { return []; } };
const ui = (p) => (x) => x.url.startsWith('antares-ui://chrome/index.html') && x.url.includes(`private=${p ? 1 : 0}`);
const focus = (re) => { const id = sh(`xdotool search --name '${re}'`).trim().split('\n').pop(); if (id) sh(`xdotool windowfocus --sync ${id}`); };
const r = (name, ok, d='') => console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${name}${d ? '  — ' + d : ''}`);
sh('pkill -f linux-unpacked'); await sleep(800);
const p = spawn('/tmp/distlinux/linux-unpacked/antares', ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333', 'http://127.0.0.1:8766/a.html'], { env, stdio: 'ignore' });
await sleep(9000);
// 1) private window closed with the X button
focus('— Antares$'); sh('xdotool key ctrl+shift+n'); await sleep(3500);
r('Janela privada abriu', (await targets()).some(ui(true)));
console.log('  ', sh(`python3 xclose.py 'Antares \\(Privado\\)$'`).trim()); await sleep(2500);
r('Botão X fecha a janela privada', !(await targets()).some(ui(true)));
// 2) private window closed by closing its last tab
focus('— Antares$'); sh('xdotool key ctrl+shift+n'); await sleep(3500);
focus('Antares \\(Privado\\)$'); sh('xdotool key ctrl+w'); await sleep(2500);
r('Fechar a última aba fecha a janela privada', !(await targets()).some(ui(true)));
// 3) normal window with 3 tabs closed with X: app exits and session is saved
focus('— Antares$'); sh('xdotool key ctrl+t'); await sleep(800); sh('xdotool key ctrl+t'); await sleep(800);
const before = (await targets()).filter((x) => x.type === 'page' && !x.url.startsWith('antares-ui')).length;
console.log('  ', sh(`python3 xclose.py '— Antares$'`).trim()); await sleep(4000);
const alive = sh("ps -eo args | grep -c '^/tmp/distlinux/linux-unpacked/antares'").trim();
r('Botão X fecha janela com várias abas e encerra o app', alive === '0' || alive === '', `abas=${before}, processos restantes=${alive || 0}`);
const st = JSON.parse(fs.readFileSync(process.env.HOME + '/.config/Antares/settings.json', 'utf8'));
r('Sessão salva ao fechar (para "continuar de onde parei")', (st.lastSession || []).some((x) => (x.url || x) === 'http://127.0.0.1:8766/a.html'), JSON.stringify(st.lastSession));
sh('pkill -f linux-unpacked');
