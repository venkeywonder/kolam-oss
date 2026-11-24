/*
 * Text elements: words straight on the board, with no card around them. Their look lives in data:
 *   font (sans / serif / mono / hand), size (px), b / i / u (bold, italic, underline for the whole element),
 *   ink (a custom text colour, #rrggbb; otherwise the card's colour key, otherwise the theme's ink),
 *   bg (a fill: a palette key, which follows light and dark, or #rrggbb).
 * Alignment is the card's `align` like any text card (cards/align.js). The last look you pick is the one new text
 * gets (core/styles.js, kind "text").
 */
import { $$ } from '../core/util.js';
import { PALETTE, pal } from '../core/palette.js';
import { S, checkpoint, els, save } from '../core/store.js';
import { remember, styleOf } from '../core/styles.js';
import { renderLines } from '../canvas/lines.js';
import { isDark } from '../ui/theme.js';

export const FONTS = [
  ['sans', 'Sans', 'var(--font)'],
  ['serif', 'Serif', "'Source Serif 4',Georgia,serif"],
  ['mono', 'Mono', "ui-monospace,'SF Mono',Menlo,Consolas,monospace"],
  ['hand', 'Hand', "'Caveat','Bradley Hand','Segoe Print',cursive"],
];
export const SIZES = [12, 14, 16, 20, 24, 32, 40, 48, 64, 96];
export const SIZE_MIN = 8, SIZE_MAX = 200, SIZE_USUAL = 20;
const STYLE_KEYS = ['font', 'size', 'b', 'i', 'u', 'ink', 'bg'];

const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
export const sizeOf = d => Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(+d?.size || SIZE_USUAL)));
/** The fill colour on screen, or null for none. */
export function fillOf(d) {
  if (isHex(d?.bg)) return d.bg;
  const p = d?.bg && PALETTE.find(x => x.k === d.bg);
  return p ? (isDark() ? p.dbg : p.bg) : null;
}
/** The text colour on screen, or null for the theme's own (or, on a fill, whichever of black and white reads). */
export function inkOf(it) {
  if (isHex(it.data?.ink)) return it.data.ink;
  if (it.color) return pal(it.color).line;
  const f = fillOf(it.data);
  if (!f) return null;
  const n = parseInt(f.slice(1), 16), l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.6 ? '#1f1f24' : '#f3f3f5';
}

/** The look new text starts with: the last one picked. */
export function newTextData() {
  const s = styleOf('text'), d = { html: '' };
  for (const k of STYLE_KEYS) if (s[k] != null) d[k] = s[k];
  return d;
}

/** Apply an element's look to its element (no rebuild, so typing and the caret are untouched). */
export function paintText(el, it) {
  const d = it.data || {}, s = el.style;
  s.setProperty('--tx-font', (FONTS.find(f => f[0] === d.font) || FONTS[0])[2]);
  s.setProperty('--tx-size', sizeOf(d) + 'px');
  const ink = inkOf(it), fill = fillOf(d);
  if (ink) s.setProperty('--tx-ink', ink); else s.removeProperty('--tx-ink');
  if (fill) s.setProperty('--tx-bg', fill); else s.removeProperty('--tx-bg');
  el.classList.toggle('tx-fill', !!fill);
  el.classList.toggle('tx-b', !!d.b); el.classList.toggle('tx-i', !!d.i); el.classList.toggle('tx-u', !!d.u);
  // no width of its own: as wide as its longest line (up to a limit), until someone resizes it
  if (!it.w && !it.col) { s.width = 'max-content'; s.maxWidth = '900px'; }
}

/** Selected text elements that can be restyled. */
export const textItems = ids => [...ids].map(id => S.items[id]).filter(it => it?.type === 'text' && !it.locked);

/**
 * Change the look of these text elements. patch keys: STYLE_KEYS, plus color (a palette key for the text colour);
 * null removes a key. undo=false skips the undo step (several changes from one slider or colour well).
 */
export function setTextStyle(items, patch, undo = true) {
  if (!items.length) return;
  if (undo) checkpoint();
  for (const it of items) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'color') it.color = v;
      else if (v == null || v === false) delete it.data[k];
      else it.data[k] = v;
    }
    const el = els.get(it.id); if (el) paintText(el, it);
  }
  remember('text', Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === false ? null : v])));
  save(); renderLines();
}

/* ---------- the toolbar's popovers for text (ui/toolbar.js opens them) ---------- */
const on = c => (c ? ' class="on"' : '');
const paletteSwatches = (key, cur, color) => PALETTE.filter(p => p.k).map(p =>
  `<button data-${key}="${p.k}" title="${p.name}" style="--c:${color(p)}"${on(cur === p.k)}></button>`).join('');

