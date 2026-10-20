<div align="center">

# WLauncher

**Лаунчер модовой сборки ATM10-Wahha: нажал «Играть» — всё скачалось, обновилось и запустилось.**

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![Platforms](https://img.shields.io/badge/Windows%20%7C%20Linux-supported-444)
![Release](https://img.shields.io/github/v/release/WahhaWood/WLauncher)
![License](https://img.shields.io/badge/license-MIT-blue)

</div>

WLauncher сам ставит всё нужное для игры: Java, Minecraft 1.21.1, NeoForge и модовую сборку
[ATM10-Wahha](https://github.com/WahhaWood/wahha-pack). При каждом запуске он сверяет
файлы с манифестом сборки и докачивает только изменившееся.

## Возможности

- **Установка с нуля.** Подбирает и скачивает Java, ставит Minecraft и NeoForge, проверяет свободное место на диске.
- **Обновление по манифесту.** Читает `manifest.json` сборки, сравнивает SHA-256 и докачивает только изменённые архивы.
- **Настройки игрока не затираются.** Конфиги оверлея обновляются трёхсторонним слиянием: ваши правки остаются, новое от сборки добавляется.
- **Статус сервера.** Показывает, жив ли сервер и сколько на нём игроков, и сам добавляет его в список серверов игры.
- **Ник и память.** Ник проверяется по шаблону, объём оперативной памяти настраивается в окне настроек.
- **Удалённый конфиг.** Адрес сервера и значения по умолчанию можно менять через `launcher.json` сборки без новой версии лаунчера.

## Установка

Готовые сборки лежат в [Releases](https://github.com/WahhaWood/WLauncher/releases):

| Система | Файл |
| --- | --- |
| Windows | `WLauncher.Setup.<версия>.exe` (установщик) или `WLauncher.<версия>.exe` (portable) |
| Linux | `WLauncher-<версия>.AppImage` или `wlauncher-<версия>.pacman` |

## Запуск из исходников

Нужны Node.js 20+ и npm.

```bash
npm install
npm start                # лаунчер в режиме разработки
npm run dist             # установщик и portable для Windows
npm run dist:linux       # AppImage и pacman
```

Готовые файлы появляются в `dist/`. Переменная `WLAUNCHER_DRY_RUN=1` прогоняет установку без запуска игры.

## Настройка

Адреса сборки лежат в `config.json`:

| Ключ | Что значит |
| --- | --- |
| `manifestUrl` | манифест сборки, единственный источник файлов |
| `remoteConfigUrl` | удалённый конфиг: сервер, ник, память |
| `server` | адрес сервера для проверки статуса |
| `defaultMinRam`, `defaultMaxRam` | память по умолчанию, МБ |
| `nicknamePattern` | допустимый ник |

Чтобы запустить свою сборку, укажите свои адреса. Формат манифеста описан в
[wahha-pack](https://github.com/WahhaWood/wahha-pack).

## Устройство

```
src/
├── main.js            окно, IPC, жизненный цикл
├── engine.js          установка и обновление сборки
├── minecraft/         Java, установщик игры, запуск, статус сервера, servers.dat
└── ui/                интерфейс окна
```

## Лицензия

[MIT](LICENSE). В `vendor/packwiz/` лежит сторонний загрузчик packwiz со своей лицензией.
