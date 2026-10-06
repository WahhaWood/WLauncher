const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

function humanBytes(bytes) {
  if (!bytes || bytes < 1) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd}: ${err.message}${stderr ? `\n${String(stderr).trim()}` : ''}`;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Base directory for ALL launcher data (game, java, caches, state, logs).
 * Portable mode (electron-builder portable exe sets PORTABLE_EXECUTABLE_DIR):
 * everything lives next to the exe in WLauncherData — nothing touches
 * %APPDATA% or %USERPROFILE%. WLAUNCHER_DATA_DIR overrides both (tests).
 */
function dataDir() {
  if (process.env.WLAUNCHER_DATA_DIR) return process.env.WLAUNCHER_DATA_DIR;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'WLauncherData');
  }
  return path.join(require('os').homedir(), '.wlauncher');
}

function isPortable() {
  return Boolean(process.env.WLAUNCHER_DATA_DIR || process.env.PORTABLE_EXECUTABLE_DIR);
}

/**
 * Single download with progress. Writes to a .part file first so an
 * interrupted download never looks like a complete file.
 */
async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const started = Date.now();
  const file = fs.createWriteStream(tmp);
  let fileError = null;
  file.on('error', (err) => {
    fileError = err;
  });
  let received = 0;
  try {
    for await (const chunk of res.body) {
      received += chunk.length;
      file.write(chunk);
      if (total && onProgress) onProgress(received, total);
    }
    await new Promise((resolve) => file.end(resolve));
    if (fileError) throw fileError;
    fs.rmSync(dest, { force: true });
    fs.renameSync(tmp, dest);
  } catch (err) {
    file.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { bytes: received, ms: Date.now() - started };
}

async function downloadWithRetry(url, dest, { retries = 3, onProgress } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await download(url, dest, onProgress);
    } catch (err) {
      lastError = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw lastError;
}

/**
 * Parallel downloads with a worker pool.
 * items: [{ url, dest, extract?: dir }]
 */
async function downloadPool(items, { concurrency = 12, onProgress } = {}) {
  if (items.length === 0) return { done: 0, total: 0, bytes: 0 };
  const queue = items.slice();
  const state = { done: 0, total: items.length, bytes: 0 };
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        const result = await downloadWithRetry(item.url, item.dest, { onProgress: item.onProgress });
        state.bytes += result.bytes;
        if (item.extract) await extractZip(item.dest, item.extract);
        state.done++;
        onProgress?.(state);
      } catch (err) {
        throw new Error(`Не удалось скачать ${path.basename(item.dest)}: ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
  return state;
}

/**
 * JSON fetch with a TTL cache on disk (for version manifests etc).
 */
async function fetchJsonCached(url, cachePath, ttlMs = 0) {
  if (ttlMs > 0 && fs.existsSync(cachePath)) {
    try {
      const stat = fs.statSync(cachePath);
      if (Date.now() - stat.mtimeMs < ttlMs) {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
    } catch {
      // fall through to download
    }
  } else if (ttlMs === 0 && fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      // fall through
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
  const data = await res.json();
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data));
  } catch {
    // cache write is best-effort
  }
  return data;
}

/**
 * Free disk space for the filesystem containing dir.
 * Returns { ok, free, required }; ok=true when the check is unavailable.
 */
function checkDiskSpace(dir, requiredBytes) {
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    const stat = fs.statfsSync(probe);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return { ok: free >= requiredBytes, free, required: requiredBytes };
  } catch {
    return { ok: true, free: null, required: requiredBytes };
  }
}

/**
 * Extracts a zip/jar using only Node's zlib.
 *
 * The previous implementation shelled out to `tar -xf`, which only works for
 * zip archives on Windows (bsdtar) and fails outright on Linux, where tar
 * cannot read the zip container at all. Native libraries ship as jars, so this
 * broke every non-Windows launch.
 */
async function extractZip(zipPath, destDir) {
  const buffer = fs.readFileSync(zipPath);
  fs.mkdirSync(destDir, { recursive: true });

  for (const entry of readZipEntries(buffer, zipPath)) {
    if (entry.name.endsWith('/')) {
      fs.mkdirSync(path.join(destDir, entry.name), { recursive: true });
      continue;
    }

    const target = safeJoin(destDir, entry.name);
    if (!target) continue; // entry escapes the destination directory

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = inflateEntry(buffer, entry);
    // Natives are loaded through dlopen, so keep them readable and executable.
    fs.writeFileSync(target, data, { mode: entry.unixMode ?? 0o755 });
  }
}

function readZipEntries(buffer, zipPath) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error(`Не похоже на zip-архив: ${path.basename(zipPath)}`);

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break; // central directory signature
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const externalAttrs = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    // Local header: its own name/extra lengths differ from the central ones.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    // Unix permissions live in the high half of the external attributes.
    const unixMode = (externalAttrs >>> 16) & 0o7777;

    entries.push({ name, method, compressedSize, dataStart, unixMode: unixMode || undefined });
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function inflateEntry(buffer, entry) {
  const raw = buffer.slice(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return raw; // stored
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`Неподдерживаемый метод сжатия ${entry.method} в архиве`);
}

/**
 * Joins a zip entry name onto destDir, rejecting absolute paths and any name
 * that would resolve outside it (a downloaded archive could otherwise write
 * anywhere on disk).
 */
function safeJoin(destDir, name) {
  const cleaned = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(destDir, cleaned);
  const base = path.resolve(destDir);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

module.exports = {
  humanBytes,
  execFileAsync,
  download,
  downloadWithRetry,
  downloadPool,
  fetchJsonCached,
  checkDiskSpace,
  extractZip,
  dataDir,
  isPortable,
};
