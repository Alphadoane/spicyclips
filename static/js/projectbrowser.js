import { api } from './api.js';
import { el, toast, openModal, closeModal, wireModalDismiss } from './ui.js';

let _onOpen = null;

export function initProjectBrowser(onOpen) {
  _onOpen = onOpen;
  wireModalDismiss('modal-new-project');
  document.getElementById('btn-projects').addEventListener('click', showBrowser);
  wireResGrid();

  document.getElementById('btn-create-project').addEventListener('click', async () => {
    const name = document.getElementById('new-project-name').value.trim() || 'Untitled Project';
    const selBtn = document.querySelector('#new-project-res-grid button.selected');
    const w = parseInt(selBtn.getAttribute('data-w'), 10);
    const h = parseInt(selBtn.getAttribute('data-h'), 10);
    try {
      const project = await api.createProject({ name, width: w, height: h, fps: 30 });
      closeModal('modal-new-project');
      _onOpen(project.id);
    } catch (e) { toast(e.message, 'error'); }
  });

  showBrowser();
}

function wireResGrid() {
  const grid = document.getElementById('new-project-res-grid');
  grid.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      grid.querySelectorAll('button').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
}

export function showBrowser() {
  document.getElementById('project-browser').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  renderBrowserGrid();
}

export function hideBrowser() {
  document.getElementById('project-browser').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

async function renderBrowserGrid() {
  const grid = document.getElementById('browser-grid');
  grid.innerHTML = '';
  grid.appendChild(el('div', { class: 'project-card new', onclick: () => openModal('modal-new-project') }, [
    el('div', { style: 'font-size:28px;line-height:1;margin-bottom:8px;', text: '+' }),
    el('div', { text: 'New project' }),
  ]));

  try {
    const projects = await api.listProjects();
    projects.forEach((p) => {
      const delBtn = el('button', {
        class: 'icon ghost small', title: 'Delete project',
        style: 'float:right;',
        onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete "${p.name}"? This removes its saved media and cannot be undone.`)) return;
          try { await api.deleteProject(p.id); renderBrowserGrid(); }
          catch (err) { toast(err.message, 'error'); }
        },
      }, '×');
      const card = el('div', { class: 'project-card' }, [
        delBtn,
        el('h4', { text: p.name }),
        el('div', { class: 'pmeta', text: `${p.clip_count} clip${p.clip_count === 1 ? '' : 's'} · ${new Date(p.modified * 1000).toLocaleDateString()}` }),
      ]);
      card.addEventListener('click', () => _onOpen(p.id));
      grid.appendChild(card);
    });
  } catch (e) {
    toast('Could not load projects: ' + e.message, 'error');
  }
}
