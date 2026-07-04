"""
downloader.py
Media acquisition from URLs using yt-dlp.

Responsible-use note: this module can fetch any media a supported site serves
to yt-dlp. It is intended for content you own, have licensed, is under a
permissive/Creative-Commons license, or that the source platform explicitly
allows downloading. It does not circumvent DRM or paywalls. Respect the
terms of service of the site you are importing from and applicable copyright
law - that responsibility sits with whoever runs this tool.
"""
import os
import uuid

try:
    import yt_dlp
except ImportError:  # pragma: no cover - surfaced nicely to the user at call time
    yt_dlp = None

# Standard quality buckets we try to expose to the user, mapped to a max height.
QUALITY_BUCKETS = [
    ("360p", 360),
    ("480p", 480),
    ("720p", 720),
    ("1080p", 1080),
    ("1440p", 1440),
    ("4K", 2160),
]


def _require_ytdlp():
    if yt_dlp is None:
        raise RuntimeError(
            "yt-dlp is not installed. Run: pip install -r requirements.txt"
        )


def _get_cookies_opt():
    """Look for cookies.txt in the project root and return cookiefile option if present."""
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cookies_path = os.path.join(root_dir, "cookies.txt")
    if os.path.exists(cookies_path):
        return {"cookiefile": cookies_path}
    return {}


def probe_url(url):
    """
    Inspect a URL and return metadata plus the list of quality buckets
    actually available for it (only buckets with a matching format are returned).
    Does not download anything.
    """
    _require_ytdlp()
    ydl_opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    ydl_opts.update(_get_cookies_opt())
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    # A URL can resolve to a playlist; for the editor we only take the first item.
    if info.get("_type") == "playlist" and info.get("entries"):
        info = info["entries"][0]

    formats = info.get("formats", []) or []
    heights_available = sorted({f.get("height") for f in formats if f.get("height")})

    available_qualities = []
    for label, max_h in QUALITY_BUCKETS:
        # A bucket is offered if there's real source material at/above a size
        # that would credibly produce it (i.e. some format height falls in a
        # sensible range for that bucket, or exceeds it and can be downscaled).
        if any(h and h >= max_h * 0.85 for h in heights_available):
            available_qualities.append(label)

    if not available_qualities and heights_available:
        # Fallback: single-quality source (e.g. a direct mp4 link).
        from engine.media_probe import classify_quality
        available_qualities = [classify_quality(max(heights_available))]

    return {
        "title": info.get("title") or "Untitled",
        "duration": info.get("duration"),
        "thumbnail": info.get("thumbnail"),
        "uploader": info.get("uploader"),
        "webpage_url": info.get("webpage_url", url),
        "available_qualities": available_qualities or ["source"],
        "has_audio_only_option": True,
        "extractor": info.get("extractor"),
    }


def download(url, quality_label, dest_dir, media_id=None):
    """
    Download a URL at the requested quality bucket into dest_dir.
    Returns dict with file_path, audio_path (extracted), and probed metadata.
    """
    _require_ytdlp()
    os.makedirs(dest_dir, exist_ok=True)
    media_id = media_id or uuid.uuid4().hex[:12]

    max_h = dict(QUALITY_BUCKETS).get(quality_label)
    if quality_label == "audio":
        fmt_selector = "bestaudio/best"
    elif max_h:
        fmt_selector = (
            f"bestvideo[height<={max_h}]+bestaudio/best[height<={max_h}]/best"
        )
    else:
        fmt_selector = "bestvideo+bestaudio/best"

    out_template = os.path.join(dest_dir, f"{media_id}.%(ext)s")
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "format": fmt_selector,
        "outtmpl": out_template,
        "merge_output_format": "mp4",
        "postprocessors": [{
            "key": "FFmpegVideoConvertor",
            "preferedformat": "mp4",
        }] if quality_label != "audio" else [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "m4a",
        }],
    }
    ydl_opts.update(_get_cookies_opt())

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        if info.get("_type") == "playlist" and info.get("entries"):
            info = info["entries"][0]

    ext = "m4a" if quality_label == "audio" else "mp4"
    file_path = os.path.join(dest_dir, f"{media_id}.{ext}")
    if not os.path.exists(file_path):
        # yt-dlp sometimes keeps the original extension if conversion was skipped
        for f in os.listdir(dest_dir):
            if f.startswith(media_id):
                file_path = os.path.join(dest_dir, f)
                break

    return {
        "media_id": media_id,
        "file_path": file_path,
        "title": info.get("title") or "Untitled",
        "source_url": url,
        "quality_label": quality_label,
    }
