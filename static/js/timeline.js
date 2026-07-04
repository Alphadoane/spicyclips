import { store, emit, on, getTrack, getClip, getMedia, timelineDuration, uid, markDirty, fmtTimecode } from './store.js';
import { el, toast } from './ui.js';
import { api } from './api.js';

const TRACK_COLORS = { video: 'var(--track-video)', audio: 'var(--track-audio)', overlay: 'var(--track-overlay)', subtitle: 'var(--track-subtitle)' };

export function initTimeline() {
  wireRulerScrub();

  document.getElementById('zoom-in').addEventListener('click', () => { store.zoom = Math.min(400, store.zoom * 1.3); renderAll(); });
  document.getElementById('zoom-out').addEventListener('click', () => { store.zoom = Math.max(8, store.zoom / 1.3); renderAll(); });
  document.getElementById('btn-split').addEventListener('click', splitSelectedAtPlayhead);
  document.getElementById('btn-delete-clip').addEventListener('click', deleteSelected);

  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === 's' || e.key === 'S') { splitSelectedAtPlayhead(); }
  });

  on('project:loaded', renderAll);
  on('media:changed', renderAll);
  on('timeline:changed', () => renderAll());
  on('playhead:changed', () => { updatePlayheadEl(); updateTimecodeDisplay(); });
  on('selection:changed', renderAll);
}

function totalWidth() {
  const dur = Math.max(timelineDuration() + 15, 20);
  return dur * store.zoom;
}

export function renderAll() {
  if (!store.project) return;
  renderTrackHeaders();
  renderRuler();
  renderTracks();
  updatePlayheadEl();
  updateTimecodeDisplay();
}

function renderTrackHeaders() {
  const wrap = document.getElementById('track-headers');
  wrap.innerHTML = '';
  store.project.tracks.forEach((track) => {
    wrap.appendChild(el('div', { class: 'track-header' }, [
      el('div', { style: 'display:flex; align-items:center; justify-content:space-between;' }, [
        el('div', {}, [
          el('span', { class: 'dot', style: `background:${TRACK_COLORS[track.kind]}` }),
          el('span', { class: 'tname', text: track.name }),
        ]),
        trackAddControls(track),
      ]),
      el('div', { class: 'tkind', text: track.kind }),
    ]));
  });
}

function trackAddControls(track) {
  if (track.kind === 'subtitle') {
    return el('button', {
      class: 'icon ghost small', title: 'Add subtitle at playhead',
      onclick: () => addSubtitleAtPlayhead(track),
    }, '+');
  }
  if (track.kind === 'overlay') {
    const wrap = el('div', { style: 'display:flex; gap:3px;' });
    wrap.appendChild(el('button', {
      class: 'icon ghost small', title: 'Add text overlay at playhead',
      onclick: () => addTextOverlayAtPlayhead(track),
    }, 'T'));
    const imgInput = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    imgInput.addEventListener('change', async () => {
      const file = imgInput.files[0];
      imgInput.value = '';
      if (!file) return;
      try {
        const res = await api.uploadOverlayImage(store.project.id, file);
        addImageOverlayAtPlayhead(track, res.file_path);
      } catch (e) { toast(e.message, 'error'); }
    });
    wrap.appendChild(el('button', {
      class: 'icon ghost small', title: 'Add image overlay at playhead',
      onclick: () => imgInput.click(),
    }, 'img'));
    wrap.appendChild(imgInput);
    return wrap;
  }
  return el('span', {});
}

function addSubtitleAtPlayhead(track) {
  const clip = { id: uid('sub'), start: store.playhead, duration: 3, text: 'New subtitle' };
  track.clips.push(clip);
  store.selection = { trackId: track.id, clipId: clip.id };
  markDirty(); emit('timeline:changed'); emit('selection:changed'); renderAll();
}

function addTextOverlayAtPlayhead(track) {
  const clip = {
    id: uid('ov'), type: 'text', text: 'New Text', start: store.playhead, duration: 3,
    position: 'bottom-center', style: { color: '#ffffff', size: 54, background: true },
  };
  track.clips.push(clip);
  store.selection = { trackId: track.id, clipId: clip.id };
  markDirty(); emit('timeline:changed'); emit('selection:changed'); renderAll();
}

function addImageOverlayAtPlayhead(track, filePath) {
  const clip = {
    id: uid('ov'), type: 'image', file_path: filePath, start: store.playhead, duration: 3,
    position: 'bottom-center', scale: 1, opacity: 1,
  };
  track.clips.push(clip);
  store.selection = { trackId: track.id, clipId: clip.id };
  markDirty(); emit('timeline:changed'); emit('selection:changed'); renderAll();
}

