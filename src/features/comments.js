/*
 * Comments on cards: one thread per card, with @mentions, reactions and resolve / reopen.
 * - pulls bring comments with the board's other changes (S.comments, S.threads, S.cnames); writes go through
 *   /api/comments, and what the server answers is shown at once.
 * - a speech-bubble badge on a card opens its thread in the Comments panel; comment cards show their thread inline.
 * - on a comment link, guests comment without an account under a name; this browser keeps a key (localStorage) that
 *   lets them edit and delete their own comments. On a view link, comments can be read.
 */
import { $, $$, esc } from '../core/util.js';
import { api } from '../core/api.js';
import { LINK, S, SPACE, VIEW, can, cur, els, flush, user } from '../core/store.js';
import { syncedItem } from '../core/sync.js';
import { ago } from '../core/sanitize.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { rebuildCard, renderBoard } from '../canvas/render.js';
import { selectOnly } from '../canvas/selection.js';
import { centerOn } from '../canvas/viewport.js';
import { openBoard } from '../app/navigation.js';
import { confirmDialog } from '../ui/modal.js';
import { TYPES } from '../cards/types.js';
import { hue } from '../ui/presence.js';
import { renderPanel, setPanel, panel as drawerPanel } from '../ui/drawer.js';
import { toggle as toggleAi } from '../ui/ai.js';
import { plain } from '../ui/search.js';
import { openModal, closeModal } from '../ui/modal.js';

export const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'];
const MENTION = /<@(u_[a-f0-9]{20})>/g;

/* ---------- data ---------- */
export function initComments(st) { st.comments ||= {}; st.threads ||= {}; st.cnames ||= {}; }

/** Comments from a pull. $full: the server sent everything, so anything else is gone. Returns whether something changed. */
export function takeComments(res, full) {
  initComments(S);
  const had = full && (Object.keys(S.comments).length || Object.keys(S.threads).length);
  if (full) { S.comments = {}; S.threads = {}; }
  Object.assign(S.cnames, res.names || {});
  for (const c of res.comments || []) c.del ? delete S.comments[c.id] : (S.comments[c.id] = c);
  for (const [item, t] of Object.entries(res.threads || {})) t ? (S.threads[item] = t) : delete S.threads[item];
  return !!(had || res.comments?.length || Object.keys(res.threads || {}).length);
}

export const commentsOf = id => Object.values(S?.comments || {}).filter(c => c.item === id).sort((a, b) => a.at - b.at);
export const resolved = id => !!S?.threads?.[id];
const nameOf = id => S.cnames?.[id] || (id === user?.id ? user.name : id?.startsWith('a_') ? 'A guest' : 'Someone');
const canComment = id => !!S.items[id] && (VIEW ? LINK.role === 'commenter' : can(S.items[id].board, 'commenter'));
/** The author as shown: guests (comment links) are marked. */
export const author = c => (c.g ? c.name + ' (guest)' : c.name);
const avatar = c => `<span class="av" style="--h:${hue(c.by || c.g || c.name)}">${esc(c.name.trim()[0]?.toUpperCase() || '?')}</span>`;

