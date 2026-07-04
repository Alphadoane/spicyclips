"""
render.py
The render engine. Turns a project's timeline (tracks + clips + effects +
transitions + overlays + subtitles) into a final exported video.

Design: nothing here ever opens a source media file in write mode. Every
editing decision (trim points, arrangement, effects, transitions) is only
resolved into pixels at export time, into a fresh file under data/renders.
Re-opening a project for further edits costs nothing - it's just JSON.

Pipeline:
  1. Each track is rendered in isolation to a full-timeline-length file
     (video tracks keep an alpha channel so gaps are transparent; audio
     tracks get silence in gaps). Overlapping adjacent clips on a track
     become a transition (crossfade) automatically, matching how most
     NLEs treat clip overlap.
  2. Video tracks are composited bottom-to-top with `overlay`; audio
     tracks are mixed with `amix`.
  3. Text/image overlays and subtitles are applied to the composite.
  4. The result is scaled/encoded to the requested export format.
"""
import os
import shutil
import subprocess
import time
import uuid

from engine.project_store import BASE_DIR, abs_path

RENDERS_DIR = os.path.join(BASE_DIR, "data", "renders")
TMP_ROOT = os.path.join(BASE_DIR, "data", "tmp")

XFADE_TRANSITIONS = {
    "fade", "dissolve", "wipeleft", "wiperight", "wipeup", "wipedown",
    "slideleft", "slideright", "slideup", "slidedown",
    "circleopen", "circleclose", "radial", "pixelize",
}

EXPORT_PRESETS = {
    "mp4": {"vcodec": "libx264", "acodec": "aac",
            "extra": ["-preset", "medium", "-crf", "20", "-movflags", "+faststart"]},
    "mov": {"vcodec": "libx264", "acodec": "aac",
            "extra": ["-preset", "medium", "-crf", "18"]},
    "webm": {"vcodec": "libvpx-vp9", "acodec": "libopus",
              "extra": ["-b:v", "0", "-crf", "30"]},
    "gif": {"vcodec": "gif", "acodec": None, "extra": []},
}

RESOLUTION_HEIGHTS = {
    "360p": 360, "480p": 480, "720p": 720,
    "1080p": 1080, "1440p": 1440, "4K": 2160, "source": None,
}


class RenderError(RuntimeError):
    pass


def _run(cmd, desc=""):
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RenderError(f"ffmpeg step failed ({desc}):\n{result.stderr[-3000:]}")
    return result


# ---------------------------------------------------------------- helpers --

def get_media(project, media_id):
    for m in project["media_pool"]:
        if m["id"] == media_id:
            return m
    raise RenderError(f"Media '{media_id}' referenced by a clip but not found in project")


def audio_source_path(media_entry):
    if media_entry.get("extracted_audio_path"):
        return abs_path(media_entry["extracted_audio_path"])
    return abs_path(media_entry["file_path"])


def timeline_duration(project):
    end = 0.0
    for track in project["tracks"]:
        for clip in track["clips"]:
            end = max(end, clip["start"] + clip["duration"])
    return end


EFFECT_FILTERS = {
    "brightness": lambda v: f"eq=brightness={v}",
    "contrast": lambda v: f"eq=contrast={v}",
    "saturation": lambda v: f"eq=saturation={v}",
    "grayscale": lambda v: "hue=s=0",
    "sepia": lambda v: "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:0",
    "blur": lambda v: f"gblur=sigma={max(0.1, float(v or 2))}",
    "mirror": lambda v: "hflip",
}


def build_effect_chain(effects):
    out = []
    for e in effects or []:
        fn = EFFECT_FILTERS.get(e.get("type"))
        if fn:
            out.append(fn(e.get("value")))
    return out


# ------------------------------------------------------- segment renderers --

