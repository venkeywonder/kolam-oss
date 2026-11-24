/* The Share dialog of a board: people with access, invitations, restricting, links, transfer and move. */
import { $, esc } from '../core/util.js';
import { api } from '../core/api.js';
import { icon } from '../ui/icons.js';
import { SPACE, cur, flush, user } from '../core/store.js';
import { toast } from '../ui/toast.js';
import { closeModal, confirmDialog, openModal } from '../ui/modal.js';
import { ROLE_LABEL, askCards, choose, copyFrom, formerList, inviteForm, invitesList, peopleRow, roleSelect, showSent } from './people.js';
import { contexts, refreshContexts, switchSpace } from './spaces.js';
import { exitEdit } from '../canvas/editing.js';

const BOARD_ROLES = ['editor', 'commenter', 'viewer'];
/** The address of a link: view and comment links show the board; join links add you to it. */
export const linkUrl = l => location.origin + location.pathname + (l.kind === 'join' ? '?join=' : '?view=') + l.token;

function linkWhat(l) {
  if (l.kind === 'view') return 'Anyone with the link can view';
  if (l.kind === 'comment') return 'Anyone with the link can view and comment';
  return `People who sign in join with “${ROLE_LABEL[l.role]}”`;
}
function linkMeta(l) {
  const now = Date.now() / 1000, out = [];
  if (l.expires === null) out.push('No expiry');
  else if (l.expires < now) out.push('<b class="ln-expired">Expired</b>');
  else out.push('Expires ' + (l.expires - now < 86400 ? 'today' : 'in ' + Math.ceil((l.expires - now) / 86400) + ' days'));
  if (l.password) out.push('Password');
  if (l.kind === 'join' && l.uses) out.push(`${l.uses} joined`);
  return out.join(' · ');
}
const LINK_ICON = { view: 'open', comment: 'comment', join: 'userPlus' };
function linksHtml(links) {
  if (!links.length) return '<p class="ln-none">No links yet. A link can let anyone view or comment without an account, or let people with an account join this board.</p>';
  return links.map(l => `<div class="ln-row" data-link="${esc(l.token)}"><div class="ln-top"><span class="pp-av ln-ic">${icon(LINK_ICON[l.kind], 14)}</span>` +
    `<div class="pp-who"><b>${esc(l.label || linkWhat(l))}</b><small>${l.label ? esc(linkWhat(l)) + ' · ' : ''}${linkMeta(l)}</small></div>` +
    `<div class="pp-right"><button class="icon-btn sm" data-edit-link title="Change">${icon('edit', 14)}</button><button class="icon-btn sm" data-del-link title="Turn off">${icon('trash', 14)}</button></div></div>` +
    `<div class="share-row"><input class="field" readonly value="${esc(linkUrl(l))}"><button class="btn ghost sm" data-copy>Copy</button></div></div>`).join('');
}
function linkForm(l) {
  const kind = l ? (l.kind === 'join' ? 'join:' + l.role : l.kind) : 'view';
  const opt = (v, t) => `<option value="${v}"${kind === v ? ' selected' : ''}>${t}</option>`;
  const exp = l?.expires ? `<option value="keep" selected>${l.expires < Date.now() / 1000 ? 'Expired' : 'Expires'} ${esc(new Date(l.expires * 1000).toLocaleDateString())}</option>` : '';
  return `<form class="ln-form"><b>${l ? 'Change link' : 'New link'}</b>` +
    `<label class="ln-f"><span>Label</span><input class="field" name="label" maxlength="120" placeholder="Optional, for example “Client review”" value="${esc(l?.label || '')}"></label>` +
    `<label class="ln-f"><span>People with the link</span><select class="field" name="kind">` +
    opt('view', 'can view — no account needed') + opt('comment', 'can view and comment — no account needed, they give a name') +
    opt('join:editor', 'can join and edit — they sign in') + opt('join:commenter', 'can join and comment — they sign in') + opt('join:viewer', 'can join and view — they sign in') +
    `</select></label>` +
    `<label class="ln-f"><span>Expires</span><select class="field" name="expires">${exp}<option value="never"${l && !l.expires ? ' selected' : ''}>Never</option>` +
    `<option value="1">In 1 day</option><option value="7">In 7 days</option><option value="30">In 30 days</option><option value="90">In 90 days</option></select></label>` +
    `<label class="ln-f ln-pw"><span><input type="checkbox" name="pw"${l?.password ? ' checked' : ''}> Password</span>` +
    `<input class="field" type="password" name="password" autocomplete="new-password" maxlength="200" placeholder="${l?.password ? 'Leave empty to keep the current password' : 'At least 4 characters'}"${l?.password ? '' : ' hidden'}></label>` +
    `<div class="m-actions"><button class="btn ghost" type="button" data-cancel-link>Cancel</button><button class="btn" type="submit">${l ? 'Save' : 'Create link'}</button></div></form>`;
}

