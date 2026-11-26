import { API_BASE, ApiError, api } from './api.js';

/*
 * Uploads in pieces (server/src/Uploads.php): the server hands out an upload, the file goes up in 8 MB parts —
 * straight to the storage bucket when it allows that, else to the app — then the server checks it and files it.
 * A part that fails is tried again after a pause (and once the browser is back online); the parts already up stay
 * up, so a dropped connection carries on where it stopped rather than starting over.
 */
const TRIES = 6;
const FINAL = new Set([400, 401, 402, 403, 404, 409, 413, 415]);   // trying again won't help

const sleep = ms => new Promise(r => setTimeout(r, ms));
const online = () => navigator.onLine ? Promise.resolve() : new Promise(r => addEventListener('online', r, { once: true }));

async function retry(fn, signal) {
  for (let n = 0; ; n++) {
    try { return await fn(n); } catch (e) {
      if (e.name === 'AbortError' || FINAL.has(e.status) || n + 1 >= TRIES) throw e;
      await sleep(Math.min(30000, 1000 * 2 ** n));
      await online();
      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    }
  }
}

/** PUT one piece, to the app (app: true) or a presigned bucket URL. */
function put(url, body, app, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    if (app) x.setRequestHeader('X-Requested-With', 'kolam');
    x.upload.onprogress = e => onProgress(e.loaded);
    x.onload = () => {
      if (x.status < 300) return resolve();
      let msg = `Upload failed (${x.status})`;
      try { msg = JSON.parse(x.responseText).error || msg; } catch {}
      reject(new ApiError(x.status, msg));
    };
    x.onerror = () => reject(new ApiError(0, 'Upload failed — check your connection'));
    x.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => x.abort(), { once: true });
    x.send(body);
  });
}

/**
 * Upload a File/Blob (plus smaller copies of a picture: variants { t, s, m }) into a space; resolves to the asset
 * record { id, mime, size, name }. `state` keeps the upload between calls, so calling again after a failure resumes it.
 */
export async function uploadAsset(blob, name, { space, variants = {}, onProgress, signal } = {}, state = {}) {
  const sizes = Object.fromEntries(Object.entries(variants).map(([k, b]) => [k, b.size]));
  const total = blob.size + Object.values(sizes).reduce((a, b) => a + b, 0) || 1;
  let up = state.up, done = 0;
  if (!up) up = state.up = await retry(() => api('assets/uploads', { method: 'POST', body: { name, size: blob.size, type: blob.type, space, variants: sizes }, signal }), signal);
  // what already arrived (a resumed upload), with fresh bucket addresses
  let have = { parts: [], variants: [] };
  if (state.resumed) { have = await retry(() => api('assets/uploads/' + up.id, { signal }), signal); Object.assign(up, have.urls ? { urls: have.urls } : {}, have.variantUrls ? { variantUrls: have.variantUrls } : {}); }
  state.resumed = true;
  const report = extra => onProgress?.(Math.min(1, (done + extra) / total));
  const s3 = up.target === 's3';

  for (let n = 1; n <= up.parts; n++) {
    const part = blob.slice((n - 1) * up.partSize, Math.min(n * up.partSize, blob.size));
    if (!have.parts.some(p => p.n === n)) {
      await retry(async again => {
        if (again && s3) { const st = await api('assets/uploads/' + up.id, { signal }); if (st.urls) up.urls = st.urls; }
        await put(s3 ? up.urls[n - 1] : `${API_BASE}assets/uploads/${up.id}/parts/${n}`, part, !s3, report, signal);
      }, signal);
    }
    done += part.size; report(0);
  }
  for (const [v, b] of Object.entries(variants)) {
    if (!have.variants.includes(v)) {
      await retry(async again => {
        if (again && s3) { const st = await api('assets/uploads/' + up.id, { signal }); if (st.variantUrls) up.variantUrls = st.variantUrls; }
        await put(s3 ? up.variantUrls[v] : `${API_BASE}assets/uploads/${up.id}/variants/${v}`, b, !s3, report, signal);
      }, signal);
    }
    done += b.size; report(0);
  }
  const asset = await retry(() => api(`assets/uploads/${up.id}/complete`, { method: 'POST', signal }), signal);
  delete state.up;
  return asset;
}

/** Give up on an upload started with uploadAsset (its parts are deleted). */
export function abortUpload(state) {
  if (state.up) api('assets/uploads/' + state.up.id, { method: 'DELETE' }).catch(() => {});
  delete state.up;
}
