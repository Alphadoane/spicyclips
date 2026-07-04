import { store, on, emit, getTrack, getClip, getMedia, markDirty, OVERLAY_POSITIONS } from './store.js';
import { el, toast } from './ui.js';

const SLIDER_EFFECTS = [
  { type: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.05, default: 0 },
  { type: 'contrast', label: 'Contrast', min: 0, max: 2, step: 0.05, default: 1 },
  { type: 'saturation', label: 'Saturation', min: 0, max: 3, step: 0.05, default: 1 },
  { type: 'blur', label: 'Blur', min: 0, max: 20, step: 0.5, default: 0 },
];
const TOGGLE_EFFECTS = [
  { type: 'grayscale', label: 'Grayscale' },
  { type: 'sepia', label: 'Sepia' },
  { type: 'mirror', label: 'Mirror (flip horizontal)' },
];
const TRANSITIONS = ['fade', 'dissolve', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown', 'circleopen', 'circleclose'];

export function initInspector() {
  on('selection:changed', renderInspector);
  on('project:loaded', renderInspector);
}

function renderInspector() {
  const container = document.getElementById('inspector-content');
  container.innerHTML = '';
  const sel = store.selection;
  if (!sel || !store.project) {
    container.appendChild(el('div', {
      class: 'empty-inspector',
      text: 'Select a clip on the timeline to edit its trim, effects, transition, or timing.',
    }));
    return;
  }
  const track = getTrack(sel.trackId);
  const clip = getClip(sel.trackId, sel.clipId);
  if (!track || !clip) { store.selection = null; renderInspector(); return; }

  if (track.kind === 'video') renderVideoClipInspector(container, track, clip);
  else if (track.kind === 'audio') renderAudioClipInspector(container, track, clip);
  else if (track.kind === 'overlay') renderOverlayClipInspector(container, track, clip);
  else if (track.kind === 'subtitle') renderSubtitleClipInspector(container, track, clip);
}

// ------------------------------------------------------------- helpers --

function fmtNum(v) {
  return (Math.round(v * 100) / 100).toString();
}

function sliderRow(labelText, value, min, max, step, onInput, onCommit) {
  const valSpan = el('span', { class: 'val', text: fmtNum(value) });
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    valSpan.textContent = fmtNum(v);
    onInput(v);
  });
  input.addEventListener('change', () => onCommit(parseFloat(input.value)));
  return el('div', { class: 'field' }, [
    el('label', { text: labelText }),
    el('div', { class: 'range-row' }, [input, valSpan]),
  ]);
}

function getEffect(clip, type) {
  return (clip.effects || []).find((e) => e.type === type);
}
function setEffectValue(clip, type, value) {
  if (!clip.effects) clip.effects = [];
  const e = clip.effects.find((x) => x.type === type);
  if (e) e.value = value; else clip.effects.push({ type, value });
}
function toggleEffect(clip, type, on_) {
  if (!clip.effects) clip.effects = [];
  const idx = clip.effects.findIndex((x) => x.type === type);
  if (on_ && idx === -1) clip.effects.push({ type });
  else if (!on_ && idx !== -1) clip.effects.splice(idx, 1);
}

function posLabel(p) {
  return p.split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join(' ');
}

// -------------------------------------------------------------- video ---

