/*
 * Favorites: a floating bar at the bottom centre of the board with the tools you use most, so you needn't scroll the
 * left toolbar for them. Drag a tool from the toolbar onto the bar to add it (a copy: the toolbar keeps it), up to
 * MAX_FAVS. Drag a favorite along the bar to reorder it, or up into the "remove" zone that appears above the bar while
 * you drag one, to take it off. Click a favorite, or drag it onto the board, like any tool.
 * Saved to your account (users.favorites, server/src/Favorites.php), so every device shows the same bar. Until you
 * change it, the bar holds Text, Note, To-do, Link and Column, and a hint shows how to add more.
 * The drag itself is the toolbar's (toolbar.js toolDown): it calls favDragStart / favDragOver / favDrop.
 */
import { $, $$, esc } from '../core/util.js';
import { api } from '../core/api.js';
import { icon } from './icons.js';
import { tile } from './tool-icons.js';
import { calm, gulp, shake, snap, glide } from '../canvas/motion.js';
import { toast } from './toast.js';
import { drawMode } from '../cards/drawing.js';

export const MAX_FAVS = 8;
const START = ['text', 'note', 'todo', 'link', 'column'];
const SLOT_W = 44;   // a favorite's width (#favBar .tool), so the gap opened for a drop fits one exactly

const bar = $('#favBar'), zone = $('#favZone');
let list = null, hintEl = null;
let favs = [], tools = [], button = null, onDown = null, saveT = 0;
// the drag in progress: the tool, the favorite it came from (null: from the toolbar), the gap opened in the bar,
// where the pointer is ('bar' | 'zone' | null) and whether the tool is already a favorite
let drag = null;

const nameOf = t => tools.find(x => x[0] === t)?.[1] || t;
const valid = t => tools.some(x => x[0] === t);
const buttons = () => $$('.tool[data-tool]', list);
const near = (r, x, y, pad) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;

/* ---------- dock-style magnification on hover; off while dragging (rects must stay true then) or under
   prefers-reduced-motion ---------- */
function magnify(x) {
  if (calm() || bar.classList.contains('dragging')) return;
  const sigma = SLOT_W * .72;
  for (const el of buttons()) {
    const r = el.getBoundingClientRect();
    const d = x - (r.left + r.width / 2);
    el.style.setProperty('--mag', (1 + .5 * Math.exp(-(d * d) / (2 * sigma * sigma))).toFixed(3));
  }
}
function unmagnify() { for (const el of buttons()) el.style.removeProperty('--mag'); }

function render() {
  list.innerHTML = favs.map(t => button(t, `${nameOf(t)}: click, or drag onto the board. Drag it up out of the bar to remove it.`)).join('');
  if (drawMode) $('.tool[data-tool="draw"]', list)?.classList.add('active');
  bar.classList.toggle('empty', !favs.length);
}

function persist() {
  hideHint();
  clearTimeout(saveT);
  saveT = setTimeout(() => api('auth/me', { method: 'PATCH', body: { favorites: favs } }).catch(() => toast('Couldn’t save your favorites')), 400);
}

/** After sign-in: the account's favorites (null: never changed, so the starting bar and the hint). */
export function loadFavorites(saved) {
  favs = Array.isArray(saved) ? saved.filter(valid).slice(0, MAX_FAVS) : START.slice();
  render();
  bar.hidden = false;
  document.body.classList.add('has-favbar');
  if (!Array.isArray(saved)) showHint();
}

/* ---------- the hint for people who haven't used the bar yet ---------- */
function showHint() {
  hintEl = document.createElement('div');
  hintEl.className = 'fav-hint';
  hintEl.setAttribute('role', 'note');
  hintEl.innerHTML = `<div class="fh-demo" aria-hidden="true"><span class="fh-tile">${tile('todo')}</span><span class="fh-slot"></span></div>` +
    `<p><b>Keep your tools handy</b>Drag any tool from the left onto this bar to make it a favorite. Drag one up out of the bar to remove it.</p>` +
    `<button class="fh-x" type="button" title="Got it" aria-label="Got it">${icon('close', 14)}</button>`;
  bar.appendChild(hintEl);
  hintEl.querySelector('.fh-x').addEventListener('click', () => persist());
}
function hideHint() {
  const h = hintEl; if (!h) return;
  hintEl = null;
  if (calm()) return h.remove();
  h.animate([{ opacity: 1, scale: 1 }, { opacity: 0, scale: .85, translate: '0 8px' }], { duration: 200, easing: 'ease-in', fill: 'forwards' })
    .finished.catch(() => {}).then(() => h.remove());
}

