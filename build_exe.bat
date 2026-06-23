@echo off
chcp 65001 >nul
echo Installing dependencies...
python -m pip install customtkinter requests mutagen pillow pyinstaller --quiet

echo.
echo Building EXE...
python -m PyInstaller --onefile --windowed --name "QobuzDownloader" --hidden-import customtkinter --hidden-import PIL --hidden-import mutagen --collect-all customtkinter qobuz_gui.py

echo.
if exist "dist\QobuzDownloader.exe" (
    echo Done! EXE is in dist folder.
    start dist
) else (
    echo Build failed. See errors above.
)
pause
