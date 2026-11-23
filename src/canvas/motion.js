/*
 * Drag & drop motion: cards sway with the pointer's speed while dragged, land with a little squash and a ring on the
 * board, glide into their new place (columns, after reordering), and get swallowed by the board or the Unsorted
 * drawer they're dropped into. Everything is skipped when the system asks for reduced motion.
 * Only CSS individual transform properties (translate / rotate / scale) are animated here, so these effects stack
 * with the transform a dragged card is positioned with.
 */
import { clamp } from '../core/util.js';
import { itemsLayer } from '../core/dom.js';
import { els } from '../core/store.js';
import { V, rectWorld } from './viewport.js';

const mq = matchMedia('(prefers-reduced-motion: reduce)');
export const calm = () => mq.matches;

// heavier cards tilt less and settle slower
const MASS = { column: 2.6, table: 1.7, doc: 1.4, drawing: 1.3, image: 1.15, sketch: 1.15, board: .85, shortcut: .85, swatch: .8 };
export const massOf = type => MASS[type] || 1;

/**
 * Tilt that follows horizontal speed and settles when the pointer rests.
 * set(deg) applies the angle; call move(clientX) on every pointer move and stop() at the end (returns the last angle).
 */
export function sway(set, mass = 1) {
  const max = 9 / Math.sqrt(mass), k = 6 / mass, follow = .24 / Math.sqrt(mass);
  let px = null, pt = 0, v = 0, a = 0, raf = 0;
  const tick = () => {
    v *= .85;
    a += (clamp(v * k, -max, max) - a) * follow;
    if (Math.abs(a) < .02) a = 0;
    set(a);
    raf = requestAnimationFrame(tick);
  };
  return {
    move(x) {
      const t = performance.now();
      if (px !== null && t > pt) v = v * .55 + clamp((x - px) / (t - pt), -4, 4) * .45;
      px = x; pt = t;
      if (!raf && !calm()) raf = requestAnimationFrame(tick);
    },
    stop() { cancelAnimationFrame(raf); raf = 0; return a; },
  };
}

