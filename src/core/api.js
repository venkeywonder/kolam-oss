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
