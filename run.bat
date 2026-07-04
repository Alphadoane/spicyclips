@echo off
cd /d "%~dp0"

:: Add local ffmpeg to PATH if it exists
if exist "%~dp0ffmpeg\bin" (
  set "PATH=%~dp0ffmpeg\bin;%PATH%"
)

if not exist ".venv" (
  echo Setting up a virtual environment ^(first run only^)...
  python -m venv .venv
  .venv\Scripts\python.exe -m pip install --upgrade pip
  .venv\Scripts\pip install -r requirements.txt
)

where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo.
  echo ffmpeg was not found. Downloading and installing ffmpeg locally...
  .venv\Scripts\python.exe install_ffmpeg.py
  if exist "%~dp0ffmpeg\bin" (
    set "PATH=%~dp0ffmpeg\bin;%PATH%"
  )
)

.venv\Scripts\python app.py
pause