/* ---------- the gap that opens where a dragged tool would land ---------- */
/** Where a tool let go at x would land. Buttons are compared where they'd be without the open gap (the bar, centred,
   grows by a gap: those before it move left by half a gap, those after it right by half), so the gap doesn't jump. */
function indexAt(x) {
  const half = (SLOT_W + 2) / 2;
  let i = 0, past = false;
  for (const el of list.children) {
    if (el === drag?.slot) { past = true; continue; }
    if (!el.matches('.tool[data-tool]')) continue;
    const r = el.getBoundingClientRect();
    if (x > r.left + r.width / 2 + (drag?.slot ? (past ? -half : half) : 0)) i++;
  }
  return i;
}
function placeSlot(i) {
  if (drag.slot && drag.idx === i) return;
  const bs = buttons(), before = snap(bs);
  const fresh = !drag.slot;
  if (fresh) { drag.slot = document.createElement('span'); drag.slot.className = 'fav-slot'; }
  list.insertBefore(drag.slot, bs[i] || null);
  drag.idx = i;
  if (fresh && !calm()) drag.slot.animate([{ width: '0px' }, { width: SLOT_W + 'px' }], { duration: 220, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  else glide(before, k => k, { zoom: 1, duration: 260 });
}
function closeSlot() {
  const s = drag?.slot; if (!s) return;
  drag.slot = null; drag.idx = -1;
  if (calm()) return s.remove();
  s.animate([{ width: SLOT_W + 'px' }, { width: '0px' }], { duration: 200, easing: 'ease-out' }).finished.catch(() => {}).then(() => s.remove());
}

/* ---------- called by the toolbar's drag (toolbar.js toolDown) ---------- */
/**
 * A drag began: of a toolbar tool (src null) or of a favorite (src: its button). A dragged favorite stays in its
 * place, faded, and nothing on the bar moves until it's dropped; then the bar rearranges.
 */
export function favDragStart(tool, src) {
  if (bar.hidden) return;
  unmagnify();
  drag = { tool, src, slot: null, idx: -1, over: null, has: !src && favs.includes(tool) };
  bar.classList.add('dragging');
  bar.classList.toggle('from-tools', !src);
  if (src) {
    src.classList.add('lifted');
    zone.hidden = false;
    requestAnimationFrame(() => zone.classList.add('show'));
  }
}

/** The pointer moved: returns where it is ('bar', 'zone' or null); for a toolbar tool, opens or moves the gap. */
export function favDragOver(ev) {
  if (!drag) return null;
  const x = ev.clientX, y = ev.clientY;
  const over = drag.src && near(zone.getBoundingClientRect(), x, y, 10) ? 'zone'
    : near(bar.getBoundingClientRect(), x, y, 18) ? 'bar' : null;
  if (over !== drag.over) {
    zone.classList.toggle('hot', over === 'zone');
    if (!drag.src) {
      bar.classList.toggle('drop-on', over === 'bar');
      bar.classList.toggle('full', over === 'bar' && !drag.has && favs.length >= MAX_FAVS);
      if (over === 'bar' && drag.has) {
        const b = btnOf(drag.tool);
        b?.classList.remove('hey'); void b?.offsetWidth; b?.classList.add('hey');
      }
    }
    drag.over = over;
  }
  if (!drag.src) {
    if (over === 'bar' && !drag.has && favs.length < MAX_FAVS) placeSlot(indexAt(x));
    else if (over !== 'bar') closeSlot();
  }
  return over;
}

/**
 * The drag ended. Adds, reorders or removes the favorite and returns true when it was dropped on the bar or the
 * remove zone; otherwise puts a dragged favorite back and returns false (the toolbar then makes the card).
 */
export function favDrop(ev, ghost) {
  if (!drag) return false;
  const over = favDragOver(ev), d = drag;
  drag = null;
  bar.classList.remove('dragging', 'from-tools', 'drop-on', 'full');
  zone.classList.remove('show', 'hot');
  setTimeout(() => { if (!drag) zone.hidden = true; }, 250);
  $$('.hey', list).forEach(b => b.classList.remove('hey'));

  if (d.src) {
    if (over === 'zone') { remove(d.tool, ghost); return true; }
    if (over === 'bar') { reorder(d.tool, ghost, ev.clientX); return true; }
    d.src.classList.remove('lifted');
    return false;
  }
  if (over !== 'bar') { d.slot?.remove(); return false; }
  if (d.has) {
    const b = btnOf(d.tool);
    flyInto(ghost, b).then(() => gulp(b));
    return true;
  }
  if (favs.length >= MAX_FAVS) {
    shake(bar);
    toast(`You can keep up to ${MAX_FAVS} favorites. Drag one up out of the bar to make room.`);
    fadeAway(ghost);
    return true;
  }
  const i = d.slot ? buttons().filter(b => d.slot.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING).length : favs.length;
  const next = favs.slice();
  next.splice(i, 0, d.tool);
  flyInto(ghost, d.slot || list).then(() => {
    d.slot?.remove();
    favs = next; render();
    celebrate(btnOf(d.tool));
    persist();
  });
  return true;
}

/* ---------- reordering, removing ---------- */
const btnOf = t => $(`.tool[data-tool="${t}"]`, list);
const centre = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };

/** A favorite dropped on the bar: it goes where it was let go, and the others slide to make room. */
function reorder(tool, ghost, x) {
  let i = 0;
  for (const b of buttons()) if (b.dataset.tool !== tool && x > centre(b)[0]) i++;
  const next = favs.filter(t => t !== tool);
  next.splice(i, 0, tool);
  const before = snap(favs, btnOf);
  before.set(tool, centre(ghost.firstElementChild || ghost));   // the moved one glides in from where it was dropped
  ghost.remove();
  const changed = next.join() !== favs.join();
  favs = next; render();
  glide(before, btnOf, { zoom: 1, duration: 380 });
  if (changed) persist();
}

/** A favorite dropped on the remove zone: it goes up in smoke and the others close the gap. */
function remove(tool, ghost) {
  const at = favs.indexOf(tool);
  favs = favs.filter(t => t !== tool);
  const before = snap(favs, btnOf);
  render();
  glide(before, btnOf, { zoom: 1, duration: 320 });
  poof(ghost);
  persist();
  toast(`${nameOf(tool)} removed from favorites`, 'Undo', () => {
    if (favs.includes(tool) || favs.length >= MAX_FAVS) return;
    favs.splice(Math.min(at, favs.length), 0, tool);
    render(); celebrate(btnOf(tool)); persist();
  });
}

/* ---------- motion. The ghost's outer element only moves (by its transform); scale and fade go on its inner
   .tg-in, so they pivot on the ghost's own centre. ---------- */
/** Float the drag ghost into a place on the bar along a small arc, shrinking to the button's size. */
function flyInto(ghost, el) {
  if (calm() || !el?.isConnected) { ghost.remove(); return Promise.resolve(); }
  const inner = ghost.firstElementChild || ghost;
  const [gx, gy] = centre(inner), [tx, ty] = centre(el);
  const dx = tx - gx, dy = ty - gy;
  const opts = { duration: 420, easing: 'cubic-bezier(.3,.7,.35,1)', fill: 'forwards' };
  ghost.animate([{ translate: '0px 0px' }, { translate: `${dx * .55}px ${dy * .55 - 22}px`, offset: .55 }, { translate: `${dx}px ${dy}px` }], opts);
  return inner.animate([{ scale: 1, opacity: 1 }, { scale: .8, opacity: 1, offset: .7 }, { scale: .55, opacity: 0 }], opts)
    .finished.catch(() => {}).then(() => ghost.remove());
}
/** The ghost of a tool that can't be added shrinks away where it is. */
function fadeAway(ghost) {
  if (calm()) return ghost.remove();
  (ghost.firstElementChild || ghost).animate([{ scale: 1, opacity: 1 }, { scale: .5, opacity: 0 }], { duration: 220, easing: 'ease-in', fill: 'forwards' })
    .finished.catch(() => {}).then(() => ghost.remove());
}
/** A new favorite: it springs into its place with a wiggle, sparkles fly off it and the bar bounces. */
function celebrate(b) {
  if (!b || calm()) return;
  b.animate([
    { scale: .4, rotate: '-20deg' },
    { scale: 1.22, rotate: '9deg', offset: .45 },
    { scale: .94, rotate: '-4deg', offset: .7 },
    { scale: 1, rotate: '0deg' },
  ], { duration: 560, easing: 'cubic-bezier(.3,.7,.4,1)' });
  bar.animate([{ scale: 1 }, { scale: 1.04, offset: .3 }, { scale: .99, offset: .6 }, { scale: 1 }], { duration: 420, easing: 'ease-out' });
  const [x, y] = centre(b);
  sparks(x, y - 6);
}
/** A removed favorite: a quick swell and vanish, inside a puff of smoke. */
function poof(ghost) {
  const inner = ghost.firstElementChild || ghost;
  const [x, y] = centre(inner);
  if (calm()) return ghost.remove();
  smoke(x, y);
  inner.animate([{ scale: 1, opacity: 1 }, { scale: 1.12, opacity: 1, offset: .3 }, { scale: .3, opacity: 0 }],
    { duration: 240, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {}).then(() => ghost.remove());
}
/** Particles leaving a screen point; only transform and opacity animate, so they stay smooth. */
function particle(cls, x, y, size, frames, duration) {
  const p = document.createElement('i');
  p.className = 'fav-particle ' + cls;
  Object.assign(p.style, { left: x - size / 2 + 'px', top: y - size / 2 + 'px', width: size + 'px', height: size + 'px' });
  document.body.appendChild(p);
  p.animate(frames, { duration, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }).finished.catch(() => {}).then(() => p.remove());
  return p;
}
function sparks(x, y) {
  const colors = ['#f4511c', '#f6b100', '#2fae6a', '#5f79f5', '#e05a78', '#2f7d84'];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.random() * .4, d = 30 + Math.random() * 24;
    particle('spark', x, y, 5 + Math.random() * 4, [
      { translate: '0px 0px', scale: 1, opacity: 1, rotate: '0deg' },
      { translate: `${Math.cos(a) * d}px ${Math.sin(a) * d}px`, scale: .3, opacity: 0, rotate: `${(Math.random() - .5) * 240}deg` },
    ], 520 + Math.random() * 200).style.background = colors[i % colors.length];
  }
}
/** Soft grey clouds that billow out and rise from where the favorite was let go. */
function smoke(x, y) {
  particle('puff', x, y, 46, [{ scale: .3, opacity: .9 }, { scale: 1.5, opacity: 0, translate: '0px -12px' }], 520);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.random() * .6, d = 22 + Math.random() * 16;
    particle('puff', x + Math.cos(a) * 8, y + Math.sin(a) * 6, 18 + Math.random() * 12, [
      { translate: '0px 0px', scale: .4, opacity: .85 },
      { translate: `${Math.cos(a) * d}px ${Math.sin(a) * d - 16}px`, scale: 1.35, opacity: 0 },
    ], 560 + Math.random() * 220);
  }
}

/** tools: the toolbar's [id, name] list; button(tool, title): a tool button's HTML; down: the toolbar's pointerdown. */
export function init({ tools: t, button: b, down }) {
  tools = t.filter(x => Array.isArray(x)); button = b; onDown = down;
  bar.innerHTML = `<div class="fav-items"></div><div class="fav-empty">${icon('star', 16)}<span>Drag tools here</span></div>` +
    `<div class="fav-drop" aria-hidden="true">${icon('star', 14)}<span>Add to favorites</span></div>`;
  zone.innerHTML = `${icon('trash', 18)}<span>Drop here to remove</span>`;
  list = $('.fav-items', bar);
  bar.addEventListener('pointerdown', e => { if (e.target.closest('.tool[data-tool]')) onDown(e); });
  bar.addEventListener('pointermove', e => magnify(e.clientX));
  bar.addEventListener('pointerleave', unmagnify);
  bar.addEventListener('click', e => {
    const b = e.target.closest('.tool[data-tool]');
    if (!b || calm()) return;
    b.classList.remove('fav-bounce'); void b.offsetWidth; b.classList.add('fav-bounce');
    b.addEventListener('animationend', () => b.classList.remove('fav-bounce'), { once: true });
  });
}
