'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const send = (ch) => (...a) => ipcRenderer.send(ch, ...a);
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('chrome2', {
  newTab: send('ui:new-tab'), closeTab: send('ui:close-tab'), activate: send('ui:activate'),
  navigate: send('ui:navigate'), open: send('ui:open'), back: send('ui:back'), forward: send('ui:forward'),
  reload: send('ui:reload'), stop: send('ui:stop'), home: send('ui:home'), bookmark: send('ui:bookmark'),
  menu: send('ui:menu'), internal: send('ui:internal'), zoom: send('ui:zoom'), mute: send('ui:mute'),
  layout: send('ui:layout'), win: send('ui:win'), focusPage: send('ui:focus-page'), find: send('ui:find'), stopFind: send('ui:stop-find'),
  moveTab: send('ui:move-tab'), tabMenu: send('ui:tab-menu'), bookmarkMenu: send('ui:bookmark-menu'),
  popupMenu: send('ui:popup-menu'), siteMenu: send('ui:site-menu'), shieldMenu: send('ui:shield-menu'), openUpdate: send('ui:open-update'), dismissUpdate: send('ui:dismiss-update'),
  space: send('ui:space'), split: send('ui:split'), capture: send('ui:capture'), device: send('ui:device'), readLater: send('ui:read-later'),
  missionMenu: send('ui:mission-menu'), setSetting: send('ui:set-setting'), paletteRun: send('ui:palette-run'),
  orbit: send('ui:orbit'), mission: send('ui:mission'),
  suggest: inv('ui:suggest'), media: inv('ui:media'), mediaAction: inv('ui:media-action'),
  perf: inv('ui:perf'), perfAction: inv('ui:perf-action'), palette: inv('ui:palette'),
  on: (ch, fn) => {
    const ok = ['init', 'tabs', 'tab', 'bookmarks', 'settings', 'downloads', 'download-started', 'focus-address', 'show-find', 'find-result', 'fullscreen', 'update',
      'spaces', 'collections', 'recents', 'split', 'win-state', 'win-focus', 'palette', 'toggle-mode', 'space-rename', 'device-frame'];
    if (ok.includes(ch)) ipcRenderer.on(ch, (e, ...a) => fn(...a));
  },
});