/* ---------- guests on a comment link ---------- */
function guest() {
  let g = null;
  try { g = JSON.parse(localStorage.getItem('nk-guest') || 'null'); } catch {}
  if (!/^[a-f0-9]{16}$/.test(g?.aid || '') || !/^[a-f0-9]{32}$/.test(g?.secret || '')) {
    const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
    g = { aid: hex(8), secret: hex(16), name: g?.name || '' };
    localStorage.setItem('nk-guest', JSON.stringify(g));
  }
  return g;
}
/** Who you are in reactions: your id, or "a_" + your guest id. */
const me = () => (VIEW ? 'a_' + guest().aid : user?.id);
const isMine = c => (VIEW ? !!c.g && c.g === guest().aid : c.by === user?.id);
/** Ask a guest for the name their comments show with (asked once, kept in this browser). */
function askName() {
  return new Promise(resolve => {
    let done = false;
    const card = openModal(`<h2>What’s your name?</h2><p>It shows with your comments. You don’t need an account.</p>` +
      `<form><input class="field" name="name" maxlength="60" placeholder="Your name" autocomplete="name" required>` +
      `<div class="m-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="submit">Continue</button></div></form>`,
      { onClose: () => { if (!done) resolve(null); } });
    const inp = $('input', card); inp.value = guest().name; inp.focus();
    $('form', card).onsubmit = e => {
      e.preventDefault();
      const name = inp.value.trim().replace(/\s+/g, ' '); if (!name) return;
      localStorage.setItem('nk-guest', JSON.stringify({ ...guest(), name }));
      done = true; closeModal(); resolve(name);
    };
  });
}
/** Where comment writes go, and what they carry: a guest's identity and the link's password key. */
const path = id => (VIEW ? `shared/${VIEW}/comments` : 'comments') + (id ? '/' + id : '');
const as = body => (VIEW ? { ...body, aid: guest().aid, secret: guest().secret, name: guest().name, k: LINK.key } : body);

/** Comment text as HTML: escaped, with @mentions highlighted. */
export function bodyHtml(body) {
  return esc(body).replace(/&lt;@(u_[a-f0-9]{20})&gt;/g, (_, id) => `<span class="mention${id === user?.id ? ' me' : ''}">@${esc(nameOf(id))}</span>`);
}
/** Comment text as plain text, mentions as @Name. */
export const bodyText = body => body.replace(MENTION, (_, id) => '@' + nameOf(id));

function put(c) { if (c?.id) { S.comments[c.id] = c; changed(c.item); } }
/** Redraw what shows a card's comments: its card on the board and the panel. */
function changed(item) {
  if (S.items[item] && els.has(item)) rebuildCard(item);
  paintButton();
  if (open) paint();
}

/* ---------- writes ---------- */
export async function addComment(item, body) {
  try {
    if (VIEW && !guest().name && !await askName()) return false;
    if (!VIEW && !syncedItem(item)) await flush();   // a card made a moment ago: the server needs it first
    const r = await api(path(), { method: 'POST', body: as({ space: SPACE, item, body }) });
    delete S.threads[item]; put(r.comment);
    return true;
  } catch (e) { toast(e.message); return false; }
}
async function editComment(id, body) {
  try { put((await api(path(id), { method: 'PATCH', body: as({ body }) })).comment); return true; }
  catch (e) { toast(e.message); return false; }
}
async function deleteComment(id) {
  const c = S.comments[id]; if (!c) return;
  if (!await confirmDialog('Delete this comment?', { body: 'This can’t be undone.', ok: 'Delete', danger: true })) return;
  try { await api(path(id), { method: 'DELETE', body: as({}) }); delete S.comments[id]; changed(c.item); }
  catch (e) { toast(e.message); }
}
async function react(id, emoji) {
  try { put((await api(path(id) + '/react', { method: 'POST', body: as({ emoji }) })).comment); }
  catch (e) { toast(e.message); }
}
async function setResolved(item, on) {
  try {
    await api('comments/resolve', { method: 'POST', body: { space: SPACE, item, resolved: on } });
    if (on) S.threads[item] = { at: Date.now(), by: user.id }; else delete S.threads[item];
    changed(item);
    if (on) toast('Thread resolved');
  } catch (e) { toast(e.message); }
}

/* ---------- @mentions ---------- */
const people = new Map();   // "space|board" -> { at, list }
async function peopleOn(board) {
  if (VIEW) return [];   // guests can't @mention
  const k = SPACE + '|' + board, hit = people.get(k);
  if (hit && Date.now() - hit.at < 60000) return hit.list;
  try {
    const list = (await api(`comments/people?space=${encodeURIComponent(SPACE)}&board=${encodeURIComponent(board)}`)).people;
    for (const p of list) S.cnames[p.id] = p.name;
    people.set(k, { at: Date.now(), list });
    return list;
  } catch { return []; }
}

