import { store, emit, on, markDirty } from './store.js';
import { api } from './api.js';
import { toast } from './ui.js';
import { initMediaPool } from './mediapool.js';
import { initTimeline } from './timeline.js';
import { initPreview } from './preview.js';
import { initInspector } from './inspector.js';
import { initExportPanel } from './exportpanel.js';
import { initProjectBrowser, hideBrowser } from './projectbrowser.js';

let saveTimer = null;

async function openProject(id) {
  try {
    const project = await api.getProject(id);
    store.project = project;
    store.selection = null;
    store.playhead = 0;
    store.playing = false;
    store.dirty = false;
    document.getElementById('project-name').value = project.name;
    try { localStorage.setItem('splice:lastProject', id); } catch (e) { /* ignore */ }
    hideBrowser();
    emit('project:loaded');
  } catch (e) {
    toast('Could not open that project: ' + e.message, 'error');
  }
}

function scheduleAutosave() {
  const ind = document.getElementById('save-indicator');
  ind.textContent = 'Unsaved changes…';
  ind.classList.add('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 900);
}

async function doSave() {
  if (!store.project) return;
  try {
    await api.saveProject(store.project);
    store.dirty = false;
    const ind = document.getElementById('save-indicator');
    ind.textContent = 'All changes saved';
    ind.classList.remove('saving');
  } catch (e) {
    document.getElementById('save-indicator').textContent = 'Save failed — retrying…';
    saveTimer = setTimeout(doSave, 3000);
  }
}

async function checkSystem() {
  try {
    const status = await api.systemCheck();
    const problems = [];
    if (!status.ffmpeg || !status.ffprobe) {
      problems.push('ffmpeg was not found on PATH — install it to enable import, thumbnails, and export.');
    }
    if (!status.yt_dlp) {
      problems.push('yt-dlp is not installed — run "pip install -r requirements.txt" to import from URLs (local file upload still works).');
    }
    if (problems.length) {
      const banner = document.getElementById('system-banner');
      banner.textContent = problems.join('   ·   ');
      banner.classList.remove('hidden');
    }
  } catch (e) { /* backend not reachable yet - ignore, other calls will surface the error */ }
}

function init() {
  checkSystem();

  document.getElementById('btn-projects').addEventListener('click', () => { if (store.dirty) doSave(); });
  document.getElementById('project-name').addEventListener('change', (e) => {
    if (!store.project) return;
    store.project.name = e.target.value.trim() || 'Untitled Project';
    markDirty();
  });

  on('project:dirty', scheduleAutosave);

  initMediaPool();
  initTimeline();
  initPreview();
  initInspector();
  initExportPanel();
  initProjectBrowser(openProject);

  window.addEventListener('beforeunload', (e) => {
    if (store.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

init();
