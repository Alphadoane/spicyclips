"""
project_store.py
Project persistence and media-pool management.

A project is a JSON document that references media files by relative path
and stores every editing decision (trims, arrangement, effects, transitions,
overlays, subtitles). Rendering only happens on export - opening or editing
a project never touches the original imported media files.
"""
import json
import os
import shutil
import subprocess
import time
import uuid

from engine import media_probe

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
PROJECTS_DIR = os.path.join(DATA_DIR, "projects")
MEDIA_ROOT = os.path.join(DATA_DIR, "media")
RENDERS_DIR = os.path.join(DATA_DIR, "renders")

for d in (PROJECTS_DIR, MEDIA_ROOT, RENDERS_DIR):
    os.makedirs(d, exist_ok=True)


def _project_path(project_id):
    return os.path.join(PROJECTS_DIR, f"{project_id}.json")


def new_project(name="Untitled Project", width=1920, height=1080, fps=30):
    project_id = uuid.uuid4().hex[:10]
    now = time.time()
    project = {
        "id": project_id,
        "name": name,
        "created": now,
        "modified": now,
        "settings": {"width": width, "height": height, "fps": fps, "sample_rate": 48000},
        "media_pool": [],
        "tracks": [
            {"id": "v1", "kind": "video", "name": "Video 1", "clips": []},
            {"id": "a1", "kind": "audio", "name": "Audio 1", "clips": []},
            {"id": "a2", "kind": "audio", "name": "Music", "clips": []},
            {"id": "ov1", "kind": "overlay", "name": "Overlays", "clips": []},
            {"id": "sub1", "kind": "subtitle", "name": "Subtitles", "clips": []},
        ],
    }
    os.makedirs(os.path.join(MEDIA_ROOT, project_id), exist_ok=True)
    save_project(project)
    return project


def save_project(project):
    project["modified"] = time.time()
    with open(_project_path(project["id"]), "w") as f:
        json.dump(project, f, indent=2)
    return project


def load_project(project_id):
    path = _project_path(project_id)
    if not os.path.exists(path):
        raise FileNotFoundError(f"No project with id {project_id}")
    with open(path) as f:
        return json.load(f)


def list_projects():
    out = []
    for fname in sorted(os.listdir(PROJECTS_DIR)):
        if fname.endswith(".json"):
            try:
                with open(os.path.join(PROJECTS_DIR, fname)) as f:
                    p = json.load(f)
                out.append({
                    "id": p["id"], "name": p["name"],
                    "modified": p["modified"], "created": p["created"],
                    "clip_count": sum(len(t["clips"]) for t in p["tracks"]),
                })
            except (json.JSONDecodeError, KeyError):
                continue
    return sorted(out, key=lambda p: p["modified"], reverse=True)


def delete_project(project_id):
    path = _project_path(project_id)
    if os.path.exists(path):
        os.remove(path)
    media_dir = os.path.join(MEDIA_ROOT, project_id)
    if os.path.exists(media_dir):
        shutil.rmtree(media_dir)


def media_dir_for(project_id):
    d = os.path.join(MEDIA_ROOT, project_id)
    os.makedirs(d, exist_ok=True)
    return d


def generate_thumbnail(file_path, out_path, at_seconds=0.5):
    cmd = [
        "ffmpeg", "-y", "-ss", str(at_seconds), "-i", file_path,
        "-frames:v", "1", "-vf", "scale=320:-2", out_path,
    ]
    subprocess.run(cmd, capture_output=True)
    return out_path if os.path.exists(out_path) else None


def extract_audio(file_path, out_path):
    """Pull the audio stream out of a video file into its own file.
    Read-only on the source - writes only to out_path."""
    cmd = [
        "ffmpeg", "-y", "-i", file_path, "-vn",
        "-acodec", "aac", "-b:a", "192k", out_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not os.path.exists(out_path):
        return None
    return out_path


def register_media(project, source_file, media_id=None, display_name=None,
                    origin="upload", origin_url=None, quality_label=None):
    """
    Add an already-downloaded/uploaded file into a project's media pool:
    probes it, generates a thumbnail, and (if it has both video and audio)
    extracts the audio into its own independent file.
    Returns the media_pool entry.
    """
    media_id = media_id or uuid.uuid4().hex[:12]
    mdir = media_dir_for(project["id"])

    info = media_probe.probe(source_file)
    ext = os.path.splitext(source_file)[1] or ".mp4"

    stored_path = os.path.join(mdir, f"{media_id}{ext}")
    if os.path.abspath(source_file) != os.path.abspath(stored_path):
        shutil.copy2(source_file, stored_path)

    entry = {
        "id": media_id,
        "display_name": display_name or os.path.basename(source_file),
        "origin": origin,
        "origin_url": origin_url,
        "quality_label": quality_label or media_probe.classify_quality(info["height"]),
        "file_path": os.path.relpath(stored_path, BASE_DIR),
        "duration": info["duration"],
        "width": info["width"],
        "height": info["height"],
        "fps": info["fps"],
        "has_video": info["has_video"],
        "has_audio": info["has_audio"],
        "thumbnail": None,
        "extracted_audio_path": None,
    }

    if info["has_video"]:
        thumb_path = os.path.join(mdir, f"{media_id}_thumb.jpg")
        thumb = generate_thumbnail(stored_path, thumb_path, at_seconds=min(0.5, (info["duration"] or 1) / 2))
        if thumb:
            entry["thumbnail"] = os.path.relpath(thumb, BASE_DIR)

    if info["has_video"] and info["has_audio"]:
        audio_path = os.path.join(mdir, f"{media_id}_audio.m4a")
        extracted = extract_audio(stored_path, audio_path)
        if extracted:
            entry["extracted_audio_path"] = os.path.relpath(extracted, BASE_DIR)

    project["media_pool"].append(entry)
    save_project(project)
    return entry


def save_overlay_image(project_id, file_storage, original_filename):
    """Save an uploaded image for use as an overlay layer. Kept separate from
    register_media() because ffprobe treats still images as 1-frame video
    streams, which would confuse the video-clip pipeline."""
    mdir = media_dir_for(project_id)
    ext = os.path.splitext(original_filename)[1].lower() or ".png"
    if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        ext = ".png"
    image_id = uuid.uuid4().hex[:12]
    stored_path = os.path.join(mdir, f"img_{image_id}{ext}")
    file_storage.save(stored_path)
    return {"file_path": os.path.relpath(stored_path, BASE_DIR), "id": image_id}


def abs_path(relative_path):
    return os.path.join(BASE_DIR, relative_path)
