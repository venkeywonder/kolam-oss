import { uid } from '../core/util.js';
import { S, RO, checkpoint, clip, clipText, cur, save, sel, selLine, setClip, setClipText, setSelLine, undo } from '../core/store.js';
import { remember } from '../core/styles.js';
import { itemRect } from '../canvas/viewport.js';
import { childrenOf, itemsOf } from '../core/model.js';
import { TYPES } from '../cards/types.js';
import { renderBoard } from '../canvas/render.js';
import { refreshSel } from '../canvas/selection.js';
import { toast } from '../ui/toast.js';
import { toTrash } from '../ui/drawer.js';

/* ================= delete / duplicate / clipboard ================= */
export function deleteItems(ids) {
  for (const id of ids) {
    const it = S.items[id]; if (!it) continue;
    if (it.type === 'column') deleteItems(childrenOf(id).map(k => k.id));
    if (it.type === 'board') deleteBoard(it.data.target);
    delete S.items[id];
    for (const ln of Object.values(S.lines)) if (ln.a.item === id || ln.b.item === id) delete S.lines[ln.id];
  }
}
export function deleteBoard(bid) {
  if (!S.boards[bid] || bid === 'home') return;
  deleteItems(itemsOf(bid).map(i => i.id));
  for (const ln of Object.values(S.lines)) if (ln.board === bid) delete S.lines[ln.id];
  delete S.boards[bid];
}
export function deleteSelection() {
  if (RO) return;
  if (selLine) { checkpoint(); delete S.lines[selLine]; setSelLine(null); save(); renderBoard(); return; }
  if (!sel.size) return;
  checkpoint();
  const n = sel.size;
  toTrash([...sel]);
  deleteItems([...sel]); sel.clear();
  save(); renderBoard();
  toast(`${n === 1 ? 'Card' : n + ' cards'} moved to Trash`, 'Undo', undo);
}
export function capture(ids) {
  const set = new Set(ids.filter(id => S.items[id]));
  for (const id of [...set]) if (S.items[id].type === 'column') childrenOf(id).forEach(k => set.add(k.id));
  const items = [...set].map(id => {
    const n = structuredClone(S.items[id]);
    if (n.col && !set.has(n.col)) {
      const r = itemRect(id);
      if (r) { n.x = Math.round(r.x); n.y = Math.round(r.y); n.w = Math.round(r.w); }
      n.col = null;
    }
    return n;
  });
  const lines = Object.values(S.lines)
    .filter(l => l.board === cur && (l.a.item || l.b.item) && (!l.a.item || set.has(l.a.item)) && (!l.b.item || set.has(l.b.item)))
    .map(l => structuredClone(l));
  return { items, lines };
}
export function cloneBoard(bid, parent) {
  const src = S.boards[bid];
  const nb = { id: uid(), title: src ? src.title : 'Untitled board', parent };
  S.boards[nb.id] = nb;
  if (src) cloneItems(itemsOf(bid).map(i => structuredClone(i)), Object.values(S.lines).filter(l => l.board === bid).map(l => structuredClone(l)), nb.id, 0, 0);
  return nb.id;
}
export function cloneItems(items, lines, board, dx, dy) {
  const map = {}; items.forEach(i => (map[i.id] = uid()));
  let z = itemsOf(board).reduce((m, i) => Math.max(m, i.z || 0), 0);
  const out = [];
  for (const src of items) {
    const n = structuredClone(src);
    n.id = map[src.id]; n.board = board;
    n.col = src.col ? map[src.col] || null : null;
    if (!n.col) { n.x = Math.round((n.x || 0) + dx); n.y = Math.round((n.y || 0) + dy); n.z = ++z; }
    if (n.type === 'board') n.data = { target: cloneBoard(src.data.target, board) };
    S.items[n.id] = n;
    if (!n.col) out.push(n.id);
  }
  const mapEnd = e => (e.item ? (map[e.item] ? { ...e, item: map[e.item] } : null) : { x: e.x + dx, y: e.y + dy });
  for (const l of lines) {
    const a = mapEnd(l.a), b = mapEnd(l.b);
    if (a && b) { const id = uid(); S.lines[id] = { ...l, id, board, a, b }; }
  }
  return out;
}
export function duplicate() {
  if (!sel.size) return;
  checkpoint();
  const c = capture([...sel]);
  const ids = cloneItems(c.items, c.lines, cur, 24, 24);
  save(); renderBoard();
  sel.clear(); ids.forEach(id => sel.add(id)); refreshSel();
}
export function copySel() {
  if (!sel.size) return false;
  setClip(capture([...sel]));
  setClipText(clip.items.map(i => (TYPES[i.type].text?.(i) || '').replace(/<[^>]+>/g, ' ').trim()).filter(Boolean).join('\n\n') || '[Kolam cards]');
  return true;
}
export function pasteClip(at) {
  if (!clip) return;
  checkpoint();
  const tops = clip.items.filter(i => !i.col);
  let dx = 24, dy = 24;
  if (at && tops.length) {
    const minX = Math.min(...tops.map(i => i.x)), minY = Math.min(...tops.map(i => i.y));
    dx = at.x - minX; dy = at.y - minY;
  }
  const ids = cloneItems(structuredClone(clip.items), structuredClone(clip.lines), cur, dx, dy);
  clip.items.forEach(i => { if (!i.col) { i.x += 24; i.y += 24; } });
  save(); renderBoard();
  sel.clear(); ids.forEach(id => sel.add(id)); refreshSel();
}
export function setColor(k) {
  checkpoint();
  if (selLine) { S.lines[selLine].color = k; remember('line', { color: k }); }
  // new cards of each kind you recoloured come out in this colour
  for (const id of sel) if (S.items[id]) { S.items[id].color = k; remember(S.items[id].type, { color: k }); }
  save(); renderBoard();
}
export function reorder(front) {
  checkpoint();
  const tops = itemsOf(cur).filter(i => !i.col).sort((a, b) => (a.z || 0) - (b.z || 0));
  const moving = tops.filter(i => sel.has(i.id)), rest = tops.filter(i => !sel.has(i.id));
  (front ? [...rest, ...moving] : [...moving, ...rest]).forEach((it, i) => (it.z = i + 1));
  save(); renderBoard();
}
