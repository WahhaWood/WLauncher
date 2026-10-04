const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wlauncher', {
  play: (nickname, settings) => ipcRenderer.invoke('engine:play', nickname, settings),
  onLog: (handler) => ipcRenderer.on('engine:log', (_event, line) => handler(line)),
  onProgress: (handler) => ipcRenderer.on('engine:progress', (_event, fraction) => handler(fraction)),
  onConfig: (handler) => ipcRenderer.on('config', (_event, cfg) => handler(cfg)),
});
