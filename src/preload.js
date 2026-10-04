const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wlauncher', {
  play: (nickname, settings) => ipcRenderer.invoke('engine:play', nickname, settings),
  syncPack: (settings) => ipcRenderer.invoke('engine:sync-pack', settings),
  serverStatus: () => ipcRenderer.invoke('engine:server-status'),
  openGameDir: (settings) => ipcRenderer.invoke('app:open-game-dir', settings),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  onLog: (handler) => ipcRenderer.on('engine:log', (_event, line) => handler(line)),
  onProgress: (handler) => ipcRenderer.on('engine:progress', (_event, fraction) => handler(fraction)),
  onConfig: (handler) => ipcRenderer.on('config', (_event, cfg) => handler(cfg)),
});
