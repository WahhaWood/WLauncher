const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { ensureJava } = require('./minecraft/java');
const { ensureGame, MINECRAFT_VERSION } = require('./minecraft/installer');
const { prepareAndLaunch, offlineUuidFor } = require('./minecraft/launcher');
const { checkDiskSpace, humanBytes } = require('./minecraft/util');
const { pingServer } = require('./minecraft/server-status');

const PACKWIZ_BOOTSTRAP_SOURCE = path.join(__dirname, '..', 'vendor', 'packwiz', 'packwiz-installer-bootstrap.jar');
const DRY_RUN = process.env.WLAUNCHER_DRY_RUN === '1';

/**
 * Java cannot read files packed inside app.asar, so the bootstrap jar is
 * copied into the user's home on first use (and refreshed when it changes).
 */
let cachedBootstrap = null;
function bootstrapJar() {
  if (cachedBootstrap) return cachedBootstrap;
  const destDir = path.join(os.homedir(), '.wlauncher', 'bootstrap');
  const dest = path.join(destDir, 'packwiz-installer-bootstrap.jar');
  try {
    const data = fs.readFileSync(PACKWIZ_BOOTSTRAP_SOURCE);
    let upToDate = false;
    try {
      upToDate = fs.readFileSync(dest).equals(data);
    } catch {
      // not copied yet
    }
    if (!upToDate) {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(dest, data);
    }
    cachedBootstrap = dest;
    return dest;
  } catch {
    // fallback: source path (dev mode / asar unpacked)
    cachedBootstrap = PACKWIZ_BOOTSTRAP_SOURCE;
    return cachedBootstrap;
  }
}

function defaultGameDir() {
  return path.join(os.homedir(), '.wlauncher', 'game');
}

function statePath() {
  return path.join(os.homedir(), '.wlauncher', 'state.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const state = { ...readState(), ...patch };
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 1));
  } catch {
    // best effort
  }
}

/**
 * Check for crash reports created after the last launch.
 * Returns the newest crash report path or null.
 */
function findFreshCrash(gameDir, sinceMs) {
  const dir = path.join(gameDir, 'crash-reports');
  if (!fs.existsSync(dir)) return null;
  let newest = null;
  let newestTime = sinceMs || 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.txt')) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.mtimeMs > newestTime) {
        newest = full;
        newestTime = stat.mtimeMs;
      }
    }
  } catch {
    return null;
  }
  return newest;
}

/**
 * Full play flow: java → minecraft+neoforge → assets → packwiz sync → launch.
 * Every step is idempotent and reports progress.
 */
async function play({ config, nickname, settings = {}, onLog, onProgress } = {}) {
  const log = (line) => onLog?.(line);
  const gameDir = settings.gameDir || defaultGameDir();

  // 0. Disk space check (only when we may need to install things)
  const installed = fs.existsSync(path.join(gameDir, 'versions', MINECRAFT_VERSION, `${MINECRAFT_VERSION}.jar`));
  if (!installed) {
    const space = checkDiskSpace(gameDir, 2.5 * 1024 * 1024 * 1024);
    if (!space.ok && space.free !== null) {
      throw new Error(`Недостаточно места на диске: свободно ${humanBytes(space.free)}, нужно ~2.5 ГБ.`);
    }
  }

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

  // 4. Pack sync (packwiz). A failure here must NOT block the launch —
  // the player still has the files from the previous sync.
  if (config.packUrl) {
    log('Синхронизация сборки…');
    try {
      await runProcess(java, ['-jar', bootstrapJar(), '-g', config.packUrl], {
        cwd: gameDir,
        onLog: log,
      });
      log('Сборка синхронизирована.');
    } catch (err) {
      log(`ПРЕДУПРЕЖДЕНИЕ: не удалось обновить сборку (${firstLine(err.message)}).`);
      log('Запускаю с текущими файлами.');
    }
  }

  // 5. Launch detached: the game must survive the launcher closing.
  log('Запуск игры…');
  const child = await launchGame(launch.java, launch.args, {
    cwd: launch.gameDir,
    onLog: log,
    watchFor: 12000,
  });

  writeState({ lastLaunch: Date.now(), gameDir });

  // The game is running — tell the caller (main.js) so it can close the launcher.
  return { pid: child?.pid ?? null, launched: true };
}

/**
 * Manual pack sync (for the "Проверить сборку" button).
 */
async function syncPack({ config, settings = {}, onLog } = {}) {
  const log = (line) => onLog?.(line);
  if (!config.packUrl) throw new Error('В config.json не задан packUrl.');
  const gameDir = settings.gameDir || defaultGameDir();
  const java = await ensureJava({ onLog: log });
  log('Проверка сборки…');
  await runProcess(java, ['-jar', bootstrapJar(), '-g', config.packUrl], {
    cwd: gameDir,
    onLog: log,
  });
  log('Сборка проверена и обновлена.');
  return { ok: true };
}

/**
 * Server status for the UI.
 */
async function serverStatus(config) {
  if (!config.server) return { configured: false };
  const result = await pingServer(config.server);
  return { configured: true, address: config.server, ...result };
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
        const hint = code === 1 ? ' Проверь выделение ОЗУ в настройках.' : '';
        reject(new Error(`Игра завершилась сразу после запуска (код ${code}). Полный лог: ${gameLog}` + hint));
      }
    });
  });
}

function runProcess(executable, args, { cwd, onLog = () => {} } = {}) {
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
    child.on('close', (code) =>
      code === 0 ? resolve(child) : reject(new Error(`${path.basename(executable)} завершился с кодом ${code}`))
    );
  });
}

function firstLine(text) {
  return String(text).split('\n')[0].trim();
}

module.exports = {
  play,
  syncPack,
  serverStatus,
  findFreshCrash,
  writeState,
  readState,
  defaultGameDir,
  offlineUuidFor,
  DRY_RUN,
};
