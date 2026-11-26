import { $, clamp } from '../core/util.js';
import { canvas, world } from '../core/dom.js';
import { S, cur, els, save } from '../core/store.js';
import { itemsOf } from '../core/model.js';
import { cull, scheduleCull, sizeOf } from './cull.js';
import { renderHandles } from './lines.js';
import { positionBars } from '../ui/floatbars.js';
import { isAway, reveal } from '../cards/group.js';

/* ================= view / coordinates ================= */
export const V = () => (S ? (S.views[cur] ||= { x: 60, y: 40, z: 1 }) : { x: 0, y: 0, z: 1 });
const zoomPct = $('#zoomPct');
let lastPct = '', lastZ = 0;
export function applyView(fast) {
  const v = V();
  world.style.transform = `translate3d(${v.x}px,${v.y}px,0) scale(${v.z})`;
  // will-change keeps Chrome from redrawing the text at every step of a pinch (smooth), but it also keeps the text
  // bitmap from the zoom where the gesture started, stretched and blurry. So: on while the zoom moves, off once it rests,
  // and Chrome redraws the text sharp at the new zoom. Panning doesn't change the scale and needs no redraw.
  if (!fast) world.style.willChange = '';
  else if (v.z !== lastZ) world.style.willChange = 'transform';
  lastZ = v.z;
  world.style.setProperty('--iz', 1 / v.z);   // handles keep the same size on screen at any zoom
  // zoomed far out, cards are too small to resize or connect: their handles go (hundreds of cards draw much faster)
  canvas.classList.toggle('far', v.z < 0.4);
  const g = 20 * v.z;
  canvas.style.backgroundSize = `${g}px ${g}px`;
  canvas.style.backgroundPosition = `${v.x}px ${v.y}px`;
  const pct = Math.round(v.z * 100) + '%';
  if (pct !== lastPct) { zoomPct.textContent = pct; lastPct = pct; }
  scheduleCull();
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
/** A card's box in world coordinates: measured when it's drawn, else from its place and last known size (cull.js). */
export function itemRect(id) {
  if (isAway(id)) return null;   // hidden in a minimised group
  const el = els.get(id);
  if (el) return el.isConnected && el.offsetParent !== null ? rectWorld(el) : null;
  const it = S?.items[id];
  if (!it || it.board !== cur) return null;
  if (it.col) { const c = S.items[it.col]; return c && !c.data?.collapsed ? itemRect(c.id) : null; }   // a column off screen stands in for its cards
  const [w, h] = sizeOf(it);
  return { x: it.x, y: it.y, w, h };
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
  cull();   // the card is on screen now: draw it for whoever works on it next
}
