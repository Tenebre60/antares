'use strict';
const {
  app, BaseWindow, WebContentsView, ipcMain, session, protocol, Menu,
  dialog, shell, clipboard, nativeTheme, net, screen,
} = require('electron');
// every renderer is sandboxed, even one created by mistake (Chromium refuses this when running as Linux root, e.g. in test containers)
if (!(process.platform === 'linux' && process.getuid && process.getuid() === 0)) app.enableSandbox();
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { FiltersEngine, Request: AbRequest } = require('@ghostery/adblocker');

app.setName('Aurora');
// never show a crash dialog for an unexpected error in the browser process; log it instead
process.on('uncaughtException', (err) => console.error('uncaught', err));
process.on('unhandledRejection', (err) => console.error('unhandled', err));
if (process.platform === 'win32') app.setAppUserModelId('com.aurora.browser');

const UI_DIR = path.join(__dirname, 'ui');
const PAGES_DIR = path.join(__dirname, 'pages');
const ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const HOME = 'aurora://newtab';

protocol.registerSchemesAsPrivileged([
  { scheme: 'aurora', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'aurora-ui', privileges: { standard: true, secure: true } },
]);
// The browser's own interface lives in a separate session that web pages never share.
let uiSession = null;
function getUiSession() {
  if (uiSession) return uiSession;
  uiSession = session.fromPartition('aurora-ui-chrome');
  uiSession.protocol.handle('aurora-ui', (req) => {
    const u = new URL(req.url);
    const file = path.normalize(path.join(UI_DIR, decodeURIComponent(u.pathname)));
    const ext = path.extname(file);
    if (!file.startsWith(UI_DIR + path.sep) || !MIME[ext] || !fs.existsSync(file)) return new Response('', { status: 404 });
    return new Response(fs.readFileSync(file), { headers: { 'Content-Type': MIME[ext], 'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } });
  });
  uiSession.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  uiSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => cb({ cancel: d.resourceType !== 'image' }));
  return uiSession;
}
const uiUrl = (file, query) => `aurora-ui://chrome/${file}?${new URLSearchParams(query)}`;

if (!app.requestSingleInstanceLock()) { app.quit(); }

/* ---------------------------------------------------------------- storage */
const dataFile = (n) => path.join(app.getPath('userData'), `${n}.json`);
const timers = {};
const writeChains = {};
let flushed = false;
let writeSeq = 0;
// Files are written to a temporary name and then renamed, so a crash or power loss in the
// middle of a save can never leave a half-written (corrupt) file. A .bak copy of the last
// good file is kept and used automatically if the main file is ever unreadable.
function writeAtomicSync(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
function load(name, def) {
  const file = dataFile(name);
  for (const f of [file, `${file}.bak`]) {
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(def) !== Array.isArray(v)) continue;
      if (f === file) { try { fs.copyFileSync(file, `${file}.bak`); } catch {} }
      return Array.isArray(def) ? v : Object.assign({}, def, v);
    } catch {}
  }
  return Array.isArray(def) ? [] : { ...def };
}
function save(name, data, delay) {
  if (flushed) return;
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => {
    timers[name] = null;
    let text; try { text = JSON.stringify(data); } catch { return; }
    const file = dataFile(name); const tmp = `${file}.${++writeSeq}.tmp`;
    writeChains[name] = (writeChains[name] || Promise.resolve())
      .then(() => fs.promises.writeFile(tmp, text))
      .then(() => (flushed ? fs.promises.unlink(tmp) : fs.promises.rename(tmp, file)))
      .catch((e) => console.error('save', name, e.message));
  }, delay ?? (name === 'history' ? 2500 : 400));
}
function flushAll() {
  for (const n of Object.keys(timers)) clearTimeout(timers[n]);
  if (!settings || flushed) return;
  flushed = true;
  const all = { settings, bookmarks, history, downloads: persistableDownloads() };
  for (const [n, d] of Object.entries(all)) {
    try { writeAtomicSync(dataFile(n), JSON.stringify(d)); } catch (e) { console.error(e); }
  }
}

const DEFAULT_SETTINGS = {
  searchEngine: 'google',
  homepage: HOME,
  startup: 'newtab', // newtab | restore
  showBookmarksBar: true,
  theme: 'system',
  askDownloadLocation: false,
  blockTrackers: true,
  httpsOnly: true,
  gpc: true,
  permissions: {},
  popupAllow: {},
  adblockAllow: {},
  lastSession: [],
  filtersUpdated: 0,
  lastUpdateCheck: 0,
  tabSleep: true,
  zoom: {},
};
const BUILD_DATE = '2026-11-18';
let settings, bookmarks, history;

const SEARCH = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  ecosia: { name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s' },
};

function toUrl(input) {
  const t = String(input || '').trim();
  if (!t) return null;
  if (/^javascript:/i.test(t)) return null;
  if (/^(https?|file|aurora|about|data|view-source):/i.test(t)) return t;
  if (/^[a-z]:\\/i.test(t) || t.startsWith('/')) return pathToFileURL(t).toString();
  if (!/\s/.test(t) && (/^localhost(:\d+)?(\/|$)/i.test(t) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(t) ||
      /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t))) {
    return (/^localhost|^\d/.test(t) ? 'http://' : 'https://') + t;
  }
  return searchUrl(t);
}
function searchUrl(q) {
  const eng = SEARCH[settings.searchEngine] || SEARCH.google;
  return eng.url.replace('%s', encodeURIComponent(q));
}

function addHistory(url, title, favicon) {
  if (!/^https?:/i.test(url)) return;
  const now = Date.now();
  const last = history[0];
  if (last && last.url === url && now - last.time < 30 * 60 * 1000) {
    last.time = now; if (title) last.title = title; if (favicon) last.favicon = favicon;
  } else {
    history.unshift({ url, title: title || url, favicon: favicon || '', time: now });
    if (history.length > 20000) history.length = 20000;
  }
  save('history', history);
}
function updateHistoryMeta(url, patch) {
  const h = history.find((x) => x.url === url);
  if (h) { Object.assign(h, patch); save('history', history); }
}

