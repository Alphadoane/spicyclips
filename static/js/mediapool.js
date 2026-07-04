import { store, emit, on, uid, markDirty } from './store.js';
import { api, pollJob } from './api.js';
import { toast, openModal, closeModal, wireModalDismiss, el } from './ui.js';

let selectedQuality = null;
let lastProbe = null;

export function initMediaPool() {
  wireModalDismiss('modal-import-url');
  document.getElementById('btn-import-url').addEventListener('click', () => {
    resetImportModal();
    openModal('modal-import-url');
  });
  document.getElementById('btn-probe-url').addEventListener('click', doProbe);
  document.getElementById('btn-start-import').addEventListener('click', doImport);

  document.getElementById('btn-upload').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });
  document.getElementById('file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const file of files) await doUpload(file);
  });

  on('project:loaded', renderMediaList);
  on('media:changed', renderMediaList);
}

function resetImportModal() {
  document.getElementById('import-url-input').value = '';
  document.getElementById('import-probe-result').classList.add('hidden');
  document.getElementById('import-progress').classList.add('hidden');
  document.getElementById('import-error').classList.add('hidden');
  document.getElementById('btn-start-import').disabled = true;
  document.getElementById('btn-probe-url').disabled = false;
  selectedQuality = null;
  lastProbe = null;
}

async function doProbe() {
  const url = document.getElementById('import-url-input').value.trim();
  if (!url) { toast('Paste a link first', 'error'); return; }
  const btn = document.getElementById('btn-probe-url');
  btn.disabled = true;
  btn.textContent = 'Looking up…';
  document.getElementById('import-error').classList.add('hidden');
  try {
    const info = await api.probeUrl(url);
    lastProbe = info;
    document.getElementById('import-title').textContent = info.title || 'Untitled';
    document.getElementById('import-thumb').src = info.thumbnail || '';
    document.getElementById('import-duration').textContent = info.duration
      ? `${Math.round(info.duration)}s · ${info.extractor || ''}` : (info.extractor || '');
    const grid = document.getElementById('import-quality-grid');
    grid.innerHTML = '';
    selectedQuality = null;
    (info.available_qualities || []).forEach((q) => {
      const b = el('button', { text: q, onclick: () => {
        selectedQuality = q;
        grid.querySelectorAll('button').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        document.getElementById('btn-start-import').disabled = false;
      }});
      grid.appendChild(b);
    });
    document.getElementById('import-probe-result').classList.remove('hidden');
  } catch (e) {
    showImportError(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Look up link';
  }
}

async function doImport() {
  if (!selectedQuality || !lastProbe) return;
  const url = document.getElementById('import-url-input').value.trim();
  const startBtn = document.getElementById('btn-start-import');
  startBtn.disabled = true;
  document.getElementById('import-progress').classList.remove('hidden');
  document.getElementById('import-error').classList.add('hidden');
  const msgEl = document.getElementById('import-progress-msg');
  msgEl.textContent = 'Starting download…';
  try {
    const { job_id } = await api.importUrl(store.project.id, url, selectedQuality);
    const job = await pollJob(job_id, (j) => { msgEl.textContent = j.progress || 'Working…'; });
    store.project.media_pool.push(job.result);
    await api.saveProject(store.project);
    emit('media:changed');
    toast(`Imported "${job.result.display_name}"`);
    closeModal('modal-import-url');
  } catch (e) {
    showImportError(e.message);
    startBtn.disabled = false;
  }
}

function showImportError(msg) {
  const box = document.getElementById('import-error');
  box.textContent = msg;
  box.classList.remove('hidden');
  document.getElementById('import-progress').classList.add('hidden');
}

async function doUpload(file) {
  toast(`Uploading "${file.name}"…`);
  try {
    const entry = await api.uploadFile(store.project.id, file);
    store.project.media_pool.push(entry);
    await api.saveProject(store.project);
    emit('media:changed');
    toast(`Added "${entry.display_name}" to media pool`);
  } catch (e) {
    toast(`Upload failed: ${e.message}`, 'error');
  }
}

function fmtDur(s) {
  if (!s && s !== 0) return '';
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function renderMediaList() {
  const list = document.getElementById('media-list');
  const empty = document.getElementById('media-empty');
  list.innerHTML = '';
  const pool = store.project?.media_pool || [];
  empty.classList.toggle('hidden', pool.length > 0);

  pool.forEach((media) => {
    const thumb = el('div', { class: 'thumb' });
    if (media.thumbnail) {
      thumb.style.backgroundImage = `url(/media/${store.project.id}/${media.thumbnail.split('/').pop()})`;
    } else {
      thumb.textContent = '♪';
    }
    const addBtn = el('button', {
      class: 'icon ghost add-btn', title: 'Add to timeline',
      onclick: () => addMediaToTimeline(media),
      text: '+',
    });
    const delBtn = el('button', {
      class: 'icon ghost add-btn', title: 'Remove from pool',
      onclick: async (ev) => {
        ev.stopPropagation();
        try {
          await api.deleteMedia(store.project.id, media.id);
          store.project.media_pool = store.project.media_pool.filter(m => m.id !== media.id);
          store.project.tracks.forEach(t => { t.clips = t.clips.filter(c => c.media_id !== media.id); });
          emit('media:changed');
          emit('timeline:changed');
        } catch (e) { toast(e.message, 'error'); }
      },
      text: '×',
    });

    const item = el('div', { class: 'media-item', draggable: 'true' }, [
      thumb,
      el('div', { class: 'meta' }, [
        el('div', { class: 'name', text: media.display_name }),
        el('div', { class: 'sub' }, [
          el('span', { class: 'badge', text: media.quality_label || '—' }),
          fmtDur(media.duration),
        ]),
      ]),
      addBtn, delBtn,
    ]);
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-media-id', media.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dblclick', () => addMediaToTimeline(media));
    list.appendChild(item);
  });
}

export function addMediaToTimeline(media, atTime = null) {
  const project = store.project;
  if (media.has_video) {
    const vtrack = project.tracks.find(t => t.kind === 'video');
    const start = atTime != null ? atTime : trackEnd(vtrack);
    const clip = {
      id: uid('clip'), media_id: media.id, in: 0, out: media.duration,
      start, duration: media.duration, effects: [], speed: 1, transition_in: null,
    };
    vtrack.clips.push(clip);
    if (media.has_audio) {
      const atrack = project.tracks.find(t => t.kind === 'audio');
      atrack.clips.push({
        id: uid('aclip'), media_id: media.id, in: 0, out: media.duration,
        start, duration: media.duration, gain_db: 0, fade_in: 0, fade_out: 0,
      });
    }
  } else if (media.has_audio) {
    const audioTracks = project.tracks.filter(t => t.kind === 'audio');
    const atrack = audioTracks[1] || audioTracks[0];
    const start = atTime != null ? atTime : trackEnd(atrack);
    atrack.clips.push({
      id: uid('aclip'), media_id: media.id, in: 0, out: media.duration,
      start, duration: media.duration, gain_db: 0, fade_in: 0, fade_out: 0,
    });
  } else {
    toast('This file has no video or audio track', 'error');
    return;
  }
  markDirty();
  emit('timeline:changed');
}

function trackEnd(track) {
  let end = 0;
  track.clips.forEach(c => { end = Math.max(end, c.start + c.duration); });
  return end;
}
