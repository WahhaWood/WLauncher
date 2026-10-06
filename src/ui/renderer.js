const nickInput = document.getElementById('nickname');
const avatar = document.getElementById('avatar');
const playButton = document.getElementById('play');
const logBox = document.getElementById('log');
const hint = document.getElementById('hint');
const statusLine = document.getElementById('status-line');
const subtitle = document.getElementById('subtitle');
const serverDot = document.getElementById('server-dot');
const versionTag = document.getElementById('version-tag');
const progressBar = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');
const settingsCancelX = document.getElementById('settings-cancel-x');
const gameDirBtn = document.getElementById('game-dir-btn');
const syncBtn = document.getElementById('sync-btn');
const logsBtn = document.getElementById('logs-btn');
const consoleClear = document.getElementById('console-clear');

const STORAGE_KEY = 'wlauncher.nickname';
const SETTINGS_KEY = 'wlauncher.settings';
let running = false;

const DEFAULT_SETTINGS = {
  gameDir: '',
  // ATM10 with ~370 mods will not fit into a small heap: -XX:+AlwaysPreTouch
  // only pre-commits up to -Xms, so a small -Xms against a large -Xmx leaves
  // most of the heap to be faulted in during play, which is exactly when
  // stutter hurts. 6G is the floor for this pack; the engine additionally
  // clamps both values to what the machine can actually give.
  minRam: 6144,
  maxRam: 8192,
  width: 1920,
  height: 1080,
  jvmArgs: '',
  fullscreen: false,
  aikarFlags: true,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function applySettingsToForm(settings) {
  document.getElementById('setting-game-dir').value = settings.gameDir || '';
  document.getElementById('setting-min-ram').value = settings.minRam;
  document.getElementById('setting-max-ram').value = settings.maxRam;
  document.getElementById('setting-width').value = settings.width;
  document.getElementById('setting-height').value = settings.height;
  document.getElementById('setting-jvm-args').value = settings.jvmArgs || '';
  document.getElementById('setting-fullscreen').checked = settings.fullscreen;
  document.getElementById('setting-aikar').checked = settings.aikarFlags !== false;
}

function readSettingsFromForm() {
  return {
    gameDir: document.getElementById('setting-game-dir').value.trim(),
    minRam: parseInt(document.getElementById('setting-min-ram').value, 10) || DEFAULT_SETTINGS.minRam,
    maxRam: parseInt(document.getElementById('setting-max-ram').value, 10) || DEFAULT_SETTINGS.maxRam,
    width: parseInt(document.getElementById('setting-width').value, 10) || DEFAULT_SETTINGS.width,
    height: parseInt(document.getElementById('setting-height').value, 10) || DEFAULT_SETTINGS.height,
    jvmArgs: document.getElementById('setting-jvm-args').value.trim(),
    fullscreen: document.getElementById('setting-fullscreen').checked,
    aikarFlags: document.getElementById('setting-aikar').checked,
  };
}

function appendLog(line) {
  const stamp = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  logBox.textContent += `[${stamp}] ${line}\n`;
  logBox.scrollTop = logBox.scrollHeight;
  if (running) statusLine.textContent = line;
}

function setProgress(fraction) {
  if (fraction == null) {
    progressBar.classList.remove('visible');
    return;
  }
  progressBar.classList.add('visible');
  progressFill.style.width = `${Math.round(fraction * 100)}%`;
}

function setRunning(value) {
  running = value;
  playButton.disabled = value;
  playButton.querySelector('span').textContent = value ? 'Запуск…' : 'Играть';
  if (!value) statusLine.textContent = '';
}

async function updateServerStatus() {
  try {
    const status = await window.wlauncher.serverStatus();
    if (!status.configured) {
      subtitle.textContent = 'Сборка WLauncher';
      serverDot.className = 'dot';
      return;
    }
    if (status.online) {
      const players = status.players ? ` · ${status.players.online}/${status.players.max}` : '';
      subtitle.textContent = `${status.address} · онлайн${players} · ${status.latency} мс`;
      serverDot.className = 'dot online';
    } else {
      subtitle.textContent = `${status.address} · офлайн`;
      serverDot.className = 'dot offline';
    }
  } catch {
    subtitle.textContent = 'Сборка WLauncher';
    serverDot.className = 'dot';
  }
}

window.wlauncher.onLog(appendLog);
window.wlauncher.onProgress(setProgress);
window.wlauncher.onConfig(async (config) => {
  if (config.version) versionTag.textContent = `v${config.version}`;
  // RAM floors come from the remote config when the player never touched
  // settings — a saved customization always wins over the remote default.
  try {
    if (!localStorage.getItem(SETTINGS_KEY)) {
      if (Number(config.defaultMinRam) > 0) DEFAULT_SETTINGS.minRam = Number(config.defaultMinRam);
      if (Number(config.defaultMaxRam) > 0) DEFAULT_SETTINGS.maxRam = Number(config.defaultMaxRam);
    }
  } catch {
    // localStorage unavailable — keep baked defaults
  }
  await updateServerStatus();
});

nickInput.value = localStorage.getItem(STORAGE_KEY) || '';
updateAvatar();
nickInput.addEventListener('input', () => {
  localStorage.setItem(STORAGE_KEY, nickInput.value.trim());
  updateAvatar();
});

function updateAvatar() {
  const name = nickInput.value.trim();
  avatar.textContent = name ? name[0] : '?';
}

nickInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') playButton.click();
});

playButton.addEventListener('click', async () => {
  if (running) return;

  const nickname = nickInput.value.trim();
  if (!nickname) {
    hint.textContent = 'Введи ник.';
    nickInput.focus();
    return;
  }

  hint.textContent = '';
  setProgress(0);
  setRunning(true);
  statusLine.textContent = 'Подготовка…';

  const settings = loadSettings();
  const result = await window.wlauncher.play(nickname, settings);
  if (!result.ok) {
    hint.textContent = result.error;
    setRunning(false);
    setProgress(null);
  }
});

// Settings modal
settingsBtn.addEventListener('click', () => {
  applySettingsToForm(loadSettings());
  settingsModal.classList.add('visible');
});

function closeSettings() {
  settingsModal.classList.remove('visible');
}

settingsCancel.addEventListener('click', closeSettings);
settingsCancelX.addEventListener('click', closeSettings);

settingsSave.addEventListener('click', () => {
  const settings = readSettingsFromForm();
  saveSettings(settings);
  closeSettings();
  appendLog('Настройки сохранены.');
});

settingsModal.addEventListener('click', (event) => {
  if (event.target === settingsModal) closeSettings();
});

// Toolbar actions
gameDirBtn.addEventListener('click', () => {
  window.wlauncher.openGameDir(loadSettings());
});

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true;
  try {
    await window.wlauncher.syncPack(loadSettings());
  } finally {
    syncBtn.disabled = false;
  }
});

logsBtn.addEventListener('click', () => {
  window.wlauncher.openLogs();
});

consoleClear.addEventListener('click', () => {
  logBox.textContent = '';
});

setInterval(() => {
  if (!running) updateServerStatus().catch(() => {});
}, 60000);
