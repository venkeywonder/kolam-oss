/*
 * Resizing cards: every edge and corner is a handle. The edge under the pointer lights up, a badge shows the size,
 * edges snap to the cards around (with a guide), Shift keeps the shape, Alt resizes from the centre (and skips snapping),
 * and double-clicking a handle puts the card back to its usual size.
 *
 * How a card resizes depends on its type: free (width and height: sketches), keeping its shape (images, drawings: the
 * height follows the width), taller-only (to-dos, links, columns, tables, colours: the card can be pulled taller than
 * its content but never cuts it, and more content still grows it) or width only (everything else: the height follows
 * the content).
 */
import { $, track } from '../core/util.js';
import { S, checkpoint, cur, els, save, sel } from '../core/store.js';
import { V, itemRect } from './viewport.js';
import { itemsOf } from '../core/model.js';
import { TYPES } from '../cards/types.js';
import { renderLines } from './lines.js';
import { selectOnly } from './selection.js';
import { positionBars } from '../ui/floatbars.js';
import { contentBox, contentsOf } from '../cards/group.js';
import { calm } from './motion.js';

const modeOf = T => (T.resizeH ? 'free' : T.ratio ? 'ratio' : T.fitH ? 'fit' : 'width');
const EDGES = { free: ['n', 'e', 's', 'w'], fit: ['n', 'e', 's', 'w'], ratio: ['e', 'w'], width: ['e', 'w'] };
/** How narrow and how wide each type of card can be made ([min, max] width; sketches also [min, max] height). */
const WIDTHS = {
  note: [220, 720], todo: [240, 640], link: [240, 640], image: [140, 1200], file: [240, 480], board: [130, 280], shortcut: [130, 280],
  column: [240, 520], comment: [240, 480], sketch: [220, 1200], swatch: [140, 360], table: [300, 1200], doc: [260, 520],
  drawing: [60, 1600], text: [40, 1600], icon: [24, 480], group: [120, 4000],
};
const HEIGHTS = { sketch: [150, 900], group: [80, 4000] };
const widthRange = type => WIDTHS[type] || [180, 800];
const heightRange = type => HEIGHTS[type] || [120, 1200];
const SAFE = 12;

/** A note can be made as narrow as its widest line plus a little room (never wider than the usual minimum). */
function noteMinW(el, minW) {
  const body = el.querySelector('.note-body'); if (!body) return minW;
  const chrome = el.offsetWidth - body.offsetWidth, w0 = body.style.width;
  body.style.width = 'max-content';
  const content = body.offsetWidth;
  body.style.width = w0;
  return Math.min(minW, Math.max(60, Math.ceil(content + chrome + SAFE)));
}

/** The handles for a card of type T. */
export function resizeHandles(T) {
  const mode = modeOf(T), tip = 'Drag to resize · double-click for the usual size';
  return `<div class="rz-set rz-${mode}">` + [...EDGES[mode], 'ne', 'se', 'sw', 'nw']
    .map(d => `<div class="rz${d.length > 1 ? ' c' : ''}" data-rz="${d}" title="${tip}"></div>`).join('') + '</div>';
}

