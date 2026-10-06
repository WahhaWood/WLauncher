const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileAsync, download, humanBytes, dataDir } = require('./util');

const ADOPTIUM_API = 'https://api.adoptium.net/v3';
const REQUIRED_MAJOR = 21;

/**
 * Returns a path to a usable Java 21+.
 * Order: system Java (PATH / common locations) -> previously downloaded -> download Temurin.
 */
async function ensureJava({ onLog, onProgress } = {}) {
  if (process.env.WLAUNCHER_DRY_RUN === '1') {
    onLog?.(`[dry-run] Java ${REQUIRED_MAJOR} (пропуск скачивания)`);
    return 'java';
  }

  const system = await findSystemJava(onLog);
  if (system) return system;

  const dest = path.join(dataDir(), 'jre');
  const marker = path.join(dest, 'ok.txt');

  // The marker records which major the JRE was downloaded for, so switching the
  // required version re-downloads instead of silently reusing an older one.
  if (fs.existsSync(marker)) {
    const [markedMajor, markedPath] = fs.readFileSync(marker, 'utf8').split('\n');
    if (Number(markedMajor) === REQUIRED_MAJOR && markedPath && fs.existsSync(markedPath)) {
      onLog?.(`Java ${REQUIRED_MAJOR} уже установлена.`);
      return markedPath;
    }
  }

  const isWindows = process.platform === 'win32';
  const ext = isWindows ? 'zip' : 'tar.gz';
  const platform = isWindows ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const url = `${ADOPTIUM_API}/binary/latest/${REQUIRED_MAJOR}/ga/${platform}/x64/jre/hotspot/normal/eclipse`;
  const archive = path.join(dest, `jre${REQUIRED_MAJOR}.${ext}`);

  fs.mkdirSync(dest, { recursive: true });

  onLog?.(`Скачивание Java ${REQUIRED_MAJOR}…`);
  let lastReported = 0;
  await download(url, archive, (received, total) => {
    onProgress?.(total ? received / total : 0);
    if (received - lastReported > 5 * 1024 * 1024) {
      lastReported = received;
      onLog?.(`Java: ${humanBytes(received)}${total ? ` / ${humanBytes(total)}` : ''}`);
    }
  });

  onLog?.('Распаковка Java…');
  // Drop every previously downloaded JRE so a version switch cannot leave the
  // old runtime sitting next to the new one (findJava would pick either).
  for (const entry of fs.readdirSync(dest)) {
    if (entry.startsWith('jdk-') || entry.startsWith('jre-')) {
      fs.rmSync(path.join(dest, entry), { recursive: true, force: true });
    }
  }
  await execFileAsync('tar', [isWindows ? '-xf' : '-xzf', archive, '-C', dest]);

  const java = findJava(dest);
  if (!java) throw new Error('Java не найдена после распаковки');

  fs.writeFileSync(marker, `${REQUIRED_MAJOR}\n${java}`, 'utf8');
  fs.rmSync(archive, { force: true });
  onLog?.(`Java готова: Java ${(await majorOf(java)) ?? REQUIRED_MAJOR}`);
  return java;
}

/**
 * Reads the major version out of a `java -version` banner. Returns null if the
 * binary cannot be executed.
 */
async function majorOf(javaExe) {
  try {
    const { stderr } = await execFileAsync(javaExe, ['-version']);
    return parseMajor(String(stderr));
  } catch {
    return null;
  }
}

function parseMajor(banner) {
  const match = banner.match(/version "?(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1]);
  // Legacy 1.x format ("1.8.0_504") reports the real major in the minor slot.
  return major === 1 && match[2] ? Number(match[2]) : major;
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

  const usable = [];
  for (const candidate of candidates) {
    try {
      const { stderr } = await execFileAsync(candidate, ['-version']);
      const major = parseMajor(String(stderr));
      if (major !== null && major >= REQUIRED_MAJOR) usable.push({ candidate, major });
    } catch {
      // not usable, continue
    }
  }

  // A newer JVM is not necessarily better: 1.21.1 and NeoForge 21.1 are only
  // tested against Java 21, so an exact match wins over any other version.
  const exact = usable.find((u) => u.major === REQUIRED_MAJOR);
  const chosen = exact || usable[0];
  if (chosen) {
    onLog?.(
      exact
        ? `Найдена системная Java ${chosen.major} (${chosen.candidate}) — скачивание не нужно.`
        : `Найдена системная Java ${chosen.major} (${chosen.candidate}). Ожидалась ${REQUIRED_MAJOR} — работает, но не проверено.`
    );
    return chosen.candidate;
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
