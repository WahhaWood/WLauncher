const nickInput = document.getElementById('nickname');
const playButton = document.getElementById('play');
const logBox = document.getElementById('log');
const hint = document.getElementById('hint');
const subtitle = document.getElementById('subtitle');

const STORAGE_KEY = 'wlauncher.nickname';
let running = false;

function appendLog(line) {
  const stamp = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  logBox.textContent += `[${stamp}] ${line}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

function setRunning(value) {
  running = value;
  playButton.disabled = value;
  playButton.textContent = value ? 'Запуск…' : 'Играть';
}

window.wlauncher.onLog(appendLog);

window.wlauncher.onConfig((config) => {
  if (config.server) subtitle.textContent = `Сервер: ${config.server}`;
});

window.wlauncher.info().then((info) => {
  if (!info.installed) {
    hint.textContent = 'Движок лаунчера не найден в vendor/fjord — сборка повреждена.';
    playButton.disabled = true;
  }
  if (info.server) subtitle.textContent = `Сервер: ${info.server}`;
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
  setRunning(true);
  appendLog(`Ник: ${nickname}`);

  const result = await window.wlauncher.play(nickname);
  if (!result.ok) {
    hint.textContent = result.error;
    setRunning(false);
  } else {
    appendLog(`Готово. ${result.command || ''}`);
  }
});
