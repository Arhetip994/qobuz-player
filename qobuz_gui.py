"""
Qobuz Downloader  —  Spotify-style dark GUI
Requires: pip install customtkinter requests mutagen pillow pyinstaller
"""

import base64
import ctypes
import io
import json
import os
import queue
import re
import tempfile
import threading
import tkinter as tk
from tkinter import filedialog, messagebox
from urllib.parse import urlparse

import customtkinter as ctk
from PIL import Image, ImageDraw, ImageFont

try:
    import requests
except ImportError:
    raise SystemExit("pip install requests")

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("dark-blue")

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

PAX_BASE   = "https://api.paxsenix.org"
PAX_SEARCH = PAX_BASE + "/qobuz/search"
PAX_ALBUM  = PAX_BASE + "/qobuz/album"
PAX_DL     = PAX_BASE + "/dl/qobuz"

QUALITY_OPTIONS = ["Studio Quality", "Hi-Res", "CD", "320kbps"]

# Palette
C_BG      = "#0f0f0f"
C_CARD    = "#181818"
C_HOVER   = "#282828"
C_BORDER  = "#333333"
C_GREEN   = "#1DB954"
C_GREEN2  = "#1ed760"
C_TEXT    = "#FFFFFF"
C_SUB     = "#b3b3b3"
C_MUTED   = "#535353"
THUMB_SZ  = 52


# ── Config ────────────────────────────────────────────────────────────────────

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"api_key": "", "download_folder": "", "quality": "CD",
            "filename_template": "{artist} - {title}"}