/**
 * @mention picking for a text field: typing "@" lists the people who can see the board; picking one writes "@Name".
 * Returns a function turning the field's text into what's sent ("@Name" → "<@id>").
 */
function mentions(field, board, picked = new Map()) {   // picked: name -> id
  const menu = document.createElement('div');
  menu.className = 'mention-list'; menu.hidden = true;
  field.parentElement.appendChild(menu);
  let list = [], active = 0, start = -1;
  const query = () => {
    const before = field.value.slice(0, field.selectionStart);
    const m = before.match(/(^|\s)@([^\s@]{0,30})$/);
    return m ? { at: before.length - m[2].length - 1, q: m[2].toLowerCase() } : null;
  };
  const close = () => { menu.hidden = true; start = -1; };
  const choose = p => {
    const end = field.selectionStart;
    field.value = field.value.slice(0, start) + '@' + p.name + ' ' + field.value.slice(end);
    const caret = start + p.name.length + 2;
    field.setSelectionRange(caret, caret);
    picked.set(p.name, p.id);
    close(); field.focus();
    field.dispatchEvent(new Event('input'));
  };
  const show = async () => {
    const q = query();
    if (!q) return close();
    const all = (await peopleOn(board)).filter(p => p.id !== user.id);
    list = all.filter(p => p.name.toLowerCase().includes(q.q) || p.email.toLowerCase().startsWith(q.q)).slice(0, 6);
    if (!list.length) return close();
    start = q.at; active = Math.min(active, list.length - 1);
    menu.innerHTML = list.map((p, i) => `<button type="button" class="${i === active ? 'on' : ''}" data-i="${i}"><span class="av" style="--h:${hue(p.id)}">${esc(p.name.trim()[0]?.toUpperCase() || '?')}</span><b>${esc(p.name)}</b><small>${esc(p.email)}</small></button>`).join('');
    menu.hidden = false;
  };
  field.addEventListener('input', () => { active = 0; show(); });
  field.addEventListener('blur', () => setTimeout(close, 150));
  field.addEventListener('keydown', e => {
    if (menu.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length; show(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); choose(list[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  menu.addEventListener('pointerdown', e => { e.preventDefault(); const b = e.target.closest('[data-i]'); if (b) choose(list[+b.dataset.i]); });
  return {
    text() {
      let s = field.value.trim();
      for (const [name, id] of picked) s = s.split('@' + name).join(`<@${id}>`);
      return s;
    },
    /** Start from a comment's text (editing): its mentions become "@Name" again. */
    load(body) {
      field.value = body.replace(MENTION, (_, id) => { picked.set(nameOf(id), id); return '@' + nameOf(id); });
    },
  };
}

/* ---------- what cards show ---------- */
/** Badge (open comments) or, on hover, an "add a comment" button, for every card but comment cards. */
export function badgeHtml(it) {
  if (it.type === 'comment' || !S) return '';
  const n = resolved(it.id) ? 0 : commentsOf(it.id).length;
  if (n) return `<button class="cm-badge" data-cm data-nodrag title="${n} comment${n === 1 ? '' : 's'}">${icon('comment', 13)}<b>${n}</b></button>`;
  return canComment(it.id) ? `<button class="cm-add" data-cm data-nodrag title="Comment">${icon('comment', 13)}</button>` : '';
}
export function mountBadge(el, it) {
  $(':scope > [data-cm]', el)?.addEventListener('click', e => { e.stopPropagation(); openThread(it.id); });
}

/** A comment card: its thread, and a reply field for people who may comment. */
export function commentCardHtml(it) {
  const list = commentsOf(it.id);
  const rows = list.map(c => `<div class="cm-row" data-open>${avatar(c)}` +
    `<div class="cm-main"><div class="cm-meta"><b>${esc(author(c))}</b> · ${ago(c.at)}${c.ed ? ' · edited' : ''}</div><div class="cm-text">${bodyHtml(c.body)}</div>` +
    reactsHtml(c, false) + '</div></div>').join('');
  return (resolved(it.id) ? `<div class="cm-resolved" data-open>${icon('check', 13)} Resolved</div>` : '') + rows +
    (canComment(it.id) ? `<div class="cm-reply" data-nodrag><input placeholder="${list.length ? 'Reply…' : 'Write a comment…'}${VIEW ? '' : ' (@ to mention)'}"></div>` : '');
}
export function mountCommentCard(el, it) {
  el.addEventListener('click', e => { if (e.target.closest('[data-open]')) openThread(it.id); });
  const inp = $('.cm-reply input', el); if (!inp) return;
  const m = mentions(inp, it.board);
  inp.addEventListener('keydown', async e => {
    if (e.key === 'Escape') return inp.blur();
    if (e.key !== 'Enter' || e.defaultPrevented || !inp.value.trim()) return;
    e.preventDefault();
    const body = m.text(); inp.disabled = true;
    if (await addComment(it.id, body)) $('.cm-reply input', els.get(it.id))?.focus();
    else inp.disabled = false;
  });
}

function reactsHtml(c, buttons) {
  const r = Object.entries(c.r || {}).filter(([, who]) => who.length);
  if (!r.length) return '';
  return `<div class="cmt-reacts">${r.map(([e, who]) => `<button class="cmt-react${who.includes(me()) ? ' mine' : ''}" ${buttons ? `data-react="${e}"` : 'tabindex="-1"'} title="${esc(who.map(nameOf).join(', '))}">${e}<b>${who.length}</b></button>`).join('')}</div>`;
}

/* ---------- the Comments panel ---------- */
const el = $('#commentsPanel');
let open = false, thread = null, tab = 'open', editing = null, picking = null;
let draft = { item: null, text: '', picked: new Map() };   // the reply being written, kept while the panel redraws

export function toggle(on = !open) {
  open = on;
  el.hidden = !open;
  $('#commentsBtn')?.classList.toggle('open', open);
  if (open) {
    toggleAi(false);
    if (drawerPanel) { setPanel(null); renderPanel(); }
    dispatchEvent(new CustomEvent('nk:panel', { detail: 'comments' }));
    paint();
  } else { thread = null; editing = null; }
}

/** Open a card's thread (from its badge, a comment card, or a notification). */
export function openThread(item) {
  const it = S.items[item]; if (!it) return toast('That card isn’t here any more');
  if (it.board !== cur) openBoard(it.board);
  thread = item; editing = null; picking = null;
  selectOnly(item); centerOn(it.col || item);
  toggle(true);
  setTimeout(() => $('.cmt-compose textarea', el)?.focus(), 30);
}

/** The number on the Comments button: open threads on this board. */
export function paintButton() {
  const b = $('#commentsBtn'); if (!b || !S) return;
  const n = threadsOn(cur).filter(t => !t.done).length;
  b.innerHTML = icon('comment', 15) + '<span>Comments</span>' + (n ? `<i class="cm-count">${n}</i>` : '');
  b.hidden = VIEW && LINK.role !== 'commenter' && !Object.keys(S.comments || {}).length;
}

/** Cards on a board with comments: [{ item, list, done }], most recent activity first. */
function threadsOn(board) {
  const by = new Map();
  for (const c of Object.values(S.comments || {})) {
    const it = S.items[c.item];
    if (!it || it.board !== board) continue;
    (by.get(c.item) || by.set(c.item, []).get(c.item)).push(c);
  }
  return [...by].map(([item, list]) => ({ item, list: list.sort((a, b) => a.at - b.at), done: resolved(item) }))
    .sort((a, b) => b.list.at(-1).at - a.list.at(-1).at);
}

function cardLabel(it) {
  const T = TYPES[it.type];
  const text = plain(T?.text?.(it) || '').slice(0, 60);
  return `<span class="cmt-card">${icon(it.type in { note: 1, todo: 1, link: 1, board: 1, column: 1, comment: 1 } ? it.type : 'note', 14)}<span>${esc(text || T?.label || 'Card')}</span></span>`;
}

export function paint() {
  if (!open || !S) return;
  if (thread && !S.items[thread]) thread = null;
  if (thread && S.items[thread].board !== cur) thread = null;
  paintButton();
  const ta = $('.cmt-compose textarea', el), focused = ta && document.activeElement === ta, caret = ta?.selectionStart;
  if (ta && draft.item === thread) draft.text = ta.value;
  if (draft.item !== thread) draft = { item: thread, text: '', picked: new Map() };
  if (!thread) return paintList();
  paintThread();
  const next = $('.cmt-compose textarea', el);
  if (next && draft.text) { next.value = draft.text; if (focused) { next.focus(); next.setSelectionRange(caret, caret); } }
}

function head(title, back) {
  return `<div class="dr-head">${back ? `<button class="icon-btn" data-back title="All comments">${icon('arrowLeft', 16)}</button>` : ''}<b>${title}</b><span class="dr-sub"></span>` +
    `<button class="icon-btn" data-x title="Close">${icon('close', 16)}</button></div>`;
}

function paintList() {
  const all = threadsOn(cur), shown = all.filter(t => (tab === 'open') !== t.done);
  const nOpen = all.filter(t => !t.done).length;
  el.innerHTML = head('Comments') +
    `<div class="cmt-tabs"><button class="${tab === 'open' ? 'on' : ''}" data-tab="open">Open${nOpen ? ` (${nOpen})` : ''}</button><button class="${tab === 'done' ? 'on' : ''}" data-tab="done">Resolved${all.length - nOpen ? ` (${all.length - nOpen})` : ''}</button></div>` +
    `<div class="cmt-list">${shown.length ? shown.map(t => {
      const last = t.list.at(-1);
      return `<button class="cmt-thread" data-thread="${esc(t.item)}">${cardLabel(S.items[t.item])}` +
        `<span class="cmt-last"><b>${esc(author(last))}</b> ${esc(bodyText(last.body).slice(0, 120))}</span>` +
        `<small>${t.list.length} comment${t.list.length === 1 ? '' : 's'} · ${ago(last.at)}</small></button>`;
    }).join('') : `<div class="dr-empty">${tab === 'open'
      ? `No open comments on this board.${canComment(Object.values(S.items).find(i => i.board === cur)?.id) ? '<br><br>To comment on a card, hover it and click the speech bubble in its corner.' : ''}`
      : 'Resolved threads show up here.'}</div>`}</div>`;
}

function paintThread() {
  const it = S.items[thread], list = commentsOf(thread), done = resolved(thread), mayComment = canComment(thread);
  const owner = !VIEW && can(it.board, 'owner');
  const res = S.threads[thread];
  el.innerHTML = head('Comments', true) +
    `<div class="cmt-top">${cardLabel(it)}${mayComment && !VIEW && list.length ? `<button class="btn ghost sm" data-resolve>${done ? 'Reopen' : `${icon('check', 14)} Resolve`}</button>` : ''}</div>` +
    (done ? `<div class="cmt-done">${icon('check', 13)} Resolved by ${esc(nameOf(res.by))} · ${ago(res.at)}</div>` : '') +
    `<div class="cmt-list">${list.map(c => {
      const mine = isMine(c);
      const acts = mayComment || mine || owner
        ? `<span class="cmt-acts">${mayComment ? `<button data-pick title="React">${icon('smile', 14)}</button>` : ''}${mine && mayComment ? `<button data-edit title="Edit">${icon('edit', 14)}</button>` : ''}${mine || owner ? `<button data-del title="Delete">${icon('trash', 14)}</button>` : ''}</span>` : '';
      const body = editing === c.id
        ? `<div class="cmt-editbox"><textarea rows="3"></textarea><div><button class="btn sm" data-save>Save</button><button class="btn ghost sm" data-cancel>Cancel</button></div></div>`
        : `<div class="cmt-body">${bodyHtml(c.body)}</div>`;
      return `<div class="cmt" data-c="${esc(c.id)}">${avatar(c)}` +
        `<div class="cmt-main"><div class="cmt-meta"><b>${esc(author(c))}</b><span>${ago(c.at)}${c.ed ? ' <i>(edited)</i>' : ''}</span>${acts}</div>${body}` +
        (picking === c.id ? `<div class="cmt-pick">${REACTIONS.map(e => `<button data-react="${e}">${e}</button>`).join('')}</div>` : '') +
        reactsHtml(c, mayComment) + '</div></div>';
    }).join('') || '<div class="dr-empty">No comments yet.</div>'}</div>` +
    (mayComment ? `<div class="cmt-compose"><textarea rows="2" placeholder="${list.length ? 'Reply' : 'Comment'}… (${VIEW ? '' : '@ to mention, '}Enter to send)"></textarea><button class="icon-btn" data-send title="Send">${icon('send', 16)}</button></div>` : '');
  const ta = $('.cmt-compose textarea', el);
  if (ta) {
    const m = mentions(ta, it.board, draft.picked);
    ta.addEventListener('input', () => { draft.text = ta.value; });
    const send = async () => {
      if (!ta.value.trim()) return;
      const body = m.text(), was = ta.value;
      ta.value = draft.text = ''; ta.disabled = true;
      if (await addComment(thread, body)) { $('.cmt-compose textarea', el)?.focus(); const l = $('.cmt-list', el); l.scrollTop = l.scrollHeight; return; }
      const t = $('.cmt-compose textarea', el) || ta;
      t.value = draft.text = was; t.disabled = false; t.focus();
    };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) { e.preventDefault(); send(); } });
    $('[data-send]', el).onclick = send;
  }
  const box = $('.cmt-editbox textarea', el);
  if (box) {
    const m = mentions(box, it.board);
    m.load(S.comments[editing].body);
    box.focus(); box.setSelectionRange(box.value.length, box.value.length);
    const save = async () => { if (box.value.trim() && await editComment(editing, m.text())) { editing = null; paint(); } };
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { editing = null; paint(); }
    });
    $('[data-save]', el).onclick = save;
  }
  const l = $('.cmt-list', el); if (!editing && !picking) l.scrollTop = l.scrollHeight;
}