function renderVideoClipInspector(container, track, clip) {
  const media = getMedia(clip.media_id);
  container.appendChild(el('div', { class: 'insp-section' }, [
    el('h3', { text: 'Clip' }),
    el('div', { style: 'font-weight:600;font-size:13px;margin-bottom:4px;', text: media ? media.display_name : '(missing media)' }),
    el('div', { class: 'mono', style: 'font-size:11px;color:var(--text-dim);',
      text: `${clip.duration.toFixed(2)}s on timeline · source ${clip.in.toFixed(2)}–${clip.out.toFixed(2)}s` }),
  ]));

  const speedSection = el('div', { class: 'insp-section' }, [el('h3', { text: 'Speed' })]);
  speedSection.appendChild(sliderRow('Playback speed ×', clip.speed || 1, 0.25, 4, 0.05,
    () => {},
    (v) => {
      clip.speed = v;
      clip.duration = (clip.out - clip.in) / v;
      markDirty(); emit('timeline:changed'); renderInspector();
    }));
  container.appendChild(speedSection);

  const fxSection = el('div', { class: 'insp-section' }, [el('h3', { text: 'Effects' })]);
  SLIDER_EFFECTS.forEach((def) => {
    const existing = getEffect(clip, def.type);
    const value = existing ? existing.value : def.default;
    fxSection.appendChild(sliderRow(def.label, value, def.min, def.max, def.step,
      (v) => setEffectValue(clip, def.type, v),
      (v) => { setEffectValue(clip, def.type, v); markDirty(); emit('timeline:changed'); }));
  });
  TOGGLE_EFFECTS.forEach((def) => {
    const active = !!getEffect(clip, def.type);
    const cb = el('input', { type: 'checkbox' });
    cb.checked = active;
    cb.addEventListener('change', () => {
      toggleEffect(clip, def.type, cb.checked);
      markDirty(); emit('timeline:changed');
    });
    fxSection.appendChild(el('div', { class: 'effect-toggle' }, [
      el('label', { style: 'margin:0;text-transform:none;letter-spacing:0;font-size:12.5px;color:var(--text);', text: def.label }),
      cb,
    ]));
  });
  container.appendChild(fxSection);

  const clips = [...track.clips].sort((a, b) => a.start - b.start);
  const idx = clips.findIndex((c) => c.id === clip.id);
  const next = clips[idx + 1];
  if (next) {
    const overlap = Math.min(clip.duration, (clip.start + clip.duration) - next.start);
    if (overlap > 0.02) {
      const tSection = el('div', { class: 'insp-section' }, [
        el('h3', { text: 'Transition to next clip' }),
        el('div', { class: 'mono', style: 'font-size:11px;color:var(--text-dim);margin-bottom:8px;',
          text: `${overlap.toFixed(2)}s crossfade — drag clips on the timeline to change its length` }),
      ]);
      const select = el('select', {});
      TRANSITIONS.forEach((t) => {
        const opt = el('option', { value: t, text: t });
        if ((next.transition_in && next.transition_in.type) === t) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', () => {
        next.transition_in = { type: select.value, duration: overlap };
        markDirty(); emit('timeline:changed');
      });
      tSection.appendChild(select);
      container.appendChild(tSection);
    }
  }
}

// -------------------------------------------------------------- audio ---

function renderAudioClipInspector(container, track, clip) {
  const media = getMedia(clip.media_id);
  container.appendChild(el('div', { class: 'insp-section' }, [
    el('h3', { text: 'Clip' }),
    el('div', { style: 'font-weight:600;font-size:13px;margin-bottom:4px;', text: media ? media.display_name : '(missing media)' }),
    el('div', { class: 'mono', style: 'font-size:11px;color:var(--text-dim);', text: `${clip.duration.toFixed(2)}s on timeline` }),
  ]));

  const section = el('div', { class: 'insp-section' }, [el('h3', { text: 'Volume & fades' })]);
  section.appendChild(sliderRow('Gain (dB)', clip.gain_db || 0, -40, 12, 0.5,
    (v) => { clip.gain_db = v; },
    (v) => { clip.gain_db = v; markDirty(); emit('timeline:changed'); }));
  const maxFade = Math.max(0.5, clip.duration / 2);
  section.appendChild(sliderRow('Fade in (s)', clip.fade_in || 0, 0, Math.min(10, maxFade), 0.1,
    (v) => { clip.fade_in = v; },
    (v) => { clip.fade_in = v; markDirty(); emit('timeline:changed'); }));
  section.appendChild(sliderRow('Fade out (s)', clip.fade_out || 0, 0, Math.min(10, maxFade), 0.1,
    (v) => { clip.fade_out = v; },
    (v) => { clip.fade_out = v; markDirty(); emit('timeline:changed'); }));
  container.appendChild(section);
}

// ------------------------------------------------------------ overlay ---

