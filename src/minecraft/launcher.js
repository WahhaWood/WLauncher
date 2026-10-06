const fs = require('fs');
const path = require('path');
const os = require('os');
const { downloadPool, fetchJsonCached, extractZip, humanBytes } = require('./util');
const { ensureServerEntry } = require('./servers-dat');

const PLACEHOLDERS = {
  auth_player_name: '${auth_player_name}',
  auth_uuid: '${auth_uuid}',
  auth_access_token: '${auth_access_token}',
  auth_xuid: '${auth_xuid}',
  user_type: '${user_type}',
  user_properties: '${user_properties}',
  auth_session: '${auth_session}',
  version_name: '${version_name}',
  version_type: '${version_type}',
  game_directory: '${game_directory}',
  game_assets: '${game_assets}',
  assets_root: '${assets_root}',
  assets_index_name: '${assets_index_name}',
  library_directory: '${library_directory}',
  classpath: '${classpath}',
  classpath_separator: '${classpath_separator}',
  natives_directory: '${natives_directory}',
  launcher_name: '${launcher_name}',
  launcher_version: '${launcher_version}',
  clientid: '${clientid}',
  quickPlayMultiplayer: '${quickPlayMultiplayer}',
  quickPlayPath: '${quickPlayPath}',
  quickPlayRealms: '${quickPlayRealms}',
  quickPlaySingleplayer: '${quickPlaySingleplayer}',
  resolution_height: '${resolution_height}',
  resolution_width: '${resolution_width}',
};

// Aikar's flags: the community standard for smooth G1GC behaviour in Minecraft.
const AIKAR_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
];

/**
 * Downloads every library and asset the version json references, then builds
 * the final launch command. Libraries and assets are fetched in parallel.
 */