export async function openShare(space = SPACE, board = cur) {
  exitEdit();
  await flush();
  let a;
  try { a = await api(`boards/${space}/${encodeURIComponent(board)}/access`); } catch (e) { return toast(e.message); }
  shareModal(a);
}

function viaText(p) {
  if (p.via === 'workspace') return `Workspace ${ROLE_LABEL[p.wsRole].toLowerCase()}`;
  if (p.via === 'inherited') return `Through “${esc(p.from.title)}”`;
  return '';
}

function shareModal(a) {
  const base = `boards/${a.space}/${encodeURIComponent(a.board)}`;
  const reopen = () => openShare(a.space, a.board);
  const team = a.people.some(p => p.via === 'workspace' && p.id !== user.id);
  const lead = `In the workspace <b>${esc(a.owner.name)}</b>. ` +
    (team ? 'Everyone in it can open this board.' : 'Only you and the people below can open this board and the boards inside it.');
  const people = a.people.map(p => {
    const mine = p.id === user.id;
    const changeable = a.canManage && !mine && (p.via === 'direct' || p.via === 'inherited');
    const sub = [p.email && a.canManage ? esc(p.email) : '', viaText(p)].filter(Boolean).join(' · ');
    return peopleRow(p, {
      sub,
      right: changeable
        ? roleSelect('role', BOARD_ROLES, p.role, `data-role="${esc(p.id)}"`) + (p.via === 'direct' ? `<button class="icon-btn sm" data-remove="${esc(p.id)}" title="Remove access">${icon('close', 14)}</button>` : '')
        : `<span class="pp-tag">${ROLE_LABEL[p.role]}${mine ? ' · you' : ''}</span>`,
    });
  }).join('');
  const canMove = a.canManage && (contexts?.workspaces || []).some(w => w.id !== a.space && w.role !== 'guest');
  const canTransfer = a.canManage && a.owner.mine && a.people.some(p => p.id !== user.id);
  const card = openModal(
    `<h2>Share “${esc(a.title)}”</h2><p class="pp-lead">${lead}</p>` +
    (a.canManage ? inviteForm(BOARD_ROLES, 'editor') : '') +
    `<div class="pp-sec">People with access</div>${people}` +
    invitesList(a.invites, a.canManage) + formerList(a.former) +
    (a.canManage && a.nested ? `<label class="pp-check"><input type="checkbox" data-restrict${a.restricted ? ' checked' : ''}><span><b>Only people added here</b><small>People who can open the board above don’t get this one automatically (workspace members and admins still do).</small></span></label>` : '') +
    (a.canManage ? `<div class="pp-sec">Links<span class="grow"></span><button class="btn ghost sm" data-new-link>${icon('plus', 13)} New link</button></div><div class="pp-links">${linksHtml(a.links)}</div>` : '') +
    `<div class="m-actions pp-foot">` +
    (canMove ? '<button class="btn ghost" data-move>Move to workspace…</button>' : '') +
    (canTransfer ? '<button class="btn ghost" data-transfer>Transfer ownership…</button>' : '') +
    (a.canLeave ? '<button class="btn ghost danger-text" data-leave>Leave board</button>' : '') +
    `<span class="grow"></span><button class="btn" data-close>Done</button></div>`,
    { cls: 'people-modal' });
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); } catch (e) { toast(e.message); } };
  let links = a.links || [], editing = null;   // editing: the link being changed (or {} for a new one)
  const paintLinks = () => { const box = $('.pp-links', card); if (box) box.innerHTML = editing ? linkForm(editing.token ? editing : null) : linksHtml(links); $('[data-new-link]', card)?.toggleAttribute('hidden', !!editing); };
  card.addEventListener('submit', async e => {
    if (!e.target.matches('.ln-form')) return;
    e.preventDefault();
    const f = new FormData(e.target), l = editing.token ? editing : null;
    const [kind, role] = String(f.get('kind')).split(':');
    const body = { label: String(f.get('label') || '').trim(), kind, ...(role ? { role } : {}) };
    const exp = String(f.get('expires'));
    if (exp === 'never') body.expires = null;
    else if (exp !== 'keep') body.expires = Math.floor(Date.now() / 1000) + Number(exp) * 86400;
    const pw = String(f.get('password') || '');
    if (!f.get('pw')) { if (l?.password) body.password = null; }
    else if (pw) body.password = pw;
    else if (!l?.password) return toast('Enter a password, or untick Password');
    try {
      const r = l ? await api(`links/${l.token}`, { method: 'PATCH', body }) : await api(`shares/${a.space}/${encodeURIComponent(a.board)}`, { method: 'POST', body });
      links = l ? links.map(x => (x.token === l.token ? r.link : x)) : [...links, r.link];
      editing = null; paintLinks();
      toast(l ? 'Link changed' : 'Link created');
      if (!l) dispatchEvent(new CustomEvent('nk:link-created'));
    } catch (err) { toast(err.message); }
  });
  card.addEventListener('change', e => {
    if (e.target.name === 'pw') { const p = $('.ln-form [name=password]', card); p.hidden = !e.target.checked; if (e.target.checked) p.focus(); }
  });

  $('form.pp-invite', card)?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api(`${base}/invites`, { method: 'POST', body: { email: f.get('email'), role: f.get('role') } });
      e.target.reset(); showSent(card, r);
      dispatchEvent(new CustomEvent('nk:invited'));
    } catch (err) { toast(err.message); }
  });
  card.addEventListener('change', e => {
    const s = e.target.closest('[data-role]');
    if (s) return act(async () => { await api(`${base}/members/${s.dataset.role}`, { method: 'PATCH', body: { role: s.value } }); reopen(); }, 'Access changed');
    const r = e.target.closest('[data-restrict]');
    if (r) return act(async () => { await api(`${base}/restrict`, { method: 'POST', body: { on: r.checked } }); }, r.checked ? 'Only people added here can open this board' : 'People with access to the board above can open this one');
  });
  card.addEventListener('click', async e => {
    const t = e.target;
    if (t.closest('[data-copy-link]')) return copyFrom($('.pp-sent input', card));
    const rm = t.closest('[data-remove]');
    if (rm) {
      const p = a.people.find(x => x.id === rm.dataset.remove);
      const cards = await askCards(p.name); if (!cards) return reopen();
      return act(async () => { await api(`${base}/members/${p.id}?cards=${cards}`, { method: 'DELETE' }); reopen(); }, `${p.name} no longer has access`);
    }
    const rs = t.closest('[data-resend]');
    if (rs) return act(async () => { const r = await api(`invites/${rs.dataset.resend}/resend`, { method: 'POST' }); showSent(card, r); });
    const rv = t.closest('[data-revoke]');
    if (rv) return act(async () => { await api(`invites/${rv.dataset.revoke}`, { method: 'DELETE' }); reopen(); }, 'Invitation cancelled');
    const fd = t.closest('[data-former-del]');
    if (fd) return act(async () => { await api(`${base}/former/${fd.dataset.formerDel}/delete-cards`, { method: 'POST' }); reopen(); }, 'Their cards were moved to the Trash');
    const fx = t.closest('[data-former-dismiss]');
    if (fx) return act(async () => { await api(`${base}/former/${fx.dataset.formerDismiss}`, { method: 'DELETE' }); reopen(); });
    // links
    if (t.closest('[data-new-link]')) { editing = {}; paintLinks(); return $('.ln-form input', card)?.focus(); }
    if (t.closest('[data-cancel-link]')) { editing = null; return paintLinks(); }
    const lr = t.closest('[data-link]');
    const l = lr && links.find(x => x.token === lr.dataset.link);
    if (l && t.closest('[data-copy]')) return copyFrom($('input', lr));
    if (l && t.closest('[data-edit-link]')) { editing = l; return paintLinks(); }
    if (l && t.closest('[data-del-link]')) {
      if (!await confirmDialog('Turn off this link?', { body: l.kind === 'join' ? 'People who already joined keep their access.' : 'It stops working right away.', ok: 'Turn off', danger: true })) return;
      return act(async () => { await api(`links/${l.token}`, { method: 'DELETE' }); links = links.filter(x => x !== l); paintLinks(); }, 'Link turned off');
    }
    if (t.closest('[data-leave]')) {
      if (!await confirmDialog(`Leave “${a.title}”?`, { body: 'You’ll lose access to it. The cards you made stay.', ok: 'Leave', danger: true })) return;
      return act(async () => { await api(`${base}/leave`, { method: 'POST' }); closeModal(); await refreshContexts(); switchSpace(user.space); }, 'You left the board');
    }
    if (t.closest('[data-move]')) return moveDialog(a);
    if (t.closest('[data-transfer]')) return transferDialog(a);
  });
}