function renderOverlayClipInspector(container, track, clip) {
  const section = el('div', { class: 'insp-section' }, [el('h3', { text: clip.type === 'text' ? 'Text overlay' : 'Image overlay' })]);

  if (clip.type === 'text') {
    const ta = el('textarea', { rows: '3' });
    ta.value = clip.text || '';
    ta.addEventListener('input', () => { clip.text = ta.value; });
    ta.addEventListener('change', () => { markDirty(); emit('timeline:changed'); });
    section.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Text' }), ta]));

    const colorInput = el('input', { type: 'color' });
    colorInput.value = (clip.style && clip.style.color) || '#ffffff';
    colorInput.addEventListener('input', () => { clip.style = clip.style || {}; clip.style.color = colorInput.value; });
    colorInput.addEventListener('change', () => { markDirty(); emit('timeline:changed'); });
    section.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Color' }), colorInput]));

    section.appendChild(sliderRow('Size', (clip.style && clip.style.size) || 48, 16, 140, 2,
      (v) => { clip.style = clip.style || {}; clip.style.size = v; },
      (v) => { clip.style = clip.style || {}; clip.style.size = v; markDirty(); emit('timeline:changed'); }));

    const bgCb = el('input', { type: 'checkbox' });
    bgCb.checked = !!(clip.style && clip.style.background);
    bgCb.addEventListener('change', () => {
      clip.style = clip.style || {};
      clip.style.background = bgCb.checked;
      markDirty(); emit('timeline:changed');
    });
    section.appendChild(el('div', { class: 'effect-toggle' }, [
      el('label', { style: 'margin:0;text-transform:none;letter-spacing:0;font-size:12.5px;color:var(--text);', text: 'Background plate' }),
      bgCb,
    ]));
  } else if (clip.type === 'image') {
    if (clip.file_path) {
      section.appendChild(el('img', {
        src: `/media/${store.project.id}/${clip.file_path.split('/').pop()}`,
        style: 'width:100%;border-radius:6px;margin-bottom:10px;display:block;',
      }));
    }
    section.appendChild(sliderRow('Scale', clip.scale || 1, 0.1, 2, 0.05,
      (v) => { clip.scale = v; },
      (v) => { clip.scale = v; markDirty(); emit('timeline:changed'); }));
    section.appendChild(sliderRow('Opacity', clip.opacity != null ? clip.opacity : 1, 0, 1, 0.05,
      (v) => { clip.opacity = v; },
      (v) => { clip.opacity = v; markDirty(); emit('timeline:changed'); }));
  }
  container.appendChild(section);

  const posSection = el('div', { class: 'insp-section' }, [el('h3', { text: 'Position' })]);
  const grid = el('div', { class: 'pos-presets' });
  OVERLAY_POSITIONS.forEach((p) => {
    const btn = el('button', { class: (clip.position || 'bottom-center') === p ? 'active' : '', text: posLabel(p) });
    btn.addEventListener('click', () => {
      clip.position = p;
      markDirty(); emit('timeline:changed');
      renderInspector();
    });
    grid.appendChild(btn);
  });
  posSection.appendChild(grid);
  container.appendChild(posSection);

  appendTimingFields(container, clip);
}

// ----------------------------------------------------------- subtitle ---

function renderSubtitleClipInspector(container, track, clip) {
  const section = el('div', { class: 'insp-section' }, [el('h3', { text: 'Subtitle' })]);
  const ta = el('textarea', { rows: '3' });
  ta.value = clip.text || '';
  ta.addEventListener('input', () => { clip.text = ta.value; });
  ta.addEventListener('change', () => { markDirty(); emit('timeline:changed'); });
  section.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Caption text' }), ta]));
  container.appendChild(section);
  appendTimingFields(container, clip);
}

// --------------------------------------------------------------- timing --

function appendTimingFields(container, clip) {
  const section = el('div', { class: 'insp-section' }, [el('h3', { text: 'Timing' })]);
  const row = el('div', { class: 'row' });

  const startInput = el('input', { type: 'number', step: '0.1', min: '0' });
  startInput.value = clip.start.toFixed(2);
  startInput.addEventListener('change', () => {
    clip.start = Math.max(0, parseFloat(startInput.value) || 0);
    markDirty(); emit('timeline:changed');
  });
  const durInput = el('input', { type: 'number', step: '0.1', min: '0.1' });
  durInput.value = clip.duration.toFixed(2);
  durInput.addEventListener('change', () => {
    clip.duration = Math.max(0.1, parseFloat(durInput.value) || 0.1);
    markDirty(); emit('timeline:changed');
  });

  row.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Start (s)' }), startInput]));
  row.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Duration (s)' }), durInput]));
  section.appendChild(row);
  container.appendChild(section);
}
