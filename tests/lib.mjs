export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function targets() { try { return await (await fetch('http://127.0.0.1:9333/json')).json(); } catch { return []; } }
export async function ev(pred, expression, timeout = 8000) {
  const list = await targets();
  const t = typeof pred === 'function' ? list.find(pred) : list.find((x) => x.type === 'page' && x.url.startsWith(pred));
  if (!t) throw new Error('sem alvo ' + pred);
  return new Promise((res, rej) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    const to = setTimeout(() => { try { ws.close(); } catch {} rej(new Error('timeout')); }, timeout);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id !== 1) return; clearTimeout(to); ws.close();
      if (d.result?.exceptionDetails) rej(new Error(d.result.exceptionDetails.exception?.description || 'exc')); else res(d.result?.result?.value); };
    ws.onerror = () => { clearTimeout(to); rej(new Error('ws')); };
  });
}
export const UI = (priv = false) => (x) => x.url.startsWith('antares-ui://chrome/index.html') && x.url.includes(`private=${priv ? 1 : 0}`);
export const ui = (e, priv) => ev(UI(priv), e);
export const st = async (priv) => JSON.parse(await ui(`JSON.stringify({tabs: state.tabs.map(t=>({id:t.id,url:t.url,title:t.title,space:t.space,sleeping:t.sleeping,device:t.device})), active: state.activeId, space: state.space, split: state.split, panes: state.panes && state.panes.panes.length, spaces: state.spaces.map(s=>s.id), mode: document.body.className})`, priv));
export async function waitFor(fn, ms = 8000, step = 200) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return null; }
export const results = [];
export function check(name, ok, detail = '') { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASSOU' : 'FALHOU'}  ${name}${detail ? '  — ' + detail : ''}`); }
