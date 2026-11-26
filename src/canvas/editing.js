import { $$ } from '../core/util.js';
import { itemsLayer } from '../core/dom.js';
import { S, RO, editSnap, editingId, els, freshId, redo, redoStack, save, sel, selLine, setEditSnap, setEditingId, setFreshId, setSelLine, snap, snapshot, undo, undoStack, updUndo } from '../core/store.js';
import { TYPES } from '../cards/types.js';
import { rebuildCard, renderBoard, renderCrumbs } from './render.js';
import { mountIds } from './cull.js';
import { renderLines } from './lines.js';
import { refreshSel, selectOnly } from './selection.js';
import { deleteItems } from '../actions/edit.js';
import { positionBars } from '../ui/floatbars.js';
import { toast } from '../ui/toast.js';
import { editorOf } from '../ui/presence.js';
import { open as openText } from '../core/ytext.js';

/* ================= editing ================= */
export function caretEnd(n) {
  if (!n) return;
  n.focus();
  const r = document.createRange(); r.selectNodeContents(n); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
// whether anything was typed since the card went into editing: until then a press-and-drag on it moves it
let typed = false;
export const typedSinceEdit = () => typed;
/** Nothing of the current edit is left: nothing typed yet, or everything typed was undone again. */
function untouched() {
  if (!typed) return true;
  const it = S.items[editingId], el = els.get(editingId);
  if (it && el) TYPES[it.type].read?.(el, it);
  return !!editSnap && snapshot() === editSnap.s;
}
export function startEdit(id, pt) {
  const it = S.items[id]; if (!it) return;
  const T = TYPES[it.type]; if (!T.edit || RO) return;
  if (it.locked) { toast('This card is locked. Unlock it to edit.'); return; }
  const why = T.noEdit?.(it);
  if (why) { toast(why); return; }
  if (editingId && editingId !== id) exitEdit();
  if (editingId === id) return;
  const other = editorOf(id);
  if (other) toast(`${other.name} is editing this card too`);
  setEditingId(id); setEditSnap(snap()); typed = false;
  openText(id);
  sel.clear(); sel.add(id); setSelLine(null);
  mountIds([id]);   // editing a card off screen (Enter on a selection) needs its element
  const el = els.get(id);
  el.classList.add('editing', 'untyped');   // untyped: a drag still moves it, so it shows the hand (cards.css)
  const f = T.edit(el, it);
  refreshSel();
  if (f) {
    const under = pt && document.elementFromPoint(pt.x, pt.y);
    const target = under?.closest?.('[contenteditable=true]');
    if (target && el.contains(target)) {
      target.focus();
      const r = document.caretRangeFromPoint?.(pt.x, pt.y);
      if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); } else caretEnd(target);
    } else caretEnd(f);
  }
  positionBars();
}
export function exitEdit(silent) {
  if (!editingId) return;
  const id = editingId; setEditingId(null);
  const it = S.items[id], el = els.get(id);
  let needRebuild = false;
  if (it && el) {
    TYPES[it.type].read?.(el, it);
    needRebuild = !!TYPES[it.type].stop?.(el, it);
    el.classList.remove('editing', 'untyped');
    $$('[contenteditable]', el).forEach(n => { n.removeAttribute('contenteditable'); if (n.classList.contains('rt') && !n.innerText.trim()) n.innerHTML = ''; });
    // throw away a brand-new note or text that was left empty
    if (!silent && freshId === id && (it.type === 'note' || it.type === 'text') && !it.data.html) {
      deleteItems([id]); setFreshId(null); setEditSnap(null);
      undoStack.pop(); updUndo(); save(); renderBoard(); return;
    }
  }
  setFreshId(null);
  if (!silent && editSnap && snapshot() !== editSnap.s) {
    undoStack.push(editSnap); redoStack.length = 0; save();
  }
  setEditSnap(null);
  getSelection()?.removeAllRanges();
  if (silent) return;
  if (it?.type === 'board') { renderCrumbs(); }
  if (needRebuild) rebuildCard(id);
  updUndo(); refreshSel();
}

export function init() {
  itemsLayer.addEventListener('input', e => {
    if (!editingId) return;
    const it = S.items[editingId], el = els.get(editingId);
    if (it && el && e.target.closest('[contenteditable=true]')) { typed = true; el.classList.remove('untyped'); openText(editingId); TYPES[it.type].read?.(el, it); save(); renderLines(); positionBars(); }
  });
  itemsLayer.addEventListener('keydown', e => {
    if (!editingId) return;
    const T = TYPES[S.items[editingId]?.type];
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const id = editingId; exitEdit(); selectOnly(id); }
    else if (e.key === 'Enter' && T?.enterExits && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); exitEdit(); }
    // ⌘Z / Ctrl+Z: the browser's text undo covers what was typed here. With nothing of this edit left to undo (nothing
    // typed yet, or all of it undone) the browser would do nothing, so close the card and undo the board instead.
    else if ((e.metaKey || e.ctrlKey) && !e.altKey && /^[zy]$/i.test(e.key) && (e.shiftKey || e.key.toLowerCase() === 'y' ? !typed : untouched())) {
      e.preventDefault(); e.stopPropagation();
      const n = undoStack.length, keep = redoStack.slice();
      exitEdit();
      // closing a card nothing was typed in isn't a change of its own (its fields may have been tidied, e.g. '' titles)
      if (undoStack.length > n) { undoStack.length = n; redoStack.splice(0, Infinity, ...keep); }
      if (e.shiftKey || e.key.toLowerCase() === 'y') redo();
      else if (undoStack.length === n) undo();   // a brand-new empty note is already gone (exitEdit drops it and its undo step)
    }
  });
}

