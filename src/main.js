const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const { describeEngine, prepare, syncPack, launch } = require('./engine');

let mainWindow = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 600,
    resizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#14161c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.webContents.send('config', { server: config.server });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('engine:info', () => describeEngine(config));

ipcMain.handle('engine:play', async (_event, nickname) => {
  const pattern = new RegExp(config.nicknamePattern || '^[A-Za-z0-9_]{3,16}$');
  if (!pattern.test(nickname || '')) {
    return { ok: false, error: 'Ник должен быть 3–16 символов: латиница, цифры и подчёркивание.' };
  }

  const profileDir = path.join(app.getPath('userData'), 'engine');
  const log = (line) => send('engine:log', line);

  try {
    await prepare({ config, profileDir, packSource: config.packUrl, onLog: log });
    await syncPack({ config, profileDir, onLog: log });

    const result = await launch({
      config,
      nickname,
      profileDir,
      onLog: log,
    });
    return { ok: true, ...result };
  } catch (err) {
    send('engine:log', `ОШИБКА: ${err.message}`);
    return { ok: false, error: err.message };
  }
});
