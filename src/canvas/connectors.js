import { $$, clamp, uid, track } from '../core/util.js';
import { canvas } from '../core/dom.js';
import { S, checkpoint, cur, dragging, els, save, sel, selLine, setDragging, setSelLine, undoStack, updUndo } from '../core/store.js';
import { V, itemRect, toWorld } from './viewport.js';
import { SIDES, lineGeom, renderLines, routeOf, setPortHint } from './lines.js';
import { curveNew, lineStyle, remember } from '../core/styles.js';
import { refreshSel } from './selection.js';
import { hideBars } from '../ui/floatbars.js';

/* ---------- connectors ---------- */
export function cardAt(cx, cy) {
  for (const n of document.elementsFromPoint(cx, cy)) {
    const c = n.closest?.('.card'); if (c) return c.dataset.id;
    if (n === canvas) return null;
  }
  return null;
}
/**
 * Where a line end dropped at world point p attaches on card rect r:
 * near an edge → pinned to that point of the side (snapping to the side's middle); well inside → automatic ({}).
 */
export function portAt(r, p) {
  const z = V().z;
  const dist = { top: p.y - r.y, right: r.x + r.w - p.x, bottom: r.y + r.h - p.y, left: p.x - r.x };
  const side = SIDES.reduce((a, s) => (dist[s] < dist[a] ? s : a));
  if (dist[side] > Math.min(24 / z, r.w / 4, r.h / 4)) return {};
  const along = side === 'top' || side === 'bottom', len = along ? r.w : r.h;
  let t = clamp((along ? p.x - r.x : p.y - r.y) / len, 0, 1);
  if (Math.abs(t - 0.5) * len < 10 / z) t = 0.5;
  return { side, t: Math.round(t * 1000) / 1000 };
}
export function connStart(e, id, side) {
  e.preventDefault();
  checkpoint();
  const p = toWorld(e.clientX, e.clientY);
  const a = SIDES.includes(side) ? { item: id, side, t: 0.5 } : { item: id };
  const ln = { id: uid(), board: cur, a, b: { x: p.x, y: p.y }, ...lineStyle() };
  S.lines[ln.id] = ln;
  sel.clear(); setSelLine(ln.id); refreshSel();
  endpointDrag(e, ln.id, 'b', true);
}
export function endpointDrag(e, lid, end, fresh) {
  const ln = S.lines[lid];
  const other = end === 'a' ? 'b' : 'a';
  setDragging(true); hideBars();
  let moved = false;
  const mv = ev => {
    moved = true;
    const hit = cardAt(ev.clientX, ev.clientY), r = hit && hit !== ln[other].item && itemRect(hit);
    const p = toWorld(ev.clientX, ev.clientY);
    $$('.drop-target').forEach(x => x.classList.remove('drop-target'));
    if (r) {
      ln[end] = { item: hit, ...portAt(r, p) };
      if (!ln[end].side) els.get(hit)?.classList.add('drop-target');
    } else ln[end] = { x: Math.round(p.x), y: Math.round(p.y) };
    setPortHint(r ? hit : null);
    renderLines();
  };
  const up = () => {
    setDragging(false); setPortHint(null);
    $$('.drop-target').forEach(x => x.classList.remove('drop-target'));
    if (fresh && !moved) { delete S.lines[lid]; undoStack.pop(); setSelLine(null); updUndo(); }
    else if (fresh) { curveNew(ln); renderLines(); }
    save(); refreshSel();
  };
  track(mv, up);
}
export function bendDrag(e, lid) {
  const ln = S.lines[lid];
  setDragging(true); hideBars();
  // dragging the middle of a straight line curves it (and new lines come out curved from then on)
  const was = routeOf(ln);
  if (ln.route === 'straight') delete ln.route;
  const mv = ev => {
    const G = lineGeom(ln); if (!G) return;
    let b = G.bendAt(toWorld(ev.clientX, ev.clientY));
    if (Math.abs(b) < 12) b = 0;
    ln.bend = Math.round(b);
    renderLines();
  };
  const up = () => {
    setDragging(false);
    if (was === 'straight' && routeOf(ln) === 'curved') remember('line', { route: 'curved' });
    save(); refreshSel();
  };
  track(mv, up);
}