def render_gap_segment(duration, project, out_path, kind="video"):
    duration = max(0.04, duration)
    if kind == "video":
        w, h, fps = project["settings"]["width"], project["settings"]["height"], project["settings"]["fps"]
        cmd = ["ffmpeg", "-y", "-f", "lavfi",
               "-i", f"color=c=black@0.0:s={w}x{h}:r={fps}:d={duration}",
               "-vf", "format=yuva420p", "-c:v", "qtrle", out_path]
    else:
        sr = project["settings"]["sample_rate"]
        cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r={sr}:cl=stereo",
               "-t", str(duration), "-c:a", "pcm_s16le", out_path]
    _run(cmd, "gap segment")
    return out_path


def render_video_segment(media_entry, clip, project, out_path, trim_in, trim_out):
    w, h, fps = project["settings"]["width"], project["settings"]["height"], project["settings"]["fps"]
    src = abs_path(media_entry["file_path"])
    speed = clip.get("speed", 1.0) or 1.0
    dur = max(0.04, trim_out - trim_in)

    vf = ["setpts=PTS-STARTPTS"]
    if speed != 1.0:
        vf.append(f"setpts=PTS/{speed}")
    vf += build_effect_chain(clip.get("effects"))
    vf.append(f"scale={w}:{h}:force_original_aspect_ratio=decrease")
    vf.append(f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black")
    vf.append("setsar=1")
    vf.append(f"fps={fps}")
    vf.append("format=yuva420p")

    cmd = ["ffmpeg", "-y", "-ss", str(max(0, trim_in)), "-i", src, "-t", str(dur),
           "-an", "-vf", ",".join(vf), "-c:v", "qtrle", out_path]
    _run(cmd, f"video segment {clip.get('id')}")
    return out_path


def render_video_transition(media_a, clip_a, media_b, clip_b, transition_type, duration, project, out_path):
    w, h, fps = project["settings"]["width"], project["settings"]["height"], project["settings"]["fps"]
    src_a, src_b = abs_path(media_a["file_path"]), abs_path(media_b["file_path"])
    a_in = max(0, clip_a["out"] - duration)
    b_in = max(0, clip_b["in"])
    t_type = transition_type if transition_type in XFADE_TRANSITIONS else "fade"

    prep = (f"setpts=PTS-STARTPTS,scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps}")
    filter_complex = (
        f"[0:v]{prep}[a];[1:v]{prep}[b];"
        f"[a][b]xfade=transition={t_type}:duration={duration}:offset=0,format=yuva420p[outv]"
    )
    cmd = ["ffmpeg", "-y",
           "-ss", str(a_in), "-t", str(duration), "-i", src_a,
           "-ss", str(b_in), "-t", str(duration), "-i", src_b,
           "-filter_complex", filter_complex, "-map", "[outv]", "-c:v", "qtrle", out_path]
    _run(cmd, "video transition")
    return out_path


def render_audio_segment(src_path, clip, project, out_path, trim_in, trim_out):
    sr = project["settings"]["sample_rate"]
    dur = max(0.04, trim_out - trim_in)
    gain_db = clip.get("gain_db", 0) or 0

    af = ["asetpts=PTS-STARTPTS", f"aformat=sample_rates={sr}:channel_layouts=stereo"]
    if gain_db:
        af.append(f"volume={gain_db}dB")
    if clip.get("fade_in"):
        af.append(f"afade=t=in:st=0:d={clip['fade_in']}")
    if clip.get("fade_out"):
        af.append(f"afade=t=out:st={max(0, dur - clip['fade_out'])}:d={clip['fade_out']}")

    cmd = ["ffmpeg", "-y", "-ss", str(max(0, trim_in)), "-i", src_path, "-t", str(dur),
           "-vn", "-af", ",".join(af), "-c:a", "pcm_s16le", out_path]
    _run(cmd, f"audio segment {clip.get('id')}")
    return out_path


def render_audio_transition(clip_a, clip_b, duration, project, out_path, src_a, src_b):
    sr = project["settings"]["sample_rate"]
    a_in = max(0, clip_a["out"] - duration)
    b_in = max(0, clip_b["in"])
    filter_complex = (
        f"[0:a]aformat=sample_rates={sr}:channel_layouts=stereo[a];"
        f"[1:a]aformat=sample_rates={sr}:channel_layouts=stereo[b];"
        f"[a][b]acrossfade=d={duration}[outa]"
    )
    cmd = ["ffmpeg", "-y",
           "-ss", str(a_in), "-t", str(duration), "-i", src_a,
           "-ss", str(b_in), "-t", str(duration), "-i", src_b,
           "-filter_complex", filter_complex, "-map", "[outa]", "-c:a", "pcm_s16le", out_path]
    _run(cmd, "audio transition")
    return out_path


# ------------------------------------------------------------ track build --

def build_track_segments(track, total_duration):
    """Walk a track's clips in order and turn them into gap / clip / transition
    segments covering [0, total_duration]. Overlapping adjacent clips become
    a transition automatically (standard NLE behaviour: drag one clip over
    another to create a crossfade)."""
    clips = sorted(track["clips"], key=lambda c: c["start"])
    segments = []
    cursor = 0.0
    n = len(clips)

    for i, clip in enumerate(clips):
        prev_overlap = 0.0
        if i > 0:
            prev = clips[i - 1]
            prev_overlap = max(0.0, (prev["start"] + prev["duration"]) - clip["start"])
            prev_overlap = min(prev_overlap, clip["duration"])
        next_overlap = 0.0
        if i < n - 1:
            nxt = clips[i + 1]
            next_overlap = max(0.0, (clip["start"] + clip["duration"]) - nxt["start"])
            next_overlap = min(next_overlap, clip["duration"] - prev_overlap)

        main_start = clip["start"] + prev_overlap
        main_end = clip["start"] + clip["duration"] - next_overlap
        main_duration = max(0.0, main_end - main_start)

        if main_start > cursor + 1e-6:
            segments.append({"kind": "gap", "start": cursor, "duration": main_start - cursor})

        if main_duration > 1e-6:
            speed = clip.get("speed", 1.0) or 1.0
            seg_in = clip["in"] + prev_overlap * speed
            seg_out = clip["out"] - next_overlap * speed
            segments.append({
                "kind": "clip", "start": main_start, "duration": main_duration,
                "clip": clip, "trim_in": seg_in, "trim_out": seg_out,
            })
            cursor = main_start + main_duration
        else:
            cursor = max(cursor, main_start)

        if next_overlap > 1e-6 and i < n - 1:
            nxt = clips[i + 1]
            t_type = (nxt.get("transition_in") or {}).get("type", "fade")
            segments.append({
                "kind": "transition", "start": cursor, "duration": next_overlap,
                "clip_a": clip, "clip_b": nxt, "transition_type": t_type,
            })
            cursor += next_overlap

    if total_duration > cursor + 1e-6:
        segments.append({"kind": "gap", "start": cursor, "duration": total_duration - cursor})

    return segments


def concat_segments(seg_files, tmp_dir, name, video=True):
    seg_files = [p for p in seg_files if p]
    if not seg_files:
        return None
    list_path = os.path.join(tmp_dir, f"{name}_concat.txt")
    with open(list_path, "w") as f:
        for p in seg_files:
            f.write(f"file '{os.path.abspath(p)}'\n")
    ext = "mov" if video else "wav"
    out_path = os.path.join(tmp_dir, f"{name}_full.{ext}")
    _run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path, "-c", "copy", out_path],
         f"concat {name}")
    return out_path


