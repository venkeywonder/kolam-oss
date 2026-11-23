/* In-app support: Send feedback, What's new (changelog) and the rest of the ? help menu's items beyond shortcuts. */
import { $, esc } from '../core/util.js';
import { api } from '../core/api.js';
import { analyticsAvailable, track } from '../core/analytics.js';
import { showConsentBanner } from '../ui/consent.js';
import { user } from '../core/store.js';
import { openModal, closeModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

let configPromise = null;
/** auth/me is already fetched at boot for the signed-in user; the help menu fetches its own copy once and reuses it. */
function getConfig() {
  if (!configPromise) configPromise = api('auth/me').then(me => me.config).catch(() => ({}));
  return configPromise;
}

const seenKey = () => `kolam.changelogSeen.${user?.id || 'anon'}`;

/** True once the newest changelog entry is newer than the one this account last opened "What's new" on. */
export async function hasUnseenChangelog() {
  try {
    const entries = await api('changelog');
    const latest = entries[0]?.date;
    if (!latest) return false;
    return latest > (localStorage.getItem(seenKey()) || '');
  } catch { return false; }
}

const FEEDBACK_KINDS = [
  ['idea', 'Idea'],
  ['problem', 'Problem'],
  ['question', 'Question'],
  ['praise', 'Praise'],
];

/** Builds the ? menu's entries. `onShortcuts` shows keyboard shortcuts; `onWhatsNewSeen` runs once "What's new" is marked read. */
export function helpMenuEntries(config, onShortcuts, onWhatsNewSeen) {
  const m = [{ label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', act: onShortcuts }];
  m.push({ label: "What's new", icon: 'bullets', act: () => openWhatsNew().then(onWhatsNewSeen) });
  if (config.site) m.push({ label: 'Help center', icon: 'open', act: () => window.open(config.site + '/help', '_blank', 'noopener') });
  m.push('-');
  m.push({ label: 'Send feedback…', icon: 'edit', act: openFeedback });
  if (config.support) m.push({ label: 'Contact support', icon: 'comment', act: () => { location.href = 'mailto:' + config.support; } });
  if (analyticsAvailable()) m.push({ label: 'Cookie settings', icon: 'lock', act: () => showConsentBanner(config.site) });
  return m;
}

export { getConfig };

/** "What's new": dated sections of the changelog, newest first; marks the newest entry seen once it opens. */
export async function openWhatsNew() {
  let entries;
  try { entries = await api('changelog'); } catch (e) { return toast(e.message); }
  const html = entries.length
    ? entries.map(e => `<section class="whatsnew-entry"><h3>${esc(new Date(e.date + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))}</h3><ul>${e.items.map(i => `<li>${i}</li>`).join('')}</ul></section>`).join('')
    : '<p>Nothing here yet.</p>';
  openModal(`<h2>What's new</h2><div class="whatsnew-list">${html}</div><div class="m-actions"><button class="btn" data-close>Close</button></div>`, { cls: 'whatsnew-modal' });
  if (entries[0]?.date) localStorage.setItem(seenKey(), entries[0].date);
}

/** Send feedback dialog: kind, body, and an opt-in "include this page" checkbox. */
export function openFeedback() {
  const card = openModal(`<h2>Send feedback</h2>
    <p>Tell us what's on your mind. We read every message.</p>
    <div class="fb-kinds">${FEEDBACK_KINDS.map(([v, label], i) =>
      `<label class="fb-kind"><input type="radio" name="fbKind" value="${v}" ${i === 0 ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div>
    <textarea class="fb-body" maxlength="5000" placeholder="What's up?" autofocus></textarea>
    <label class="fb-page"><input type="checkbox" checked> Include this page's address</label>
    <div class="m-actions"><button class="btn ghost" data-close>Cancel</button><button class="btn" data-ok>Send</button></div>`,
    { cls: 'feedback-modal' });
  $('.fb-body', card).focus();
  $('[data-ok]', card).onclick = async () => {
    const kind = card.querySelector('input[name="fbKind"]:checked')?.value || 'idea';
    const body = $('.fb-body', card).value.trim();
    if (!body) return toast("Tell us what's on your mind");
    const includePage = $('.fb-page input', card).checked;
    const page = includePage ? location.pathname + location.hash : '';
    const btn = $('[data-ok]', card);
    btn.disabled = true;
    try {
      await api('feedback', { method: 'POST', body: { kind, body, page } });
      track('feedback_sent', { kind });
      closeModal();
      toast('Thanks! We read every message.');
    } catch (e) {
      btn.disabled = false;
      toast(e.message);
    }
  };
}
