import { $, esc } from '../core/util.js';
import { RO, S, SPACE, els, save } from '../core/store.js';
import { ApiError } from '../core/api.js';
import { abortUpload, uploadAsset } from '../core/upload.js';
import { rebuildCard, renderBoard } from '../canvas/render.js';
import { toast } from '../ui/toast.js';

/*
 * Files added to a board upload in the background, three at a time, while their cards already sit on the board
 * (actions/create.js handleFiles). A card waiting for its file has data.upload (a key into `jobs` on the device that
 * uploads it); everyone else sees it as uploading. Pictures are first scaled and given their smaller sizes in a
 * worker (workers/image.js); the card shows the small one at once. A failed upload offers Try again on the card.
 */
const AT_ONCE = 3;
const jobs = new Map();       // upload key -> { key, id, file, space, status, progress, error, preview, state, w0 }
const finished = [];          // uploads that ended while their space wasn't open: [job, asset]
let running = 0;

/** Start uploading `file` for this new card (its data.upload is the key). */
export function queueUpload(it, file) {
  jobs.set(it.data.upload, { key: it.data.upload, id: it.id, file, space: SPACE, status: 'waiting', progress: 0, error: '', preview: null, state: {}, w0: it.w });
  pump();
}

/** Upload a picture that belongs inside a card (a poll answer's): scaled, with its smaller sizes. Resolves to the asset. */
export async function uploadPicture(file) {
  const p = /gif|svg/.test(file.type) ? { blob: file, variants: {} } : await prepare(file);
  return uploadAsset(p.blob, file.name || 'image', { space: SPACE, variants: p.variants });
}

function pump() {
  for (const job of jobs.values()) {
    if (running >= AT_ONCE) return;
    if (job.status === 'waiting') run(job);
  }
}

async function run(job) {
  running++;
  job.status = 'uploading'; job.error = ''; paint(job);
  try {
    let blob = job.file, variants = {};
    if (job.file.type.startsWith('image/') && !/gif|svg/.test(job.file.type)) {
      const p = job.ready ||= await prepare(job.file);
      blob = p.blob; variants = p.variants;
      if (!job.preview) {
        job.preview = URL.createObjectURL(p.variants.s || p.variants.t || p.blob);
        const it = S.items[job.id];
        if (it && job.space === SPACE && it.data.upload === job.key) {
          it.data.ratio = p.h / p.w;
          if (it.w === job.w0) it.w = Math.min(p.w, 320);   // unless it was resized meanwhile
          save(); rebuildCard(job.id);
        }
      }
    }
    const a = await uploadAsset(blob, job.file.name || 'image', {
      space: job.space, variants, onProgress: f => { job.progress = f; paint(job); },
    }, job.state);
    finish(job, a);
  } catch (e) {
    console.error(e);
    if (e instanceof ApiError && e.status && e.status !== 429 && e.status < 500) {
      // too large, not allowed: this file can't go up, so its card goes
      toast(`Couldn’t add ${job.file.name}: ${e.message}`);
      drop(job, true);
    } else {
      job.status = 'failed'; job.error = e.message || 'Upload failed'; paint(job);
    }
  } finally { running--; pump(); }
}

/** The file is up: its card shows it (when the card is in the space that's open; else once it is again). */
function finish(job, a) {
  if (job.space !== SPACE) { finished.push([job, a]); job.status = 'done'; return; }
  jobs.delete(job.key);
  const it = S.items[job.id];
  if (it?.data.upload === job.key) {
    delete it.data.upload;
    it.data.asset = a.id;
    if (it.type === 'file' && !it.data.mime) it.data.mime = a.mime;
    save();
    if (els.has(job.id)) rebuildCard(job.id);
  }
  // the small copy stays until the board's own copy has loaded
  if (job.preview) setTimeout(() => URL.revokeObjectURL(job.preview), 60000);
  recent.set(a.id, job.preview);
}
addEventListener('nk:space', () => {
  for (const [job, a] of finished.splice(0)) if (job.space === SPACE) finish(job, a); else finished.push([job, a]);
});
addEventListener('beforeunload', e => {
  if ([...jobs.values()].some(j => j.status !== 'done')) { e.preventDefault(); e.returnValue = ''; }
});

