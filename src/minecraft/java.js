const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileAsync, download, humanBytes } = require('./util');

const ADOPTIUM_API = 'https://api.adoptium.net/v3';
const REQUIRED_MAJOR = 25;

/**
 * Returns a path to a usable Java 25+.
 * Order: system Java (PATH / common locations) -> previously downloaded -> download Temurin.
 */
async function ensureJava({ onLog, onProgress } = {}) {
  if (process.env.WLAUNCHER_DRY_RUN === '1') {
    onLog?.('[dry-run] Java 25 (пропуск скачивания)');
    return 'java';
  }

  const system = await findSystemJava(onLog);
  if (system) return system;

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
  const platform = isWindows ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const url = `${ADOPTIUM_API}/binary/latest/${REQUIRED_MAJOR}/ga/${platform}/x64/jre/hotspot/normal/eclipse`;
  const archive = path.join(dest, `jre${REQUIRED_MAJOR}.${ext}`);

  fs.mkdirSync(dest, { recursive: true });

  onLog?.('Скачивание Java 25…');
  let lastReported = 0;
  await download(url, archive, (received, total) => {
    onProgress?.(total ? received / total : 0);
    if (received - lastReported > 5 * 1024 * 1024) {
      lastReported = received;
      onLog?.(`Java: ${humanBytes(received)}${total ? ` / ${humanBytes(total)}` : ''}`);
    }
  });

  onLog?.('Распаковка Java…');
  fs.rmSync(path.join(dest, `jdk-${REQUIRED_MAJOR}`), { recursive: true, force: true });
  await execFileAsync('tar', [isWindows ? '-xf' : '-xzf', archive, '-C', dest]);

  const java = findJava(dest);
  if (!java) throw new Error('Java не найдена после распаковки');

  fs.writeFileSync(marker, java, 'utf8');
  fs.rmSync(archive, { force: true });
  onLog?.(`Java готова: ${humanBytes(fs.statSync(java).size)}`);
  return java;
}

/**
 * Look for a suitable system Java. Returns the path or null.
 */
async function findSystemJava(onLog) {
  const candidates = ['java'];
  if (process.platform === 'win32') {
    const roots = [
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Microsoft\\jdk',
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Eclipse Adoptium'),
    ];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      try {
        for (const entry of fs.readdirSync(root)) {
          const exe = path.join(root, entry, 'bin', 'java.exe');
          if (fs.existsSync(exe)) candidates.push(exe);
        }
      } catch {
        // ignore
      }
    }
  } else {
    candidates.push('/usr/bin/java', '/usr/local/bin/java');
  }

  for (const candidate of candidates) {
    try {
      const { stderr } = await execFileAsync(candidate, ['-version']);
      const match = String(stderr).match(/version "?(\d+)(?:\.(\d+))?/);
      if (!match) continue;
      let major = Number(match[1]);
      if (major === 1 && match[2]) major = Number(match[2]); // legacy 1.8 format
      if (major >= REQUIRED_MAJOR) {
        onLog?.(`Найдена системная Java ${major} (${candidate}) — скачивание не нужно.`);
        return candidate;
      }
    } catch {
      // not usable, continue
    }
  }
  return null;
}

function findJava(root) {
  const names = process.platform === 'win32' ? ['java.exe', 'javaw.exe'] : ['java'];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
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

module.exports = { ensureJava, findJava, REQUIRED_MAJOR };
