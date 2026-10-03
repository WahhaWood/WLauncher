const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'vendor', 'fjord');
const ENGINE_EXE = path.join(ENGINE_DIR, 'fjordlauncher.exe');
const PACKWIZ_BOOTSTRAP = path.join(ROOT, 'vendor', 'packwiz', 'packwiz-installer-bootstrap.jar');

// Lets us print the command instead of running it (used for automated checks).
const DRY_RUN = process.env.WLAUNCHER_DRY_RUN === '1';

function describeEngine(config) {
  return {
    installed: fs.existsSync(ENGINE_EXE),
    enginePath: ENGINE_EXE,
    server: config.server || '',
  };
}

function instanceDir(profileDir, instanceId) {
  return path.join(profileDir, 'instances', instanceId);
}

/**
 * First-run preparation: hand our prepared instance to the engine.
 * The engine supports importing from a local path or URL, so the pack
 * itself can stay in git (mrpack / packwiz zip) instead of being baked in.
 */
async function prepare({ config, profileDir, packSource, onLog }) {
  fs.mkdirSync(profileDir, { recursive: true });

  const target = instanceDir(profileDir, config.instanceId);
  if (fs.existsSync(path.join(target, 'instance.cfg'))) {
    onLog(`Инстанс ${config.instanceId} уже подготовлен.`);
    return { prepared: false };
  }

  if (!packSource) {
    throw new Error(
      'Нет источника сборки: заполни config.json -> packUrl (ссылка на .mrpack) или укажи локальный файл.'
    );
  }

  onLog('Первая подготовка: импорт сборки в движок...');
  await runEngine({ profileDir, flags: ['--import', packSource], onLog });
  if (DRY_RUN) return { prepared: true, dryRun: true };

  // The import runs asynchronously inside the engine; wait for the instance.
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(target, 'instance.cfg'))) {
      onLog('Сборка импортирована.');
      return { prepared: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Импорт не завершился за 10 минут — смотри лог.');
}

/**
 * Mod sync is done by us, not by the engine, so we keep full control of the
 * order: sync -> launch. The engine downloads a Java runtime for the game on
 * first run; we reuse that same runtime to run the packwiz installer.
 */
function findJava(profileDir) {
  const roots = [path.join(profileDir, 'java'), path.join(profileDir, 'runtime')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of walk(root)) {
      if (path.basename(dir) === 'bin' && fs.existsSync(path.join(dir, 'javaw.exe'))) {
        return path.join(dir, 'javaw.exe');
      }
    }
  }
  return null;
}

function* walk(dir, depth = 0) {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  yield dir;
  for (const entry of entries) {
    if (entry.isDirectory()) yield* walk(path.join(dir, entry.name), depth + 1);
  }
}

async function syncPack({ config, profileDir, onLog }) {
  if (!config.packUrl) {
    onLog('Синхронизация сборки пропущена: не задан packUrl.');
    return { synced: false };
  }
  if (DRY_RUN) {
    onLog(`[dry-run] packwiz-installer-bootstrap ${config.packUrl}`);
    return { synced: true, dryRun: true };
  }

  const java = findJava(profileDir);
  if (!java) {
    onLog('Java ещё не скачан движком — синхронизация отложена на следующий запуск.');
    return { synced: false };
  }

  onLog('Обновление сборки...');
  await runProcess(java, ['-jar', PACKWIZ_BOOTSTRAP, config.packUrl], {
    cwd: instanceDir(profileDir, config.instanceId),
    onLog,
  });
  onLog('Сборка обновлена.');
  return { synced: true };
}

/**
 * Launch flow: the engine starts the instance hidden (no --show-window),
 * offline under the nickname the friend typed, and auto-joins our server.
 */
async function launch({ config, nickname, profileDir, onLog }) {
  const flags = ['--launch', config.instanceId, '--offline', nickname];
  if (config.server) flags.push('--server', config.server);

  onLog(`Запуск: ник ${nickname}${config.server ? ', сервер ' + config.server : ''}`);
  const child = await runEngine({ profileDir, flags, onLog });

  return {
    pid: child ? child.pid : null,
    command: [ENGINE_EXE, '-d', profileDir, ...flags].join(' '),
  };
}

function runEngine({ profileDir, flags, onLog = () => {} }) {
  const args = ['-d', profileDir, ...flags];

  if (DRY_RUN) {
    onLog(`[dry-run] ${ENGINE_EXE} ${args.join(' ')}`);
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE_EXE, args, { cwd: ENGINE_DIR, windowsHide: true });
    const forward = (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach(onLog);

    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);
    child.on('spawn', () => resolve(child));
  });
}

function runProcess(executable, args, { cwd, onLog = () => {} } = {}) {
  if (DRY_RUN) {
    onLog(`[dry-run] ${executable} ${args.join(' ')}`);
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

module.exports = {
  describeEngine,
  prepare,
  syncPack,
  launch,
  findJava,
  instanceDir,
  ENGINE_EXE,
  ENGINE_DIR,
  PACKWIZ_BOOTSTRAP,
  ROOT,
};
