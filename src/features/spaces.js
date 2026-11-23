/*
 * Spaces: your own boards, team workspaces, and boards other people shared with you.
 * Switching between them, the Spaces panel, workspace settings, invitations, and the warning before
 * moving cards to a board that a different set of people can see.
 */
import { $, esc } from '../core/util.js';
import { api } from '../core/api.js';
import { icon } from '../ui/icons.js';
import { ACC, ROOT, S, SPACE, VIEW, boardHash, cur, isPersonal, resetUndo, sel, setCur, setSPACE, setSelLine, user } from '../core/store.js';
import { flush, load } from '../core/sync.js';
import { render } from '../canvas/render.js';
import { exitEdit } from '../canvas/editing.js';
import { toast } from '../ui/toast.js';
import { closeModal, confirmDialog, openModal } from '../ui/modal.js';
import { drawer, panel, renderPanel, togglePanel } from '../ui/drawer.js';
import { ROLE_HELP, ROLE_LABEL, askCards, avatar, copyFrom, formerList, inviteForm, invitesList, peopleRow, roleSelect, showSent, typeToConfirm } from './people.js';

export let contexts = null;        // last answer of GET /spaces
export async function refreshContexts() {
  try { contexts = await api('spaces'); } catch { return contexts; }
  paintSpaceBtn();
  if (panel === 'spaces') renderPanel();
  return contexts;
}

/* ---------- switching ---------- */
let switching = Promise.resolve();
export function switchSpace(space, board) {
  switching = switching.then(() => doSwitch(space || user.space, board)).catch(e => console.error(e));
  return switching;
}
async function doSwitch(space, board) {
  if (VIEW) return;
  if (space === SPACE) {
    if (board && S.boards[board] && board !== cur) { location.hash = boardHash(board); }
    return;
  }
  exitEdit();
  await flush();
  const prev = SPACE;
  setSPACE(space); resetUndo(); sel.clear(); setSelLine(null);
  try { await load(); } catch (e) {
    if (e.status === 401) return location.reload();
    toast(e.status === 404 ? 'You don’t have access to that any more' : e.message);
    setSPACE(prev);
    if (prev) { await load().catch(() => {}); } else return;
    refreshContexts();
  }
  setCur(board && S.boards[board] ? board : ROOT);
  history.replaceState(null, '', location.pathname + location.search + boardHash(cur));
  render(); renderPanel(); paintSpaceBtn();
  dispatchEvent(new CustomEvent('nk:space'));
}

/* ---------- the space button in the top bar ---------- */
export function paintSpaceBtn() {
  const b = $('#spaceBtn'); if (!b || VIEW) return;
  const n = contexts?.invites?.length || 0;
  const kind = isPersonal() ? 'home' : ACC?.space?.kind === 'workspace' ? 'users' : 'userPlus';
  b.innerHTML = `${icon(kind === 'users' ? 'board' : kind, 15)}<span>${esc(isPersonal() ? 'My boards' : ACC?.space?.name || 'Shared')}</span>${icon('chevD', 13)}` +
    (n ? `<i class="sp-badge" title="${n} invitation${n === 1 ? '' : 's'}">${n}</i>` : '');
  b.classList.toggle('shared', !isPersonal());
}

