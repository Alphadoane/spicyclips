#!/usr/bin/env bash
# Convenience launcher for Mac/Linux.
set -e
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  echo "Setting up a virtual environment (first run only)..."
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip >/dev/null
  ./.venv/bin/pip install -r requirements.txt
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo ""
  echo "WARNING: ffmpeg was not found on your PATH."
  echo "Install it first:"
  echo "  macOS:  brew install ffmpeg"
  echo "  Linux:  sudo apt install ffmpeg   (or your distro's package manager)"
  echo ""
fi

./.venv/bin/python app.py
