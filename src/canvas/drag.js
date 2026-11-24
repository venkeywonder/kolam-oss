import { $, $$, track } from '../core/util.js';
import { canvas, itemsLayer, world } from '../core/dom.js';
import { S, RO, can, checkpoint, cur, dragging, editingId, els, save, sel, selLine, setDragging, setSelLine, spaceDown } from '../core/store.js';
import { V, itemRect, rectWorld } from './viewport.js';
import { childrenOf, isDescendantBoard, itemsOf, maxZ, opensBoard } from '../core/model.js';
import { renderBoard } from './render.js';
import { renderLines } from './lines.js';
import { refreshSel, selectOnly } from './selection.js';
import { caretEnd, exitEdit, startEdit, typedSinceEdit } from './editing.js';
import { connStart } from './connectors.js';
import { resetSize, resizeStart } from './resize.js';
import { panStart } from './pointer.js';
import { openBoard } from '../app/navigation.js';
import { hideBars } from '../ui/floatbars.js';
import { hideMenu } from '../ui/menus.js';
import { toast } from '../ui/toast.js';
import { lightbox } from '../ui/modal.js';
import { openDoc } from '../cards/doc.js';
import { pickSwatch } from '../cards/types.js';
import { drawDown, drawMode } from '../cards/drawing.js';
import { viewCardDown } from './viewonly.js';
import { snapGuides } from './arrange.js';
import { overDrawer, renderPanel } from '../ui/drawer.js';
import { confirmMove } from '../features/spaces.js';
import { fly, glide, glideCards, gulp, land, massOf, open, popIn, shake, snap, snapCards, sway } from './motion.js';
import { contentsOf } from '../cards/group.js';

/* ================= pointer: cards ================= */
export function cardDown(e, id) {
  e.stopPropagation();
  hideMenu();
  if (RO) return viewCardDown(e, id);
  if (drawMode) return drawDown(e);
  if (e.button === 1) return panStart(e);
  if (e.button !== 0) return;
  if (e.target.closest('.rz')) { if (editingId && editingId !== id) exitEdit(); return resizeStart(e, id); }
  if (editingId === id) {                 // let text editing / drawing work, but until something is typed a drag moves the card
    if (!typedSinceEdit() && S.items[id]?.type !== 'sketch' && !e.target.closest('[data-nodrag],a,input,textarea') && !onText(e.target)) pressMove(e, id);
    return;
  }
  const conn = e.target.closest('.conn');
  if (conn) { if (editingId) exitEdit(); return connStart(e, id, conn.dataset.side); }
  if (spaceDown) return panStart(e);
  if (editingId) exitEdit();
  const nd = e.target.closest('[data-nodrag]');
  if (nd) {   // an empty text box, or the frame right around one (a new link card): a drag moves the card
    const f = blankField(e.target) ? e.target : e.target === nd && $(':scope > input,:scope > textarea', nd);
    if (f && blankField(f)) pressMove(e, id, f);
    return;
  }
  e.preventDefault();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const was = sel.has(id) && sel.size === 1;
  if (e.shiftKey || e.metaKey || e.ctrlKey) {
    sel.has(id) ? sel.delete(id) : sel.add(id);
    setSelLine(null); refreshSel(); return;
  }
  if (!sel.has(id)) selectOnly(id);
  const sx = e.clientX, sy = e.clientY;
  let d = null;
  const mv = ev => {
    if (!d) { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return; d = dragBegin(sx, sy); }
    dragMove(d, ev);
  };
  const up = ev => {
    if (d) dragEnd(d); else cardClick(ev, id, was, e.target);
  };
  track(mv, up);
}
/** An empty text box on a card (a new link's address, a comment reply): a drag from it moves the card. */
const blankField = t => t.matches('textarea,input:not([type=color],[type=range],[type=checkbox],[type=radio],[type=file])') && !t.value;
/** Pressed on text that's already there (a table cell, a title): that press selects text rather than moving the card. */
const onText = t => !!t.closest('[contenteditable=true]')?.textContent.trim();
/*
 * A press on a card that is waiting for typing: moving past 4px drags the card (it stays ready to type afterwards);
 * letting go without moving puts the caret where you pressed, as a plain click would.
 */
