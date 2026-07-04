// Thin fetch wrappers around the Flask backend.

async function req(url, options = {}) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const msg = (body && body.error) ? body.error : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

export const api = {
  systemCheck: () => req('/api/system/check'),

  listProjects: () => req('/api/projects'),
  createProject: (data) => req('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  }),
  getProject: (id) => req(`/api/projects/${id}`),
  saveProject: (project) => req(`/api/projects/${project.id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project),
  }),
  deleteProject: (id) => req(`/api/projects/${id}`, { method: 'DELETE' }),

  probeUrl: (url) => req('/api/import/probe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  }),
  importUrl: (projectId, url, quality) => req(`/api/projects/${projectId}/import/url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, quality }),
  }),
  uploadFile: (projectId, file, onProgress) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects/${projectId}/import/upload`);
    xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || 'Upload failed'));
      } catch (e) { reject(e); }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  }),
  deleteMedia: (projectId, mediaId) => req(`/api/projects/${projectId}/media/${mediaId}`, { method: 'DELETE' }),

  uploadOverlayImage: (projectId, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return req(`/api/projects/${projectId}/import/image`, { method: 'POST', body: fd });
  },

  startExport: (projectId, opts) => req(`/api/projects/${projectId}/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts),
  }),

  jobStatus: (jobId) => req(`/api/jobs/${jobId}`),
};

export async function pollJob(jobId, onProgress, intervalMs = 900) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const job = await api.jobStatus(jobId);
        if (onProgress) onProgress(job);
        if (job.status === 'done') resolve(job);
        else if (job.status === 'error') reject(new Error(job.error || 'Job failed'));
        else setTimeout(tick, intervalMs);
      } catch (e) { reject(e); }
    };
    tick();
  });
}
