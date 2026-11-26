/*
 * Poll cards: a question and answers to vote on. An answer is words, a picture, people (@mentions) or any mix of them.
 * A poll takes one answer or several, and can end at a set time; after that it's read-only and shows the final results.
 * - votes go through /api/polls/vote (server/src/Polls.php), never sync: the server keeps who picked what in
 *   data.votes ({ person id: { o: option ids, n: name, at: ms } }), and every answer shows its voters on the card.
 * - commenters and up vote; editors change the question, the answers and the settings while editing the card.
 */
import { $, $$, esc, uid } from '../core/util.js';
import { api, assetUrl } from '../core/api.js';
import { S, SPACE, VIEW, can, checkpoint, editingId, els, flush, save, user } from '../core/store.js';
import { syncedItem, takeItem } from '../core/sync.js';
import { TYPES } from './types.js';
import { rebuildCard } from '../canvas/render.js';
import { caretEnd } from '../canvas/editing.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { avatarHtml } from '../ui/avatars.js';
import { pickDate, ymd } from '../ui/datepicker.js';
import { peopleOn } from '../features/comments.js';
import { uploadPicture } from '../actions/uploads.js';

const pending = new Map();    // card id -> the answers you picked, until the server has your vote
const busy = new Set();       // cards with a vote on its way
const previews = new Map();   // option id -> the picture still uploading for it (object URL)
const timers = new Map();     // card id -> timeout that redraws the card when the poll ends
const VOTERS_SHOWN = 8;
const LANG = navigator.language || 'en-US';
const pad2 = n => String(n).padStart(2, '0');

/* ---------- state ---------- */
/** The poll has an end time, and it has passed: read-only, final results. */
export const ended = it => it?.data?.closes != null && it.data.closes <= Date.now();
const mayVote = it => !VIEW && !!user && can(it.board, 'commenter');
const mine = it => pending.get(it.id) ?? it.data.votes?.[user?.id]?.o ?? [];
const opt = (d, oid) => (d.options ||= []).find(o => o.id === oid);

/** Who picked each answer (in the order they voted), and how many people voted, your vote on its way included. */
function tally(it) {
  const by = new Map((it.data.options || []).map(o => [o.id, []]));
  const votes = Object.entries(it.data.votes || {}).map(([id, v]) => ({ id, ...v }));
  const want = pending.get(it.id);
  if (want && user) {
    const v = votes.find(v => v.id === user.id);
    if (v) v.o = want; else votes.push({ id: user.id, n: user.name, at: Date.now(), o: want });
  }
  votes.sort((a, b) => (a.at || 0) - (b.at || 0));
  let people = 0;
  for (const v of votes) {
    const o = (v.o || []).filter(x => by.has(x));
    if (!o.length) continue;
    people++;
    for (const x of o) by.get(x).push(v);
  }
  return { by, people };
}

const when = ms => {
  const d = new Date(ms);
  return d.toLocaleString(LANG, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });
};
const dayOf = ms => new Date(ms).toLocaleDateString(LANG, { weekday: 'short', month: 'short', day: 'numeric' });
const timeOf = ms => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
const optText = o => [o.t, ...(o.ppl || []).map(p => '@' + p.n)].filter(Boolean).join(' ');

/* ---------- what the card shows ---------- */
function votersHtml(list) {
  if (!list.length) return '';
  const chip = v => `<span class="pl-voter${v.id === user?.id ? ' me' : ''}" title="${esc(v.n || 'Someone')}">${avatarHtml(v.id, v.n)}${v.id === user?.id ? 'You' : esc((v.n || 'Someone').trim().split(/\s+/)[0])}</span>`;
  const rest = list.slice(VOTERS_SHOWN);
  return `<div class="pl-who">${list.slice(0, VOTERS_SHOWN).map(chip).join('')}` +
    (rest.length ? `<span class="pl-more" title="${esc(rest.map(v => v.n || 'Someone').join(', '))}">+${rest.length} more</span>` : '') + '</div>';
}