/* ---------- the Spaces panel ---------- */
const roleText = r => ROLE_LABEL[r] || '';
export function renderSpacesPanel() {
  const c = contexts;
  const row = (attrs, ic, title, sub, on, extra = '') =>
    `<div class="sp-row${on ? ' on' : ''}"><button class="sp-go" ${attrs}>${ic}<span class="sp-t"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>${extra}</div>`;
  let h = `<div class="dr-head"><b>Spaces</b><span class="dr-sub"></span><button class="icon-btn" data-x title="Close">${icon('close', 16)}</button></div><div class="dr-list sp-list">`;
  if (!c) h += '<div class="dr-empty">Loading…</div>';
  else {
    if (c.invites.length) {
      h += '<div class="pp-sec">Invitations</div>' + c.invites.map(i => `<div class="sp-inv"><p><b>${esc(i.by)}</b> invited you to ${i.kind === 'workspace' ? 'the workspace' : 'the board'} <b>${esc(i.title)}</b>${i.workspace && i.kind === 'board' ? ` in ${esc(i.workspace)}` : ''} · ${esc(ROLE_LABEL[i.role])}</p>` +
        `<div><button class="btn sm" data-accept="${esc(i.id)}">Accept</button><button class="btn ghost sm" data-decline="${esc(i.id)}">Decline</button></div></div>`).join('');
    }
    h += '<div class="pp-sec">Your boards</div>' + row(`data-go="${esc(c.personal.id)}"`, `<span class="sp-ic">${icon('home', 16)}</span>`, 'My boards', '', SPACE === c.personal.id);
    h += `<div class="pp-sec">Workspaces<button class="sp-new" data-new-ws>${icon('plus', 13)} New</button></div>`;
    h += c.workspaces.length ? c.workspaces.map(w => row(`data-go="${esc(w.id)}"`, `<span class="sp-ic sp-ws">${esc(w.name.trim()[0]?.toUpperCase() || 'W')}</span>`, w.name,
      `${w.members} member${w.members === 1 ? '' : 's'} · ${roleText(w.role)}`, SPACE === w.id,
      `<button class="icon-btn sm" data-ws="${esc(w.id)}" title="Members and settings">${icon('more', 16)}</button>`)).join('')
      : '<div class="sp-empty">A workspace is a shared set of boards for a team. Everyone in it sees and edits every board.</div>';
    h += '<div class="pp-sec">Shared with you</div>';
    h += c.shared.length ? c.shared.map(s => row(`data-go="${esc(s.space)}" data-board="${esc(s.board)}"`, `<span class="sp-ic">${icon('board', 16)}</span>`, s.title,
      `${s.from} · ${roleText(s.role)}`, SPACE === s.space && ACC?.roots?.includes(s.board))).join('')
      : '<div class="sp-empty">Boards people share with you show up here.</div>';
  }
  drawer.innerHTML = h + '</div>';
  $('[data-x]', drawer).onclick = () => togglePanel('spaces');
  drawer.onclick = async e => {
    const go = e.target.closest('[data-go]');
    if (go) return switchSpace(go.dataset.go, go.dataset.board);
    const ws = e.target.closest('[data-ws]'); if (ws) return openWorkspace(ws.dataset.ws);
    if (e.target.closest('[data-new-ws]')) return newWorkspace();
    const acc = e.target.closest('[data-accept]'); if (acc) return acceptInvite(acc.dataset.accept);
    const dec = e.target.closest('[data-decline]');
    if (dec) { try { await api(`invites/${dec.dataset.decline}/decline`, { method: 'POST' }); toast('Invitation declined'); } catch (err) { toast(err.message); } refreshContexts(); }
  };
}

/* ---------- invitations ---------- */
export async function acceptInvite(key) {
  try {
    const go = await api(`invites/${encodeURIComponent(key)}/accept`, { method: 'POST' });
    await refreshContexts();
    toast('Invitation accepted');
    await switchSpace(go.space, go.board || undefined);
    return true;
  } catch (e) { toast(e.message); refreshContexts(); return false; }
}

/** Opened from an invitation link while signed in. $direct: just signed up or in for it, so accept without asking. */
export async function inviteLanding(token, direct = false) {
  history.replaceState(null, '', location.pathname + location.hash);
  let info;
  try { info = await api('invites/' + token); } catch (e) { return toast(e.message); }
  if (info.status === 'accepted') return acceptInvite(token);
  if (info.status !== 'pending' || info.expired) return toast(info.expired ? 'This invitation has expired. Ask for a new one.' : 'This invitation is no longer valid');
  const what = info.kind === 'workspace' ? 'the workspace' : 'the board';
  if (info.email !== user.email.toLowerCase()) {
    const card = openModal(`<h2>This invitation is for someone else</h2><p>It was sent to <b>${esc(info.email)}</b>, but you’re signed in as <b>${esc(user.email)}</b>. Sign out and sign in with that address to accept it.</p>` +
      `<div class="m-actions"><button class="btn ghost" data-close>Not now</button><button class="btn" data-out>Sign out</button></div>`);
    $('[data-out]', card).onclick = async () => { await api('auth/logout', { method: 'POST' }).catch(() => {}); location.assign(location.pathname + '?invite=' + token); };
    return;
  }
  if (direct) return acceptInvite(token);
  const card = openModal(`<h2>Join “${esc(info.title)}”?</h2><p><b>${esc(info.by)}</b> invited you to ${what} <b>${esc(info.title)}</b>${info.workspace && info.kind === 'board' ? ` in ${esc(info.workspace)}` : ''} as ${esc(ROLE_LABEL[info.role].toLowerCase())}.</p>` +
    `<div class="m-actions"><button class="btn ghost" data-close>Not now</button><button class="btn" data-ok>Accept</button></div>`);
  $('[data-ok]', card).onclick = () => { closeModal(); acceptInvite(token); };
}

