const nickInput = document.getElementById('nickname');
const playButton = document.getElementById('play');
const logBox = document.getElementById('log');
const hint = document.getElementById('hint');
const subtitle = document.getElementById('subtitle');
const progressBar = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');

const STORAGE_KEY = 'wlauncher.nickname';
let running = false;

function appendLog(line) {
  const stamp = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  logBox.textContent += `[${stamp}] ${line}\n`;
  logBox.scrollTop = logBox.scrollHeight;
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
}

window.wlauncher.onLog(appendLog);
window.wlauncher.onProgress(setProgress);

window.wlauncher.onConfig((config) => {
  if (config.server) subtitle.textContent = `Сервер: ${config.server}`;
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

  const result = await window.wlauncher.play(nickname);
  if (!result.ok) {
    hint.textContent = result.error;
    setRunning(false);
    setProgress(null);
  }
});
