"""
media_probe.py
Thin wrapper around ffprobe for reading metadata from media files.
Never modifies the source file - read only.
"""
import json
import subprocess


def probe(file_path):
    """Return a normalized metadata dict for a media file using ffprobe."""
    cmd = [
        "ffprobe", "-v", "error",
        "-print_format", "json",
        "-show_format", "-show_streams",
        file_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed for {file_path}: {result.stderr.strip()}")

    raw = json.loads(result.stdout)
    fmt = raw.get("format", {})
    streams = raw.get("streams", [])

    video_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = float(fmt.get("duration", 0) or 0)
    if duration == 0 and video_stream:
        duration = float(video_stream.get("duration", 0) or 0)
    if duration == 0 and audio_stream:
        duration = float(audio_stream.get("duration", 0) or 0)

    info = {
        "duration": duration,
        "has_video": video_stream is not None,
        "has_audio": audio_stream is not None,
        "width": None,
        "height": None,
        "fps": None,
        "video_codec": None,
        "audio_codec": None,
        "sample_rate": None,
        "channels": None,
        "size_bytes": int(fmt.get("size", 0) or 0),
    }

    if video_stream:
        info["width"] = video_stream.get("width")
        info["height"] = video_stream.get("height")
        info["video_codec"] = video_stream.get("codec_name")
        rate = video_stream.get("avg_frame_rate") or video_stream.get("r_frame_rate")
        if rate and rate != "0/0":
            num, _, den = rate.partition("/")
            try:
                info["fps"] = round(float(num) / float(den), 3) if den else float(num)
            except (ValueError, ZeroDivisionError):
                info["fps"] = None

    if audio_stream:
        info["audio_codec"] = audio_stream.get("codec_name")
        info["sample_rate"] = int(audio_stream["sample_rate"]) if audio_stream.get("sample_rate") else None
        info["channels"] = audio_stream.get("channels")

    return info


def classify_quality(height):
    """Map a pixel height to a friendly quality label."""
    if height is None:
        return "unknown"
    buckets = [
        (2160, "4K"), (1440, "1440p"), (1080, "1080p"),
        (720, "720p"), (480, "480p"), (360, "360p"), (240, "240p"),
    ]
    for min_h, label in buckets:
        if height >= min_h:
            return label
    return "240p"