/* ---------- workspaces ---------- */
export function newWorkspace() {
  const card = openModal(`<h2>New workspace</h2><p>A shared set of boards for a team. You can invite people once it’s created.</p>` +
    `<form><input class="field" name="name" maxlength="120" placeholder="Workspace name" required autocomplete="off">` +
    `<div class="m-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="submit">Create</button></div></form>`);
  $('input', card).focus();
  $('form', card).onsubmit = async e => {
    e.preventDefault();
    const name = $('input', card).value.trim(); if (!name) return;
    try {
      const w = await api('workspaces', { method: 'POST', body: { name } });
      closeModal();
      await refreshContexts();
      await switchSpace(w.id);
      openWorkspace(w.id);
    } catch (err) { toast(err.message); }
  };
}

export async function openWorkspace(id) {
  let w;
  try { w = await api('workspaces/' + id); } catch (e) { return toast(e.message); }
  const owner = w.role === 'owner';
  const editable = p => w.canManage && p.role !== 'owner' && p.id !== user.id && (owner || p.role !== 'admin');
  const roles = owner ? ['admin', 'member', 'guest'] : ['member', 'guest'];
  const people = w.members.map(p => peopleRow(p, {
    sub: esc(p.email || '') || esc(ROLE_HELP[p.role] || ''),
    right: editable(p)
      ? roleSelect('role', [...roles, ...(owner && p.role !== 'guest' ? ['owner'] : [])], p.role, `data-ws-role="${esc(p.id)}"`) +
        `<button class="icon-btn sm" data-ws-remove="${esc(p.id)}" title="Remove from workspace">${icon('close', 14)}</button>`
      : `<span class="pp-tag">${ROLE_LABEL[p.role]}${p.id === user.id ? ' · you' : ''}</span>`,
  })).join('');
  const card = openModal(
    `<div class="pp-head">${w.canManage ? `<input class="pp-name" value="${esc(w.name)}" maxlength="120" aria-label="Workspace name">` : `<h2>${esc(w.name)}</h2>`}</div>` +
    `<p class="pp-lead">Everyone in a workspace sees its boards. Members and admins edit every board; guests only see boards shared with them.</p>` +
    (w.canManage ? inviteForm(owner ? ['member', 'admin'] : ['member'], 'member') : '') +
    `<div class="pp-sec">People</div>${people}` + invitesList(w.invites, w.canManage) + formerList(w.former) +
    `<div class="m-actions pp-foot">${owner ? '<button class="btn ghost danger-text" data-ws-delete>Delete workspace…</button>' : '<button class="btn ghost danger-text" data-ws-leave>Leave workspace</button>'}<span class="grow"></span><button class="btn" data-close>Done</button></div>`,
    { cls: 'people-modal' });
  const reopen = () => openWorkspace(id);
  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); } catch (e) { toast(e.message); } };
  const name = $('.pp-name', card);
  if (name) name.addEventListener('change', () => act(async () => { await api('workspaces/' + id, { method: 'PATCH', body: { name: name.value.trim() } }); refreshContexts(); }, 'Renamed'));
  $('form.pp-invite', card)?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api(`workspaces/${id}/invites`, { method: 'POST', body: { email: f.get('email'), role: f.get('role') } });
      e.target.reset(); showSent(card, r);
      dispatchEvent(new CustomEvent('nk:invited'));
    } catch (err) { toast(err.message); }
  });
  card.addEventListener('change', async e => {
    const s = e.target.closest('[data-ws-role]'); if (!s) return;
    const uid = s.dataset.wsRole, role = s.value;
    if (role === 'owner' && !await confirmDialog('Make them the owner of this workspace?', { body: 'You’ll stay on as an admin.', ok: 'Make owner' })) return reopen();
    act(async () => { await api(`workspaces/${id}/members/${uid}`, { method: 'PATCH', body: { role } }); reopen(); refreshContexts(); }, 'Role changed');
  });
  card.addEventListener('click', async e => {
    const t = e.target;
    if (t.closest('[data-copy-link]')) return copyFrom($('.pp-sent input', card));
    const rm = t.closest('[data-ws-remove]');
    if (rm) {
      const p = w.members.find(m => m.id === rm.dataset.wsRemove);
      const cards = await askCards(p.name); if (!cards) return reopen();
      return act(async () => { await api(`workspaces/${id}/members/${p.id}?cards=${cards}`, { method: 'DELETE' }); reopen(); }, `${p.name} was removed`);
    }
    const rs = t.closest('[data-resend]');
    if (rs) return act(async () => { const r = await api(`invites/${rs.dataset.resend}/resend`, { method: 'POST' }); showSent(card, r); });
    const rv = t.closest('[data-revoke]');
    if (rv) return act(async () => { await api(`invites/${rv.dataset.revoke}`, { method: 'DELETE' }); reopen(); }, 'Invitation cancelled');
    const fd = t.closest('[data-former-del]');
    if (fd) return act(async () => { await api(`workspaces/${id}/former/${fd.dataset.formerDel}/delete-cards`, { method: 'POST' }); reopen(); }, 'Their cards were moved to the Trash');
    const fx = t.closest('[data-former-dismiss]');
    if (fx) return act(async () => { await api(`workspaces/${id}/former/${fx.dataset.formerDismiss}`, { method: 'DELETE' }); reopen(); });
    if (t.closest('[data-ws-leave]')) {
      if (!await confirmDialog(`Leave “${w.name}”?`, { body: 'You’ll lose access to its boards. The cards you made stay.', ok: 'Leave', danger: true })) return;
      return act(async () => { await api(`workspaces/${id}/leave`, { method: 'POST' }); closeModal(); await refreshContexts(); if (SPACE === id) switchSpace(user.space); }, 'You left the workspace');
    }
    if (t.closest('[data-ws-delete]')) {
      const ok = await typeToConfirm('Delete this workspace?', `Its boards go to your Trash for 30 days, where you can restore them. Nobody else can open them meanwhile. Type <b>${esc(w.name)}</b> to confirm.`, w.name, 'Delete workspace');
      if (!ok) return reopen();
      return act(async () => { await api('workspaces/' + id, { method: 'DELETE', body: { name: ok } }); await refreshContexts(); if (SPACE === id) switchSpace(user.space); }, 'Workspace moved to Trash');
    }
  });
}

