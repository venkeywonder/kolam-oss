/*
 * In-app notifications: the bell in the top bar. The realtime server (or the presence poll) says when the newest
 * notification arrived; when that's newer than what we have, the list is fetched again.
 */
import { $, esc } from '../core/util.js';
import { api } from '../core/api.js';
import { S, SPACE, VIEW, cur, user } from '../core/store.js';
import { ago } from '../core/sanitize.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { hue } from './presence.js';
import { openBoard } from '../app/navigation.js';
import { showSpaces, switchSpace } from '../features/spaces.js';
import { openThread } from '../features/comments.js';

const btn = $('#bellBtn'), el = $('#notifPanel');
let items = [], unread = 0, latest = 0, off = [], loading = null, settings = false;

const PREFS = [['mention', 'When someone @mentions me'], ['reply', 'Replies in threads I’m in'],
  ['guest', 'Guest comments through my links'], ['access', 'Invitations, role changes and people joining']];

async function fetchList() {
  loading ||= api('notifications').then(r => { ({ items, unread, latest, off } = r); paint(); }).catch(() => {}).finally(() => { loading = null; });
  return loading;
}

/** The newest notification is from time $at: fetch if that's news. */
export function noteSeen(at) {
  if (VIEW || !user || !(at > latest)) return;
  const first = latest === 0 && !items.length;
  latest = at;
  fetchList().then(() => {
    const n = items[0];
    if (!first && n && !n.read && el.hidden) toast(`${n.actor || 'Someone'} ${what(n)}`);
  });
}

function what(n) {
  const where = n.where ? ` in “${n.where}”` : '';
  if (n.kind === 'mention') return `mentioned you${where}`;
  if (n.kind === 'reply') return `replied${where}`;
  if (n.kind === 'guest') return `commented with your link${where}`;
  if (n.kind === 'join') return `joined “${n.where || 'a board'}” with a link, ${n.text}`;
  return n.text;
}

function paint() {
  btn.innerHTML = icon('bell', 19) + (unread ? `<i class="nt-dot">${unread > 9 ? '9+' : unread}</i>` : '');
  btn.title = unread ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications';
  if (el.hidden) return;
  let h = `<div class="nt-head"><b>Notifications</b>` +
    (unread ? '<button class="nt-link" data-all>Mark all as read</button>' : '') +
    `<button class="icon-btn sm" data-settings title="Notification settings">${icon('more', 16)}</button></div>`;
  if (settings) {
    h += `<div class="nt-settings"><p>Notify me about:</p>${PREFS.map(([k, l]) =>
      `<label><input type="checkbox" data-pref="${k}"${off.includes(k) ? '' : ' checked'}> ${l}</label>`).join('')}</div>`;
  }
  h += `<div class="nt-list">${items.length ? items.map(n => {
    const text = ['mention', 'reply', 'guest'].includes(n.kind) ? `<span class="nt-q">“${esc(n.text)}”</span>` : '';
    return `<button class="nt-row${n.read ? '' : ' unread'}" data-n="${esc(n.id)}"><span class="av" style="--h:${hue(n.by || n.actor || '?')}">${esc((n.actor || '?').trim()[0]?.toUpperCase() || '?')}</span>` +
      `<span class="nt-main"><span><b>${esc(n.actor || 'Someone')}</b> ${esc(what(n))}</span>${text}<small>${ago(n.at)}</small></span></button>`;
  }).join('') : '<div class="dr-empty">Nothing yet. You’ll hear about mentions, replies to your comments, guest comments and invitations here.</div>'}</div>`;
  el.innerHTML = h;
}

function show(on = el.hidden) {
  el.hidden = !on;
  btn.classList.toggle('open', on);
  if (on) { settings = false; paint(); fetchList(); }
}

async function markRead(body) {
  try { unread = (await api('notifications/read', { method: 'POST', body })).unread; } catch {}
}

async function go(n) {
  show(false);
  if (!n.read) { n.read = true; unread = Math.max(0, unread - 1); paint(); markRead({ ids: [n.id] }); }
  if (n.kind === 'invite') return showSpaces(true);
  if (!n.space) return;
  if (n.space !== SPACE) await switchSpace(n.space, n.board);
  if (n.space !== SPACE) return;   // no access any more (switchSpace said so)
  if (n.board && S.boards[n.board] && cur !== n.board) openBoard(n.board);
  if (n.item) {
    if (S.items[n.item]) openThread(n.item);
    else toast('That card isn’t here any more');
  }
}

export function init() {
  if (VIEW) { btn.hidden = true; return; }
  paint();
  btn.addEventListener('click', () => show());
  addEventListener('nk:space', () => { if (!latest) fetchList(); }, { once: true });
  document.addEventListener('pointerdown', e => { if (!el.hidden && !el.contains(e.target) && !btn.contains(e.target)) show(false); }, true);
  el.addEventListener('click', async e => {
    if (e.target.closest('[data-all]')) { items.forEach(n => (n.read = true)); unread = 0; paint(); return markRead({ all: true }); }
    if (e.target.closest('[data-settings]')) { settings = !settings; return paint(); }
    const row = e.target.closest('[data-n]');
    if (row) go(items.find(n => n.id === row.dataset.n));
  });
  el.addEventListener('change', async e => {
    const k = e.target.dataset?.pref; if (!k) return;
    off = e.target.checked ? off.filter(x => x !== k) : [...off, k];
    try { await api('auth/me', { method: 'PATCH', body: { notifyOff: off } }); toast('Notification settings saved'); }
    catch (err) { toast(err.message); }
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !el.hidden) show(false); });
}
