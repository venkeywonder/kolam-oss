/* Account settings page (#/account/<section>): profile, sign-in (password, Google) and signed-in devices, data export, and account
 * deletion. It covers the app while open; the board stays loaded underneath, and "Back to boards" (or Escape) returns
 * to the board you came from. */
import { $, esc } from '../core/util.js';
import { api, API_BASE } from '../core/api.js';
import { track } from '../core/analytics.js';
import { VIEW, boardHash, cur, user } from '../core/store.js';
import { confirmDialog, openModal, closeModal } from './modal.js';
import { toast } from './toast.js';
import { icon } from './icons.js';
import { paintAvatar } from './header.js';
import { GOOGLE_G, startGoogle } from './auth.js';

const fmtDate = ts => new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/** "Chrome on macOS" from a user agent string; good enough to recognise your own devices. */
export function describeUA(ua) {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|python|node|Go-http/i.test(ua) ? 'Script' : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** "just now", "5 minutes ago", "3 days ago", then a date. */
export function fmtAgo(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 120) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 86400 * 2) return `${Math.floor(s / 3600)} hours ago`.replace(/^1 hours/, '1 hour');
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return fmtDate(ts);
}

/* ================= routing ================= */
const SECTIONS = [
  ['profile', 'Profile', 'user'],
  ['security', 'Sign-in & devices', 'lock'],
  ['data', 'Your data', 'download'],
];
let page = null;       // #account, built on first open
let section = 'profile';
let data = null;       // { u, config } while open
let back = null;       // the hash to return to

/** The section a hash points at (#/account → 'profile'), or null when it isn't the account page. */
export function accountRoute(h = location.hash) {
  const m = /^#\/account(?:\/([a-z]+))?\/?$/.exec(h);
  return m ? m[1] || 'profile' : null;
}
export const accountOpen = () => !!page && !page.hidden;

/** Opens the page (from the account menu or links); the hash change shows it. */
export function openAccountSettings(to = '') {
  location.hash = '#/account' + (to ? '/' + to : '');
}

export function closeAccount() {
  location.hash = back || boardHash(cur);
}

/** Shows, switches or hides the page for the current hash. True when the account page handled it. */
export function routeAccount(oldURL) {
  const to = accountRoute();
  if (!to || VIEW || !user) { if (accountOpen()) hide(); return false; }
  section = to;
  if (!accountOpen()) {
    const from = oldURL ? new URL(oldURL).hash : '';
    back = from && !accountRoute(from) ? from : null;
    show();
  } else { page.scrollTop = 0; draw(); }
  return true;
}

function show() {
  if (!page) {
    page = document.createElement('div');
    page.id = 'account';
    page.hidden = true;
    page.innerHTML = `
      <header class="ac-top"><button class="ac-back" type="button">${icon('arrowLeft', 16)}<span>Back to boards</span></button></header>
      <div class="ac-wrap">
        <h1 class="ac-h1">Account settings</h1>
        <div class="ac-grid"><nav class="ac-nav" aria-label="Account settings"></nav><main class="ac-main" tabindex="-1"></main></div>
      </div>`;
    $('.ac-back', page).onclick = closeAccount;
    document.body.append(page);
  }
  page.hidden = false;
  page.scrollTop = 0;
  document.body.classList.add('account-open');
  data = null;
  draw();
  load().then(draw, e => { $('.ac-main', page).innerHTML = `<p class="ac-sub">${esc(e.message)}</p>`; });
}

function hide() {
  page.hidden = true;
  document.body.classList.remove('account-open');
  data = null;
  $('#canvas')?.focus({ preventScroll: true });
}

async function load() {
  const me = await api('auth/me');
  if (!me.user) return location.reload();
  data = { u: me.user, config: me.config };
}

