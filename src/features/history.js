/*
 * History (/api/history): the activity on a board — who added, changed, moved and deleted cards, and who commented —
 * and each card's versions. One person's edits to a card within 2 minutes show as one change.
 * A card can go back to an earlier version: that's a normal change you make (so undo takes it back, and it shows in
 * the activity like any other), which keeps where the card is now and brings back its content, colour and size.
 */
import { $, esc } from '../core/util.js';
import { api } from '../core/api.js';
import { S, SPACE, VIEW, can, checkpoint, cur, flush, save, undo } from '../core/store.js';
import { ago } from '../core/sanitize.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { renderBoard } from '../canvas/render.js';
import { selectOnly } from '../canvas/selection.js';
import { centerOn } from '../canvas/viewport.js';
import { TYPES } from '../cards/types.js';
import { avatarHtml } from '../ui/avatars.js';
import { miniCard, renderPanel, setPanel, panel as drawerPanel } from '../ui/drawer.js';
import { openThread, toggle as toggleComments } from './comments.js';
import { toggle as toggleAi } from '../ui/ai.js';
import { plain } from '../ui/search.js';

const el = $('#historyPanel');
let open = false;
let feed = null;   // { key: "space|board", entries, names, more, busy }
let vers = null;   // { item, label, type, list, names, sel: index, data: Map ref -> card }
let lastLoad = 0;

/* ---------- describing changes ---------- */
// the icon for each type of card (1: the icon named like the type)
const TYPE_ICON = { text: 1, note: 1, todo: 1, link: 1, board: 1, shortcut: 1, column: 1, comment: 1, table: 1, doc: 1, image: 1, sketch: 1, swatch: 1, group: 1, icon: 'logo' };
const typeIcon = t => (TYPE_ICON[t] === 1 ? t : TYPE_ICON[t] || 'note');
/** What a changed field is about. */
function part(f) {
  if (f.startsWith('data.') || f === 'type') return 'content';
  if (f === 'color') return 'colour';
  if (f === 'corners') return 'corners';
  if (f === 'w' || f === 'h') return 'size';
  if (f === 'locked' || f === 'lockedBy') return 'lock';
  if (['x', 'y', 'z', 'col', 'order', 'board'].includes(f)) return 'position';
  if (f === 'title') return 'title';
  return 'other';
}
const VERB = { content: 'edited', colour: 'recoloured', corners: 'changed the corners of', size: 'resized', lock: 'locked or unlocked', position: 'moved', title: 'renamed', other: 'changed' };
/** The verb for a change, and (for edits touching several things) what changed. */
function verb(e) {
  if (e.act === 'create') return { v: 'added' };
  if (e.act === 'delete') return { v: 'deleted' };
  if (e.act === 'restore') return { v: 'restored' };
  const parts = [...new Set((e.f || []).map(part))];
  const main = parts.includes('content') ? 'content' : parts[0] || 'other';
  return { v: VERB[main], more: parts.length > 1 ? parts.join(', ') : '' };
}
const cardThing = (type, label) => `<span class="hs-card">${icon(typeIcon(type), 13)}<span>${esc(label || TYPES[type]?.label || 'a card')}</span></span>`;
const when = at => `<span title="${esc(new Date(at).toLocaleString())}">${ago(at)}</span>`;
const avatar = (by, name) => avatarHtml(by, name, { key: by || name || '?' });
function dayOf(at) {
  const d = new Date(at), t = new Date();
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}

/* ---------- the panel ---------- */
export function toggle(on = !open) {
  if (VIEW) return;
  open = on;
  el.hidden = !open;
  $('#historyBtn')?.classList.toggle('open', open);
  if (open) {
    toggleComments(false); toggleAi(false);
    if (drawerPanel) { setPanel(null); renderPanel(); }
    dispatchEvent(new CustomEvent('nk:panel', { detail: 'history' }));
    if (!vers) loadFeed();
    paint();
  } else vers = null;
}

/** Open a card's versions (from its menu, or an activity entry). */
export function openVersions(item, label = '', type = '') {
  const it = S.items[item];
  vers = { item, label: label || (it ? plain(TYPES[it.type]?.text?.(it) || '').slice(0, 80) : ''), type: type || it?.type || 'note', list: null, names: {}, sel: null, data: new Map() };
  if (!open) toggle(true); else paint();
  loadVersions();
}

async function loadFeed(more = false) {
  const key = SPACE + '|' + cur;
  if (!more && feed?.key !== key) feed = { key, entries: [], names: {}, more: false, busy: true };
  const f = feed;
  const before = more ? f.entries.at(-1)?.at : 0;
  try {
    const r = await api(`history?space=${encodeURIComponent(SPACE)}&board=${encodeURIComponent(cur)}` + (before ? '&before=' + before : ''));
    if (feed !== f) return;
    f.entries = more ? f.entries.concat(r.entries) : r.entries;
    Object.assign(f.names, r.names); f.more = r.more;
  } catch (e) { if (feed === f && !more) f.error = e.message; }
  f.busy = false; lastLoad = Date.now();
  if (open && !vers) paint();
}

