'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, payload) => cb(payload)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
});
