'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Shortcuts that web apps may use themselves (Ctrl+S, Ctrl+F, Ctrl+H, Ctrl+D, Ctrl+P, Ctrl+J, Ctrl+U):
// after the page has handled the key, tell the browser whether the page claimed it.
// Runs in every frame, isolated from the page's own scripts; synthetic (untrusted) events are ignored.
const SHORTCUT_KEYS = new Set(['s', 'f', 'h', 'd', 'p', 'j', 'u']);
window.addEventListener('keydown', (e) => {
  if (!e.isTrusted) return;
  const mod = /Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey || e.shiftKey) return;
  const k = String(e.key || '').toLowerCase();
  if (!SHORTCUT_KEYS.has(k)) return;
  setTimeout(() => ipcRenderer.send('page:key', k, e.defaultPrevented), 0);
}, true);
if (location.protocol === 'aurora:' && window.top === window) {
  const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
  contextBridge.exposeInMainWorld('aurora', {
    settings: inv('aurora:settings'), setSettings: inv('aurora:set-settings'), resolve: inv('aurora:resolve'),
    bookmarks: inv('aurora:bookmarks'), removeBookmark: inv('aurora:remove-bookmark'), editBookmark: inv('aurora:edit-bookmark'),
    moveBookmark: inv('aurora:move-bookmark'), importBookmarks: inv('aurora:import-bookmarks'), exportBookmarks: inv('aurora:export-bookmarks'),
    history: inv('aurora:history'), removeHistory: inv('aurora:remove-history'), topSites: inv('aurora:top-sites'), isPrivate: inv('aurora:is-private'),
    downloads: inv('aurora:downloads'), downloadAction: inv('aurora:download-action'), clearDownloads: inv('aurora:clear-downloads'),
    openDownloadsFolder: inv('aurora:open-downloads-folder'), clearData: inv('aurora:clear-data'),
    updateFilters: inv('aurora:update-filters'), checkUpdate: inv('aurora:check-update'),
    clearExceptions: inv('aurora:clear-exceptions'), allowHttp: inv('aurora:allow-http'),
    setDefault: inv('aurora:set-default'), isDefault: inv('aurora:is-default'),
  });
}