function optionHtml(o, t, picked, top, votable, closed) {
  const list = t.by.get(o.id) || [], n = list.length, pct = t.people ? Math.round((n / t.people) * 100) : 0;
  const src = previews.get(o.id) || (o.img ? assetUrl(o.img) + '?v=s' : '');
  const ppl = (o.ppl || []).map(p => `<span class="pl-ppl${p.id === user?.id ? ' me' : ''}" data-pid="${esc(p.id)}">@${esc(p.n || 'someone')}` +
    `<button class="pl-x" data-unppl title="Remove ${esc(p.n || 'this person')}">${icon('close', 10)}</button></span>`).join('');
  const lead = n > 0 && n === top;
  const cls = ['pl-opt', picked.includes(o.id) && 'mine', lead && 'win'].filter(Boolean).join(' ');
  return `<div class="${cls}" data-oid="${esc(o.id)}"${votable ? ' data-nodrag' : ''}><span class="pl-mark"></span><div class="pl-main">` +
    (src ? `<div class="pl-img${previews.has(o.id) ? ' up' : ''}"><img src="${esc(src)}" alt="" draggable="false"><button class="pl-x" data-unimg data-nodrag title="Remove picture">${icon('close', 12)}</button></div>` : '') +
    `<div class="pl-line"><span class="pl-text" data-ph="${src || ppl ? 'Add words (optional)' : 'Answer'}">${esc(o.t)}</span>${ppl}</div>` +
    `<div class="pl-bar"><i style="width:${pct}%"></i></div>${votersHtml(list)}</div>` +
    `<span class="pl-n">${lead ? `<em class="pl-lead">${closed ? 'Winner' : 'Top'}</em>` : ''}${n ? `${n}<small>${pct}%</small>` : ''}</span>` +
    `<div class="pl-tools" data-nodrag><button data-img title="${src ? 'Change picture' : 'Add a picture'}">${icon('image', 14)}</button>` +
    `<button data-ppl title="Mention people">@</button><button data-del title="Remove answer">${icon('close', 14)}</button></div></div>`;
}

function html(it) {
  const d = it.data, t = tally(it), closed = ended(it), picked = mine(it);
  const votable = mayVote(it) && !closed;
  const top = Math.max(0, ...[...t.by.values()].map(l => l.length));
  const foot = [t.people ? `${t.people} ${t.people === 1 ? 'person' : 'people'} voted` : 'No votes yet', d.multi ? 'Pick any' : 'Pick one'];
  if (d.closes != null) foot.push(`${closed ? 'Ended' : 'Ends'} ${when(d.closes)}`);
  return `<div class="pl-title" data-ph="Ask a question">${esc(d.title)}</div>` +
    `<div class="pl-opts">${(d.options || []).map(o => optionHtml(o, t, picked, top, votable, closed)).join('')}</div>` +
    `<div class="pl-add" data-nodrag>+ Add an answer</div>` +
    `<div class="pl-set" data-nodrag><label class="pl-multi"><input type="checkbox" data-multi${d.multi ? ' checked' : ''}> Allow several answers</label>` +
    `<div class="pl-end">${icon('calendar', 14)}<button data-ends title="${d.closes != null ? 'Change or remove the end date' : 'The poll closes then and keeps its results'}">${d.closes != null ? 'Ends ' + esc(dayOf(d.closes)) : 'Add an end date'}</button>` +
    (d.closes != null ? `<input type="time" data-time value="${timeOf(d.closes)}" aria-label="End time">` : '') + '</div></div>' +
    `<div class="pl-foot">${closed ? `<span class="pl-closed">${icon('lock', 11)} Closed</span>` : ''}${esc(foot.join(' · '))}</div>`;
}

/* ---------- voting ---------- */
function vote(id, oid) {
  const it = S.items[id]; if (!it || !mayVote(it)) return;
  if (ended(it)) return toast('This poll has ended');
  const have = mine(it);
  const next = it.data.multi ? (have.includes(oid) ? have.filter(x => x !== oid) : [...have, oid])
    : (have.length === 1 && have[0] === oid ? [] : [oid]);   // your answer again takes the vote back
  pending.set(id, next);
  rebuildCard(id);
  send(id);
}

/** Send your latest choice; clicks while a vote is on its way are sent after it, as one. */
async function send(id) {
  if (busy.has(id)) return;
  busy.add(id);
  try {
    while (pending.has(id)) {
      const want = pending.get(id);
      try {
        if (!syncedItem(id)) await flush();   // a poll made a moment ago: the server needs it first
        const r = await api('polls/vote', { method: 'POST', body: { space: SPACE, item: id, options: want } });
        if (pending.get(id) === want) pending.delete(id);
        takeItem(id, r.item);
      } catch (e) { pending.delete(id); toast(e.message); }
    }
  } finally {
    busy.delete(id);
    if (els.has(id)) rebuildCard(id);
  }
}

/* ---------- changing the poll ---------- */
/** Change a poll's data as one step (part of the edit while it's being edited), save it and redraw it. */
function change(id, fn) {
  const cur = S.items[id], el = els.get(id); if (!cur) return null;
  if (editingId === id && el) TYPES.poll.read(el, cur); else checkpoint();
  cur.data.options ||= [];
  fn(cur.data);
  save();
  const a = document.activeElement, was = el?.contains(a) && a.matches('.pl-text') ? a.closest('[data-oid]').dataset.oid : null;
  const nel = rebuildCard(id);
  // while editing, the card keeps the keyboard after a change (so typing goes on, and Esc still closes it)
  if (nel && editingId === id && !nel.contains(document.activeElement)) focusText(nel, was && opt(cur.data, was) ? was : null);
  return nel;
}

