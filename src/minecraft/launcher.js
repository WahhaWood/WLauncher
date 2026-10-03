const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileAsync } = require('./java');
const { MINECRAFT_VERSION } = require('./installer');

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

/**
 * Downloads every library and asset the version json references, then builds
 * the final launch command. Libraries are filtered by OS rules, natives are
 * extracted, assets are fetched by hash.
 */
async function prepareAndLaunch({ java, versionJson, gameDir, nickname, server, onLog, onProgress } = {}) {
  if (process.env.WLAUNCHER_DRY_RUN === '1') {
    onLog?.('[dry-run] Подготовка ассетов и библиотек (пропуск)');
    return { java, args: ['-cp', '<classpath>', 'net.neoforged.fml.startup.Client', '--username', nickname, '--quickPlayMultiplayer', server || ''], mainClass: 'net.neoforged.fml.startup.Client', gameDir };
  }

  const nativesDir = path.join(gameDir, 'natives');
  const assetsDir = path.join(gameDir, 'assets');
  const objectsDir = path.join(assetsDir, 'objects');
  const librariesDir = path.join(gameDir, 'libraries');
  const indexesDir = path.join(assetsDir, 'indexes');
  const versionsDir = path.join(gameDir, 'versions');

  fs.mkdirSync(nativesDir, { recursive: true });
  fs.mkdirSync(objectsDir, { recursive: true });
  fs.mkdirSync(librariesDir, { recursive: true });
  fs.mkdirSync(indexesDir, { recursive: true });

  // --- Libraries ---
  const libs = (versionJson.libraries || []).filter((lib) => matchesRules(lib.rules));
  const classpathEntries = [];

  // The client jar itself must be on the classpath
  const clientJar = path.join(versionsDir, MINECRAFT_VERSION, `${MINECRAFT_VERSION}.jar`);
  if (fs.existsSync(clientJar)) {
    classpathEntries.push(clientJar);
  }

  for (let i = 0; i < libs.length; i++) {
    const lib = libs[i];
    const artifact = lib.downloads?.artifact;
    if (!artifact) continue;

    const dest = path.join(librariesDir, artifact.path);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await downloadWithRetry(artifact.url, dest);
    }
    classpathEntries.push(dest);

    // Natives: extract the classifier jar into the natives directory
    const nativeKey = process.platform === 'win32' ? 'natives-windows' : process.platform === 'darwin' ? 'natives-macos' : 'natives-linux';
    const classifier = lib.natives?.[nativeKey];
    if (classifier) {
      const nativeArtifact = lib.downloads?.classifiers?.[classifier];
      if (nativeArtifact) {
        const nativeJar = path.join(librariesDir, nativeArtifact.path);
        if (!fs.existsSync(nativeJar)) {
          fs.mkdirSync(path.dirname(nativeJar), { recursive: true });
          await downloadWithRetry(nativeArtifact.url, nativeJar);
        }
        await extractZip(nativeJar, nativesDir);
      }
    }

    onProgress?.((i + 1) / (libs.length + 1) * 0.6);
  }

  // --- Assets ---
  const assetIndex = versionJson.assetIndex;
  if (assetIndex) {
    const indexJson = await fetchJsonCached(assetIndex.url, path.join(indexesDir, `${assetIndex.id}.json`));
    const objects = Object.values(indexJson.objects || {});
    const total = objects.length;

    for (let i = 0; i < total; i++) {
      const obj = objects[i];
      const hash = obj.hash;
      const prefix = hash.slice(0, 2);
      const dest = path.join(objectsDir, prefix, hash);
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await downloadWithRetry(`https://resources.download.minecraft.net/${prefix}/${hash}`, dest);
      }
      if (i % 20 === 0) onProgress?.(0.6 + (i / total) * 0.4);
    }
  }

  onLog?.('Все файлы скачаны.');

  // --- Build the launch command ---
  const classpath = classpathEntries.join(path.delimiter);
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
    [PLACEHOLDERS.resolution_height]: '1080',
    [PLACEHOLDERS.resolution_width]: '1920',
  };

  const jvmArgs = [];
  const gameArgs = [];

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

  // Auto-join the server (remove any vanilla quickPlay args first to avoid duplicates)
  const filteredGameArgs = gameArgs.filter((a) => !a.startsWith('--quickPlay'));
  if (server) {
    filteredGameArgs.push('--quickPlayMultiplayer', server);
  }

  const mainClass = versionJson.mainClass;
  if (!mainClass) throw new Error('mainClass не найден в version json');

  // JVM options first, then the main class, then game arguments
  const fullArgs = [...jvmArgs, mainClass, ...filteredGameArgs];

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
  let allowed = false;
  for (const rule of rules) {
    const osMatch = !rule.os || rule.os.name === (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux');
    if (rule.action === 'allow' && osMatch) allowed = true;
    if (rule.action === 'disallow' && osMatch) return false;
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

async function downloadWithRetry(url, dest, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = fs.createWriteStream(dest);
      for await (const chunk of res.body) file.write(chunk);
      file.end();
      await new Promise((resolve, reject) => file.on('finish', resolve).on('error', reject));
      return;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function fetchJsonCached(url, cachePath) {
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      // fall through to download
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  const data = await res.json();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(data));
  return data;
}

async function extractZip(zipPath, destDir) {
  if (process.platform === 'win32') {
    await execFileAsync('tar', ['-xf', zipPath, '-C', destDir]);
  } else {
    await execFileAsync('tar', ['-xf', zipPath, '-C', destDir]);
  }
}

module.exports = { prepareAndLaunch, offlineUuidFor };