function draw() {
  if (data && !SECTIONS.some(([k]) => k === section)) { section = 'profile'; history.replaceState(null, '', '#/account'); }
  const u = data?.u || user;
  $('.ac-nav', page).innerHTML = `
    <div class="ac-me"><span class="ac-avatar">${esc(((u.name || u.email || '?').trim()[0] || '?').toUpperCase())}</span>
      <div><b>${esc(u.name || u.email)}</b><small>${esc(u.email)}</small></div></div>
    ${SECTIONS.map(([k, label, ic]) => `<a href="#/account/${k}"${k === section ? ' class="on" aria-current="page"' : ''}>${icon(ic, 17)}<span>${label}</span></a>`).join('')}`;
  const nav = $('.ac-nav', page), on = $('a.on', nav);   // the narrow layout scrolls the nav sideways: keep the current one in view
  if (on) nav.scrollLeft += on.getBoundingClientRect().left - nav.getBoundingClientRect().left - 8;
  const main = $('.ac-main', page);
  if (!data) { main.innerHTML = '<p class="ac-sub">Loading…</p>'; return; }
  main.innerHTML = ({ profile: profileHtml, security: securityHtml, data: dataHtml })[section]();
  ({ profile: wireProfile, security: wireSecurity, data: wireData })[section](main);
}

const head = (title, lead) => `<header class="ac-head"><h2>${title}</h2><p>${lead}</p></header>`;

/* ================= profile ================= */
function profileHtml() {
  const { u, config } = data;
  const email = !config.verification ? ''
    : u.verified ? '<span class="ac-tag ok">Confirmed</span>'
    : '<span class="ac-tag warn">Not confirmed</span> <button class="ac-link" type="button" data-resend>Send the link again</button>';
  return head('Profile', 'How you appear to the people you work with.') + `
    <section class="ac-card">
      <form class="ac-form" data-name-form>
        <label class="ac-field"><span>Name</span>
          <input class="field" name="name" value="${esc(u.name)}" maxlength="120" autocomplete="name" required>
          <small>Shown on your comments, next to your cursor and to people you share boards with.</small></label>
        <label class="ac-field"><span>Email</span>
          <input class="field" type="email" value="${esc(u.email)}" disabled>
          <small>${email || 'You sign in with this address.'}</small></label>
        <div class="ac-actions"><button class="btn" type="submit" disabled>Save changes</button></div>
      </form>
    </section>`;
}

function wireProfile(main) {
  const form = $('[data-name-form]', main), input = form.elements.name, save = $('[type=submit]', form);
  input.addEventListener('input', () => { save.disabled = !input.value.trim() || input.value.trim() === data.u.name; });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name || name === data.u.name) return;
    save.disabled = true;
    try {
      const { user: nu } = await api('auth/me', { method: 'PATCH', body: { name } });
      Object.assign(user, nu); data.u.name = nu.name; paintAvatar(); draw(); toast('Name updated');
    } catch (err) { toast(err.message); save.disabled = false; }
  });
  $('[data-resend]', main)?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { toast((await api('auth/verify/resend', { method: 'POST' })).message || 'Email sent'); } catch (err) { toast(err.message); }
    btn.disabled = false;
  });
}

