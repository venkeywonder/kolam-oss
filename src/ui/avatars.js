/*
 * Profile pictures: a person's initial on a coloured circle, or their picture (one of the illustrations in
 * src/assets/avatars/, or one they uploaded; see server/src/Avatars.php). Other people's pictures are looked up in
 * batches the first time they're drawn; the initials already on screen turn into the picture when it arrives.
 */
import { esc } from '../core/util.js';
import { api, assetUrl } from '../core/api.js';
import { user } from '../core/store.js';

/** How many illustrations there are: src/assets/avatars/01.webp … */
export const PRESETS = 24;
export const presetValue = n => 'p:' + String(n).padStart(2, '0');

/** A stable colour (0–359) for someone's initials. */
export const hue = id => [...(id || '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
export const initial = name => (String(name || '?').trim()[0] || '?').toUpperCase();

/** The image URL for an avatar value ("p:07" or an asset id), or null for initials. */
export function avatarSrc(v) {
  if (typeof v !== 'string') return null;
  if (/^p:\d\d$/.test(v)) return new URL(`src/assets/avatars/${v.slice(2)}.webp`, document.baseURI).href;
  return v.startsWith('a_') ? assetUrl(v) : null;
}

const known = new Map();   // user id => avatar value, null for initials
let queue = new Set(), timer = 0;
const valueOf = id => (id === user?.id ? user.avatar ?? null : known.get(id) ?? null);

function want(id) {
  if (!user || id === user.id || known.has(id) || !/^u_[a-f0-9]{20}$/.test(id)) return;
  queue.add(id);
  timer ||= setTimeout(lookup, 30);
}

async function lookup() {
  timer = 0;
  const ids = [...queue]; queue = new Set();
  for (const id of ids) known.set(id, null);   // asked once per page load; a failed lookup leaves the initials
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids.slice(i, i + 100);
    let got;
    try { got = await api('avatars?ids=' + part.join(',')); } catch { continue; }
    for (const id of part) if (got[id]) { known.set(id, got[id]); fill(id); }
  }
}

const img = src => `<img src="${esc(src)}" alt="" draggable="false" decoding="async">`;

function show(el, v) {
  const src = avatarSrc(v);
  el.classList.toggle('av-pic', !!src);
  if (src) el.innerHTML = img(src); else el.textContent = el.dataset.l;
}
const fill = id => document.querySelectorAll(`[data-av="${CSS.escape(id)}"]`).forEach(el => show(el, valueOf(id)));

/**
 * Someone's avatar as HTML: a span of class `cls` with their initial, or their picture. id is their user id (none for
 * guests: always initials); key seeds the initials' colour; attrs is extra markup for the span (title, aria-…).
 */
export function avatarHtml(id, name, { cls = 'av', key = id || name, attrs = '' } = {}) {
  const l = initial(name), src = id ? avatarSrc(valueOf(id)) : null;
  if (id) want(id);
  return `<span class="${cls}${src ? ' av-pic' : ''}"${id ? ` data-av="${esc(id)}"` : ''} data-l="${esc(l)}" style="--h:${hue(key)}"${attrs ? ' ' + attrs : ''}>${src ? img(src) : esc(l)}</span>`;
}

/** The same for an element that's already on the page (the account button in the top bar). */
export function paintAvatarEl(el, id, name) {
  el.dataset.av = id;
  el.dataset.l = initial(name);
  want(id);
  show(el, valueOf(id));
}

/** Your own picture changed (user.avatar): redraw it everywhere it shows. */
export function avatarChanged() {
  if (user) fill(user.id);
}

// a picture that doesn't load (removed, offline) falls back to the initials
document.addEventListener('error', e => {
  const el = e.target.parentElement;
  if (e.target.tagName === 'IMG' && el?.classList.contains('av-pic')) { el.classList.remove('av-pic'); el.textContent = el.dataset.l; }
}, true);
