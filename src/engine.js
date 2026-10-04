const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { ensureJava } = require('./minecraft/java');
const { ensureGame } = require('./minecraft/installer');
const { prepareAndLaunch, offlineUuidFor } = require('./minecraft/launcher');

const PACKWIZ_BOOTSTRAP = path.join(__dirname, '..', 'vendor', 'packwiz', 'packwiz-installer-bootstrap.jar');
const DRY_RUN = process.env.WLAUNCHER_DRY_RUN === '1';
function gameDir() {
  return path.join(os.homedir(), '.wlauncher', 'game');
}

function instanceDir() {
  return path.join(gameDir(), 'instances', 'WLauncher');
}

/**
 * Full play flow: java → minecraft+neoforge → assets → packwiz sync → launch.
 * Every step is idempotent and reports progress.
 */
async function play({ config, nickname, settings = {}, onLog, onProgress } = {}) {
  const log = (line) => onLog?.(line);
  const gameDir = settings.gameDir || path.join(os.homedir(), '.wlauncher', 'game');

  // 1. Java
  log('Проверка Java…');
  const java = await ensureJava({ onLog: log, onProgress });

  // 2. Minecraft + NeoForge
  log('Проверка Minecraft…');
  const { versionJson } = await ensureGame({ java, gameDir, onLog: log, onProgress });

  // 3. Assets + libraries + launch command
  log('Подготовка запуска…');
  const launch = await prepareAndLaunch({
    java,
    versionJson,
    gameDir,
    nickname,
    server: config.server,
    settings,
    onLog: log,
    onProgress,
  });

  // 4. Pack sync (packwiz) — runs before the game starts
  if (config.packUrl) {
    log('Синхронизация сборки…');
    await runProcess(java, ['-jar', PACKWIZ_BOOTSTRAP, '-g', config.packUrl], {
      cwd: gameDir,
      onLog: log,
    });
  }

  // 5. Launch detached: the game must survive the launcher closing.
  log('Запуск игры…');
  const child = await launchGame(launch.java, launch.args, {
    cwd: launch.gameDir,
    onLog: log,
    watchFor: 12000,
  });

  // The game is running — tell the caller (main.js) so it can close the launcher.
  return { pid: child?.pid ?? null, launched: true };
}

/**
 * Launches the game fully detached with output going to a log file.
 * Piping into the launcher would kill the game the moment the launcher
 * closes (the pipe breaks and Electron tears the child process down).
 */
function launchGame(executable, args, { cwd, onLog = () => {}, watchFor = 12000 } = {}) {
  if (DRY_RUN) {
    onLog(`[dry-run] ${executable} ${args.slice(0, 6).join(' ')}…`);
    return Promise.resolve(null);
  }

  const logDir = path.join(os.homedir(), '.wlauncher', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const gameLog = path.join(logDir, 'game-out.log');

  const fd = fs.openSync(gameLog, 'a');
  fs.writeSync(fd, `\n===== Запуск ${new Date().toISOString()} =====\n`);

  const child = spawn(executable, args, {
    cwd,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();

  // Mirror new lines from the game's log into the launcher window.
  let offset = 0;
  try {
    offset = fs.statSync(gameLog).size;
  } catch {
    // ignore
  }
  const forwardNew = () => {
    try {
      const size = fs.statSync(gameLog).size;
      if (size <= offset) return;
      const len = size - offset;
      const buf = Buffer.alloc(len);
      const fdr = fs.openSync(gameLog, 'r');
      fs.readSync(fdr, buf, 0, len, offset);
      fs.closeSync(fdr);
      offset = size;
      String(buf).split(/\r?\n/).filter(Boolean).forEach(onLog);
    } catch {
      // ignore
    }
  };
  const tailTimer = setInterval(forwardNew, 700);

  return new Promise((resolve, reject) => {
    let settled = false;

    child.on('error', (err) => {
      if (tailTimer) clearInterval(tailTimer);
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      reject(err);
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (tailTimer) clearInterval(tailTimer);
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
        resolve(child);
      }
    }, watchFor);

    child.on('exit', (code) => {
      forwardNew();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (tailTimer) clearInterval(tailTimer);
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
        reject(new Error(`Игра завершилась сразу после запуска (код ${code}). Полный лог: ${gameLog}`));
      }
    });
  });
}

function runProcess(executable, args, { cwd, onLog = () => {}, watchFor = 0 } = {}) {
  if (DRY_RUN) {
    onLog(`[dry-run] ${executable} ${args.slice(0, 6).join(' ')}…`);
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true });
    const forward = (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach(onLog);

    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);

    if (watchFor > 0) {
      // Give the game time to crash if it's going to. If it survives, we're good.
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(child);
        }
      }, watchFor);
      child.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Игра завершилась сразу после запуска (код ${code}). Смотри лог выше — там причина.`));
        }
      });
    } else {
      child.on('spawn', () => resolve(child));
    }
  });
}

module.exports = { play, offlineUuidFor, gameDir, instanceDir };