def render_video_track(track, project, tmp_dir, total_duration):
    segments = build_track_segments(track, total_duration)
    if not segments:
        return None
    seg_files = []
    for idx, seg in enumerate(segments):
        out_path = os.path.join(tmp_dir, f"{track['id']}_seg{idx}.mov")
        if seg["kind"] == "gap":
            render_gap_segment(seg["duration"], project, out_path, kind="video")
        elif seg["kind"] == "clip":
            media = get_media(project, seg["clip"]["media_id"])
            render_video_segment(media, seg["clip"], project, out_path, seg["trim_in"], seg["trim_out"])
        else:
            media_a = get_media(project, seg["clip_a"]["media_id"])
            media_b = get_media(project, seg["clip_b"]["media_id"])
            render_video_transition(media_a, seg["clip_a"], media_b, seg["clip_b"],
                                     seg["transition_type"], seg["duration"], project, out_path)
        seg_files.append(out_path)
    return concat_segments(seg_files, tmp_dir, track["id"], video=True)


def render_audio_track(track, project, tmp_dir, total_duration):
    segments = build_track_segments(track, total_duration)
    if not segments:
        return None
    seg_files = []
    for idx, seg in enumerate(segments):
        out_path = os.path.join(tmp_dir, f"{track['id']}_seg{idx}.wav")
        if seg["kind"] == "gap":
            render_gap_segment(seg["duration"], project, out_path, kind="audio")
        elif seg["kind"] == "clip":
            media = get_media(project, seg["clip"]["media_id"])
            render_audio_segment(audio_source_path(media), seg["clip"], project, out_path,
                                  seg["trim_in"], seg["trim_out"])
        else:
            media_a = get_media(project, seg["clip_a"]["media_id"])
            media_b = get_media(project, seg["clip_b"]["media_id"])
            render_audio_transition(seg["clip_a"], seg["clip_b"], seg["duration"], project, out_path,
                                     audio_source_path(media_a), audio_source_path(media_b))
        seg_files.append(out_path)
    return concat_segments(seg_files, tmp_dir, track["id"], video=False)