async function moveDialog(a) {
  const list = (contexts?.workspaces || []).filter(w => w.id !== a.space && w.role !== 'guest');
  const ws = await choose(`Move “${a.title}” to a workspace`,
    'The board, the boards inside it and their cards move to the workspace’s top board. Everyone in the workspace will be able to open it, and the people it’s shared with keep their access.',
    [{ label: 'Cancel', cls: 'ghost', value: null }, ...list.map(w => ({ label: w.name, value: w.id }))]);
  if (!ws) return openShare(a.space, a.board);
  try {
    const r = await api(`boards/${a.space}/${encodeURIComponent(a.board)}/move`, { method: 'POST', body: { space: ws, parent: 'home' } });
    toast('Moved to the workspace');
    await refreshContexts();
    switchSpace(r.space, r.board);
  } catch (e) { toast(e.message); }
}

async function transferDialog(a) {
  const list = a.people.filter(p => p.id !== user.id);
  const to = await choose(`Transfer “${a.title}”`,
    'The board and everything inside it moves to their workspace and they become the owner. You stay on as an editor.',
    [{ label: 'Cancel', cls: 'ghost', value: null }, ...list.map(p => ({ label: p.name, value: p.id }))]);
  if (!to) return openShare(a.space, a.board);
  const p = list.find(x => x.id === to);
  if (!await confirmDialog(`Give “${a.title}” to ${p.name}?`, { body: 'Only they can undo this.', ok: 'Transfer', danger: true })) return openShare(a.space, a.board);
  try {
    const r = await api(`boards/${a.space}/${encodeURIComponent(a.board)}/transfer`, { method: 'POST', body: { user: to } });
    toast(`${p.name} now owns “${a.title}”`);
    await refreshContexts();
    switchSpace(r.space, r.board);
  } catch (e) { toast(e.message); }
}

export function init() {
  $('#shareBtn').addEventListener('click', () => openShare());
}
