const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const ADOPTIUM_API = 'https://api.adoptium.net/v3';

/**
 * Downloads a Temurin JRE and extracts it. Returns the path to the java binary.
 * Uses a single JRE for both the NeoForge installer and the game itself.
 */
async function ensureJava({ onLog, onProgress } = {}) {
  if (process.env.WLAUNCHER_DRY_RUN === '1') {
    onLog?.('[dry-run] Java 25 (пропуск скачивания)');
    return 'java';
  }

  const dest = path.join(os.homedir(), '.wlauncher', 'jre');
  const marker = path.join(dest, 'ok.txt');

  if (fs.existsSync(marker)) {
    const java = findJava(dest);
    if (java) {
      onLog?.('Java уже установлена.');
      return java;
    }
  }

  const isWindows = process.platform === 'win32';
  const ext = isWindows ? 'zip' : 'tar.gz';
  const url = `${ADOPTIUM_API}/binary/latest/25/ga/${process.platform === 'win32' ? 'windows' : 'linux'}/x64/jre/hotspot/normal/eclipse`;
  const archive = path.join(dest, `jre25.${ext}`);

  fs.mkdirSync(dest, { recursive: true });

  onLog?.('Скачивание Java 25…');
  await download(url, archive, onProgress);

  onLog?.('Распаковка Java…');
  fs.rmSync(path.join(dest, 'jdk-25'), { recursive: true, force: true });
  if (isWindows) {
    await execFileAsync('tar', ['-xf', archive, '-C', dest]);
  } else {
    await execFileAsync('tar', ['-xzf', archive, '-C', dest]);
  }

  const java = findJava(dest);
  if (!java) throw new Error('Java не найдена после распаковки');

  fs.writeFileSync(marker, java, 'utf8');
  fs.rmSync(archive, { force: true });
  onLog?.('Java готова.');
  return java;
}

function findJava(root) {
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    const name = process.platform === 'win32' ? 'javaw.exe' : 'java';
    if (fs.existsSync(path.join(dir, name))) {
      return path.join(dir, name);
    }
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
      }
    } catch {
      // ignore unreadable directories
    }
  }
  return null;
}

function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const file = fs.createWriteStream(dest);
  let received = 0;
  for await (const chunk of res.body) {
    received += chunk.length;
    file.write(chunk);
    if (total && onProgress) onProgress(received / total);
  }
  file.end();
  await new Promise((resolve, reject) => file.on('finish', resolve).on('error', reject));
}

module.exports = { ensureJava, findJava, download, execFileAsync };
