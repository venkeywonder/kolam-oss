import { $ } from './util.js';
import { render } from '../canvas/render.js';
import { exitEdit } from '../canvas/editing.js';
import { save, user } from './sync.js';
import { fieldsOf } from './merge.js';

// persistence lives in sync.js; re-exported so feature modules have one place to import from
export { DB, save, flush, load, putAsset, getAsset, serverOK, saveT, user } from './sync.js';

/* ================= app state ================= */
export let S = null;               // state of the space being shown
export const VIEW = new URLSearchParams(location.search).get('view'); // token of a view or comment link being shown
// that link: "view" or "comment", the role it gives ("viewer" / "commenter"), and the key its password unlocked
export const LINK = { kind: null, role: 'viewer', key: '' };
export let ROOT = 'home';
export let cur = 'home';           // current board id
export const sel = new Set();      // selected item ids
export let selLine = null;         // selected line id
export let editingId = null, editSnap = null, freshId = null;
export let dragging = false, spaceDown = false;
export let lastPointer = null;     // last pointer in world coords
export let clip = null, clipText = '';
export const els = new Map();      // item id -> element

/* ================= spaces & access ================= */
// SPACE: whose boards are shown — your own (id = your user id) or a workspace / someone else's space you have boards in.
// ACC: what the server says you can do there (role per board, where your access starts, who sees which board).
export let SPACE = null;
export let ACC = null;
export let RO = !!VIEW;            // the current board is read-only for you
export const setSPACE = v => (SPACE = v);
export const setACC = v => (ACC = v);
export let docOpen = null;         // id of the document card open in the editor (presence: "X is editing")
export const setDocOpen = v => (docOpen = v);
/** Viewing your home workspace (the one you own that has your Unsorted inbox). */
export const isHome = () => !VIEW && !!user && SPACE === user.space;
const RANK = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
export function roleOf(b = cur) {
  if (VIEW) return 'viewer';
  if (b === '__unsorted') return isHome() ? 'owner' : null;
  let r = ACC?.boards?.[b], n = 0;
  // a board created moments ago isn't in the server's list yet: it has its parent's role
  while (r === undefined && S?.boards[b] && n++ < 100) { b = S.boards[b].parent; r = ACC?.boards?.[b]; }
  return r ?? (isHome() ? 'owner' : null);
}
export const can = (b = cur, need = 'editor') => (RANK[roleOf(b)] || 0) >= RANK[need];
export function updateRO() {
  RO = !can(cur, 'editor');
  document.body.classList.toggle('viewonly', RO);
  document.body.classList.toggle('can-comment', RO && !VIEW && can(cur, 'commenter'));
  document.body.classList.toggle('shared-space', !VIEW && !isHome());
  if (!VIEW) { const p = $('#viewPill'); p.hidden = !RO; p.textContent = can(cur, 'commenter') ? 'Can comment' : 'View only'; }
}
/** URL hash for a board in the space being shown. */
export const boardHash = (id, space = SPACE) => (VIEW || !space || space === user?.space ? '#/b/' : `#/s/${space}/b/`) + id;
export function parseHash(h = location.hash) {
  const m = h.match(/^#\/(?:s\/([uw]_[a-f0-9]+)\/)?b\/(.+)$/);
  return m ? { space: m[1] || null, board: decodeURIComponent(m[2]) } : null;
}

/* ================= undo: only your own changes ================= */
// Each undo entry is a snapshot plus the moment it was taken. Changes pulled from the server after that moment are
// remembered per field ("color", "data.html", …), and undo leaves those fields alone, so it never reverts other people's work.
export const undoStack = [], redoStack = [];
let seq = 0;
const remoteAt = new Map();        // "kind:id" -> [{ seq, f: changed fields, or null when the record appeared/vanished }]
export function markRemote(key, before, after) {
  const list = remoteAt.get(key) || [];
  list.push({ seq: ++seq, f: before && after ? fieldsOf(before, after) : null });
  remoteAt.set(key, list);
}
export const snapshot = () => JSON.stringify({ boards: S.boards, items: S.items, lines: S.lines, trash: S.trash });
export const snap = () => ({ s: snapshot(), seq });
export function checkpoint() {
  undoStack.push(snap());
  if (undoStack.length > 150) {
    undoStack.shift();
    const oldest = undoStack[0].seq;   // older remote changes can't matter any more
    for (const [k, list] of remoteAt) { const keep = list.filter(x => x.seq > oldest); keep.length ? remoteAt.set(k, keep) : remoteAt.delete(k); }
  }
  redoStack.length = 0;
  updUndo();
}
export function resetUndo() { undoStack.length = redoStack.length = 0; remoteAt.clear(); updUndo(); }
export function restore(entry) {
  exitEdit(true);
  const o = JSON.parse(entry.s);
  const since = key => (remoteAt.get(key) || []).filter(x => x.seq > entry.seq);
  for (const [k, f] of [['board', 'boards'], ['item', 'items'], ['line', 'lines']]) {
    const from = o[f] || {};
    for (const id of new Set([...Object.keys(from), ...Object.keys(S[f])])) {
      const theirs = since(k + ':' + id), was = from[id], now = S[f][id];
      if (!theirs.length) { if (was) S[f][id] = was; else delete S[f][id]; continue; }
      // someone else changed this record meanwhile: put back only the fields they didn't touch
      if (!was || !now || theirs.some(x => !x.f)) continue;
      const skip = new Set(theirs.flatMap(x => [...x.f])), out = structuredClone(now);
      for (const p of fieldsOf(was, now)) {
        if (skip.has(p)) continue;
        const [a, b] = p.split('.');
        if (b !== undefined) { if (b in was.data) out.data[b] = was.data[b]; else delete out.data[b]; }
        else if (a in was) out[a] = was[a]; else delete out[a];
      }
      S[f][id] = out;
    }
  }
  const mine = key => !since(key).length;
  const now = new Map(S.trash.map(t => [t.id, t])), was = new Map((o.trash || []).map(t => [t.id, t]));
  S.trash = [...new Set([...now.keys(), ...was.keys()])].map(id => (mine('trash:' + id) ? was : now).get(id)).filter(Boolean)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!S.boards[cur]) { cur = ROOT; location.hash = boardHash(ROOT); }
  sel.clear(); selLine = null;
  save(); render();
}
export function undo() { if (RO || !undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); updUndo(); }
export function redo() { if (RO || !redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); updUndo(); }
export function updUndo() { $('#undoBtn').disabled = RO || !undoStack.length; $('#redoBtn').disabled = RO || !redoStack.length; }
export const setS = v => (S = v);
export const setROOT = v => (ROOT = v);
export const setCur = v => (cur = v);
export const setSelLine = v => (selLine = v);
export const setEditingId = v => (editingId = v);
export const setEditSnap = v => (editSnap = v);
export const setFreshId = v => (freshId = v);
export const setDragging = v => (dragging = v);
export const setSpaceDown = v => (spaceDown = v);
export const setLastPointer = v => (lastPointer = v);
export const setClip = v => (clip = v);
export const setClipText = v => (clipText = v);
