/* Opening a link to a board: its password (asked once per tab), expired or turned-off links, and joining through one. */
import { $, esc } from '../core/util.js';
import { api } from '../core/api.js';
import { LINK } from '../core/store.js';
import { loadShared } from '../core/sync.js';
import { showLinkPassword } from '../ui/auth.js';
import { closeModal, openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { refreshContexts, switchSpace } from './spaces.js';

const A_ROLE = { editor: 'an editor', commenter: 'a commenter', viewer: 'a viewer' };
export const roleAs = role => A_ROLE[role] || 'a viewer';

function errorPage(title, text) {
  document.body.innerHTML = `<div class="err-page"><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div></div>`;
}

/**
 * What a link shows (a view or comment link: the boards; a join link: what you'd join), asking for its password if it
 * has one. The key the password unlocks stays in this tab (sessionStorage). Returns null after showing why it can't open.
 */
export async function openLink(token) {
  const store = 'nk-link:' + token;
  LINK.key = sessionStorage.getItem(store) || '';
  let note = '';
  for (;;) {
    try { return await loadShared(token); }
    catch (e) {
      if (e.status === 423) {
        if (LINK.key) note = 'The password for this link was changed. Enter the new one.';
        LINK.key = await showLinkPassword(token, note);
        sessionStorage.setItem(store, LINK.key);
        continue;
      }
      if (e.status === 410) errorPage('This link has expired', 'Ask the person who shared it for a new one.');
      else if (e.status === 0) errorPage('Can’t reach the server', 'Check your connection and reload.');
      else errorPage('This link isn’t available', 'The board may no longer be shared.');
      return null;
    }
  }
}

/** Signed in with a join link open: join the board (right away if you just signed in for it). */
export async function joinLanding(token, info, direct = false) {
  history.replaceState(null, '', location.pathname + location.hash);
  const go = async () => {
    try {
      const r = await api(`links/${token}/join`, { method: 'POST', body: { k: LINK.key } });
      await refreshContexts();
      toast(r.already ? `You already have access to “${info.title}”` : `You joined “${info.title}”`);
      await switchSpace(r.space, r.board);
    } catch (e) { toast(e.message); }
  };
  if (direct) return go();
  const card = openModal(`<h2>Join “${esc(info.title)}”?</h2><p><b>${esc(info.by)}</b> shared ${info.workspace ? `a board in <b>${esc(info.workspace)}</b>` : 'this board'} with a link. You’ll join it as ${roleAs(info.role)}.</p>` +
    `<div class="m-actions"><button class="btn ghost" data-close>Not now</button><button class="btn" data-ok>Join</button></div>`);
  $('[data-ok]', card).onclick = () => { closeModal(); go(); };
}

const REASONS = [
  ['spam', 'Spam'],
  ['phishing', 'Phishing'],
  ['malware', 'Malware'],
  ['illegal', 'Illegal content'],
  ['harassment', 'Harassment'],
  ['copyright', 'Copyright infringement'],
  ['other', 'Something else'],
];

/** A small "Report" dialog for anyone viewing a public share link, no account needed. */
export function openReportDialog(token) {
  const card = openModal(`<h2>Report this link</h2>
    <p>Tell us what's wrong with this shared board. We'll take a look.</p>
    <div class="report-reasons">${REASONS.map(([v, label], i) =>
      `<label><input type="radio" name="reportReason" value="${v}" ${i === 0 ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div>
    <textarea class="report-details" maxlength="2000" placeholder="More details (optional)"></textarea>
    <input class="report-email" type="email" placeholder="Your email, if you'd like a reply (optional)">
    <div class="m-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn" data-ok>Submit report</button></div>`,
    { cls: 'report-modal' });
  $('[data-ok]', card).onclick = async () => {
    const reason = card.querySelector('input[name="reportReason"]:checked')?.value || 'other';
    const details = $('.report-details', card).value.trim();
    const email = $('.report-email', card).value.trim();
    $('[data-ok]', card).disabled = true;
    try {
      await api(`shared/${token}/report`, { method: 'POST', body: { reason, details, email } });
      closeModal();
      toast("Thanks. We'll review this link.");
    } catch (e) {
      $('[data-ok]', card).disabled = false;
      toast(e.message);
    }
  };
}
