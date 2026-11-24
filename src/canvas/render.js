import { esc } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { pal } from '../core/palette.js';
import { canvas, crumbsEl, emptyHint, itemsLayer } from '../core/dom.js';
import { S, RO, boardHash, cur, editingId, els, sel, selLine, setEditingId, setSelLine, updUndo, updateRO } from '../core/store.js';
import { applyView } from './viewport.js';
import { itemsOf } from '../core/model.js';
import { TYPES, noBg } from '../cards/types.js';
import { renderLines } from './lines.js';
import { refreshSel, selectOnly } from './selection.js';
import { cardDbl, cardDown } from './drag.js';
import { positionBars } from '../ui/floatbars.js';
import { resizeHandles } from './resize.js';
import { boardCorners } from '../cards/corners.js';
import { applyAlign } from '../cards/align.js';
import { showItemMenu } from '../ui/menus.js';
import { isDark } from '../ui/theme.js';
import { updateBadges } from '../ui/drawer.js';
import { paintEditing, paintPresence } from '../ui/presence.js';
import { badgeHtml, mountBadge, paintButton } from '../features/comments.js';
import { drawOrder } from '../cards/group.js';

// one connection dot in the middle of each side; dragging one starts a line pinned to that point
const CONN_DOTS = ['top', 'right', 'bottom', 'left'].map(s => `<div class="conn" data-side="${s}" title="Drag to connect"></div>`).join('');

/* ================= rendering ================= */
export function render() { updateRO(); renderCrumbs(); renderBoard(); updUndo(); paintPresence(); paintButton(); }
export function renderCrumbs() {
  const chain = []; let b = S.boards[cur], n = 0;
  while (b && n++ < 50) { chain.unshift(b); b = S.boards[b.parent]; }
  crumbsEl.innerHTML = chain.map((b, i) => i < chain.length - 1
    ? `<a href="${boardHash(b.id)}">${esc(b.title)}</a><span class="sep">/</span>`
    : `<span class="cur">${esc(b.title)}</span>`).join('');
  const bt = document.getElementById('boardTitle');
  if (bt && bt.contentEditable !== 'true') bt.textContent = chain.at(-1)?.title || '';
  document.title = `${chain.at(-1)?.title || 'Board'} · Kolam`;
}
export function renderBoard() {
  const keepEdit = editingId;
  itemsLayer.innerHTML = ''; els.clear();
  const frag = document.createDocumentFragment();
  const tops = itemsOf(cur).filter(i => !i.col || !S.items[i.col]).sort(drawOrder);
  for (const it of tops) {
    if (it.col && !S.items[it.col]) it.col = null; // orphan safety
    let el;
    try { el = makeCard(it); } catch (err) { console.error('Could not draw card', it.id, err); continue; }
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
    frag.appendChild(el);
  }
  itemsLayer.appendChild(frag);
  for (const id of [...sel]) if (!S.items[id] || S.items[id].board !== cur) sel.delete(id);
  if (selLine && (!S.lines[selLine] || S.lines[selLine].board !== cur)) setSelLine(null);
  emptyHint.hidden = tops.length > 0 || Object.values(S.lines).some(ln => ln.board === cur);
  canvas.dataset.bg = S.boards[cur]?.bg || 'dots';
  canvas.dataset.corners = boardCorners(cur);
  updateBadges();
  applyView();
  refreshSel();
  if (keepEdit && els.has(keepEdit)) {
    const el = els.get(keepEdit);
    el.classList.add('editing');
    TYPES[S.items[keepEdit].type].edit?.(el, S.items[keepEdit]);
  } else if (keepEdit) { setEditingId(null); }
  paintEditing();
}
export function makeCard(it) {
  const T = TYPES[it.type];
  if (!T) throw new Error('Unknown card type ' + it.type);
  it.data ||= {};
  const el = document.createElement('div');
  el.className = 'card t-' + it.type;
  el.dataset.id = it.id;
  const p = pal(it.color);
  if (!noBg.has(it.type) && it.color) { el.style.setProperty('--card-bg', isDark() ? p.dbg : p.bg); if (p.dark && !isDark()) el.classList.add('dark'); }
  if (it.locked) el.classList.add('locked');
  applyAlign(el, it);
  if (it.col) el.classList.add('in-col');
  else if (it.w || T.w) el.style.width = (it.w || T.w) + 'px';   // text with no width fits its words (cards/text.js)
  if (T.resizeH && !it.col) el.style.height = (it.h || T.h) + 'px';
  else if (T.fitH && it.h && !it.col) el.style.minHeight = it.h + 'px';
  el.innerHTML = T.html(it) + CONN_DOTS + (it.col || it.locked ? '' : resizeHandles(T)) + (it.locked ? `<div class="lock-badge" title="Locked">${icon('lock', 11)}</div>` : '') + badgeHtml(it);
  T.mount?.(el, it);
  mountBadge(el, it);
  el.addEventListener('pointerdown', e => cardDown(e, it.id));
  el.addEventListener('dblclick', e => cardDbl(e, it.id));
  el.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    if (editingId === it.id || RO) return;
    if (!sel.has(it.id)) selectOnly(it.id);
    showItemMenu(e.clientX, e.clientY);
  });
  els.set(it.id, el);
  return el;
}
export function rebuildCard(id) {
  const old = els.get(id), it = S.items[id];
  if (!old || !it) return null;
  const el = makeCard(it);
  if (!it.col) { el.style.left = it.x + 'px'; el.style.top = it.y + 'px'; }
  if (old.classList.contains('selected')) el.classList.add('selected');
  old.replaceWith(el);
  if (editingId === id) { el.classList.add('editing'); TYPES[it.type].edit?.(el, it); }
  renderLines(); positionBars(); paintEditing();
  return el;
}
