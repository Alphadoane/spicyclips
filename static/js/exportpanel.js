import { store } from './store.js';
import { api, pollJob } from './api.js';
import { openModal, wireModalDismiss, toast } from './ui.js';

const selected = { format: 'mp4', resolution: 'source', subs: 'burn' };

export function initExportPanel() {
  wireModalDismiss('modal-export');
  document.getElementById('btn-export').addEventListener('click', () => {
    if (!store.project) return;
    resetExportModal();
    openModal('modal-export');
  });

  wireGrid('export-format-grid', 'data-format', (v) => { selected.format = v; updateSubsFieldVisibility(); });
  wireGrid('export-res-grid', 'data-res', (v) => { selected.resolution = v; });
  wireGrid('export-subs-grid', 'data-subs', (v) => { selected.subs = v; });

  document.getElementById('btn-start-export').addEventListener('click', startExport);
}

function wireGrid(gridId, attr, onSelect) {
  const grid = document.getElementById(gridId);
  grid.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      grid.querySelectorAll('button').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      onSelect(btn.getAttribute(attr));
    });
  });
}

function updateSubsFieldVisibility() {
  const softBtn = document.querySelector('#export-subs-grid button[data-subs="soft"]');
  const disable = !(selected.format === 'mp4' || selected.format === 'mov');
  softBtn.disabled = disable;
  if (disable && selected.subs === 'soft') {
    selected.subs = 'burn';
    document.querySelectorAll('#export-subs-grid button').forEach((b) => b.classList.remove('selected'));
    document.querySelector('#export-subs-grid button[data-subs="burn"]').classList.add('selected');
  }
}

function resetExportModal() {
  document.getElementById('export-progress').classList.add('hidden');
  document.getElementById('export-done').classList.add('hidden');
  document.getElementById('export-error').classList.add('hidden');
  const btn = document.getElementById('btn-start-export');
  btn.disabled = false;
  btn.textContent = 'Start export';
}

async function startExport() {
  const btn = document.getElementById('btn-start-export');
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  document.getElementById('export-progress').classList.remove('hidden');
  document.getElementById('export-done').classList.add('hidden');
  document.getElementById('export-error').classList.add('hidden');
  const msgEl = document.getElementById('export-progress-msg');
  msgEl.textContent = 'Starting…';

  try {
    const { job_id } = await api.startExport(store.project.id, {
      format: selected.format, resolution: selected.resolution, subtitle_mode: selected.subs,
    });
    const job = await pollJob(job_id, (j) => { msgEl.textContent = j.progress || 'Working…'; });
    document.getElementById('export-progress').classList.add('hidden');
    const link = document.getElementById('export-download-link');
    link.href = `/renders/${job.result.filename}`;
    document.getElementById('export-done').classList.remove('hidden');
    toast('Export finished');
  } catch (e) {
    const box = document.getElementById('export-error');
    box.textContent = e.message;
    box.classList.remove('hidden');
    document.getElementById('export-progress').classList.add('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Start export';
  }
}