/* --------------------------------------------------------- security helpers */
// Web content may only open these kinds of addresses by itself (new tabs/pop-ups).
const isWebUrl = (u) => /^https?:\/\//i.test(u || '');
const isOpenableByPage = (u) => isWebUrl(u) || u === 'about:blank' || u === '';
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const isLocalHost = (h) => h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
  /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[') || !h.includes('.');

const DANGEROUS_EXT = new Set(('exe msi msix msixbundle appx appxbundle bat cmd com scr pif cpl hta js jse vbs vbe wsf wsh ps1 psm1 ' +
  'reg lnk url jar dll sys ocx inf iso img vhd vhdx apk xll xlam docm xlsm pptm chm application gadget msp mst scf settingcontent-ms').split(' '));
const isDangerousFile = (name) => DANGEROUS_EXT.has(path.extname(name || '').slice(1).toLowerCase());
// Links to other programs (mailto:, tel:, zoommtg:…) are allowed after asking, except these,
// which are known to be abused to run code or reach local files.
const BLOCKED_SCHEMES = new Set(('file javascript vbscript data blob about chrome devtools aurora aurora-ui jar shell mk its ms-its hcp help res ' +
  'search search-ms ms-search ms-msdt ms-officecmd ms-cxh ms-cxh-full ms-appinstaller ms-settings ms-gamebarservices ms-diagnostics ' +
  'ms-quick-assist ms-remoteassistance ldap ldaps cdl smb nfs').split(' '));
const ASK_PERMS = ['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'display-capture', 'idle-detection', 'speaker-selection'];
const sessionGrants = new WeakMap(); // session -> Set of "origin|perm" granted only for this run
const popupContents = new WeakSet();
const pageContents = new WeakSet();
const stripHash = (u) => String(u || '').split('#')[0];
const certs = new Map(); // hostname -> last seen certificate
const sessionDenies = new WeakMap(); // session -> Set of "origin|perm" the user blocked during this run
const pendingPrompts = new Set();      // "wcId|kind" with a dialog currently open (one at a time)
const pageDenied = new WeakMap();      // webContents -> Set of things refused on the current page
const pageAllowed = new WeakMap();     // webContents -> Set of things allowed on the current page
const autoDownloads = new WeakMap();   // webContents -> automatic downloads on the current page
const recentInput = (wc, ms = 3000) => { try { return Date.now() - (lastUserInput.get(wc) || 0) < ms; } catch { return false; } };
const pageSet = (map, wc) => { let s = map.get(wc); if (!s) { s = new Set(); map.set(wc, s); } return s; };
const clientCertChoice = new Map(); // host -> chosen certificate fingerprint (this run only)

/* ----------------------------------------------------------- trust tracking */
// Internal pages (aurora://) get the privileged API only when the browser itself
// loaded them (address bar, menu, back/forward) or another trusted internal page did.
const trusted = new WeakSet();
const uiContents = new WeakSet();
const lastUserInput = new WeakMap();

const pendingNav = new WeakMap();
function guardWebContents(wc) {
  // decide trust when a navigation starts, apply it only when that navigation commits
  wc.on('did-start-navigation', (d) => {
    if (!d.isMainFrame || d.isSameDocument) return;
    const init = d.initiator;
    let ok = !init; // started by the browser itself (address bar, menus, back/forward, reload)
    try { if (init && String(init.url).startsWith('aurora://') && trusted.has(wc)) ok = true; } catch {}
    pendingNav.set(wc, { url: String(d.url), ok });
  });
  wc.on('did-redirect-navigation', (d) => { if (d.isMainFrame) { const p = pendingNav.get(wc); if (p) p.ok = false; } });
  wc.on('did-navigate', (e, url) => {
    pageDenied.delete(wc); pageAllowed.delete(wc); autoDownloads.delete(wc);
    const p = pendingNav.get(wc); pendingNav.delete(wc);
    if (String(url).startsWith('aurora://') && p && p.ok && p.url.split('#')[0] === String(url).split('#')[0]) trusted.add(wc);
    else trusted.delete(wc);
  });
  wc.on('will-redirect', (d) => { if (String(d.url).startsWith('aurora://')) d.preventDefault(); });
  wc.on('will-navigate', (d) => {
    if (uiContents.has(wc)) { d.preventDefault(); return; }
    const target = String(d.url);
    if (target.startsWith('aurora://') && !(wc.getURL().startsWith('aurora://') && trusted.has(wc))) d.preventDefault();
    if (/^(file|view-source|chrome|devtools):/i.test(target) && !wc.getURL().startsWith('file:')) d.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('input-event', (e, ie) => {
    // a real interaction with the page: clicks, taps and ordinary typing (browser shortcuts don't count)
    const mods = ie.modifiers || [];
    const isKey = ie.type === 'rawKeyDown' || ie.type === 'keyDown';
    const shortcut = isKey && (mods.includes('control') || mods.includes('meta') || mods.includes('alt') || /^F\d+$/.test(ie.key || ''));
    if (ie.type === 'mouseDown' || ie.type === 'touchStart' || ie.type === 'gestureTap' || (isKey && !shortcut)) {
      lastUserInput.set(wc, Date.now());
    }
  });
}
app.on('web-contents-created', (e, wc) => {
  guardWebContents(wc);
  // default for anything not otherwise configured (pop-ups, devtools…): never spawn native windows
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});

/* ------------------------------------------------------- ad & tracker block */
let engine = null;
let blockedTotal = 0;
const blockedPerTab = new Map(); // webContentsId -> count
const AB_TYPES = {
  mainFrame: 'main_frame', subFrame: 'sub_frame', stylesheet: 'stylesheet', script: 'script', image: 'image',
  font: 'font', object: 'object', xhr: 'xmlhttprequest', ping: 'ping', cspReport: 'csp_report', media: 'media',
  webSocket: 'websocket', other: 'other',
};
const FILTER_LISTS = [
  'https://raw.githubusercontent.com/easylist/easylist/gh-pages/easylist.txt',
  'https://raw.githubusercontent.com/easylist/easylist/gh-pages/easyprivacy.txt',
];
function loadEngine() {
  const candidates = [path.join(app.getPath('userData'), 'filters.bin'), path.join(__dirname, 'assets', 'filters.bin')];
  for (const f of candidates) {
    try { engine = FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(f))); return; } catch {}
  }
}
async function updateFilterLists(force = false) {
  if (!force && Date.now() - (settings.filtersUpdated || 0) < 7 * 864e5) return false;
  try {
    const texts = [];
    for (const u of FILTER_LISTS) {
      const r = await net.fetch(u);
      if (!r.ok) throw new Error(String(r.status));
      texts.push(await r.text());
    }
    const fresh = FiltersEngine.parse(texts.join('\n'), { loadCosmeticFilters: false, loadNetworkFilters: true, enableCompression: true });
    if (fresh.getFilters().networkFilters.length < 10000) throw new Error('lista incompleta');
    engine = fresh;
    fs.writeFileSync(path.join(app.getPath('userData'), 'filters.bin'), Buffer.from(fresh.serialize()));
    settings.filtersUpdated = Date.now(); save('settings', settings);
    return true;
  } catch (e) { console.error('filter update failed', e.message); return false; }
}
function filterCount() { try { return engine ? engine.getFilters().networkFilters.length : 0; } catch { return 0; } }

/* ------------------------------------------------------------ https-first */
const httpExempt = new Set();     // hosts the user chose to open without HTTPS (this run)
const upgradedUrls = new Map();   // https url -> original http url

/* ------------------------------------------------------------------ sessions */
const configured = new WeakSet();
const downloads = [];
const dlItems = new Map();
let dlSeq = 0;

const reservedPaths = new Set(); // paths already promised to downloads still in progress
function uniquePath(dir, name) {
  const ext = path.extname(name); const base = path.basename(name, ext);
  let p = path.join(dir, name); let i = 1;
  while (fs.existsSync(p) || reservedPaths.has(p.toLowerCase())) p = path.join(dir, `${base} (${i++})${ext}`);
  return p;
}
function persistableDownloads() {
  return downloads.filter((d) => !d.private && d.state !== 'progressing').slice(0, 200)
    .map(({ id, filename, url, path: p, total, received, state, start, dangerous }) => ({ id, filename, url, path: p, total, received, state, start, dangerous }));
}

function setupSession(ses, isPrivate) {
  if (configured.has(ses)) return;
  configured.add(ses);

  ses.protocol.handle('aurora', serveAurora);
  ses.setDevicePermissionHandler(() => false); // USB/HID/serial: never silently
  sessionGrants.set(ses, new Set());
  sessionDenies.set(ses, new Set());
  ses.setPermissionCheckHandler((wc, perm, origin) => {
    if (['hid', 'serial', 'usb', 'bluetooth', 'window-management'].includes(perm)) return false;
    if (!ASK_PERMS.includes(perm)) return true;
    // "ask" permissions are only granted after the user said yes (never silently)
    const key = `${origin}|${perm}`;
    if (sessionGrants.get(ses).has(key)) return true;
    if (!isPrivate && key in settings.permissions) return settings.permissions[key] === true;
    return false;
  });
  ses.setCertificateVerifyProc((req, cb) => {
    if (req.certificate) { certs.set(req.hostname, { ...req.certificate, result: req.verificationResult }); if (certs.size > 300) certs.delete(certs.keys().next().value); }
    cb(-3); // keep Chromium's own verification result
  });

  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'aurora://*/*'] }, (d, cb) => {
    if (d.url.startsWith('aurora:')) {
      // internal pages answer only to browser navigations and to other internal pages;
      // websites can't load them (no detecting Aurora, no embedding)
      if (d.resourceType === 'mainFrame') return cb({});
      let frameUrl = ''; try { frameUrl = d.frame ? d.frame.url : ''; } catch {}
      const from = frameUrl || d.referrer || '';
      return cb({ cancel: !from.startsWith('aurora://') });
    }
    try {
      // HTTPS-first: upgrade top-level http navigations
      if (d.resourceType === 'mainFrame' && settings.httpsOnly && d.url.startsWith('http://') && d.method === 'GET') {
        const h = hostOf(d.url);
        if (h && !isLocalHost(h) && !httpExempt.has(h)) {
          const up = 'https://' + d.url.slice(7);
          upgradedUrls.set(up, d.url);
          if (upgradedUrls.size > 500) upgradedUrls.delete(upgradedUrls.keys().next().value);
          return cb({ redirectURL: up });
        }
      }
      if (settings.blockTrackers && engine && d.resourceType !== 'mainFrame') {
        let top = '';
        try { top = d.webContents ? d.webContents.getURL() : ''; } catch {}
        const source = top || d.referrer || '';
        const th = hostOf(source);
        if (!(th && settings.adblockAllow[th])) {
          const req = AbRequest.fromRawDetails({ url: d.url, sourceUrl: source, type: AB_TYPES[d.resourceType] || 'other' });
          const { match } = engine.match(req);
          if (match) {
            blockedTotal++;
            if (d.webContentsId) {
              blockedPerTab.set(d.webContentsId, (blockedPerTab.get(d.webContentsId) || 0) + 1);
              const t = tabByWcId(d.webContentsId);
              if (t) t.win.sendTabSoon(t);
            }
            return cb({ cancel: true });
          }
        }
      }
    } catch (e) { console.error(e); }
    cb({});
  });

  ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    const h = d.requestHeaders;
    if (settings.gpc) h['Sec-GPC'] = '1';
    cb({ requestHeaders: h });
  });

  ses.setPermissionRequestHandler(async (wc, perm, cb, details) => {
    if (perm === 'fullscreen' && popupContents.has(wc)) return cb(false); // no fake full-screen pop-ups
    const auto = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock'];
    if (auto.includes(perm)) return cb(true);
    let origin = '';
    try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch { return cb(false); }
    if (perm === 'openExternal') return cb(await askOpenExternal(wc, origin, details.externalURL, isPrivate));
    if (!ASK_PERMS.includes(perm)) return cb(false);
    {
      const k = `${origin}|${perm}`;
      // once blocked, a site can't keep asking during this session; and only one question at a time
      if (sessionDenies.get(ses).has(k)) return cb(false);
      if (sessionGrants.get(ses).has(k)) return cb(true);
      const pk = `${wc.id}|perm`;
      if (pendingPrompts.has(pk)) return cb(false);
      pendingPrompts.add(pk);
      const done = (v) => { pendingPrompts.delete(pk); if (!v) sessionDenies.get(ses).add(k); cb(v); };
      cb = done;
    }
    const key = `${origin}|${perm}`;
    if (!isPrivate && key in settings.permissions) return cb(settings.permissions[key]);
    const names = {
      media: 'usar sua câmera e/ou microfone', geolocation: 'saber sua localização',
      notifications: 'mostrar notificações', midi: 'acessar dispositivos MIDI', midiSysex: 'acessar dispositivos MIDI',
      'clipboard-read': 'ler sua área de transferência', 'display-capture': 'capturar sua tela',
      'idle-detection': 'saber quando você está inativo', 'speaker-selection': 'escolher alto-falantes',
    };
    const bw = BrowserWin.fromWebContents(wc);
    const r = await dialog.showMessageBox(bw ? bw.win : undefined, {
      type: 'question', buttons: ['Permitir', 'Bloquear'], defaultId: 1, cancelId: 1,
      title: 'Permissão', message: `${origin} quer ${names[perm] || perm}.`,
      checkboxLabel: isPrivate ? undefined : 'Lembrar minha decisão para este site', checkboxChecked: true,
    });
    const ok = r.response === 0;
    if (!isPrivate && r.checkboxChecked) { settings.permissions[key] = ok; save('settings', settings); }
    if (ok) sessionGrants.get(ses).add(key);
    cb(ok);
  });

  ses.on('will-download', (event, item, wc) => {
    // a page may download one file on its own; more than that without a click needs the user's OK
    let multiDecision = Promise.resolve(true);
    let held = false;
    if (wc && !wc.isDestroyed() && (pageContents.has(wc) || popupContents.has(wc)) && !recentInput(wc, 5000)) {
      const n = (autoDownloads.get(wc) || 0) + 1; autoDownloads.set(wc, n);
      if (n > 1 && pageSet(pageDenied, wc).has('downloads')) { item.cancel(); return; }
      if (n > 1 && !pageSet(pageAllowed, wc).has('downloads')) { held = true; multiDecision = askMultipleDownloads(wc); }
    }
    const id = ++dlSeq;
    const dir = app.getPath('downloads');
    const name = item.getFilename() || 'download';
    const dangerous = isDangerousFile(name);
    let quarantine = null;
    if (dangerous || held) {
      // dangerous files download into a hidden quarantine folder until the user decides
      const qdir = path.join(app.getPath('userData'), 'quarantine');
      try { fs.mkdirSync(qdir, { recursive: true }); } catch {}
      quarantine = path.join(qdir, `${id}-${Date.now()}.download`);
      item.setSavePath(quarantine);
    } else if (settings.askDownloadLocation) {
      const bw = BrowserWin.fromWebContents(wc) || BrowserWin.focused();
      item.setSaveDialogOptions({ defaultPath: path.join(dir, name) });
      void bw;
    } else {
      const p = uniquePath(dir, name);
      reservedPaths.add(p.toLowerCase());
      item.setSavePath(p);
    }
    const reserved = item.getSavePath();
    const d = {
      id, filename: name, url: item.getURL(), path: dangerous ? '' : item.getSavePath(), total: item.getTotalBytes(),
      received: 0, state: 'progressing', paused: false, start: Date.now(), private: !!isPrivate,
    };
    downloads.unshift(d); dlItems.set(id, item);
    d.dangerous = dangerous;
    let decide = () => {};
    const decision = new Promise((r) => { decide = r; });
    if (dangerous) {
      d.state = 'progressing'; d.awaiting = true;
      const bw = (wc && BrowserWin.fromWebContents(wc)) || BrowserWin.focused();
      const from = hostOf(item.getURL()) || 'um site';
      dialog.showMessageBox(bw ? bw.win : undefined, {
        type: 'warning', title: 'Download potencialmente perigoso',
        message: `“${name}” pode prejudicar seu computador.`,
        detail: `Este tipo de arquivo pode instalar programas ou alterar o sistema. Só mantenha se você confia em ${from} e estava esperando por este arquivo.`,
        buttons: ['Descartar', 'Manter mesmo assim'], defaultId: 0, cancelId: 0, noLink: true,
      }).then((r) => {
        d.awaiting = false;
        decide(r.response === 1);
        if (r.response !== 1 && d.state === 'progressing') { try { item.cancel(); } catch {} }
      });
    }
    if (held) multiDecision.then((ok) => { if (!ok && d.state === 'progressing') { try { item.cancel(); } catch {} } });
    item.on('updated', (e, state) => {
      d.state = state; d.received = item.getReceivedBytes(); d.total = item.getTotalBytes();
      d.paused = item.isPaused();
      if (!dangerous) { d.path = item.getSavePath(); d.filename = path.basename(d.path) || d.filename; }
      broadcastDownloads();
    });
    item.once('done', async (e, state) => {
      dlItems.delete(id);
      if (reserved) reservedPaths.delete(reserved.toLowerCase());
      d.received = item.getReceivedBytes();
      if (quarantine) {
        const keep = state === 'completed' && await multiDecision && (!dangerous || await decision);
        if (!keep) {
          try { fs.unlinkSync(quarantine); } catch {}
          d.state = state === 'completed' ? 'cancelled' : state; d.path = '';
          broadcastDownloads(); save('downloads', persistableDownloads()); return;
        }
        const final = uniquePath(app.getPath('downloads'), name);
        try { fs.renameSync(quarantine, final); } catch { try { fs.copyFileSync(quarantine, final); fs.unlinkSync(quarantine); } catch {} }
        d.path = final; d.filename = path.basename(final);
      } else {
        d.path = item.getSavePath(); d.filename = path.basename(d.path) || d.filename;
      }
      d.state = state;
      if (state === 'completed' && process.platform === 'win32') {
        // Mark-of-the-Web: lets Windows SmartScreen / Defender / Office check the file
        try {
          const zone = `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${isWebUrl(d.url) ? d.url : 'about:internet'}\r\n`;
          fs.writeFileSync(`${d.path}:Zone.Identifier`, zone);
        } catch {}
      }
      broadcastDownloads();
      save('downloads', persistableDownloads());
    });
    broadcastDownloads();
    for (const w of BrowserWin.all) w.send('download-started');
    // a tab opened only to download a file is closed, like Chrome does
    const owner = wc && BrowserWin.fromWebContents(wc);
    if (owner && !wc.getURL() && owner.tabs.length > 1) {
      const t = owner.tabs.find((x) => x.view.webContents === wc);
      if (t) setTimeout(() => owner.closeTab(t.id), 0);
    }
  });
}