/** A ring that spreads out on the board under a card that just landed (or appeared). */
export function ripple(el) {
  if (!el?.isConnected || calm()) return;
  const target = el.classList.contains('t-board') ? el.querySelector('.bd-icon') || el : el;
  const r = rectWorld(target);
  const d = document.createElement('div');
  d.className = 'land-ring';
  Object.assign(d.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', borderRadius: getComputedStyle(target).borderRadius });
  itemsLayer.insertBefore(d, itemsLayer.firstChild);
  d.addEventListener('animationend', () => d.remove());
}

/** Set a card down: from its lifted tilt to a small squash, a wobble back and rest; ring: spread a ring under it. */
export function land(el, from = 0, { delay = 0, ring = true } = {}) {
  if (!el || calm()) return;
  el.animate([
    { rotate: `${from}deg`, scale: 1.04 },
    { rotate: `${-from * .3}deg`, scale: .965, offset: .4 },
    { rotate: `${from * .1}deg`, scale: 1.012, offset: .72 },
    { rotate: '0deg', scale: 1 },
  ], { duration: 520, delay, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'backwards' });
  if (ring) setTimeout(() => ripple(el), delay + 120);
}

/** Drop something into a list from just above, with a little overshoot. */
export function popIn(el, delay = 0) {
  if (!el || calm()) return;
  el.animate([{ opacity: 0, translate: '0px -14px', scale: .9 }, { opacity: 1, translate: '0px 0px', scale: 1 }],
    { duration: 380, delay, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'backwards' });
}

/** A new card pops onto the board (CSS .appear) and a ring spreads under it. */
export function appear(el) {
  if (!el) return;
  el.classList.add('appear');
  if (!calm()) setTimeout(() => ripple(el), 140);
}

/** Send a floating ghost (fixed on screen) back into the element it came from, then remove it. */
export function goHome(ghost, home, { scale = .9 } = {}) {
  if (calm() || !home?.isConnected) { ghost.remove(); return; }
  const g = ghost.getBoundingClientRect(), h = home.getBoundingClientRect();
  const dx = h.left + h.width / 2 - (g.left + g.width / 2), dy = h.top + h.height / 2 - (g.top + g.height / 2);
  ghost.animate([
    { translate: '0px 0px', rotate: ghost.style.rotate || '0deg', scale: getComputedStyle(ghost).scale.replace('none', '1'), opacity: 1 },
    { translate: `${dx}px ${dy}px`, rotate: '0deg', scale, opacity: .2 },
  ], { duration: 360, easing: 'cubic-bezier(.3,.9,.4,1)', fill: 'forwards' }).finished.catch(() => {}).then(() => ghost.remove());
}

/** Screen centres of some elements; key → element through get(). Pair with glide() after the DOM changed. */
export function snap(keys, get = k => k) {
  const m = new Map();
  for (const k of keys) {
    const el = get(k);
    if (!el?.isConnected) continue;
    const r = el.getBoundingClientRect();
    m.set(k, [r.left + r.width / 2, r.top + r.height / 2]);
  }
  return m;
}
/** Animate elements from where snap() saw them to where they are now (FLIP). zoom: the scale they're drawn at. */
export function glide(before, get = k => k, { zoom = V().z, duration = 440 } = {}) {
  if (calm()) return;
  for (const [k, [x, y]] of before) {
    const el = get(k);
    if (!el?.isConnected) continue;
    const r = el.getBoundingClientRect();
    const dx = (x - r.left - r.width / 2) / zoom, dy = (y - r.top - r.height / 2) / zoom;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5) continue;
    el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }], { duration, easing: 'cubic-bezier(.2,1.2,.36,1)' });
  }
}
/** glide() for cards on the board, by id (they're drawn anew by renderBoard). */
export const snapCards = ids => snap(ids, id => els.get(id));
export const glideCards = before => glide(before, id => els.get(id));

/** Shrink an element into a screen point, spinning a little; resolves when it's gone. */
export function fly(el, [x, y], { zoom = 1, delay = 0, spin = 14 } = {}) {
  if (!el?.isConnected || calm()) return Promise.resolve();
  const r = el.getBoundingClientRect();
  const dx = (x - r.left - r.width / 2) / zoom, dy = (y - r.top - r.height / 2) / zoom;
  const a = el.animate([
    { translate: '0px 0px', scale: 1, rotate: '0deg', opacity: 1 },
    { translate: `${dx * .15}px ${dy * .15 - 14 / zoom}px`, scale: 1.05, rotate: `${-spin * .3}deg`, opacity: 1, offset: .25 },
    { translate: `${dx}px ${dy}px`, scale: .08, rotate: `${spin}deg`, opacity: 0 },
  ], { duration: 460, delay, easing: 'cubic-bezier(.55,0,.75,.2)', fill: 'forwards' });
  return a.finished.catch(() => {});
}

/** A happy bounce for something that just received cards (a board's icon, the Unsorted list). */
export function gulp(el) {
  if (!el || calm()) return;
  el.animate([{ scale: 1 }, { scale: 1.2, offset: .25 }, { scale: .88, offset: .5 }, { scale: 1.06, offset: .75 }, { scale: 1 }],
    { duration: 560, easing: 'ease-out' });
}

/** "No": a quick head shake. */
export function shake(el) {
  if (!el || calm()) return;
  el.animate([{ translate: '0px 0px' }, { translate: '-7px 0px' }, { translate: '6px 0px' }, { translate: '-4px 0px' }, { translate: '2px 0px' }, { translate: '0px 0px' }],
    { duration: 380, easing: 'ease-out' });
}

/** Grow a placeholder's height from nothing, so the cards below it slide out of the way. */
export function open(el) {
  if (!el || calm()) return;
  el.animate([{ height: '0px', marginBottom: '0px', opacity: 0 }, { height: el.style.height, opacity: 1 }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
}
