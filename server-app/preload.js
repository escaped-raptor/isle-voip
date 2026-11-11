// Bridge for the setup page running inside the server app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serverApp', {
  versionLabel: ipcRenderer.sendSync('app:versionLabel'),
  pickFile: () => ipcRenderer.invoke('app:pickFile'),
  setupFinished: () => ipcRenderer.send('app:setupFinished')
});