const multiDownloadAsk = new WeakMap(); // webContents -> pending answer (one question per page)
function askMultipleDownloads(wc) {
  if (multiDownloadAsk.has(wc)) return multiDownloadAsk.get(wc);
  const bw = BrowserWin.fromWebContents(wc) || BrowserWin.focused();
  const p = dialog.showMessageBox(bw ? bw.win : undefined, {
    type: 'question', title: 'Vários downloads', buttons: ['Bloquear', 'Permitir'], defaultId: 0, cancelId: 0, noLink: true,
    message: `${hostOf(wc.getURL()) || 'Este site'} quer baixar vários arquivos.`,
    detail: 'O site está iniciando downloads sozinho, sem você clicar. Permita só se estiver esperando esses arquivos.',
  }).then((r) => {
    const ok = r.response === 1;
    if (!wc.isDestroyed()) pageSet(ok ? pageAllowed : pageDenied, wc).add('downloads');
    multiDownloadAsk.delete(wc);
    return ok;
  });
  multiDownloadAsk.set(wc, p);
  return p;
}

async function askOpenExternal(wc, origin, externalURL, isPrivate) {
  let scheme = '';
  try { scheme = new URL(externalURL).protocol.slice(0, -1).toLowerCase(); } catch { return false; }
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || BLOCKED_SCHEMES.has(scheme)) return false;
  const key = `${origin}|external:${scheme}`;
  if (!isPrivate && key in settings.permissions) return settings.permissions[key];
  // only right after the user clicked/typed, one question at a time, and no re-asking after "Cancelar"
  if (!recentInput(wc)) return false;
  if (pageSet(pageDenied, wc).has(key)) return false;
  const pk = `${wc.id}|external`;
  if (pendingPrompts.has(pk)) return false;
  pendingPrompts.add(pk);
  try { return await askOpenExternalDialog(wc, origin, externalURL, isPrivate, scheme, key); }
  finally { pendingPrompts.delete(pk); }
}
async function askOpenExternalDialog(wc, origin, externalURL, isPrivate, scheme, key) {
  const names = { mailto: 'seu programa de e-mail', tel: 'o discador', callto: 'o discador', sms: 'o app de mensagens', whatsapp: 'o WhatsApp',
    zoommtg: 'o Zoom', zoomus: 'o Zoom', msteams: 'o Microsoft Teams', spotify: 'o Spotify', steam: 'a Steam', discord: 'o Discord', tg: 'o Telegram', skype: 'o Skype' };
  const bw = BrowserWin.fromWebContents(wc) || BrowserWin.focused();
  const r = await dialog.showMessageBox(bw ? bw.win : undefined, {
    type: 'question', title: 'Abrir outro programa?', buttons: ['Abrir', 'Cancelar'], defaultId: 0, cancelId: 1, noLink: true,
    message: `Abrir ${names[scheme] || 'outro programa'}?`,
    detail: `${hostOf(origin) || 'Este site'} quer abrir um link em um programa do seu computador:\n${String(externalURL).slice(0, 140)}${String(externalURL).length > 140 ? '…' : ''}`,
    checkboxLabel: isPrivate ? undefined : `Sempre permitir que ${hostOf(origin)} abra links “${scheme}:”`, checkboxChecked: false,
  });
  const ok = r.response === 0;
  if (!isPrivate && r.checkboxChecked && ok) { settings.permissions[key] = true; save('settings', settings); }
  if (!ok) pageSet(pageDenied, wc).add(key);
  return ok;
}

function downloadsSummary() {
  const active = downloads.filter((d) => d.state === 'progressing');
  const total = active.reduce((s, d) => s + (d.total || 0), 0);
  const rec = active.reduce((s, d) => s + (d.received || 0), 0);
  return { active: active.length, progress: total ? rec / total : (active.length ? -1 : 0), any: downloads.length > 0 };
}
let dlBroadcastTimer = null;
function broadcastDownloads() {
  if (dlBroadcastTimer) return;
  dlBroadcastTimer = setTimeout(() => {
    dlBroadcastTimer = null;
    const s = downloadsSummary();
    for (const w of BrowserWin.all) w.send('downloads', s);
  }, 250);
}

const INTERNAL_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; " +
  "font-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
async function serveAurora(req) {
  const u = new URL(req.url);
  const host = u.hostname || 'newtab';
  let rel = (!u.pathname || u.pathname === '/') ? `${host}.html` : decodeURIComponent(u.pathname.slice(1));
  let file = path.normalize(path.join(PAGES_DIR, rel));
  if (!file.startsWith(PAGES_DIR + path.sep) || !fs.existsSync(file) || !MIME[path.extname(file)]) {
    file = path.join(PAGES_DIR, 'error.html');
  }
  const body = fs.readFileSync(file);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': MIME[path.extname(file)], 'Content-Security-Policy': INTERNAL_CSP,
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Opener-Policy': 'same-origin', 'Referrer-Policy': 'same-origin',
    },
  });
}

/* ------------------------------------------------------------------ windows */
let tabSeq = 0;
const tabById = new Map();
let sharedPrivateSession = null;
const normalWindows = () => [...BrowserWin.all].filter((w) => !w.isPrivate && !w.disposed);
const tabUrl = (t) => { try { return (t.sleeping ? '' : t.view.webContents.getURL()) || t.url || ''; } catch { return t.url || ''; } };
function saveSession(force = false) {
  const wins = normalWindows().filter((w) => force || !w.closingWindow);
  if (!wins.length || (!force && normalWindows().some((w) => w.closingWindow))) return;
  const urls = wins.flatMap((w) => w.tabs.map(tabUrl)).filter((u) => /^https?:/.test(u)).slice(0, 100);
  if (JSON.stringify(urls) === JSON.stringify(settings.lastSession)) return;
  settings.lastSession = urls; save('settings', settings);
}
function tabByWcId(id) {
  for (const t of tabById.values()) { try { if (t.view.webContents.id === id) return t; } catch {} }
  return null;
}

class BrowserWin {
  static all = new Set();
  static lastFocused = null;
  static focused() {
    return BrowserWin.lastFocused && BrowserWin.all.has(BrowserWin.lastFocused) ? BrowserWin.lastFocused : [...BrowserWin.all][0];
  }
  static fromWebContents(wc) {
    for (const w of BrowserWin.all) {
      if (w.ui.webContents === wc || w.tabs.some((t) => t.view.webContents === wc)) return w;
    }
    return null;
  }

  constructor({ isPrivate = false, urls = null } = {}) {
    this.isPrivate = isPrivate;
    // all private windows share one temporary session (like Chrome); it is discarded when the last one closes
    if (isPrivate && !sharedPrivateSession) sharedPrivateSession = session.fromPartition(`aurora-private-${Date.now()}`);
    this.ses = isPrivate ? sharedPrivateSession : session.defaultSession;
    setupSession(this.ses, isPrivate);
    this.tabs = []; this.activeId = null; this.closedTabs = [];
    this.chromeHeight = 82; this.uiHeight = 82; this.htmlFull = false;

    this.win = new BaseWindow({
      width: 1280, height: 840, minWidth: 480, minHeight: 360, title: 'Aurora',
      icon: fs.existsSync(ICON) ? ICON : undefined,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171d' : '#eef0f5',
      autoHideMenuBar: true,
    });
    this.win.setMenuBarVisibility(false);

    this.ui = new WebContentsView({
      webPreferences: { session: getUiSession(), preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, sandbox: true, spellcheck: false },
    });
    this.ui.setBackgroundColor('#00000000');
    uiContents.add(this.ui.webContents);
    this.win.contentView.addChildView(this.ui);
    this.ui.webContents.loadURL(uiUrl('index.html', { private: isPrivate ? '1' : '0' }));
    this.hookKeys(this.ui.webContents);

    this.ui.webContents.once('did-finish-load', () => {
      this.send('init', { isPrivate, bookmarks, settings: publicSettings(), downloads: downloadsSummary(), platform: process.platform });
      const msg = updateNeeded(); if (msg) this.send('update', { msg });
      const list = urls && urls.length ? urls : [null];
      list.forEach((u, i) => this.newTab(u, { background: i > 0 }));
      if (list.length > 1) this.activate(this.tabs[0].id);
    });

    this.win.on('resize', () => this.layout());
    this.win.on('focus', () => { BrowserWin.lastFocused = this; });
    this.win.on('enter-full-screen', () => this.layout());
    this.win.on('leave-full-screen', () => { if (this.htmlFull) { this.htmlFull = false; } this.send('fullscreen', false); this.layout(); this.hideNotice(); });
    this.win.on('close', (e) => {
      if (this.forceClose) return;
      // remember the session before tabs start closing (only when this is the last normal window)
      if (!this.isPrivate && normalWindows().length === 1 && this.tabs.length) saveSession(true);
      if (!this.tabs.length) return;
      // close tabs first so pages with unsaved changes can ask "Leave site?"
      e.preventDefault();
      this.closingWindow = true;
      for (const t of [...this.tabs]) this.closeTab(t.id);
    });
    this.win.on('closed', () => {
      this.disposed = true;
      for (const t of [...this.tabs]) { tabById.delete(t.id); clearTimeout(t.closeTimer); try { t.view.webContents.close(); } catch {} }
      for (const v of [this.ui, this.notice]) { try { if (v) v.webContents.close(); } catch {} }
      BrowserWin.all.delete(this);
      if (this.isPrivate && ![...BrowserWin.all].some((w) => w.isPrivate) && sharedPrivateSession) {
        // last private window closed: wipe everything that session held, the next one starts clean
        const old = sharedPrivateSession; sharedPrivateSession = null;
        for (let i = downloads.length - 1; i >= 0; i--) {
          const d = downloads[i]; if (!d.private) continue;
          const it = dlItems.get(d.id); if (it) { try { it.cancel(); } catch {} }
          downloads.splice(i, 1);
        }
        broadcastDownloads();
        old.clearStorageData().catch(() => {}); old.clearCache().catch(() => {}); old.clearAuthCache().catch(() => {});
      }
    });
    BrowserWin.all.add(this);
    BrowserWin.lastFocused = this;
  }

  get active() { return this.tabs.find((t) => t.id === this.activeId) || null; }
  send(ch, ...a) { const wc = this.ui.webContents; if (!wc.isDestroyed()) wc.send(ch, ...a); }

  layout() {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize();
    const ch = this.htmlFull ? 0 : this.chromeHeight;
    this.ui.setBounds({ x: 0, y: 0, width: w, height: this.htmlFull ? 0 : Math.max(this.uiHeight, ch) });
    const a = this.active;
    if (a) a.view.setBounds({ x: 0, y: ch, width: w, height: Math.max(0, h - ch) });
  }

  tabInfo(t) {
    const live = this.alive(t);
    const wc = live ? t.view.webContents : { isDestroyed: () => true, id: -1 };
    const url = tabUrl(t);
    let display = url;
    let warn = '';
    if (url.startsWith(HOME)) display = '';
    else if (url.startsWith('aurora://error')) { try { display = new URL(url).searchParams.get('u') || url; } catch {} }
    else if (isWebUrl(url)) {
      try {
        const pu = new URL(url);
        if (pu.username || pu.password) {
          warn = 'Este endereço contém um nome de usuário antes do site real, um truque comum de golpes. O site verdadeiro é ' + pu.hostname + '.';
          pu.username = ''; pu.password = ''; display = pu.toString();
        }
        if (pu.hostname.split('.').some((l) => l.startsWith('xn--'))) {
          warn = warn || 'Este endereço usa caracteres de outros alfabetos e pode imitar um site conhecido. Confira com atenção antes de digitar senhas.';
        }
      } catch {}
    }
    let blocked = 0; try { blocked = blockedPerTab.get(wc.id) || 0; } catch {}
    return {
      warn, blocked, adblockOff: !!settings.adblockAllow[hostOf(url)], blockedPopups: (t.blockedPopups || []).length,
      id: t.id, title: t.title, url, display, favicon: t.favicon, loading: t.loading,
      canBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
      canForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(),
      bookmarked: bookmarks.some((b) => b.url === url),
      secure: warn ? 'insecure' : url.startsWith('https:') ? 'secure' : url.startsWith('http:') ? 'insecure' : url.startsWith('aurora:') ? 'internal' : 'file',
      audible: !wc.isDestroyed() && wc.isCurrentlyAudible(), muted: !wc.isDestroyed() && wc.isAudioMuted(),
      zoom: wc.isDestroyed() ? 1 : wc.getZoomFactor(),
      crashed: !!t.crashed, sleeping: !!t.sleeping,
    };
  }
  sendTabSoon(t) {
    if (t._sendTimer) return;
    t._sendTimer = setTimeout(() => { t._sendTimer = null; if (tabById.has(t.id)) this.sendTab(t); }, 300);
  }
  sendTabs() { this.send('tabs', { tabs: this.tabs.map((t) => this.tabInfo(t)), activeId: this.activeId }); }
  sendTab(t) {
    this.send('tab', this.tabInfo(t));
    if (t.id === this.activeId && !this.win.isDestroyed()) this.win.setTitle(`${t.title || 'Nova aba'} — Aurora${this.isPrivate ? ' (Privado)' : ''}`);
  }

