# Qobuz Downloader GUI

A dark, desktop Qobuz downloader for Windows with search, album browsing, quick preview playback, metadata tagging, and MusicBee-friendly downloads.

> This project uses the Paxsenix API as a Qobuz search/download proxy. You need your own Paxsenix API key.

## Features

- Search tracks, albums, and artists
- Browse album tracklists
- Download selected tracks
- Choose quality: `320kbps`, `CD`, `Hi-Res`, or `Studio Quality`
- Built-in track preview player
- Automatic filename formatting
- Automatic tags for title, artist, album, track number, and cover art
- Dark Spotify/Yandex Music inspired interface
- Silent launch through `run.vbs`
- Windows EXE build script included

## Requirements

- Windows
- Python 3.10 or newer
- Paxsenix API key from [api.paxsenix.org](https://api.paxsenix.org)

## Quick Start

1. Clone or download this repository.
2. Run:

```bat
run.bat
```

The script installs the required Python packages and starts the app.

If you do not want a console window, run:

```bat
run.vbs
```

## API Key Setup

1. Open [api.paxsenix.org](https://api.paxsenix.org)
2. Create an account and copy your API key
3. Open the app
4. Go to Settings
5. Paste the key into the `Paxsenix API Key` field

## Building EXE

Run:

```bat
build_exe.bat
```

The compiled app will appear in:

```text
dist\QobuzDownloader.exe
```

## Desktop Shortcut

To create a desktop shortcut with an icon, run:

```bat
python create_shortcut.py
```

## Notes

- Preview playback uses a temporary `320kbps` cached file.
- Downloads use the quality selected in the sidebar.
- Files can be saved directly into your MusicBee library folder.
- This app is not affiliated with Qobuz, MusicBee, or Paxsenix.

## GitHub Repository Description

```text
Dark Windows GUI for searching, previewing, and downloading Qobuz tracks with metadata tagging, album browsing, and MusicBee-friendly output.
```

---

# Qobuz Downloader GUI на русском

Тёмное desktop-приложение для Windows: поиск музыки в Qobuz, просмотр альбомов, прослушивание треков, скачивание в нужную папку и автоматическая запись тегов.

> Приложение работает через Paxsenix API. Нужен свой API ключ.

## Возможности

- Поиск треков, альбомов и исполнителей
- Просмотр треков внутри альбома
- Скачивание выбранных треков
- Выбор качества: `320kbps`, `CD`, `Hi-Res`, `Studio Quality`
- Встроенное прослушивание треков
- Настраиваемый шаблон имени файла
- Автоматические теги: название, исполнитель, альбом, номер трека и обложка
- Тёмный интерфейс в стиле Spotify / Яндекс Музыки
- Запуск без командной строки через `run.vbs`
- Скрипт сборки в `.exe`

## Что нужно

- Windows
- Python 3.10 или новее
- API ключ Paxsenix с [api.paxsenix.org](https://api.paxsenix.org)

## Быстрый запуск

Запусти:

```bat
run.bat
```

Скрипт сам установит нужные библиотеки и откроет приложение.

Если хочешь запуск без окна командной строки:

```bat
run.vbs
```

## Как добавить API ключ

1. Открой [api.paxsenix.org](https://api.paxsenix.org)
2. Зарегистрируйся и скопируй API ключ
3. Открой приложение
4. Нажми `Настройки`
5. Вставь ключ в поле `Paxsenix API Key`

## Сборка в EXE

Запусти:

```bat
build_exe.bat
```

Готовый файл появится здесь:

```text
dist\QobuzDownloader.exe
```

## Ярлык на рабочем столе

Чтобы создать ярлык с иконкой:

```bat
python create_shortcut.py
```

## Примечания

- Для прослушивания используется временный кэш в `320kbps`.
- Для скачивания используется качество, выбранное в боковой панели.
- Папкой загрузки можно указать папку библиотеки MusicBee.
- Проект не связан официально с Qobuz, MusicBee или Paxsenix.
