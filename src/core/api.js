/* HTTP client for the PHP API. All paths are relative to <base>/api/. */
export const API_BASE = new URL('api/', document.baseURI).href;

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body, form, signal, keepalive } = {}) {
  const headers = { 'X-Requested-With': 'kolam' };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let r;
  try {
    r = await fetch(API_BASE + path, { method, headers, body: payload, signal, keepalive, credentials: 'same-origin', cache: 'no-store' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'You appear to be offline');
  }
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json().catch(() => ({})) : {};
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith('auth/')) dispatchEvent(new CustomEvent('nk:signedout'));
    throw new ApiError(r.status, data.error || `Request failed (${r.status})`);
  }
  return data;
}

export const assetUrl = id => API_BASE + 'assets/' + encodeURIComponent(id);

/** Upload a File/Blob into a space; resolves to the stored asset record. */
export function upload(file, name, onProgress, space) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    if (space) fd.append('space', space);
    fd.append('file', file, name || file.name || 'file');
    const x = new XMLHttpRequest();
    x.open('POST', API_BASE + 'assets');
    x.setRequestHeader('X-Requested-With', 'kolam');
    x.responseType = 'json';
    if (onProgress) x.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? resolve(x.response) : reject(new ApiError(x.status, x.response?.error || 'Upload failed')));
    x.onerror = () => reject(new ApiError(0, 'Upload failed — check your connection'));
    x.send(fd);
  });
}
