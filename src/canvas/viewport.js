import { $, clamp } from '../core/util.js';
import { canvas, world } from '../core/dom.js';
import { S, cur, els, save } from '../core/store.js';
import { itemsOf } from '../core/model.js';
import { renderHandles } from './lines.js';
import { positionBars } from '../ui/floatbars.js';
import { reveal } from '../cards/group.js';

/* ================= view / coordinates ================= */
export const V = () => (S ? (S.views[cur] ||= { x: 60, y: 40, z: 1 }) : { x: 0, y: 0, z: 1 });
const zoomPct = $('#zoomPct');
let lastPct = '';
export function applyView(fast) {
  const v = V();
  world.style.transform = `translate3d(${v.x}px,${v.y}px,0) scale(${v.z})`;
  world.style.setProperty('--iz', 1 / v.z);   // handles keep the same size on screen at any zoom
  const g = 20 * v.z;
  canvas.style.backgroundSize = `${g}px ${g}px`;
  canvas.style.backgroundPosition = `${v.x}px ${v.y}px`;
  const pct = Math.round(v.z * 100) + '%';
  if (pct !== lastPct) { zoomPct.textContent = pct; lastPct = pct; }
  if (fast) return;
  renderHandles();
  positionBars();
}
export function toWorld(cx, cy) {
  const r = canvas.getBoundingClientRect(), v = V();
  return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z };
}
export function rectWorld(el) {
  const b = el.getBoundingClientRect(), p = toWorld(b.left, b.top), z = V().z;
  return { x: p.x, y: p.y, w: b.width / z, h: b.height / z };
}
export function itemRect(id) {
  const el = els.get(id);
  return el && el.isConnected && el.offsetParent !== null ? rectWorld(el) : null;
}
export function zoomAt(nz, cx, cy, fast) {
  const v = V(), r = canvas.getBoundingClientRect();
  nz = clamp(nz, 0.15, 3);
  const px = cx - r.left, py = cy - r.top;
  v.x = px - (px - v.x) * nz / v.z;
  v.y = py - (py - v.y) * nz / v.z;
  v.z = nz;
  applyView(fast); if (!fast) save(true);
}
export function zoomCenter(f) { const r = canvas.getBoundingClientRect(); zoomAt(V().z * f, r.left + r.width / 2, r.top + r.height / 2); }
export function viewCenter() { const r = canvas.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); }
export function fit() {
  const tops = itemsOf(cur).filter(i => !i.col);
  const v = V(), r = canvas.getBoundingClientRect();
  if (!tops.length) { v.x = 60; v.y = 40; v.z = 1; applyView(); return; }
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const it of tops) { const b = itemRect(it.id); if (!b) continue; x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
  const z = clamp(Math.min((r.width - 120) / (x2 - x1), (r.height - 120) / (y2 - y1), 1.2), 0.15, 1.2);
  v.z = z; v.x = (r.width - (x2 - x1) * z) / 2 - x1 * z; v.y = (r.height - (y2 - y1) * z) / 2 - y1 * z;
  applyView(); save(true);
}
export function centerOn(id) {
  reveal(id);   // shown in full if a minimised group hides it
  const b = itemRect(id); if (!b) return;
  const v = V(), r = canvas.getBoundingClientRect();
  v.x = r.width / 2 - (b.x + b.w / 2) * v.z;
  v.y = r.height / 2 - (b.y + b.h / 2) * v.z;
  applyView();
}
