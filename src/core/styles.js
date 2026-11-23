/*
 * Styles for new elements: the last style you pick for a kind of element becomes the default for the next one.
 * Make an arrow curved and dashed, and new arrows come out curved and dashed; colour a note yellow, and new notes are
 * yellow. Kinds: "line", "board" (new boards' background and corners), "sketch" (pen colour), "table" (header row),
 * and every card type (its colour). Saved to your account (server/src/Styles.php), so every device uses the same ones;
 * templates, pasted and duplicated cards keep their own look.
 */
import { api } from './api.js';
import { toast } from '../ui/toast.js';
import { lineGeom } from '../canvas/lines.js';

let styles = {};
let timer = 0;

export function loadStyles(s) { styles = s && typeof s === 'object' ? s : {}; }

/** The remembered style of a kind of element ({} when none). */
export const styleOf = kind => styles[kind] || {};

export const hasStyles = () => Object.keys(styles).length > 0;

/** Remember style fields for a kind; null / undefined forgets that field. */
export function remember(kind, fields) {
  const next = { ...styles[kind] };
  for (const [k, v] of Object.entries(fields)) { if (v == null) delete next[k]; else next[k] = v; }
  if (JSON.stringify(next) === JSON.stringify(styles[kind] || {})) return;
  const first = !hasStyles();
  if (Object.keys(next).length) styles[kind] = next; else delete styles[kind];
  if (first) hintOnce();
  persist();
}

export function resetStyles() {
  styles = {};
  persist();
  toast('New elements use the standard style again');
}

function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => api('auth/me', { method: 'PATCH', body: { styles } }).catch(() => {}), 600);
}

// the first time a style is remembered, say so (once per browser), so a yellow new note isn't a surprise
function hintOnce() {
  try { if (localStorage.getItem('nk-style-hint')) return; localStorage.setItem('nk-style-hint', '1'); } catch { return; }
  setTimeout(() => toast('New elements of this kind will use this style. Reset it from the ⋯ menu.'), 400);
}

/** A new line with your line style; a curved one gets a bend once its length is known (curveNew). */
export function lineStyle() {
  const s = styleOf('line'), out = { arrow: s.arrow ?? true, color: s.color ?? null, bend: 0 };
  for (const k of ['route', 'arrowStart', 'head', 'width', 'dash']) if (s[k] != null) out[k] = s[k];
  return out;
}

/** A new curved line starts with a visible bend (a curve with no bend draws straight). */
export function curveNew(ln) {
  if (ln.route !== 'curved' || ln.bend) return;
  const G = lineGeom(ln);
  if (G) ln.bend = Math.round(Math.max(40, G.len * 0.2));
}
