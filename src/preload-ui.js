'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const send = (ch) => (...a) => ipcRenderer.send(ch, ...a);
contextBridge.exposeInMainWorld('chrome2', {
  newTab: send('ui:new-tab'), closeTab: send('ui:close-tab'), activate: send('ui:activate'),
  navigate: send('ui:navigate'), open: send('ui:open'), back: send('ui:back'), forward: send('ui:forward'),
  reload: send('ui:reload'), stop: send('ui:stop'), home: send('ui:home'), bookmark: send('ui:bookmark'),
  menu: send('ui:menu'), internal: send('ui:internal'), zoom: send('ui:zoom'), mute: send('ui:mute'),
  heights: send('ui:heights'), focusPage: send('ui:focus-page'), find: send('ui:find'), stopFind: send('ui:stop-find'),
  moveTab: send('ui:move-tab'), tabMenu: send('ui:tab-menu'), bookmarkMenu: send('ui:bookmark-menu'),
  popupMenu: send('ui:popup-menu'), siteMenu: send('ui:site-menu'), shieldMenu: send('ui:shield-menu'), openUpdate: send('ui:open-update'), dismissUpdate: send('ui:dismiss-update'),
  suggest: (t) => ipcRenderer.invoke('ui:suggest', t),
  on: (ch, fn) => {
    const ok = ['init', 'tabs', 'tab', 'bookmarks', 'settings', 'downloads', 'download-started', 'focus-address', 'show-find', 'find-result', 'fullscreen', 'update'];
    if (ok.includes(ch)) ipcRenderer.on(ch, (e, ...a) => fn(...a));
  },
});
