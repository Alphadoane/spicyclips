# Splice — a local video editor

Splice is a self-contained video editing app that runs entirely on your own
machine. It's a small local web app: a Python/Flask backend that does the
real work with `ffmpeg` and `yt-dlp`, and a browser-based timeline editor
UI. Nothing leaves your computer except the URLs you explicitly paste in to
import media.

## What it does

- **Import by pasting a link.** Paste a supported media URL, Splice looks up
  what qualities are actually available (360p–4K, or audio-only) and downloads
  the one you pick.
- **Trim and arrange multiple clips on a timeline**, non-destructively —
  your original source files are never modified. Trims, effects, and
  arrangement are just numbers in a project file until you export.
- **Audio is split out automatically.** When you add a video clip that has
  audio, Splice pulls the audio onto its own track so you can edit dialogue,
  music, and sound effects independently, then it's all re-synced at export.
- **Transitions.** Drag one clip to overlap the next on the timeline and it
  becomes a crossfade (or wipe/slide/etc.) automatically.
- **Text and image overlays**, with position presets and timing control.
- **Subtitles**, either burned into the video or as a soft/toggleable track.
- **Multiple export formats** — MP4, MOV, WebM, GIF — at any resolution up
  to your source quality.
- **Projects save automatically** as plain JSON referencing your media, so
  you can close the app and pick up editing later without re-importing or
  re-rendering anything.

## Requirements

- **Python 3.9+**
- **ffmpeg** (and `ffprobe`, which ships with it) — this does all the actual
  video processing.
  - **Windows (Automatic):** If `ffmpeg` is not found on your system, the Windows startup script will automatically download and install it locally within the project directory.
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg` (or your distro's equivalent)
- Internet access only when you're importing from a URL (yt-dlp needs it) —
  everything else works fully offline.

## Running it

**Windows:** double-click `run.bat`
- The script automatically handles setting up a Python virtual environment, installing dependencies, downloading a local copy of `ffmpeg` if not found, configuring paths, and starting the local web server.

**Mac/Linux:**
```
./run.sh
```

Then open **http://127.0.0.1:5050** in your browser.

## How your data is organized

Everything lives under `data/` next to `app.py`:
- `data/projects/*.json` — one file per project: every editing decision
  (trims, positions, effects, transitions, overlay/subtitle text, timing)
- `data/media/<project-id>/` — the source files you imported or uploaded for
  that project, plus auto-generated thumbnails and extracted-audio files.
  **Originals are never edited in place.**
- `data/renders/` — your exported output files, ready to grab.

Because a project file only stores *decisions* and references to media,
re-opening a project is instant, and you can keep refining it indefinitely
without ever re-encoding until you actually export.

## Using it

1. **New project** → pick a resolution.
2. **Media Pool** (left panel) → paste a link and pick a quality, or upload a
   file directly.
3. Drag a clip from the pool onto the timeline (or use the **+** button).
4. Drag clip edges to trim, drag clips to reposition, drag one clip to
   overlap the next to create a transition. Press **S** to split at the
   playhead, **Delete** to remove the selected clip.
5. Click a clip to edit it in the **Inspector** (right panel): trim, speed,
   effects, transition style, volume/fades, overlay text/position, subtitle
   timing.
6. Use the **T** / **img** buttons on the Overlays track, or **+** on the
   Subtitles track, to add those at the playhead.
7. **Export** (top right) → pick format, resolution, and whether subtitles
   should be burned in or a soft track.

## Known limitations (v1)

- The timeline UI works with **one video track** plus two audio tracks
  (dialogue + music), one overlay track, and one subtitle track — this
  covers the multi-clip cut-together-and-merge workflow the app is built
  around. The render engine itself supports stacking multiple video tracks
  (for picture-in-picture-style layers), it's just not yet wired into the
  timeline UI.
- The in-browser preview is a lightweight approximation (CSS filters
  standing in for the real ffmpeg effects, simple crossfades) meant for
  checking timing and arrangement. The actual export always does the exact
  ffmpeg processing, which is what determines final quality.
- No waveform rendering on audio clips yet (they show a placeholder
  pattern).
- No undo/redo yet — autosave means you also can't "discard changes,"
  though nothing is lost across sessions.

## A note on importing from URLs

The link importer uses [yt-dlp](https://github.com/yt-dlp/yt-dlp), the same
open-source engine behind many download tools. It can fetch whatever a site
serves it — it doesn't crack DRM or paywalls. That capability is powerful,
so please only use it for content you own, have the rights to, or that's
explicitly licensed for reuse (Creative Commons, your own uploads, stock
footage you've licensed, etc.), and respect the source platform's terms of
service and applicable copyright law.

## Troubleshooting

- **"ffmpeg was not found"** — install it (see Requirements) and restart the
  app. On Windows, make sure the `ffmpeg` folder's `bin` directory is on
  your PATH and open a new terminal afterward.
- **"yt-dlp is not installed"** — run `pip install -r requirements.txt`
  again inside the app's virtual environment. Local file upload works
  without it.
- **Port 5050 already in use** — set a different port:
  `PORT=5051 python app.py` (Mac/Linux) or `set PORT=5051 && python app.py`
  (Windows).
- **A specific site's link won't import** — yt-dlp supports a huge number
  of sites but not every one; try downloading the file yourself and using
  the upload button instead.
