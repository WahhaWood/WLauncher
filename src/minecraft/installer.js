const fs = require('fs');
const path = require('path');
const os = require('os');
const { download, execFileAsync } = require('./java');

const MINECRAFT_VERSION = '26.1.2';
const NEOFORGE_VERSION = '26.1.2.114';
const NEOFORGE_INSTALLER_URL = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-installer.jar`;

/**
 * Installs vanilla Minecraft + NeoForge into a game directory.
 * The NeoForge installer produces a self-contained version json that we read
 * back to build the launch command.
 */
async function ensureGame({ java, gameDir, onLog, onProgress } = {}) {
  if (process.env.WLAUNCHER_DRY_RUN === '1') {
    onLog?.('[dry-run] Minecraft 26.1.2 + NeoForge 26.1.2.114 (пропуск)');
    return { gameDir: gameDir || '/tmp/opencode/game', versionJson: { id: 'neoforge-26.1.2.114', mainClass: 'net.neoforged.fml.startup.Client', arguments: { jvm: [], game: [] }, libraries: [], assetIndex: { id: '30', url: 'https://example.com/30.json' } } };
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
    const manifest = await fetchJson(
      'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
    );
    const entry = manifest.versions.find((v) => v.id === MINECRAFT_VERSION);
    if (!entry) throw new Error(`Версия ${MINECRAFT_VERSION} не найдена в манифесте`);

    const versionJson = await fetchJson(entry.url);
    fs.writeFileSync(path.join(mcDir, `${MINECRAFT_VERSION}.json`), JSON.stringify(versionJson));

    const clientJar = path.join(mcDir, `${MINECRAFT_VERSION}.jar`);
    await download(versionJson.downloads.client.url, clientJar, onProgress);
  }

  // 2. NeoForge installer
  if (!fs.existsSync(nfJson)) {
    onLog?.('Установка NeoForge…');
    const installer = path.join(gameDir, 'neoforge-installer.jar');
    if (!fs.existsSync(installer)) {
      await download(NEOFORGE_INSTALLER_URL, installer, onProgress);
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
      nfVersionJson.libraries = [...(parent.libraries || []), ...(nfVersionJson.libraries || [])];
      nfVersionJson.arguments = {
        jvm: [...(parent.arguments?.jvm || []), ...(nfVersionJson.arguments?.jvm || [])],
        game: [...(parent.arguments?.game || []), ...(nfVersionJson.arguments?.game || [])],
      };
      if (!nfVersionJson.assetIndex && parent.assetIndex) nfVersionJson.assetIndex = parent.assetIndex;
      if (!nfVersionJson.assets && parent.assets) nfVersionJson.assets = parent.assets;
    }
  }

  onLog?.('Minecraft + NeoForge готовы.');
  return { gameDir, versionJson: nfVersionJson };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  return res.json();
}

module.exports = { ensureGame, MINECRAFT_VERSION, NEOFORGE_VERSION };
