'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Shortcuts that web apps may use themselves (Ctrl+S, Ctrl+F, Ctrl+H, Ctrl+D, Ctrl+P, Ctrl+J, Ctrl+U, Ctrl+K):
// after the page has handled the key, tell the browser whether the page claimed it.
// Runs in every frame, isolated from the page's own scripts; synthetic (untrusted) events are ignored.
const SHORTCUT_KEYS = new Set(['s', 'f', 'h', 'd', 'p', 'j', 'u', 'k']);
window.addEventListener('keydown', (e) => {
  if (!e.isTrusted) return;
  const mod = /Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey || e.shiftKey) return;
  const k = String(e.key || '').toLowerCase();
  if (!SHORTCUT_KEYS.has(k)) return;
  setTimeout(() => ipcRenderer.send('page:key', k, e.defaultPrevented), 0);
}, true);
if (location.protocol === 'antares:' && window.top === window) {
  const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
  contextBridge.exposeInMainWorld('antares', {
    settings: inv('antares:settings'), setSettings: inv('antares:set-settings'), resolve: inv('antares:resolve'),
    bookmarks: inv('antares:bookmarks'), removeBookmark: inv('antares:remove-bookmark'), editBookmark: inv('antares:edit-bookmark'),
    moveBookmark: inv('antares:move-bookmark'), importBookmarks: inv('antares:import-bookmarks'), exportBookmarks: inv('antares:export-bookmarks'),
    history: inv('antares:history'), removeHistory: inv('antares:remove-history'), topSites: inv('antares:top-sites'), isPrivate: inv('antares:is-private'),
    downloads: inv('antares:downloads'), downloadAction: inv('antares:download-action'), clearDownloads: inv('antares:clear-downloads'),
    openDownloadsFolder: inv('antares:open-downloads-folder'), clearData: inv('antares:clear-data'),
    updateFilters: inv('antares:update-filters'), checkUpdate: inv('antares:check-update'),
    clearExceptions: inv('antares:clear-exceptions'), allowHttp: inv('antares:allow-http'),
    setDefault: inv('antares:set-default'), isDefault: inv('antares:is-default'),
    universe: inv('antares:universe'), spaceAction: inv('antares:space-action'), orbitAction: inv('antares:orbit-action'),
    missionAction: inv('antares:mission-action'), readLaterAction: inv('antares:readlater-action'), shortcuts: inv('antares:shortcuts'),
    starMap: inv('antares:star-map'), open: inv('antares:open'),
    appUpdate: inv('antares:app-update'), appUpdateCheck: inv('antares:app-update-check'), appUpdateInstall: inv('antares:app-update-install'), setAutoUpdate: inv('antares:set-auto-update'),
  });
}
