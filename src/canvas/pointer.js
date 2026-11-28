import { perFrame, track } from '../core/util.js';
import { canvas, marqueeEl } from '../core/dom.js';
import { RO, checkpoint, cur, editingId, els, freshId, lastPointer, save, sel, selLine, setFreshId, setLastPointer, setSelLine, spaceDown } from '../core/store.js';
import { V, applyView, itemRect, toWorld, zoomAt } from './viewport.js';
import { itemsOf } from '../core/model.js';
import { refreshSel, selectOnly } from './selection.js';
import { exitEdit, startEdit } from './editing.js';
import { bendDrag, endpointDrag } from './connectors.js';
import { createItem } from '../actions/create.js';
import { hideMenu, showCanvasMenu, showLineMenu } from '../ui/menus.js';
import { drawDown, drawMode } from '../cards/drawing.js';
import { editLineLabel } from './line-labels.js';

/* ================= pointer: canvas ================= */
export function panStart(e) {
  e.preventDefault();
  const v = V(), sx = e.clientX, sy = e.clientY, ox = v.x, oy = v.y;
  canvas.classList.add('panning');
  const mv = ev => { v.x = ox + ev.clientX - sx; v.y = oy + ev.clientY - sy; applyView(true); };
  const up = () => { canvas.classList.remove('panning'); save(true); };
  track(mv, up);
}

/** A right-click without Ctrl or Alt: on empty board it only pans; Ctrl or Alt (or Ctrl-click on a Mac) opens the board's menu. */
const plainRightClick = e => e.button === 2 && !e.ctrlKey && !e.altKey;

export function init() {
  // The right button: on empty board it pans; on a card or a line it selects it, and the contextmenu handlers then
  // open its options at the pointer.
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 2 || e.ctrlKey || e.altKey) return;
    e.stopPropagation();
    hideMenu();
    if (RO || drawMode) return panStart(e);
    const card = e.target.closest('.card[data-id]'), g = e.target.closest('g.ln');
    if (card) {
      e.preventDefault();
      const id = card.dataset.id;
      if (editingId === id) return;
      exitEdit();
      if (!sel.has(id)) selectOnly(id);
      return;
    }
    if (g) { e.preventDefault(); exitEdit(); sel.clear(); setSelLine(g.dataset.lid); refreshSel(); return; }
    panStart(e);
  }, true);
  canvas.addEventListener('pointerdown', e => {
    hideMenu();
    if (drawMode) return drawDown(e);
    if (RO) { if (e.button === 0 || e.button === 1) panStart(e); return; }
    const h = e.target.closest('#handles circle');
    if (h && selLine) {
      e.preventDefault(); e.stopPropagation();
      checkpoint();
      if (h.dataset.h === 'm') bendDrag(e, selLine); else endpointDrag(e, selLine, h.dataset.h, false);
      return;
    }
    if (e.button === 1 || spaceDown) return panStart(e);
    const g = e.target.closest('g.ln');
    if (g && e.button === 0) {
      exitEdit();
      sel.clear(); setSelLine(g.dataset.lid); refreshSel();
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault(); // stop the browser turning a marquee drag into a native text selection
    exitEdit();
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const additive = e.shiftKey || e.metaKey;
    const base = additive ? new Set(sel) : new Set();
    if (!additive) { sel.clear(); setSelLine(null); refreshSel(); }
    const cr = canvas.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, w0 = toWorld(sx, sy);
    let active = false, rects = null;
    const mv = ev => {
      if (!active) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
        active = true; marqueeEl.hidden = false;
        // groups only count when the box takes them in whole, so you can box-select what's inside one
        rects = itemsOf(cur).filter(it => !it.col).map(it => [it.id, itemRect(it.id), it.type === 'group']).filter(x => x[1]);
      }
      const x1 = Math.min(sx, ev.clientX), y1 = Math.min(sy, ev.clientY), x2 = Math.max(sx, ev.clientX), y2 = Math.max(sy, ev.clientY);
      Object.assign(marqueeEl.style, { left: x1 - cr.left + 'px', top: y1 - cr.top + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
      const w1 = toWorld(ev.clientX, ev.clientY);
      const rx1 = Math.min(w0.x, w1.x), ry1 = Math.min(w0.y, w1.y), rx2 = Math.max(w0.x, w1.x), ry2 = Math.max(w0.y, w1.y);
      const next = new Set(base);
      for (const [id, r, whole] of rects) if (whole ? r.x >= rx1 && r.x + r.w <= rx2 && r.y >= ry1 && r.y + r.h <= ry2 : r.x < rx2 && r.x + r.w > rx1 && r.y < ry2 && r.y + r.h > ry1) next.add(id);
      for (const id of sel) if (!next.has(id)) els.get(id)?.classList.remove('selected');
      for (const id of next) if (!sel.has(id)) els.get(id)?.classList.add('selected');
      sel.clear(); next.forEach(id => sel.add(id));
    };
    const up = () => {
      marqueeEl.hidden = true;
      refreshSel();
      window.getSelection()?.removeAllRanges(); // clear any stray native selection left over from the drag
    };
    track(mv, up);
  });
  canvas.addEventListener('pointermove', e => { setLastPointer(toWorld(e.clientX, e.clientY)); });
  canvas.addEventListener('dblclick', e => {
    if (RO || drawMode) return;
    const gl = e.target.closest('g.ln');
    if (gl) return editLineLabel(gl.dataset.lid);
    if (e.target.closest('.card')) return;
    const p = toWorld(e.clientX, e.clientY);
    const it = createItem('note', { x: p.x - 20, y: p.y - 20 });
    setFreshId(it.id);
    startEdit(it.id);
  });
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (RO || drawMode) return;
    const g = e.target.closest('g.ln');
    if (g) { sel.clear(); setSelLine(g.dataset.lid); refreshSel(); return showLineMenu(e.clientX, e.clientY); }
    if (plainRightClick(e)) return;
    setLastPointer(toWorld(e.clientX, e.clientY));
    showCanvasMenu(e.clientX, e.clientY);
  });
  // Trackpad / wheel: accumulate deltas and apply them once per frame; finish up when the gesture rests.
  let acc = null, idleT = 0;
  const applyWheel = perFrame(() => {
    const a = acc; acc = null; if (!a) return;
    const v = V();
    if (a.zoom) zoomAt(v.z * Math.exp(a.zoom), a.cx, a.cy, true);
    if (a.dx || a.dy) { v.x -= a.dx; v.y -= a.dy; applyView(true); }
    clearTimeout(idleT);
    idleT = setTimeout(() => { applyView(); save(true); }, 140);
  });
  canvas.addEventListener('wheel', e => {
    if (e.target.closest('#searchResults')) return;
    e.preventDefault();
    acc ||= { dx: 0, dy: 0, zoom: 0, cx: 0, cy: 0 };
    const unit = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) {
      acc.zoom += -e.deltaY * unit * (e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 50 ? 0.012 : 0.0025);
      acc.cx = e.clientX; acc.cy = e.clientY;
    } else { acc.dx += (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit; acc.dy += (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit; }
    applyWheel();
  }, { passive: false });
}