async function prepareAndLaunch({ java, versionJson, gameDir, nickname, server, settings = {}, onLog, onProgress } = {}) {
  if (process.env.WLAUNCHER_DRY_RUN === '1') {
    onLog?.('[dry-run] Подготовка ассетов и библиотек (пропуск)');
    const mainClass = 'cpw.mods.bootstraplauncher.BootstrapLauncher';
    return {
      java,
      args: ['-cp', '<classpath>', mainClass, '--username', nickname, '--quickPlayMultiplayer', server || ''],
      mainClass,
      gameDir,
    };
  }

  const nativesDir = path.join(gameDir, 'natives');
  const assetsDir = path.join(gameDir, 'assets');
  const objectsDir = path.join(assetsDir, 'objects');
  const librariesDir = path.join(gameDir, 'libraries');
  const indexesDir = path.join(assetsDir, 'indexes');

  fs.mkdirSync(nativesDir, { recursive: true });
  fs.mkdirSync(objectsDir, { recursive: true });
  fs.mkdirSync(librariesDir, { recursive: true });
  fs.mkdirSync(indexesDir, { recursive: true });

  // The server goes into the multiplayer list (servers.dat) instead of an
  // auto-join flag: the player picks it themselves, and the entry survives
  // pack updates. Our own entries are matched by ip, others are untouched.
  if (server) {
    try {
      ensureServerEntry(gameDir, server, `WLauncher | ${server}`);
    } catch (err) {
      onLog?.(`Не удалось записать servers.dat: ${err.message}`);
    }
  }

  const tasks = [];
  const classpathEntries = [];

  // The vanilla client jar deliberately stays OFF the classpath. Under NeoForge
  // the game code comes from the installer-generated SRG jar (an explicit
  // `minecraft` module), and adding the vanilla jar puts a second module
  // (_1._21._1) on the layer that exports net.minecraft.client.main too —
  // ModLauncher then aborts with a ResolutionException.

  // --- Libraries ---
  const libs = (versionJson.libraries || []).filter((lib) => matchesRules(lib.rules));
  const nativeKey = process.platform === 'win32' ? 'natives-windows' : process.platform === 'darwin' ? 'natives-macos' : 'natives-linux';
  let nativeCount = 0;

  for (const lib of libs) {
    const artifact = lib.downloads?.artifact;
    if (!artifact) continue;

    const dest = path.join(librariesDir, artifact.path);
    if (!fs.existsSync(dest)) {
      tasks.push({ url: artifact.url, dest, kind: 'library' });
    }

    // Since 1.20.5 the shared libraries ship as separate `<artifact>-natives-<os>`
    // artifacts instead of old-style classifiers. They must be unpacked into the
    // natives directory — LWJGL loads them from there via java.library.path.
    if (/-natives-/.test(artifact.path)) {
      tasks.push({ url: null, dest, extract: nativesDir, kind: 'native' });
      nativeCount++;
      continue;
    }

    classpathEntries.push(dest);

    const classifier = lib.natives?.[nativeKey];
    if (classifier) {
      const nativeArtifact = lib.downloads?.classifiers?.[classifier];
      if (nativeArtifact) {
        const nativeJar = path.join(librariesDir, nativeArtifact.path);
        if (!fs.existsSync(nativeJar)) {
          tasks.push({ url: nativeArtifact.url, dest: nativeJar, kind: 'library' });
        }
        tasks.push({ url: null, dest: nativeJar, extract: nativesDir, kind: 'native' });
        nativeCount++;
      }
    }
  }

  // --- Assets ---
  const assetIndex = versionJson.assetIndex;
  if (assetIndex) {
    const indexJson = await fetchJsonCached(assetIndex.url, path.join(indexesDir, `${assetIndex.id}.json`));
    for (const obj of Object.values(indexJson.objects || {})) {
      const hash = obj.hash;
      const prefix = hash.slice(0, 2);
      const dest = path.join(objectsDir, prefix, hash);
      if (!fs.existsSync(dest)) {
        tasks.push({ url: `https://resources.download.minecraft.net/${prefix}/${hash}`, dest, kind: 'asset' });
      }
    }
  }

  const toDownload = tasks.filter((t) => t.url);
  const toExtract = tasks.filter((t) => t.extract);

  if (toDownload.length > 0) {
    onLog?.(`Скачивание файлов: ${toDownload.length} шт.`);
    await downloadPool(toDownload, {
      concurrency: 16,
      onProgress: (state) => {
        const fraction = state.total ? state.done / state.total : 1;
        onProgress?.(fraction);
        if (state.done % 25 === 0 || state.done === state.total) {
          onLog?.(`Файлы: ${state.done}/${state.total} · ${humanBytes(state.bytes)}`);
        }
      },
    });
  }

  // Extract natives after their jars are downloaded
  for (const task of toExtract) {
    if (fs.existsSync(task.dest)) {
      await extractZip(task.dest, task.extract);
    }
  }
  if (nativeCount > 0) onLog?.(`Нативные библиотеки распакованы: ${nativeCount}.`);

  if (toDownload.length === 0) onLog?.('Все файлы уже на месте.');
  onProgress?.(1);
  onLog?.('Все файлы скачаны.');

  // --- Build the launch command ---
  // securejarhandler rejects a classpath that lists the same jar twice.
  const classpath = [...new Set(classpathEntries)].join(path.delimiter);
  const offlineUuid = offlineUuidFor(nickname);

  const values = {
    [PLACEHOLDERS.auth_player_name]: nickname,
    [PLACEHOLDERS.auth_uuid]: offlineUuid,
    [PLACEHOLDERS.auth_access_token]: '0',
    [PLACEHOLDERS.user_type]: 'legacy',
    [PLACEHOLDERS.user_properties]: '{}',
    [PLACEHOLDERS.auth_session]: '0',
    [PLACEHOLDERS.version_name]: versionJson.id,
    [PLACEHOLDERS.version_type]: 'release',
    [PLACEHOLDERS.game_directory]: gameDir,
    [PLACEHOLDERS.game_assets]: path.join(assetsDir, 'virtual', 'legacy'),
    [PLACEHOLDERS.assets_root]: assetsDir,
    [PLACEHOLDERS.assets_index_name]: assetIndex?.id || versionJson.assets,
    [PLACEHOLDERS.library_directory]: librariesDir,
    [PLACEHOLDERS.classpath]: classpath,
    [PLACEHOLDERS.classpath_separator]: path.delimiter,
    [PLACEHOLDERS.natives_directory]: nativesDir,
    [PLACEHOLDERS.launcher_name]: 'WLauncher',
    [PLACEHOLDERS.launcher_version]: '1.0',
    [PLACEHOLDERS.auth_xuid]: '',
    [PLACEHOLDERS.clientid]: '',
    [PLACEHOLDERS.quickPlayMultiplayer]: server || '',
    [PLACEHOLDERS.quickPlayPath]: '',
    [PLACEHOLDERS.quickPlayRealms]: '',
    [PLACEHOLDERS.quickPlaySingleplayer]: '',
    [PLACEHOLDERS.resolution_height]: String(settings.height || 1080),
    [PLACEHOLDERS.resolution_width]: String(settings.width || 1920),
  };

  const jvmArgs = [];
  const gameArgs = [];

  // RAM settings. Never allocate more than the machine can actually give:
  // a 4 GB VM with -Xmx4096M makes the JVM die before the game even starts.
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  const safeMax = Math.max(1024, totalMb - 1536);
  let maxRam = settings.maxRam || 2048;
  let minRam = settings.minRam || 512;
  if (maxRam > safeMax) {
    onLog?.(`ОЗУ: запрошено ${maxRam} МБ, но на машине всего ${totalMb} МБ — снижаю до ${safeMax} МБ.`);
    maxRam = safeMax;
  }
  if (minRam > maxRam) minRam = maxRam;
  jvmArgs.push(`-Xms${minRam}M`, `-Xmx${maxRam}M`);

  // Aikar's flags (on by default, can be disabled in settings)
  if (settings.aikarFlags !== false) {
    jvmArgs.push(...AIKAR_FLAGS);
    onLog?.('JVM: применяю оптимизированные флаги (Aikar).');
  }
  onLog?.(`Память: -Xms${minRam}M -Xmx${maxRam}M (всего ОЗУ ${totalMb} МБ)`);

  // Custom JVM args from settings go last so they can override ours
  if (settings.jvmArgs) {
    jvmArgs.push(...settings.jvmArgs.split(/\s+/).filter(Boolean));
  }

  for (const arg of versionJson.arguments?.jvm || []) {
    if (typeof arg === 'string') jvmArgs.push(substitute(arg, values));
    else if (arg.rules && !matchesRules(arg.rules)) continue;
    else if (typeof arg.value === 'string') jvmArgs.push(substitute(arg.value, values));
    else if (Array.isArray(arg.value)) jvmArgs.push(...arg.value.map((v) => substitute(v, values)));
  }

  for (const arg of versionJson.arguments?.game || []) {
    if (typeof arg === 'string') gameArgs.push(substitute(arg, values));
    else if (arg.rules && !matchesRules(arg.rules)) continue;
    else if (typeof arg.value === 'string') gameArgs.push(substitute(arg.value, values));
    else if (Array.isArray(arg.value)) gameArgs.push(...arg.value.map((v) => substitute(v, values)));
  }

  // Auto-join is intentionally NOT used: the server lives in servers.dat
  // (written above) so the player chooses when to join. Vanilla still lists
  // each quickPlay option as two entries, so drop any it declares to avoid a
  // stray substituted address lingering as a positional argument.
  const filteredGameArgs = [];
  for (let i = 0; i < gameArgs.length; i++) {
    const arg = gameArgs[i];
    if (arg.startsWith('--quickPlay')) {
      i++; // also drop the value that follows the flag
      continue;
    }
    filteredGameArgs.push(arg);
  }

  // Remove --demo flag and empty arguments
  const cleanGameArgs = filteredGameArgs.filter((a) => a && a !== '--demo');

  // Fullscreen
  if (settings.fullscreen) {
    cleanGameArgs.push('--fullscreen', 'true');
  }

  const mainClass = versionJson.mainClass;
  if (!mainClass) throw new Error('mainClass не найден в version json');

  // JVM options first, then the main class, then game arguments
  const fullArgs = [...jvmArgs, mainClass, ...cleanGameArgs];

  onLog?.(`Запуск: ${mainClass}`);
  return { java, args: fullArgs, mainClass, gameDir };
}

function substitute(template, values) {
  let result = template;
  for (const [placeholder, value] of Object.entries(values)) {
    result = result.split(placeholder).join(value);
  }
  return result;
}

function matchesRules(rules) {
  if (!rules || rules.length === 0) return true;
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const arch = process.arch;
  let allowed = false;
  for (const rule of rules) {
    const nameMatch = !rule.os || !rule.os.name || rule.os.name === osName;
    const archMatch = !rule.os || !rule.os.arch || rule.os.arch === arch;
    if (nameMatch && archMatch) {
      if (rule.action === 'allow') allowed = true;
      if (rule.action === 'disallow') return false;
    }
  }
  return allowed;
}

function offlineUuidFor(nickname) {
  const crypto = require('crypto');
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${nickname}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = { prepareAndLaunch, offlineUuidFor };
