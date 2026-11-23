/* The operator's admin page (only for ADMIN_EMAILS): numbers at a glance, accounts, reports about share links, and
 * feedback sent from the app. Server side: server/src/Admin.php. */
import { $, esc } from '../core/util.js';
import { api } from '../core/api.js';
import { confirmDialog, openModal } from './modal.js';
import { toast } from './toast.js';
import { fmtAgo } from './account.js';

const fmtBytes = n => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : n >= 1024 ** 2 ? Math.round(n / 1024 ** 2) + ' MB'
  : n > 0 ? Math.max(1, Math.round(n / 1024)) + ' KB' : '0';
const fmtDay = ts => new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const num = n => Number(n).toLocaleString();
const TABS = [['overview', 'Overview'], ['users', 'Users'], ['reports', 'Reports'], ['feedback', 'Feedback']];

let card, body;
const st = { tab: 'overview', q: '', offset: 0, status: 'open', fbOffset: 0 };

export async function openAdmin() {
  card = openModal(`
    <div class="adm-head"><h2>Admin</h2><button class="btn ghost sm" data-close>Close</button></div>
    <nav class="adm-tabs">${TABS.map(([k, l]) => `<button type="button" data-tab="${k}">${l}</button>`).join('')}</nav>
    <div class="adm-body"></div>`, { cls: 'admin-modal' });
  body = $('.adm-body', card);
  card.addEventListener('click', e => {
    const t = e.target.closest('[data-tab]');
    if (t) show(t.dataset.tab);
  });
  show(st.tab);
}

function show(tab) {
  st.tab = tab;
  card.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  body.innerHTML = '<p class="adm-muted">Loading…</p>';
  ({ overview, users, reports, feedback })[tab]().catch(e => { body.innerHTML = `<p class="adm-muted">${esc(e.message)}</p>`; });
}

/* ================= overview ================= */
async function overview() {
  const o = await api('admin/overview');
  const tile = (n, label, hint = '') => `<div class="adm-tile"><b>${n}</b><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</div>`;
  body.innerHTML = `
    <h3>Accounts</h3>
    <div class="adm-tiles">
      ${tile(num(o.users.total), 'Accounts', `${num(o.users.new7)} new this week, ${num(o.users.new30)} this month`)}
      ${tile(num(o.users.active1), 'Active today', `${num(o.users.active7)} in the last 7 days`)}
      ${tile(num(o.users.unverified), 'Unverified')}
      ${tile(num(o.users.deleting), 'Scheduled for deletion')}
      ${tile(num(o.users.suspended), 'Suspended')}
    </div>
    <h3>Content</h3>
    <div class="adm-tiles">
      ${tile(num(o.workspaces), 'Team workspaces')}
      ${tile(num(o.boards), 'Boards')}
      ${tile(num(o.cards), 'Cards')}
      ${tile(num(o.links), 'Share links')}
      ${tile(fmtBytes(o.storageBytes), 'Files stored')}
    </div>
    <h3>Needs attention</h3>
    <div class="adm-tiles">
      ${tile(num(o.openReports), 'Open reports', o.openReports ? '<a href="#" data-go="reports">Review them</a>' : 'All clear')}
      ${tile(num(o.feedback7), 'Feedback this week', o.feedback7 ? '<a href="#" data-go="feedback">Read it</a>' : '')}
    </div>`;
  body.onclick = e => { const g = e.target.closest('[data-go]'); if (g) { e.preventDefault(); show(g.dataset.go); } };
}

