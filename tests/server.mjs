import http from 'http';
const page = (title, body = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font:16px sans-serif;background:#fff"><h1>${title}</h1>${body}</body></html>`;
// 1s 440Hz WAV for media tests
function wav() { const sr = 8000, n = sr * 30; const b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(40 * Math.sin(i * 2 * Math.PI * 440 / sr)); return b; }
const W = wav();
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/small') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="nota.txt"' }); return res.end('conteudo de teste'); }
  if (u.pathname === '/a.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page('PaginaA', '<p>antares um, antares dois, antares tres.</p><p><a href="/b.html">link b</a> <a href="/a.html" target="_blank">nova a</a></p>')); }
  if (u.pathname === '/tone.wav') { res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(W); }
  if (u.pathname === '/media.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page('Media', '<audio id="a" src="/tone.wav" loop controls></audio>')); }
  if (u.pathname === '/slowpage') { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page('Slow')); }, 3000); return; }
  if (u.pathname === '/cookie.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page('Cookie')); }
  const name = (u.pathname.replace(/^\//, '').replace(/\.html$/, '') || 'index').toUpperCase();
  res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page('Página ' + name, '<p><a href="/b.html">link b</a> <a href="/a.html" target="_blank">nova a</a></p>'));
}).listen(8766, '127.0.0.1');
http.createServer((req, res) => {
  if (req.url === '/redir') { res.writeHead(302, { Location: 'antares://settings' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(page('Evil', `<img src="https://securepubads.g.doubleclick.net/gampad/ads?x=1"><img src="https://www.google-analytics.com/collect?v=1">
  <script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>
  <script>try{location.href='antares://settings'}catch(e){} try{window.open('antares://settings')}catch(e){} try{window.open('data:text/html,<h1>fake</h1>')}catch(e){} window.open('http://127.0.0.1:8766/a.html?popup');</script>`));
}).listen(8765, '127.0.0.1');
console.log('servers up');
// attack fixtures (port 8767)
const att = {
  'extflood.html': page('Ext', `<script>let n=0;const t=setInterval(()=>{n++;location.href='mailto:x@y.z?n='+n;const a=document.createElement('a');a.href='ms-settings:x';a.click();document.title='tentativas '+n;if(n>20)clearInterval(t)},100)</script>`),
  'popspawn.html': page('Pop', `<script>document.addEventListener('click',()=>{const w=window.open('http://127.0.0.1:8766/b.html','p','width=500,height=400');for(let i=0;i<5;i++)setTimeout(()=>{window.open('http://127.0.0.1:8766/a.html?s='+i)},300*i)});</script><div style="position:fixed;inset:0">clique</div>`),
  'offscreen.html': page('Off', `<script>document.addEventListener('click',()=>{const w=window.open('http://127.0.0.1:8766/b.html','p','left=-5000,top=-5000,width=50,height=50');setTimeout(()=>{try{w.moveTo(-9000,-9000);w.resizeTo(10,10)}catch(e){}},800)});</script><div style="position:fixed;inset:0">clique</div>`),
  'multidl.html': page('Multi', `<script>for(let i=0;i<6;i++)setTimeout(()=>{const a=document.createElement('a');a.href='http://127.0.0.1:8766/small?'+i;a.download='nota.txt';document.body.appendChild(a);a.click()},200*i)</script>`),
};
http.createServer((req, res) => { const k = req.url.slice(1).split('?')[0]; res.writeHead(att[k] ? 200 : 404, { 'Content-Type': 'text/html' }); res.end(att[k] || 'no'); }).listen(8767, '127.0.0.1');
http.createServer((req, res) => {
  const pages = {
    '/fav.html': `<!doctype html><html><head><title>Fav</title><link rel="icon" href="file:///etc/passwd"><link rel="icon" href="antares://settings/x.png"></head><body>fav</body></html>`,
    '/spoof.html': `<!doctype html><html><head><title>Banco do Brasil - Login</title></head><body><h1>login falso</h1></body></html>`,
    '/probe.html': `<!doctype html><html><head><title>Probe</title></head><body><script>document.title = [typeof window.antares, typeof window.chrome2, typeof require].join(',')</script></body></html>`,
  };
  res.writeHead(pages[req.url] ? 200 : 404, { 'Content-Type': 'text/html' }); res.end(pages[req.url] || 'no');
}).listen(8768, '127.0.0.1');
