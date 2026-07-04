// Central app state + a tiny pub/sub bus. No framework - modules subscribe
// to the events they care about and re-render just their own piece of DOM.

export const store = {
  project: null,        // current project object, mirrors the backend schema
  selection: null,      // { trackId, clipId } | null
  playhead: 0,           // seconds
  zoom: 70,               // pixels per second on the timeline
  playing: false,
  dirty: false,
};

const target = new EventTarget();

export function emit(name, detail) {
  target.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, fn) {
  target.addEventListener(name, fn);
}

// -------------------------------------------------------------- helpers --

export function getTrack(trackId) {
  return store.project?.tracks.find(t => t.id === trackId) || null;
}

export function getClip(trackId, clipId) {
  const track = getTrack(trackId);
  return track?.clips.find(c => c.id === clipId) || null;
}

export function getMedia(mediaId) {
  return store.project?.media_pool.find(m => m.id === mediaId) || null;
}

export function selectedClip() {
  if (!store.selection) return null;
  return getClip(store.selection.trackId, store.selection.clipId);
}

export function timelineDuration() {
  let end = 0;
  if (!store.project) return 0;
  for (const track of store.project.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.start + clip.duration);
    }
  }
  return end;
}

export function markDirty() {
  store.dirty = true;
  emit('project:dirty');
}

export function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

export const OVERLAY_POSITIONS = [
  'top-left', 'top-center', 'top-right',
  'center',
  'bottom-left', 'bottom-center', 'bottom-right',
];

// Mirrors engine/render.py's TEXT_POSITIONS / IMAGE_POSITIONS mapping, for
// the live browser preview (approximate - ffmpeg does the exact math at export).
export function positionToStyle(position) {
  const styles = {
    'top-left': { top: '6%', left: '6%', transform: 'translate(0,0)' },
    'top-center': { top: '6%', left: '50%', transform: 'translate(-50%,0)' },
    'top-right': { top: '6%', left: '94%', transform: 'translate(-100%,0)' },
    'center': { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' },
    'bottom-left': { top: '90%', left: '6%', transform: 'translate(0,-100%)' },
    'bottom-center': { top: '90%', left: '50%', transform: 'translate(-50%,-100%)' },
    'bottom-right': { top: '90%', left: '94%', transform: 'translate(-100%,-100%)' },
  };
  return styles[position] || styles['bottom-center'];
}

export function fmtTimecode(seconds, withMs = true) {
  seconds = Math.max(0, seconds || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds - Math.floor(seconds)) * 10);
  const pad = (n) => String(n).padStart(2, '0');
  return withMs ? `${pad(h)}:${pad(m)}:${pad(s)}.${tenths}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}
