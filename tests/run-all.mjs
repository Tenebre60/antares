// Runs the Antares test suites against the packaged Linux build in /tmp/distlinux.
// Needs an X display on :99 with a window manager (CI: Xvfb + openbox), xdotool, ImageMagick and python3-xlib.
// Exits with code 1 if any check fails, so a broken version is never published.
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const dir = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, DISPLAY: ':99', NO_PROXY: '*', no_proxy: '*' };
const APP = '/tmp/distlinux/linux-unpacked/antares';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = () => { try { execSync('pkill -9 -f linux-unpacked', { env }); } catch {} };
const server = spawn(process.execPath, [path.join(dir, 'server.mjs')], { env, stdio: 'ignore' });
await sleep(800);
let pass = 0, fail = 0; const failed = [];
function run(file, timeout = 400000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(dir, file)], { env, cwd: dir });
    let out = '';
    p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    p.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('exit', (code) => {
      clearTimeout(t);
      const ok = (out.match(/^PASSOU/gm) || []).length, bad = (out.match(/^FALHOU/gm) || []).length;
      pass += ok; fail += bad;
      if (bad) failed.push(...out.split('\n').filter((l) => l.startsWith('FALHOU')).map((l) => `${file}: ${l}`));
      if (code !== 0 || ok === 0) { fail++; failed.push(`${file}: terminou com erro (código ${code}, ${ok} verificações)`); }
      resolve();
    });
  });
}
for (const f of ['e2e.mjs', 'atk.mjs', 'dlchoice.mjs', 'wintest.mjs']) { kill(); await sleep(800); fs.rmSync(path.join(process.env.HOME, '.config', 'Antares'), { recursive: true, force: true }); await run(f); }
// suites that drive an already running browser
for (const f of ['ft.mjs', 'sec2.mjs']) {
  kill(); await sleep(800); fs.rmSync('/tmp/antprof', { recursive: true, force: true });
  const app = spawn(APP, ['--no-sandbox', '--user-data-dir=/tmp/antprof', '--remote-debugging-port=9333'], { env, stdio: 'ignore' });
  await sleep(9000); await run(f); app.kill('SIGKILL');
}
kill(); server.kill();
console.log(`\n==== ${pass} verificações passaram, ${fail} falharam ====`);
if (failed.length) {
  console.log(failed.join('\n'));
  try { console.log('\n--- fim do registro do navegador ---\n' + fs.readFileSync('/tmp/e2e-app.log', 'utf8').split('\n').filter((l) => !/dbus|Fontconfig|gles|viz_main/i.test(l)).slice(-80).join('\n')); } catch {}
  process.exit(1);
}
process.exit(0);
