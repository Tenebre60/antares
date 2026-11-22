import fs from 'fs';
import { sleep, ev, ui, st, waitFor, check, results, targets } from './lib.mjs';
const P = 'http://127.0.0.1:8768';
const active = async () => { const s = await st(); return s.tabs.find((t) => t.id === s.active); };
await waitFor(() => st().then((s) => s.tabs.length >= 1), 15000);
// web pages see no browser APIs
await ui(`chrome2.navigate('${P}/probe.html')`);
check('Site não enxerga APIs internas (antares, chrome2, require)', await waitFor(async () => (await active()).title === 'undefined,undefined,undefined'), (await active()).title);
// favicons from forbidden schemes are ignored
await ui(`chrome2.navigate('${P}/fav.html')`); await sleep(2500);
const fav = await ui(`state.tabs.find(t=>t.id===state.activeId).favicon`);
check('Favicon file:// ou antares:// é ignorado', fav === '', fav);
// thumbnails stay in memory
await ui(`chrome2.navigate('http://127.0.0.1:8766/a.html')`); await sleep(4000);
check('Miniatura existe em Recentes', await ui(`state.recents.some(r=>r.thumb)`) === true);
const files = fs.readdirSync('/tmp/antprof');
check('Nenhuma captura de página gravada no disco', !files.some((f) => f.startsWith('thumbs')), files.join(' '));
// clearing history clears recents
await ui(`chrome2.internal('history')`); await sleep(1500);
await ev('antares://history', `antares.clearData({history:true, range:0}).then(()=>1)`).catch((e) => console.log('clear err', e.message));
await sleep(1500);
check('Limpar histórico zera os Recentes', (await ui(`state.recents.length`)) === 0);
// split view shows the real host
await ui(`chrome2.navigate('http://127.0.0.1:8766/a.html')`); await sleep(1200);
await ui(`chrome2.newTab('${P}/spoof.html', {})`); await sleep(1500);
const s = await st();
await ui(`chrome2.split('add', ${s.tabs.find((t) => t.url.includes('a.html')).id})`); await sleep(1500);
const heads = await ui(`[...document.querySelectorAll('.pane-head .ph-host')].map(x=>x.textContent).join('|')`);
check('Split View mostra o endereço real de cada página', heads.includes('127.0.0.1:8768') && heads.includes('127.0.0.1:8766'), heads);
await ui(`chrome2.split('exit')`);
// private window never writes to Orbits / Read later
await ui(`chrome2.paletteRun({kind:'cmd',id:'private'})`);
await waitFor(async () => (await targets()).some((x) => x.url.includes('private=1')), 8000); await sleep(2000);
await ev((x) => x.url.includes('private=1'), `chrome2.navigate('http://127.0.0.1:8766/b.html')`); await sleep(1500);
const before = JSON.stringify(await ui('state.collections'));
await ev((x) => x.url.includes('private=1'), `chrome2.readLater(); chrome2.orbit('save'); chrome2.paletteRun({kind:'cmd',id:'save-orbit'}); chrome2.paletteRun({kind:'cmd',id:'read-later'}); 1`);
await sleep(1200);
check('Janela privada não salva em Orbits nem Ler depois', JSON.stringify(await ui('state.collections')) === before);
const cmds = await ev((x) => x.url.includes('private=1'), `chrome2.palette('').then(r=>r.map(i=>i.id).join(','))`);
check('Central da janela privada não oferece salvar', !/save-orbit|read-later/.test(cmds));
const lr = fs.existsSync('/tmp/antprof/readlater.json') ? fs.readFileSync('/tmp/antprof/readlater.json', 'utf8') : '[]';
check('Nada da janela privada no disco', !lr.includes('b.html'));
// web page cannot open internal universe pages
await ui(`chrome2.navigate('http://127.0.0.1:8765/redir')`); await sleep(2000);
check('Redirecionamento para página interna bloqueado', !(await active()).url.startsWith('antares://'), (await active()).url);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passaram`);
process.exit(0);