/* ================= users ================= */
async function users() {
  const r = await api(`admin/users?q=${encodeURIComponent(st.q)}&offset=${st.offset}`);
  const status = u => [
    u.suspended ? '<span class="adm-tag bad">Suspended</span>' : '',
    u.deleteAt ? `<span class="adm-tag warn" title="Deletes on ${esc(fmtDay(u.deleteAt))}">Deleting</span>` : '',
    !u.verified ? '<span class="adm-tag">Unverified</span>' : '',
    u.admin ? '<span class="adm-tag ok">Admin</span>' : '',
  ].join('');
  const actions = u => [
    !u.verified ? `<button class="btn ghost sm" data-act="verify">Mark verified</button>` : '',
    u.deleteAt ? `<button class="btn ghost sm" data-act="keep">Cancel deletion</button>` : '',
    `<button class="btn ghost sm" data-act="signout">Sign out</button>`,
    u.admin ? '' : u.suspended ? `<button class="btn ghost sm" data-act="unsuspend">Unsuspend</button>`
      : `<button class="btn ghost sm danger-text" data-act="suspend">Suspend</button>`,
  ].join('');
  const end = Math.min(r.offset + r.page, r.total);
  body.innerHTML = `
    <div class="adm-bar">
      <input class="field adm-search" type="search" placeholder="Search by email or name" value="${esc(st.q)}">
      <span class="adm-muted">${r.total ? `${num(r.offset + 1)}–${num(end)} of ${num(r.total)}` : 'No accounts found'}</span>
      <button class="btn ghost sm" data-page="-1" ${r.offset ? '' : 'disabled'}>Previous</button>
      <button class="btn ghost sm" data-page="1" ${end < r.total ? '' : 'disabled'}>Next</button>
    </div>
    <div class="adm-scroll"><table class="adm-table">
      <thead><tr><th>Account</th><th>Files</th><th>Workspaces</th><th>Joined</th><th>Last active</th><th></th></tr></thead>
      <tbody>${r.users.map(u => `<tr data-id="${esc(u.id)}" data-email="${esc(u.email)}">
        <td><b>${esc(u.name)}</b> ${status(u)}<small>${esc(u.email)}</small></td>
        <td>${fmtBytes(u.storageBytes)}</td>
        <td>${u.workspaces}</td>
        <td>${esc(fmtDay(u.created))}</td>
        <td>${u.seen ? esc(fmtAgo(u.seen)) : '<span class="adm-muted">Never</span>'}</td>
        <td><div class="adm-actions">${actions(u)}</div></td>
      </tr>`).join('')}</tbody>
    </table></div>`;

  const search = $('.adm-search', body);
  let timer;
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { st.q = search.value.trim(); st.offset = 0; show('users'); }, 300); };
  if (st.q) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  body.onclick = async e => {
    const pg = e.target.closest('[data-page]');
    if (pg) { st.offset = Math.max(0, st.offset + Number(pg.dataset.page) * r.page); return show('users'); }
    const b = e.target.closest('[data-act]'); if (!b) return;
    const row = b.closest('tr'), email = row.dataset.email, act = b.dataset.act;
    const ask = {
      suspend: ['Suspend this account?', `${email} is signed out everywhere, can't sign in, and their share links stop working until you unsuspend them. Nothing is deleted.`, 'Suspend', true],
      signout: ['Sign this account out everywhere?', `${email} will need to sign in again on every device, and their AI connections are removed.`, 'Sign out', false],
    }[act];
    if (ask && !await confirmDialog(ask[0], { body: ask[1], ok: ask[2], danger: ask[3] })) return;
    await userAction(row.dataset.id, { action: act }, {
      verify: 'Marked as verified', keep: 'Deletion cancelled', signout: 'Signed out everywhere', suspend: 'Account suspended', unsuspend: 'Account unsuspended',
    }[act]);
  };
}

async function userAction(id, payload, done) {
  try { await api('admin/users/' + id, { method: 'POST', body: payload }); toast(done); }
  catch (e) { toast(e.message); }
  show('users');
}