# --------------------------------------------------------- compositing ----

def composite_video_tracks(track_paths, tmp_dir):
    track_paths = [p for p in track_paths if p]
    if not track_paths:
        raise RenderError("No video tracks to composite")
    if len(track_paths) == 1:
        return track_paths[0]
    inputs = []
    for p in track_paths:
        inputs += ["-i", p]
    filter_parts = []
    prev_label = "0:v"
    last_label = prev_label
    for i in range(1, len(track_paths)):
        out_label = f"c{i}" if i < len(track_paths) - 1 else "vout"
        filter_parts.append(f"[{prev_label}][{i}:v]overlay=shortest=1[{out_label}]")
        prev_label = out_label
        last_label = out_label
    out_path = os.path.join(tmp_dir, "composited.mov")
    cmd = ["ffmpeg", "-y"] + inputs + ["-filter_complex", ";".join(filter_parts),
           "-map", f"[{last_label}]", "-c:v", "qtrle", out_path]
    _run(cmd, "composite video tracks")
    return out_path


def mix_audio_tracks(track_paths, tmp_dir):
    track_paths = [p for p in track_paths if p]
    if not track_paths:
        return None
    if len(track_paths) == 1:
        return track_paths[0]
    inputs = []
    for p in track_paths:
        inputs += ["-i", p]
    filter_complex = "".join(f"[{i}:a]" for i in range(len(track_paths)))
    filter_complex += f"amix=inputs={len(track_paths)}:duration=longest:dropout_transition=0[outa]"
    out_path = os.path.join(tmp_dir, "mixed_audio.wav")
    cmd = ["ffmpeg", "-y"] + inputs + ["-filter_complex", filter_complex, "-map", "[outa]",
           "-c:a", "pcm_s16le", out_path]
    _run(cmd, "mix audio tracks")
    return out_path


TEXT_POSITIONS = {
    "top-left": ("40", "40"),
    "top-center": ("(w-text_w)/2", "40"),
    "top-right": ("w-text_w-40", "40"),
    "center": ("(w-text_w)/2", "(h-text_h)/2"),
    "bottom-left": ("40", "h-text_h-60"),
    "bottom-center": ("(w-text_w)/2", "h-text_h-60"),
    "bottom-right": ("w-text_w-40", "h-text_h-60"),
}

IMAGE_POSITIONS = {
    "top-left": ("40", "40"),
    "top-center": ("(main_w-overlay_w)/2", "40"),
    "top-right": ("main_w-overlay_w-40", "40"),
    "center": ("(main_w-overlay_w)/2", "(main_h-overlay_h)/2"),
    "bottom-left": ("40", "main_h-overlay_h-40"),
    "bottom-center": ("(main_w-overlay_w)/2", "main_h-overlay_h-40"),
    "bottom-right": ("main_w-overlay_w-40", "main_h-overlay_h-40"),
}


