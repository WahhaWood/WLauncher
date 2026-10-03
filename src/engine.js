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
async function play({ config, nickname, onLog, onProgress } = {}) {
  const log = (line) => onLog?.(line);

  // 1. Java
  log('Проверка Java…');
  const java = await ensureJava({ onLog: log, onProgress });

  // 2. Minecraft + NeoForge
  log('Проверка Minecraft…');
  const { versionJson } = await ensureGame({ java, onLog: log, onProgress });

  // 3. Assets + libraries + launch command
  log('Подготовка запуска…');
  const launch = await prepareAndLaunch({
    java,
    versionJson,
    gameDir: gameDir(),
    nickname,
    server: config.server,
    onLog: log,
    onProgress,
  });

  // 4. Pack sync (packwiz) — runs before the game starts
  if (config.packUrl) {
    log('Синхронизация сборки…');
    await runProcess(java, ['-jar', PACKWIZ_BOOTSTRAP, config.packUrl], {
      cwd: instanceDir(),
      onLog: log,
    });
  }

  // 5. Launch
  log('Запуск игры…');
  const child = await runProcess(launch.java, launch.args, {
    cwd: launch.gameDir,
    onLog: log,
  });

  // The game is running — our job is done, close the launcher.
  log('Игра запущена. Закрываем лаунчер.');
  app.quit();

  return { pid: child?.pid ?? null };
}

function runProcess(executable, args, { cwd, onLog = () => {} } = {}) {
  if (DRY_RUN) {
    onLog(`[dry-run] ${executable} ${args.slice(0, 6).join(' ')}…`);
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: false });
    const forward = (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach(onLog);

    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);
    child.on('spawn', () => resolve(child));
  });
}

module.exports = { play, offlineUuidFor, gameDir, instanceDir };