export function init() {
  $('#commentsBtn').addEventListener('click', () => toggle());
  addEventListener('nk:panel', e => { if (open && e.detail !== 'comments') toggle(false); });
  el.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.matches('[data-x]')) return toggle(false);
    if (t.matches('[data-back]')) { thread = null; return paint(); }
    if (t.dataset.tab) { tab = t.dataset.tab; return paint(); }
    if (t.dataset.thread) return openThread(t.dataset.thread);
    if (t.matches('[data-resolve]')) return setResolved(thread, !resolved(thread));
    if (t.matches('[data-cancel]')) { editing = null; return paint(); }
    const id = t.closest('[data-c]')?.dataset.c; if (!id) return;
    if (t.matches('[data-pick]')) { picking = picking === id ? null : id; return paint(); }
    if (t.dataset.react) { picking = null; return react(id, t.dataset.react); }
    if (t.matches('[data-edit]')) { editing = id; picking = null; return paint(); }
    if (t.matches('[data-del]')) return deleteComment(id);
  });
  addEventListener('nk:space', () => { thread = null; if (open) paint(); else paintButton(); });
  addEventListener('hashchange', () => setTimeout(() => (open ? paint() : paintButton()), 0));
  // relative times
  setInterval(() => { if (open && !editing && !document.activeElement?.closest?.('#commentsPanel')) paint(); }, 60000);
}

/** After a board redraw or a pull. */
export function refreshComments() { paintButton(); if (open && !editing) paint(); }
