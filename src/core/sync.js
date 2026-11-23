/*
 * Persistence: keeps the in-memory state (S) of the space being shown in step with the server.
 * - save() marks the state dirty; flush() diffs it against what the server last confirmed and pushes only changed records,
 *   naming the fields that changed, so the server keeps whatever other people changed in the rest (merge.js).
 * - pulls bring other people's and devices' changes; your unsent changes are merged in field by field, and rich text
 *   character by character (ytext.js). Pulls also happen while you type: the cursor stays where it was (caret.js).
 * - IndexedDB keeps a copy per space so boards open instantly and edits survive going offline.
 * - the server checks every change against your role; if it refuses one, local changes are dropped and the board reloads.
 */
import { $ } from './util.js';
import { api, assetUrl, upload } from './api.js';
import { ACC, LINK, ROOT, S, SPACE, VIEW, can, cur, docOpen, dragging, isPersonal, markRemote, setACC, setCur, setROOT, setS } from './store.js';
import { seed } from './seed.js';
import { render } from '../canvas/render.js';
import { modal } from '../ui/modal.js';
import { drawMode } from '../cards/drawing.js';
import { toast } from '../ui/toast.js';
import { renderPanel } from '../ui/drawer.js';
import { refreshDoc } from '../cards/doc.js';
import { isLive } from './realtime.js';
import { eq, mergeRecord, patchOf } from './merge.js';
import { keepCaret } from './caret.js';
import * as ytext from './ytext.js';
import { initComments, refreshComments, takeComments } from '../features/comments.js';
import { refreshHistory } from '../features/history.js';