export function textPopHtml(act, it) {
  const d = it.data;
  if (act === 'tfont') return '<div class="tp-head">Font</div><div class="tx-fonts">' +
    FONTS.map(([k, label, fam]) => `<button data-font="${k}" style="font-family:${fam}"${on((d.font || 'sans') === k)}><b>Aa</b><span>${label}</span></button>`).join('') +
    '</div><div class="tp-head">Style</div><div class="tx-toggles">' +
    [['b', '<b>B</b>', 'Bold'], ['i', '<i>I</i>', 'Italic'], ['u', '<u>U</u>', 'Underline']].map(([k, g, t]) => `<button data-flag="${k}" title="${t}"${on(d[k])}>${g}</button>`).join('') + '</div>';
  if (act === 'tsize') return '<div class="tp-head">Size</div>' +
    `<div class="tx-step"><button data-step="-1" title="Smaller">−</button><input type="number" data-size-in min="${SIZE_MIN}" max="${SIZE_MAX}" value="${sizeOf(d)}" aria-label="Size in pixels"><span>px</span><button data-step="1" title="Larger">+</button></div>` +
    `<div class="tx-sizes">${SIZES.map(n => `<button data-size="${n}"${on(sizeOf(d) === n)}>${n}</button>`).join('')}</div>`;
  if (act === 'tcolor') return '<div class="tp-head">Text colour</div><div class="tx-swatches">' +
    `<button data-ink-auto title="Automatic (follows light and dark)" class="tx-auto${!it.color && !isHex(d.ink) ? ' on' : ''}">A</button>` +
    paletteSwatches('ink-key', isHex(d.ink) ? null : it.color, p => p.line) +
    `<label class="tx-custom${isHex(d.ink) ? ' on' : ''}" title="Any colour" style="--c:${isHex(d.ink) ? d.ink : 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)'}"><input type="color" data-ink-in value="${isHex(d.ink) ? d.ink : '#3478e5'}"></label></div>`;
  if (act === 'tfill') return '<div class="tp-head">Background</div><div class="tx-swatches">' +
    `<button data-bg-none title="None" class="tx-none${d.bg ? '' : ' on'}"></button>` +
    paletteSwatches('bg-key', d.bg, p => (isDark() ? p.dbg : p.bg)) +
    `<label class="tx-custom${isHex(d.bg) ? ' on' : ''}" title="Any colour" style="--c:${isHex(d.bg) ? d.bg : 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)'}"><input type="color" data-bg-in value="${isHex(d.bg) ? d.bg : '#fff3b8'}"></label></div>`;
  return '';
}

/** Wire a text popover: changes apply to every selected text element as you pick. */
export function mountTextPop(el, act, items, onChange) {
  let marked = false;
  const live = patch => { if (!marked) { checkpoint(); marked = true; } setTextStyle(items, patch, false); onChange?.(); };
  const pick = patch => { setTextStyle(items, patch); marked = false; refresh(); onChange?.(); };
  const refresh = () => { const fresh = document.createElement('div'); fresh.innerHTML = textPopHtml(act, items[0]); keepInputs(el, fresh); };
  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if (d.font) pick({ font: d.font === 'sans' ? null : d.font });
    else if (d.flag) pick({ [d.flag]: !items[0].data[d.flag] });
    else if (d.size) pick({ size: +d.size });
    else if (d.step) {
      const now = sizeOf(items[0].data), next = +d.step > 0 ? SIZES.find(n => n > now) ?? Math.min(SIZE_MAX, now + 16) : [...SIZES].reverse().find(n => n < now) ?? Math.max(SIZE_MIN, now - 2);
      pick({ size: next });
    }
    else if ('inkAuto' in d) pick({ color: null, ink: null });
    else if (d.inkKey) pick({ color: d.inkKey, ink: null });
    else if ('bgNone' in d) pick({ bg: null });
    else if (d.bgKey) pick({ bg: d.bgKey });
  });
  el.addEventListener('input', e => {
    const t = e.target;
    if (t.matches('[data-size-in]')) { const v = Math.round(+t.value); if (v >= SIZE_MIN && v <= SIZE_MAX) live({ size: v }); }
    else if (t.matches('[data-ink-in]')) { live({ ink: t.value }); t.parentNode.style.setProperty('--c', t.value); }
    else if (t.matches('[data-bg-in]')) { live({ bg: t.value }); t.parentNode.style.setProperty('--c', t.value); }
  });
  el.addEventListener('change', () => { marked = false; refresh(); });
}
// redraw the buttons' "on" states without replacing an input that's in use
function keepInputs(el, fresh) {
  const now = $$('button,label', el), next = $$('button,label', fresh);
  now.forEach((n, i) => { if (next[i]) n.className = next[i].className; });
  const inp = el.querySelector('[data-size-in]'), v = fresh.querySelector('[data-size-in]');
  if (inp && v && document.activeElement !== inp) inp.value = v.value;
}
