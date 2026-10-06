const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { download, execFileAsync, fetchJsonCached, humanBytes } = require('./util');

const MINECRAFT_VERSION = '1.21.1';
const NEOFORGE_VERSION = '21.1.251';
const NEOFORGE_INSTALLER_URL = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-installer.jar`;
const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const MANIFEST_TTL = 3 * 60 * 60 * 1000; // 3 часа

function cacheDir() {
  return path.join(os.homedir(), '.wlauncher', 'cache');
}

function sha1(buffer) {
  return createHash('sha1').update(buffer).digest('hex');
}

/**
 * Installs vanilla Minecraft + NeoForge into a game directory.
 * The NeoForge installer produces a self-contained version json that we read
 * back to build the launch command.
 */
async function ensureGame({ java, gameDir, onLog, onProgress } = {}) {
  if (process.env.WLAUNCHER_DRY_RUN === '1') {
    onLog?.(`[dry-run] Minecraft ${MINECRAFT_VERSION} + NeoForge ${NEOFORGE_VERSION} (пропуск)`);
    return {
      gameDir: gameDir || '/tmp/opencode/game',
      versionJson: {
        id: `neoforge-${NEOFORGE_VERSION}`,
        mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
        arguments: { jvm: [], game: [] },
        libraries: [],
        assetIndex: { id: '17', url: 'https://example.com/17.json' },
      },
    };
  }

  const versionsDir = path.join(gameDir, 'versions');
  const mcDir = path.join(versionsDir, MINECRAFT_VERSION);
  const nfDir = path.join(versionsDir, `neoforge-${NEOFORGE_VERSION}`);
  const nfJson = path.join(nfDir, `neoforge-${NEOFORGE_VERSION}.json`);

  fs.mkdirSync(gameDir, { recursive: true });

  // 1. Vanilla version json + client jar (the installer needs these present)
  if (!fs.existsSync(path.join(mcDir, `${MINECRAFT_VERSION}.json`))) {
    onLog?.('Скачивание Minecraft…');
    fs.mkdirSync(mcDir, { recursive: true });
    const manifest = await fetchJsonCached(MANIFEST_URL, path.join(cacheDir(), 'version_manifest.json'), MANIFEST_TTL);
    const entry = manifest.versions.find((v) => v.id === MINECRAFT_VERSION);
    if (!entry) throw new Error(`Версия ${MINECRAFT_VERSION} не найдена в манифесте`);

    const versionJson = await fetchJsonCached(entry.url, path.join(cacheDir(), `version-${MINECRAFT_VERSION}.json`));
    fs.writeFileSync(path.join(mcDir, `${MINECRAFT_VERSION}.json`), JSON.stringify(versionJson));

    const clientJar = path.join(mcDir, `${MINECRAFT_VERSION}.jar`);
    let lastReported = 0;
    await download(versionJson.downloads.client.url, clientJar, (received, total) => {
      onProgress?.(total ? received / total : 0);
      if (received - lastReported > 5 * 1024 * 1024) {
        lastReported = received;
        onLog?.(`Minecraft: ${humanBytes(received)}${total ? ` / ${humanBytes(total)}` : ''}`);
      }
    });

    // The NeoForge installer patches this jar; a truncated or corrupted download
    // would only surface as an opaque installer failure much later.
    const expected = versionJson.downloads.client.sha1;
    const actual = sha1(fs.readFileSync(clientJar));
    if (expected && actual !== expected) {
      fs.rmSync(clientJar, { force: true });
      throw new Error('Хеш Minecraft не совпал — файл повреждён при скачивании. Он удалён, попробуйте ещё раз.');
    }
  }

  // 2. NeoForge installer
  if (!fs.existsSync(nfJson)) {
    onLog?.('Установка NeoForge…');
    const installer = path.join(gameDir, 'neoforge-installer.jar');
    if (!fs.existsSync(installer)) {
      await download(NEOFORGE_INSTALLER_URL, installer);
    }

    // The installer requires a vanilla launcher profile to exist
    const profilesPath = path.join(gameDir, 'launcher_profiles.json');
    if (!fs.existsSync(profilesPath)) {
      fs.writeFileSync(profilesPath, JSON.stringify({ profiles: {}, selectedProfile: 'game', clientToken: 'wlauncher' }, null, 1));
    }

    await execFileAsync(java, ['-jar', installer, '--install-client', gameDir]);
    fs.rmSync(installer, { force: true });
  }

  if (!fs.existsSync(nfJson)) throw new Error('NeoForge не установился: version json не найден');

  // NeoForge's version json inherits libraries and arguments from vanilla.
  // Merge them so we have everything in one place.
  const nfVersionJson = JSON.parse(fs.readFileSync(nfJson, 'utf8'));
  if (nfVersionJson.inheritsFrom) {
    const parentJson = path.join(versionsDir, nfVersionJson.inheritsFrom, `${nfVersionJson.inheritsFrom}.json`);
    if (fs.existsSync(parentJson)) {
      const parent = JSON.parse(fs.readFileSync(parentJson, 'utf8'));
      const parentLibs = parent.libraries || [];
      const merged = dedupeLibraries([...parentLibs, ...(nfVersionJson.libraries || [])]);
      const duplicates = parentLibs.length + (nfVersionJson.libraries || []).length - merged.length;
      if (duplicates > 0) onLog?.(`Объединено библиотек: дубликатов отброшено ${duplicates}.`);
      nfVersionJson.libraries = merged;
      nfVersionJson.arguments = {
        jvm: [...(parent.arguments?.jvm || []), ...(nfVersionJson.arguments?.jvm || [])],
        game: [...(parent.arguments?.game || []), ...(nfVersionJson.arguments?.game || [])],
      };
      if (!nfVersionJson.assetIndex && parent.assetIndex) nfVersionJson.assetIndex = parent.assetIndex;
      if (!nfVersionJson.assets && parent.assets) nfVersionJson.assets = parent.assets;
    }
  } else {
    nfVersionJson.libraries = dedupeLibraries(nfVersionJson.libraries || []);
  }

  onLog?.('Minecraft + NeoForge готовы.');
  return { gameDir, versionJson: nfVersionJson };
}

/**
 * NeoForge repeats several libraries that vanilla already declares. Listing the
 * same jar twice makes securejarhandler abort with "Duplicate key", so keep only
 * the first entry — the vanilla one, which is what the official launcher does.
 */
function dedupeLibraries(libs) {
  const seen = new Set();
  const result = [];
  for (const lib of libs) {
    const key = lib.downloads?.artifact?.path || lib.name;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(lib);
  }
  return result;
}

module.exports = { ensureGame, MINECRAFT_VERSION, NEOFORGE_VERSION };
