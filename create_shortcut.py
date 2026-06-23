"""Run once to create a desktop shortcut with Spotify-style icon."""
import os
import struct
import zlib

# ── Generate a simple Spotify-green music-note icon (.ico) ───────────────────

def make_icon(path: str):
    """Create a 32x32 green circle with a music note as .ico"""
    from PIL import Image, ImageDraw

    sizes = [256, 64, 32, 16]
    frames = []

    for sz in sizes:
        img = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        # Green circle background
        pad = max(1, sz // 16)
        draw.ellipse([pad, pad, sz - pad, sz - pad], fill="#1DB954")

        # Music note (♪) — draw manually as shapes
        cx, cy = sz // 2, sz // 2
        r = sz * 0.18
        # Note head (filled ellipse)
        nx = cx - sz * 0.04
        ny = cy + sz * 0.12
        draw.ellipse([nx - r, ny - r * 0.7, nx + r, ny + r * 0.7],
                     fill="white")
        # Note stem
        sw = max(1, sz // 20)
        draw.rectangle([nx + r - sw, cy - sz * 0.18,
                        nx + r, ny],
                       fill="white")
        # Note flag
        fx = nx + r
        draw.polygon([
            (fx,           cy - sz * 0.18),
            (fx + sz * 0.2, cy - sz * 0.05),
            (fx + sz * 0.2, cy + sz * 0.02),
            (fx,           cy - sz * 0.06),
        ], fill="white")

        frames.append(img)

    frames[0].save(path, format="ICO",
                   sizes=[(s, s) for s in sizes],
                   append_images=frames[1:])


# ── Create desktop shortcut ───────────────────────────────────────────────────

def create_shortcut(vbs_path: str, icon_path: str):
    import subprocess

    desktop  = os.path.join(os.path.expanduser("~"), "Desktop")
    lnk_path = os.path.join(desktop, "Qobuz Downloader.lnk")
    work_dir = os.path.dirname(vbs_path)

    ps = f"""
$ws = New-Object -ComObject WScript.Shell
$s  = $ws.CreateShortcut('{lnk_path}')
$s.TargetPath       = 'wscript.exe'
$s.Arguments        = '"{vbs_path}"'
$s.WorkingDirectory = '{work_dir}'
$s.IconLocation     = '{icon_path},0'
$s.Description      = 'Qobuz Downloader'
$s.Save()
"""
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    print(f"Shortcut created: {lnk_path}")


if __name__ == "__main__":
    base = os.path.dirname(os.path.abspath(__file__))
    icon_path = os.path.join(base, "icon.ico")
    vbs_path  = os.path.join(base, "run.vbs")

    print("Generating icon...")
    try:
        make_icon(icon_path)
        print(f"Icon saved: {icon_path}")
    except Exception as e:
        print(f"Icon error: {e}")

    print("Creating desktop shortcut...")
    try:
        create_shortcut(vbs_path, icon_path)
    except Exception as e:
        print(f"Shortcut error: {e}")

    print("Done.")