  createView() {
    const view = new WebContentsView({
      webPreferences: {
        session: this.ses, preload: path.join(__dirname, 'preload-internal.js'),
        contextIsolation: true, sandbox: true, spellcheck: true, nodeIntegrationInSubFrames: true,
        // after the first alert, offer "stop this page from showing more dialogs" (anti alert-loop scams)
        safeDialogs: true, safeDialogsMessage: 'Impedir que esta página mostre mais caixas de diálogo',
      },
    });
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#16171d' : '#ffffff');
    return view;
  }

  newTab(url, { background = false, index = null, opener = null } = {}) {
    const view = this.createView();
    const t = { id: ++tabSeq, view, title: 'Nova aba', url: '', favicon: '', loading: true, win: this, lastActive: Date.now(), openerId: opener ? opener.id : null };
    tabById.set(t.id, t);
    let pos = index;
    if (pos == null && opener && this.tabs.includes(opener)) {
      // links opened from the same tab line up after it, in the order they were opened
      pos = this.tabs.indexOf(opener) + 1;
      while (pos < this.tabs.length && this.tabs[pos].openerId === opener.id) pos++;
    }
    if (pos == null) {
      const ai = this.tabs.findIndex((x) => x.id === this.activeId);
      pos = ai >= 0 && url ? ai + 1 : this.tabs.length;
    }
    this.tabs.splice(pos, 0, t);
    this.wireTab(t);
    const target = toUrl(url) || settings.homepage || HOME;
    t.url = target;
    view.webContents.loadURL(target).catch(() => {});
    if (!background || !this.activeId) this.activate(t.id); else this.sendTabs();
    return t;
  }

  alive(t) { const wc = t.view && t.view.webContents; return !!wc && !wc.isDestroyed(); }

  activate(id) {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return;
    if (!this.alive(t)) {
      // the page is gone (closed or lost): finish closing it, or bring it back if it should still exist
      if (t.closing) { this.finalizeClose(t); return; }
      t.sleepState = { url: t.url }; t.view = this.createView(); t.sleeping = true; this.wireTab(t);
    }
    const prev = this.active;
    if (prev && prev !== t) { prev.lastActive = Date.now(); try { this.win.contentView.removeChildView(prev.view); } catch {} }
    if (prev !== t) for (const x of this.tabs) if (x.openerId && x !== t) x.openerId = null; // like Chrome: switching tabs resets link order
    if (t.sleeping) this.wake(t);
    t.lastActive = Date.now();
    this.activeId = id;
    this.win.contentView.addChildView(t.view);
    this.win.contentView.addChildView(this.ui); // keep chrome on top
    this.layout();
    this.sendTabs();
    this.sendTab(t);
    const u = t.view.webContents.getURL() || t.url;
    if (!u || u.startsWith(HOME)) this.focusAddress();
    else t.view.webContents.focus();
  }

  closeTab(id) {
    const t = this.tabs.find((x) => x.id === id);
    if (!t) return;
    if (!this.alive(t) || t.crashed || t.sleeping || !t.view.webContents.getURL()) { this.finalizeClose(t); return; }
    const wc = t.view.webContents;
    if (t.closing) return;
    t.closing = true;
    t.closedUrl = tabUrl(t);
    // safety net: a frozen page must not keep the tab open forever
    t.closeTimer = setTimeout(() => { if (!wc.isDestroyed() && t.closing && !t.prompting) { try { wc.close(); } catch {} } }, 5000);
    try { wc.close({ waitForBeforeUnload: true }); } catch { this.finalizeClose(t); }
  }

