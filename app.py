"""
Local Video Editor - Flask backend.
Run with: python app.py
Then open http://127.0.0.1:5050 in your browser.

Everything runs locally: media files, project data, and renders are all
stored under ./data. Nothing is uploaded anywhere except the media source
URL you paste, which is fetched directly by yt-dlp on your machine.
"""
import os
import shutil
import threading
import uuid

from flask import Flask, jsonify, request, render_template, send_from_directory
from werkzeug.utils import secure_filename

from engine import project_store as ps
from engine import downloader
from engine import render as render_engine

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024 * 1024  # 8GB, local tool, big video files expected

# ---------------------------------------------------------------- jobs ----
# Long-running work (URL downloads, exports) runs in a background thread and
# reports progress through this in-memory registry, polled by the frontend.
JOBS = {}
JOBS_LOCK = threading.Lock()


def _new_job():
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {"status": "running", "progress": "Starting", "result": None, "error": None}
    return job_id


def _set_job(job_id, **kwargs):
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(kwargs)


def _get_job(job_id):
    with JOBS_LOCK:
        return dict(JOBS[job_id]) if job_id in JOBS else None


@app.route("/api/jobs/<job_id>")
def job_status(job_id):
    job = _get_job(job_id)
    if job is None:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job)


# ------------------------------------------------------------- pages ------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------- system check --

@app.route("/api/system/check")
def system_check():
    return jsonify({
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
        "yt_dlp": downloader.yt_dlp is not None,
    })


# ------------------------------------------------------------ projects ----

@app.route("/api/projects", methods=["GET"])
def api_list_projects():
    return jsonify(ps.list_projects())


@app.route("/api/projects", methods=["POST"])
def api_create_project():
    data = request.get_json(silent=True) or {}
    project = ps.new_project(
        name=data.get("name", "Untitled Project"),
        width=int(data.get("width", 1920)),
        height=int(data.get("height", 1080)),
        fps=int(data.get("fps", 30)),
    )
    return jsonify(project)


@app.route("/api/projects/<project_id>", methods=["GET"])
def api_get_project(project_id):
    try:
        return jsonify(ps.load_project(project_id))
    except FileNotFoundError:
        return jsonify({"error": "project not found"}), 404


@app.route("/api/projects/<project_id>", methods=["PUT"])
def api_update_project(project_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "missing project body"}), 400
    data["id"] = project_id
    ps.save_project(data)
    return jsonify({"ok": True, "modified": data["modified"]})


@app.route("/api/projects/<project_id>", methods=["DELETE"])
def api_delete_project(project_id):
    ps.delete_project(project_id)
    return jsonify({"ok": True})


# --------------------------------------------------------------- import ---

@app.route("/api/import/probe", methods=["POST"])
def api_import_probe():
    """Look up a pasted URL and report available quality options, without downloading."""
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "Paste a media URL first."}), 400
    try:
        info = downloader.probe_url(url)
        return jsonify(info)
    except Exception as e:
        return jsonify({"error": f"Could not read that link: {e}"}), 400


@app.route("/api/projects/<project_id>/import/url", methods=["POST"])
def api_import_url(project_id):
    """Kick off a background download + import at the chosen quality."""
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    quality = data.get("quality", "720p")
    if not url:
        return jsonify({"error": "Paste a media URL first."}), 400

    try:
        ps.load_project(project_id)
    except FileNotFoundError:
        return jsonify({"error": "project not found"}), 404

    job_id = _new_job()

    def work():
        try:
            _set_job(job_id, progress=f"Downloading ({quality})")
            dl = downloader.download(url, quality, ps.media_dir_for(project_id))
            _set_job(job_id, progress="Processing media")
            project = ps.load_project(project_id)
            entry = ps.register_media(
                project, dl["file_path"], media_id=dl["media_id"],
                display_name=dl["title"], origin="url", origin_url=url, quality_label=quality,
            )
            _set_job(job_id, status="done", progress="Done", result=entry)
        except Exception as e:
            _set_job(job_id, status="error", error=str(e), progress="Failed")

    threading.Thread(target=work, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/api/projects/<project_id>/import/upload", methods=["POST"])
def api_import_upload(project_id):
    """Import a local file directly (drag & drop / file picker)."""
    if "file" not in request.files:
        return jsonify({"error": "no file provided"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "no file selected"}), 400

    try:
        project = ps.load_project(project_id)
    except FileNotFoundError:
        return jsonify({"error": "project not found"}), 404

    mdir = ps.media_dir_for(project_id)
    staging_path = os.path.join(mdir, f"_upload_{uuid.uuid4().hex[:8]}_{secure_filename(f.filename)}")
    f.save(staging_path)
    try:
        entry = ps.register_media(project, staging_path, display_name=f.filename, origin="upload")
    finally:
        if os.path.exists(staging_path):
            os.remove(staging_path)
    return jsonify(entry)


@app.route("/api/projects/<project_id>/import/image", methods=["POST"])
def api_import_image(project_id):
    """Upload a still image for use as a text/image overlay layer."""
    if "file" not in request.files:
        return jsonify({"error": "no file provided"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "no file selected"}), 400
    try:
        ps.load_project(project_id)
    except FileNotFoundError:
        return jsonify({"error": "project not found"}), 404
    result = ps.save_overlay_image(project_id, f, f.filename)
    return jsonify(result)


@app.route("/api/projects/<project_id>/media/<media_id>", methods=["DELETE"])
def api_delete_media(project_id, media_id):
    project = ps.load_project(project_id)
    project["media_pool"] = [m for m in project["media_pool"] if m["id"] != media_id]
    for track in project["tracks"]:
        track["clips"] = [c for c in track["clips"] if c.get("media_id") != media_id]
    ps.save_project(project)
    return jsonify({"ok": True})


# --------------------------------------------------------------- export ---

@app.route("/api/projects/<project_id>/export", methods=["POST"])
def api_export(project_id):
    data = request.get_json(silent=True) or {}
    export_format = data.get("format", "mp4")
    resolution = data.get("resolution", "source")
    subtitle_mode = data.get("subtitle_mode", "burn")

    try:
        project = ps.load_project(project_id)
    except FileNotFoundError:
        return jsonify({"error": "project not found"}), 404

    job_id = _new_job()

    def work():
        def cb(msg):
            _set_job(job_id, progress=msg)
        try:
            out_path = render_engine.render_project(
                project, export_format=export_format, resolution_label=resolution,
                subtitle_mode=subtitle_mode, progress_cb=cb,
            )
            _set_job(job_id, status="done", progress="Done", result={"filename": os.path.basename(out_path)})
        except Exception as e:
            _set_job(job_id, status="error", error=str(e), progress="Failed")

    threading.Thread(target=work, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/renders/<path:filename>")
def get_render(filename):
    return send_from_directory(render_engine.RENDERS_DIR, filename, as_attachment=True)


@app.route("/api/renders", methods=["GET"])
def list_renders():
    os.makedirs(render_engine.RENDERS_DIR, exist_ok=True)
    files = sorted(os.listdir(render_engine.RENDERS_DIR),
                    key=lambda f: os.path.getmtime(os.path.join(render_engine.RENDERS_DIR, f)), reverse=True)
    return jsonify([f for f in files if not f.startswith(".")])


# ---------------------------------------------------------------- media ---

@app.route("/media/<project_id>/<path:filename>")
def get_media_file(project_id, filename):
    directory = ps.media_dir_for(project_id)
    return send_from_directory(directory, filename)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5050))
    print(f"\n  Local Video Editor running at http://127.0.0.1:{port}\n")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