/* ---------- local cache (IndexedDB) ---------- */
export const DB = {
  db: null,
  async open() {
    if (this.db) return;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('kolam', 2);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('kv')) r.result.createObjectStore('kv'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  get(k) { return new Promise((res, rej) => { const q = this.db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  set(k, v) { return new Promise((res, rej) => { const tx = this.db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
};

export let user = null;            // signed-in account (id, email, name, space = their own space id)
export const setUser = u => (user = u);
export let serverOK = true;        // false while offline
export const setServerOK = v => (serverOK = v);
export let saveT = null;
export let lastStamp = 0;          // kept for older callers
export const setLastStamp = v => (lastStamp = v);

let rev = 0;                       // last server revision of this space we have applied
let acl = -1;                      // access revision we know about (who can see what)
let synced = { board: new Map(), item: new Map(), line: new Map(), trash: new Map() };
let pushing = null;
// your own space keeps the cache key it had before spaces existed
const cacheKey = () => 'cache:' + user.id + (SPACE === user.space ? '' : ':' + SPACE);
const q = () => 'space=' + encodeURIComponent(SPACE);

const records = {
  board: () => Object.entries(S.boards),
  item: () => Object.entries(S.items),
  line: () => Object.entries(S.lines),
  trash: () => S.trash.map(t => [t.id, t]),
};
const get = (k, id) => k === 'board' ? S.boards[id] : k === 'item' ? S.items[id] : k === 'line' ? S.lines[id] : S.trash.find(t => t.id === id);
function put(k, id, d) {
  markRemote(k + ':' + id, get(k, id), d);
  if (k === 'board') d ? (S.boards[id] = d) : delete S.boards[id];
  else if (k === 'item') { if (d) S.items[id] = d; else { delete S.items[id]; ytext.drop(id); } }
  else if (k === 'line') d ? (S.lines[id] = d) : delete S.lines[id];
  else { S.trash = S.trash.filter(t => t.id !== id); if (d) S.trash.push(d); }
}
/** The server's last confirmed copy of a card. */
export const syncedItem = id => { const j = synced.item.get(id); return j ? JSON.parse(j) : null; };

function diff() {
  const ops = [];
  for (const k in records) {
    const seen = new Set(), base = synced[k];
    for (const [id, obj] of records[k]()) {
      seen.add(id);
      const j = JSON.stringify(obj), was = base.get(id);
      if (was === j) continue;
      if (was === undefined) { ops.push({ k, id, d: obj, j }); continue; }
      // an existing record: name the changed fields, so the server keeps other people's changes to the rest
      const p = patchOf(JSON.parse(was), obj);
      if (p.f.length) ops.push({ k, id, d: obj, j, ...p }); else base.set(id, j);
    }
    for (const id of base.keys()) if (!seen.has(id)) ops.push({ k, id, del: 1 });
  }
  return ops;
}

const setStatus = (t, cls) => { const el = $('#saveState'); if (!el) return; el.textContent = t; el.dataset.state = cls || ''; };

// pulls wait while something is mid-gesture or a form field has focus; typing in a card or a document doesn't stop them.
// Nor does typing in a side panel (comments)
const blocked = () => !!(dragging || drawMode || (!modal.hidden && !docOpen) ||
  (document.activeElement?.matches?.('input,textarea') && !document.activeElement.closest('#commentsPanel,.doc-modal')));

let saveDue = 0;
export function save(quiet) {
  if (VIEW || !can(cur, 'commenter')) return;
  S.updatedAt = Date.now();
  if (!quiet) setStatus('Saving…', 'saving');
  // a burst of changes goes out every few hundred ms rather than after it ends, so others see you type
  const due = Date.now() + (quiet ? 900 : !isPersonal() && isLive() ? 250 : 400);
  if (saveT && saveDue <= due) return;
  clearTimeout(saveT);
  saveDue = due;
  saveT = setTimeout(flush, due - Date.now());
}

export async function flush() {
  clearTimeout(saveT); saveT = null;
  if (VIEW || !user || !S) return;
  if (pushing) { await pushing; return flush(); }
  const y = ytext.outgoing();
  const ops = diff();
  writeCache();
  if (!ops.length && !Object.values(y).some(e => e.u)) return setStatus('Saved', 'saved');
  const space = SPACE;
  pushing = (async () => {
    try {
      const body = { ops: ops.map(({ j, ...o }) => o) };
      if (Object.keys(y).length) body.y = y;
      const r = await api('sync?' + q(), { method: 'POST', body });
      if (space !== SPACE) return;
      for (const o of ops) o.del ? synced[o.k].delete(o.id) : synced[o.k].set(o.id, o.j);
      // other people's text that came in meanwhile, and records the server completed or merged
      let changed = ytext.take(r.y).length > 0;
      if (r.fixed?.length && takeFixed(r.fixed, ops)) changed = true;
      if (r.rev === rev + 1 && !r.more) rev = r.rev;   // nobody else wrote in between (and no comments to fetch)
      else if (r.more) stale = true;
      serverOK = true;
      setStatus('Saved', 'saved');
      bc?.postMessage({ t: 'pushed', user: user.id, space });
      if (changed) refresh(); else writeCache();
    } catch (e) {
      if (space !== SPACE) return;
      ytext.unsent(y);
      if (e.status === 403 || e.status === 409 || e.status === 422) {   // refused: go back to what the server has
        toast(e.message);
        setStatus('Saved', 'saved');
        setTimeout(resync, 0);
        return;
      }
      if (e.status === 404) return lost();
      serverOK = e.status !== 0 ? serverOK : false;
      setStatus(e.status === 0 ? 'Offline — saved on this device' : 'Not saved', 'error');
      if (e.status !== 401) setTimeout(() => save(true), 5000);
    } finally { pushing = null; }
  })();
  return pushing;
}


let cacheT = null;
function writeCache() {
  clearTimeout(cacheT);
  const key = user && SPACE ? cacheKey() : null;
  cacheT = setTimeout(() => {
    if (!key || !S || key !== cacheKey()) return;
    const sy = {}; for (const k in synced) sy[k] = [...synced[k]];
    DB.set(key, { S, synced: sy, rev, acl, ACC }).catch(() => {});
  }, 300);
}

/**
 * Apply records pulled from the server. Your unsent changes are merged in field by field (and text by Yjs), unless
 * $force (after the server refused a change, its copy wins). Returns whether anything visible changed.
 */
function apply(res, force = false, full = res.full) {
  let changed = false;
  if (res.access) { setACC(res.access); acl = res.acl; changed = true; }
  else if (res.acl !== undefined) acl = res.acl;
  if (ytext.take(res.y).length) changed = true;
  if (takeComments(res, full)) changed = true;
  const dirty = (k, id, obj) => synced[k].get(id) !== (obj === undefined ? undefined : JSON.stringify(obj));
  const incoming = new Set();
  for (const c of res.changes) {
    if (!synced[c.k]) continue;
    incoming.add(c.k + ':' + c.id);
    const local = get(c.k, c.id), was = synced[c.k].get(c.id);
    if (c.del) {
      synced[c.k].delete(c.id);
      if (local === undefined || (!force && was === undefined)) continue;   // gone already, or made here and not sent yet
      put(c.k, c.id, null); changed = true;                                  // a deletion wins over unsent edits
      continue;
    }
    synced[c.k].set(c.id, JSON.stringify(c.d));
    if (local === undefined && !force && was !== undefined) continue;     // you deleted it, not sent yet: that wins
    let next = c.d;
    if (local !== undefined && !force && JSON.stringify(local) !== was) next = mergeRecord(was === undefined ? null : JSON.parse(was), local, c.d);
    if (c.k === 'item' && !force) next = ytext.keep(c.id, local, next);
    if (local !== undefined && eq(local, next)) continue;
    put(c.k, c.id, next); changed = true;
  }
  if (full) {   // anything we have that the server no longer sends was deleted, or we lost access to it
    for (const [k, list] of Object.entries(records)) for (const [id, obj] of list()) {
      if (incoming.has(k + ':' + id)) continue;
      if (!force && (!synced[k].has(id) || dirty(k, id, obj))) continue;
      put(k, id, null); synced[k].delete(id); changed = true;
    }
    for (const k in synced) for (const id of [...synced[k].keys()]) if (!incoming.has(k + ':' + id) && get(k, id) === undefined) synced[k].delete(id);
  }
  S.trash.sort((a, b) => (b.at || 0) - (a.at || 0));
  if (res.rev !== undefined) rev = res.rev;
  return changed;
}

/** Records the server completed or merged after a push; merged with anything you changed again meanwhile. */
function takeFixed(fixed, ops) {
  let changed = false;
  for (const f of fixed) {
    if (!synced[f.k]) continue;
    const op = ops.find(o => o.k === f.k && o.id === f.id), local = get(f.k, f.id);
    if (f.d === null) {   // deleted by someone else meanwhile: the deletion wins
      synced[f.k].delete(f.id);
      if (local !== undefined) { put(f.k, f.id, null); changed = true; }
      continue;
    }
    synced[f.k].set(f.id, JSON.stringify(f.d));
    if (local === undefined) continue;
    let next = !op || JSON.stringify(local) === op.j ? structuredClone(f.d) : mergeRecord(JSON.parse(op.j), local, f.d);
    if (f.k === 'item') next = ytext.keep(f.id, local, next);
    if (!eq(local, next)) { put(f.k, f.id, next); changed = true; }
  }
  return changed;
}

/** Redraw after other people's changes, keeping your cursor where it was. */
export function refresh() {
  if (!S) return;
  if (!S.boards[cur]) setCur(ROOT);
  keepCaret(() => { render(); renderPanel(); });
  refreshComments();
  refreshHistory();
  refreshDoc();
  writeCache();
}

/** Where a space opens: your own Home, a workspace's top board, or the first board shared with you. */
export function defaultRoot() {
  if (S.boards.home && (isPersonal() || ACC?.boards?.home)) return 'home';
  return ACC?.roots?.find(b => S.boards[b]) || Object.keys(S.boards)[0] || 'home';
}

/** Show the space SPACE: cached boards straight away, then catch up with the server. */
export async function load() {
  try { await DB.open(); } catch (e) { console.warn('No IndexedDB cache', e); }
  let cache = null;
  try { cache = DB.db && await DB.get(cacheKey()); } catch {}
  synced = { board: new Map(), item: new Map(), line: new Map(), trash: new Map() };
  ytext.reset();
  if (cache?.S?.boards) {
    setS(cache.S); rev = cache.rev || 0; acl = cache.acl ?? -1; setACC(cache.ACC || null);
    for (const k in synced) synced[k] = new Map(cache.synced?.[k] || []);
  } else {
    setS({ boards: {}, items: {}, lines: {}, views: {}, trash: [] });
    rev = 0; acl = -1; setACC(null);
  }
  S.views ||= {}; S.items ||= {}; S.lines ||= {}; S.trash ||= []; initComments(S);
  try {
    apply(await api(`sync?${q()}&since=${cache ? rev : 0}&acl=${acl}`));
    serverOK = true;
  } catch (e) {
    if (e.status === 401 || e.status === 404) throw e;
    serverOK = false;
    if (!cache) throw e;
  }
  if (isPersonal() && !S.boards.home) {   // brand-new account
    const s = seed();
    Object.assign(S.boards, s.boards); Object.assign(S.items, s.items); Object.assign(S.lines, s.lines);
    save(true);
  } else if (diff().length) save(true);
  setROOT(defaultRoot());
  writeCache();
}

/** Throw away local changes and take the server's copy (after it refused a change). */
export async function resync() {
  if (VIEW || !user || !S) return;
  try {
    const res = await api(`sync?${q()}&since=0&acl=-1`);
    ytext.reset();
    apply(res, true);
    setROOT(defaultRoot());
    refresh();
  } catch (e) { if (e.status === 404) lost(); }
}

/** The space can't be opened any more (access removed, or it was deleted). */
function lost() { dispatchEvent(new CustomEvent('nk:lost', { detail: { space: SPACE } })); }

let stale = false, lastPull = 0;
/** The realtime server (or a presence poll) says the space is at revision r: pull if we're behind. */
export function poke(r, a) {
  if (r !== rev || (a !== undefined && a !== acl)) { stale = true; pull(); }
}

export async function pull() {
  if (!user || VIEW || !S || blocked() || pushing) return;
  const space = SPACE;
  try {
    lastPull = Date.now();
    const ys = ytext.spec();
    const res = await api(`sync?${q()}&since=${rev}&acl=${acl}` + (ys ? '&y=' + encodeURIComponent(ys) : ''));
    if (space !== SPACE || blocked() || pushing) return;
    stale = false;
    if (apply(res)) {
      if (res.access) setROOT(defaultRoot());
      refresh();
    }
    if (!serverOK) { serverOK = true; setStatus('Saved', 'saved'); }
  } catch (e) { if (e.status === 404 && space === SPACE) lost(); }
}

/* ---------- uploads ---------- */
export async function putAsset(file, name) {
  setStatus('Uploading…', 'saving');
  try { const a = await upload(file, name, null, SPACE); return a.id; }
  finally { setStatus('Saved', 'saved'); }
}
export async function getAsset(id) { return id ? assetUrl(id) : null; }

/* ---------- boards shown through a view or comment link ---------- */
let sharedRev = -1;
const sharedPath = token => 'shared/' + encodeURIComponent(token) + (LINK.key ? '?k=' + LINK.key : '');
export async function loadShared(token) {
  const d = await api(sharedPath(token));
  sharedRev = d.rev;
  return d;
}
/** The state for what a link shows, with its comments. */
export function sharedState(d, views = {}) {
  setS({ boards: d.boards, items: d.items || {}, lines: d.lines || {}, views, trash: [] });
  initComments(S);
  takeComments(d, true);
}
async function pollShared() {
  if (blocked()) return;
  try {
    const d = await api(sharedPath(VIEW));
    if (d.rev === sharedRev) return;
    sharedRev = d.rev;
    sharedState(d, S.views);
    if (!S.boards[cur]) setCur(ROOT);
    keepCaret(() => render());
    refreshComments();
  } catch (e) {
    // the link was turned off, expired, or got a (new) password: show why
    if ([404, 410, 423].includes(e.status)) location.reload();
  }
}

export const bc = 'BroadcastChannel' in window ? new BroadcastChannel('kolam') : null;

export function init() {
  bc?.addEventListener('message', e => { if (e.data?.t === 'pushed' && e.data.user === user?.id && e.data.space === SPACE) pull(); });
  // with the realtime server we pull when told to (plus a slow safety check); without it, every second
  let n = 0;
  setInterval(() => {
    if (document.hidden) return;
    if (VIEW) { if (++n % 5 === 0) pollShared(); return; }
    if (stale || !isLive() || Date.now() - lastPull > 15000) pull();
  }, 1000);
  addEventListener('focus', () => (VIEW ? pollShared() : pull()));
  addEventListener('online', () => save(true));
  addEventListener('pagehide', () => { if (saveT) flush(); });
}
