'use strict';
/* Narrow bridge between the windows and the main process. No Node access in the pages. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  dispatch: (action) => ipcRenderer.invoke('state:dispatch', action),
  onState: (fn) => { ipcRenderer.on('state', (_e, s) => fn(s)); },
  getMeta: () => ipcRenderer.invoke('meta:get'),
  onMeta: (fn) => { ipcRenderer.on('meta', (_e, m) => fn(m)); },
  onView: (fn) => { ipcRenderer.on('studio:view', (_e, v) => fn(v)); },
  openStudio: (view) => ipcRenderer.send('studio:open', view),
  toggleWidget: () => ipcRenderer.send('widget:toggle'),
  widgetMenu: () => ipcRenderer.send('widget:menu'),
  resizeStart: () => ipcRenderer.send('resize:start'),
  resizeMove: () => ipcRenderer.send('resize:move'),
  resizeEnd: () => ipcRenderer.send('resize:end'),
  moveStart: () => ipcRenderer.send('move:start'),
  moveMove: () => ipcRenderer.send('move:move'),
  moveEnd: () => ipcRenderer.send('move:end'),
  undock: () => ipcRenderer.send('dock:release'),
  pickPhoto: () => ipcRenderer.invoke('photo:pick'),
  exportCsv: (kind) => ipcRenderer.invoke('export:csv', kind),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  installUpdate: () => ipcRenderer.send('update:install'),
});
