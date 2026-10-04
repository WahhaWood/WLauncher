const fs = require('fs');
const path = require('path');
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

async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  await execFileAsync('tar', ['-xf', zipPath, '-C', destDir]);
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
};
