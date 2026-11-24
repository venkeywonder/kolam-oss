import { $$ } from '../core/util.js';
import { itemsLayer } from '../core/dom.js';
import { S, RO, editSnap, editingId, els, freshId, redoStack, save, sel, selLine, setEditSnap, setEditingId, setFreshId, setSelLine, snap, snapshot, undoStack, updUndo } from '../core/store.js';
import { TYPES } from '../cards/types.js';
import { rebuildCard, renderBoard, renderCrumbs } from './render.js';
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
export function startEdit(id, pt) {
  const it = S.items[id]; if (!it) return;
  const T = TYPES[it.type]; if (!T.edit || RO) return;
  if (it.locked) { toast('This card is locked. Unlock it to edit.'); return; }
  if (editingId && editingId !== id) exitEdit();
  if (editingId === id) return;
  const other = editorOf(id);
  if (other) toast(`${other.name} is editing this card too`);
  setEditingId(id); setEditSnap(snap());
  openText(id);
  sel.clear(); sel.add(id); setSelLine(null);
  const el = els.get(id);
  el.classList.add('editing');
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
    el.classList.remove('editing');
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
    if (it && el && e.target.closest('[contenteditable=true]')) { openText(editingId); TYPES[it.type].read?.(el, it); save(); renderLines(); positionBars(); }
  });
  itemsLayer.addEventListener('keydown', e => {
    if (!editingId) return;
    const T = TYPES[S.items[editingId]?.type];
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const id = editingId; exitEdit(); selectOnly(id); }
    else if (e.key === 'Enter' && T?.enterExits && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); exitEdit(); }
  });
}

