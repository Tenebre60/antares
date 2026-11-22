import { execSync } from 'child_process';
import { sleep, ev, ui, st, waitFor, check, results, targets } from './lib.mjs';
const A = 'http://127.0.0.1:8766/a.html', B = 'http://127.0.0.1:8766/b.html';
const shot = (n) => execSync(`DISPLAY=:99 import -window root /tmp/${n}.png`);
const active = async () => { const s = await st(); return s.tabs.find((t) => t.id === s.active); };

await waitFor(() => st().then((s) => s.tabs.length >= 1), 15000);
let s = await st();
check('Começa na Space Pessoal', s.space === 'pessoal', s.space);
await ui(`chrome2.navigate(${JSON.stringify(A)})`);
check('Navega para A', await waitFor(async () => (await active()).url === A));
await ui(`chrome2.newTab(${JSON.stringify(B)})`);
check('Nova aba B', await waitFor(async () => (await active()).url === B));
s = await st();
const pessoalIds = s.tabs.filter((t) => t.space === 'pessoal').map((t) => t.id);
check('2 abas na Pessoal', pessoalIds.length === 2);
// switch to Trabalho
await ui(`chrome2.space('switch','trabalho')`);
check('Troca para Trabalho', await waitFor(async () => (await st()).space === 'trabalho'));
s = await st();
const trab = s.tabs.filter((t) => t.space === 'trabalho');
check('Trabalho ganha uma aba nova própria', trab.length === 1 && trab[0].id === s.active);
check('Barra mostra só as abas da Space', (await ui(`document.querySelectorAll('#tabs .tab').length`)) === 1);
await ui(`chrome2.navigate('http://127.0.0.1:8766/work.html')`);
await waitFor(async () => (await active()).url.includes('work'));
await ui(`chrome2.space('switch','pessoal')`);
check('Volta para a Pessoal e reabre a última aba usada', await waitFor(async () => { const x = await st(); return x.space === 'pessoal' && x.active === pessoalIds[1]; }));
check('Barra mostra 2 abas', (await ui(`document.querySelectorAll('#tabs .tab').length`)) === 2);
// split view
await ui(`chrome2.split('add', ${pessoalIds[0]})`);
check('Split View com 2 páginas', await waitFor(async () => (await st()).panes === 2));
await sleep(800); shot('split2');
await ui(`chrome2.split('add')`);
check('Split View com 3 páginas', await waitFor(async () => (await st()).panes === 3));
await sleep(300);
await ui(`chrome2.navigate('http://127.0.0.1:8766/c.html')`);
await sleep(1200);
await ui(`chrome2.split('add')`); await waitFor(async () => (await st()).panes === 4);
check('Split View com 4 páginas', (await st()).panes === 4);
await sleep(1200); shot('split4');
await ui(`chrome2.split('add')`); await sleep(500);
check('Não passa de 4 páginas', (await st()).panes === 4);
const s4 = await st();
await ui(`chrome2.split('remove', ${s4.split[3]})`);
check('Remove uma página do Split', await waitFor(async () => (await st()).panes === 3));
await ui(`chrome2.split('exit')`);
check('Sai do Split View', await waitFor(async () => !(await st()).panes));
// palette
await ui(`openPalette()`); await sleep(500);
const n = await ui(`document.querySelectorAll('.pal-row').length`);
check('Central de comandos abre com itens', n > 5, String(n));
await ui(`palIn.value='work'; palIn.dispatchEvent(new Event('input'))`); await sleep(500);
check('Central encontra aba de outra Space', (await ui(`palItems.some(i=>i.kind==='tab' && /WORK/i.test(i.title))`)) === true);
shot('palette');
await ui(`runPalette(palItems.findIndex(i=>i.kind==='tab' && /WORK/i.test(i.title)))`);
check('Escolher aba de outra Space troca de Space', await waitFor(async () => (await st()).space === 'trabalho'));
await ui(`chrome2.space('switch','pessoal')`); await sleep(500);
// popovers
await ui(`document.getElementById('d-perf').click()`); await sleep(800);
check('Painel Desempenho mostra memória', /MB/.test(await ui(`document.getElementById('pop').textContent`)));
shot('perf');
await ui(`closePop()`);
await ui(`chrome2.navigate('http://127.0.0.1:8766/media.html')`); await sleep(1500);
await ev('http://127.0.0.1:8766/media.html', `document.getElementById('a').play().then(()=>1)`);
await sleep(1200);
await ui(`document.getElementById('d-media').click()`); await sleep(800);
check('Painel Mídia lista a aba tocando', /Media/.test(await ui(`document.getElementById('pop').textContent`)));
shot('media');
await ui(`document.querySelector('#pop [data-a=toggle]').click()`); await sleep(800);
check('Pausar pelo painel Mídia', (await ev('http://127.0.0.1:8766/media.html', `document.getElementById('a').paused`)) === true);
await ui(`closePop()`);
// devices
await ui(`chrome2.device('phone')`); await sleep(2000);
check('Visualização de celular', (await active()).device === 'phone');
const ua = await ev("http://127.0.0.1:8766/media.html", "navigator.userAgent + \"|\" + screen.width");
check('Celular usa UA móvel e 390px', /Mobile/.test(ua) && ua.endsWith("|390"), ua);
shot('phone');
await ui(`chrome2.device('desktop')`); await sleep(2000);
const ua2 = await ev('http://127.0.0.1:8766/media.html', 'navigator.userAgent + "|" + innerWidth');
check('Volta ao computador', !/Mobile/.test(ua2), ua2);
// capture
await ui(`chrome2.capture()`); await sleep(1500);
const dl = await ui(`document.getElementById('downloads').title`);
check('Captura não trava', typeof dl === 'string');
// read later & missions
await ui(`chrome2.navigate(${JSON.stringify(A)})`); await sleep(1200);
await ui(`chrome2.readLater()`); await sleep(500);
check('Ler depois conta 1', (await ui(`state.collections.readLater`)) === 1);
// mode
await ui(`toggleMode()`); await sleep(800);
check('Modo Foco ativa', /mode-focus/.test((await st()).mode));
shot('focus');
await ui(`toggleMode()`); await sleep(800);
check('Modo Órbita volta', /mode-orbit/.test((await st()).mode));
// internal pages
await ui(`chrome2.internal('universe#missions')`); await sleep(1500);
await ev('antares://universe', `document.getElementById('mission-title').value='Planejar viagem'; document.getElementById('mission-add').requestSubmit(); 1`); await sleep(800);
check('Cria missão', (await ui(`state.collections.missions.length`)) === 1);
shot('missions');
await ui(`chrome2.internal('universe#spaces')`); await sleep(1200); shot('spaces');
await ui(`chrome2.internal('mapa')`); await sleep(2000); shot('mapa');
check('Mapa Estelar desenha estrelas', (await ev('antares://mapa', `document.querySelectorAll('#world .node').length`)) >= 6);
await ui(`chrome2.internal('newtab')`); await sleep(1500); shot('newtab');
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passaram`);
process.exit(0);