export function resizeStart(e, id) {
  e.preventDefault();
  const dir = e.target.closest('.rz').dataset.rz;
  let it = S.items[id];
  const T = TYPES[it.type], z = V().z, mode = modeOf(T);
  let el = els.get(id);
  if (!sel.has(id)) selectOnly(id);
  const r0 = { x: it.x, y: it.y, w: el.offsetWidth, h: el.offsetHeight }, ratio = r0.w / r0.h;
  let [minW, maxW] = widthRange(it.type);
  const [minH, maxH] = heightRange(it.type);
  if (it.type === 'note') minW = noteMinW(el, minW);
  const hx = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
  const hy = mode === 'width' ? 0 : dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
  // a group can't be pulled in over the cards inside it (each edge stops where it would cut them, or where it started
  // if they already sit closer), and its edges don't snap onto those cards
  const box = it.type === 'group' ? contentBox(id) : null;
  const fit = box && { x1: Math.max(box.x1, r0.x), y1: Math.max(box.y1, r0.y), x2: Math.min(box.x2, r0.x + r0.w), y2: Math.min(box.y2, r0.y + r0.h) };
  const inside = new Set(box ? contentsOf(id, true) : []);
  const others = itemsOf(cur).filter(i => !i.col && i.id !== id && !inside.has(i.id)).map(i => itemRect(i.id)).filter(Boolean);
  /** The least size along one axis that keeps [a, b] covered, for a card starting at `start` with `size`, pulled by `d`. */
  const cover = (a, b, start, size, d, centre) => Math.ceil(centre ? Math.max(size - 2 * (a - start), 2 * (b - start) - size)
    : d > 0 ? b - start : d < 0 ? start + size - a : 0);
  const sx = e.clientX, sy = e.clientY;
  const guides = $('#guides'), body = document.body;
  let badge = null, started = false;

  const mv = ev => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 2) return;
      started = true;
      checkpoint();
      el.classList.add('resizing');
      if (T.autoW) el.style.maxWidth = 'none';   // text gets a width of its own from now on
      el.querySelector(`.rz[data-rz="${dir}"]`).classList.add('on');
      body.style.setProperty('--rz-cursor', getComputedStyle(el.querySelector(`.rz[data-rz="${dir}"]`)).cursor);
      body.classList.add('resizing');
      badge = document.createElement('div'); badge.className = 'rz-badge';
      body.appendChild(badge);
    }
    // the board may be redrawn mid-resize (changes coming in): keep working on the card that's on screen
    const now = els.get(id); if (!now || !S.items[id]) return;
    it = S.items[id];
    if (now !== el) { el = now; el.classList.add('resizing'); el.querySelector(`.rz[data-rz="${dir}"]`)?.classList.add('on'); }
    const centre = ev.altKey, k = centre ? 2 : 1;
    const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
    let w = r0.w + hx * dx * k, h = r0.h + hy * dy * k;
    const keep = mode === 'ratio' || (mode === 'free' && ev.shiftKey && hx && hy);
    if (keep) {
      if (!hx) w = h * ratio;
      else if (hy && h * ratio > w) w = h * ratio;     // a corner follows whichever way it's pulled further
      h = w / ratio;
    }
    // snap the edges that move onto the edges and middles of the cards around
    let gx = null, gy = null;
    if (!centre) {
      const th = 6 / z;
      const near = (v, axis) => {
        let best = null;
        for (const r of others) for (const o of axis === 'x' ? [r.x, r.x + r.w / 2, r.x + r.w] : [r.y, r.y + r.h / 2, r.y + r.h]) {
          const d = o - v; if (Math.abs(d) < th && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, v: o, r };
        }
        return best;
      };
      if (hx) { gx = near(hx > 0 ? r0.x + w : r0.x + r0.w - w, 'x'); if (gx) w += hx * gx.d; }
      if (hy && !keep) { gy = near(hy > 0 ? r0.y + h : r0.y + r0.h - h, 'y'); if (gy) h += hy * gy.d; }
      if (keep && gx) h = w / ratio;
    }
    const loW = fit ? Math.max(minW, cover(fit.x1, fit.x2, r0.x, r0.w, hx, centre)) : minW;
    const loH = fit ? Math.max(minH, cover(fit.y1, fit.y2, r0.y, r0.h, hy, centre)) : minH;
    let limit = w < loW ? 'min' : w > maxW ? 'max' : mode === 'free' && !keep && h < loH ? 'min' : mode === 'free' && !keep && h > maxH ? 'max' : '';
    w = Math.round(Math.min(maxW, Math.max(loW, w)));
    if (mode === 'free') h = Math.round(Math.min(maxH, Math.max(loH, keep ? w / ratio : h)));
    if (limit) { gx = gy = null; }
    it.w = w; el.style.width = w + 'px';
    if (mode === 'free') { it.h = h; el.style.height = h + 'px'; T.onResize?.(el, it); }
    else if (mode === 'fit') {
      el.style.minHeight = '';
      const need = el.offsetHeight;                        // what the content needs at this width
      if (!limit) limit = h < need ? 'min' : h > maxH ? 'max' : '';
      h = Math.round(Math.min(maxH, h));
      if (h > need) { it.h = h; el.style.minHeight = h + 'px'; } else { delete it.h; h = need; }
    }
    else h = el.offsetHeight;                              // the height follows the content
    it.x = Math.round(centre ? r0.x + (r0.w - w) / 2 : hx < 0 ? r0.x + r0.w - w : r0.x);
    it.y = Math.round(centre && hy ? r0.y + (r0.h - h) / 2 : hy < 0 ? r0.y + r0.h - h : r0.y);
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px';

    badge.textContent = `${w} × ${Math.round(h)}${limit ? ' · ' + limit : ''}`;
    badge.classList.toggle('limit', !!limit);
    badge.style.left = ev.clientX + 16 + 'px'; badge.style.top = ev.clientY + 18 + 'px';
    const t = 1 / z;
    let g = '';
    if (gx) { const y1 = Math.min(it.y, gx.r.y), y2 = Math.max(it.y + h, gx.r.y + gx.r.h); g += `<i style="left:${gx.v}px;top:${y1}px;width:${t}px;height:${y2 - y1}px"></i>`; }
    if (gy) { const x1 = Math.min(it.x, gy.r.x), x2 = Math.max(it.x + w, gy.r.x + gy.r.w); g += `<i style="top:${gy.v}px;left:${x1}px;height:${t}px;width:${x2 - x1}px"></i>`; }
    guides.innerHTML = g;
    renderLines(); positionBars();
  };
  const up = () => {
    if (!started) return;
    el = els.get(id) || el;
    el.classList.remove('resizing'); el.querySelector('.rz.on')?.classList.remove('on');
    body.classList.remove('resizing');
    guides.innerHTML = '';
    if (calm()) badge.remove();
    else badge.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150 }).finished.then(() => badge.remove(), () => badge.remove());
    save();
  };
  track(mv, up);
}