/* ---------- moving cards between audiences ---------- */
const audOf = b => {
  if (b === '__unsorted') return [user.id];
  let x = b, n = 0;
  while (x && !ACC?.aud?.[x] && n++ < 100) x = S.boards[x]?.parent;
  return ACC?.aud?.[x] || [user.id];
};
const names = ids => {
  const n = ids.map(id => ACC?.people?.[id] || 'someone');
  return n.length <= 3 ? n.join(n.length === 2 ? ' and ' : ', ').replace(/, ([^,]*)$/, ' and $1') : `${n.slice(0, 2).join(', ')} and ${n.length - 2} others`;
};
/** Resolves true when the move is fine (same people can see both boards) or the person confirms. */
export function confirmMove(from, to, count = 1) {
  if (VIEW || from === to) return Promise.resolve(true);
  const a = new Set(audOf(from)), b = new Set(audOf(to));
  const gain = [...b].filter(x => !a.has(x) && x !== user.id), lose = [...a].filter(x => !b.has(x) && x !== user.id);
  if (!gain.length && !lose.length) return Promise.resolve(true);
  const what = count === 1 ? 'this card' : `these ${count} cards`;
  const title = to === '__unsorted' ? 'Unsorted' : S.boards[to]?.title || 'that board';
  return new Promise(res => {
    let done = false;
    const card = openModal(`<h2>Move ${what} to “${esc(title)}”?</h2>` +
      (gain.length ? `<p>${esc(names(gain))} will be able to see ${what}.</p>` : '') +
      (lose.length ? `<p>${esc(names(lose))} won’t see ${what} any more.</p>` : '') +
      `<div class="m-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn" data-ok>Move</button></div>`,
      { onClose: () => { if (!done) res(false); } });
    $('[data-ok]', card).onclick = () => { done = true; closeModal(); res(true); };
  });
}

export function init() {
  if (VIEW) return;
  $('#spaceBtn')?.addEventListener('click', () => { togglePanel('spaces'); if (panel === 'spaces') refreshContexts(); });
  addEventListener('nk:lost', e => {
    if (e.detail.space !== SPACE) return;
    toast('You no longer have access to those boards');
    refreshContexts();
    switchSpace(user.space);
  });
  // new invitations show up on the space button
  setInterval(() => { if (!document.hidden && user) refreshContexts(); }, 60000);
}
