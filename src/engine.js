const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { spawn } = require('child_process');
const { ensureJava } = require('./minecraft/java');
const { ensureGame, MINECRAFT_VERSION } = require('./minecraft/installer');
const { prepareAndLaunch, offlineUuidFor } = require('./minecraft/launcher');
const { checkDiskSpace, humanBytes, download, extractZip, dataDir, rotateFile } = require('./minecraft/util');
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
  const destDir = path.join(dataDir(), 'bootstrap');
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
  return path.join(dataDir(), 'game');
}

function statePath() {
  return path.join(dataDir(), 'state.json');
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

  // 4. Pack sync. A failure here must NOT block the launch —
  // the player still has the files from the previous sync.
  // manifestUrl (zip + manifest.json, see wahha-pack/build-pack.py) is the
  // primary format; packUrl (packwiz bootstrap) remains as a fallback.
  if (config.manifestUrl) {
    log('Синхронизация сборки…');
    try {
      await syncPackFromManifest({ manifestUrl: config.manifestUrl, gameDir, onLog: log, onProgress });
      log('Сборка синхронизирована.');
    } catch (err) {
      log(`ПРЕДУПРЕЖДЕНИЕ: не удалось обновить сборку (${firstLine(err.message)}).`);
      log('Запускаю с текущими файлами.');
    }
  } else if (config.packUrl) {
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

function packStatePath(gameDir) {
  return path.join(gameDir, '.wlauncher-pack.json');
}

function readPackState(gameDir) {
  try {
    return JSON.parse(fs.readFileSync(packStatePath(gameDir), 'utf8'));
  } catch {
    return {};
  }
}

function writePackState(gameDir, state) {
  try {
    fs.mkdirSync(path.dirname(packStatePath(gameDir)), { recursive: true });
    fs.writeFileSync(packStatePath(gameDir), JSON.stringify(state, null, 1));
  } catch {
    // best effort
  }
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Pack sync from manifest.json (see wahha-pack/build-pack.py).
 * Downloads only archives whose sha256 changed, verifies the hash, extracts
 * over gameDir and removes stale jars from mods/. Archives are deleted after
 * a successful apply (they duplicate the extracted content); an unchanged
 * pack is verified in place instead of re-downloaded. Pure Node.
 */
async function syncPackFromManifest({ manifestUrl, gameDir, onLog, onProgress } = {}) {
  const log = (line) => onLog?.(line);
  if (!manifestUrl) throw new Error('Не задан manifestUrl сборки.');

  const res = await fetch(manifestUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${manifestUrl}`);
  const manifest = await res.json();
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Некорректный manifest.json сборки.');
  }
  const base = manifest.baseUrl || manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);

  fs.mkdirSync(gameDir, { recursive: true });
  const cacheDir = path.join(dataDir(), 'cache', 'pack');
  fs.mkdirSync(cacheDir, { recursive: true });
  const state = readPackState(gameDir);

  // Verifies the pack is fully on disk without the archives (they are
  // deleted after apply). Mods and overlay are checked independently so a
  // damaged mod re-downloads only its shards. Results are cached per sync —
  // files only appear during it, so a positive answer stays valid.
  const isModsArchive = (name) => name.startsWith('mods-');
  let modsOk = null;
  let overlayOk = null;
  function verifyAppliedFiles(archiveName) {
    if (isModsArchive(archiveName)) {
      if (modsOk === null) modsOk = checkModsFiles();
      return modsOk;
    }
    if (overlayOk === null) overlayOk = checkOverlayFiles();
    return overlayOk;
  }
  function checkModsFiles() {
    try {
      if (!Array.isArray(manifest.mods)) return true;
      const modsDir = path.join(gameDir, 'mods');
      for (const name of manifest.mods) {
        if (!fs.existsSync(path.join(modsDir, name))) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  function checkOverlayFiles() {
    try {
      if (!Array.isArray(manifest.overlay)) return true;
      for (const rel of manifest.overlay) {
        const full = safeGamePath(gameDir, rel);
        if (!full || !fs.existsSync(full)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  let n = 0;
  for (const file of manifest.files) {
    n++;
    if (!file.name || !file.sha256) throw new Error('Некорректный manifest.json сборки.');
    const cached = path.join(cacheDir, path.basename(file.name));
    let fresh = false;
    try {
      fresh = fs.existsSync(cached) && sha256File(cached) === file.sha256;
    } catch {
      fresh = false;
    }
    const appliedKey = `applied:${file.name}`;
    const applied = state[appliedKey] === file.sha256;
    if (!fresh && applied && verifyAppliedFiles(file.name)) {
      log(`${file.name}: уже установлен, пропуск.`);
      onProgress?.(n / manifest.files.length);
      continue;
    }
    if (!fresh) {
      log(`Скачивание ${file.name}${file.size ? ` (${humanBytes(file.size)})` : ''}…`);
      await download(base + file.name, cached, (received, total) => {
        if (total) onProgress?.(((n - 1) + received / total) / manifest.files.length);
      });
      const actual = sha256File(cached);
      if (actual !== file.sha256) {
        fs.rmSync(cached, { force: true });
        throw new Error(`Хеш ${file.name} не совпал — файл удалён, попробуйте ещё раз.`);
      }
    } else {
      log(`${file.name}: уже скачан, хеш совпал.`);
    }
    onProgress?.(n / manifest.files.length);

    if (!fresh || !applied) {
      log(`Распаковка ${file.name}…`);
      await extractZip(cached, gameDir);
      state[appliedKey] = file.sha256;
      // Overlay archives carry config/kubejs: refresh the installed list so
      // files removed from the pack can be cleaned up below.
      if (Array.isArray(manifest.overlay) && !file.name.startsWith('mods-')) {
        state.overlayFiles = manifest.overlay;
      }
      writePackState(gameDir, state);
    }
    // Archives are deleted after a successful apply: they duplicate the
    // extracted content (~830M). A missing archive is simply re-downloaded
    // when its sha changes; unchanged packs are verified in place (above).
    fs.rmSync(cached, { force: true });
  }

  // Leftover of the old packwiz flow — never part of the pack.
  fs.rmSync(path.join(gameDir, 'packwiz-installer.jar'), { force: true });

  // Stale jars from a previous pack version must go, otherwise NeoForge
  // loads both the old and the new copy of a mod. Launcher caches
  // (Modrinth/Prism leftovers) are never part of the pack either.
  if (Array.isArray(manifest.mods)) {
    const keep = new Set(manifest.mods);
    const modsDir = path.join(gameDir, 'mods');
    if (fs.existsSync(modsDir)) {
      let removed = 0;
      for (const name of fs.readdirSync(modsDir)) {
        const full = path.join(modsDir, name);
        if (name === '.index' || name === '_disabled_orphans') {
          fs.rmSync(full, { recursive: true, force: true });
          removed++;
        } else if (name.endsWith('.jar') && !keep.has(name)) {
          fs.rmSync(full, { force: true });
          removed++;
        }
      }
      if (removed > 0) log(`Удалено устаревших файлов в mods/: ${removed}.`);
    }
  }

  // Overlay files removed from the pack must go too (a deleted KubeJS
  // script would otherwise keep running). Only files this sync previously
  // installed are eligible — player-generated files are never touched.
  if (Array.isArray(manifest.overlay)) {
    const prev = Array.isArray(state.overlayFiles) ? state.overlayFiles : [];
    const keep = new Set(manifest.overlay);
    let removed = 0;
    for (const rel of prev) {
      if (keep.has(rel)) continue;
      const full = safeGamePath(gameDir, rel);
      if (full && fs.existsSync(full)) {
        fs.rmSync(full, { force: true });
        removed++;
      }
    }
    if (removed > 0) log(`Удалено устаревших файлов сборки: ${removed}.`);
    state.overlayFiles = manifest.overlay;
  }

  state.version = manifest.packVersion || state.version;
  writePackState(gameDir, state);
  return { ok: true, version: manifest.packVersion };
}

/**
 * Manual pack sync (for the "Проверить сборку" button).
 */
async function syncPack({ config, settings = {}, onLog } = {}) {
  const log = (line) => onLog?.(line);
  const gameDir = settings.gameDir || defaultGameDir();
  if (config.manifestUrl) {
    await syncPackFromManifest({ manifestUrl: config.manifestUrl, gameDir, onLog: log });
    log('Сборка проверена и обновлена.');
    return { ok: true };
  }
  if (!config.packUrl) throw new Error('В config.json не задан packUrl.');
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

  const logDir = path.join(dataDir(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const gameLog = path.join(logDir, 'game-out.log');
  rotateFile(gameLog, 8 * 1024 * 1024);

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

/**
 * Resolves a manifest-relative path inside gameDir, rejecting absolute
 * paths and anything escaping it.
 */
function safeGamePath(gameDir, rel) {
  const cleaned = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(gameDir, cleaned);
  const base = path.resolve(gameDir);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

module.exports = {
  play,
  syncPack,
  syncPackFromManifest,
  serverStatus,
  findFreshCrash,
  writeState,
  readState,
  defaultGameDir,
  offlineUuidFor,
  DRY_RUN,
};
