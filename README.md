# Qobuz Player

Qobuz search and playback tools in two formats:

- `Audion plugin` for in-app Qobuz search and playback
- `Windows desktop app` for searching, previewing, and downloading tracks

This repository now contains both versions in one place.

## Repository Description

```text
Qobuz tools for Audion and Windows: search, preview, stream, and download tracks with a dark UI and metadata-aware downloads.
```

## Contents

- `index.js` and `plugin.json` - Audion plugin
- `qobuz_gui.py` - standalone Windows desktop app
- `run.bat` - start the desktop app
- `run.vbs` - start the desktop app without a console window
- `build_exe.bat` - build the desktop app into an EXE
- `create_shortcut.py` - create a desktop shortcut with an icon
- `icon.png` - plugin icon
- `icon.ico` - desktop shortcut / app icon

---

# English

## 1. Audion Plugin

The original plugin lets you search Qobuz content inside Audion and stream tracks directly in the player.

### Plugin Features

- Search tracks, albums, and artists
- Stream Qobuz tracks inside Audion
- Browse album pages and artist pages
- Save tracks into the library
- Uses Paxsenix and fallback providers for search and streaming

### Plugin Files

- `plugin.json`
- `index.js`
- `icon.png`

## 2. Windows Desktop App

The desktop app is a separate GUI app for Windows with a dark interface inspired by Spotify and Yandex Music.

### Desktop App Features

- Search tracks, albums, and artists
- Open album tracklists
- Preview tracks inside the app
- Download tracks to any folder
- Choose quality: `320kbps`, `CD`, `Hi-Res`, `Studio Quality`
- Automatic tags for title, artist, album, track number, and cover art
- MusicBee-friendly output

### Requirements

- Windows
- Python 3.10 or newer
- Paxsenix API key from [api.paxsenix.org](https://api.paxsenix.org)

### Run the Desktop App

```bat
run.bat
```

For silent launch without a console window:

```bat
run.vbs
```

### Build EXE

```bat
build_exe.bat
```

The built file will appear in:

```text
dist\QobuzDownloader.exe
```

### Create Desktop Shortcut

```bat
python create_shortcut.py
```

### API Key Setup

1. Open [api.paxsenix.org](https://api.paxsenix.org)
2. Create an account
3. Copy your API key
4. Open the desktop app settings
5. Paste the key into the `Paxsenix API Key` field

---

# Русский

## 1. Плагин для Audion

Исходная часть репозитория - это плагин для Audion, который позволяет искать музыку в Qobuz и проигрывать её прямо внутри плеера.

### Возможности плагина

- Поиск треков, альбомов и исполнителей
- Проигрывание треков внутри Audion
- Просмотр страниц альбомов и исполнителей
- Сохранение треков в библиотеку
- Работа через Paxsenix и резервные провайдеры

### Файлы плагина

- `plugin.json`
- `index.js`
- `icon.png`

## 2. Отдельное приложение для Windows

В репозиторий также добавлено отдельное desktop-приложение для Windows с тёмным интерфейсом, поиском, прослушиванием и скачиванием.

### Возможности приложения

- Поиск треков, альбомов и исполнителей
- Открытие треков внутри альбома
- Прослушивание треков прямо в приложении
- Скачивание в любую папку
- Выбор качества: `320kbps`, `CD`, `Hi-Res`, `Studio Quality`
- Автоматическая запись тегов и обложки
- Удобная выгрузка в библиотеку MusicBee

### Что нужно

- Windows
- Python 3.10 или новее
- API ключ Paxsenix с [api.paxsenix.org](https://api.paxsenix.org)

### Запуск приложения

```bat
run.bat
```

Если нужен запуск без окна командной строки:

```bat
run.vbs
```

### Сборка в EXE

```bat
build_exe.bat
```

Готовый файл появится здесь:

```text
dist\QobuzDownloader.exe
```

### Ярлык на рабочем столе

```bat
python create_shortcut.py
```

### Как добавить API ключ

1. Открой [api.paxsenix.org](https://api.paxsenix.org)
2. Зарегистрируйся
3. Скопируй API ключ
4. Открой настройки приложения
5. Вставь ключ в поле `Paxsenix API Key`
