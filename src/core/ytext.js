/*
 * Character-level merging of rich text (notes, documents, image captions) with Yjs.
 *
 * A card's text gets a Yjs document when you start editing it. The server keeps each card's log (server/src/YText.php):
 * Yjs updates, plain writes ("the AI set the text to …") and snapshots, numbered per card. We replay it in order:
 * - base: the merged state of the log so far, nothing else (so a plain write turns into the same change everywhere);
 * - doc:  base plus your own changes not in the log yet; what you see.
 * The card's own field (data.html) always holds the doc's text, so everything else keeps reading plain HTML.
 * Your typing reaches the doc when sync.js pushes or pulls (fold), as one replace of the stretch that changed.
 */
import * as Y from '../vendor/yjs.js';
import { api } from './api.js';
import { S, SPACE, VIEW, docOpen, editingId, markRemote } from './store.js';
import { refresh, save, syncedItem } from './sync.js';

const FIELDS = { note: ['html'], doc: ['html'], image: ['caption'] };
const REMOTE = 'remote';
const EMPTY = Y.encodeStateAsUpdate(new Y.Doc());
const MAX_DOCS = 20, COMPACT_AFTER = 100;
const docs = new Map();   // card id -> { doc, base, n, dirty, loaded, since, used }

export const fieldsFor = it => FIELDS[it?.type] || [];

const toB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const isHigh = c => c >= 0xd800 && c <= 0xdbff, isLow = c => c >= 0xdc00 && c <= 0xdfff;

/** Make a Y.Text read s, replacing only the stretch that differs (never splitting an emoji's surrogate pair). */
function setText(t, s) {
  const a = t.toString();
  if (a === s) return;
  const n = Math.min(a.length, s.length);
  let p = 0;
  while (p < n && a.charCodeAt(p) === s.charCodeAt(p)) p++;
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let q = 0;
  while (q < n - p && a.charCodeAt(a.length - 1 - q) === s.charCodeAt(s.length - 1 - q)) q++;
  if (q > 0 && isLow(a.charCodeAt(a.length - q))) q--;
  t.doc.transact(() => {
    if (a.length - p - q > 0) t.delete(p, a.length - p - q);
    if (s.length - p - q > 0) t.insert(p, s.slice(p, s.length - q));
  });
}

