/*
 * The icon on a board's card (and on shortcuts to it): the default board glyph, any emoji, any Lucide icon
 * (src/vendor/lucide.json, loaded the first time one is needed) or an uploaded picture filling the tile.
 * On the card, data.emoji / data.icon (a Lucide name) / data.asset (the uploaded picture); at most one is set.
 */
import { $, esc } from '../core/util.js';
import { assetUrl } from '../core/api.js';
import { icon } from '../ui/icons.js';
import { ctxmenu } from '../core/dom.js';
import { S, checkpoint, els, putAsset, save } from '../core/store.js';
import { rebuildCard } from '../canvas/render.js';
import { hideMenu } from '../ui/menus.js';
import { toast } from '../ui/toast.js';

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

/* ---------- the picker ---------- */
const EMOJI = ['🎨', '💡', '📚', '🎬', '✏️', '📷', '🎵', '🗺️', '🧠', '📅', '🚀', '⭐', '💼', '🏠', '🍳', '✈️', '🎮', '🌱',
  '🛍️', '💬', '📈', '🔬', '❤️', '🎉', '📝', '📌', '🗂️', '🧩', '🎯', '🔥', '🌍', '☕', '🏋️', '🧘', '💰', '🛠️',
  '🎁', '🐾', '🌸', '🌙', '☀️', '⚡', '🔒', '👥', '🎓', '🩺', '🧪', '🏆'];
const ICON_LIMIT = 168;
const oneEmoji = v => {
  const g = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v.trim())].map(x => x.segment);
  return g.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g[0]) ? g[0] : null;
};

function setIcon(id, patch) {
  const it = S.items[id]; if (!it) return;
  checkpoint();
  delete it.data.emoji; delete it.data.icon; delete it.data.asset;
  Object.assign(it.data, patch);
  save(); rebuildCard(id);
  // shortcuts to the board on screen show its icon too
  for (const s of Object.values(S.items)) if (s.type === 'shortcut' && s.data.target === it.data.target && els.get(s.id)) rebuildCard(s.id);
}

export function showIconPicker(id, x, y) {
  const d = S.items[id]?.data || {};
  const R = ICON_RULES, mac = /Mac/.test(navigator.platform);
  ctxmenu.innerHTML = `<div class="bip">
    <div class="mhead">Board icon</div>
    <div class="bip-tabs" role="tablist">${['emoji', 'icons', 'image'].map(t => `<button role="tab" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <div class="bip-pane" data-pane="emoji">
      <input class="bip-field" data-emoji-in placeholder="Type or paste any emoji" maxlength="32" spellcheck="false" aria-label="Any emoji">
      <div class="bip-note">${mac ? 'Press ⌃⌘Space for every emoji' : 'Press Win + . for every emoji'}</div>
      <div class="memoji">${EMOJI.map(e => `<button data-em="${e}">${e}</button>`).join('')}</div>
    </div>
    <div class="bip-pane" data-pane="icons" hidden>
      <input class="bip-field" type="search" data-icon-q placeholder="Search icons" spellcheck="false" aria-label="Search icons">
      <div class="bip-icons"><div class="bip-note">Loading icons…</div></div>
    </div>
    <div class="bip-pane" data-pane="image" hidden>
      <button class="bip-up" data-upload>${icon('upload', 22)}<b>Upload an image</b><span>PNG, JPG, WebP, GIF or SVG · up to ${R.maxMB} MB</span></button>
      <div class="bip-note">At least ${R.min} × ${R.min} px and no more than ${R.ratio}:1. It fills the ${R.min} × ${R.min} tile: cropped to a square and saved at ${R.side} × ${R.side} px.</div>
      <div class="bip-err" role="alert" hidden></div>
      <input type="file" accept="${R.types.join(',')}" hidden data-file>
    </div>
    <div class="msep"></div>
    <button class="mi" data-reset>${icon('board', 16)}<span>Default icon</span></button>
  </div>`;
  ctxmenu.hidden = false;
  ctxmenu.style.left = Math.max(8, Math.min(x, innerWidth - ctxmenu.offsetWidth - 8)) + 'px';
  ctxmenu.style.top = Math.max(8, Math.min(y, innerHeight - ctxmenu.offsetHeight - 8)) + 'px';

  const pane = t => {
    ctxmenu.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
    ctxmenu.querySelectorAll('[data-pane]').forEach(p => (p.hidden = p.dataset.pane !== t));
    if (t === 'icons') { showIcons(); $('[data-icon-q]', ctxmenu).focus(); }
    if (t === 'emoji') $('[data-emoji-in]', ctxmenu).focus();
  };
  const grid = $('.bip-icons', ctxmenu);
  const showIcons = () => loadIcons().then(() => {
    const names = searchLucide($('[data-icon-q]', ctxmenu).value.trim().toLowerCase());
    grid.innerHTML = names.slice(0, ICON_LIMIT).map(n => `<button data-ic="${n}" title="${n}" class="${n === d.icon ? 'on' : ''}">${lucideSvg(n, 20)}</button>`).join('') +
      (names.length ? (names.length > ICON_LIMIT ? `<div class="bip-note">${ICON_LIMIT} of ${names.length}; search to find more</div>` : '') : '<div class="bip-note">No icons match</div>');
  }, () => { grid.innerHTML = '<div class="bip-note">Icons couldn’t load. Check your connection.</div>'; });

  const emojiIn = $('[data-emoji-in]', ctxmenu);
  emojiIn.addEventListener('input', () => { const e = oneEmoji(emojiIn.value); if (e) { hideMenu(); setIcon(id, { emoji: e }); } });
  emojiIn.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const em = oneEmoji(emojiIn.value);
    if (em) { hideMenu(); setIcon(id, { emoji: em }); } else toast('Type or paste one emoji');
  });
  $('[data-icon-q]', ctxmenu).addEventListener('input', showIcons);

  const err = $('.bip-err', ctxmenu), file = $('[data-file]', ctxmenu), up = $('[data-upload]', ctxmenu);
  file.addEventListener('change', async () => {
    const f = file.files[0]; file.value = ''; if (!f) return;
    err.hidden = true; up.disabled = true; up.querySelector('b').textContent = 'Uploading…';
    try {
      const asset = await putAsset(await iconImage(f), 'board-icon.png');
      hideMenu(); setIcon(id, { asset });
    } catch (e) {
      err.textContent = e.message || 'Upload failed'; err.hidden = false;
      if (ctxmenu.hidden) toast(`Couldn’t use that image: ${e.message}`);
    } finally { up.disabled = false; up.querySelector('b').textContent = 'Upload an image'; }
  });

  ctxmenu.onclick = e => {
    const t = e.target.closest('[data-tab]'); if (t) return pane(t.dataset.tab);
    if (e.target.closest('[data-upload]')) return file.click();
    const em = e.target.closest('[data-em]'), ic = e.target.closest('[data-ic]');
    if (em) { hideMenu(); setIcon(id, { emoji: em.dataset.em }); }
    else if (ic) { hideMenu(); setIcon(id, { icon: ic.dataset.ic }); }
    else if (e.target.closest('[data-reset]')) { hideMenu(); setIcon(id, {}); }
  };
  pane(d.asset ? 'image' : d.icon ? 'icons' : 'emoji');
}
