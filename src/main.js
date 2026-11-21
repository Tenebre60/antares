'use strict';
const {
  app, BaseWindow, WebContentsView, ipcMain, session, protocol, Menu,
  dialog, shell, clipboard, ClipboardItem, nativeTheme, net, screen,
} = require('electron');
// every renderer is sandboxed, even one created by mistake (Chromium refuses this when running as Linux root, e.g. in test containers)
if (!(process.platform === 'linux' && process.getuid && process.getuid() === 0)) app.enableSandbox();
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { FiltersEngine, Request: AbRequest } = require('@ghostery/adblocker');

app.setName('Antares');
// Antares was called Aurora before: keep using the same profile folder so bookmarks, history,
// settings and site logins carry over after the update.
{
  const legacy = path.join(app.getPath('appData'), 'Aurora');
  if (fs.existsSync(legacy) && !app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', legacy);
}
// never show a crash dialog for an unexpected error in the browser process; log it instead
process.on('uncaughtException', (err) => console.error('uncaught', err));
process.on('unhandledRejection', (err) => console.error('unhandled', err));
if (process.platform === 'win32') app.setAppUserModelId('com.aurora.browser');

const UI_DIR = path.join(__dirname, 'ui');
const PAGES_DIR = path.join(__dirname, 'pages');
const ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const HOME = 'antares://newtab';

protocol.registerSchemesAsPrivileged([
  { scheme: 'antares', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'antares-ui', privileges: { standard: true, secure: true } },
]);
// The browser's own interface lives in a separate session that web pages never share.
let uiSession = null;
function getUiSession() {
  if (uiSession) return uiSession;
  uiSession = session.fromPartition('antares-ui-chrome');
  uiSession.protocol.handle('antares-ui', (req) => {
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
const uiUrl = (file, query) => `antares-ui://chrome/${file}?${new URLSearchParams(query)}`;

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
  showBookmarksBar: false,
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
  layoutMode: 'auto', // auto (Órbita/Foco by window state) | orbit | focus
  rightPanel: true,
  spaces: null,
  shortcuts: null,
};
const BUILD_DATE = '2026-11-21';
let settings, bookmarks, history;
let orbits = [], missions = [], readLater = [];
const thumbs = new Map(); // url -> small JPEG data URL of the page (for "Recentes")
const DEFAULT_SPACES = [
  { id: 'pessoal', name: 'Pessoal', color: '#ff7a1a' },
  { id: 'trabalho', name: 'Trabalho', color: '#ffb020' },
  { id: 'estudos', name: 'Estudos', color: '#4fa3ff' },
  { id: 'viagem', name: 'Viagem', color: '#3ad29f' },
];
const DEFAULT_SHORTCUTS = [
  { title: 'YouTube', url: 'https://www.youtube.com' }, { title: 'GitHub', url: 'https://github.com' },
  { title: 'Figma', url: 'https://www.figma.com' }, { title: 'Gmail', url: 'https://mail.google.com' },
  { title: 'Notion', url: 'https://www.notion.so' },
];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const spaceList = () => (Array.isArray(settings.spaces) && settings.spaces.length ? settings.spaces : DEFAULT_SPACES);
function broadcastSpaces() { for (const w of BrowserWin.all) w.sendSpaces(); }
function broadcastCollections() { for (const w of BrowserWin.all) w.send('collections', collectionsSummary()); }
function collectionsSummary() {
  const m = [...missions].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return {
    orbits: orbits.map((o) => ({ id: o.id, name: o.name, space: o.space, count: (o.tabs || []).length })),
    missions: m.map((x) => ({ id: x.id, title: x.title, pages: (x.pages || []).length })),
    readLater: readLater.length,
  };
}

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
  if (/^(https?|file|antares|about|data|view-source):/i.test(t)) return t;
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
const BLOCKED_SCHEMES = new Set(('file javascript vbscript data blob about chrome devtools aurora antares antares-ui jar shell mk its ms-its hcp help res ' +
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
// Internal pages (antares://) get the privileged API only when the browser itself
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
    try { if (init && String(init.url).startsWith('antares://') && trusted.has(wc)) ok = true; } catch {}
    pendingNav.set(wc, { url: String(d.url), ok });
  });
  wc.on('did-redirect-navigation', (d) => { if (d.isMainFrame) { const p = pendingNav.get(wc); if (p) p.ok = false; } });
  wc.on('did-navigate', (e, url) => {
    pageDenied.delete(wc); pageAllowed.delete(wc); autoDownloads.delete(wc);
    const p = pendingNav.get(wc); pendingNav.delete(wc);
    if (String(url).startsWith('antares://') && p && p.ok && p.url.split('#')[0] === String(url).split('#')[0]) trusted.add(wc);
    else trusted.delete(wc);
  });
  wc.on('will-redirect', (d) => { if (String(d.url).startsWith('antares://')) d.preventDefault(); });
  wc.on('will-navigate', (d) => {
    if (uiContents.has(wc)) { d.preventDefault(); return; }
    const target = String(d.url);
    if (target.startsWith('antares://') && !(wc.getURL().startsWith('antares://') && trusted.has(wc))) d.preventDefault();
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

  ses.protocol.handle('antares', serveAntares);
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

  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'antares://*/*'] }, (d, cb) => {
    if (d.url.startsWith('antares:')) {
      // internal pages answer only to browser navigations and to other internal pages;
      // websites can't load them (no detecting Antares, no embedding)
      if (d.resourceType === 'mainFrame') return cb({});
      let frameUrl = ''; try { frameUrl = d.frame ? d.frame.url : ''; } catch {}
      const from = frameUrl || d.referrer || '';
      return cb({ cancel: !from.startsWith('antares://') });
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
async function serveAntares(req) {
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
  const urls = wins.flatMap((w) => w.tabs.map((t) => ({ url: tabUrl(t), space: t.spaceId })))
    .filter((x) => /^https?:/.test(x.url)).slice(0, 150);
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

  /* ---------- spaces (each window shows the tabs of one Space at a time) */
  spaceTabs(id = this.spaceId) { return this.tabs.filter((t) => t.spaceId === id); }
  sendSpaces() {
    const counts = {};
    for (const t of this.tabs) counts[t.spaceId] = (counts[t.spaceId] || 0) + 1;
    this.send('spaces', { spaces: this.isPrivate ? [{ id: 'private', name: 'Privado', color: '#a98bff' }] : spaceList(), current: this.spaceId, counts });
  }
  switchSpace(id, { focusTab = null } = {}) {
    if (this.isPrivate) return;
    if (!spaceList().some((x) => x.id === id)) return;
    if (id === this.spaceId && !focusTab) return;
    if (this.activeId) this.lastActiveBySpace[this.spaceId] = this.activeId;
    if (this.split) this.exitSplit(this.activeId, { quiet: true });
    for (const t of this.tabs) { try { this.win.contentView.removeChildView(t.view); } catch {} }
    this.activeId = null;
    this.spaceId = id;
    const inSpace = this.spaceTabs(id);
    const target = focusTab || inSpace.find((t) => t.id === this.lastActiveBySpace[id]) || inSpace[inSpace.length - 1];
    if (target) this.activate(target.id); else this.newTab(null);
    this.sendSpaces();
  }
  moveTabToSpace(t, id) {
    if (!t || t.spaceId === id || !spaceList().some((x) => x.id === id)) return;
    if (this.split && this.split.includes(t.id)) this.removeFromSplit(t.id);
    const wasActive = t.id === this.activeId;
    if (wasActive) {
      const rest = this.spaceTabs().filter((x) => x !== t);
      try { this.win.contentView.removeChildView(t.view); } catch {}
      this.activeId = null;
      t.spaceId = id;
      if (rest.length) this.activate(rest[rest.length - 1].id); else this.newTab(null);
    } else t.spaceId = id;
    this.sendTabs(); this.sendSpaces();
  }

  /* ---------- split view: up to 4 pages side by side */
  splitRects() {
    const r = this.content; const ids = this.split || [];
    const n = ids.length; const gap = 10; const head = 30;
    const cells = [];
    if (n === 4) {
      const w = (r.width - gap) / 2, h = (r.height - gap) / 2;
      for (let i = 0; i < 4; i++) cells.push({ x: r.x + (i % 2) * (w + gap), y: r.y + Math.floor(i / 2) * (h + gap), width: w, height: h });
    } else {
      const w = (r.width - gap * (n - 1)) / n;
      for (let i = 0; i < n; i++) cells.push({ x: r.x + i * (w + gap), y: r.y, width: w, height: r.height });
    }
    return ids.map((id, i) => {
      const c = cells[i];
      return { id, head: { x: Math.round(c.x), y: Math.round(c.y), width: Math.round(c.width), height: head },
        page: { x: Math.round(c.x), y: Math.round(c.y + head), width: Math.max(0, Math.round(c.width)), height: Math.max(0, Math.round(c.height - head)) } };
    });
  }
  enterSplit(ids) {
    ids = [...new Set(ids)].filter((id) => this.tabs.some((t) => t.id === id && t.spaceId === this.spaceId)).slice(0, 4);
    if (ids.length < 2) return;
    this.split = ids;
    if (!ids.includes(this.activeId)) this.activeId = ids[0];
    for (const t of this.tabs) { try { this.win.contentView.removeChildView(t.view); } catch {} }
    for (const id of ids) { const t = tabById.get(id); if (t.sleeping) this.wake(t); this.win.contentView.addChildView(t.view); }
    this.restack(); this.layout(); this.sendTabs();
  }
  splitAdd(tabId = null) {
    if (this.split && this.split.length >= 4) { this.showNotice('O Split View mostra até 4 páginas ao mesmo tempo', 2500); return; }
    const base = this.split || [this.activeId];
    const t = tabId ? tabById.get(tabId) : this.newTab(null, { background: true });
    if (!t) return;
    this.enterSplit([...base, t.id]);
    this.activeId = t.id; this.sendTabs();
    if (!tabId) setTimeout(() => this.focusAddress(), 50);
  }
  removeFromSplit(id) {
    if (!this.split) return;
    const rest = this.split.filter((x) => x !== id);
    const t = tabById.get(id);
    if (t) { try { this.win.contentView.removeChildView(t.view); } catch {} }
    if (rest.length < 2) { this.exitSplit(rest[0] || this.activeId); return; }
    this.split = rest;
    if (this.activeId === id) this.activeId = rest[0];
    this.layout(); this.sendTabs();
  }
  exitSplit(keepId = this.activeId, { quiet = false } = {}) {
    if (!this.split) return;
    const ids = this.split; this.split = null;
    for (const id of ids) { const t = tabById.get(id); if (t && id !== keepId) { try { this.win.contentView.removeChildView(t.view); } catch {} } }
    if (quiet) return;
    if (keepId && tabById.has(keepId)) this.activate(keepId); else { this.layout(); this.sendTabs(); }
  }
  restack() {
    // pages above the browser frame; the frame goes on top only while one of its menus is open
    const views = this.split ? this.split.map((id) => tabById.get(id)).filter(Boolean).map((t) => t.view) : (this.active ? [this.active.view] : []);
    for (const v of views) { try { this.win.contentView.addChildView(v); } catch {} }
    if (this.uiOnTop) this.win.contentView.addChildView(this.ui);
    if (this.notice && this.noticeShown) this.win.contentView.addChildView(this.notice);
  }

  constructor({ isPrivate = false, urls = null } = {}) {
    this.isPrivate = isPrivate;
    // all private windows share one temporary session (like Chrome); it is discarded when the last one closes
    if (isPrivate && !sharedPrivateSession) sharedPrivateSession = session.fromPartition(`antares-private-${Date.now()}`);
    this.ses = isPrivate ? sharedPrivateSession : session.defaultSession;
    setupSession(this.ses, isPrivate);
    this.tabs = []; this.activeId = null; this.closedTabs = [];
    this.htmlFull = false; this.split = null; this.uiOnTop = false;
    this.content = { x: 0, y: 120, width: 1000, height: 600 };
    this.spaceId = isPrivate ? 'private' : (spaceList()[0] || DEFAULT_SPACES[0]).id;
    this.lastActiveBySpace = {};

    // no Windows title bar: the Antares frame draws its own controls and drag areas
    this.win = new BaseWindow({
      width: 1360, height: 880, minWidth: 640, minHeight: 480, title: 'Antares',
      icon: fs.existsSync(ICON) ? ICON : undefined, frame: false,
      backgroundColor: '#07070a', autoHideMenuBar: true,
    });
    this.win.setMenuBarVisibility(false);
    const sendState = () => { if (!this.win.isDestroyed()) this.send('win-state', { maximized: this.win.isMaximized(), fullscreen: this.win.isFullScreen() }); };
    for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) this.win.on(ev, sendState);
    this.sendState = sendState;

    this.ui = new WebContentsView({
      webPreferences: { session: getUiSession(), preload: path.join(__dirname, 'preload-ui.js'), contextIsolation: true, sandbox: true, spellcheck: false },
    });
    this.ui.setBackgroundColor('#00000000');
    uiContents.add(this.ui.webContents);
    this.win.contentView.addChildView(this.ui);
    this.ui.webContents.loadURL(uiUrl('index.html', { private: isPrivate ? '1' : '0' }));
    this.hookKeys(this.ui.webContents);

    this.ui.webContents.once('did-finish-load', () => {
      this.send('init', { isPrivate, bookmarks, settings: publicSettings(), downloads: downloadsSummary(), platform: process.platform, collections: collectionsSummary(), recents: recentItems() });
      this.sendSpaces(); this.sendState();
      const msg = updateNeeded(); if (msg) this.send('update', { msg });
      const list = (urls && urls.length ? urls : [null]).map((u) => (u && typeof u === 'object' ? u : { url: u, space: null }));
      const valid = new Set(spaceList().map((x) => x.id));
      for (const it of list) {
        const sp = !isPrivate && it.space && valid.has(it.space) ? it.space : this.spaceId;
        this.newTab(it.url, { background: true, space: sp });
      }
      const first = this.spaceTabs()[0] || this.tabs[0];
      if (first && first.spaceId !== this.spaceId) this.spaceId = first.spaceId;
      if (first) this.activate(first.id);
      this.sendSpaces();
    });

    this.win.on('resize', () => this.layout());
    this.win.on('focus', () => { BrowserWin.lastFocused = this; });
    this.win.on('enter-full-screen', () => this.layout());
    this.win.on('focus', () => this.send('win-focus', true));
    this.win.on('blur', () => this.send('win-focus', false));
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
    const a = this.active;
    if (this.htmlFull) {
      this.ui.setBounds({ x: 0, y: 0, width: w, height: 0 });
      if (a) a.view.setBounds({ x: 0, y: 0, width: w, height: h });
      return;
    }
    // the frame (UI) fills the window; pages sit in the "hole" the UI reports
    this.ui.setBounds({ x: 0, y: 0, width: w, height: h });
    const r = this.content;
    if (this.split) {
      const panes = this.splitRects();
      for (const p of panes) { const t = tabById.get(p.id); if (t && this.alive(t)) { const dr = this.deviceRect(t, p.page); t.view.setBounds(dr); this.applyDevice(t, dr); } }
      this.sendDevice(null);
      const key = JSON.stringify(panes);
      if (key !== this.lastPanes) { this.lastPanes = key; this.send('split', { panes, active: this.activeId }); }
    } else {
      if (this.lastPanes !== 'none') { this.lastPanes = 'none'; this.send('split', null); }
      if (a && this.alive(a)) {
        const dr = this.deviceRect(a, r);
        a.view.setBounds({ x: dr.x, y: dr.y, width: dr.width, height: dr.height }); this.applyDevice(a, dr);
        this.sendDevice(dr.scale ? { x: dr.x, y: dr.y, width: dr.width, height: dr.height, device: a.device } : null);
      } else this.sendDevice(null);
    }
  }
  sendDevice(d) { const k = JSON.stringify(d); if (k !== this.lastDevice) { this.lastDevice = k; this.send('device-frame', d); } }

  tabInfo(t) {
    const live = this.alive(t);
    const wc = live ? t.view.webContents : { isDestroyed: () => true, id: -1 };
    const url = tabUrl(t);
    let display = url;
    let warn = '';
    if (url.startsWith(HOME)) display = '';
    else if (url.startsWith('antares://error')) { try { display = new URL(url).searchParams.get('u') || url; } catch {} }
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
      secure: warn ? 'insecure' : url.startsWith('https:') ? 'secure' : url.startsWith('http:') ? 'insecure' : url.startsWith('antares:') ? 'internal' : 'file',
      audible: !wc.isDestroyed() && wc.isCurrentlyAudible(), muted: !wc.isDestroyed() && wc.isAudioMuted(),
      zoom: wc.isDestroyed() ? 1 : wc.getZoomFactor(),
      crashed: !!t.crashed, sleeping: !!t.sleeping, space: t.spaceId, playing: !!t.playing, device: t.device || 'desktop',
    };
  }
  sendTabSoon(t) {
    if (t._sendTimer) return;
    t._sendTimer = setTimeout(() => { t._sendTimer = null; if (tabById.has(t.id)) this.sendTab(t); }, 300);
  }
  sendTabs() { this.send('tabs', { tabs: this.tabs.map((t) => this.tabInfo(t)), activeId: this.activeId, space: this.spaceId, split: this.split }); }
  sendTab(t) {
    this.send('tab', this.tabInfo(t));
    if (t.id === this.activeId && !this.win.isDestroyed()) this.win.setTitle(`${t.title || 'Nova aba'} — Antares${this.isPrivate ? ' (Privado)' : ''}`);
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

  newTab(url, { background = false, index = null, opener = null, space = null } = {}) {
    const view = this.createView();
    const t = { id: ++tabSeq, view, title: 'Nova aba', url: '', favicon: '', loading: true, win: this, lastActive: Date.now(), openerId: opener ? opener.id : null,
      spaceId: space || (opener && opener.spaceId) || this.spaceId };
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
    if ((!background || !this.activeId) && t.spaceId === this.spaceId) this.activate(t.id); else { this.sendTabs(); this.sendSpaces(); }
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
    if (t.spaceId !== this.spaceId) {
      // a tab from another Space (e.g. picked in the command palette): go to that Space
      if (this.activeId) this.lastActiveBySpace[this.spaceId] = this.activeId;
      if (this.split) this.exitSplit(null, { quiet: true });
      for (const x of this.tabs) { try { this.win.contentView.removeChildView(x.view); } catch {} }
      this.activeId = null; this.spaceId = t.spaceId; this.sendSpaces();
    }
    if (this.split && this.split.includes(id)) {
      // inside split view: just move the focus to that pane
      this.activeId = id; t.lastActive = Date.now(); this.sendTabs(); this.sendTab(t);
      try { t.view.webContents.focus(); } catch {}
      return;
    }
    if (this.split) this.exitSplit(null, { quiet: true });
    const prev = this.active;
    if (prev && prev !== t) { prev.lastActive = Date.now(); try { this.win.contentView.removeChildView(prev.view); } catch {} }
    for (const x of this.tabs) if (x !== t && x.spaceId === this.spaceId) { try { this.win.contentView.removeChildView(x.view); } catch {} }
    if (prev !== t) for (const x of this.tabs) if (x.openerId && x !== t) x.openerId = null; // like Chrome: switching tabs resets link order
    if (t.sleeping) this.wake(t);
    t.lastActive = Date.now();
    this.activeId = id;
    this.lastActiveBySpace[this.spaceId] = id;
    this.win.contentView.addChildView(t.view);
    this.restack();
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
    if (/^https?:/.test(url) && !this.closingWindow) { this.closedTabs.push({ url, space: t.spaceId }); if (this.closedTabs.length > 25) this.closedTabs.shift(); }
    const spaceBefore = this.spaceTabs(t.spaceId);
    const si = spaceBefore.indexOf(t);
    this.tabs.splice(i, 1);
    tabById.delete(t.id);
    try { blockedPerTab.delete(t.wc.id); } catch {}
    if (this.disposed) return;
    try { this.win.contentView.removeChildView(t.view); } catch {}
    if (this.split && this.split.includes(t.id)) {
      const rest = this.split.filter((x) => x !== t.id);
      if (rest.length >= 2) { this.split = rest; if (this.activeId === t.id) this.activeId = rest[0]; this.layout(); }
      else { this.split = null; if (this.activeId === t.id || rest[0]) this.activeId = null; if (rest[0]) this.activate(rest[0]); }
    }
    if (this.activeId === t.id) {
      this.activeId = null;
      const same = this.spaceTabs(t.spaceId);
      if (!this.tabs.length) { /* window closes below */ }
      else if (same.length) this.activate(same[Math.min(si, same.length - 1)].id);
      else if (!this.closingWindow) this.newTab(null); // keep the Space open with a new tab
    }
    try { if (this.alive(t)) t.view.webContents.close(); } catch {}
    if (!this.tabs.length) { this.forceClose = true; this.win.close(); return; }
    this.sendTabs(); this.sendSpaces();
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
    wc.on('focus', () => { if (this.split && this.split.includes(t.id) && this.activeId !== t.id) { this.activeId = t.id; this.sendTabs(); this.sendTab(t); this.layout(); } });
    wc.on('dom-ready', () => { if (t.device && t.device !== 'desktop' && (t.id === this.activeId || (this.split || []).includes(t.id))) this.layout(); });
    wc.on('media-started-playing', () => { t.playing = true; t.hadMedia = true; this.sendTab(t); });
    wc.on('media-paused', () => { t.playing = false; this.sendTab(t); });
    wc.on('did-finish-load', () => {
      // small preview for the "Recentes" panel
      const url = wc.getURL();
      if (!isWebUrl(url) || this.isPrivate) return;
      setTimeout(() => {
        if (wc.isDestroyed() || wc.getURL() !== url || (t.id !== this.activeId && !(this.split || []).includes(t.id))) return;
        wc.capturePage().then((img) => {
          if (img.isEmpty()) return;
          const small = img.resize({ width: 160 });
          thumbs.delete(url); thumbs.set(url, 'data:image/jpeg;base64,' + small.toJPEG(60).toString('base64'));
          while (thumbs.size > 40) thumbs.delete(thumbs.keys().next().value);
          save('thumbs', Object.fromEntries(thumbs), 3000);
          broadcastRecents();
        }).catch(() => {});
      }, 1500);
    });
    wc.on('did-finish-load', () => { if (t.id === this.activeId && wc.getURL().startsWith(HOME)) this.focusAddress(); });
    wc.on('did-navigate', (e, url) => {
      blockedPerTab.delete(wc.id); t.blockedPopups = [];
      t.url = url; t.favicon = url.startsWith('antares:') ? '' : t.favicon;
      if (!this.isPrivate) { addHistory(url, wc.getTitle(), ''); broadcastRecentsSoon(); }
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
      if (!isMain || code === -3 || url.startsWith('antares://')) return;
      const orig = upgradedUrls.get(url);
      if (orig && code !== -3) {
        // the site does not support HTTPS: ask before falling back to plain http
        const q = new URLSearchParams({ u: orig, c: 'https', d: desc });
        wc.loadURL(`antares://error/?${q}`).catch(() => {});
        return;
      }
      const q = new URLSearchParams({ u: url, c: String(code), d: desc });
      wc.loadURL(`antares://error/?${q}`).catch(() => {});
    });
    wc.on('render-process-gone', (e, details) => {
      if (details.reason === 'clean-exit') return;
      t.crashed = true; t.loading = false; this.sendTab(t);
      const q = new URLSearchParams({ u: t.url, c: 'crash', d: details.reason });
      setTimeout(() => { if (!wc.isDestroyed()) wc.loadURL(`antares://error/?${q}`).catch(() => {}); }, 50);
    });
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      const fromInternal = wc.getURL().startsWith('antares://') && trusted.has(wc);
      if (!fromInternal && !isOpenableByPage(url)) return { action: 'deny' };
      // pop-up blocker: pages may only open windows right after a click or key press
      const origin = (() => { try { return new URL(wc.getURL()).origin; } catch { return ''; } })();
      // like Chrome, one click or key press lets the page open one window (no bursts of tabs from a single click)
      const inputAt = lastUserInput.get(wc) || 0;
      const recent = Date.now() - inputAt < 2500 && t.popupInputUsed !== inputAt;
      if (recent && !fromInternal) t.popupInputUsed = inputAt;
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
    const url = `antares://${page}`;
    const host = page.split(/[#/?]/)[0];
    const existing = this.spaceTabs().find((t) => { try { const u = new URL(tabUrl(t)); return u.protocol === 'antares:' && u.hostname === host; } catch { return false; } });
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
    const top = this.htmlFull ? 18 : this.content.y + 14;
    n.setBounds({ x: Math.round((w - width) / 2), y: top, width, height: 56 });
    this.win.contentView.addChildView(n); this.noticeShown = true;
    const a = this.active; if (a) setTimeout(() => { try { a.view.webContents.focus(); } catch {} }, 50);
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.noticeShown = false; try { this.win.contentView.removeChildView(n); } catch {} }, ms);
  }

  hideNotice() { clearTimeout(this.noticeTimer); this.noticeShown = false; if (this.notice) { try { this.win.contentView.removeChildView(this.notice); } catch {} } }

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

  /* ---------- device preview ("Dispositivos"): see the page as a phone or tablet */
  deviceRect(t, rect) {
    // a phone/tablet preview is drawn at its real proportions, centred in the page area
    const p = DEVICES[t.device || 'desktop'];
    if (!p || !p.w) return rect;
    let w = p.w, h = p.h; if (t.landscape) [w, h] = [h, w];
    const s = Math.min(1, (rect.width - 40) / w, (rect.height - 40) / h);
    const W = Math.max(50, Math.round(w * s)), H = Math.max(50, Math.round(h * s));
    return { x: rect.x + Math.round((rect.width - W) / 2), y: rect.y + Math.round((rect.height - H) / 2), width: W, height: H, scale: s, dw: w, dh: h };
  }
  applyDevice(t, r) {
    const wc = t.view.webContents;
    const p = DEVICES[t.device || 'desktop'];
    if (!p || !p.w || !r.scale) { if (t.emulating) { try { wc.disableDeviceEmulation(); } catch {} t.emulating = false; } return; }
    try {
      wc.enableDeviceEmulation({
        screenPosition: 'mobile', screenSize: { width: r.dw, height: r.dh }, viewPosition: { x: 0, y: 0 },
        viewSize: { width: r.dw, height: r.dh }, deviceScaleFactor: p.dpr, scale: r.scale,
      });
      t.emulating = true;
    } catch {}
  }
  setDevice(id, rotate = false) {
    const t = this.active; if (!t || !DEVICES[id]) return;
    const wc = t.view.webContents;
    const wasMobile = !!(DEVICES[t.device || 'desktop'] || {}).mobile;
    if (rotate && t.device === id) t.landscape = !t.landscape; else if (!rotate) t.landscape = false;
    t.device = id;
    const mobile = !!DEVICES[id].mobile;
    if (mobile !== wasMobile) {
      wc.setUserAgent(mobile ? MOBILE_UA : app.userAgentFallback);
      wc.reload();
    }
    this.layout(); this.sendTab(t);
  }

  /* ---------- capture ("Captura"): screenshot of the visible page */
  async capture() {
    const t = this.active; if (!t || !this.alive(t)) return;
    try {
      const img = await t.view.webContents.capturePage();
      if (img.isEmpty()) return;
      const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
      const name = `Captura Antares ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`;
      const file = uniquePath(app.getPath('downloads'), name);
      fs.writeFileSync(file, img.toPNG());
      try {
        if (typeof clipboard.writeImage === 'function') clipboard.writeImage(img);
        else if (ClipboardItem) clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })]).catch(() => {});
      } catch {}
      downloads.unshift({ id: ++dlSeq, filename: path.basename(file), url: tabUrl(t), path: file, total: fs.statSync(file).size, received: fs.statSync(file).size, state: 'completed', start: Date.now(), private: this.isPrivate });
      broadcastDownloads(); save('downloads', persistableDownloads());
      this.showNotice('Captura salva em Downloads e copiada', 2600);
    } catch (e) { console.error('capture', e); }
  }

  /* ---------- media hub ("Mídia") */
  mediaList() {
    const out = [];
    for (const t of this.tabs) {
      if (!this.alive(t)) continue;
      const wc = t.view.webContents;
      const audible = wc.isCurrentlyAudible(); const muted = wc.isAudioMuted();
      if (audible || muted || t.playing || t.hadMedia) out.push({ id: t.id, title: t.title, favicon: t.favicon, space: t.spaceId, playing: !!t.playing || audible, muted });
    }
    return out;
  }
  async mediaAction(id, action) {
    const t = this.tabs.find((x) => x.id === id); if (!t || !this.alive(t)) return;
    const wc = t.view.webContents;
    if (action === 'mute') wc.setAudioMuted(!wc.isAudioMuted());
    else if (action === 'go') this.activate(id);
    else if (action === 'toggle') {
      await wc.executeJavaScript(`(() => { const m = [...document.querySelectorAll('video,audio')]; const p = m.filter((x) => !x.paused);
        if (p.length) { p.forEach((x) => x.pause()); return 'paused'; } const f = m.find((x) => x.currentTime > 0) || m[0]; if (f) { f.play().catch(() => {}); return 'playing'; } return 'none'; })()`, true).catch(() => {});
    }
    this.sendTab(t);
    return this.mediaList();
  }

  /* ---------- performance ("Desempenho") */
  perfInfo() {
    const metrics = app.getAppMetrics();
    const byPid = new Map(metrics.map((m) => [m.pid, m]));
    const total = metrics.reduce((s2, m) => s2 + (m.memory ? m.memory.workingSetSize : 0), 0);
    const tabs = this.tabs.map((t) => {
      let kb = 0; try { if (this.alive(t) && !t.sleeping) { const m = byPid.get(t.view.webContents.getOSProcessId()); kb = m && m.memory ? m.memory.workingSetSize : 0; } } catch {}
      return { id: t.id, title: t.title, favicon: t.favicon, space: t.spaceId, mb: Math.round(kb / 1024), sleeping: !!t.sleeping, active: t.id === this.activeId };
    }).sort((a, b) => b.mb - a.mb);
    const cpu = metrics.reduce((s2, m) => s2 + (m.cpu ? m.cpu.percentCPUUsage : 0), 0);
    return { totalMb: Math.round(total / 1024), cpu: Math.round(cpu), tabs, sleeping: tabs.filter((x) => x.sleeping).length, blocked: blockedTotal, tabSleep: settings.tabSleep };
  }
  perfAction(action, id) {
    if (action === 'sleep-all') {
      for (const t of this.tabs) {
        if (t.id === this.activeId || t.sleeping || (this.split || []).includes(t.id) || !isWebUrl(tabUrl(t)) || !this.alive(t)) continue;
        try { if (t.view.webContents.isCurrentlyAudible()) continue; } catch {}
        this.sleepTab(t);
      }
    } else if (action === 'sleep') { const t = this.tabs.find((x) => x.id === id); if (t && t.id !== this.activeId && !t.sleeping && isWebUrl(tabUrl(t))) this.sleepTab(t); }
    else if (action === 'toggle-sleep') { settings.tabSleep = !settings.tabSleep; save('settings', settings); broadcastSettings(); }
    return this.perfInfo();
  }

  /* ---------- read later / missions from the current page */
  addReadLater(t = this.active) {
    if (!t) return;
    const url = tabUrl(t); if (!isWebUrl(url)) return;
    if (!readLater.some((x) => x.url === url)) { readLater.unshift({ url, title: t.title || url, favicon: t.favicon || '', added: Date.now() }); save('readlater', readLater); }
    broadcastCollections(); this.showNotice('Adicionado a Ler depois', 2000);
  }
  addToMission(missionId, t = this.active) {
    const m = missions.find((x) => x.id === missionId); if (!m || !t) return;
    const url = tabUrl(t); if (!isWebUrl(url)) return;
    m.pages = m.pages || [];
    if (!m.pages.some((x) => x.url === url)) m.pages.push({ url, title: t.title || url, favicon: t.favicon || '' });
    m.updated = Date.now(); save('missions', missions); broadcastCollections();
    this.showNotice(`Página adicionada à missão “${m.title}”`, 2200);
  }
  saveSpaceAsOrbit(spaceId = this.spaceId, name = null) {
    const tabs = this.spaceTabs(spaceId).map((t) => ({ url: tabUrl(t), title: t.title, favicon: t.favicon })).filter((x) => isWebUrl(x.url));
    if (!tabs.length) { this.showNotice('Não há páginas para salvar nesta Space', 2200); return null; }
    const sp = spaceList().find((x) => x.id === spaceId);
    const o = { id: uid(), name: name || `${sp ? sp.name : 'Órbita'} · ${new Date().toLocaleDateString('pt-BR')}`, space: spaceId, tabs, created: Date.now() };
    orbits.unshift(o); save('orbits', orbits); broadcastCollections();
    this.showNotice(`Órbita “${o.name}” salva com ${tabs.length} página(s)`, 2600);
    return o;
  }
  openOrbit(id) {
    const o = orbits.find((x) => x.id === id); if (!o) return;
    const first = this.tabs.length;
    (o.tabs || []).forEach((x, i) => this.newTab(x.url, { background: i > 0 }));
    void first;
  }
  openMission(id) {
    const m = missions.find((x) => x.id === id); if (!m) return;
    m.updated = Date.now(); save('missions', missions);
    const pages = (m.pages || []).slice(0, 20);
    if (!pages.length) { this.openInternal('universe#missions'); return; }
    pages.forEach((x, i) => this.newTab(x.url, { background: i > 0 }));
    broadcastCollections();
  }

  /* ---------- menus for tabs, spaces and the "Mais"/split buttons */
  tabMenu(id) {
    const t = this.tabs.find((x) => x.id === id); if (!t) return;
    const wc = t.view.webContents;
    const others = spaceList().filter((x) => x.id !== t.spaceId);
    Menu.buildFromTemplate([
      { label: 'Nova aba à direita', click: () => this.newTab(null, { index: this.tabs.indexOf(t) + 1 }) },
      { label: 'Recarregar', click: () => wc.reload() },
      { label: 'Duplicar', click: () => this.newTab(tabUrl(t), { index: this.tabs.indexOf(t) + 1 }) },
      { label: wc.isAudioMuted() ? 'Ativar som do site' : 'Silenciar site', click: () => { wc.setAudioMuted(!wc.isAudioMuted()); this.sendTab(t); } },
      { type: 'separator' },
      { label: 'Abrir em Split View', enabled: t.id !== this.activeId && !(this.split || []).includes(t.id), click: () => this.splitAdd(t.id) },
      { label: 'Mover para Space', visible: !this.isPrivate, submenu: others.length ? others.map((sp) => ({ label: sp.name, click: () => this.moveTabToSpace(t, sp.id) })) : [{ label: 'Nenhuma outra Space', enabled: false }] },
      { label: 'Ler depois', enabled: isWebUrl(tabUrl(t)) && !this.isPrivate, click: () => this.addReadLater(t) },
      { label: 'Adicionar à missão', enabled: isWebUrl(tabUrl(t)) && !this.isPrivate, submenu: missions.length ? missions.slice(0, 12).map((m) => ({ label: m.title, click: () => this.addToMission(m.id, t) })) : [{ label: 'Crie uma missão em Missions', enabled: false }] },
      { type: 'separator' },
      { label: 'Fechar', click: () => this.closeTab(id) },
      { label: 'Fechar outras abas desta Space', click: () => this.spaceTabs(t.spaceId).filter((x) => x.id !== id).forEach((x) => this.closeTab(x.id)) },
      { label: 'Fechar abas à direita', click: () => { const st = this.spaceTabs(t.spaceId); st.slice(st.indexOf(t) + 1).forEach((x) => this.closeTab(x.id)); } },
      { type: 'separator' },
      { label: 'Reabrir aba fechada', enabled: this.closedTabs.length > 0, click: () => this.reopen() },
    ]).popup({ window: this.win });
  }
  spaceMenu(id) {
    const sp = spaceList().find((x) => x.id === id); if (!sp) return;
    Menu.buildFromTemplate([
      { label: `Abrir ${sp.name}`, click: () => this.switchSpace(id) },
      { label: 'Renomear…', click: () => { this.ui.webContents.focus(); this.send('space-rename', id); } },
      { label: 'Salvar páginas como Órbita', click: () => this.saveSpaceAsOrbit(id) },
      { type: 'separator' },
      { label: 'Excluir Space (fecha as abas dela)', enabled: spaceList().length > 1, click: async () => {
        const r = await dialog.showMessageBox(this.win, { type: 'warning', buttons: ['Excluir', 'Cancelar'], defaultId: 1, cancelId: 1, noLink: true,
          message: `Excluir a Space “${sp.name}”?`, detail: 'As abas abertas nela serão fechadas. Salve-as como Órbita antes, se quiser guardá-las.' });
        if (r.response !== 0) return;
        deleteSpace(id);
      } },
    ]).popup({ window: this.win });
  }

  /* ---------- command palette (center orb / Ctrl+K) */
  paletteQuery(q) {
    q = String(q || '').trim().toLowerCase();
    const match = (...xs) => !q || xs.some((x) => String(x || '').toLowerCase().includes(q));
    const items = [];
    const cmds = [
      ['Nova aba', 'cmd', 'new-tab', 'Ctrl+T'], ['Nova janela privada', 'cmd', 'private', 'Ctrl+Shift+N'], ['Dividir a tela (Split View)', 'cmd', 'split', ''],
      ['Captura da página', 'cmd', 'capture', ''], ['Mapa Estelar', 'cmd', 'map', ''], ['Salvar esta Space como Órbita', 'cmd', 'save-orbit', ''],
      ['Ler depois', 'cmd', 'read-later', ''], ['Histórico', 'cmd', 'history', 'Ctrl+H'], ['Downloads', 'cmd', 'downloads', 'Ctrl+J'],
      ['Favoritos', 'cmd', 'bookmarks', ''], ['Configurações', 'cmd', 'settings', ''], ['Alternar Modo Foco / Órbita', 'cmd', 'mode', ''],
    ];
    for (const [title, kind, id, hint] of cmds) if (match(title)) items.push({ kind, id, title, sub: hint, group: 'Comandos' });
    if (!this.isPrivate) for (const sp of spaceList()) if (match(sp.name, 'space')) items.push({ kind: 'space', id: sp.id, title: sp.name, sub: `${this.spaceTabs(sp.id).length} aba(s)`, group: 'Spaces', color: sp.color });
    for (const t of this.tabs) if (match(t.title, tabUrl(t))) items.push({ kind: 'tab', id: t.id, title: t.title || tabUrl(t), sub: (spaceList().find((x) => x.id === t.spaceId) || { name: 'Privado' }).name, favicon: t.favicon, group: 'Abas abertas' });
    if (!this.isPrivate) {
      for (const o of orbits) if (match(o.name)) items.push({ kind: 'orbit', id: o.id, title: o.name, sub: `${(o.tabs || []).length} página(s)`, group: 'Orbits' });
      for (const m of missions) if (match(m.title, m.notes)) items.push({ kind: 'mission', id: m.id, title: m.title, sub: `${(m.pages || []).length} página(s)`, group: 'Missions' });
    }
    if (q) {
      for (const b of bookmarks) if (match(b.title, b.url)) items.push({ kind: 'url', id: b.url, title: b.title, sub: b.url, favicon: b.favicon, group: 'Favoritos' });
      const seen = new Set();
      for (const h of history) { if (items.length > 60) break; if (seen.has(h.url) || !match(h.title, h.url)) continue; seen.add(h.url); items.push({ kind: 'url', id: h.url, title: h.title || h.url, sub: h.url, favicon: h.favicon, group: 'Histórico' }); if (seen.size >= 6) break; }
      items.push({ kind: 'search', id: q, title: `Pesquisar “${q}”`, sub: (SEARCH[settings.searchEngine] || SEARCH.google).name, group: 'Web' });
    }
    return items.slice(0, 40);
  }
  paletteRun(item) {
    if (!item) return;
    const k = item.kind, id = item.id;
    if (k === 'tab') this.activate(id);
    else if (k === 'space') this.switchSpace(id);
    else if (k === 'orbit') this.openOrbit(id);
    else if (k === 'mission') this.openMission(id);
    else if (k === 'url') this.newTab(id);
    else if (k === 'search') this.newTab(searchUrl(id));
    else if (k === 'cmd') {
      const map = {
        'new-tab': () => this.newTab(), private: () => new BrowserWin({ isPrivate: true }), split: () => this.splitAdd(),
        capture: () => this.capture(), map: () => this.openInternal('mapa'), 'save-orbit': () => this.saveSpaceAsOrbit(),
        'read-later': () => this.addReadLater(), history: () => this.openInternal('history'), downloads: () => this.openInternal('downloads'),
        bookmarks: () => this.openInternal('bookmarks'), settings: () => this.openInternal('settings'), mode: () => this.send('toggle-mode'),
      };
      if (map[id]) map[id]();
    }
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
      { label: 'Sobre o Antares', click: () => this.openInternal('settings#sobre') },
      { type: 'separator' },
      { label: 'Sair', click: () => app.quit() },
    ]);
  }

  reopen() {
    const c = this.closedTabs.pop();
    if (!c) return;
    const sp = typeof c === 'object' && spaceList().some((x) => x.id === c.space) ? c.space : this.spaceId;
    if (sp !== this.spaceId) this.switchSpace(sp);
    this.newTab(typeof c === 'object' ? c.url : c);
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
    else if (k === 'k') { this.ui.webContents.focus(); this.send('palette', true); }
  }

  siteMenu(id) {
    const t = this.tabs.find((x) => x.id === id); if (!t) return;
    const wc = t.view.webContents; const url = tabUrl(t);
    let u; try { u = new URL(url); } catch { return; }
    const items = [];
    if (u.protocol === 'antares:') {
      items.push({ label: 'Página interna do Antares', enabled: false });
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
      if (mod && !i.shift && !i.alt && k === 'k') { this.ui.webContents.focus(); this.send('palette', true); }
      else if (mod && i.alt && /^[1-9]$/.test(k)) { const sp = spaceList()[Number(k) - 1]; if (sp) this.switchSpace(sp.id); }
      else if (mod && i.shift && k === 't') this.reopen();
      else if (mod && i.shift && k === 'n') new BrowserWin({ isPrivate: true });
      else if (mod && i.shift && k === 'b') toggleBookmarksBar();
      else if (mod && i.shift && k === 'o') this.openInternal('bookmarks');
      else if (mod && i.shift && k === 'Delete') this.openInternal('settings#limpar');
      else if (mod && (k === 'Tab' || k === 'PageDown' || k === 'PageUp')) {
        const dir = (k === 'PageUp' || (k === 'Tab' && i.shift)) ? -1 : 1;
        const st = this.spaceTabs();
        const idx = st.findIndex((x) => x.id === this.activeId);
        const n = st[(idx + dir + st.length) % st.length];
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
        const st = this.spaceTabs();
        const n = k === '9' ? st[st.length - 1] : st[Number(k) - 1];
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

const DEVICES = {
  desktop: { name: 'Computador' },
  phone: { name: 'Celular', w: 390, h: 844, dpr: 3, mobile: true },
  tablet: { name: 'Tablet', w: 820, h: 1180, dpr: 2, mobile: true },
};
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Mobile Safari/537.36';
function recentItems() {
  const out = []; const seen = new Set();
  for (const h of history) {
    if (!isWebUrl(h.url) || seen.has(h.url)) continue;
    seen.add(h.url);
    out.push({ url: h.url, title: h.title || h.url, favicon: h.favicon || '', thumb: thumbs.get(h.url) || '' });
    if (out.length >= 6) break;
  }
  return out;
}
function broadcastRecents() { const r = recentItems(); for (const w of BrowserWin.all) if (!w.isPrivate) w.send('recents', r); }
let recentsTimer = null;
function broadcastRecentsSoon() { clearTimeout(recentsTimer); recentsTimer = setTimeout(broadcastRecents, 800); }
function deleteSpace(id) {
  const list = spaceList(); if (list.length <= 1) return;
  settings.spaces = list.filter((x) => x.id !== id); save('settings', settings);
  const fallback = settings.spaces[0].id;
  for (const w of BrowserWin.all) {
    if (w.isPrivate) continue;
    const doomed = w.tabs.filter((t) => t.spaceId === id);
    if (w.spaceId === id) w.switchSpace(fallback);
    for (const t of doomed) w.closeTab(t.id);
  }
  broadcastSpaces();
}
const SPACE_COLORS = ['#ff7a1a', '#ffb020', '#4fa3ff', '#3ad29f', '#ff5c8a', '#a98bff', '#e8e2d6'];

const OVERRIDABLE_KEYS = new Set(['s', 'f', 'h', 'd', 'p', 'j', 'u', 'k']);
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
    layoutMode: settings.layoutMode, rightPanel: settings.rightPanel,
    shortcuts: Array.isArray(settings.shortcuts) ? settings.shortcuts : DEFAULT_SHORTCUTS,
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
uiOn('ui:layout', (w, rect, onTop) => {
  const [W, H] = w.win.getContentSize();
  const num = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  if (rect) w.content = { x: num(rect.x, W), y: num(rect.y, H), width: num(rect.width, W), height: num(rect.height, H) };
  const top = !!onTop;
  if (top !== w.uiOnTop) {
    w.uiOnTop = top;
    if (top) w.win.contentView.addChildView(w.ui); else w.restack();
    if (!top) { const a = w.active; if (a) try { a.view.webContents.focus(); } catch {} }
  }
  w.layout();
});
uiOn('ui:win', (w, action) => {
  if (action === 'min') w.win.minimize();
  else if (action === 'max') { if (w.win.isMaximized()) w.win.unmaximize(); else w.win.maximize(); }
  else if (action === 'close') w.win.close();
  else if (action === 'fullscreen') w.win.setFullScreen(!w.win.isFullScreen());
});
uiOn('ui:space', (w, action, id, name) => {
  if (w.isPrivate) return;
  if (action === 'switch') w.switchSpace(id);
  else if (action === 'menu') w.spaceMenu(id);
  else if (action === 'add') {
    const list = spaceList();
    const nm = String(name || '').trim().slice(0, 24) || `Space ${list.length + 1}`;
    const sp = { id: uid(), name: nm, color: SPACE_COLORS[list.length % SPACE_COLORS.length] };
    settings.spaces = [...list, sp]; save('settings', settings); broadcastSpaces(); w.switchSpace(sp.id);
  } else if (action === 'rename') {
    const nm = String(name || '').trim().slice(0, 24);
    if (nm) { settings.spaces = spaceList().map((x) => (x.id === id ? { ...x, name: nm } : x)); save('settings', settings); broadcastSpaces(); }
  } else if (action === 'move') { // drag a tab onto a space
    const t = w.tabs.find((x) => x.id === Number(name)); if (t) w.moveTabToSpace(t, id);
  }
});
uiOn('ui:split', (w, action, id) => {
  if (action === 'add') w.splitAdd(id ? Number(id) : null);
  else if (action === 'remove') w.removeFromSplit(Number(id));
  else if (action === 'exit') w.exitSplit(id ? Number(id) : w.activeId);
  else if (action === 'focus') w.activate(Number(id));
});
uiOn('ui:capture', (w) => w.capture());
uiOn('ui:device', (w, id, rotate) => w.setDevice(String(id), !!rotate));
uiOn('ui:read-later', (w) => w.addReadLater());
uiOn('ui:tab-menu', (w, id) => w.tabMenu(id));
uiOn('ui:mission-menu', (w) => {
  Menu.buildFromTemplate(missions.length ? missions.slice(0, 12).map((m) => ({ label: m.title, click: () => w.addToMission(m.id) }))
    : [{ label: 'Nenhuma missão ainda — crie em Missions', enabled: false }]).popup({ window: w.win });
});
uiOn('ui:set-setting', (w, key, value) => {
  if (key === 'layoutMode' && ['auto', 'orbit', 'focus'].includes(value)) settings.layoutMode = value;
  else if (key === 'rightPanel') settings.rightPanel = !!value;
  else return;
  save('settings', settings); broadcastSettings();
});
uiOn('ui:palette-run', (w, item) => w.paletteRun(item));
uiOn('ui:orbit', (w, action, id) => { if (action === 'open') w.openOrbit(id); else if (action === 'save') w.saveSpaceAsOrbit(); });
uiOn('ui:mission', (w, action, id) => { if (action === 'open') w.openMission(id); });
const uiHandle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => { const w = winOf(e); if (!w || e.sender !== w.ui.webContents) return null; try { return fn(w, ...a); } catch (err) { console.error(ch, err); return null; } });
uiHandle('ui:media', (w) => w.mediaList());
uiHandle('ui:media-action', (w, id, action) => w.mediaAction(Number(id), String(action)));
uiHandle('ui:perf', (w) => w.perfInfo());
uiHandle('ui:perf-action', (w, action, id) => w.perfAction(String(action), Number(id)));
uiHandle('ui:palette', (w, q) => w.paletteQuery(q));
uiOn('ui:focus-page', (w) => { const t = w.active; if (t) t.view.webContents.focus(); });
uiOn('ui:find', (w, text, opts) => { const t = w.active; if (t && text) t.view.webContents.findInPage(text, opts || {}); });
uiOn('ui:stop-find', (w) => { const t = w.active; if (t) t.view.webContents.stopFindInPage('clearSelection'); });
uiOn('ui:move-tab', (w, id, toIndex) => {
  const i = w.tabs.findIndex((x) => x.id === id); if (i < 0) return;
  const [t] = w.tabs.splice(i, 1); w.tabs.splice(Math.max(0, Math.min(toIndex, w.tabs.length)), 0, t); w.sendTabs();
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
  return !!(f && f.url && f.url.startsWith('antares://') && f === e.sender.mainFrame && trusted.has(e.sender));
}
const internal = (ch, fn) => ipcMain.handle(ch, (e, ...a) => { if (!isInternal(e)) { if (process.env.ANTARES_DEBUG) console.error('DENY', ch, e.sender.getURL(), e.senderFrame && e.senderFrame.url, trusted.has(e.sender), e.senderFrame === e.sender.mainFrame); throw new Error('denied'); } return fn(e, ...a); });

internal('antares:settings', () => ({
  ...publicSettings(), version: app.getVersion(), chrome: process.versions.chrome, electron: process.versions.electron,
  blocked: blockedTotal, platform: process.platform, downloadsDir: app.getPath('downloads'),
  filters: filterCount(), filtersUpdated: settings.filtersUpdated, buildDate: BUILD_DATE, update: updateInfo,
  exceptions: Object.keys(settings.popupAllow).length + Object.keys(settings.adblockAllow).length + Object.keys(settings.permissions).length,
}));
internal('antares:update-filters', async () => ({ ok: await updateFilterLists(true), filters: filterCount(), filtersUpdated: settings.filtersUpdated }));
internal('antares:check-update', async () => { await checkEngineUpdate(true); return updateInfo; });
internal('antares:clear-exceptions', () => { settings.popupAllow = {}; settings.adblockAllow = {}; settings.permissions = {}; httpExempt.clear(); save('settings', settings); return true; });
internal('antares:allow-http', (e, url) => {
  // only from the HTTPS warning page, only for the page it is warning about
  try {
    const cur = new URL(e.sender.getURL());
    if (cur.hostname !== 'error' || cur.searchParams.get('c') !== 'https' || cur.searchParams.get('u') !== url) return false;
    const u = new URL(url); if (u.protocol !== 'http:') return false;
    httpExempt.add(u.hostname); return true;
  } catch { return false; }
});
internal('antares:set-settings', (e, patch) => {
  const allowed = ['searchEngine', 'homepage', 'startup', 'showBookmarksBar', 'theme', 'askDownloadLocation', 'blockTrackers', 'httpsOnly', 'gpc', 'tabSleep', 'layoutMode', 'rightPanel'];
  if ('layoutMode' in patch && !['auto', 'orbit', 'focus'].includes(patch.layoutMode)) delete patch.layoutMode;
  if ('rightPanel' in patch) patch.rightPanel = !!patch.rightPanel;
  if ('homepage' in patch && !(isWebUrl(patch.homepage) || patch.homepage === HOME)) delete patch.homepage;
  for (const k of ['showBookmarksBar', 'askDownloadLocation', 'blockTrackers', 'httpsOnly', 'gpc', 'tabSleep']) if (k in patch) patch[k] = !!patch[k];
  for (const k of allowed) if (k in patch) settings[k] = patch[k];
  if (settings.searchEngine && !SEARCH[settings.searchEngine]) settings.searchEngine = 'google';
  nativeTheme.themeSource = settings.theme;
  save('settings', settings); broadcastSettings();
  return publicSettings();
});
internal('antares:resolve', (e, text) => toUrl(text));
internal('antares:bookmarks', () => bookmarks);
internal('antares:remove-bookmark', (e, id) => { bookmarks = bookmarks.filter((b) => b.id !== id); save('bookmarks', bookmarks); broadcastBookmarks(); for (const w of BrowserWin.all) w.sendTabs(); return bookmarks; });
internal('antares:edit-bookmark', (e, id, patch) => {
  const b = bookmarks.find((x) => x.id === id);
  if (b) { if (patch.title != null) b.title = String(patch.title); if (patch.url) b.url = toUrl(patch.url) || b.url; save('bookmarks', bookmarks); broadcastBookmarks(); }
  return bookmarks;
});
internal('antares:move-bookmark', (e, id, toIndex) => {
  const i = bookmarks.findIndex((b) => b.id === id); if (i < 0) return bookmarks;
  const [b] = bookmarks.splice(i, 1); bookmarks.splice(Math.max(0, Math.min(toIndex, bookmarks.length)), 0, b);
  save('bookmarks', bookmarks); broadcastBookmarks(); return bookmarks;
});
internal('antares:history', (e, query, limit = 300, offset = 0) => {
  const q = String(query || '').toLowerCase();
  const list = q ? history.filter((h) => h.url.toLowerCase().includes(q) || (h.title || '').toLowerCase().includes(q)) : history;
  const o = Math.max(0, offset | 0); const l = Math.min(1000, Math.max(1, limit | 0));
  return { items: list.slice(o, o + l), total: list.length };
});
internal('antares:remove-history', (e, time, url) => { history = history.filter((h) => !(h.time === time && h.url === url)); save('history', history); return true; });
internal('antares:is-private', (e) => e.sender.session !== session.defaultSession);
internal('antares:top-sites', (e) => {
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
/* ---- Antares universe: spaces, orbits, missions, read later, shortcuts, star map */
const isPrivSender = (e) => e.sender.session !== session.defaultSession;
const senderWin = (e) => BrowserWin.fromWebContents(e.sender);
const cleanStr = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
internal('antares:universe', (e) => {
  if (isPrivSender(e)) return { private: true, spaces: [], orbits: [], missions: [], readLater: [], tabs: [] };
  const tabs = [];
  for (const w of normalWindows()) for (const t of w.tabs) tabs.push({ id: t.id, title: t.title, url: tabUrl(t), favicon: t.favicon, space: t.spaceId, active: t.id === w.activeId, sleeping: !!t.sleeping });
  return { spaces: spaceList(), orbits, missions, readLater, tabs, shortcuts: Array.isArray(settings.shortcuts) ? settings.shortcuts : DEFAULT_SHORTCUTS, recents: recentItems() };
});
internal('antares:space-action', (e, action, id, value) => {
  if (isPrivSender(e)) return null;
  const w = senderWin(e) || BrowserWin.focused();
  if (action === 'add') {
    const list = spaceList(); const nm = cleanStr(value, 24) || `Space ${list.length + 1}`;
    settings.spaces = [...list, { id: uid(), name: nm, color: SPACE_COLORS[list.length % SPACE_COLORS.length] }];
  } else if (action === 'rename') { const nm = cleanStr(value, 24); if (nm) settings.spaces = spaceList().map((x) => (x.id === id ? { ...x, name: nm } : x)); }
  else if (action === 'color') { if (/^#[0-9a-f]{6}$/i.test(String(value))) settings.spaces = spaceList().map((x) => (x.id === id ? { ...x, color: value } : x)); }
  else if (action === 'delete') { deleteSpace(id); return spaceList(); }
  else if (action === 'open') { if (w) w.switchSpace(id); return spaceList(); }
  else if (action === 'orbit') { if (w) w.saveSpaceAsOrbit(id); return spaceList(); }
  else if (action === 'go-tab') { for (const x of normalWindows()) { const t = x.tabs.find((y) => y.id === Number(id)); if (t) { x.activate(t.id); x.win.focus(); } } return spaceList(); }
  else return null;
  save('settings', settings); broadcastSpaces();
  return spaceList();
});
internal('antares:orbit-action', (e, action, id, value) => {
  if (isPrivSender(e)) return null;
  const w = senderWin(e) || BrowserWin.focused();
  if (action === 'open') { if (w) w.openOrbit(id); return orbits; }
  if (action === 'save') { if (w) w.saveSpaceAsOrbit(w.spaceId, cleanStr(value, 60) || null); return orbits; }
  if (action === 'rename') { const o = orbits.find((x) => x.id === id); const nm = cleanStr(value, 60); if (o && nm) o.name = nm; }
  else if (action === 'delete') orbits = orbits.filter((x) => x.id !== id);
  else if (action === 'remove-page') { const o = orbits.find((x) => x.id === id); if (o) o.tabs = (o.tabs || []).filter((x) => x.url !== value); }
  else return null;
  save('orbits', orbits); broadcastCollections(); return orbits;
});
internal('antares:mission-action', (e, action, id, value) => {
  if (isPrivSender(e)) return null;
  const w = senderWin(e) || BrowserWin.focused();
  const m = missions.find((x) => x.id === id);
  if (action === 'create') {
    const title = cleanStr(value && value.title, 80); if (!title) return missions;
    missions.unshift({ id: uid(), title, notes: cleanStr(value.notes, 2000), done: false, pages: [], tasks: [], created: Date.now(), updated: Date.now() });
  } else if (action === 'open') { if (w) w.openMission(id); return missions; }
  else if (!m) return missions;
  else if (action === 'update') {
    if (value && 'title' in value) { const t = cleanStr(value.title, 80); if (t) m.title = t; }
    if (value && 'notes' in value) m.notes = cleanStr(value.notes, 2000);
    if (value && 'done' in value) m.done = !!value.done;
    m.updated = Date.now();
  } else if (action === 'delete') missions = missions.filter((x) => x !== m);
  else if (action === 'add-task') { const t = cleanStr(value, 140); if (t) (m.tasks = m.tasks || []).push({ id: uid(), text: t, done: false }); }
  else if (action === 'toggle-task') { const t = (m.tasks || []).find((x) => x.id === value); if (t) t.done = !t.done; }
  else if (action === 'remove-task') m.tasks = (m.tasks || []).filter((x) => x.id !== value);
  else if (action === 'add-page') {
    const url = String(value && value.url || '');
    if (isWebUrl(url) && !(m.pages || []).some((x) => x.url === url)) (m.pages = m.pages || []).push({ url, title: cleanStr(value.title, 200) || url, favicon: '' });
  } else if (action === 'add-current') {
    if (w && w.active) { w.addToMission(id, w.active); return missions; }
  } else if (action === 'remove-page') m.pages = (m.pages || []).filter((x) => x.url !== value);
  else return null;
  if (m) m.updated = Date.now();
  save('missions', missions); broadcastCollections(); return missions;
});
internal('antares:readlater-action', (e, action, url) => {
  if (isPrivSender(e)) return [];
  if (action === 'remove') readLater = readLater.filter((x) => x.url !== url);
  else if (action === 'clear') readLater = [];
  else return readLater;
  save('readlater', readLater); broadcastCollections(); return readLater;
});
internal('antares:shortcuts', (e, list) => {
  if (isPrivSender(e)) return DEFAULT_SHORTCUTS;
  if (Array.isArray(list)) {
    settings.shortcuts = list.slice(0, 12).map((x) => ({ title: cleanStr(x && x.title, 40), url: String(x && x.url || '') }))
      .filter((x) => isWebUrl(x.url)).map((x) => ({ ...x, title: x.title || hostOf(x.url).replace(/^www\./, '') }));
    save('settings', settings); broadcastSettings();
  }
  return Array.isArray(settings.shortcuts) ? settings.shortcuts : DEFAULT_SHORTCUTS;
});
internal('antares:star-map', (e) => {
  // what the "Mapa Estelar" draws: spaces as constellations, open tabs as stars, most visited sites as distant stars
  if (isPrivSender(e)) return { private: true };
  const tabs = [];
  for (const w of normalWindows()) for (const t of w.tabs) tabs.push({ id: t.id, title: t.title, url: tabUrl(t), favicon: t.favicon, space: t.spaceId, active: t.id === w.activeId, sleeping: !!t.sleeping, opener: t.openerId });
  const counts = new Map();
  for (const h of history.slice(0, 4000)) {
    const host = hostOf(h.url); if (!host || !isWebUrl(h.url)) continue;
    const c = counts.get(host) || { host, n: 0, url: new URL(h.url).origin, favicon: h.favicon || '', last: h.time };
    c.n++; if (!c.favicon && h.favicon) c.favicon = h.favicon; counts.set(host, c);
  }
  const sites = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 40);
  return { spaces: spaceList(), tabs, sites, orbits: orbits.map((o) => ({ id: o.id, name: o.name, space: o.space, count: (o.tabs || []).length })), missions: missions.map((m) => ({ id: m.id, title: m.title, pages: (m.pages || []).length, done: !!m.done })) };
});
internal('antares:open', (e, url, newTab) => {
  const w = senderWin(e); if (!w || !(isWebUrl(url) || /^antares:\/\//.test(url))) return false;
  if (newTab) w.newTab(url, { background: false }); else { const t = w.tabs.find((x) => x.view.webContents === e.sender); if (t) t.view.webContents.loadURL(url).catch(() => {}); }
  return true;
});

internal('antares:downloads', (e) => {
  // a private window lists only its own downloads; normal windows never show private ones
  const priv = e.sender.session !== session.defaultSession;
  return downloads.filter((d) => !!d.private === priv)
    .map(({ private: p, ...d }) => ({ ...d, exists: d.state === 'completed' && !!d.path && fs.existsSync(d.path) }));
});
internal('antares:download-action', (e, id, action) => {
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
internal('antares:clear-downloads', (e) => {
  const priv = e.sender.session !== session.defaultSession;
  for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing' && !!downloads[i].private === priv) downloads.splice(i, 1);
  broadcastDownloads(); save('downloads', persistableDownloads()); return true;
});
internal('antares:open-downloads-folder', () => shell.openPath(app.getPath('downloads')));
internal('antares:clear-data', async (e, opts) => {
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
internal('antares:set-default', async () => {
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:defaultapps?registeredAppUser=Aurora');
  } else {
    app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https');
  }
  return isDefaultBrowser();
});
internal('antares:is-default', () => isDefaultBrowser());
internal('antares:import-bookmarks', async (e) => {
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
internal('antares:export-bookmarks', async (e) => {
  const w = BrowserWin.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(w ? w.win : undefined, { defaultPath: path.join(app.getPath('documents'), 'favoritos-aurora.html') });
  if (r.canceled || !r.filePath) return false;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const body = bookmarks.map((b) => `    <DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor(b.created / 1000)}">${esc(b.title)}</A>`).join('\n');
  fs.writeFileSync(r.filePath, `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${body}\n</DL><p>\n`);
  return true;
});

/* ------------------------------------------------------- engine update check */
// Antares cannot patch Chromium by itself; it checks whether a newer, fixed Electron/Chromium
// exists for its line and warns the user to install a newer Antares build.
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
  if (updateInfo.latest && cmpVer(updateInfo.latest, updateInfo.current) > 0) return `Saiu uma correção de segurança do motor Chromium (Electron ${updateInfo.latest}). Instale uma versão nova do Antares.`;
  if (!updateInfo.supported) return 'Esta versão do motor Chromium não recebe mais correções de segurança. Instale uma versão nova do Antares.';
  if (!updateInfo.checked && ageDays > 60) return 'Esta versão do Antares tem mais de 2 meses e pode estar sem correções de segurança recentes.';
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
// silently send the first installed certificate; Antares asks which one, if any, to send.
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
  orbits = load('orbits', []); missions = load('missions', []); readLater = load('readlater', []);
  if (!Array.isArray(orbits)) orbits = []; if (!Array.isArray(missions)) missions = []; if (!Array.isArray(readLater)) readLater = [];
  try { const th = load('thumbs', {}); for (const [k, v] of Object.entries(th || {})) if (typeof v === 'string' && v.startsWith('data:image/jpeg')) thumbs.set(k, v); } catch {}
  // from Aurora 1.x
  if (typeof settings.homepage === 'string' && /^aurora:/i.test(settings.homepage)) settings.homepage = settings.homepage.replace(/^aurora:/i, 'antares:');
  if (!['auto', 'orbit', 'focus'].includes(settings.layoutMode)) settings.layoutMode = 'auto';
  if (typeof settings.rightPanel !== 'boolean') settings.rightPanel = true;
  if (!Array.isArray(settings.spaces) || !settings.spaces.length) settings.spaces = DEFAULT_SPACES.map((x) => ({ ...x }));
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
    .replace(/\s?Electron\/\S+/i, '').replace(/\s?(aurora|antares)\/\S+/ig, '');

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
    const limit = Number(process.env.ANTARES_SLEEP_MS) || 30 * 60e3;
    for (const w of BrowserWin.all) for (const t of w.tabs) {
      const wc = t.view.webContents;
      if (t.id === w.activeId || t.sleeping || t.loading || t.closing || !isWebUrl(tabUrl(t))) continue;
      if (Date.now() - (t.lastActive || 0) < limit) continue;
      try { if (wc.isCurrentlyAudible() || wc.isDevToolsOpened() || wc.isBeingCaptured()) continue; } catch { continue; }
      w.sleepTab(t);
    }
  }, Number(process.env.ANTARES_SLEEP_MS) ? 3000 : 60e3);
});

app.on('before-quit', () => { if (settings) saveSession(true); });
app.on('will-quit', () => flushAll()); // only once every window is really gone (quitting can still be cancelled before that)
app.on('window-all-closed', () => { flushAll(); if (process.platform !== 'darwin') app.quit(); });
