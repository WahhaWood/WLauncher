const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Config can live next to the exe (portable override) or inside the app.
// The portable override lets you change server/pack URL without rebuilding.
function loadConfig() {
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'config.json'));
  }
  candidates.push(path.join(path.dirname(process.execPath), 'config.json'));
  candidates.push(path.join(__dirname, '..', 'config.json'));

  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { data, file };
    } catch {
      // try next
    }
  }
  throw new Error('config.json не найден');
}

const { data: config, file: configFile } = loadConfig();
const { play, syncPack, serverStatus, findFreshCrash, readState, defaultGameDir } = require('./engine');

let mainWindow = null;

// Everything the launcher prints also goes to a log file next to the launcher
// data, so failures can be diagnosed without reading the in-app console.
function logPath() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'launcher.log');
}

function appendLogFile(line) {
  try {
    fs.appendFileSync(logPath(), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // logging must never break the launcher
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 470,
    height: 620,
    resizable: true,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#14161c',
    title: 'WLauncher',
    icon: path.join(__dirname, 'ui', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.webContents.send('config', {
    server: config.server,
    packUrl: config.packUrl,
    version: app.getVersion(),
  });
}

app.whenReady().then(async () => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // After the window appears: report a crash that happened after the last launch.
  const state = readState();
  if (state.lastLaunch) {
    const gameDir = state.gameDir || defaultGameDir();
    const crash = findFreshCrash(gameDir, state.lastLaunch);
    if (crash) {
      appendLogFile(`Найден краш-репорт: ${crash}`);
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Похоже, игра упала',
        message: 'Найден краш-репорт после последнего запуска.',
        detail: path.basename(crash),
        buttons: ['Открыть краш-репорт', 'Показать папку', 'Закрыть'],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) shell.openPath(crash);
      if (response === 1) shell.showItemInFolder(crash);
    }
  }
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('engine:play', async (_event, nickname, settings) => {
  const pattern = new RegExp(config.nicknamePattern || '^[A-Za-z0-9_]{3,16}$');
  if (!pattern.test(nickname || '')) {
    return { ok: false, error: 'Ник должен быть 3–16 символов: латиница, цифры и подчёркивание.' };
  }

  const started = new Date();
  appendLogFile(`=== Запуск ${started.toISOString()} | ник: ${nickname} | настройки: ${JSON.stringify(settings || {})}`);
  appendLogFile(`ОС: ${os.type()} ${os.release()} | RAM: ${(os.totalmem() / 1024 ** 3).toFixed(1)} ГБ | лог: ${logPath()}`);

  const log = (line) => {
    appendLogFile(line);
    send('engine:log', line);
  };
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
    await showErrorDialog('Не удалось запустить игру', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('engine:sync-pack', async (_event, settings) => {
  const log = (line) => {
    appendLogFile(line);
    send('engine:log', line);
  };
  try {
    await syncPack({ config, settings, onLog: log });
    return { ok: true };
  } catch (err) {
    log(`ОШИБКА синхронизации: ${err.message}`);
    await showErrorDialog('Не удалось обновить сборку', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('engine:server-status', async () => {
  try {
    return await serverStatus(config);
  } catch (err) {
    return { configured: !!config.server, error: err.message };
  }
});

ipcMain.handle('app:open-game-dir', async (_event, settings) => {
  const gameDir = settings?.gameDir || defaultGameDir();
  fs.mkdirSync(gameDir, { recursive: true });
  await shell.openPath(gameDir);
});

ipcMain.handle('app:open-logs', () => {
  shell.showItemInFolder(logPath());
});

async function showErrorDialog(title, message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title,
    message,
    buttons: ['Открыть лог', 'Закрыть'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response === 0) shell.showItemInFolder(logPath());
}