  finalizeClose(t) {
    clearTimeout(t.closeTimer);
    const i = this.tabs.indexOf(t);
    if (i < 0) return;
    const url = t.closedUrl || tabUrl(t);
    if (/^https?:/.test(url) && !this.closingWindow) { this.closedTabs.push(url); if (this.closedTabs.length > 25) this.closedTabs.shift(); }
    this.tabs.splice(i, 1);
    tabById.delete(t.id);
    try { blockedPerTab.delete(t.wc.id); } catch {}
    if (this.disposed) return;
    if (this.activeId === t.id) {
      try { this.win.contentView.removeChildView(t.view); } catch {}
      this.activeId = null;
      if (this.tabs.length) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)].id);
    }
    try { if (this.alive(t)) t.view.webContents.close(); } catch {}
    if (!this.tabs.length) { this.forceClose = true; this.win.close(); return; }
    this.sendTabs();
  }

  sleepTab(t) {
    // frees the page's memory; the tab keeps its title, icon and back/forward history
    const owc = t.view.webContents;
    let entries = null; let index = 0;
    try { entries = owc.navigationHistory.getAllEntries(); index = owc.navigationHistory.getActiveIndex(); } catch {}
    t.sleepState = { url: tabUrl(t), entries, index };
    t.url = t.sleepState.url;
    try { blockedPerTab.delete(owc.id); } catch {}
    t.view = this.createView();
    t.sleeping = true;
    this.wireTab(t);
    try { owc.close(); } catch {}
    this.sendTab(t);
  }

  wake(t) {
    if (!t.sleeping) return;
    t.sleeping = false;
    const st = t.sleepState || { url: t.url }; t.sleepState = null;
    const wc = t.view.webContents;
    const fallback = () => wc.loadURL(st.url || settings.homepage || HOME).catch(() => {});
    if (st.entries && st.entries.length && wc.navigationHistory.restore) {
      wc.navigationHistory.restore({ index: Math.min(st.index, st.entries.length - 1), entries: st.entries }).catch(fallback);
    } else fallback();
  }

  wireTab(t) {
    const wc = t.view.webContents;
    t.wc = wc;
    pageContents.add(wc);
    this.hookKeys(wc);
    wc.once('destroyed', () => { if (tabById.has(t.id) && t.wc === wc) this.finalizeClose(t); });
    wc.on('will-prevent-unload', (e) => {
      // the page has unsaved changes and asked to confirm leaving
      t.prompting = true;
      if (t.id !== this.activeId && this.tabs.includes(t)) this.activate(t.id);
      const r = dialog.showMessageBoxSync(this.win, {
        type: 'question', title: 'Sair do site?', message: 'Sair do site?', detail: 'As alterações que você fez podem não ser salvas.',
        buttons: ['Sair', 'Ficar'], defaultId: 1, cancelId: 1, noLink: true,
      });
      t.prompting = false;
      if (r === 0) e.preventDefault();
      else { t.closing = false; t.closedUrl = null; clearTimeout(t.closeTimer); this.closingWindow = false; }
    });
    wc.on('page-title-updated', (e, title) => {
      t.title = title; this.sendTab(t);
      if (!this.isPrivate) updateHistoryMeta(wc.getURL(), { title });
    });
    wc.on('page-favicon-updated', (e, favs) => {
      t.favicon = favs[0] || ''; this.sendTab(t);
      if (!this.isPrivate) updateHistoryMeta(wc.getURL(), { favicon: t.favicon });
      const b = bookmarks.find((x) => x.url === wc.getURL());
      if (b && b.favicon !== t.favicon) { b.favicon = t.favicon; save('bookmarks', bookmarks); broadcastBookmarks(); }
    });
    wc.on('did-start-loading', () => { t.loading = true; t.crashed = false; this.sendTab(t); });
    wc.on('did-stop-loading', () => { t.loading = false; this.sendTab(t); });
    wc.on('did-finish-load', () => { if (t.id === this.activeId && wc.getURL().startsWith(HOME)) this.focusAddress(); });
    wc.on('did-navigate', (e, url) => {
      blockedPerTab.delete(wc.id); t.blockedPopups = [];
      t.url = url; t.favicon = url.startsWith('aurora:') ? '' : t.favicon;
      if (!this.isPrivate) addHistory(url, wc.getTitle(), '');
      const z = settings.zoom[hostOf(url)];
      if (isWebUrl(url) && Math.abs(wc.getZoomFactor() - (z || 1)) > 0.001) wc.setZoomFactor(z || 1);
      this.sendTab(t);
    });
    wc.on('did-navigate-in-page', (e, url, isMain) => {
      if (!isMain) return;
      const prev = t.url; t.url = url;
      // sites like YouTube/Gmail change pages without reloading: record those visits too
      if (!this.isPrivate && stripHash(prev) !== stripHash(url)) addHistory(url, wc.getTitle(), t.favicon);
      this.sendTab(t);
    });
    wc.on('audio-state-changed', () => this.sendTab(t));
    wc.on('did-fail-load', (e, code, desc, url, isMain) => {
      if (!isMain || code === -3 || url.startsWith('aurora://')) return;
      const orig = upgradedUrls.get(url);
      if (orig && code !== -3) {
        // the site does not support HTTPS: ask before falling back to plain http
        const q = new URLSearchParams({ u: orig, c: 'https', d: desc });
        wc.loadURL(`aurora://error/?${q}`).catch(() => {});
        return;
      }
      const q = new URLSearchParams({ u: url, c: String(code), d: desc });
      wc.loadURL(`aurora://error/?${q}`).catch(() => {});
    });
    wc.on('render-process-gone', (e, details) => {
      if (details.reason === 'clean-exit') return;
      t.crashed = true; t.loading = false; this.sendTab(t);
      const q = new URLSearchParams({ u: t.url, c: 'crash', d: details.reason });
      setTimeout(() => { if (!wc.isDestroyed()) wc.loadURL(`aurora://error/?${q}`).catch(() => {}); }, 50);
    });
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      const fromInternal = wc.getURL().startsWith('aurora://') && trusted.has(wc);
      if (!fromInternal && !isOpenableByPage(url)) return { action: 'deny' };
      // pop-up blocker: pages may only open windows right after a click or key press
      const origin = (() => { try { return new URL(wc.getURL()).origin; } catch { return ''; } })();
      const recent = Date.now() - (lastUserInput.get(wc) || 0) < 2500;
      if (!recent && !fromInternal && !settings.popupAllow[origin]) {
        t.blockedPopups = t.blockedPopups || [];
        if (t.blockedPopups.length < 20) t.blockedPopups.push(url || 'about:blank');
        this.sendTab(t);
        return { action: 'deny' };
      }
      if (disposition === 'new-window' && features) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true, icon: fs.existsSync(ICON) ? ICON : undefined, minWidth: 260, minHeight: 200,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: undefined, safeDialogs: true, safeDialogsMessage: 'Impedir que esta página mostre mais caixas de diálogo' },
          },
        };
      }
      this.newTab(url, { background: disposition === 'background-tab', opener: t });
      return { action: 'deny' };
    });
    wc.on('did-create-window', (bw) => this.hookPopup(bw, wc.getURL()));
    wc.on('enter-html-full-screen', () => {
      this.htmlFull = true; this.win.setFullScreen(true); this.layout();
      let h = hostOf(wc.getURL()) || 'Esta página';
      this.showNotice(`${h} está em tela cheia — pressione Esc para sair`, 4000);
    });
    wc.on('leave-html-full-screen', () => { this.htmlFull = false; this.win.setFullScreen(false); this.layout(); this.hideNotice(); });
    wc.on('found-in-page', (e, r) => { if (r.finalUpdate) this.send('find-result', { active: r.activeMatchOrdinal, total: r.matches }); });
    wc.on('zoom-changed', (e, dir) => this.zoom(dir === 'in' ? 1 : -1, t));
    wc.on('context-menu', (e, p) => this.contextMenu(t, p));
  }

  zoom(step, t = this.active) {
    if (!t) return;
    const wc = t.view.webContents;
    const levels = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
    const cur = wc.getZoomFactor();
    let next = 1;
    if (step > 0) next = levels.find((l) => l > cur + 0.001) || 5;
    else if (step < 0) next = [...levels].reverse().find((l) => l < cur - 0.001) || 0.25;
    wc.setZoomFactor(next);
    const host = hostOf(tabUrl(t));
    if (host && isWebUrl(tabUrl(t)) && !this.isPrivate) {
      if (Math.abs(next - 1) < 0.001) delete settings.zoom[host]; else settings.zoom[host] = next;
      save('settings', settings);
    }
    // the zoom applies to every tab of that site; refresh their indicators
    for (const w of BrowserWin.all) for (const x of w.tabs) if (x === t || (host && hostOf(tabUrl(x)) === host)) w.sendTab(x);
  }

  navigate(text) {
    const t = this.active; const url = toUrl(text);
    if (!t || !url) return;
    t.view.webContents.loadURL(url).catch(() => {});
    t.view.webContents.focus();
  }

  toggleBookmark(t = this.active) {
    if (!t) return;
    const wc = t.view.webContents; const url = wc.getURL();
    if (!/^(https?|file):/.test(url)) return;
    const i = bookmarks.findIndex((b) => b.url === url);
    if (i >= 0) bookmarks.splice(i, 1);
    else bookmarks.push({ id: Date.now().toString(36), url, title: wc.getTitle() || url, favicon: t.favicon || '', created: Date.now() });
    save('bookmarks', bookmarks); broadcastBookmarks();
    for (const w of BrowserWin.all) for (const x of w.tabs) if (x.view.webContents.getURL() === url) w.sendTab(x);
  }

  openInternal(page) {
    const url = `aurora://${page}`;
    const host = page.split(/[#/?]/)[0];
    const existing = this.tabs.find((t) => { try { const u = new URL(tabUrl(t)); return u.protocol === 'aurora:' && u.hostname === host; } catch { return false; } });
    if (existing) { this.activate(existing.id); existing.view.webContents.loadURL(url).catch(() => {}); return; }
    const a = this.active;
    if (a && a.view.webContents.getURL().startsWith(HOME)) a.view.webContents.loadURL(url);
    else this.newTab(url);
  }

  showFind() { this.ui.webContents.focus(); this.send('show-find'); }
  focusAddress() { this.ui.webContents.focus(); this.send('focus-address'); }

  contextMenu(t, p) {
    const wc = t.view.webContents;
    const items = [];
    const linkOk = p.linkURL && (isWebUrl(p.linkURL) || (p.linkURL.startsWith('file:') && wc.getURL().startsWith('file:')));
    if (p.linkURL && !linkOk) {
      items.push({ label: 'Copiar endereço do link', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    }
    if (linkOk) {
      items.push(
        { label: 'Abrir link em nova aba', click: () => this.newTab(p.linkURL, { background: true, opener: t }) },
        { label: 'Abrir link em nova janela', click: () => new BrowserWin({ isPrivate: this.isPrivate, urls: [p.linkURL] }) },
        { label: 'Abrir link em janela privada', click: () => new BrowserWin({ isPrivate: true, urls: [p.linkURL] }) },
        { label: 'Copiar endereço do link', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && isWebUrl(p.srcURL)) {
      items.push(
        { label: 'Abrir imagem em nova aba', click: () => this.newTab(p.srcURL, { background: true }) },
        { label: 'Salvar imagem como…', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Copiar imagem', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copiar endereço da imagem', click: () => clipboard.writeText(p.srcURL) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      if (p.misspelledWord && p.dictionarySuggestions.length) {
        for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
        items.push({ label: 'Adicionar ao dicionário', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
      }
      items.push(
        { label: 'Desfazer', role: 'undo', enabled: p.editFlags.canUndo },
        { label: 'Refazer', role: 'redo', enabled: p.editFlags.canRedo },
        { type: 'separator' },
        { label: 'Recortar', role: 'cut', enabled: p.editFlags.canCut },
        { label: 'Copiar', role: 'copy', enabled: p.editFlags.canCopy },
        { label: 'Colar', role: 'paste', enabled: p.editFlags.canPaste },
        { label: 'Selecionar tudo', role: 'selectAll' },
        { type: 'separator' },
      );
    } else if (p.selectionText && p.selectionText.trim()) {
      const sel = p.selectionText.trim();
      const short = sel.length > 30 ? sel.slice(0, 30) + '…' : sel;
      const isLink = isWebUrl(sel) && !/\s/.test(sel);
      items.push(
        { label: 'Copiar', role: 'copy' },
        isLink
          ? { label: `Ir para ${short}`, click: () => this.newTab(sel, { opener: t }) }
          : { label: `Pesquisar "${short}"`, click: () => this.newTab(searchUrl(sel), { opener: t }) },
        { type: 'separator' },
      );
    }
    if (!p.linkURL && !p.isEditable && !(p.selectionText || '').trim() && p.mediaType === 'none') {
      items.push(
        { label: 'Voltar', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Avançar', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Recarregar', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Salvar página como…', click: () => this.savePage(t) },
        { label: 'Imprimir…', click: () => wc.print() },
        { label: 'Ver código-fonte', click: () => this.newTab('view-source:' + wc.getURL()) },
        { type: 'separator' },
      );
    }
    items.push({ label: 'Inspecionar', click: () => { wc.inspectElement(p.x, p.y); } });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  hookPopup(bw, openerUrl) {
    const pwc = bw.webContents;
    popupContents.add(pwc);
    bw.setMenuBarVisibility(false);
    const parent = this;
    // Pop-ups have no address bar, so the real site is always shown in the title bar
    const refresh = () => {
      if (bw.isDestroyed()) return;
      const url = pwc.getURL();
      let label = 'Pop-up';
      try {
        const u = new URL(url);
        label = u.protocol === 'https:' ? `🔒 ${u.host}` : u.protocol === 'http:' ? `⚠ Não seguro: ${u.host}` : url.slice(0, 60);
      } catch {}
      try {
        // a blank pop-up is controlled by the page that opened it: show that site
        if (!url || url === 'about:blank') label = `Pop-up de ${new URL(openerUrl).host}`;
      } catch {}
      const title = pwc.getTitle();
      bw.setTitle(title && title !== url ? `${label} — ${title.slice(0, 80)}` : label);
    };
    pwc.on('page-title-updated', (e) => { e.preventDefault(); refresh(); });
    pwc.on('did-navigate', refresh);
    pwc.on('did-navigate-in-page', refresh);
    pwc.setWindowOpenHandler(({ url }) => {
      // a pop-up may only open tabs right after a click, like any page
      if (isWebUrl(url) && BrowserWin.all.has(parent) && recentInput(pwc, 2500)) parent.newTab(url);
      return { action: 'deny' };
    });
    // pop-ups can't hide off-screen or shrink to a dot
    const keepVisible = () => {
      if (bw.isDestroyed() || bw.isFullScreen()) return;
      const b = bw.getBounds();
      const wa = screen.getDisplayMatching(b).workArea;
      const w = Math.min(Math.max(b.width, 300), wa.width), h = Math.min(Math.max(b.height, 200), wa.height);
      const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - w), y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - h);
      if (x !== b.x || y !== b.y || w !== b.width || h !== b.height) bw.setBounds({ x, y, width: w, height: h });
    };
    keepVisible();
    bw.on('move', keepVisible); bw.on('resize', keepVisible);
    pwc.on('before-input-event', (e, i) => {
      const mod = process.platform === 'darwin' ? i.meta : i.control;
      if (i.type === 'keyDown' && mod && i.key.toLowerCase() === 'w') { e.preventDefault(); bw.close(); }
    });
    refresh();
  }

  showNotice(text, ms = 3500) {
    if (!this.notice) {
      this.notice = new WebContentsView({ webPreferences: { session: getUiSession(), sandbox: true, contextIsolation: true } });
      this.notice.setBackgroundColor('#00000000');
      uiContents.add(this.notice.webContents);
      this.hookKeys(this.notice.webContents);
      this.notice.webContents.on('focus', () => { const a = this.active; if (a) a.view.webContents.focus(); });
    }
    const n = this.notice;
    n.webContents.loadURL(uiUrl('notice.html', { t: text }));
    const [w] = this.win.getContentSize();
    const width = Math.min(560, w - 40);
    n.setBounds({ x: Math.round((w - width) / 2), y: 18, width, height: 56 });
    this.win.contentView.addChildView(n);
    const a = this.active; if (a) setTimeout(() => { try { a.view.webContents.focus(); } catch {} }, 50);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { try { this.win.contentView.removeChildView(n); } catch {} }, ms);
  }

  hideNotice() { clearTimeout(this.noticeTimer); if (this.notice) { try { this.win.contentView.removeChildView(this.notice); } catch {} } }

  popupMenu(id) {
    const t = this.tabs.find((x) => x.id === id); if (!t) return;
    const list = t.blockedPopups || [];
    let origin = ''; try { origin = new URL(t.view.webContents.getURL()).origin; } catch {}
    Menu.buildFromTemplate([
      { label: `${list.length} pop-up(s) bloqueado(s) nesta página`, enabled: false },
      { type: 'separator' },
      ...list.slice(0, 10).map((u) => ({ label: `Abrir ${u.length > 70 ? u.slice(0, 70) + '…' : u}`, click: () => { if (isWebUrl(u)) this.newTab(u); } })),
      { type: 'separator' },
      { label: `Sempre permitir pop-ups de ${hostOf(origin)}`, enabled: !!origin && !this.isPrivate, click: () => { settings.popupAllow[origin] = true; save('settings', settings); } },
    ]).popup({ window: this.win });
  }

  shieldMenu(id) {
    const t = this.tabs.find((x) => x.id === id); if (!t) return;
    const wc = t.view.webContents; const host = hostOf(wc.getURL());
    const n = blockedPerTab.get(wc.id) || 0;
    const off = !!settings.adblockAllow[host];
    Menu.buildFromTemplate([
      { label: off ? `Bloqueio desativado em ${host}` : `${n} anúncio(s)/rastreador(es) bloqueado(s)`, enabled: false },
      { type: 'separator' },
      { label: off ? `Ativar bloqueio em ${host}` : `Desativar bloqueio em ${host}`, enabled: !!host, click: () => {
        if (off) delete settings.adblockAllow[host]; else settings.adblockAllow[host] = true;
        save('settings', settings); wc.reload();
      } },
      { label: 'Configurações de privacidade', click: () => this.openInternal('settings#privacidade') },
    ]).popup({ window: this.win });
  }

  async savePage(t = this.active) {
    if (!t) return;
    const wc = t.view.webContents;
    const name = (wc.getTitle() || 'pagina').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 100);
    const r = await dialog.showSaveDialog(this.win, {
      defaultPath: path.join(app.getPath('downloads'), `${name}.html`),
      filters: [{ name: 'Página completa', extensions: ['html'] }],
    });
    if (!r.canceled && r.filePath) wc.savePage(r.filePath, 'HTMLComplete').catch(() => {});
  }

  appMenu() {
    const t = this.active;
    const zoomPct = t ? Math.round(t.view.webContents.getZoomFactor() * 100) : 100;
    return Menu.buildFromTemplate([
      { label: 'Nova aba', accelerator: 'CmdOrCtrl+T', click: () => this.newTab() },
      { label: 'Nova janela', accelerator: 'CmdOrCtrl+N', click: () => new BrowserWin() },
      { label: 'Nova janela privada', accelerator: 'CmdOrCtrl+Shift+N', click: () => new BrowserWin({ isPrivate: true }) },
      { type: 'separator' },
      { label: 'Histórico', accelerator: 'CmdOrCtrl+H', click: () => this.openInternal('history') },
      { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => this.openInternal('downloads') },
      { label: 'Favoritos', accelerator: 'CmdOrCtrl+Shift+O', click: () => this.openInternal('bookmarks') },
      { label: 'Reabrir aba fechada', accelerator: 'CmdOrCtrl+Shift+T', enabled: this.closedTabs.length > 0, click: () => this.reopen() },
      { type: 'separator' },
      { label: `Zoom (${zoomPct}%)`, submenu: [
        { label: 'Aumentar', accelerator: 'CmdOrCtrl+=', click: () => this.zoom(1) },
        { label: 'Diminuir', accelerator: 'CmdOrCtrl+-', click: () => this.zoom(-1) },
        { label: 'Tamanho original', accelerator: 'CmdOrCtrl+0', click: () => this.zoom(0) },
      ] },
      { label: 'Tela cheia', accelerator: 'F11', click: () => this.win.setFullScreen(!this.win.isFullScreen()) },
      { type: 'separator' },
      { label: 'Localizar na página…', accelerator: 'CmdOrCtrl+F', click: () => this.showFind() },
      { label: 'Imprimir…', accelerator: 'CmdOrCtrl+P', click: () => t && t.view.webContents.print() },
      { label: 'Salvar página como…', accelerator: 'CmdOrCtrl+S', click: () => this.savePage() },
      { label: settings.showBookmarksBar ? 'Ocultar barra de favoritos' : 'Mostrar barra de favoritos', accelerator: 'CmdOrCtrl+Shift+B', click: () => toggleBookmarksBar() },
      { label: 'Ferramentas do desenvolvedor', accelerator: 'F12', click: () => t && t.view.webContents.toggleDevTools() },
      { type: 'separator' },
      { label: 'Configurações', click: () => this.openInternal('settings') },
      { label: 'Sobre o Aurora', click: () => this.openInternal('settings#sobre') },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]);
  }

  reopen() {
    const u = this.closedTabs.pop();
    if (u) this.newTab(u);
  }

  runShortcut(k) {
    const t = this.active; const twc = t && t.view.webContents;
    if (k === 's') this.savePage();
    else if (k === 'f') this.showFind();
    else if (k === 'h') this.openInternal('history');
    else if (k === 'd') this.toggleBookmark();
    else if (k === 'p') { if (twc) twc.print(); }
    else if (k === 'j') this.openInternal('downloads');
    else if (k === 'u') { if (twc) this.newTab('view-source:' + tabUrl(t), { opener: t }); }
  }

  siteMenu(id) {
    const t = this.tabs.find((x) => x.id === id); if (!t) return;
    const wc = t.view.webContents; const url = tabUrl(t);
    let u; try { u = new URL(url); } catch { return; }
    const items = [];
    if (u.protocol === 'aurora:') {
      items.push({ label: 'Página interna do Aurora', enabled: false });
      Menu.buildFromTemplate(items).popup({ window: this.win }); return;
    }
    const info = this.tabInfo(t);
    if (u.protocol === 'https:') items.push({ label: '🔒 A conexão é segura', enabled: false });
    else if (u.protocol === 'http:') items.push({ label: '⚠ A conexão não é segura — não digite senhas nem cartões', enabled: false });
    else items.push({ label: 'Arquivo do seu computador', enabled: false });
    if (info.warn) items.push({ label: '⚠ ' + info.warn.slice(0, 110), enabled: false });
    const c = certs.get(u.hostname);
    if (u.protocol === 'https:' && c) {
      const exp = c.validExpiry ? new Date(c.validExpiry * 1000).toLocaleDateString('pt-BR') : '?';
      items.push(
        { label: `Certificado de: ${c.subjectName || u.hostname}`, enabled: false },
        { label: `Emitido por: ${c.issuerName || '?'}`, enabled: false },
        { label: `Válido até: ${exp}`, enabled: false },
      );
    }
    if (!isWebUrl(url)) { Menu.buildFromTemplate(items).popup({ window: this.win }); return; }
    const origin = u.origin; const host = u.hostname;
    const permItem = (perm, label) => {
      const key = `${origin}|${perm}`;
      const cur = key in settings.permissions ? (settings.permissions[key] ? 'allow' : 'block') : 'ask';
      const set = (v) => {
        if (v === 'ask') delete settings.permissions[key]; else settings.permissions[key] = v === 'allow';
        const g = sessionGrants.get(this.ses); if (g) g.delete(key);
        save('settings', settings);
      };
      const names = { ask: 'Perguntar', allow: 'Permitir', block: 'Bloquear' };
      return { label: `${label}: ${names[cur]}`, submenu: ['ask', 'allow', 'block'].map((v) => ({ label: names[v], type: 'radio', checked: cur === v, click: () => set(v) })) };
    };
    items.push(
      { type: 'separator' },
      { label: `Permissões de ${host}`, enabled: false },
      permItem('media', 'Câmera e microfone'),
      permItem('geolocation', 'Localização'),
      permItem('notifications', 'Notificações'),
      permItem('clipboard-read', 'Área de transferência'),
      { label: `Pop-ups: ${settings.popupAllow[origin] ? 'Permitir' : 'Bloquear'}`, submenu: [
        { label: 'Permitir', type: 'radio', checked: !!settings.popupAllow[origin], click: () => { settings.popupAllow[origin] = true; save('settings', settings); } },
        { label: 'Bloquear', type: 'radio', checked: !settings.popupAllow[origin], click: () => { delete settings.popupAllow[origin]; save('settings', settings); } },
      ] },
      { label: 'Bloquear anúncios e rastreadores', type: 'checkbox', checked: !settings.adblockAllow[host], click: () => {
        if (settings.adblockAllow[host]) delete settings.adblockAllow[host]; else settings.adblockAllow[host] = true;
        save('settings', settings); wc.reload();
      } },
      { type: 'separator' },
      { label: 'Redefinir permissões deste site', click: () => {
        for (const k of Object.keys(settings.permissions)) if (k.startsWith(origin + '|')) delete settings.permissions[k];
        delete settings.popupAllow[origin]; delete settings.adblockAllow[host];
        const g = sessionGrants.get(this.ses); if (g) for (const k of [...g]) if (k.startsWith(origin + '|')) g.delete(k);
        save('settings', settings);
      } },
      { label: `Apagar cookies e dados de ${host}`, click: async () => {
        const r = await dialog.showMessageBox(this.win, { type: 'warning', buttons: ['Apagar', 'Cancelar'], defaultId: 1, cancelId: 1, noLink: true,
          message: `Apagar cookies e dados de ${host}?`, detail: 'Você vai sair da sua conta neste site.' });
        if (r.response !== 0) return;
        await this.ses.clearStorageData({ origin }).catch(() => {});
        const cookies = await this.ses.cookies.get({ domain: host.replace(/^www\./, '') }).catch(() => []);
        for (const ck of cookies) {
          const cu = `${ck.secure ? 'https' : 'http'}://${ck.domain.replace(/^\./, '')}${ck.path}`;
          await this.ses.cookies.remove(cu, ck.name).catch(() => {});
        }
        wc.reload();
      } },
    );
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  hookKeys(wc) {
    wc.on('before-input-event', (e, i) => {
      if (i.type !== 'keyDown') return;
      const mod = process.platform === 'darwin' ? i.meta : i.control;
      const k = i.key.length === 1 ? i.key.toLowerCase() : i.key;
      const t = this.active; const twc = t && t.view.webContents;
      if (mod && !i.alt && !i.shift && OVERRIDABLE_KEYS.has(k) && pageContents.has(wc)) {
        // web apps (Docs, Photopea…) may use these shortcuts themselves: the page gets the key
        // first and the browser acts only if the page did not handle it (see preload-internal.js)
        const tab = this.tabs.find((x) => x.view.webContents === wc);
        if (tab) {
          clearTimeout(tab.keyTimer); tab.pendingKey = k;
          tab.keyTimer = setTimeout(() => { if (tab.pendingKey === k) { tab.pendingKey = null; this.runShortcut(k); } }, 350);
        }
        return;
      }
      let handled = true;
      if (mod && i.shift && k === 't') this.reopen();
      else if (mod && i.shift && k === 'n') new BrowserWin({ isPrivate: true });
      else if (mod && i.shift && k === 'b') toggleBookmarksBar();
      else if (mod && i.shift && k === 'o') this.openInternal('bookmarks');
      else if (mod && i.shift && k === 'Delete') this.openInternal('settings#limpar');
      else if (mod && (k === 'Tab' || k === 'PageDown' || k === 'PageUp')) {
        const dir = (k === 'PageUp' || (k === 'Tab' && i.shift)) ? -1 : 1;
        const idx = this.tabs.findIndex((x) => x.id === this.activeId);
        const n = this.tabs[(idx + dir + this.tabs.length) % this.tabs.length];
        if (n) this.activate(n.id);
      }
      else if (mod && !i.shift && k === 't') this.newTab();
      else if (mod && !i.shift && k === 'n') new BrowserWin({ isPrivate: this.isPrivate });
      else if (mod && k === 'w' || (mod && k === 'F4')) { if (t) this.closeTab(t.id); }
      else if ((mod && k === 'l') || (i.alt && k === 'd') || k === 'F6') this.focusAddress();
      else if ((mod && k === 'r') || k === 'F5') { if (twc) (i.shift || mod && k === 'F5' ? twc.reloadIgnoringCache() : twc.reload()); }
      else if (mod && k === 'f') this.showFind();
      else if (mod && k === 'd') this.toggleBookmark();
      else if (mod && k === 'h') this.openInternal('history');
      else if (mod && k === 'j') this.openInternal('downloads');
      else if (mod && k === 'p') { if (twc) twc.print(); }
      else if (mod && k === 's') this.savePage();
      else if (mod && k === 'u') { if (twc) this.newTab('view-source:' + twc.getURL()); }
      else if (mod && (k === '=' || k === '+')) this.zoom(1);
      else if (mod && k === '-') this.zoom(-1);
      else if (mod && k === '0') this.zoom(0);
      else if (mod && /^[1-9]$/.test(k)) {
        const n = k === '9' ? this.tabs[this.tabs.length - 1] : this.tabs[Number(k) - 1];
        if (n) this.activate(n.id);
      }
      else if (i.alt && k === 'ArrowLeft') { if (twc && twc.navigationHistory.canGoBack()) twc.navigationHistory.goBack(); }
      else if (i.alt && k === 'ArrowRight') { if (twc && twc.navigationHistory.canGoForward()) twc.navigationHistory.goForward(); }
      else if (i.alt && k === 'Home') { if (twc) twc.loadURL(settings.homepage || HOME); }
      else if (k === 'F11') this.win.setFullScreen(!this.win.isFullScreen());
      else if (k === 'F12' || (mod && i.shift && k === 'i')) { if (twc) twc.toggleDevTools(); }
      else if (k === 'Escape' && this.htmlFull && twc) {
        // the browser restores its own UI no matter what the page does
        this.htmlFull = false; this.win.setFullScreen(false); this.layout(); this.hideNotice();
        twc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
      }
      else if (k === 'Escape' && wc !== this.ui.webContents && t && t.loading) twc.stop();
      else handled = false;
      if (handled) e.preventDefault();
    });
  }
}

const OVERRIDABLE_KEYS = new Set(['s', 'f', 'h', 'd', 'p', 'j', 'u']);
ipcMain.on('page:key', (e, key, prevented) => {
  if (typeof key !== 'string' || !OVERRIDABLE_KEYS.has(key)) return;
  const w = BrowserWin.fromWebContents(e.sender); if (!w) return;
  const t = w.tabs.find((x) => x.view.webContents === e.sender);
  if (!t || t.pendingKey !== key) return;
  clearTimeout(t.keyTimer); t.pendingKey = null;
  if (!prevented && t.id === w.activeId) w.runShortcut(key);
});

function publicSettings() {
  return {
    searchEngine: settings.searchEngine, searchEngines: Object.fromEntries(Object.entries(SEARCH).map(([k, v]) => [k, v.name])),
    homepage: settings.homepage, startup: settings.startup, showBookmarksBar: settings.showBookmarksBar,
    theme: settings.theme, askDownloadLocation: settings.askDownloadLocation, blockTrackers: settings.blockTrackers,
    httpsOnly: settings.httpsOnly, gpc: settings.gpc, tabSleep: settings.tabSleep,
  };
}
function broadcastBookmarks() { for (const w of BrowserWin.all) w.send('bookmarks', bookmarks); }
function broadcastSettings() { const s = publicSettings(); for (const w of BrowserWin.all) w.send('settings', s); }
function toggleBookmarksBar() { settings.showBookmarksBar = !settings.showBookmarksBar; save('settings', settings); broadcastSettings(); }

/* ---------------------------------------------------------------- UI IPC */
function winOf(e) { return BrowserWin.fromWebContents(e.sender); }
const uiOn = (ch, fn) => ipcMain.on(ch, (e, ...a) => {
  const w = winOf(e);
  if (!w || e.sender !== w.ui.webContents) return;
  const t = w.active;
  if (t && !w.alive(t) && ch !== 'ui:close-tab' && ch !== 'ui:activate' && ch !== 'ui:new-tab') return; // tab in transition
  try { fn(w, ...a); } catch (err) { console.error(ch, err); }
});
uiOn('ui:new-tab', (w, url) => w.newTab(url || null));
uiOn('ui:close-tab', (w, id) => w.closeTab(id));
uiOn('ui:activate', (w, id) => w.activate(id));
uiOn('ui:navigate', (w, text) => w.navigate(text));
uiOn('ui:open', (w, url, newTab) => { if (newTab) w.newTab(url, { background: true }); else w.navigate(url); });
uiOn('ui:back', (w) => { const t = w.active; if (t && t.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack(); });
uiOn('ui:forward', (w) => { const t = w.active; if (t && t.view.webContents.navigationHistory.canGoForward()) t.view.webContents.navigationHistory.goForward(); });
uiOn('ui:reload', (w, hard) => { const t = w.active; if (t) (hard ? t.view.webContents.reloadIgnoringCache() : t.view.webContents.reload()); });
uiOn('ui:stop', (w) => { const t = w.active; if (t) t.view.webContents.stop(); });
uiOn('ui:home', (w) => { const t = w.active; if (t) t.view.webContents.loadURL(settings.homepage || HOME); });
uiOn('ui:bookmark', (w) => w.toggleBookmark());
uiOn('ui:menu', (w, x, y) => w.appMenu().popup({ window: w.win, x: Math.round(x), y: Math.round(y) }));
uiOn('ui:internal', (w, page) => w.openInternal(page));
uiOn('ui:zoom', (w, step) => w.zoom(step));
uiOn('ui:popup-menu', (w, id) => w.popupMenu(id));
uiOn('ui:shield-menu', (w, id) => w.shieldMenu(id));
uiOn('ui:site-menu', (w, id) => w.siteMenu(id));
uiOn('ui:open-update', (w) => w.openInternal('settings#seguranca'));
uiOn('ui:dismiss-update', () => { updateInfo.dismissed = updateInfo.latest || (updateInfo.supported ? 'age' : 'eol'); broadcastUpdate(); });
uiOn('ui:mute', (w, id) => { const t = w.tabs.find((x) => x.id === id); if (t) { t.view.webContents.setAudioMuted(!t.view.webContents.isAudioMuted()); w.sendTab(t); } });
uiOn('ui:heights', (w, chrome, total) => { w.chromeHeight = Math.max(0, chrome | 0); w.uiHeight = Math.max(w.chromeHeight, total | 0); w.layout(); });
uiOn('ui:focus-page', (w) => { const t = w.active; if (t) t.view.webContents.focus(); });
uiOn('ui:find', (w, text, opts) => { const t = w.active; if (t && text) t.view.webContents.findInPage(text, opts || {}); });
uiOn('ui:stop-find', (w) => { const t = w.active; if (t) t.view.webContents.stopFindInPage('clearSelection'); });
uiOn('ui:move-tab', (w, id, toIndex) => {
  const i = w.tabs.findIndex((x) => x.id === id); if (i < 0) return;
  const [t] = w.tabs.splice(i, 1); w.tabs.splice(Math.max(0, Math.min(toIndex, w.tabs.length)), 0, t); w.sendTabs();
});
uiOn('ui:tab-menu', (w, id) => {
  const t = w.tabs.find((x) => x.id === id); if (!t) return;
  const wc = t.view.webContents;
  Menu.buildFromTemplate([
    { label: 'Nova aba à direita', click: () => w.newTab(null, { index: w.tabs.indexOf(t) + 1 }) },
    { label: 'Recarregar', click: () => wc.reload() },
    { label: 'Duplicar', click: () => w.newTab(wc.getURL(), { index: w.tabs.indexOf(t) + 1 }) },
    { label: wc.isAudioMuted() ? 'Ativar som do site' : 'Silenciar site', click: () => { wc.setAudioMuted(!wc.isAudioMuted()); w.sendTab(t); } },
    { type: 'separator' },
    { label: 'Fechar', click: () => w.closeTab(id) },
    { label: 'Fechar outras abas', click: () => w.tabs.filter((x) => x.id !== id).forEach((x) => w.closeTab(x.id)) },
    { label: 'Fechar abas à direita', click: () => w.tabs.slice(w.tabs.indexOf(t) + 1).forEach((x) => w.closeTab(x.id)) },
    { type: 'separator' },
    { label: 'Reabrir aba fechada', enabled: w.closedTabs.length > 0, click: () => w.reopen() },
  ]).popup({ window: w.win });
});
uiOn('ui:bookmark-menu', (w, bid) => {
  const b = bookmarks.find((x) => x.id === bid); if (!b) return;
  Menu.buildFromTemplate([
    { label: 'Abrir', click: () => w.navigate(b.url) },
    { label: 'Abrir em nova aba', click: () => w.newTab(b.url, { background: true }) },
    { label: 'Abrir em janela privada', click: () => new BrowserWin({ isPrivate: true, urls: [b.url] }) },
    { label: 'Copiar endereço', click: () => clipboard.writeText(b.url) },
    { type: 'separator' },
    { label: 'Remover', click: () => { bookmarks = bookmarks.filter((x) => x.id !== bid); save('bookmarks', bookmarks); broadcastBookmarks(); for (const x of BrowserWin.all) x.sendTabs(); } },
  ]).popup({ window: w.win });
});
ipcMain.handle('ui:suggest', (e, text) => {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return [];
  const out = []; const seen = new Set();
  const push = (x, type) => { if (out.length >= 7 || seen.has(x.url)) return; seen.add(x.url); out.push({ url: x.url, title: x.title, favicon: x.favicon, type }); };
  for (const b of bookmarks) if (b.url.toLowerCase().includes(q) || (b.title || '').toLowerCase().includes(q)) push(b, 'bookmark');
  const counts = new Map();
  for (const h of history.slice(0, 5000)) {
    if (h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)) {
      const c = counts.get(h.url); if (c) c.n++; else counts.set(h.url, { h, n: 1 });
    }
  }
  [...counts.values()].sort((a, b) => b.n - a.n).forEach(({ h }) => push(h, 'history'));
  return out;
});

/* ----------------------------------------------------------- internal IPC */
function isInternal(e) {
  const f = e.senderFrame;
  return !!(f && f.url && f.url.startsWith('aurora://') && f === e.sender.mainFrame && trusted.has(e.sender));
}
const internal = (ch, fn) => ipcMain.handle(ch, (e, ...a) => { if (!isInternal(e)) throw new Error('denied'); return fn(e, ...a); });

internal('aurora:settings', () => ({
  ...publicSettings(), version: app.getVersion(), chrome: process.versions.chrome, electron: process.versions.electron,
  blocked: blockedTotal, platform: process.platform, downloadsDir: app.getPath('downloads'),
  filters: filterCount(), filtersUpdated: settings.filtersUpdated, buildDate: BUILD_DATE, update: updateInfo,
  exceptions: Object.keys(settings.popupAllow).length + Object.keys(settings.adblockAllow).length + Object.keys(settings.permissions).length,
}));
internal('aurora:update-filters', async () => ({ ok: await updateFilterLists(true), filters: filterCount(), filtersUpdated: settings.filtersUpdated }));
internal('aurora:check-update', async () => { await checkEngineUpdate(true); return updateInfo; });
internal('aurora:clear-exceptions', () => { settings.popupAllow = {}; settings.adblockAllow = {}; settings.permissions = {}; httpExempt.clear(); save('settings', settings); return true; });
internal('aurora:allow-http', (e, url) => {
  // only from the HTTPS warning page, only for the page it is warning about
  try {
    const cur = new URL(e.sender.getURL());
    if (cur.hostname !== 'error' || cur.searchParams.get('c') !== 'https' || cur.searchParams.get('u') !== url) return false;
    const u = new URL(url); if (u.protocol !== 'http:') return false;
    httpExempt.add(u.hostname); return true;
  } catch { return false; }
});
internal('aurora:set-settings', (e, patch) => {
  const allowed = ['searchEngine', 'homepage', 'startup', 'showBookmarksBar', 'theme', 'askDownloadLocation', 'blockTrackers', 'httpsOnly', 'gpc', 'tabSleep'];
  if ('homepage' in patch && !(isWebUrl(patch.homepage) || patch.homepage === HOME)) delete patch.homepage;
  for (const k of ['showBookmarksBar', 'askDownloadLocation', 'blockTrackers', 'httpsOnly', 'gpc', 'tabSleep']) if (k in patch) patch[k] = !!patch[k];
  for (const k of allowed) if (k in patch) settings[k] = patch[k];
  if (settings.searchEngine && !SEARCH[settings.searchEngine]) settings.searchEngine = 'google';
  nativeTheme.themeSource = settings.theme;
  save('settings', settings); broadcastSettings();
  return publicSettings();
});
internal('aurora:resolve', (e, text) => toUrl(text));
internal('aurora:bookmarks', () => bookmarks);
internal('aurora:remove-bookmark', (e, id) => { bookmarks = bookmarks.filter((b) => b.id !== id); save('bookmarks', bookmarks); broadcastBookmarks(); for (const w of BrowserWin.all) w.sendTabs(); return bookmarks; });
internal('aurora:edit-bookmark', (e, id, patch) => {
  const b = bookmarks.find((x) => x.id === id);
  if (b) { if (patch.title != null) b.title = String(patch.title); if (patch.url) b.url = toUrl(patch.url) || b.url; save('bookmarks', bookmarks); broadcastBookmarks(); }
  return bookmarks;
});
internal('aurora:move-bookmark', (e, id, toIndex) => {
  const i = bookmarks.findIndex((b) => b.id === id); if (i < 0) return bookmarks;
  const [b] = bookmarks.splice(i, 1); bookmarks.splice(Math.max(0, Math.min(toIndex, bookmarks.length)), 0, b);
  save('bookmarks', bookmarks); broadcastBookmarks(); return bookmarks;
});
internal('aurora:history', (e, query, limit = 300, offset = 0) => {
  const q = String(query || '').toLowerCase();
  const list = q ? history.filter((h) => h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)) : history;
  const o = Math.max(0, offset | 0); const l = Math.min(1000, Math.max(1, limit | 0));
  return { items: list.slice(o, o + l), total: list.length };
});
internal('aurora:remove-history', (e, time, url) => { history = history.filter((h) => !(h.time === time && h.url === url)); save('history', history); return true; });
internal('aurora:is-private', (e) => e.sender.session !== session.defaultSession);
internal('aurora:top-sites', (e) => {
  if (e.sender.session !== session.defaultSession) return [];
  const counts = new Map();
  for (const h of history.slice(0, 3000)) {
    let host; try { host = new URL(h.url).hostname; } catch { continue; }
    const c = counts.get(host) || { n: 0, h }; c.n++; counts.set(host, c);
  }
  const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8)
    .map(([host, c]) => ({ url: new URL(c.h.url).origin, title: host.replace(/^www\./, ''), favicon: c.h.favicon }));
  if (top.length < 4) {
    const defaults = [
      { url: 'https://www.google.com', title: 'google.com' }, { url: 'https://www.youtube.com', title: 'youtube.com' },
      { url: 'https://pt.wikipedia.org', title: 'wikipedia.org' }, { url: 'https://g1.globo.com', title: 'g1.globo.com' },
      { url: 'https://mail.google.com', title: 'gmail' }, { url: 'https://web.whatsapp.com', title: 'whatsapp' },
    ];
    for (const d of defaults) if (top.length < 8 && !top.some((x) => x.title === d.title)) top.push(d);
  }
  return top;
});
internal('aurora:downloads', (e) => {
  // a private window lists only its own downloads; normal windows never show private ones
  const priv = e.sender.session !== session.defaultSession;
  return downloads.filter((d) => !!d.private === priv)
    .map(({ private: p, ...d }) => ({ ...d, exists: d.state === 'completed' && !!d.path && fs.existsSync(d.path) }));
});
internal('aurora:download-action', (e, id, action) => {
  const d = downloads.find((x) => x.id === id); if (!d) return false;
  const item = dlItems.get(id);
  if (action === 'open') shell.openPath(d.path);
  else if (action === 'show') shell.showItemInFolder(d.path);
  else if (action === 'cancel' && item) item.cancel();
  else if (action === 'pause' && item) item.pause();
  else if (action === 'resume' && item && item.canResume()) item.resume();
  else if (action === 'remove') { const i = downloads.indexOf(d); if (i >= 0 && d.state !== 'progressing') downloads.splice(i, 1); }
  else if (action === 'retry' && isWebUrl(d.url)) (d.private ? e.sender.session : session.defaultSession).downloadURL(d.url);
  broadcastDownloads(); save('downloads', persistableDownloads());
  return true;
});
internal('aurora:clear-downloads', (e) => {
  const priv = e.sender.session !== session.defaultSession;
  for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing' && !!downloads[i].private === priv) downloads.splice(i, 1);
  broadcastDownloads(); save('downloads', persistableDownloads()); return true;
});
internal('aurora:open-downloads-folder', () => shell.openPath(app.getPath('downloads')));
internal('aurora:clear-data', async (e, opts) => {
  const since = opts.range ? Date.now() - opts.range : 0;
  if (opts.history) { history = since ? history.filter((h) => h.time < since) : []; save('history', history); }
  const ses = session.defaultSession;
  if (opts.cookies) await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem', 'shadercache'] });
  if (opts.cache) await ses.clearCache();
  if (opts.permissions) { settings.permissions = {}; save('settings', settings); }
  if (opts.downloads) { for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing') downloads.splice(i, 1); save('downloads', persistableDownloads()); }
  if (opts.cookies || opts.cache) await ses.clearAuthCache().catch(() => {});
  return true;
});
function isDefaultBrowser() {
  if (process.platform !== 'win32') return Promise.resolve(app.isDefaultProtocolClient('https'));
  return new Promise((resolve) => {
    require('child_process').execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'],
      { windowsHide: true }, (err, out) => resolve(!err && /AuroraURL/i.test(String(out))));
  });
}
internal('aurora:set-default', async () => {
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Aurora');
  } else {
    app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https');
  }
  return isDefaultBrowser();
});
internal('aurora:is-default', () => isDefaultBrowser());
internal('aurora:import-bookmarks', async (e) => {
  const w = BrowserWin.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(w ? w.win : undefined, { filters: [{ name: 'Favoritos HTML (Chrome, Edge, Firefox)', extensions: ['html', 'htm'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return 0;
  const html = fs.readFileSync(r.filePaths[0], 'utf8');
  const re = /<A\s+[^>]*HREF="([^"]+)"[^>]*>([^<]*)<\/A>/gi; let m; let n = 0;
  const dec = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  while ((m = re.exec(html))) {
    const url = dec(m[1]); if (!/^https?:/.test(url) || bookmarks.some((b) => b.url === url)) continue;
    bookmarks.push({ id: Date.now().toString(36) + n, url, title: dec(m[2]) || url, favicon: '', created: Date.now() }); n++;
  }
  save('bookmarks', bookmarks); broadcastBookmarks();
  return n;
});
internal('aurora:export-bookmarks', async (e) => {
  const w = BrowserWin.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(w ? w.win : undefined, { defaultPath: path.join(app.getPath('documents'), 'favoritos-aurora.html') });
  if (r.canceled || !r.filePath) return false;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const body = bookmarks.map((b) => `    <DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor(b.created / 1000)}">${esc(b.title)}</A>`).join('\n');
  fs.writeFileSync(r.filePath, `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${body}\n</DL><p>\n`);
  return true;
});

/* ------------------------------------------------------- engine update check */
// Aurora cannot patch Chromium by itself; it checks whether a newer, fixed Electron/Chromium
// exists for its line and warns the user to install a newer Aurora build.
const updateInfo = { current: process.versions.electron, latest: null, supported: true, newerMajor: null, checked: 0, dismissed: null, error: null };
function cmpVer(a, b) { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; }
async function checkEngineUpdate(force = false) {
  if (!force && Date.now() - (settings.lastUpdateCheck || 0) < 12 * 3600e3 && updateInfo.checked) return;
  try {
    const r = await net.fetch('https://api.github.com/repos/electron/electron/releases?per_page=100', { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rel = (await r.json()).filter((x) => !x.prerelease && !x.draft && /^v\d+\.\d+\.\d+$/.test(x.tag_name)).map((x) => x.tag_name.slice(1));
    const major = Number(process.versions.electron.split('.')[0]);
    const sameLine = rel.filter((v) => Number(v.split('.')[0]) === major).sort(cmpVer);
    const newestMajor = Math.max(...rel.map((v) => Number(v.split('.')[0])));
    updateInfo.latest = sameLine.length ? sameLine[sameLine.length - 1] : null;
    updateInfo.supported = newestMajor - major < 3; // Electron supports the latest 3 major lines
    updateInfo.newerMajor = newestMajor > major ? newestMajor : null;
    updateInfo.checked = Date.now(); updateInfo.error = null;
    settings.lastUpdateCheck = Date.now(); save('settings', settings);
  } catch (e) { updateInfo.error = e.message; updateInfo.checked = updateInfo.checked || 0; }
  broadcastUpdate();
}
function updateNeeded() {
  const ageDays = (Date.now() - Date.parse(BUILD_DATE)) / 864e5;
  if (updateInfo.latest && cmpVer(updateInfo.latest, updateInfo.current) > 0) return `Saiu uma correção de segurança do motor Chromium (Electron ${updateInfo.latest}). Instale uma versão nova do Aurora.`;
  if (!updateInfo.supported) return 'Esta versão do motor Chromium não recebe mais correções de segurança. Instale uma versão nova do Aurora.';
  if (!updateInfo.checked && ageDays > 60) return 'Esta versão do Aurora tem mais de 2 meses e pode estar sem correções de segurança recentes.';
  return null;
}
function broadcastUpdate() {
  const msg = updateNeeded();
  const key = updateInfo.latest || (updateInfo.supported ? 'age' : 'eol');
  for (const w of BrowserWin.all) w.send('update', msg && updateInfo.dismissed !== key ? { msg } : null);
}

/* ---------------------------------------------------------------- app life */
function urlsFromArgv(argv) {
  const si = argv.indexOf('--single-argument');
  if (si >= 0) argv = [argv[0], argv.slice(si + 1).join(' ')]; // a link can never smuggle in extra switches
  return argv.slice(1).map((a) => {
    if (/^(https?|file):/i.test(a)) return a;
    if (a.startsWith('-') || a === '.' || /\.(js|exe)$/i.test(a)) return null;
    try {
      const p = path.resolve(a);
      if (p !== process.execPath && fs.statSync(p).isFile()) return pathToFileURL(p).toString();
    } catch {}
    return null;
  }).filter(Boolean);
}

// Sites may ask for a personal digital certificate (e-CPF, e-CNPJ, corporate ID). Electron would
// silently send the first installed certificate; Aurora asks which one, if any, to send.
app.on('select-client-certificate', (event, wc, url, list, callback) => {
  event.preventDefault();
  // Chromium passes "host:port" here (no scheme)
  const host = String(url || '').replace(/^[a-z]+:\/\//i, '').split('/')[0];
  if (!list || !list.length) return callback();
  const prev = clientCertChoice.get(host);
  if (prev !== undefined) { const c = list.find((x) => x.fingerprint === prev); return c ? callback(c) : callback(); }
  const shown = list.slice(0, 5);
  const label = (c) => `${(c.subjectName || '?').slice(0, 60)} — emitido por ${(c.issuerName || '?').slice(0, 40)}, válido até ${c.validExpiry ? new Date(c.validExpiry * 1000).toLocaleDateString('pt-BR') : '?'}`;
  const bw = BrowserWin.fromWebContents(wc) || BrowserWin.focused();
  dialog.showMessageBox(bw ? bw.win : undefined, {
    type: 'question', title: 'Certificado digital', noLink: true, cancelId: shown.length, defaultId: shown.length,
    message: `${host || 'Este site'} está pedindo um certificado digital seu.`,
    detail: 'Escolha qual certificado enviar para identificar você neste site, ou “Não enviar”. Só envie se você confia neste site.\n\n' +
      shown.map((c, i) => `${i + 1}. ${label(c)}`).join('\n'),
    buttons: [...shown.map((c, i) => `Enviar o nº ${i + 1}`), 'Não enviar'],
  }).then((r) => {
    const c = shown[r.response];
    clientCertChoice.set(host, c ? c.fingerprint : null);
    if (c) callback(c); else callback();
  });
});

app.on('second-instance', (e, argv) => {
  const urls = urlsFromArgv(argv);
  const w = BrowserWin.focused();
  if (!w) { new BrowserWin({ urls }); return; }
  if (w.win.isMinimized()) w.win.restore();
  w.win.focus();
  if (urls.length) urls.forEach((u) => w.newTab(u)); else new BrowserWin();
});

app.on('open-url', (e, url) => { e.preventDefault(); const w = BrowserWin.focused(); if (w) w.newTab(url); else app.whenReady().then(() => new BrowserWin({ urls: [url] })); });

app.whenReady().then(() => {
  settings = load('settings', DEFAULT_SETTINGS);
  settings.permissions = settings.permissions || {};
  bookmarks = load('bookmarks', []);
  history = load('history', []);
  for (const k of ['popupAllow', 'adblockAllow', 'permissions', 'zoom']) settings[k] = settings[k] && typeof settings[k] === 'object' ? settings[k] : {};
  // downloads list survives restarts
  for (const d of load('downloads', [])) if (d && d.id && d.state !== 'progressing') downloads.push(d);
  dlSeq = downloads.reduce((m, d) => Math.max(m, d.id || 0), 0);
  // dangerous files left undecided when the browser closed are deleted
  try { const q = path.join(app.getPath('userData'), 'quarantine'); for (const f of fs.readdirSync(q)) fs.rmSync(path.join(q, f), { force: true }); } catch {}
  nativeTheme.themeSource = settings.theme || 'system';
  Menu.setApplicationMenu(null);
  loadEngine();

  // Present as a regular Chrome to websites
  app.userAgentFallback = app.userAgentFallback
    .replace(/\s?Electron\/\S+/i, '').replace(/\s?aurora\/\S+/i, '').replace(/\s?Aurora\/\S+/, '');

  nativeTheme.on('updated', () => broadcastSettings());

  let urls = urlsFromArgv(process.argv);
  if (!urls.length && settings.startup === 'restore' && settings.lastSession && settings.lastSession.length) urls = settings.lastSession;
  new BrowserWin({ urls });

  app.on('activate', () => { if (!BrowserWin.all.size) new BrowserWin(); });
  setTimeout(() => { checkEngineUpdate(); updateFilterLists(); }, 20000);
  setInterval(() => { checkEngineUpdate(); updateFilterLists(); }, 6 * 3600e3);
  setInterval(() => saveSession(), 15000); // so "continue where I left off" survives crashes too
  setInterval(() => {
    // put tabs unused for 30 minutes to sleep to free memory
    if (!settings.tabSleep) return;
    const limit = Number(process.env.AURORA_SLEEP_MS) || 30 * 60e3;
    for (const w of BrowserWin.all) for (const t of w.tabs) {
      const wc = t.view.webContents;
      if (t.id === w.activeId || t.sleeping || t.loading || t.closing || !isWebUrl(tabUrl(t))) continue;
      if (Date.now() - (t.lastActive || 0) < limit) continue;
      try { if (wc.isCurrentlyAudible() || wc.isDevToolsOpened() || wc.isBeingCaptured()) continue; } catch { continue; }
      w.sleepTab(t);
    }
  }, Number(process.env.AURORA_SLEEP_MS) ? 3000 : 60e3);
});

app.on('before-quit', () => { if (settings) saveSession(true); });
app.on('will-quit', () => flushAll()); // only once every window is really gone (quitting can still be cancelled before that)
app.on('window-all-closed', () => { flushAll(); if (process.platform !== 'darwin') app.quit(); });
