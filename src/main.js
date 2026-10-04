const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const { play } = require('./engine');

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

ipcMain.handle('engine:play', async (_event, nickname, settings) => {
  const pattern = new RegExp(config.nicknamePattern || '^[A-Za-z0-9_]{3,16}$');
  if (!pattern.test(nickname || '')) {
    return { ok: false, error: 'Ник должен быть 3–16 символов: латиница, цифры и подчёркивание.' };
  }

  const log = (line) => send('engine:log', line);
  const onProgress = (fraction) => send('engine:progress', fraction);

  try {
    log(`Ник: ${nickname}`);
    const result = await play({ config, nickname, settings, onLog: log, onProgress });
    if (result.launched) {
      log('Игра запущена. Закрываем лаунчер.');
      app.quit();
    }
    return { ok: true, ...result };
  } catch (err) {
    log(`ОШИБКА: ${err.message}`);
    return { ok: false, error: err.message };
  }
});
