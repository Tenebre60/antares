import { execSync, spawn } from 'child_process'; import fs from 'fs';
const env = { ...process.env, DISPLAY: ':99', NO_PROXY: '*', no_proxy: '*' };
const sh = (c) => { try { return execSync(c, { env, timeout: 20000 }).toString(); } catch { return ''; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = () => { for (const f of fs.readdirSync(process.env.HOME)) if (/^nota.*\.txt$/.test(f)) fs.rmSync(process.env.HOME + '/' + f); };
const count = () => fs.readdirSync(process.env.HOME).filter((f) => /^nota.*\.txt$/.test(f)).length;
const q = () => { try { return fs.readdirSync(process.env.HOME + '/.config/Antares/quarantine').length; } catch { return 0; } };
for (const [label, x] of [['Permitir', 478], ['Bloquear', 160]]) {
  clean(); sh('pkill -9 -f linux-unpacked'); await sleep(800);
  spawn('/tmp/distlinux/linux-unpacked/antares', ['--no-sandbox', '--disable-gpu', 'http://127.0.0.1:8767/multidl.html'], { env, stdio: 'ignore' });
  await sleep(12000);
  const D = sh(`xdotool search --name 'Vários downloads'`).trim().split('\n')[0];
  const g = sh(`xdotool getwindowgeometry --shell ${D}`); const DX = +(g.match(/X=(\d+)/) || [0, 0])[1], DY = +(g.match(/Y=(\d+)/) || [0, 0])[1];
  sh(`xdotool mousemove ${DX + x} ${DY + 92} click 1`); await sleep(3000);
  const ok = label === 'Permitir' ? count() === 6 && q() === 0 : count() === 1 && q() === 0;
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${label}: ${count()} arquivo(s) salvos, ${q()} na quarentena`);
}
sh('pkill -9 -f linux-unpacked'); clean();