async function loadVersions() {
  const v = vers;
  try {
    const r = await api(`history/item?space=${encodeURIComponent(SPACE)}&id=${encodeURIComponent(v.item)}`);
    if (vers !== v) return;
    v.list = r.versions; v.names = r.names;
  } catch (e) { if (vers === v) v.error = e.message; }
  lastLoad = Date.now();
  if (open && vers === v) paint();
}

function head(title, back) {
  return `<div class="dr-head">${back ? `<button class="icon-btn" data-back title="Board activity">${icon('arrowLeft', 16)}</button>` : ''}<b>${title}</b><span class="dr-sub"></span>` +
    `<button class="icon-btn" data-x title="Close">${icon('close', 16)}</button></div>`;
}

export function paint() {
  if (!open || !S) return;
  if (vers) return paintVersions();
  if (!feed || feed.key !== SPACE + '|' + cur) { loadFeed(); }
  const f = feed;
  let day = '', rows = '';
  f.entries.forEach((e, i) => {
    const d = dayOf(e.at);
    if (d !== day) { day = d; rows += `<div class="hs-day">${esc(d)}</div>`; }
    rows += entryHtml(e, i);
  });
  el.innerHTML = head('Activity') +
    `<div class="hs-list">${rows || (f.busy ? '<div class="dr-empty">Loading…</div>'
      : `<div class="dr-empty">${f.error ? esc(f.error) : 'Changes to this board and its cards show up here: who added, edited, moved or deleted what, and when.'}</div>`)}` +
    (f.more ? '<button class="btn ghost hs-more" data-more>Show older</button>' : '') + '</div>' +
    `<div class="dr-foot">Kept for 90 days. Click a card’s change to see its versions.</div>`;
}

function entryHtml(e, i) {
  if (e.k === 'comment') {
    const name = e.guest ? e.name + ' (guest)' : feed.names[e.by] || e.name;
    const it = S.items[e.item];
    return `<button class="hs-row" data-e="${i}">${avatar(e.by, name)}<span class="hs-main"><span><b>${esc(name)}</b> commented on ` +
      `${it ? cardThing(it.type, plain(TYPES[it.type]?.text?.(it) || '').slice(0, 60)) : 'a card'}</span>` +
      `<span class="hs-quote">“${esc(e.label)}”</span><small>${when(e.at)}</small></span></button>`;
  }
  const name = feed.names[e.by] || 'Someone';
  let what;
  if (e.k === 'board') {
    what = e.act === 'create' ? 'created this board' : e.act === 'edit' && e.f.includes('title') ? `renamed this board to “${esc(e.label)}”` : 'changed this board';
  } else {
    const { v, more } = verb(e);
    what = `${v} ${cardThing(e.type, e.label)}${more ? ` <span class="hs-what">(${esc(more)})</span>` : ''}`;
  }
  return `<button class="hs-row" data-e="${i}"${e.k === 'board' ? ' data-static' : ''}>${avatar(e.by, name)}<span class="hs-main"><span><b>${esc(name)}</b> ${what}</span>` +
    `<small>${when(e.at)}${e.n > 1 ? ` · ${e.n} changes` : ''}</small></span></button>`;
}

function paintVersions() {
  const v = vers, it = S.items[v.item];
  const mayRestore = it ? can(it.board, 'editor') : can(cur, 'editor');
  let body;
  if (v.error) body = `<div class="dr-empty">${esc(v.error)}</div>`;
  else if (!v.list) body = '<div class="dr-empty">Loading…</div>';
  else if (!v.list.length) body = '<div class="dr-empty">No changes to this card in the last 90 days.</div>';
  else body = v.list.map((x, i) => {
    const name = x.by ? v.names[x.by] || 'Someone' : '';
    const label = x.act === 'earlier' ? 'Before the changes below'
      : x.act === 'delete' ? `Deleted by ${esc(name)}`
      : x.act === 'create' ? `Added by ${esc(name)}`
      : x.act === 'restore' ? `Brought back by ${esc(name)}`
      : `${esc(name)} ${verb(x).v}${verb(x).more ? ` <span class="hs-what">(${esc(verb(x).more)})</span>` : ''}`;
    const meta = x.at ? `${when(x.at)}${x.n > 1 ? ` · ${x.n} changes` : ''}` : '';
    const on = v.sel === i;
    const pick = x.ref ? ` data-v="${i}"` : ' data-static';
    let prev = '';
    if (on) {
      const data = x.ref === 'current' ? it : v.data.get(x.ref);
      prev = `<div class="hs-prev">${data ? '<div class="hs-mini"></div>' : '<div class="dr-empty">Loading…</div>'}` +
        (data && x.ref !== 'current' && mayRestore ? `<button class="btn" data-restore>${icon('undo', 14)} Restore this version</button>` : '') + '</div>';
    }
    return `<div class="hs-ver${on ? ' on' : ''}"><button class="hs-vrow"${pick}>${x.by ? avatar(x.by, name) : `<span class="av hs-none">${icon('undo', 12)}</span>`}` +
      `<span class="hs-main"><span>${label}${x.ref === 'current' ? ' <i class="hs-now">Current</i>' : ''}</span><small>${meta}</small></span></button>${prev}</div>`;
  }).join('');
  el.innerHTML = head('Version history', true) +
    `<div class="cmt-top">${cardThing(v.type, v.label)}${it ? '' : '<span class="hs-gone">Deleted</span>'}</div>` +
    `<div class="hs-list">${body}</div>` +
    `<div class="dr-foot">${mayRestore ? 'Restoring keeps the card where it is now. Undo takes it back.' : 'You can look at earlier versions; people who can edit this board can restore them.'}</div>`;
  const mini = $('.hs-mini', el);
  if (mini) {
    const x = v.list[v.sel];
    mini.appendChild(miniCard(x.ref === 'current' ? it : v.data.get(x.ref)));
  }
}

