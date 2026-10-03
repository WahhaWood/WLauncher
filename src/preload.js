const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wlauncher', {
  info: () => ipcRenderer.invoke('engine:info'),
  play: (nickname) => ipcRenderer.invoke('engine:play', nickname),
  onLog: (handler) => ipcRenderer.on('engine:log', (_event, line) => handler(line)),
  onConfig: (handler) => ipcRenderer.on('config', (_event, cfg) => handler(cfg)),
});
