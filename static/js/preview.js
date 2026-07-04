import { store, emit, on, getMedia, timelineDuration, positionToStyle } from './store.js';

const audioPool = new Map(); // trackId -> HTMLAudioElement

export function initPreview() {
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-stop').addEventListener('click', () => {
    store.playing = false;
    store.playhead = 0;
    updatePlayIcon();
    emit('playhead:changed');
  });

  window.addEventListener('resize', updateStageSize);
  on('project:loaded', () => { updateStageSize(); });
  on('timeline:changed', () => {}); // picked up by the continuous render loop

  requestAnimationFrame(tick);
}

function togglePlay() {
  if (timelineDuration() <= 0) return;
  if (store.playhead >= timelineDuration() - 0.02) store.playhead = 0;
  store.playing = !store.playing;
  updatePlayIcon();
}

function updatePlayIcon() {
  document.getElementById('icon-play').style.display = store.playing ? 'none' : '';
  document.getElementById('icon-pause').style.display = store.playing ? '' : 'none';
}

function updateStageSize() {
  if (!store.project) return;
  const stage = document.getElementById('preview-stage');
  const wrap = document.getElementById('preview-wrap');
  const { width, height } = store.project.settings;
  const wrapRect = wrap.getBoundingClientRect();
  const maxW = Math.max(80, wrapRect.width - 48);
  const maxH = Math.max(80, wrapRect.height - 48);
  const ratio = width / height;
  let w = maxW, h = w / ratio;
  if (h > maxH) { h = maxH; w = h * ratio; }
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
}

// ------------------------------------------------------------ playback --

let lastTs = null;

function tick(ts) {
  if (store.playing && store.project) {
    if (lastTs != null) {
      const dt = (ts - lastTs) / 1000;
      store.playhead += dt;
      const dur = timelineDuration();
      if (store.playhead >= dur) {
        store.playhead = dur;
        store.playing = false;
        updatePlayIcon();
      }
    }
    lastTs = ts;
    emit('playhead:changed');
  } else {
    lastTs = null;
  }
  if (store.project) renderFrame(store.playhead);
  requestAnimationFrame(tick);
}

function fileUrl(relativePath) {
  const name = relativePath.split('/').pop();
  return `/media/${store.project.id}/${name}`;
}
function mediaUrl(media) { return fileUrl(media.file_path); }
function audioUrl(media) { return fileUrl(media.extracted_audio_path || media.file_path); }

function setLayerSource(videoEl, media, sourceTime, playing) {
  const url = mediaUrl(media);
  if (videoEl.dataset.mediaId !== media.id) {
    videoEl.src = url;
    videoEl.dataset.mediaId = media.id;
  }
  if (Math.abs(videoEl.currentTime - sourceTime) > 0.15 && sourceTime >= 0 && isFinite(sourceTime)) {
    try { videoEl.currentTime = sourceTime; } catch (e) { /* not ready yet */ }
  }
  if (playing) { if (videoEl.paused) videoEl.play().catch(() => {}); }
  else if (!videoEl.paused) videoEl.pause();
}

function applyClipEffectsCss(videoEl, clip) {
  const parts = [];
  (clip.effects || []).forEach((e) => {
    if (e.type === 'brightness') parts.push(`brightness(${1 + (e.value || 0)})`);
    else if (e.type === 'contrast') parts.push(`contrast(${e.value != null ? e.value : 1})`);
    else if (e.type === 'saturation') parts.push(`saturate(${e.value != null ? e.value : 1})`);
    else if (e.type === 'grayscale') parts.push('grayscale(1)');
    else if (e.type === 'sepia') parts.push('sepia(1)');
    else if (e.type === 'blur') parts.push(`blur(${e.value || 2}px)`);
  });
  videoEl.style.filter = parts.join(' ');
  videoEl.style.transform = (clip.effects || []).some((e) => e.type === 'mirror') ? 'scaleX(-1)' : 'none';
}

