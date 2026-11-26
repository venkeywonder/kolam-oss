/*
 * The icon on a board's card (and on shortcuts to it): the default board glyph, any emoji, any Lucide icon
 * (src/vendor/lucide.json, loaded the first time one is needed), a logo from src/vendor/logos (the same ones as the
 * Icon element: logos, AWS) or an uploaded picture filling the tile.
 * On the card, data.emoji / data.icon (a Lucide name) / data.logo (a logo ref such as 'dev/docker' or 'aws/amazon-ec2',
 * with data.dark from the logo index) / data.asset (the uploaded picture); at most one is set.
 * The picker is showBoardIconPicker in cards/icon.js.
 */
import { esc } from '../core/util.js';
import { assetUrl } from '../core/api.js';
import { icon } from '../ui/icons.js';
import { isDark } from '../ui/theme.js';

/* ---------- logos (src/vendor/logos) ---------- */
export const LOGO_REF = /^(aws|dev|brand)\/[\w.-]+$/;
const LOGOS = new URL('../vendor/logos/', import.meta.url);
export const logosUrl = file => new URL(file, LOGOS).href;
/** A logo's SVG; dark = 2 means AWS drew a version for dark boards. */
const logoUrl = (ref, dark) => logosUrl(ref + (dark ? '.dark' : '') + '.svg');
/** An <img> of a logo for the current theme; dark = 1 is a black logo, inverted on a dark board. */
export const logoImg = (ref, dark, extra = '') =>
  `<img src="${esc(logoUrl(ref, dark === 2 && isDark()))}" alt="" draggable="false"${dark === 1 ? ' class="ic-inv"' : ''}${extra}>`;

/* ---------- Lucide icons ---------- */
let lucide = null, loading = null;
export function loadIcons() {
  return (loading ||= fetch(new URL('../vendor/lucide.json', import.meta.url))
    .then(r => { if (!r.ok) throw new Error('Icons couldn’t load'); return r.json(); })
    .then(d => (lucide = d.icons))
    .catch(e => { loading = null; throw e; }));
}
const lucideSvg = (name, s) => Object.hasOwn(lucide, name)
  ? `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${lucide[name][0]}</svg>`
  : icon('board', s);
/** Swap the placeholders drawn before the icons had loaded. */
function hydrate() {
  document.querySelectorAll('[data-lucide]').forEach(n => { n.outerHTML = lucideSvg(n.dataset.lucide, +n.dataset.size || 30); });
}
/** A Lucide icon by name; until the icons have loaded, a placeholder that fills in by itself. */
export function lucideIcon(name, size) {
  if (lucide) return lucideSvg(name, size);
  loadIcons().then(hydrate, () => {});
  return `<span class="bd-lucide" data-lucide="${esc(name)}" data-size="${size}" style="width:${size}px;height:${size}px"></span>`;
}
/** Lucide names matching a search (after loadIcons): named like it first, then ones only tagged with it. */
export function searchLucide(q) {
  const rank = n => !q ? 0 : n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : lucide[n][1].includes(q) ? 3 : -1;
  return Object.keys(lucide).filter(n => rank(n) >= 0).sort((a, b) => rank(a) - rank(b));
}

/** What goes inside a board tile for a board card's data. */
export function boardIconHtml(d, size = 30) {
  if (d?.asset) return `<img class="bd-img" src="${esc(assetUrl(d.asset))}" alt="" draggable="false">`;
  if (d?.logo && LOGO_REF.test(d.logo)) return `<span class="bd-logo">${logoImg(d.logo, d.dark)}</span>`;
  if (d?.icon) return lucideIcon(d.icon, size);
  if (d?.emoji) return `<span class="bd-emoji">${esc(d.emoji)}</span>`;
  return icon('board', size);
}

/* ---------- uploaded pictures ---------- */
// the tile is 72 × 72; a picture is cropped to a square and stored at 3× that, so it stays sharp on any screen and zoom
export const ICON_RULES = { types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'], maxMB: 5, min: 72, side: 216, ratio: 2 };
/** Check a picture against ICON_RULES and turn it into the square PNG stored for the tile; throws with what's wrong. */
export async function iconImage(file) {
  const R = ICON_RULES;
  // some systems leave a file's type blank; the extension says the same
  const ext = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' }[(file.name || '').split('.').pop().toLowerCase()];
  const type = file.type || ext || '';
  if (!R.types.includes(type)) throw new Error('Use a PNG, JPG, WebP, GIF or SVG image');
  if (file.size > R.maxMB * 1048576) throw new Error(`That image is larger than ${R.maxMB} MB`);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That image can’t be read')); i.src = url; });
    const svg = type === 'image/svg+xml';
    let w = img.naturalWidth, h = img.naturalHeight;
    if (svg && (!w || !h)) w = h = R.side;   // a drawing with no size of its own scales to anything
    if (!svg && Math.min(w, h) < R.min) throw new Error(`That image is ${w} × ${h} px; use one at least ${R.min} × ${R.min} px`);
    if (Math.max(w, h) / Math.min(w, h) > R.ratio) throw new Error(`That image is too ${w > h ? 'wide' : 'tall'}; use a square one (at most ${R.ratio}:1)`);
    const c = document.createElement('canvas'); c.width = c.height = R.side;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    if (svg) {
      // a vector picture keeps all of itself, centred in the square
      const k = R.side / Math.max(w, h);
      g.drawImage(img, (R.side - w * k) / 2, (R.side - h * k) / 2, w * k, h * k);
    } else {
      const s = Math.min(w, h);
      g.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, R.side, R.side);
    }
    return await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('That image can’t be read'))), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

