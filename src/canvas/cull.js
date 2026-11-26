import { canvas, itemsLayer } from '../core/dom.js';
import { S, dragging, editingId, els, sel } from '../core/store.js';
import { TYPES } from '../cards/types.js';
import { V } from './viewport.js';
import { makeCard } from './render.js';
import { renderLines } from './lines.js';
import { paintEditing } from '../ui/presence.js';
import { refreshImages } from './images.js';

/*
 * Only the cards on screen, plus a margin around it, are in the DOM. A board can hold thousands of cards and pictures;
 * drawing them all would make every pan, zoom and sync redraw slow and keep every picture in memory.
 * Cards off screen keep their place in the data; their size is the one they last had on screen (or a guess from
 * their data until they've been drawn once), so lines, snapping, box-select and "fit" still see them.
 */
const NEAR = 400;          // screen px around the view where cards are drawn before they scroll in
const FAR = 2 * NEAR;      // cards further out than this are taken out again (the gap stops cards flickering at the edge)
const BUDGET = 8;          // ms of drawing per frame while panning, so a big zoom-out fills in over a few frames
const AHEAD = 10;          // cards drawn per frame in the margin while panning: the browser lays out and paints each
                           // new card, and a whole column arriving at once when zoomed out would drop frames

let tops = [];             // top-level cards of the board, in draw order
let rank = new Map();      // id -> position in tops
let live = [];             // ids of drawn top-level cards, in draw order
const sizes = new Map();   // id -> [w, h] as last drawn (layout px, zoom left out)
let cw = canvas.clientWidth, ch = canvas.clientHeight;

new ResizeObserver(() => { cw = canvas.clientWidth; ch = canvas.clientHeight; scheduleCull(); }).observe(canvas);
const ro = new ResizeObserver(entries => {
  for (const e of entries) {
    const b = e.borderBoxSize?.[0];
    if (!e.target.isConnected || !b?.inlineSize) continue;   // taken out, or hidden
    sizes.set(e.target.dataset.id, [b.inlineSize, b.blockSize]);
  }
});

/** Size of a card on the board: as last drawn, else what its data says. */
export function sizeOf(it) {
  const s = sizes.get(it.id);
  if (s) return s;
  const T = TYPES[it.type] || {};
  if (it.type === 'group' && it.data?.collapsed) return [180, 32];   // a minimised group: just its label
  const w = it.w || T.w || 200;
  return [w, it.h || (it.data?.ratio ? w * it.data.ratio : 0) || T.h || 120];
}

/** The board was redrawn from scratch: these are its top-level cards, in draw order. */
export function resetCull(list) {
  for (const el of els.values()) ro.unobserve(el);
  tops = list; rank = new Map(list.map((it, i) => [it.id, i])); live = [];
}

let raf = 0;
export function scheduleCull() {
  // dragged cards ride in their own layer and must stay put; the drop redraws the board
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (!dragging) cull(false); });
}

let hold = false;
/** on: draw every card of the board and take none out (the PNG export draws the whole board); off: back to normal. */
export function holdAll(on) {
  hold = on;
  if (on) mountIds(tops.map(it => it.id)); else scheduleCull();
}

/** Draw the cards that came near the view and take out the ones far from it. all: everything at once (no frame budget). */
export function cull(all = true) {
  if (!S) return;
  const v = V(), z = v.z, x1 = -v.x / z, y1 = -v.y / z, x2 = x1 + cw / z, y2 = y1 + ch / z;
  const near = NEAR / z, far = FAR / z, cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const want = [];
  let changed = false;
  for (const it of tops) {
    const [w, h] = sizeOf(it), el = els.get(it.id);
    if (el) {
      if (!hold && (it.x > x2 + far || it.x + w < x1 - far || it.y > y2 + far || it.y + h < y1 - far)) {
        if (!pinned(it.id, el)) { unmount(it.id, el); changed = true; }
      }
    } else if (hold || (it.x < x2 + near && it.x + w > x1 - near && it.y < y2 + near && it.y + h > y1 - near)) {
      want.push([Math.hypot(it.x + w / 2 - cx, it.y + h / 2 - cy), it]);
    }
  }
  // nearest first, so what's on screen shows before the margin; the margin fills in a few cards a frame
  want.sort((a, b) => a[0] - b[0]);
  const t0 = performance.now();
  let n = 0;
  for (const [, it] of want) {
    if (!all && n && (performance.now() - t0 > BUDGET || (n >= AHEAD && !onScreen(it, x1, y1, x2, y2)))) { scheduleCull(); break; }
    mount(it); n++;
  }
  if (n || changed) { renderLines(); paintEditing(); }
  refreshImages();
}

function onScreen(it, x1, y1, x2, y2) {
  const [w, h] = sizeOf(it);
  return it.x < x2 && it.x + w > x1 && it.y < y2 && it.y + h > y1;
}

/** Draw these cards now if they aren't (a card in a column: its column), for code about to work on their elements. */
export function mountIds(ids) {
  let n = 0;
  for (const id of ids) {
    let it = S.items[id];
    while (it?.col && S.items[it.col]) it = S.items[it.col];
    if (it && rank.has(it.id) && !els.has(it.id)) { mount(it); n++; }
  }
  if (n) { renderLines(); paintEditing(); refreshImages(); }
}

// a card stays while it's edited, has the keyboard, or plays a video or sound
const pinned = (id, el) => id === editingId || el.contains(document.activeElement) || [...el.querySelectorAll('video,audio')].some(m => !m.paused);

function mount(it) {
  let el;
  try { el = makeCard(it); } catch (err) { console.error('Could not draw card', it.id, err); return; }
  el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
  if (sel.has(it.id) && editingId !== it.id) el.classList.add('selected');
  // keep the stacking order: in before the first drawn card that comes after it
  const r = rank.get(it.id);
  let lo = 0, hi = live.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (rank.get(live[m]) < r) lo = m + 1; else hi = m; }
  const next = live[lo] && els.get(live[lo]);
  if (next?.parentNode === itemsLayer) itemsLayer.insertBefore(el, next); else itemsLayer.appendChild(el);
  live.splice(lo, 0, it.id);
  ro.observe(el);
}

function unmount(id, el) {
  ro.unobserve(el);
  el.remove();
  // cards inside a column go with it
  for (const k of el.querySelectorAll('.card[data-id]')) if (els.get(k.dataset.id) === k) els.delete(k.dataset.id);
  els.delete(id);
  const i = live.indexOf(id);
  if (i >= 0) live.splice(i, 1);
}