def apply_overlays(video_path, overlay_track, project, tmp_dir):
    clips = overlay_track["clips"] if overlay_track else []
    if not clips:
        return video_path

    filter_parts = []
    image_inputs = []
    input_idx = 1
    last_label = "0:v"

    for i, clip in enumerate(clips):
        start, end = clip["start"], clip["start"] + clip["duration"]
        position = clip.get("position", "bottom-center")
        if clip["type"] == "text":
            style = clip.get("style", {}) or {}
            color = style.get("color", "white")
            size = style.get("size", 48)
            box = ":box=1:boxcolor=black@0.5:boxborderw=10" if style.get("background") else ""
            x, y = TEXT_POSITIONS.get(position, TEXT_POSITIONS["bottom-center"])
            text = str(clip.get("text", "")).replace("\\", "\\\\").replace("'", "\u2019").replace(":", "\\:")
            draw = (f"drawtext=text='{text}':fontcolor={color}:fontsize={size}{box}"
                    f":x={x}:y={y}:enable='between(t,{start},{end})'")
            out_label = f"ov{i}"
            filter_parts.append(f"[{last_label}]{draw}[{out_label}]")
            last_label = out_label
        elif clip["type"] == "image":
            img_path = abs_path(clip["file_path"])
            image_inputs += ["-i", img_path]
            scale = clip.get("scale", 1.0)
            opacity = clip.get("opacity", 1.0)
            x, y = IMAGE_POSITIONS.get(position, IMAGE_POSITIONS["bottom-center"])
            img_label = f"img{input_idx}"
            filter_parts.append(
                f"[{input_idx}:v]scale=iw*{scale}:ih*{scale},format=rgba,"
                f"colorchannelmixer=aa={opacity}[{img_label}]"
            )
            out_label = f"ov{i}"
            filter_parts.append(
                f"[{last_label}][{img_label}]overlay=x={x}:y={y}:"
                f"enable='between(t,{start},{end})'[{out_label}]"
            )
            last_label = out_label
            input_idx += 1

    if not filter_parts:
        return video_path

    out_path = os.path.join(tmp_dir, "with_overlays.mov")
    cmd = ["ffmpeg", "-y", "-i", video_path] + image_inputs + [
        "-filter_complex", ";".join(filter_parts), "-map", f"[{last_label}]",
        "-c:v", "qtrle", out_path]
    _run(cmd, "apply overlays")
    return out_path


