import { assetUrl } from '../core/api.js';
import { S } from '../core/store.js';
import { V } from './viewport.js';
import { sizeOf } from './cull.js';

/*
 * Pictures on the board load at the smallest stored size that looks sharp at the current zoom: the server keeps each
 * upload at ≤128, ≤512 and ≤1280 px on its longest side besides the original (Variants.php). Zoomed out over hundreds
 * of photos the browser decodes thumbnails, not full photos, and a card taken off screen (cull.js) lets its picture go.
 * A few load at a time, the ones nearest the middle of the screen first; a sharper size replaces a softer one only once
 * it has arrived, so nothing blinks.
 */
const TIERS = [['t', 128], ['s', 512], ['m', 1280]];
const ORIGINAL = 2400;     // uploads are scaled to fit this (workers/image.js); older ones may be bigger
const MAX_LOADS = 12;      // HTTP/2 serves these side by side; with HTTP/1.1 the browser queues past its 6 connections
const imgs = new Map();    // <img> -> { id, tier: what it shows ('' = original, null = nothing yet), busy, broken, dead }
let loading = 0, scale = null, waiters = [];

/** Load this card's picture through the queue, at the size its zoom needs. */
export function watchImage(img, it) {
  img.decoding = 'async';
  imgs.set(img, { id: it.id, tier: null, busy: false, broken: false, dead: false });
  queueMicrotask(refreshImages);
}

/** Pixels per board px to load pictures for; null = the screen's (zoom × device pixel ratio). For the PNG export. */
export function setImageScale(s) { scale = s; refreshImages(); }

/** Resolves once every drawn picture shows the size it needs. */
export function imagesSettled() {
  return new Promise(res => { waiters.push(res); refreshImages(); });
}

const sizeOfTier = t => t === '' ? ORIGINAL : TIERS.find(x => x[0] === t)[1];

/** The tier this picture should load next, or undefined to leave it as it is. */
function next(r) {
  const it = S?.items[r.id];
  if (!it || r.dead) return undefined;
  const [w] = sizeOf(it);
  const need = w * Math.max(1, it.data.ratio || 1) * (scale ?? V().z * devicePixelRatio);
  const want = r.broken ? '' : (TIERS.find(([, px]) => px >= need)?.[0] ?? '');
  if (want === r.tier) return undefined;
  // a softer size only when it's far softer than what's shown: zooming back and forth shouldn't reload
  if (r.tier !== null && sizeOfTier(want) < sizeOfTier(r.tier) && sizeOfTier(r.tier) < 4 * need) return undefined;
  return want;
}

function distance(id) {
  let it = S.items[id];
  while (it?.col && S.items[it.col]) it = S.items[it.col];
  if (!it) return Infinity;
  const v = V(), [w, h] = sizeOf(it), cx = (innerWidth / 2 - v.x) / v.z, cy = (innerHeight / 2 - v.y) / v.z;
  return Math.hypot(it.x + w / 2 - cx, it.y + h / 2 - cy);
}

/** Start loads for pictures that need another size, up to the limit; call whenever the view or the drawn cards change. */
export function refreshImages() {
  const todo = [];
  for (const [img, r] of imgs) {
    if (!img.isConnected) { if (r.busy) loading--; imgs.delete(img); continue; }
    if (r.busy) continue;
    const t = next(r);
    if (t !== undefined) todo.push([distance(r.id), img, r, t]);
  }
  if (!todo.length && !loading) { const w = waiters; waiters = []; w.forEach(f => f()); return; }
  todo.sort((a, b) => a[0] - b[0]);
  for (const [, img, r, t] of todo) {
    if (loading >= MAX_LOADS) break;
    start(img, r, t);
  }
}

function start(img, r, t) {
  const it = S.items[r.id];
  r.busy = true; loading++;
  const ac = new AbortController();
  const done = ok => {
    ac.abort();
    if (imgs.get(img) !== r || !r.busy) return;   // taken off the board meanwhile (already counted off)
    r.busy = false; loading--;
    if (ok) r.tier = t;
    else if (t !== '') r.broken = true;            // no such size: the original it is
    else { r.dead = true; img.closest('.card')?.classList.add('missing'); }
    refreshImages();
  };
  img.addEventListener('load', () => done(true), { signal: ac.signal });
  img.addEventListener('error', () => done(false), { signal: ac.signal });
  img.src = assetUrl(it.data.asset) + (t ? '?v=' + t : '');
}