def save_config(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


# ── API ───────────────────────────────────────────────────────────────────────

def pax_headers(api_key: str) -> dict:
    key = api_key.strip()
    if not key.startswith("Bearer "):
        key = f"Bearer {key}"
    return {"Authorization": key, "Content-Type": "application/json"}


def api_search(query: str, api_key: str) -> dict:
    r = requests.get(PAX_SEARCH, params={"q": query},
                     headers=pax_headers(api_key), timeout=20)
    r.raise_for_status()
    return r.json()


def api_album(album_id: str, api_key: str) -> dict:
    r = requests.get(PAX_ALBUM, params={"id": album_id},
                     headers=pax_headers(api_key), timeout=20)
    r.raise_for_status()
    return r.json()


def get_stream_url(track_id: str, quality: str, api_key: str):
    qobuz_url = f"https://open.qobuz.com/track/{track_id}"
    r = requests.get(PAX_DL, params={"url": qobuz_url, "quality": quality},
                     headers=pax_headers(api_key), timeout=30)
    r.raise_for_status()
    data = r.json()
    if not data.get("ok"):
        return None
    if data.get("directUrl"):
        return data["directUrl"]
    manifest_b64 = data.get("manifest")
    if manifest_b64:
        raw = base64.b64decode(manifest_b64 + "==").decode("utf-8", errors="replace")
        mime = data.get("manifestMimeType", "")
        if "dash" in mime or raw.lstrip().startswith("<"):
            return None
        try:
            obj = json.loads(raw)
            return obj.get("url") or (obj.get("urls") or [None])[0]
        except Exception:
            pass
    return None


# ── Track field helpers ───────────────────────────────────────────────────────

def track_artist(t: dict) -> str:
    if t.get("artist") and isinstance(t["artist"], str):
        return t["artist"]
    perf = t.get("performer") or {}
    if isinstance(perf, dict) and perf.get("name"):
        return perf["name"]
    alb = t.get("album") or {}
    if isinstance(alb, dict):
        art = alb.get("artist") or {}
        if isinstance(art, dict):
            return art.get("name", "")
        if isinstance(art, str):
            return art
    return "Unknown"


def track_album_title(t: dict) -> str:
    if t.get("albumTitle"):
        return t["albumTitle"]
    alb = t.get("album") or {}
    if isinstance(alb, dict):
        return alb.get("title", "")
    return ""


def track_cover_url(t: dict) -> str:
    if t.get("cover"):
        return t["cover"]
    alb = t.get("album") or {}
    if isinstance(alb, dict):
        img = alb.get("image") or {}
        if isinstance(img, dict):
            return img.get("large") or img.get("small") or img.get("thumbnail") or ""
    return ""


def album_artist(a: dict) -> str:
    v = a.get("artist", "")
    if isinstance(v, dict):
        return v.get("name", "")
    return str(v) if v else ""


def album_cover_url(a: dict) -> str:
    img = a.get("image") or {}
    if isinstance(img, dict):
        return img.get("large") or img.get("small") or ""
    return a.get("cover", "")


# ── Image helpers ─────────────────────────────────────────────────────────────

_cover_cache: dict[str, ctk.CTkImage] = {}
_placeholder: ctk.CTkImage | None = None


def get_placeholder() -> ctk.CTkImage:
    global _placeholder
    if _placeholder is None:
        img = Image.new("RGB", (THUMB_SZ, THUMB_SZ), "#282828")
        draw = ImageDraw.Draw(img)
        draw.text((THUMB_SZ // 2, THUMB_SZ // 2), "♪",
                  fill="#535353", anchor="mm")
        _placeholder = ctk.CTkImage(img, size=(THUMB_SZ, THUMB_SZ))
    return _placeholder


def fetch_cover_image(url: str) -> ctk.CTkImage | None:
    if not url:
        return None
    if url in _cover_cache:
        return _cover_cache[url]
    try:
        r = requests.get(url, timeout=8)
        if not r.ok:
            return None
        img = Image.open(io.BytesIO(r.content)).convert("RGB")
        img = img.resize((THUMB_SZ, THUMB_SZ), Image.LANCZOS)
        ctk_img = ctk.CTkImage(img, size=(THUMB_SZ, THUMB_SZ))
        _cover_cache[url] = ctk_img
        return ctk_img
    except Exception:
        return None


def prepare_preview_file(track: dict, api_key: str) -> str:
    track_id = str(track.get("id", ""))
    if not track_id:
        raise RuntimeError("У трека нет id")

    cache_dir = os.path.join(tempfile.gettempdir(), "qobuz_gui_preview")
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, f"{track_id}.mp3")
    if os.path.exists(path) and os.path.getsize(path) > 1024 * 64:
        return path

    stream_url = get_stream_url(track_id, "320kbps", api_key)
    if not stream_url:
        raise RuntimeError("Не удалось получить ссылку для прослушивания")

    tmp_path = path + ".part"
    with requests.get(stream_url, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        with open(tmp_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=131072):
                if chunk:
                    f.write(chunk)
    os.replace(tmp_path, path)
    return path


class WindowsMciPlayer:
    def __init__(self):
        self.alias = "qobuzpreview"
        self.opened = False
        self.paused = False

    def _send(self, command: str):
        buf = ctypes.create_unicode_buffer(512)
        code = ctypes.windll.winmm.mciSendStringW(command, buf, 511, 0)
        if code:
            err = ctypes.create_unicode_buffer(512)
            ctypes.windll.winmm.mciGetErrorStringW(code, err, 511)
            raise RuntimeError(err.value or f"MCI error {code}")
        return buf.value

    def play(self, path: str):
        self.stop()
        safe_path = os.path.abspath(path).replace('"', "")
        self._send(f'open "{safe_path}" type mpegvideo alias {self.alias}')
        self.opened = True
        self.paused = False
        self._send(f"play {self.alias}")

    def pause(self):
        if self.opened:
            self._send(f"pause {self.alias}")
            self.paused = True

    def resume(self):
        if self.opened:
            self._send(f"resume {self.alias}")
            self.paused = False

    def stop(self):
        if self.opened:
            try:
                self._send(f"stop {self.alias}")
                self._send(f"close {self.alias}")
            except Exception:
                pass
        self.opened = False
        self.paused = False

    def is_playing(self) -> bool:
        if not self.opened:
            return False
        try:
            return self._send(f"status {self.alias} mode").strip().lower() == "playing"
        except Exception:
            return False


# ── Downloader ────────────────────────────────────────────────────────────────

def sanitize(name: str) -> str:
    return re.sub(r'[\\/*?:"<>|]', "_", name).strip()


def build_filename(template: str, track: dict, ext: str) -> str:
    artist  = sanitize(track_artist(track))
    title   = sanitize(track.get("title", "Unknown"))
    album   = sanitize(track_album_title(track))
    track_n = str(track.get("trackNumber") or track.get("track_number") or "").zfill(2)
    return template.format(artist=artist, title=title, album=album, track=track_n) + ext


def tag_file(path: str, track: dict, cover_data: bytes | None):
    try:
        from mutagen.flac import FLAC, Picture
        from mutagen.id3 import ID3, TIT2, TPE1, TALB, TRCK, APIC
    except ImportError:
        return
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".flac":
            audio = FLAC(path)
            audio["title"]       = track.get("title", "")
            audio["artist"]      = track_artist(track)
            audio["album"]       = track_album_title(track)
            audio["tracknumber"] = str(track.get("trackNumber") or track.get("track_number") or "")
            if cover_data:
                pic = Picture()
                pic.type = 3; pic.mime = "image/jpeg"; pic.data = cover_data
                audio.add_picture(pic)
            audio.save()
        elif ext == ".mp3":
            try:
                audio = ID3(path)
            except Exception:
                audio = ID3()
            audio["TIT2"] = TIT2(encoding=3, text=track.get("title", ""))
            audio["TPE1"] = TPE1(encoding=3, text=track_artist(track))
            audio["TALB"] = TALB(encoding=3, text=track_album_title(track))
            audio["TRCK"] = TRCK(encoding=3, text=str(track.get("trackNumber") or ""))
            if cover_data:
                audio["APIC"] = APIC(encoding=3, mime="image/jpeg",
                                     type=3, desc="Cover", data=cover_data)
            audio.save(path)
    except Exception:
        pass


def download_track(track: dict, quality: str, folder: str,
                   template: str, api_key: str, log_fn):
    track_id = str(track.get("id", ""))
    title    = track.get("title", track_id)
    artist   = track_artist(track)
    log_fn(f"⟳  {artist} — {title}")

    qualities = QUALITY_OPTIONS[QUALITY_OPTIONS.index(quality):]
    stream_url = None
    used_q = quality
    for q in qualities:
        try:
            stream_url = get_stream_url(track_id, q, api_key)
            if stream_url:
                used_q = q
                break
        except Exception as e:
            log_fn(f"   {q} недоступно: {e}")

    if not stream_url:
        log_fn(f"✗  Нет ссылки: {title}")
        return False

    try:
        head = requests.head(stream_url, timeout=8, allow_redirects=True)
        ct = head.headers.get("Content-Type", "")
    except Exception:
        ct = ""
    ppath = urlparse(stream_url).path.lower()
    ext = ".flac" if ("flac" in ct or ".flac" in ppath) else \
          ".ogg"  if ("ogg"  in ct or ".ogg"  in ppath) else ".mp3"

    filename = build_filename(template, track, ext)
    filepath = os.path.join(folder, filename)

    if os.path.exists(filepath):
        log_fn(f"✓  Уже есть: {filename}")
        return True

    try:
        with requests.get(stream_url, stream=True, timeout=120) as resp:
            resp.raise_for_status()
            with open(filepath, "wb") as f:
                for chunk in resp.iter_content(chunk_size=131072):
                    f.write(chunk)
    except Exception as e:
        log_fn(f"✗  Ошибка: {e}")
        if os.path.exists(filepath):
            os.remove(filepath)
        return False

    cover_url  = track_cover_url(track)
    cover_data = None
    if cover_url:
        try:
            r = requests.get(cover_url, timeout=8)
            cover_data = r.content if r.ok else None
        except Exception:
            pass
    tag_file(filepath, track, cover_data)

    mb = os.path.getsize(filepath) / 1024 / 1024
    log_fn(f"✓  {filename}  [{used_q} · {mb:.1f} MB]")
    return True


# ══════════════════════════════════════════════════════════════════════════════
# GUI
# ══════════════════════════════════════════════════════════════════════════════

class TrackRow(ctk.CTkFrame):
    """Single row in the results list."""

    def __init__(self, master, track: dict, index: int,
                 on_select, on_download, on_play, **kw):
        super().__init__(master, fg_color=C_CARD, corner_radius=8, **kw)
        self.track    = track
        self.index    = index
        self.selected = False
        self._on_select   = on_select
        self._on_download = on_download
        self._on_play     = on_play

        self.configure(cursor="hand2")
        self._build()
        self._bind_hover()

    def _build(self):
        self.grid_columnconfigure(1, weight=1)

        # Cover placeholder
        self.cover_lbl = ctk.CTkLabel(self, text="", width=THUMB_SZ, height=THUMB_SZ,
                                      fg_color=C_HOVER, corner_radius=4,
                                      image=get_placeholder())
        self.cover_lbl.grid(row=0, column=0, rowspan=2, padx=(10, 10), pady=6, sticky="ns")

        # Title
        title = self.track.get("title", "")
        self.title_lbl = ctk.CTkLabel(self, text=title, anchor="w",
                                      font=ctk.CTkFont("Segoe UI", 13, "normal"),
                                      text_color=C_TEXT)
        self.title_lbl.grid(row=0, column=1, sticky="sw", pady=(8, 0))

        # Artist · Album
        artist = track_artist(self.track)
        album  = track_album_title(self.track)
        sub    = f"{artist}  ·  {album}" if album else artist
        self.sub_lbl = ctk.CTkLabel(self, text=sub, anchor="w",
                                    font=ctk.CTkFont("Segoe UI", 11),
                                    text_color=C_SUB)
        self.sub_lbl.grid(row=1, column=1, sticky="nw", pady=(0, 8))

        # Duration
        dur   = self.track.get("duration", 0)
        dur_s = f"{dur//60}:{dur%60:02d}" if dur else ""
        ctk.CTkLabel(self, text=dur_s, width=48, anchor="e",
                     font=ctk.CTkFont("Segoe UI", 11),
                     text_color=C_MUTED).grid(row=0, column=2, rowspan=2, padx=(0, 6))

        # Quality badge
        sr = (self.track.get("sampleRate") or
              self.track.get("maximum_sampling_rate") or
              (self.track.get("album") or {}).get("maximum_sampling_rate", ""))
        bd = (self.track.get("bitDepth") or
              self.track.get("maximum_bit_depth") or
              (self.track.get("album") or {}).get("maximum_bit_depth", ""))
        q_text = f"{bd}b·{sr}k" if (sr and bd) else \
                 ("Hi-Res" if self.track.get("isHiRes") or
                              self.track.get("hires_streamable") else "")
        if q_text:
            ctk.CTkLabel(self, text=q_text, width=80,
                         font=ctk.CTkFont("Segoe UI", 10),
                         text_color=C_GREEN,
                         fg_color="#1a3a2a", corner_radius=4).grid(
                row=0, column=3, rowspan=2, padx=(0, 8))

        # Play button
        play_btn = ctk.CTkButton(self, text="▶", width=32, height=32,
                                 fg_color="transparent", hover_color=C_HOVER,
                                 text_color=C_GREEN, font=ctk.CTkFont("Segoe UI", 13),
                                 corner_radius=16,
                                 command=lambda: self._on_play(self.track))
        play_btn.grid(row=0, column=4, rowspan=2, padx=(0, 4))

        # Download button
        dl_btn = ctk.CTkButton(self, text="↓", width=32, height=32,
                               fg_color="transparent", hover_color=C_HOVER,
                               text_color=C_SUB, font=ctk.CTkFont("Segoe UI", 16),
                               corner_radius=16,
                               command=lambda: self._on_download(self.track))
        dl_btn.grid(row=0, column=5, rowspan=2, padx=(0, 10))

    def _bind_hover(self):
        for w in [self, self.title_lbl, self.sub_lbl, self.cover_lbl]:
            w.bind("<Button-1>", self._click)
            w.bind("<Enter>",    self._enter)
            w.bind("<Leave>",    self._leave)

    def _click(self, _=None):
        self.selected = not self.selected
        self._update_bg()
        self._on_select(self.index, self.selected)

    def _enter(self, _=None):
        if not self.selected:
            self.configure(fg_color=C_HOVER)

    def _leave(self, _=None):
        if not self.selected:
            self.configure(fg_color=C_CARD)

    def _update_bg(self):
        self.configure(fg_color="#1a3a2a" if self.selected else C_CARD)

    def set_cover(self, img: ctk.CTkImage):
        self.cover_lbl.configure(image=img)

    def set_downloaded(self):
        self.title_lbl.configure(text_color=C_GREEN)


class AlbumCard(ctk.CTkFrame):
    """Card in the albums grid."""

    def __init__(self, master, album: dict, index: int, on_open, **kw):
        super().__init__(master, fg_color=C_CARD, corner_radius=10,
                         width=160, height=200, **kw)
        self.album   = album
        self.index   = index
        self._on_open = on_open
        self.configure(cursor="hand2")
        self._build()
        self.bind("<Button-1>", self._click)
        self.bind("<Enter>",    lambda _: self.configure(fg_color=C_HOVER))
        self.bind("<Leave>",    lambda _: self.configure(fg_color=C_CARD))

    def _build(self):
        self.cover_lbl = ctk.CTkLabel(self, text="", width=136, height=136,
                                      fg_color=C_HOVER, corner_radius=6,
                                      image=get_placeholder())
        self.cover_lbl.pack(padx=12, pady=(12, 6))
        self.cover_lbl.bind("<Button-1>", self._click)

        title = self.album.get("title", "")
        ctk.CTkLabel(self, text=title[:22] + ("…" if len(title) > 22 else ""),
                     font=ctk.CTkFont("Segoe UI", 12, "bold"),
                     text_color=C_TEXT, wraplength=140).pack(padx=8)

        artist = album_artist(self.album)
        ctk.CTkLabel(self, text=artist[:24] + ("…" if len(artist) > 24 else ""),
                     font=ctk.CTkFont("Segoe UI", 11),
                     text_color=C_SUB).pack(padx=8, pady=(2, 10))

    def _click(self, _=None):
        self._on_open(self.index)

    def set_cover(self, img: ctk.CTkImage):
        big = ctk.CTkImage(img._light_image.resize((136, 136), Image.LANCZOS),
                           size=(136, 136))
        self.cover_lbl.configure(image=big)


def bind_clipboard(entry: ctk.CTkEntry):
    """Bind Ctrl+C/X/V/A/Z to a CTkEntry so clipboard works on Windows."""
    w = entry._entry  # underlying tk.Entry widget
    w.bind("<Control-c>", lambda e: w.event_generate("<<Copy>>"))
    w.bind("<Control-x>", lambda e: w.event_generate("<<Cut>>"))
    w.bind("<Control-v>", lambda e: w.event_generate("<<Paste>>"))
    w.bind("<Control-a>", lambda e: (w.select_range(0, "end"), "break"))
    w.bind("<Control-z>", lambda e: w.event_generate("<<Undo>>"))


class SettingsDialog(ctk.CTkToplevel):
    def __init__(self, master, cfg: dict, on_save):
        super().__init__(master)
        self.title("Настройки")
        self.geometry("480x320")
        self.resizable(False, False)
        self.configure(fg_color=C_BG)
        self.grab_set()
        self._cfg    = cfg
        self._on_save = on_save
        self._build()

    def _build(self):
        ctk.CTkLabel(self, text="Настройки", font=ctk.CTkFont("Segoe UI", 16, "bold"),
                     text_color=C_TEXT).pack(anchor="w", padx=24, pady=(20, 0))

        ctk.CTkLabel(self, text="Paxsenix API Key",
                     font=ctk.CTkFont("Segoe UI", 12),
                     text_color=C_SUB).pack(anchor="w", padx=24, pady=(16, 0))
        self._key_var = ctk.StringVar(value=self._cfg.get("api_key", ""))
        key_entry = ctk.CTkEntry(self, textvariable=self._key_var, show="•",
                                 width=432, height=38,
                                 fg_color=C_CARD, border_color=C_BORDER,
                                 text_color=C_TEXT, font=ctk.CTkFont("Segoe UI", 12))
        key_entry.pack(padx=24)
        bind_clipboard(key_entry)

        show_v = ctk.BooleanVar()
        ctk.CTkCheckBox(self, text="Показать ключ", variable=show_v,
                        fg_color=C_GREEN, hover_color=C_GREEN2,
                        text_color=C_SUB, font=ctk.CTkFont("Segoe UI", 11),
                        command=lambda: key_entry.configure(
                            show="" if show_v.get() else "•")).pack(
            anchor="w", padx=24, pady=(4, 0))

        ctk.CTkLabel(self, text="Шаблон имени файла  · переменные: {artist} {title} {album} {track}",
                     font=ctk.CTkFont("Segoe UI", 11),
                     text_color=C_SUB).pack(anchor="w", padx=24, pady=(14, 0))
        self._tmpl_var = ctk.StringVar(
            value=self._cfg.get("filename_template", "{artist} - {title}"))
        tmpl_entry = ctk.CTkEntry(self, textvariable=self._tmpl_var, width=432, height=38,
                                  fg_color=C_CARD, border_color=C_BORDER,
                                  text_color=C_TEXT, font=ctk.CTkFont("Segoe UI", 12))
        tmpl_entry.pack(padx=24)
        bind_clipboard(tmpl_entry)

        ctk.CTkLabel(self, text="Получить ключ: api.paxsenix.org  (есть бесплатный тир)",
                     font=ctk.CTkFont("Segoe UI", 10),
                     text_color=C_MUTED).pack(anchor="w", padx=24, pady=(8, 0))

        ctk.CTkButton(self, text="Сохранить", width=160, height=38,
                      fg_color=C_GREEN, hover_color=C_GREEN2,
                      text_color="#000000", font=ctk.CTkFont("Segoe UI", 13, "bold"),
                      command=self._save).pack(pady=18)

    def _save(self):
        self._cfg["api_key"]           = self._key_var.get().strip()
        self._cfg["filename_template"] = self._tmpl_var.get().strip() or "{artist} - {title}"
        save_config(self._cfg)
        self._on_save()
        self.destroy()


class QobuzApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Qobuz Downloader")
        self.geometry("1020x700")
        self.minsize(820, 560)
        self.configure(fg_color=C_BG)

        self.cfg         = load_config()
        self.track_data  = []   # current tracks in list
        self.album_data  = []   # current albums in grid
        self.selected    = set()
        self.track_rows: list[TrackRow] = []
        self.album_cards: list[AlbumCard] = []
        self.log_queue   = queue.Queue()
        self._busy       = False
        self._player_paused = False
        self._current_track: dict | None = None
        self._player = WindowsMciPlayer()

        self._build()
        self._poll_log()

    # ── Layout ────────────────────────────────────────────────────────────────

    def _build(self):
        # ── Sidebar
        self.sidebar = ctk.CTkFrame(self, width=220, fg_color=C_CARD,
                                    corner_radius=0)
        self.sidebar.pack(side="left", fill="y")
        self.sidebar.pack_propagate(False)
        self._build_sidebar()

        # ── Main
        main = ctk.CTkFrame(self, fg_color=C_BG, corner_radius=0)
        main.pack(side="left", fill="both", expand=True)
        self._build_main(main)

    def _build_sidebar(self):
        # Logo
        ctk.CTkLabel(self.sidebar,
                     text="♪  Qobuz",
                     font=ctk.CTkFont("Segoe UI", 18, "bold"),
                     text_color=C_GREEN).pack(anchor="w", padx=20, pady=(24, 32))

        # Nav buttons
        self._tab_var = ctk.StringVar(value="tracks")
        for label, key in [("Треки", "tracks"), ("Альбомы", "albums"), ("Исполнители", "artists")]:
            btn = ctk.CTkButton(self.sidebar, text=label, anchor="w",
                                height=40, fg_color="transparent",
                                hover_color=C_HOVER, text_color=C_SUB,
                                font=ctk.CTkFont("Segoe UI", 13),
                                corner_radius=6,
                                command=lambda k=key: self._switch_tab(k))
            btn.pack(fill="x", padx=12, pady=2)
            setattr(self, f"_nav_{key}", btn)

        ctk.CTkFrame(self.sidebar, height=1, fg_color=C_BORDER).pack(
            fill="x", padx=16, pady=16)

        # Download folder
        ctk.CTkLabel(self.sidebar, text="Папка загрузки",
                     font=ctk.CTkFont("Segoe UI", 11),
                     text_color=C_MUTED).pack(anchor="w", padx=20, pady=(0, 4))

        folder_row = ctk.CTkFrame(self.sidebar, fg_color="transparent")
        folder_row.pack(fill="x", padx=12)
        self._folder_var = ctk.StringVar(value=self.cfg.get("download_folder", ""))
        ctk.CTkEntry(folder_row, textvariable=self._folder_var,
                     fg_color=C_HOVER, border_color=C_BORDER,
                     text_color=C_TEXT, font=ctk.CTkFont("Segoe UI", 10),
                     height=32).pack(side="left", fill="x", expand=True)
        ctk.CTkButton(folder_row, text="…", width=32, height=32,
                      fg_color=C_HOVER, hover_color=C_BORDER,
                      text_color=C_SUB, corner_radius=6,
                      command=self._pick_folder).pack(side="left", padx=(4, 0))

        # Quality
        ctk.CTkLabel(self.sidebar, text="Качество",
                     font=ctk.CTkFont("Segoe UI", 11),
                     text_color=C_MUTED).pack(anchor="w", padx=20, pady=(12, 4))
        self._quality_var = ctk.StringVar(value=self.cfg.get("quality", "CD"))
        ctk.CTkOptionMenu(self.sidebar, values=QUALITY_OPTIONS,
                          variable=self._quality_var,
                          fg_color=C_HOVER, button_color=C_BORDER,
                          button_hover_color=C_MUTED,
                          text_color=C_TEXT,
                          font=ctk.CTkFont("Segoe UI", 12),
                          height=36).pack(fill="x", padx=12)

        ctk.CTkFrame(self.sidebar, height=1, fg_color=C_BORDER).pack(
            fill="x", padx=16, pady=16)

        # Download button
        self._dl_btn = ctk.CTkButton(
            self.sidebar, text="⬇  Скачать выбранное",
            height=42, fg_color=C_GREEN, hover_color=C_GREEN2,
            text_color="#000000", font=ctk.CTkFont("Segoe UI", 13, "bold"),
            corner_radius=8, command=self._download_selected)
        self._dl_btn.pack(fill="x", padx=12)

        self._prog = ctk.CTkProgressBar(self.sidebar, height=4,
                                        fg_color=C_HOVER, progress_color=C_GREEN)
        self._prog.pack(fill="x", padx=12, pady=(8, 0))
        self._prog.set(0)

        # Settings at bottom
        ctk.CTkButton(self.sidebar, text="⚙  Настройки",
                      height=36, fg_color="transparent",
                      hover_color=C_HOVER, text_color=C_MUTED,
                      font=ctk.CTkFont("Segoe UI", 11),
                      corner_radius=6,
                      command=self._open_settings).pack(
            side="bottom", fill="x", padx=12, pady=16)

    def _build_main(self, parent):
        # Search bar
        search_bar = ctk.CTkFrame(parent, fg_color="transparent")
        search_bar.pack(fill="x", padx=24, pady=(20, 12))

        self._search_var = ctk.StringVar()
        search_entry = ctk.CTkEntry(
            search_bar, textvariable=self._search_var,
            placeholder_text="Поиск треков, альбомов, исполнителей…",
            height=44, fg_color=C_CARD, border_color=C_BORDER,
            text_color=C_TEXT, placeholder_text_color=C_MUTED,
            font=ctk.CTkFont("Segoe UI", 13))
        search_entry.pack(side="left", fill="x", expand=True)
        search_entry.bind("<Return>", lambda _: self._search())
        bind_clipboard(search_entry)

        ctk.CTkButton(search_bar, text="Найти", width=96, height=44,
                      fg_color=C_GREEN, hover_color=C_GREEN2,
                      text_color="#000000", font=ctk.CTkFont("Segoe UI", 13, "bold"),
                      corner_radius=8,
                      command=self._search).pack(side="left", padx=(10, 0))

        # Content area with scrollable frames
        self._content = ctk.CTkFrame(parent, fg_color="transparent")
        self._content.pack(fill="both", expand=True, padx=24)

        # Tracks scroll
        self._tracks_frame = ctk.CTkScrollableFrame(
            self._content, fg_color="transparent",
            scrollbar_button_color=C_BORDER,
            scrollbar_button_hover_color=C_MUTED)
        self._tracks_frame.pack(fill="both", expand=True)
        self._tracks_frame.columnconfigure(0, weight=1)

        # Albums scroll (hidden initially)
        self._albums_frame = ctk.CTkScrollableFrame(
            self._content, fg_color="transparent",
            scrollbar_button_color=C_BORDER,
            scrollbar_button_hover_color=C_MUTED)

        # Artists scroll (hidden initially)
        self._artists_frame = ctk.CTkScrollableFrame(
            self._content, fg_color="transparent",
            scrollbar_button_color=C_BORDER,
            scrollbar_button_hover_color=C_MUTED)

        # Empty state label
        self._empty_lbl = ctk.CTkLabel(
            self._tracks_frame,
            text="Введи запрос и нажми Найти",
            font=ctk.CTkFont("Segoe UI", 14),
            text_color=C_MUTED)
        self._empty_lbl.pack(pady=80)

        # Player bar
        player = ctk.CTkFrame(parent, fg_color=C_CARD, corner_radius=0, height=58)
        player.pack(fill="x", side="bottom")
        player.pack_propagate(False)

        self._play_btn = ctk.CTkButton(player, text="▶", width=40, height=34,
                                       fg_color=C_GREEN, hover_color=C_GREEN2,
                                       text_color="#000000",
                                       font=ctk.CTkFont("Segoe UI", 14, "bold"),
                                       corner_radius=18,
                                       command=self._toggle_player)
        self._play_btn.pack(side="left", padx=(14, 10), pady=10)

        self._stop_btn = ctk.CTkButton(player, text="■", width=34, height=34,
                                       fg_color=C_HOVER, hover_color=C_BORDER,
                                       text_color=C_SUB,
                                       font=ctk.CTkFont("Segoe UI", 12),
                                       corner_radius=17,
                                       command=self._stop_player)
        self._stop_btn.pack(side="left", pady=10)

        self._now_lbl = ctk.CTkLabel(player, text="Ничего не играет",
                                     anchor="w",
                                     font=ctk.CTkFont("Segoe UI", 12),
                                     text_color=C_SUB)
        self._now_lbl.pack(side="left", fill="x", expand=True, padx=14)

        # Log console
        log_frame = ctk.CTkFrame(parent, fg_color=C_CARD,
                                 corner_radius=0, height=100)
        log_frame.pack(fill="x", side="bottom")
        log_frame.pack_propagate(False)
        self._log_box = ctk.CTkTextbox(log_frame, fg_color="transparent",
                                       text_color=C_GREEN,
                                       font=ctk.CTkFont("Consolas", 10),
                                       state="disabled", wrap="word")
        self._log_box.pack(fill="both", expand=True, padx=12, pady=6)

        self._switch_tab("tracks")

    def _switch_tab(self, key: str):
        self._tab_var.set(key)
        self._tracks_frame.pack_forget()
        self._albums_frame.pack_forget()
        self._artists_frame.pack_forget()
        if key == "tracks":
            self._tracks_frame.pack(fill="both", expand=True)
            self._nav_tracks.configure(text_color=C_TEXT)
            self._nav_albums.configure(text_color=C_SUB)
            self._nav_artists.configure(text_color=C_SUB)
        elif key == "albums":
            self._albums_frame.pack(fill="both", expand=True)
            self._nav_tracks.configure(text_color=C_SUB)
            self._nav_albums.configure(text_color=C_TEXT)
            self._nav_artists.configure(text_color=C_SUB)
        else:
            self._artists_frame.pack(fill="both", expand=True)
            self._nav_tracks.configure(text_color=C_SUB)
            self._nav_albums.configure(text_color=C_SUB)
            self._nav_artists.configure(text_color=C_TEXT)

    # ── Log ───────────────────────────────────────────────────────────────────

    def _log(self, msg: str):
        self.log_queue.put(msg)

    def _poll_log(self):
        try:
            while True:
                msg = self.log_queue.get_nowait()
                self._log_box.configure(state="normal")
                self._log_box.insert("end", msg + "\n")
                self._log_box.see("end")
                self._log_box.configure(state="disabled")
        except queue.Empty:
            pass
        self.after(100, self._poll_log)

    # ── Settings / Folder ─────────────────────────────────────────────────────

    def _open_settings(self):
        SettingsDialog(self, self.cfg,
                       on_save=lambda: self._log("✓  Настройки сохранены"))

    def _pick_folder(self):
        f = filedialog.askdirectory(title="Папка для загрузки")
        if f:
            self._folder_var.set(f)
            self.cfg["download_folder"] = f
            save_config(self.cfg)

    # ── Search ────────────────────────────────────────────────────────────────

    def _search(self):
        q = self._search_var.get().strip()
        if not q:
            return
        api_key = self.cfg.get("api_key", "").strip()
        if not api_key:
            messagebox.showwarning("API Key", "Укажите Paxsenix API Key в настройках")
            self._open_settings()
            return
        if self._busy:
            return
        self._busy = True
        self._prog.set(0)
        self._prog.start()
        self._clear_results()
        self._log(f"🔍  {q}")
        threading.Thread(target=self._do_search, args=(q, api_key), daemon=True).start()

    def _do_search(self, query: str, api_key: str):
        try:
            data = api_search(query, api_key)
            tracks  = data.get("tracks",  [])
            albums  = data.get("albums",  [])
            artists = data.get("artists", [])
            self._log(f"✓  {len(tracks)} треков · {len(albums)} альбомов · {len(artists)} исполнителей")
            self.after(0, lambda: self._populate(tracks, albums, artists))
        except Exception as e:
            self._log(f"✗  Ошибка: {e}")
        finally:
            self._busy = False
            self.after(0, self._prog.stop)

    def _clear_results(self):
        self.track_data.clear()
        self.album_data.clear()
        self.selected.clear()
        self.track_rows.clear()
        self.album_cards.clear()
        for w in self._tracks_frame.winfo_children():
            w.destroy()
        for w in self._albums_frame.winfo_children():
            w.destroy()
        for w in self._artists_frame.winfo_children():
            w.destroy()

    def _populate(self, tracks, albums, artists):
        self.track_data = tracks
        self.album_data = albums

        if self._empty_lbl.winfo_exists():
            self._empty_lbl.destroy()

        # ── Tracks
        for i, t in enumerate(tracks):
            row = TrackRow(self._tracks_frame, t, i,
                           on_select=self._on_track_select,
                           on_download=self._download_single,
                           on_play=self._play_track)
            row.pack(fill="x", pady=2)
            self.track_rows.append(row)

        # ── Albums grid
        grid = ctk.CTkFrame(self._albums_frame, fg_color="transparent")
        grid.pack(fill="both", expand=True)
        for i, a in enumerate(albums):
            card = AlbumCard(grid, a, i, on_open=self._open_album)
            card.grid(row=i // 5, column=i % 5, padx=8, pady=8, sticky="nw")
            self.album_cards.append(card)

        # ── Artists
        for ar in artists:
            name = ar.get("name") or ar.get("title", "")
            cnt  = ar.get("albumsCount") or ar.get("albums_count", "")
            row = ctk.CTkFrame(self._artists_frame, fg_color=C_CARD, corner_radius=8)
            row.pack(fill="x", pady=2)
            ctk.CTkLabel(row, text=name, anchor="w",
                         font=ctk.CTkFont("Segoe UI", 13),
                         text_color=C_TEXT).pack(side="left", padx=16, pady=10)
            if cnt:
                ctk.CTkLabel(row, text=f"{cnt} альбомов",
                             font=ctk.CTkFont("Segoe UI", 11),
                             text_color=C_MUTED).pack(side="right", padx=16)

        # Load covers in background
        threading.Thread(target=self._load_track_covers, daemon=True).start()
        threading.Thread(target=self._load_album_covers, daemon=True).start()

    def _load_track_covers(self):
        for i, (t, row) in enumerate(zip(self.track_data, self.track_rows)):
            url = track_cover_url(t)
            img = fetch_cover_image(url)
            if img and i < len(self.track_rows):
                self.after(0, lambda r=row, im=img: r.set_cover(im))

    def _load_album_covers(self):
        for i, (a, card) in enumerate(zip(self.album_data, self.album_cards)):
            url = album_cover_url(a)
            img = fetch_cover_image(url)
            if img and i < len(self.album_cards):
                self.after(0, lambda c=card, im=img: c.set_cover(im))

    # ── Album expand ──────────────────────────────────────────────────────────

    def _open_album(self, index: int):
        album   = self.album_data[index]
        api_key = self.cfg.get("api_key", "").strip()
        self._log(f"↳  Загрузка треков: {album.get('title','')}")
        threading.Thread(target=self._load_album,
                         args=(album, api_key), daemon=True).start()

    def _load_album(self, album: dict, api_key: str):
        try:
            data   = api_album(str(album.get("id", "")), api_key)
            tracks = data.get("tracks", {})
            if isinstance(tracks, dict):
                tracks = tracks.get("items", [])
            alb_title = album.get("title", "")
            normalized = []
            for t in tracks:
                normalized.append({
                    **t,
                    "albumTitle": alb_title,
                    "cover":      album_cover_url(album),
                })
            self._log(f"   {len(normalized)} треков")
            self.after(0, lambda: self._append_tracks(normalized))
        except Exception as e:
            self._log(f"✗  {e}")

    def _append_tracks(self, tracks: list):
        start = len(self.track_data)
        self.track_data.extend(tracks)
        for i, t in enumerate(tracks, start=start):
            row = TrackRow(self._tracks_frame, t, i,
                           on_select=self._on_track_select,
                           on_download=self._download_single,
                           on_play=self._play_track)
            row.pack(fill="x", pady=2)
            self.track_rows.append(row)
        self._switch_tab("tracks")
        threading.Thread(target=self._load_track_covers, daemon=True).start()

    # ── Player ───────────────────────────────────────────────────────────────

    def _play_track(self, track: dict):
        api_key = self.cfg.get("api_key", "").strip()
        if not api_key:
            messagebox.showwarning("API Key", "Укажите Paxsenix API Key в настройках")
            self._open_settings()
            return

        title = track.get("title", "")
        artist = track_artist(track)
        self._current_track = track
        self._player_paused = False
        self._play_btn.configure(text="…")
        self._now_lbl.configure(text=f"Загрузка: {artist} — {title}")
        threading.Thread(target=self._do_play_track, args=(track, api_key), daemon=True).start()

    def _do_play_track(self, track: dict, api_key: str):
        try:
            path = prepare_preview_file(track, api_key)
            title = track.get("title", "")
            artist = track_artist(track)
            self._player.play(path)
            self.after(0, lambda: self._set_now_playing(artist, title))
        except Exception as e:
            self.after(0, lambda: self._player_error(e))

    def _set_now_playing(self, artist: str, title: str):
        self._play_btn.configure(text="⏸")
        self._now_lbl.configure(text=f"Играет: {artist} — {title}")

    def _player_error(self, err: Exception):
        self._play_btn.configure(text="▶")
        self._now_lbl.configure(text="Не удалось включить трек")
        self._log(f"✗  Плеер: {err}")

    def _toggle_player(self):
        if self._current_track is None:
            return
        if self._player_paused:
            self._player.resume()
            self._player_paused = False
            self._play_btn.configure(text="⏸")
        elif self._player.is_playing():
            self._player.pause()
            self._player_paused = True
            self._play_btn.configure(text="▶")
        else:
            self._play_track(self._current_track)

    def _stop_player(self):
        self._player.stop()
        self._player_paused = False
        self._play_btn.configure(text="▶")
        self._now_lbl.configure(text="Остановлено")

    # ── Selection & Download ──────────────────────────────────────────────────

    def _on_track_select(self, index: int, selected: bool):
        if selected:
            self.selected.add(index)
        else:
            self.selected.discard(index)
        count = len(self.selected)
        self._dl_btn.configure(
            text=f"⬇  Скачать {count}" if count > 0 else "⬇  Скачать выбранное")

    def _download_single(self, track: dict):
        folder = self._get_folder()
        if not folder:
            return
        api_key  = self.cfg.get("api_key", "").strip()
        quality  = self._quality_var.get()
        template = self.cfg.get("filename_template", "{artist} - {title}")
        self._prog.start()
        threading.Thread(target=self._do_download,
                         args=([track], quality, folder, template, api_key),
                         daemon=True).start()

    def _download_selected(self):
        if self._busy:
            return
        if not self.selected:
            messagebox.showinfo("Выбор", "Кликни по трекам чтобы выбрать, или нажми ↓ у трека")
            return
        folder = self._get_folder()
        if not folder:
            return
        api_key  = self.cfg.get("api_key", "").strip()
        quality  = self._quality_var.get()
        template = self.cfg.get("filename_template", "{artist} - {title}")
        self.cfg["quality"] = quality
        save_config(self.cfg)
        tracks = [self.track_data[i] for i in sorted(self.selected)
                  if i < len(self.track_data)]
        self._busy = True
        self._prog.start()
        threading.Thread(target=self._do_download,
                         args=(tracks, quality, folder, template, api_key),
                         daemon=True).start()

    def _do_download(self, tracks, quality, folder, template, api_key):
        os.makedirs(folder, exist_ok=True)
        self._log(f"⬇  {len(tracks)} треков → {folder}")
        ok = fail = 0
        for i, track in enumerate(tracks):
            self.after(0, lambda v=i / len(tracks): self._prog.set(v))
            success = download_track(track, quality, folder, template, api_key, self._log)
            if success:
                ok += 1
                # Mark row green
                idx = self.track_data.index(track) if track in self.track_data else -1
                if idx >= 0 and idx < len(self.track_rows):
                    self.after(0, self.track_rows[idx].set_downloaded)
            else:
                fail += 1
        self._log(f"─  Готово: {ok} ✓  {fail} ✗")
        self._busy = False
        self.after(0, lambda: self._prog.set(1))

    def _get_folder(self) -> str | None:
        folder = self._folder_var.get().strip()
        if not folder:
            folder = filedialog.askdirectory(title="Куда скачивать?")
            if not folder:
                return None
            self._folder_var.set(folder)
            self.cfg["download_folder"] = folder
            save_config(self.cfg)
        return folder


def main():
    app = QobuzApp()
    app.mainloop()


if __name__ == "__main__":
    main()