/** Forget an upload and (remove) take its card off the board. */
function drop(job, remove) {
  abortUpload(job.state);
  jobs.delete(job.key);
  if (job.preview) URL.revokeObjectURL(job.preview);
  const it = S.items[job.id];
  if (remove && it?.data.upload === job.key && job.space === SPACE) { delete S.items[job.id]; save(); renderBoard(); }
}

const recent = new Map();     // asset id -> the small copy shown while it uploaded
/** A picture to show on this card before its stored one loads: the uploader's own small copy. */
export function previewOf(it) {
  return (it.data.upload ? jobs.get(it.data.upload)?.preview : recent.get(it.data.asset)) || null;
}

/** The uploading state on a card that waits for its file (progress, or Try again / Remove). */
export function mountUpload(el, it) {
  const box = document.createElement('div');
  box.className = 'up';
  box.dataset.nodrag = '';
  el.appendChild(box);
  const job = jobs.get(it.data.upload);
  paintBox(box, job);
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-up]'); if (!b) return;
    const j = jobs.get(S.items[it.id]?.data.upload);
    if (b.dataset.up === 'retry' && j) { j.status = 'waiting'; pump(); }
    if (b.dataset.up === 'remove') {
      if (j) drop(j, true);
      else if (S.items[it.id]) { delete S.items[it.id]; save(); renderBoard(); }
    }
  });
}

let frame = 0;
const dirty = new Set();
function paint(job) {
  dirty.add(job);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    for (const j of dirty) { const box = $('.up', els.get(j.id)); if (box && els.get(j.id)) paintBox(box, j); }
    dirty.clear();
  });
}
function paintBox(box, job) {
  const failed = job?.status === 'failed';
  box.classList.toggle('failed', failed);
  box.style.setProperty('--p', job ? job.progress : 0);
  // someone else's upload (or one this device lost on a reload): nothing to do but wait, or take the card away
  box.innerHTML = `<div class="up-bar"><i></i></div><span class="up-txt">${failed ? esc(job.error) : job ? `Uploading… ${Math.round(job.progress * 100)}%` : 'Uploading…'}</span>` +
    (RO ? '' : (failed ? '<button data-up="retry">Try again</button>' : '') + (failed || !job ? '<button data-up="remove">Remove</button>' : ''));
}

/* ---------- pictures: scaled and given their smaller sizes off the main thread ---------- */
const WORKERS = 2;
const pool = [], waiting = [];
let made = 0;

/** { blob, w, h, variants } for a picture; one that can't be read in a worker goes up as it is. */
function prepare(file) {
  return new Promise(res => { waiting.push([file, res]); feed(); });
}
function feed() {
  while (waiting.length) {
    let w = pool.find(w => !w.busy);
    if (!w && made < WORKERS && typeof OffscreenCanvas !== 'undefined') {
      try { w = new Worker(new URL('../workers/image.js', import.meta.url), { type: 'module' }); made++; pool.push(w); } catch { made = WORKERS; }
    }
    if (!w) {
      if (made) return;    // all busy: the next to finish takes it
      const [file, res] = waiting.shift();
      size(file).then(d => res({ blob: file, variants: {}, ...d }));
      continue;
    }
    const [file, res] = waiting.shift();
    w.busy = true;
    w.onmessage = async ({ data }) => {
      w.busy = false;
      res(data.error ? { blob: file, variants: {}, ...await size(file) } : data);
      feed();
    };
    w.postMessage({ file });
  }
}
/** Width and height of a picture the worker couldn't read (the browser may still show it). */
function size(file) {
  const url = URL.createObjectURL(file);
  return new Promise(res => {
    const i = new Image();
    i.onload = () => { res({ w: i.naturalWidth, h: i.naturalHeight }); URL.revokeObjectURL(url); };
    i.onerror = () => { res({ w: 300, h: 225 }); URL.revokeObjectURL(url); };
    i.src = url;
  });
}