/** End the poll at ms (now: close it), or with null take the end date away (reopen it). */
export function setPollEnd(id, ms) {
  change(id, d => { if (ms == null) delete d.closes; else d.closes = ms; });
  toast(ms == null ? 'The poll is open again' : 'Poll closed');
}

function pickImage(id, oid) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    if (!f.type.startsWith('image/') && !/\.(jpe?g|png|gif|webp|avif|svg)$/i.test(f.name)) return toast('Pick a picture');
    const url = URL.createObjectURL(f);
    previews.set(oid, url);
    if (els.has(id)) rebuildCard(id);
    try {
      const a = await uploadPicture(f);
      previews.delete(oid);
      change(id, d => { const o = opt(d, oid); if (o) o.img = a.id; });
    } catch (e) {
      previews.delete(oid);
      toast(`Couldn’t add the picture: ${e.message}`);
      if (els.has(id)) rebuildCard(id);
    } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  };
  inp.click();
}

let picker = null;
function closePicker() { picker?.remove(); picker = null; removeEventListener('pointerdown', outside, true); }
function outside(e) { if (picker && !picker.contains(e.target)) closePicker(); }
/** Mention people in an answer: anyone who can see the board. */
async function pickPeople(anchor, id, oid) {
  closePicker();
  const it = S.items[id]; if (!it) return;
  const el = picker = document.createElement('div');
  el.className = 'pl-pick';
  el.innerHTML = `<input class="field" placeholder="Find someone" spellcheck="false" aria-label="Find someone"><div class="pl-pick-list"><div class="pl-pick-none">Loading…</div></div>`;
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px';
  el.style.top = (r.bottom + el.offsetHeight + 8 > innerHeight ? Math.max(8, r.top - el.offsetHeight - 6) : r.bottom + 6) + 'px';
  addEventListener('pointerdown', outside, true);
  const inp = $('input', el), list = $('.pl-pick-list', el);
  inp.focus();
  const all = await peopleOn(it.board);
  if (picker !== el) return;
  let shown = [], active = 0;
  const paint = () => {
    const q = inp.value.trim().toLowerCase();
    const have = new Set((opt(S.items[id]?.data || {}, oid)?.ppl || []).map(p => p.id));
    shown = all.filter(p => !have.has(p.id) && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().startsWith(q))).slice(0, 8);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length
      ? shown.map((p, i) => `<button type="button" class="${i === active ? 'on' : ''}" data-i="${i}">${avatarHtml(p.id, p.name)}` +
        `<b>${esc(p.name)}${p.id === user?.id ? ' (you)' : ''}</b><small>${esc(p.email)}</small></button>`).join('')
      : `<div class="pl-pick-none">${all.length ? 'Nobody else to add' : 'Nobody to mention here'}</div>`;
  };
  const choose = p => {
    closePicker();
    change(id, d => { const o = opt(d, oid); if (o && !o.ppl?.some(x => x.id === p.id)) (o.ppl ||= []).push({ id: p.id, n: p.name }); });
  };
  inp.addEventListener('input', () => { active = 0; paint(); });
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; paint(); }
    } else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) choose(shown[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
  });
  list.addEventListener('pointerdown', e => e.preventDefault());
  list.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) choose(shown[+b.dataset.i]); });
  paint();
}

/** Put the caret in an answer's words (or the question) of the card as it is now. */
const focusText = (el, oid) => caretEnd(oid ? $(`[data-oid="${oid}"] .pl-text`, el) : $('.pl-title', el));

function onClick(e, id) {
  const it = S.items[id]; if (!it) return;
  const oid = e.target.closest('[data-oid]')?.dataset.oid;
  const b = e.target.closest('button,.pl-add');
  if (b?.matches('[data-unppl]')) {
    const pid = b.closest('[data-pid]').dataset.pid;
    return change(id, d => { const o = opt(d, oid); if (!o) return; o.ppl = (o.ppl || []).filter(p => p.id !== pid); if (!o.ppl.length) delete o.ppl; });
  }
  if (b?.matches('[data-unimg]')) return change(id, d => { const o = opt(d, oid); if (o) delete o.img; });
  if (b?.matches('[data-del]')) {
    let prev = null;
    const el = change(id, d => { const i = d.options.findIndex(o => o.id === oid); if (i < 0) return; prev = d.options[i - 1]?.id || null; d.options.splice(i, 1); });
    if (el && editingId === id) focusText(el, prev);
    return;
  }
  if (b?.matches('[data-img]')) return pickImage(id, oid);
  if (b?.matches('[data-ppl]')) return pickPeople(b, id, oid);
  if (b?.matches('.pl-add')) {
    const o = { id: uid(), t: '' };
    const el = change(id, d => d.options.push(o));
    if (el && editingId === id) focusText(el, o.id);
    return;
  }
  if (b?.matches('[data-ends]')) {
    b.classList.add('picking');
    return pickDate({
      anchor: b, value: it.data.closes != null ? ymd(new Date(it.data.closes)) : null,
      onPick: v => change(id, d => {
        if (!v) { delete d.closes; return; }
        const [y, m, day] = v.split('-').map(Number), was = d.closes != null ? new Date(d.closes) : null;
        d.closes = new Date(y, m - 1, day, was ? was.getHours() : 23, was ? was.getMinutes() : 59).getTime();
      }),
      onClose: () => b.classList.remove('picking'),
    });
  }
  // a click on an answer votes; the second click of a double-click doesn't take it back again
  if (oid && editingId !== id && e.detail < 2 && e.target.closest('.pl-opt[data-nodrag]')) vote(id, oid);
}