function renderFrame(time) {
  const project = store.project;
  const videoA = document.getElementById('video-a');
  const videoB = document.getElementById('video-b');
  const noPreview = document.getElementById('no-preview');
  const totalDur = timelineDuration();
  noPreview.classList.toggle('hidden', totalDur > 0);

  const videoTrack = project.tracks.find((t) => t.kind === 'video');
  const active = videoTrack
    ? videoTrack.clips.filter((c) => time >= c.start && time < c.start + c.duration).sort((a, b) => a.start - b.start)
    : [];

  if (active.length === 0) {
    videoA.style.opacity = 0; videoB.style.opacity = 0;
    if (!videoA.paused) videoA.pause();
    if (!videoB.paused) videoB.pause();
  } else if (active.length === 1) {
    const clip = active[0];
    const media = getMedia(clip.media_id);
    if (media) {
      const speed = clip.speed || 1;
      setLayerSource(videoA, media, clip.in + (time - clip.start) * speed, store.playing);
      applyClipEffectsCss(videoA, clip);
    }
    videoA.style.opacity = 1;
    videoB.style.opacity = 0;
    if (!videoB.paused) videoB.pause();
  } else {
    const outC = active[0], inC = active[1];
    const overlapDur = Math.min(outC.duration, (outC.start + outC.duration) - inC.start) || 0.001;
    const progress = Math.min(1, Math.max(0, (time - inC.start) / overlapDur));

    const mediaOut = getMedia(outC.media_id);
    const mediaIn = getMedia(inC.media_id);
    if (mediaOut) {
      const speed = outC.speed || 1;
      setLayerSource(videoA, mediaOut, outC.in + (time - outC.start) * speed, store.playing);
      applyClipEffectsCss(videoA, outC);
    }
    if (mediaIn) {
      const speed = inC.speed || 1;
      setLayerSource(videoB, mediaIn, inC.in + (time - inC.start) * speed, store.playing);
      applyClipEffectsCss(videoB, inC);
    }
    videoA.style.opacity = 1 - progress;
    videoB.style.opacity = progress;
  }

  renderAudio(time);
  renderOverlays(time);
}

function getAudioEl(trackId) {
  if (!audioPool.has(trackId)) {
    const a = new Audio();
    a.preload = 'auto';
    audioPool.set(trackId, a);
  }
  return audioPool.get(trackId);
}

function renderAudio(time) {
  const project = store.project;
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio');
  audioTracks.forEach((track) => {
    const el = getAudioEl(track.id);
    const clip = track.clips.find((c) => time >= c.start && time < c.start + c.duration);
    if (!clip) {
      if (!el.paused) el.pause();
      return;
    }
    const media = getMedia(clip.media_id);
    if (!media) return;
    const key = media.id + ':' + clip.id;
    if (el.dataset.key !== key) {
      el.src = audioUrl(media);
      el.dataset.key = key;
    }
    const srcTime = clip.in + (time - clip.start);
    if (Math.abs(el.currentTime - srcTime) > 0.2 && srcTime >= 0 && isFinite(srcTime)) {
      try { el.currentTime = srcTime; } catch (e) { /* not ready */ }
    }
    const gain = Math.pow(10, (clip.gain_db || 0) / 20);
    el.volume = Math.min(1, Math.max(0, gain));
    if (store.playing) { if (el.paused) el.play().catch(() => {}); }
    else if (!el.paused) el.pause();
  });
}

function renderOverlays(time) {
  const layer = document.getElementById('overlay-layer');
  layer.innerHTML = '';
  const project = store.project;
  const ovTrack = project.tracks.find((t) => t.kind === 'overlay');
  const subTrack = project.tracks.find((t) => t.kind === 'subtitle');

  (ovTrack ? ovTrack.clips : []).forEach((clip) => {
    if (time < clip.start || time >= clip.start + clip.duration) return;
    if (clip.type === 'text') {
      const style = clip.style || {};
      const div = document.createElement('div');
      div.className = 'overlay-text';
      div.textContent = clip.text || '';
      div.style.color = style.color || 'white';
      div.style.fontSize = Math.max(10, (style.size || 48) / 2) + 'px';
      if (style.background) {
        div.style.background = 'rgba(0,0,0,.55)';
        div.style.padding = '4px 12px';
        div.style.borderRadius = '5px';
      }
      Object.assign(div.style, positionToStyle(clip.position || 'bottom-center'));
      layer.appendChild(div);
    } else if (clip.type === 'image' && clip.file_path) {
      const img = document.createElement('img');
      img.src = fileUrl(clip.file_path);
      img.style.position = 'absolute';
      img.style.maxWidth = (30 * (clip.scale || 1)) + '%';
      img.style.opacity = clip.opacity != null ? clip.opacity : 1;
      Object.assign(img.style, positionToStyle(clip.position || 'bottom-center'));
      layer.appendChild(img);
    }
  });

  const activeSub = subTrack ? subTrack.clips.find((c) => time >= c.start && time < c.start + c.duration) : null;
  if (activeSub) {
    const cap = document.createElement('div');
    cap.className = 'subtitle-caption';
    cap.textContent = activeSub.text;
    layer.appendChild(cap);
  }
}
