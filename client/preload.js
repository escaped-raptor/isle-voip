// The only bridge between the page and the desktop shell.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('isleDesktop', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  steamLogin: (server) => ipcRenderer.invoke('auth:steam', server),
  loadSession: (server) => ipcRenderer.invoke('session:load', server),
  saveSession: (server, token) => ipcRenderer.invoke('session:save', server, token),
  clearSession: (server) => ipcRenderer.invoke('session:clear', server),
  setPttKey: (binding) => ipcRenderer.invoke('keys:setPtt', binding),
  captureKey: () => ipcRenderer.invoke('keys:capture'),
  tapKey: (code) => ipcRenderer.invoke('keys:tap', code),
  onPtt: (cb) => ipcRenderer.on('ptt', (_e, down) => cb(down))
});
