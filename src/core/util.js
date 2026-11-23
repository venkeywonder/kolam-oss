/* ================= helpers ================= */
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
/**
 * Follow a pointer gesture. Moves are coalesced to one call per animation frame,
 * the last pending move is flushed before onUp, and listeners are always cleaned up.
 * While it runs, embedded frames (YouTube, Spotify...) ignore the pointer: a button let go over one would never reach
 * the page and leave the gesture stuck to the pointer. A mouse that moves with no button down ends the gesture too.
 */
let tracking = 0;
export function track(onMove, onUp) {
  let raf = 0, last = null, done = false;
  const run = () => { raf = 0; if (last) { const e = last; last = null; onMove(e); } };
  const mv = e => {
    if (e.pointerType === 'mouse' && e.buttons === 0) return up(e);
    last = e; if (!raf) raf = requestAnimationFrame(run);
  };
  const up = e => {
    if (done) return;
    done = true;
    removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
    if (!--tracking) document.documentElement.classList.remove('tracking');
    if (raf) { cancelAnimationFrame(raf); run(); }
    onUp?.(e);
  };
  if (!tracking++) document.documentElement.classList.add('tracking');
  addEventListener('pointermove', mv, { passive: true }); addEventListener('pointerup', up); addEventListener('pointercancel', up);
}
/** Run fn at most once per animation frame (latest arguments win). */
export function perFrame(fn) {
  let raf = 0, args = null;
  return (...a) => { args = a; if (!raf) raf = requestAnimationFrame(() => { raf = 0; fn(...args); }); };
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
