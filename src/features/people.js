/* Pieces shared by the board Share dialog and the workspace settings: people rows, invitations, small choice dialogs. */
import { $, esc } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { closeModal, openModal } from '../ui/modal.js';

export const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest', editor: 'Can edit', commenter: 'Can comment', viewer: 'Can view' };
export const ROLE_HELP = {
  editor: 'Can add, change and delete cards',
  commenter: 'Can read and add comments',
  viewer: 'Can only look',
  admin: 'Edits every board and manages members',
  member: 'Sees and edits every board',
};

export const avatar = name => `<span class="pp-av">${esc((name || '?').trim()[0]?.toUpperCase() || '?')}</span>`;

export function roleSelect(name, roles, value, attrs = '') {
  return `<select class="pp-role" name="${name}" ${attrs}>${roles.map(r => `<option value="${r}"${r === value ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`;
}

export const ago = t => {
  const s = Math.round(Date.now() / 1000 - t);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
};
const inDays = t => { const d = Math.ceil((t - Date.now() / 1000) / 86400); return d <= 0 ? 'expired' : d === 1 ? 'expires tomorrow' : `expires in ${d} days`; };

/** The invite form: email + role. */
export function inviteForm(roles, value) {
  return `<form class="pp-invite" novalidate><input class="field" name="email" type="email" placeholder="Email address" autocomplete="off" required>` +
    roleSelect('role', roles, value) + `<button class="btn" type="submit">Invite</button></form>` +
    `<div class="pp-sent" hidden></div>`;
}

/** After inviting: say whether the email went out, and always offer the link to copy. */
export function showSent(card, r) {
  const box = $('.pp-sent', card); if (!box) return;
  box.hidden = false;
  box.innerHTML = `<p>${r.emailed ? `Invitation emailed to <b>${esc(r.invite.email)}</b>. You can also send them this link` : r.mail
      ? `The email to <b>${esc(r.invite.email)}</b> couldn’t be sent. Send them this link instead`
      : `Email isn’t set up on this server. Send <b>${esc(r.invite.email)}</b> this link`} (it works for 7 days):</p>` +
    `<div class="share-row"><input class="field" readonly value="${esc(r.link)}"><button class="btn ghost" type="button" data-copy-link>Copy</button></div>`;
}

export async function copyFrom(input) {
  input.select();
  try { await navigator.clipboard.writeText(input.value); } catch { document.execCommand('copy'); }
  toast('Link copied');
}

export function peopleRow(p, { right = '', sub = '' } = {}) {
  return `<div class="pp-row" data-uid="${esc(p.id)}">${avatar(p.name)}<div class="pp-who"><b>${esc(p.name)}</b><small>${sub || esc(p.email || '')}</small></div><div class="pp-right">${right}</div></div>`;
}

export function invitesList(invites, manage) {
  if (!invites.length) return '';
  return `<div class="pp-sec">Invited</div>` + invites.map(i =>
    `<div class="pp-row" data-inv="${esc(i.id)}"><span class="pp-av pp-av-pending">${icon('userPlus', 14)}</span><div class="pp-who"><b>${esc(i.email)}</b>` +
    `<small>${ROLE_LABEL[i.role]} · ${i.expired ? 'expired' : inDays(i.expires)}</small></div>` +
    (manage ? `<div class="pp-right"><button class="btn ghost sm" data-resend="${esc(i.id)}" title="Send again with a new link">Resend</button><button class="icon-btn sm" data-revoke="${esc(i.id)}" title="Cancel invitation">${icon('close', 14)}</button></div>` : '') +
    `</div>`).join('');
}

export function formerList(former) {
  if (!former.length) return '';
  return `<div class="pp-sec">Former members</div>` + former.map(f => peopleRow(f, {
    sub: `Left ${ago(f.left)} · ${f.cards} card${f.cards === 1 ? '' : 's'} they made`,
    right: (f.cards ? `<button class="btn ghost sm" data-former-del="${esc(f.id)}">Move their cards to Trash</button>` : '') +
      `<button class="icon-btn sm" data-former-dismiss="${esc(f.id)}" title="Remove from this list">${icon('close', 14)}</button>`,
  })).join('');
}

/** A small dialog with a few buttons; resolves to the chosen value (null when closed). */
export function choose(title, text, buttons) {
  return new Promise(res => {
    let done = false;
    const card = openModal(`<h2>${esc(title)}</h2><p>${text}</p><div class="m-actions">` +
      buttons.map((b, i) => `<button class="btn${b.cls ? ' ' + b.cls : ''}" data-ch="${i}">${esc(b.label)}</button>`).join('') + '</div>',
      { onClose: () => { if (!done) res(null); } });
    card.addEventListener('click', e => {
      const b = e.target.closest('[data-ch]'); if (!b) return;
      done = true; closeModal(); res(buttons[+b.dataset.ch].value);
    });
  });
}

/** Ask what happens to a person's cards when they're removed. */
export const askCards = name => choose(`Remove ${name}?`,
  `They lose access straight away. What should happen to the cards they made?`,
  [{ label: 'Cancel', cls: 'ghost', value: null }, { label: 'Move their cards to Trash', cls: 'ghost', value: 'delete' }, { label: 'Keep their cards', cls: 'danger', value: 'keep' }]);

/** Type-to-confirm dialog; resolves to the typed text or null. */
export function typeToConfirm(title, text, expect, action) {
  return new Promise(res => {
    let done = false;
    const card = openModal(`<h2>${esc(title)}</h2><p>${text}</p><input class="field" autocomplete="off" placeholder="${esc(expect)}">` +
      `<div class="m-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" data-ok disabled>${esc(action)}</button></div>`,
      { onClose: () => { if (!done) res(null); } });
    const inp = $('input', card), ok = $('[data-ok]', card);
    inp.addEventListener('input', () => (ok.disabled = inp.value.trim() !== expect));
    inp.focus();
    ok.addEventListener('click', () => { done = true; closeModal(); res(inp.value.trim()); });
  });
}