/* ================= reports ================= */
async function reports() {
  const { reports: list } = await api('admin/reports?status=' + st.status);
  const appBase = location.origin + location.pathname;
  body.innerHTML = `
    <div class="adm-bar">
      <select class="field adm-status">${[['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(([v, l]) => `<option value="${v}"${v === st.status ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <span class="adm-muted">${list.length ? `${list.length} report${list.length === 1 ? '' : 's'}` : ''}</span>
    </div>
    ${list.length ? list.map(r => `<article class="adm-item" data-id="${esc(r.id)}" data-owner="${esc(r.owner?.id || '')}" data-owner-email="${esc(r.owner?.email || '')}">
      <header><span class="adm-tag ${r.status === 'open' ? 'warn' : ''}">${esc(r.reason)}</span>
        <span class="adm-muted">${esc(fmtAgo(r.created))} · from ${esc(r.email || r.ip || 'anonymous')}</span></header>
      ${r.details ? `<p>${esc(r.details)}</p>` : ''}
      <p class="adm-muted">Link ${r.linkLive ? `<a href="${esc(appBase + '?view=' + r.token)}" target="_blank" rel="noopener">${esc(r.token)}</a>` : `${esc(r.token)} (removed)`}
        ${r.owner ? ` · made by ${esc(r.owner.name)} (${esc(r.owner.email)})${r.owner.suspended ? ' <span class="adm-tag bad">Suspended</span>' : ''}` : ''}</p>
      <div class="adm-actions">
        ${r.linkLive ? '<button class="btn ghost sm danger-text" data-ract="disable">Turn off link</button>' : ''}
        ${r.owner && !r.owner.suspended ? '<button class="btn ghost sm danger-text" data-ract="suspend">Suspend owner</button>' : ''}
        ${r.status === 'open' ? '<button class="btn ghost sm" data-ract="close">Mark handled</button>' : '<button class="btn ghost sm" data-ract="reopen">Reopen</button>'}
      </div>
    </article>`).join('') : `<p class="adm-muted">${st.status === 'open' ? 'No open reports. All clear.' : 'No reports.'}</p>`}`;

  $('.adm-status', body).onchange = e => { st.status = e.target.value; show('reports'); };
  body.onclick = async e => {
    const b = e.target.closest('[data-ract]'); if (!b) return;
    const it = b.closest('.adm-item'), act = b.dataset.ract;
    try {
      if (act === 'suspend') {
        if (!await confirmDialog('Suspend the owner?', { body: `${it.dataset.ownerEmail} is signed out everywhere, can't sign in, and all their share links stop working. Nothing is deleted.`, ok: 'Suspend', danger: true })) return;
        await api('admin/users/' + it.dataset.owner, { method: 'POST', body: { action: 'suspend' } });
        toast('Owner suspended');
      } else {
        if (act === 'disable' && !await confirmDialog('Turn off this link?', { body: 'The link stops working for everyone and every report about it is marked handled. The board itself is not touched.', ok: 'Turn off', danger: true })) return;
        await api('admin/reports/' + it.dataset.id, { method: 'POST', body: { action: act } });
        toast({ disable: 'Link turned off', close: 'Marked handled', reopen: 'Reopened' }[act]);
      }
    } catch (err) { toast(err.message); }
    show('reports');
  };
}

/* ================= feedback ================= */
async function feedback() {
  const r = await api('admin/feedback?offset=' + st.fbOffset);
  const end = Math.min(r.offset + r.page, r.total);
  body.innerHTML = `
    <div class="adm-bar">
      <span class="adm-muted">${r.total ? `${num(r.offset + 1)}–${num(end)} of ${num(r.total)}` : ''}</span>
      <button class="btn ghost sm" data-page="-1" ${r.offset ? '' : 'disabled'}>Newer</button>
      <button class="btn ghost sm" data-page="1" ${end < r.total ? '' : 'disabled'}>Older</button>
    </div>
    ${r.feedback.length ? r.feedback.map(f => `<article class="adm-item">
      <header><span class="adm-tag">${esc(f.kind)}</span>
        <span class="adm-muted">${esc(fmtAgo(f.created))} · ${f.email ? `<a href="mailto:${esc(f.email)}">${esc(f.name || f.email)}</a>` : 'no email'}${f.page ? ' · ' + esc(f.page) : ''}</span></header>
      <p>${esc(f.body)}</p>
    </article>`).join('') : '<p class="adm-muted">No feedback yet.</p>'}`;
  body.onclick = e => {
    const pg = e.target.closest('[data-page]'); if (!pg) return;
    st.fbOffset = Math.max(0, st.fbOffset + Number(pg.dataset.page) * r.page);
    show('feedback');
  };
}