async function pickVersion(i) {
  const v = vers, x = v.list[i];
  v.sel = v.sel === i ? null : i;
  paint();
  if (v.sel === null || x.ref === 'current' || v.data.has(x.ref)) return;
  try {
    const r = await api(`history/version?space=${encodeURIComponent(SPACE)}&ref=${encodeURIComponent(x.ref)}`);
    v.data.set(x.ref, r.item);
  } catch (e) { toast(e.message); v.sel = null; }
  if (vers === v) paint();
}

/** Put a card back the way it was in a version: its content, colour and size; it stays where it is now. */
function restore(data) {
  const id = vers.item, now = S.items[id];
  if (!now && data.type === 'board') return toast('Restore this board from the Trash');
  const out = structuredClone(data);
  if (now) {
    for (const k of ['board', 'col', 'x', 'y', 'z', 'order', 'locked', 'lockedBy']) { if (k in now) out[k] = now[k]; else delete out[k]; }
  } else {
    if (!S.boards[out.board] || !can(out.board, 'editor')) { out.board = cur; out.col = null; }
    if (out.col && !S.items[out.col]) out.col = null;
  }
  checkpoint();
  S.items[id] = out;
  if (!now) {
    // it's back, so it leaves the Trash
    S.trash = S.trash.map(t => (t.items?.some(x => x.id === id) ? { ...t, items: t.items.filter(x => x.id !== id) } : t))
      .filter(t => t.type === 'workspace' || t.items?.length || t.boards?.length);
  }
  save(); renderBoard();
  if (out.board === cur) { selectOnly(id); centerOn(out.col || id); }
  toast(now ? 'Version restored' : 'Card restored', 'Undo', undo);
  vers.sel = null;
  paint();
  flush().then(loadVersions);
}

/** After a pull: keep what's shown up to date. */
export function refreshHistory() {
  if (!open || Date.now() - lastLoad < 1500) return;
  if (vers) loadVersions(); else loadFeed();
}

export function init() {
  const b = $('#historyBtn');
  if (VIEW) { b.hidden = true; return; }
  b.innerHTML = icon('history', 16);
  b.addEventListener('click', () => { if (open && vers) { vers = null; loadFeed(); paint(); } else toggle(); });
  el.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.matches('[data-x]')) return toggle(false);
    if (t.matches('[data-back]')) { vers = null; loadFeed(); return paint(); }
    if (t.matches('[data-more]')) { t.disabled = true; return loadFeed(true); }
    if (t.matches('[data-restore]')) { const x = vers.list[vers.sel]; const d = vers.data.get(x.ref); return d && restore(d); }
    if (t.dataset.v !== undefined) return pickVersion(+t.dataset.v);
    if (t.dataset.e === undefined || t.matches('[data-static]')) return;
    const x = feed.entries[+t.dataset.e];
    if (x.k === 'comment') return S.items[x.item] ? openThread(x.item) : toast('That card isn’t here any more');
    if (S.items[x.item]?.board === cur) { selectOnly(x.item); centerOn(S.items[x.item].col || x.item); }
    openVersions(x.item, x.label, x.type);
  });
  addEventListener('nk:panel', e => { if (open && e.detail !== 'history') toggle(false); });
  addEventListener('nk:space', () => { vers = null; feed = null; if (open) paint(); });
  addEventListener('hashchange', () => setTimeout(() => { if (open && !vers) paint(); }, 0));
  // your own changes show up too, a little later
  setInterval(() => { if (open && !document.hidden && Date.now() - lastLoad > 10000) (vers ? loadVersions() : loadFeed()); }, 5000);
}