/* ================= sign-in & devices ================= */
function securityHtml() {
  const { u, config } = data;
  // Google: connected (disconnecting needs a password to fall back on), or offered when the server has it set up
  const google = u.google ? `
    <section class="ac-card">
      <h3>Google</h3>
      <p class="ac-sub">You can sign in with the Google account <b>${esc(u.google)}</b>.</p>
      ${u.password ? '<div class="ac-actions"><button class="btn ghost" type="button" data-google-off>Disconnect Google</button></div>'
        : '<p class="ac-sub ac-tail">To disconnect Google, choose a password first.</p>'}
    </section>`
    : config.google ? `
    <section class="ac-card">
      <h3>Google</h3>
      <p class="ac-sub">Sign in with one click using your Google account.</p>
      <div class="ac-actions"><button class="btn ghost" type="button" data-google-on>${GOOGLE_G}Connect Google</button></div>
    </section>` : '';
  const password = u.password ? `
    <section class="ac-card">
      <h3>Change password</h3>
      <p class="ac-sub">Changing it signs you out on every other device.</p>
      <form class="ac-form" data-pass>
        <label class="ac-field"><span>Current password</span><input class="field" type="password" name="current" autocomplete="current-password" required></label>
        <label class="ac-field"><span>New password</span><input class="field" type="password" name="next" autocomplete="new-password" minlength="8" required><small>At least 8 characters.</small></label>
        <label class="ac-field"><span>Confirm new password</span><input class="field" type="password" name="confirm" autocomplete="new-password" minlength="8" required></label>
        <div class="ac-actions"><button class="btn" type="submit">Change password</button></div>
      </form>
    </section>` : `
    <section class="ac-card">
      <h3>Password</h3>
      <p class="ac-sub">You sign in with Google, so your account has no password yet. To also sign in with your email and a password, we’ll email you a link to choose one.</p>
      <div class="ac-actions"><button class="btn ghost" type="button" data-pass-link>Email me a link</button></div>
    </section>`;
  return head('Sign-in &amp; devices', 'Keep your account secure and see where you’re signed in.') + google + password + `
    <section class="ac-card">
      <h3>Signed-in devices</h3>
      <div class="ac-sessions"><p class="ac-sub">Loading…</p></div>
    </section>`;
}

function wireSecurity(main) {
  $('[data-pass]', main)?.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const current = f.get('current'), next = f.get('next'), confirm = f.get('confirm');
    if (next !== confirm) return toast('The new passwords don’t match');
    try {
      await api('auth/me', { method: 'PATCH', body: { password: current, newPassword: next } });
      e.target.reset();
      toast('Password changed. Other devices were signed out.');
      drawSessions($('.ac-sessions', main));
    } catch (err) { toast(err.message); }
  });
  $('[data-pass-link]', main)?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { toast((await api('auth/password/link', { method: 'POST' })).message); } catch (err) { toast(err.message); }
    btn.disabled = false;
  });
  $('[data-google-on]', main)?.addEventListener('click', e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    startGoogle({ link: true }).catch(err => { toast(err.message); btn.disabled = false; });
  });
  $('[data-google-off]', main)?.addEventListener('click', disconnectGoogle);
  drawSessions($('.ac-sessions', main));
}

/** Stop signing in with Google; the server asks for the password, the way back in from then on. */
function disconnectGoogle() {
  const card = openModal(`
    <h2>Disconnect Google?</h2>
    <p>You’ll sign in with your email address and password from now on. Enter your password to confirm.</p>
    <form>
      <input class="field" type="password" name="password" placeholder="Password" autocomplete="current-password" required>
      <div class="m-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="submit">Disconnect</button></div>
    </form>
  `);
  $('input', card).focus();
  $('form', card).addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const { user: nu } = await api('auth/google', { method: 'DELETE', body: { password: $('input', card).value } });
      Object.assign(user, nu); Object.assign(data.u, nu);
      closeModal(); draw(); toast('Google is disconnected');
    } catch (err) { toast(err.message); }
  });
}

