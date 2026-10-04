const nickInput = document.getElementById('nickname');
const playButton = document.getElementById('play');
const logBox = document.getElementById('log');
const hint = document.getElementById('hint');
const subtitle = document.getElementById('subtitle');
const statusPill = document.getElementById('status-pill');
const serverValue = document.getElementById('server-value');
const packValue = document.getElementById('pack-value');
const versionTag = document.getElementById('version-tag');
const progressBar = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');
const settingsCancelX = document.getElementById('settings-cancel-x');
const consoleClear = document.getElementById('console-clear');
const logsBtn = document.getElementById('logs-btn');

const STORAGE_KEY = 'wlauncher.nickname';
const SETTINGS_KEY = 'wlauncher.settings';
let running = false;

const DEFAULT_SETTINGS = {
  gameDir: '',
  minRam: 1024,
  maxRam: 2048,
  width: 1920,
  height: 1080,
  jvmArgs: '',
  fullscreen: false,
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
  };
}

function appendLog(line) {
  const stamp = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  logBox.textContent += `[${stamp}] ${line}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

function setStatus(text, kind = '') {
  statusPill.textContent = text;
  statusPill.className = `status-pill ${kind}`.trim();
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
  playButton.textContent = value ? 'Запуск…' : 'Играть';
  if (value) setStatus('Запуск', 'busy');
}

window.wlauncher.onLog(appendLog);
window.wlauncher.onProgress(setProgress);

window.wlauncher.onConfig((config) => {
  if (config.version) versionTag.textContent = `v${config.version}`;
  if (config.server) {
    serverValue.textContent = config.server;
  }
  if (config.packUrl) {
    packValue.textContent = 'подключена';
    packValue.title = config.packUrl;
  }
});

nickInput.value = localStorage.getItem(STORAGE_KEY) || '';
nickInput.addEventListener('input', () => {
  localStorage.setItem(STORAGE_KEY, nickInput.value.trim());
});

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

  const settings = loadSettings();
  const result = await window.wlauncher.play(nickname, settings);
  if (!result.ok) {
    hint.textContent = result.error;
    subtitle.textContent = result.error;
    setRunning(false);
    setStatus('Ошибка', 'error');
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

consoleClear.addEventListener('click', () => {
  logBox.textContent = '';
});

logsBtn.addEventListener('click', () => {
  window.wlauncher.openLogs();
});