// the same client id in every browser for a given plain write, so they all make the identical Yjs change
function clientFor(id, n) {
  let h = 0x811c9dc5;
  for (const ch of `${id}:${n}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) || 1;
}

function replay(id, rec, entries) {
  for (const e of entries) {
    if (e.n <= rec.n) continue;
    let u;
    if (e.k === 'p') {
      const { f, v } = JSON.parse(e.d);
      const t = new Y.Doc();
      t.clientID = clientFor(id, e.n);
      Y.applyUpdate(t, rec.base);
      setText(t.getText(f), typeof v === 'string' ? v : '');
      u = Y.encodeStateAsUpdate(t, Y.encodeStateVectorFromUpdate(rec.base));
    } else u = fromB64(e.d);
    rec.base = Y.mergeUpdates([rec.base, u]);
    Y.applyUpdate(rec.doc, u, REMOTE);
    rec.n = e.n;
    rec.since = e.k === 's' ? 0 : rec.since + 1;
  }
}

/** Your edits to the card's field since the doc last matched it go into the doc. */
function fold(id, rec) {
  const it = S.items[id];
  if (!it || !rec.loaded) return;
  for (const f of fieldsFor(it)) {
    const v = it.data?.[f];
    if (typeof v === 'string' && rec.doc.getText(f).toString() !== v) setText(rec.doc.getText(f), v);
  }
}

/** The card's fields take the doc's text (after other people's changes came in). Returns whether any changed. */
function show(id, rec, only) {
  const it = S.items[id];
  if (!it) return false;
  let changed = false;
  for (const f of only || fieldsFor(it)) {
    if (!rec.doc.share.has(f)) continue;
    const t = rec.doc.getText(f).toString();
    if ((it.data?.[f] ?? '') === t) continue;
    const before = structuredClone(it);
    it.data ||= {};
    it.data[f] = t;
    markRemote('item:' + id, before, it);
    changed = true;
  }
  return changed;
}

/** Start merging a card's text: load its log. Safe to call repeatedly. */
export function open(id) {
  const it = S.items[id];
  if (VIEW || !fieldsFor(it).length) return Promise.resolve();
  const have = docs.get(id);
  if (have) { have.used = Date.now(); return have.ready; }
  const rec = { doc: new Y.Doc(), base: EMPTY, n: 0, dirty: false, loaded: false, since: 0, used: Date.now() };
  rec.doc.on('update', (_, origin) => { if (origin !== REMOTE) rec.dirty = true; });
  docs.set(id, rec);
  evict();
  const space = SPACE;
  rec.ready = api(`ytext?space=${encodeURIComponent(space)}&id=${encodeURIComponent(id)}&after=0`).then(r => {
    if (docs.get(id) !== rec || space !== SPACE) return;
    const cur = S.items[id];
    if (!cur) { docs.delete(id); return; }
    const typed = Object.fromEntries(fieldsFor(cur).map(f => [f, cur.data?.[f]]));
    const server = syncedItem(id);
    replay(id, rec, r.entries);
    rec.loaded = true;
    let changed = false;
    for (const f of fieldsFor(cur)) {
      const mine = typed[f], was = server ? server.data?.[f] : '';
      // typed here before the log arrived: keep it; otherwise the log has the latest text
      if (typeof mine === 'string' && mine !== (was ?? '')) setText(rec.doc.getText(f), mine);
      else changed = show(id, rec, [f]) || changed;
    }
    if (rec.since >= COMPACT_AFTER) compact(id, rec);
    if (changed) { refresh(); save(true); }
  }).catch(() => { if (docs.get(id) === rec) docs.delete(id); });
  return rec.ready;
}

function evict() {
  if (docs.size <= MAX_DOCS) return;
  const old = [...docs].filter(([id, r]) => r.loaded && !r.dirty && id !== editingId && id !== docOpen).sort((a, b) => a[1].used - b[1].used);
  for (const [id] of old.slice(0, docs.size - MAX_DOCS)) docs.delete(id);
}

function compact(id, rec) {
  if (rec.compacting) return;
  rec.compacting = true;
  const d = new Y.Doc(); Y.applyUpdate(d, rec.base);
  api('ytext/compact?space=' + encodeURIComponent(SPACE), { method: 'POST', body: { id, n: rec.n, s: toB64(Y.encodeStateAsUpdate(d)) } })
    .then(() => { rec.since = 0; }).catch(() => {}).finally(() => { rec.compacting = false; });
}

/** Before a push: everyone's text folded in; per open card, the last entry we have and our unsent update. */
export function outgoing() {
  const y = {};
  for (const [id, rec] of docs) {
    if (!rec.loaded) continue;
    fold(id, rec);
    const e = { n: rec.n };
    if (rec.dirty) { e.u = toB64(Y.encodeStateAsUpdate(rec.doc, Y.encodeStateVectorFromUpdate(rec.base))); rec.dirty = false; }
    y[id] = e;
  }
  return y;
}

/** A push failed: what it carried still has to be sent. */
export function unsent(y) { for (const [id, e] of Object.entries(y || {})) if (e.u && docs.has(id)) docs.get(id).dirty = true; }

/** For a pull: "id:n,…" of the open cards. */
export const spec = () => [...docs].filter(([, r]) => r.loaded).map(([id, r]) => id + ':' + r.n).join(',');

/** Log entries from the server (pull or push response). Returns the cards whose text changed. */
export function take(map) {
  const changed = [];
  let behind = false;
  for (const [id, entries] of Object.entries(map || {})) {
    const rec = docs.get(id);
    if (!rec?.loaded || !entries?.length) continue;
    fold(id, rec);
    replay(id, rec, entries);
    if (show(id, rec)) changed.push(id);
    if (rec.since >= COMPACT_AFTER) compact(id, rec);
    const it = S.items[id], server = syncedItem(id);
    if (it && server && fieldsFor(it).some(f => (it.data?.[f] ?? '') !== (server.data?.[f] ?? ''))) behind = true;
  }
  // the card itself holds whichever side's text was saved last: write the merged text to it
  if (behind) save(true);
  return changed;
}

/** A pulled copy of a card replaces yours: keep the merged text from its doc. */
export function keep(id, local, next) {
  const rec = docs.get(id);
  if (!rec?.loaded || !local || !next) return next;
  for (const f of fieldsFor(next)) if (typeof local.data?.[f] === 'string') { next.data ||= {}; next.data[f] = local.data[f]; }
  return next;
}

export const drop = id => docs.delete(id);
export const reset = () => docs.clear();