def generate_srt(subtitle_clips, out_path):
    def fmt_ts(t):
        t = max(0.0, t)
        h = int(t // 3600)
        m = int((t % 3600) // 60)
        s = int(t % 60)
        ms = int(round((t - int(t)) * 1000))
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    with open(out_path, "w", encoding="utf-8") as f:
        for i, c in enumerate(sorted(subtitle_clips, key=lambda c: c["start"]), start=1):
            f.write(f"{i}\n{fmt_ts(c['start'])} --> {fmt_ts(c['start'] + c['duration'])}\n{c['text']}\n\n")
    return out_path


def burn_subtitles(video_path, srt_path, tmp_dir):
    out_path = os.path.join(tmp_dir, "with_subs.mov")
    escaped = srt_path.replace("\\", "/").replace(":", "\\:")
    cmd = ["ffmpeg", "-y", "-i", video_path, "-vf", f"subtitles='{escaped}'", "-c:v", "qtrle", out_path]
    _run(cmd, "burn subtitles")
    return out_path


# --------------------------------------------------------------- export ---

def final_encode(video_path, audio_path, out_path, export_format, resolution_label, project,
                  subtitle_srt=None, soft_subs=False):
    fmt = EXPORT_PRESETS[export_format]
    target_h = RESOLUTION_HEIGHTS.get(resolution_label)

    vf_parts = []
    if target_h and target_h != project["settings"]["height"]:
        vf_parts.append(f"scale=-2:{target_h}")
    vf_parts.append("format=rgb24" if export_format == "gif" else "format=yuv420p")
    if export_format == "gif":
        vf_parts.append("fps=15")

    inputs = ["-i", video_path]
    maps = ["-map", "0:v"]
    next_idx = 1
    if audio_path:
        inputs += ["-i", audio_path]
        maps += ["-map", f"{next_idx}:a"]
        next_idx += 1
    use_soft_subs = soft_subs and subtitle_srt and export_format in ("mp4", "mov")
    if use_soft_subs:
        inputs += ["-i", subtitle_srt]
        maps += ["-map", f"{next_idx}:s"]
        next_idx += 1

    cmd = ["ffmpeg", "-y"] + inputs + ["-vf", ",".join(vf_parts)] + maps

    if export_format == "gif":
        cmd += ["-loop", "0"]
    else:
        cmd += ["-c:v", fmt["vcodec"]] + fmt["extra"]
        if audio_path:
            cmd += ["-c:a", fmt["acodec"], "-b:a", "192k"]
        if use_soft_subs:
            cmd += ["-c:s", "mov_text"]
    cmd += [out_path]
    _run(cmd, "final encode")
    return out_path


# ------------------------------------------------------------ orchestrate --

def render_project(project, export_format="mp4", resolution_label="source",
                    subtitle_mode="burn", out_name=None, progress_cb=None):
    """subtitle_mode: 'burn' | 'soft' | 'none'"""
    def progress(msg):
        if progress_cb:
            progress_cb(msg)

    if export_format not in EXPORT_PRESETS:
        raise RenderError(f"Unsupported export format '{export_format}'")

    total_duration = timeline_duration(project)
    if total_duration <= 0:
        raise RenderError("Timeline is empty - add at least one clip before exporting.")

    os.makedirs(TMP_ROOT, exist_ok=True)
    tmp_dir = os.path.join(TMP_ROOT, f"render_{uuid.uuid4().hex[:8]}")
    os.makedirs(tmp_dir, exist_ok=True)

    try:
        video_tracks = [t for t in project["tracks"] if t["kind"] == "video" and t["clips"]]
        audio_tracks = [t for t in project["tracks"] if t["kind"] == "audio" and t["clips"]]
        overlay_track = next((t for t in project["tracks"] if t["kind"] == "overlay"), None)
        subtitle_track = next((t for t in project["tracks"] if t["kind"] == "subtitle"), None)

        progress("Rendering video tracks")
        track_video_paths = [render_video_track(t, project, tmp_dir, total_duration) for t in video_tracks]
        if not any(track_video_paths):
            blank = os.path.join(tmp_dir, "blank.mov")
            render_gap_segment(total_duration, project, blank, kind="video")
            track_video_paths = [blank]

        progress("Compositing video layers")
        composite = composite_video_tracks(track_video_paths, tmp_dir)

        progress("Rendering audio tracks")
        track_audio_paths = [render_audio_track(t, project, tmp_dir, total_duration) for t in audio_tracks]
        mixed_audio = mix_audio_tracks(track_audio_paths, tmp_dir) if any(track_audio_paths) else None

        progress("Applying overlays")
        with_overlays = apply_overlays(composite, overlay_track, project, tmp_dir)

        subtitle_srt = None
        if subtitle_track and subtitle_track["clips"] and subtitle_mode != "none":
            subtitle_srt = generate_srt(subtitle_track["clips"], os.path.join(tmp_dir, "subs.srt"))

        final_video = with_overlays
        if subtitle_srt and subtitle_mode == "burn":
            progress("Burning in subtitles")
            final_video = burn_subtitles(with_overlays, subtitle_srt, tmp_dir)

        progress("Encoding final export")
        os.makedirs(RENDERS_DIR, exist_ok=True)
        out_name = out_name or f"{project['name'].replace(' ', '_')}_{int(time.time())}"
        out_path = os.path.join(RENDERS_DIR, f"{out_name}.{export_format}")

        final_encode(final_video, mixed_audio, out_path, export_format, resolution_label,
                     project, subtitle_srt=subtitle_srt, soft_subs=(subtitle_mode == "soft"))
        progress("Done")
        return out_path
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