/** Double-click on a handle: back to the type's usual size, keeping the card where it is. */
export function resetSize(id) {
  const it = S.items[id], el = els.get(id), T = TYPES[it?.type];
  if (!it || !el || it.locked) return;
  // text: back to fitting its words
  if (T.autoW) {
    if (!it.w) return;
    checkpoint(); delete it.w; el.style.width = 'max-content'; el.style.maxWidth = '900px';
    save(); renderLines(); positionBars(); return;
  }
  let w = T.w || 260, h = T.resizeH ? T.h || 220 : null;
  // a group comes back to its usual size, or just big enough for what's inside it
  const box = it.type === 'group' && contentBox(id);
  if (box) { w = Math.max(w, Math.ceil(box.x2 - it.x)); h = Math.max(h, Math.ceil(box.y2 - it.y)); }
  if (el.offsetWidth === w && (h == null || el.offsetHeight === h) && !(T.fitH && it.h)) return;
  checkpoint();
  const from = { width: el.offsetWidth + 'px', height: el.offsetHeight + 'px' };
  it.w = w; el.style.width = w + 'px';
  if (h != null) { it.h = h; el.style.height = h + 'px'; T.onResize?.(el, it); }
  else if (T.fitH) { delete it.h; el.style.minHeight = ''; }
  save(); renderLines(); positionBars();
  if (!calm()) el.animate([from, { width: w + 'px', height: el.offsetHeight + 'px' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' })
    .finished.then(() => { renderLines(); positionBars(); }, () => {});
}