async function drawSessions(box) {
  let list;
  try { ({ sessions: list } = await api('account/sessions')); } catch (e) { box.innerHTML = `<p class="ac-sub">${esc(e.message)}</p>`; return; }
  if (!box.isConnected) return;
  const others = list.filter(s => !s.current);
  box.innerHTML = `<ul class="ac-devices">${list.map(s => `
      <li>
        <div><b>${esc(describeUA(s.ua))}</b>${s.current ? ' <span class="ac-tag ok">This device</span>' : ''}
          <small>${s.current ? 'Active now' : 'Last active ' + esc(fmtAgo(s.seen))}${s.ip ? ' · ' + esc(s.ip) : ''} · Signed in ${esc(fmtDate(s.created))}</small></div>
        ${s.current ? '' : `<button class="btn ghost sm" type="button" data-end="${esc(s.id)}">Sign out</button>`}
      </li>`).join('')}</ul>
    ${others.length ? '<div class="ac-actions"><button class="btn ghost" type="button" data-end-all>Sign out all other devices</button></div>'
      : '<p class="ac-sub ac-tail">You’re not signed in anywhere else.</p>'}`;
  box.onclick = async e => {
    const one = e.target.closest('[data-end]');
    const all = e.target.closest('[data-end-all]');
    if (!one && !all) return;
    if (all && !await confirmDialog('Sign out all other devices?', { body: `${others.length === 1 ? 'One other device' : others.length + ' other devices'} will need to sign in again. You stay signed in here.`, ok: 'Sign out' })) return;
    try {
      await api('account/sessions' + (one ? '/' + one.dataset.end : ''), { method: 'DELETE' });
      toast(one ? 'Signed out that device' : 'Signed out all other devices');
      drawSessions(box);
    } catch (err) { toast(err.message); }
  };
}

/* ================= your data ================= */
function dataHtml() {
  const { config } = data;
  return head('Your data', 'Take everything with you, or close your account.') + `
    <section class="ac-card">
      <h3>Download your data</h3>
      <p class="ac-sub">Everything in your account: your boards as JSON you can import back into Kolam, a Markdown file for every board, and your uploaded files.</p>
      <div class="ac-actions"><button class="btn ghost" type="button" data-export>${icon('download', 16)}Download all my data</button></div>
    </section>
    <section class="ac-card ac-danger">
      <h3>Delete account</h3>
      <p class="ac-sub">Deleting your account removes everything ${config.graceDays} days after you ask, unless you sign in again before then. Workspaces you own with other people in them pass to one of them automatically.</p>
      <div class="ac-actions"><button class="btn ghost danger-text" type="button" data-delete>Delete account…</button></div>
    </section>`;
}

function wireData(main) {
  $('[data-export]', main).addEventListener('click', () => { track('data_export'); location.href = API_BASE + 'account/export'; });
  $('[data-delete]', main).addEventListener('click', () => deleteAccountFlow(data.config.graceDays));
}

async function deleteAccountFlow(graceDays) {
  const ok = await confirmDialog('Delete your account?', {
    body: `Your account and everything in it will be permanently deleted ${graceDays} days from now. Workspaces you own with other people in them pass to one of them automatically. Signing in again before then cancels it.`,
    ok: 'Continue', danger: true,
  });
  if (!ok) return;
  // an account without a password (made with Google) confirms by typing its email address instead
  const { email, password: hasPassword } = data.u;
  const card = openModal(hasPassword ? `
    <h2>Confirm with your password</h2>
    <p>Enter your password to schedule your account for deletion.</p>
    <form>
      <input class="field" type="password" name="password" placeholder="Password" autocomplete="current-password" required>
      <div class="m-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn danger" type="submit">Delete my account</button></div>
    </form>
  ` : `
    <h2>Confirm with your email</h2>
    <p>Type <b>${esc(email)}</b> to schedule your account for deletion.</p>
    <form>
      <input class="field" type="email" name="email" placeholder="Email address" autocomplete="off" required>
      <div class="m-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn danger" type="submit">Delete my account</button></div>
    </form>
  `);
  $('input', card).focus();
  $('form', card).addEventListener('submit', async e => {
    e.preventDefault();
    const value = $('input', card).value;
    try {
      const r = await api('account/delete', { method: 'POST', body: hasPassword ? { password: value } : { email: value } });
      card.innerHTML = `<h2>Account scheduled for deletion</h2>
        <p>Your account will be permanently deleted on <b>${esc(fmtDate(r.deleteAt))}</b>. Signing in again before then cancels it.</p>
        <div class="m-actions"><button class="btn" data-done>OK</button></div>`;
      // reload without #/account, so signing in again lands on the boards
      $('[data-done]', card).addEventListener('click', () => { closeModal(); location.replace(location.pathname + location.search); });
    } catch (err) { toast(err.message); }
  });
}
