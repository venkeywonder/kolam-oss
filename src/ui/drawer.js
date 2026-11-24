import { $, $$, esc, uid, track } from '../core/util.js';
import { icon } from './icons.js';
import { pal } from '../core/palette.js';
import { canvas } from '../core/dom.js';
import { ROOT, S, VIEW, checkpoint, cur, els, isPersonal, save, user } from '../core/store.js';
import { api } from '../core/api.js';
import { V, toWorld } from '../canvas/viewport.js';
import { childrenOf, itemsOf, maxZ } from '../core/model.js';
import { ago } from '../core/sanitize.js';
import { TYPES, drawSketch, noBg } from '../cards/types.js';
import { renderBoard } from '../canvas/render.js';
import { selectOnly } from '../canvas/selection.js';
import { findDropTarget } from '../canvas/drag.js';
import { glide, goHome, land, snap, snapCards, sway } from '../canvas/motion.js';
import { deleteItems } from '../actions/edit.js';
import { openBoard } from '../app/navigation.js';
import { plain } from './search.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';
import { isDark } from './theme.js';
import { confirmMove, refreshContexts, renderSpacesPanel, switchSpace } from '../features/spaces.js';
import { toggle as toggleComments } from '../features/comments.js';

/* ================= Unsorted & Trash drawer ================= */
export let panel = null;
export const drawer = $('#drawer');
export function togglePanel(p) { panel = panel === p ? null : p; renderPanel(); }
export function overDrawer(x, y) {
  if (drawer.hidden || panel !== 'unsorted') return false;
  const r = drawer.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
export function updateBadges() {
  const n = itemsOf('__unsorted').filter(i => !i.col).length;
  const b = $('#unsortedBadge'); if (b) b.textContent = n;
  $('#unsortedPill')?.classList.toggle('has', n > 0);
}
export function renderPanel() {
  $$('.tool[data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
  $('#unsortedPill')?.classList.toggle('active', panel === 'unsorted');
  if (panel === 'unsorted' && !isPersonal()) panel = null;   // the inbox belongs to your own boards
  if (!panel || VIEW) { drawer.hidden = true; return; }
  drawer.hidden = false;
  toggleComments(false);
  dispatchEvent(new CustomEvent('nk:panel', { detail: 'drawer' }));
  if (panel === 'unsorted') renderUnsorted(); else if (panel === 'spaces') renderSpacesPanel(); else renderTrash();
  updateBadges();
}
export function miniCard(it) {
  const el = document.createElement('div');
  el.className = 'card in-col t-' + it.type;
  const p = pal(it.color);
  if (!noBg.has(it.type) && it.color) { el.style.setProperty('--card-bg', isDark() ? p.dbg : p.bg); if (p.dark && !isDark()) el.classList.add('dark'); }
  el.innerHTML = TYPES[it.type].html(it);
  if (['image', 'file', 'sketch', 'text'].includes(it.type)) TYPES[it.type].mount(el, it);
  if (it.type === 'sketch') el.style.height = Math.round((it.h || 220) * 270 / (it.w || 320)) + 'px';
  return el;
}
export function renderUnsorted() {
  const its = itemsOf('__unsorted').filter(i => !i.col).sort((a, b) => (b.order || 0) - (a.order || 0));
  drawer.innerHTML = `<div class="dr-head"><b>Unsorted</b><span class="dr-sub">${its.length} card${its.length === 1 ? '' : 's'}</span><button class="icon-btn" data-x title="Close">${icon('close', 16)}</button></div>` +
    `<div class="dr-quick"><textarea placeholder="Jot down a quick note… (Enter to save, Shift+Enter for a new line)"></textarea></div>` +
    `<div class="dr-list">${its.length ? '' : '<div class="dr-empty">Quick notes, web clips and cards you drag here wait in Unsorted until you place them on a board.</div>'}</div>` +
    `<div class="dr-foot">Drag a card onto the board to place it.</div>`;
  const list = $('.dr-list', drawer);
  for (const it of its) {
    const w = document.createElement('div'); w.className = 'dr-item'; w.dataset.id = it.id;
    const el = miniCard(it);
    w.appendChild(el);
    w.insertAdjacentHTML('beforeend', `<button class="dr-del" title="Move to Trash">${icon('close', 12)}</button>`);
    list.appendChild(w);
    el.addEventListener('pointerdown', e => unsortedDrag(e, it.id, el));
    $('.dr-del', w).onclick = () => { checkpoint(); toTrash([it.id]); deleteItems([it.id]); save(); renderPanel(); };
  }
  $('[data-x]', drawer).onclick = () => togglePanel('unsorted');
  const ta = $('textarea', drawer);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = ta.value.trim(); if (!t) return;
      checkpoint();
      const it = { id: uid(), board: '__unsorted', type: 'note', x: 0, y: 0, w: 260, z: 1, col: null, order: Date.now(), color: null, data: { html: t.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') } };
      S.items[it.id] = it;
      save(); renderPanel();
      $('textarea', drawer).focus();
    }
    if (e.key === 'Escape') ta.blur();
  });
}
export function unsortedDrag(e, id, src) {
  if (e.button !== 0 || e.target.closest('[data-nodrag],audio,video,a,iframe')) return;
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY;
  let ghost = null, colT = null, sw = null, gx = 0, gy = 0;
  const r0 = src.getBoundingClientRect(), ox = sx - r0.left, oy = sy - r0.top;
  const mv = ev => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
      // the ghost is the card as it will be on the board: its own size, at the board's zoom, held where it was grabbed
      const it = S.items[id], T = TYPES[it?.type]; if (!T) return;
      ghost = src.cloneNode(true); ghost.classList.remove('in-col'); ghost.classList.add('dr-ghost');
      const bw = it.w || T.w || 260, k = bw / r0.width;
      ghost.style.width = bw + 'px';
      if (T.resizeH) ghost.style.height = (it.h || T.h) + 'px';
      else if (T.fitH && it.h) ghost.style.minHeight = it.h + 'px';
      ghost.style.setProperty('--gz', V().z);
      document.body.appendChild(ghost);
      if (it.type === 'sketch') drawSketch(ghost, it);
      gx = ox * k; gy = Math.min(oy * k, ghost.offsetHeight - 4);
      ghost.style.transformOrigin = `${gx}px ${gy}px`;
      document.body.classList.add('grabbing');
      sw = sway(a => (ghost.style.rotate = a.toFixed(2) + 'deg'), S.items[id]?.type === 'column' ? 2.6 : 1);
    }
    sw.move(ev.clientX);
    ghost.style.left = ev.clientX - gx + 'px'; ghost.style.top = ev.clientY - gy + 'px';
    $$('.drop-target').forEach(x => x.classList.remove('drop-target'));
    colT = null;
    if (!overDrawer(ev.clientX, ev.clientY)) {
      const t = findDropTarget(ev.clientX, ev.clientY, new Set(), S.items[id]?.type === 'column');
      if (t?.type === 'col') {
        const tel = els.get(t.id); tel.classList.add('drop-target');
        const kids = $$('.col-body > .card', tel);
        const idx = kids.findIndex(k => { const r = k.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
        colT = { id: t.id, idx: idx < 0 ? kids.length : idx };
      }
    }
  };
  const up = async ev => {
    $$('.drop-target').forEach(x => x.classList.remove('drop-target'));
    document.body.classList.remove('grabbing');
    if (!ghost) return;
    const angle = sw.stop();
    const cr = canvas.getBoundingClientRect();
    // let go over the drawer or outside the board: the card goes back to its place in the list
    if (overDrawer(ev.clientX, ev.clientY) || ev.clientX < cr.left || ev.clientY < cr.top) { goHome(ghost, src, { scale: .9 * r0.width / ghost.offsetWidth }); return; }
    const from = snap([ghost]).get(ghost);
    ghost.remove();
    const it = S.items[id]; if (!it) return;
    if (!await confirmMove('__unsorted', cur)) return;
    checkpoint();
    const p = toWorld(ev.clientX, ev.clientY);
    const set = [it, ...(it.type === 'column' ? childrenOf(it.id) : [])];
    set.forEach(x => (x.board = cur));
    if (it.type === 'board' && S.boards[it.data.target]) S.boards[it.data.target].parent = cur;
    let before = null;
    if (colT) {
      const kids = childrenOf(colT.id);
      before = snapCards(kids.map(k => k.id));
      kids.splice(colT.idx, 0, it);
      kids.forEach((k, i) => { k.col = colT.id; k.order = i; });
    } else {
      it.col = null; it.x = Math.round(p.x - gx); it.y = Math.round(p.y - gy); it.z = maxZ() + 1;
    }
    save(); renderBoard(); renderPanel(); selectOnly(colT ? null : id);
    if (before) { before.set(id, from); glide(before, k => els.get(k)); land(els.get(id), angle * .5, { ring: false }); }
    else land(els.get(id), angle);
  };
  track(mv, up);
}
export function collectForTrash(ids) {
  const items = new Map(), boards = new Set();
  const addItem = id => {
    const it = S.items[id]; if (!it || items.has(id)) return;
    items.set(id, it);
    if (it.type === 'column') childrenOf(id).forEach(k => addItem(k.id));
    if (it.type === 'board') addBoard(it.data.target);
  };
  const addBoard = bid => {
    if (!S.boards[bid] || boards.has(bid) || bid === 'home') return;
    boards.add(bid);
    itemsOf(bid).forEach(i => addItem(i.id));
  };
  ids.forEach(addItem);
  const lines = Object.values(S.lines).filter(l => boards.has(l.board) || (l.a.item && items.has(l.a.item)) || (l.b.item && items.has(l.b.item)));
  return { items: [...items.values()], boards: [...boards].map(b => S.boards[b]), lines };
}
export function trashLabel(it) {
  const t = plain(TYPES[it.type]?.text?.(it) || '').slice(0, 70);
  return TYPES[it.type].label + (t ? ': ' + t : '');
}
export function toTrash(ids) {
  const c = collectForTrash(ids);
  if (!c.items.length) return;
  const tops = ids.map(id => S.items[id]).filter(Boolean);
  S.trash.unshift({
    id: uid(), at: Date.now(), from: tops[0].board,
    label: tops.length === 1 ? trashLabel(tops[0]) : `${tops.length} cards`,
    items: structuredClone(c.items), boards: structuredClone(c.boards), lines: structuredClone(c.lines),
  });
  if (S.trash.length > 150) S.trash.length = 150;
}
export async function restoreTrash(tid) {
  const i = S.trash.findIndex(t => t.id === tid); if (i < 0) return;
  if (S.trash[i].type === 'workspace') return restoreWorkspace(S.trash[i]);
  checkpoint();
  const t = S.trash[i];
  const target = S.boards[t.from] || t.from === '__unsorted' ? t.from : ROOT;
  const ids = new Set(t.items.map(x => x.id)), bids = new Set(t.boards.map(b => b.id));
  for (const b of t.boards) { if (!S.boards[b.parent] && !bids.has(b.parent)) b.parent = target; S.boards[b.id] = b; }
  for (const it of t.items) {
    if (!S.boards[it.board] && it.board !== '__unsorted') it.board = target;
    if (it.col && !S.items[it.col] && !ids.has(it.col)) it.col = null;
    S.items[it.id] = it;
  }
  for (const l of t.lines) {
    const ok = e => !e.item || S.items[e.item];
    if (ok(l.a) && ok(l.b) && S.boards[l.board]) S.lines[l.id] = l;
  }
  S.trash.splice(i, 1);
  save(); renderBoard(); renderPanel();
  toast(`Restored to “${target === '__unsorted' ? 'Unsorted' : S.boards[target].title}”`, target === cur ? '' : 'Go there', () => target === '__unsorted' ? togglePanel('unsorted') : openBoard(target));
}
/** A deleted workspace waits in its owner's trash; restoring or purging it is done by the server. */
async function restoreWorkspace(t) {
  try {
    await api(`workspaces/${t.space}/restore`, { method: 'POST' });
    S.trash = S.trash.filter(x => x.id !== t.id);
    renderPanel(); await refreshContexts();
    toast(`${t.label} is back`, 'Open', () => switchSpace(t.space));
  } catch (e) { toast(e.message); }
}
const purgeWorkspace = t => api(`workspaces/${t.space}/purge`, { method: 'POST' }).then(() => { S.trash = S.trash.filter(x => x.id !== t.id); }, e => toast(e.message));
function trashMeta(t) {
  if (t.type === 'workspace') return `Deleted ${ago(t.at)} · removed for good ${t.purgeAt ? 'in ' + Math.max(1, Math.ceil((t.purgeAt - Date.now()) / 86400000)) + ' days' : 'after 30 days'}`;
  const from = t.from === '__unsorted' ? 'Unsorted' : S.boards[t.from]?.title || 'a deleted board';
  const by = t.by && t.by.id !== user?.id ? ` by ${t.by.name}` : '';
  return `From ${from} · ${ago(t.at)}${by}${t.items.length > 1 ? ` · ${t.items.length} cards` : ''}`;
}
export function renderTrash() {
  const tr = S.trash || [];
  drawer.innerHTML = `<div class="dr-head"><b>Trash</b><span class="dr-sub">${tr.length} item${tr.length === 1 ? '' : 's'}</span>${tr.length ? '<button class="btn ghost" data-empty style="height:28px;font-size:12px">Empty</button>' : ''}<button class="icon-btn" data-x title="Close">${icon('close', 16)}</button></div>` +
    `<div class="dr-list">${tr.length ? tr.map(t => `<div class="tr-row"><b title="${esc(t.label)}">${esc(t.label)}</b><small>${esc(trashMeta(t))}</small><button class="btn" data-restore="${t.id}">Restore</button><button class="btn ghost" data-purge="${t.id}">Delete forever</button></div>`).join('') : `<div class="dr-empty">${isPersonal() ? 'Deleted cards and boards land here, so you can bring them back.' : 'Cards and boards deleted here land in this Trash. Everyone who can edit these boards can bring them back.'}</div>`}</div>`;
  $('[data-x]', drawer).onclick = () => togglePanel('trash');
  drawer.onclick = async e => {
    const r = e.target.closest('[data-restore]'); if (r) return restoreTrash(r.dataset.restore);
    const p = e.target.closest('[data-purge]');
    if (p) {
      const t = S.trash.find(x => x.id === p.dataset.purge); if (!t) return;
      if (t.type === 'workspace') {
        if (!await confirmDialog(`Delete ${t.label} for good?`, { body: 'All of its boards will be deleted. This can’t be undone.', ok: 'Delete', danger: true })) return;
        await purgeWorkspace(t); return renderPanel();
      }
      checkpoint(); S.trash = S.trash.filter(x => x.id !== t.id); save(); return renderPanel();
    }
    if (e.target.closest('[data-empty]') && await confirmDialog('Empty the Trash?', { body: 'Everything in the Trash will be deleted for good. This can’t be undone.', ok: 'Empty Trash', danger: true })) {
      for (const t of S.trash.filter(x => x.type === 'workspace')) await purgeWorkspace(t);
      checkpoint(); S.trash = S.trash.filter(x => x.type === 'workspace'); save(); renderPanel();
    }
  };
}
export const setPanel = v => (panel = v);