function renderRuler() {
  const ruler = document.getElementById('ruler');
  const sprockets = document.getElementById('sprockets');
  ruler.querySelectorAll('.tick').forEach((n) => n.remove());
  sprockets.innerHTML = '';
  const width = totalWidth();
  ruler.style.width = width + 'px';

  let interval = 1;
  if (store.zoom < 15) interval = 30;
  else if (store.zoom < 30) interval = 10;
  else if (store.zoom < 60) interval = 5;
  else if (store.zoom < 110) interval = 2;

  const dur = width / store.zoom;
  let count = 0;
  for (let t = 0; t <= dur && count < 2000; t += interval, count++) {
    const x = t * store.zoom;
    ruler.appendChild(el('div', { class: 'tick', style: `left:${x}px`, text: fmtTimecode(t, false) }));
  }
  const sprInterval = Math.max(interval / 2, 0.5);
  count = 0;
  for (let t = 0; t <= dur && count < 2500; t += sprInterval, count++) {
    sprockets.appendChild(el('i', { style: `left:${t * store.zoom}px` }));
  }
}

function renderTracks() {
  const tracksEl = document.getElementById('tracks');
  tracksEl.innerHTML = '';
  const width = totalWidth();
  tracksEl.style.width = width + 'px';

  store.project.tracks.forEach((track) => {
    const lane = el('div', { class: 'track-lane' });
    lane.style.width = width + 'px';
    wireDropTarget(lane, track);
    lane.addEventListener('click', () => {
      store.selection = null;
      emit('selection:changed');
      renderAll();
    });

    track.clips.forEach((clip) => lane.appendChild(renderClip(track, clip)));
    if (track.kind === 'video' || track.kind === 'audio') renderOverlapZones(lane, track);

    tracksEl.appendChild(lane);
  });
}

function renderOverlapZones(lane, track) {
  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  for (let i = 0; i < clips.length - 1; i++) {
    const a = clips[i], b = clips[i + 1];
    const overlap = Math.min(a.duration, (a.start + a.duration) - b.start);
    if (overlap > 0.02) {
      const left = b.start * store.zoom;
      const width = Math.max(overlap * store.zoom, 2);
      lane.appendChild(el('div', { class: 'transition-zone', style: `left:${left}px; width:${width}px;` }));
    }
  }
}

function clipLabel(track, clip) {
  if (track.kind === 'video' || track.kind === 'audio') {
    const media = getMedia(clip.media_id);
    return media ? media.display_name : '(missing media)';
  }
  if (track.kind === 'overlay') return clip.type === 'text' ? (clip.text || 'Text') : 'Image';
  if (track.kind === 'subtitle') return clip.text || '';
  return '';
}

function renderClip(track, clip) {
  const left = clip.start * store.zoom;
  const width = Math.max(clip.duration * store.zoom, 4);
  const isSelected = !!(store.selection && store.selection.trackId === track.id && store.selection.clipId === clip.id);

  const node = el('div', {
    class: `clip kind-${track.kind}` + (isSelected ? ' selected' : ''),
    style: `left:${left}px; width:${width}px;`,
    'data-clip-id': clip.id,
  });

  const body = el('div', { class: 'clip-body' }, [
    el('div', { class: 'clip-label', text: clipLabel(track, clip) }),
  ]);

  if (track.kind === 'video' || track.kind === 'audio') {
    const handleL = el('div', { class: 'handle' });
    const handleR = el('div', { class: 'handle' });
    node.appendChild(handleL);
    node.appendChild(body);
    node.appendChild(handleR);
    wireTrim(handleL, track, clip, 'left');
    wireTrim(handleR, track, clip, 'right');
  } else {
    node.appendChild(body);
  }

  node.addEventListener('click', (e) => {
    e.stopPropagation();
    store.selection = { trackId: track.id, clipId: clip.id };
    emit('selection:changed');
    renderAll();
  });

  wireDrag(node, track, clip);
  return node;
}

function clipNode(clipId) {
  return document.querySelector(`.clip[data-clip-id="${clipId}"]`);
}