function pressMove(e, id, field = e.target) {
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY;
  let d = null;
  const mv = ev => {
    if (!d) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      getSelection()?.removeAllRanges(); document.activeElement?.blur?.();
      if (!sel.has(id)) selectOnly(id);
      d = dragBegin(sx, sy);
    }
    dragMove(d, ev);
  };
  const up = () => {
    if (d) dragEnd(d);
    const el = els.get(id); if (!el) return;
    if (editingId === id) {
      const t = !d && field.closest?.('[contenteditable=true]');
      if (t && el.contains(t)) {
        t.focus();
        const r = document.caretRangeFromPoint?.(sx, sy);
        if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); } else caretEnd(t);
      } else caretEnd($('[contenteditable=true]', el));
    } else if (blankField(field)) (d ? $('[data-nodrag] input,[data-nodrag] textarea', el) : field)?.focus();
  };
  track(mv, up);
}
export function cardClick(e, id, was, downTarget) {
  const it = S.items[id]; if (!it) return;
  if (opensBoard(it) && downTarget?.closest?.('.bd-icon')) return openBoard(it.data.target);
  if (was && !it.locked) startEdit(id, { x: e.clientX, y: e.clientY });
}
export function cardDbl(e, id) {
  e.stopPropagation();
  const it = S.items[id]; if (!it) return;
  if (e.target.closest('.rz')) return resetSize(id);
  if (editingId === id && it.type !== 'sketch') return;
  if (opensBoard(it)) return openBoard(it.data.target);
  if (it.type === 'doc') return openDoc(id);
  if (RO) { if (it.type === 'link' && it.data.url) window.open(it.data.url, '_blank', 'noopener'); if (it.type === 'image') lightbox(id); return; }
  if (it.locked) return;
  if (it.type === 'link' && it.data.url) return window.open(it.data.url, '_blank', 'noopener');
  if (it.type === 'swatch') return pickSwatch(els.get(id));
  if (it.type === 'sketch') { if (editingId !== id) startEdit(id); return; }
  startEdit(id, { x: e.clientX, y: e.clientY });
}
/* ---------- drag & drop of cards ---------- */
export function dragBegin(sx, sy) {
  setDragging(true); hideBars();
  checkpoint();
  let ids = [...sel].filter(id => S.items[id] && S.items[id].board === cur);
  ids = ids.filter(id => { const c = S.items[id].col; return !(c && sel.has(c)) && !S.items[id].locked; });
  // a group takes along whatever lies wholly inside it (and inside groups inside it), keeping their stacking order
  const carried = [];
  for (const id of ids) if (S.items[id].type === 'group') for (const k of contentsOf(id)) if (!ids.includes(k) && !carried.includes(k)) carried.push(k);
  ids.push(...carried.sort((a, b) => (S.items[a].z || 0) - (S.items[b].z || 0)));
  const others = itemsOf(cur).filter(i => !i.col && !ids.includes(i.id)).map(i => itemRect(i.id)).filter(Boolean);
  let z = maxZ();
  const touchedCols = new Set();
  // the cards left behind in a column slide up to close the gap
  const stay = new Set(ids);
  const behind = snapCards([...new Set(ids.map(id => S.items[id].col).filter(Boolean))].flatMap(c => childrenOf(c).map(k => k.id)).filter(id => !stay.has(id)));
  const list = ids.map(id => {
    const it = S.items[id], el = els.get(id);
    if (it.col) {
      const r = rectWorld(el);
      touchedCols.add(it.col);
      it.col = null; it.x = Math.round(r.x); it.y = Math.round(r.y); it.w = Math.round(r.w);
      el.classList.remove('in-col');
      el.style.width = it.w + 'px';
      itemsLayer.appendChild(el);
    }
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
    it.z = ++z;
    el.classList.add('dragging');
    return { id, el, ox: it.x, oy: it.y };
  });
  for (const c of touchedCols) { const ce = els.get(c); if (ce) $('.col-count', ce).textContent = childrenOf(c).length || ''; }
  glideCards(behind);
  // columns and groups never go into a column
  const hasCol = list.some(o => S.items[o.id].type === 'column' || S.items[o.id].type === 'group');
  const ph = document.createElement('div'); ph.className = 'col-ph';
  ph.style.height = Math.min(120, Math.max(40, list[0]?.el.offsetHeight || 60)) + 'px';
  list.forEach(o => { o.w = o.el.offsetWidth; o.h = o.el.offsetHeight; });
  liftCards(list.map(o => o.el));
  document.body.classList.add('grabbing');
  // the heaviest card sets how much the group sways
  const mass = Math.max(...list.map(o => massOf(S.items[o.id].type)), 1);
  const sw = sway(a => { for (const o of list) o.el.style.rotate = a ? a.toFixed(2) + 'deg' : ''; }, mass);
  return { list, sx, sy, hasCol, ph, target: null, ids: new Set(ids), others, sw };
}
export function findDropTarget(cx, cy, dragIds, hasCol) {
  for (const n of document.elementsFromPoint(cx, cy)) {
    if (n.closest('.dragging')) continue;
    const c = n.closest('.card');
    if (!c) { if (n === canvas || n === itemsLayer) break; continue; }
    const tid = c.dataset.id, t = S.items[tid];
    if (!t || dragIds.has(tid)) return null;
    if (t.type === 'column' && !hasCol) return { type: 'col', id: tid };
    if (t.col && !hasCol) return { type: 'col', id: t.col };
    if (opensBoard(t)) {
      // a shortcut takes cards to its board too, but never to this board or a board inside one being dragged
      const bad = t.data.target === cur || [...dragIds].some(id => S.items[id]?.type === 'board' && isDescendantBoard(t.data.target, S.items[id].data.target));
      return bad ? null : { type: 'board', id: tid };
    }
    return null;
  }
  return null;
}
export function dragMove(d, ev) {
  syncLift();
  const z = V().z, dx = (ev.clientX - d.sx) / z, dy = (ev.clientY - d.sy) / z;
  d.sw.move(ev.clientX);
  for (const o of d.list) {
    const it = S.items[o.id];
    it.x = Math.round(o.ox + dx); it.y = Math.round(o.oy + dy);
    placeDragged(o, it);
  }
  let t = findDropTarget(ev.clientX, ev.clientY, d.ids, d.hasCol);
  if (!t && overDrawer(ev.clientX, ev.clientY)) t = { type: 'unsorted' };
  snapGuides(t || ev.altKey ? null : d);
  const key = t ? t.type + ':' + (t.id || '') : '';
  if (key !== d.tkey) {          // target changed: swap highlight
    $$('.drop-target').forEach(x => x.classList.remove('drop-target'));
    $$('.col-body.has-ph').forEach(x => x.classList.remove('has-ph'));
    const left = d.ph.parentNode && snap($$(':scope > .card', d.ph.parentNode));
    d.ph.remove(); d.phIdx = -1;
    if (left) glide(left);
    if (t?.type === 'unsorted') $('#drawer').classList.add('drop-target');
    else if (t) els.get(t.id)?.classList.add('drop-target');
    d.tkey = key;
  }
  if (t?.type === 'col') {
    const colIt = S.items[t.id], row = colIt.data.dir === 'row';
    const body = $('.col-body', els.get(t.id));
    const kids = [...body.children].filter(c => c.classList.contains('card'));
    let idx = row
      ? kids.findIndex(k => { const r = k.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2; })
      : kids.findIndex(k => { const r = k.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    if (idx < 0) idx = kids.length;
    t.idx = idx;
    if (idx !== d.phIdx) {         // the cards around the gap make room
      const room = snap(kids), fresh = !d.ph.isConnected;
      if (row) { d.ph.style.width = Math.min(240, Math.max(80, d.list[0]?.w || 160)) + 'px'; d.ph.style.height = ''; }
      else { d.ph.style.height = Math.min(120, Math.max(40, d.list[0]?.h || 60)) + 'px'; d.ph.style.width = ''; }
      body.insertBefore(d.ph, kids[idx] || null); body.classList.add('has-ph'); d.phIdx = idx;
      if (fresh) open(d.ph);
      glide(room);
    }
  }
  d.target = t;
  renderLines();
}
export function dragEnd(d) {
  setDragging(false);
  document.body.classList.remove('grabbing');
  const angle = d.sw.stop();
  let t = d.target;
  // where everything was on screen, so cards can glide from there into a column
  const before = snapCards([...d.ids, ...(t?.type === 'col' ? childrenOf(t.id).map(k => k.id) : [])]);
  d.list.forEach(o => { const it = S.items[o.id]; o.el.style.translate = o.el.style.rotate = ''; if (it) { o.el.style.left = it.x + 'px'; o.el.style.top = it.y + 'px'; } });
  d.ph.remove();
  $('#guides').innerHTML = '';
  $$('.drop-target').forEach(x => x.classList.remove('drop-target'));
  d.list.forEach(o => o.el.classList.remove('dragging'));
  let to = t?.type === 'unsorted' ? '__unsorted' : t?.type === 'board' ? S.items[t.id].data.target : null;
  let refused = false;
  if (to && ((to !== '__unsorted' && !S.boards[to]) || !can(to, 'editor'))) { toast('You can’t add cards to that board'); to = null; t = null; refused = true; }
  if (t?.type === 'col') {
    const row = S.items[t.id].data.dir === 'row';
    const kids = childrenOf(t.id).filter(k => !d.ids.has(k.id));
    const moving = d.list.map(o => S.items[o.id]).sort((a, b) => row ? a.x - b.x : a.y - b.y);
    kids.splice(t.idx, 0, ...moving);
    kids.forEach((k, i) => { k.col = t.id; k.order = i; });
  }
  dropLifted();
  save(); renderBoard();
  const ids = [...d.ids];
  // into Unsorted: the cards stay above the drawer while the move is confirmed and they fly in
  if (to === '__unsorted') liftCards(ids.map(id => els.get(id)));
  if (refused) ids.forEach(id => shake(els.get(id)));
  else if (t?.type === 'col') { glideCards(before); ids.forEach((id, i) => land(els.get(id), angle * .5, { delay: i * 30, ring: false })); }
  else if (!t) ids.forEach((id, i) => land(els.get(id), angle, { delay: i * 30 }));
  // into another board (or Unsorted): ask first when different people can see it there
  if (to) confirmMove(cur, to, d.ids.size).then(async ok => {
    if (!ok) { dropLifted(true); ids.forEach(id => land(els.get(id), 0)); return; }
    const into = swallowPoint(t);
    if (into) await Promise.all(ids.map((id, i) => fly(els.get(id), into, { zoom: V().z, delay: i * 40 })));
    moveToBoard(ids, to);
    dropLifted();
    toast(to === '__unsorted' ? 'Moved to Unsorted' : `Moved to “${S.boards[to]?.title || 'board'}”`);
    save(); renderBoard(); renderPanel();
    if (to === '__unsorted') {
      ids.forEach((id, i) => popIn($(`.dr-item[data-id="${id}"]`), i * 50));
      gulp($('#unsortedBadge'));
    } else gulp(els.get(t.id)?.querySelector('.bd-icon'));
  });
}
/** Screen point that cards dropped on a board card (its icon) or the Unsorted drawer (the top of its list) fly into. */
function swallowPoint(t) {
  const n = t.type === 'board' ? els.get(t.id)?.querySelector('.bd-icon') : $('#drawer .dr-list');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return [r.left + r.width / 2, t.type === 'board' ? r.top + r.height / 2 : r.top + 36];
}
/*
 * Cards being dragged ride in a layer above the side panels, drawn with the board's own pan and zoom, so they pass
 * over the Unsorted drawer rather than under it. Element hit tests ignore the layer, so drop targets still work.
 */
let lift = null;
function syncLift() {
  if (!lift) return;
  const r = canvas.getBoundingClientRect();
  lift.style.left = r.left + 'px'; lift.style.top = r.top + 'px';
  lift.dataset.corners = canvas.dataset.corners || '';
  lift.firstChild.style.transform = world.style.transform;
  lift.firstChild.style.setProperty('--iz', world.style.getPropertyValue('--iz'));
}
function liftCards(list) {
  if (!lift) { lift = document.createElement('div'); lift.id = 'dragLayer'; lift.appendChild(document.createElement('div')); document.body.appendChild(lift); }
  syncLift();
  for (const el of list) if (el) lift.firstChild.appendChild(el);
}
/** Empty the layer: back onto the board (back), or away (the board was redrawn and has fresh copies). */
function dropLifted(back = false) {
  if (!lift) return;
  if (back) itemsLayer.append(...lift.firstChild.children);
  else lift.firstChild.replaceChildren();
}
/** Position a dragged card relative to where the drag started (the translate property, so rotate/scale stay centred). */
export function placeDragged(o, it) {
  o.el.style.translate = `${it.x - o.ox}px ${it.y - o.oy}px`;
}
/** A y below every card on a board, where cards brought in from elsewhere start a new row. */
export function belowAll(bid) {
  const estH = i => i.h || (i.type === 'column' ? 120 + childrenOf(i.id).length * 80 : opensBoard(i) ? 170 : 240);
  return itemsOf(bid).filter(i => !i.col).reduce((m, i) => Math.max(m, (i.y || 0) + estH(i) + 40), 40);
}
export function moveToBoard(ids, bid) {
  const set = new Set(ids);
  for (const id of ids) if (S.items[id]?.type === 'column') childrenOf(id).forEach(k => set.add(k.id));
  const baseY = belowAll(bid);
  let i = 0;
  const tops = ids.map(id => S.items[id]).filter(Boolean).sort((a, b) => a.x - b.x || a.y - b.y);
  for (const it of tops) { it.x = 40 + (i % 4) * 300; it.y = baseY + Math.floor(i / 4) * 260; it.order = Date.now() + i; i++; }
  for (const id of set) {
    const it = S.items[id]; if (!it) continue;
    it.board = bid;
    if (it.type === 'board' && S.boards[it.data.target]) S.boards[it.data.target].parent = bid;
  }
  for (const ln of Object.values(S.lines)) {
    const ina = ln.a.item && set.has(ln.a.item), inb = ln.b.item && set.has(ln.b.item);
    if (ina && inb) ln.board = bid;
    else if (ina || inb) delete S.lines[ln.id];
  }
  sel.clear();
}
