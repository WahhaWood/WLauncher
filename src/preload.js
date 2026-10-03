const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wlauncher', {
  play: (nickname) => ipcRenderer.invoke('engine:play', nickname),
  onLog: (handler) => ipcRenderer.on('engine:log', (_event, line) => handler(line)),
  onProgress: (handler) => ipcRenderer.on('engine:progress', (_event, fraction) => handler(fraction)),
  onConfig: (handler) => ipcRenderer.on('config', (_event, cfg) => handler(cfg)),
});