function wireDrag(node, track, clip) {
  node.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('handle')) return;
    e.preventDefault();
    const startX = e.clientX;
    const initialStart = clip.start;
    let moved = false;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      const newStart = Math.max(0, initialStart + dx / store.zoom);
      clip.start = Math.round(newStart * 1000) / 1000;
      node.style.left = (clip.start * store.zoom) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved) {
        markDirty();
        emit('timeline:changed');
        renderAll();
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function wireTrim(handle, track, clip, side) {
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const media = getMedia(clip.media_id);
    const maxOut = media ? media.duration : Infinity;
    const speed = clip.speed || 1;
    const initialIn = clip.in, initialOut = clip.out, initialStart = clip.start;
    const minDur = 0.1;

    function onMove(ev) {
      const dxSec = (ev.clientX - startX) / store.zoom;
      if (side === 'left') {
        const newIn = Math.min(Math.max(0, initialIn + dxSec * speed), initialOut - minDur * speed);
        const deltaIn = newIn - initialIn;
        clip.in = newIn;
        clip.start = Math.max(0, initialStart + deltaIn / speed);
        clip.duration = (clip.out - clip.in) / speed;
      } else {
        const newOut = Math.max(Math.min(maxOut, initialOut + dxSec * speed), initialIn + minDur * speed);
        clip.out = newOut;
        clip.duration = (clip.out - clip.in) / speed;
      }
      const n = clipNode(clip.id);
      if (n) {
        n.style.left = (clip.start * store.zoom) + 'px';
        n.style.width = Math.max(clip.duration * store.zoom, 4) + 'px';
      }
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      markDirty();
      emit('timeline:changed');
      renderAll();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function wireDropTarget(lane, track) {
  lane.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/x-media-id')) {
      e.preventDefault();
      lane.classList.add('drop-target');
    }
  });
  lane.addEventListener('dragleave', () => lane.classList.remove('drop-target'));
  lane.addEventListener('drop', (e) => {
    e.preventDefault();
    lane.classList.remove('drop-target');
    const mediaId = e.dataTransfer.getData('application/x-media-id');
    if (!mediaId) return;
    const media = getMedia(mediaId);
    if (!media) return;
    const rect = lane.getBoundingClientRect();
    const dropTime = Math.max(0, (e.clientX - rect.left) / store.zoom);
    dropOnTrack(track, media, dropTime);
  });
}

function dropOnTrack(track, media, atTime) {
  const snapped = Math.round(atTime * 10) / 10;
  if (track.kind === 'video') {
    if (!media.has_video) { toast('Only video files can go on a video track', 'error'); return; }
    track.clips.push({
      id: uid('clip'), media_id: media.id, in: 0, out: media.duration,
      start: snapped, duration: media.duration, effects: [], speed: 1, transition_in: null,
    });
    if (media.has_audio) {
      const atrack = store.project.tracks.find((t) => t.kind === 'audio');
      if (atrack) {
        atrack.clips.push({
          id: uid('aclip'), media_id: media.id, in: 0, out: media.duration,
          start: snapped, duration: media.duration, gain_db: 0, fade_in: 0, fade_out: 0,
        });
      }
    }
  } else if (track.kind === 'audio') {
    if (!media.has_audio) { toast('This file has no audio', 'error'); return; }
    track.clips.push({
      id: uid('aclip'), media_id: media.id, in: 0, out: media.duration,
      start: snapped, duration: media.duration, gain_db: 0, fade_in: 0, fade_out: 0,
    });
  } else {
    toast('Drop video or audio clips onto a video/audio track', 'error');
    return;
  }
  markDirty();
  emit('timeline:changed');
  renderAll();
}

function splitSelectedAtPlayhead() {
  const sel = store.selection;
  if (!sel) { toast('Select a clip first', 'error'); return; }
  const track = getTrack(sel.trackId);
  const clip = getClip(sel.trackId, sel.clipId);
  if (!track || !clip) return;
  const t = store.playhead;
  if (t <= clip.start + 0.02 || t >= clip.start + clip.duration - 0.02) {
    toast('Move the playhead inside the selected clip to split', 'error');
    return;
  }
  const localOffset = t - clip.start;
  const newClip = JSON.parse(JSON.stringify(clip));
  newClip.id = uid('clip');

  if (track.kind === 'video' || track.kind === 'audio') {
    const speed = clip.speed || 1;
    const splitSrc = clip.in + localOffset * speed;
    newClip.in = splitSrc;
    newClip.start = t;
    newClip.duration = clip.duration - localOffset;
    clip.out = splitSrc;
    clip.duration = localOffset;
  } else {
    newClip.start = t;
    newClip.duration = clip.duration - localOffset;
    clip.duration = localOffset;
  }
  track.clips.push(newClip);
  store.selection = { trackId: track.id, clipId: newClip.id };
  markDirty();
  emit('timeline:changed');
  emit('selection:changed');
  renderAll();
}

function deleteSelected() {
  const sel = store.selection;
  if (!sel) return;
  const track = getTrack(sel.trackId);
  if (!track) return;
  track.clips = track.clips.filter((c) => c.id !== sel.clipId);
  store.selection = null;
  markDirty();
  emit('timeline:changed');
  emit('selection:changed');
  renderAll();
}

function wireRulerScrub() {
  const target = document.getElementById('ruler-click-target');
  function seekFromEvent(e) {
    const rect = target.getBoundingClientRect();
    const t = Math.max(0, (e.clientX - rect.left) / store.zoom);
    store.playhead = t;
    emit('playhead:changed');
  }
  target.addEventListener('mousedown', (e) => {
    seekFromEvent(e);
    function onMove(ev) { seekFromEvent(ev); }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function updatePlayheadEl() {
  const ph = document.getElementById('playhead');
  ph.style.left = (store.playhead * store.zoom) + 'px';
}

function updateTimecodeDisplay() {
  document.getElementById('tc-now').textContent = fmtTimecode(store.playhead);
  document.getElementById('tc-total').textContent = fmtTimecode(timelineDuration());
}