function onKey(e, el, id) {
  if (editingId !== id) return;
  const cur = S.items[id];
  const text = e.target.closest('.pl-text'), title = e.target.closest('.pl-title');
  if (!text && !title) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    TYPES.poll.read(el, cur);
    const opts = cur.data.options ||= [];
    if (title && opts.length) return focusText(el, opts[0].id);
    const at = text ? opts.findIndex(x => x.id === text.closest('[data-oid]').dataset.oid) + 1 : 0;
    const next = opts[at];
    // the next answer is still empty (a new poll's second one): go there rather than adding another
    if (next && !next.t && !next.img && !next.ppl?.length) return focusText(el, next.id);
    const o = { id: uid(), t: '' };
    opts.splice(at, 0, o);
    save();
    focusText(rebuildCard(id), o.id);
  } else if (e.key === 'Backspace' && text && !text.innerText.trim()) {
    const opts = cur.data.options || [], i = opts.findIndex(x => x.id === text.closest('[data-oid]').dataset.oid);
    if (i < 0 || opts[i].img || opts[i].ppl?.length) return;   // its picture or people stay: remove it with ×
    e.preventDefault();
    TYPES.poll.read(el, cur);
    opts.splice(i, 1);
    save();
    focusText(rebuildCard(id), opts[i - 1]?.id || null);
  }
}

function onChange(e, id) {
  if (e.target.matches('[data-multi]')) change(id, d => { if (e.target.checked) d.multi = true; else delete d.multi; });
  else if (e.target.matches('[data-time]') && /^\d\d:\d\d$/.test(e.target.value)) {
    const [h, m] = e.target.value.split(':').map(Number);
    change(id, d => { if (d.closes == null) return; const t = new Date(d.closes); t.setHours(h, m, 0, 0); d.closes = t.getTime(); });
  }
}

function mount(el, it) {
  el.classList.toggle('multi', !!it.data.multi);
  el.classList.toggle('closed', ended(it));
  // the card turns read-only by itself when the poll ends while it's on screen
  clearTimeout(timers.get(it.id));
  const left = it.data.closes != null ? it.data.closes - Date.now() : -1;
  if (left > 0 && left < 2 ** 31 - 1) timers.set(it.id, setTimeout(() => { timers.delete(it.id); if (els.has(it.id)) rebuildCard(it.id); }, left + 50));
  el.addEventListener('click', e => onClick(e, it.id));
  el.addEventListener('keydown', e => onKey(e, el, it.id));
  el.addEventListener('change', e => onChange(e, it.id));
  // double-clicking an answer votes, rather than opening the card for editing
  el.addEventListener('dblclick', e => { if (editingId !== it.id && e.target.closest('.pl-opt[data-nodrag]')) e.stopImmediatePropagation(); });
}

export function init() {
  TYPES.poll = {
    label: 'Poll', w: 300, fitH: true,
    init: () => ({ title: '', options: [{ id: uid(), t: '' }, { id: uid(), t: '' }] }),
    html,
    mount,
    edit: el => { $$('.pl-title,.pl-text', el).forEach(n => (n.contentEditable = 'true')); return $('.pl-title', el); },
    read: (el, it) => {
      it.data.title = $('.pl-title', el).innerText.trim();
      for (const n of $$('.pl-opt', el)) { const o = opt(it.data, n.dataset.oid); if (o) o.t = $('.pl-text', n).innerText.replace(/\n/g, ' ').trim(); }
    },
    // answers left with nothing in them go
    stop: (el, it) => {
      const before = (it.data.options ||= []).length;
      it.data.options = it.data.options.filter(o => o.t || o.img || o.ppl?.length || previews.has(o.id));
      return it.data.options.length !== before;
    },
    noEdit: it => (ended(it) ? 'This poll has ended. Reopen it to change it.' : ''),
    text: it => [it.data.title, ...(it.data.options || []).map(optText)].join(' '),
  };
}
