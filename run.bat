@echo off
python -m pip install customtkinter requests mutagen pillow --quiet
python "%~dp0qobuz_gui.py"
pause
