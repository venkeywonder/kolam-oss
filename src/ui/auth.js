/* Sign-in / create-account screen shown before the app loads. */
import { esc } from '../core/util.js';
import { api } from '../core/api.js';
import { track } from '../core/analytics.js';
import { forgetDevice } from '../core/pwa.js';

// the Kolam emblem (made by brand/generate.py); CSS shows the one for the theme
const LOGO = ['light', 'dark'].map((t) => `<img class="emblem emblem-${t}" src="src/assets/emblem-${t}.svg" width="40" height="40" alt="">`).join('');

const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.9M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/></svg>';

// Google's "G" for the Continue with Google buttons
export const GOOGLE_G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

/**
 * Sends the browser to Google to sign in; the server runs the flow and brings it back to the app (server/src/Google.php).
 * body: invite, or join and k (signing up through a link); link: true to connect Google to the signed-in account.
 */
export async function startGoogle(body = {}) {
  const { url } = await api('auth/google', { method: 'POST', body });
  location.assign(url);
}

/** Words for the code a Google sign-in comes back with (?gerr=). '' = say nothing (you cancelled it yourself). */
export function googleError(code) {
  return ({
    cancelled: '',
    expired: 'That Google sign-in expired. Please try again.',
    unverified: 'Google hasn’t verified that account’s email address. Use another Google account, or your email and password.',
    other: 'Your Kolam account is connected to a different Google account. Use that one, or your email and password.',
    taken: 'That Google account is already connected to another Kolam account.',
    relink: 'You were signed out while at Google. Sign in, then connect Google again from Account settings.',
    suspended: 'This account is suspended. Contact support if you think this is a mistake.',
    invite: 'Use the Google account with the address the invitation was sent to.',
    closed: 'Sign-ups are closed on this server.',
    disposable: 'Please use a permanent email address.',
    busy: 'Too many attempts. Wait a few minutes and try again.',
  })[code] ?? 'Signing in with Google didn’t work. Please try again.';
}

/**
 * One labelled input with a line under it for its hint, Caps Lock warning or error.
 * attrs: the input's other attributes, already escaped. aside: markup at the end of the label row.
 * Password fields get a show/hide eye button.
 */
function field({ name, label, type = 'text', attrs = '', aside = '', hint = '' }) {
  const id = 'auth-' + name;
  const input = `<input id="${id}" name="${name}" type="${type}" aria-describedby="${id}-msg" ${attrs}>`;
  return `<div class="auth-field">
      <div class="auth-label"><label for="${id}">${label}</label>${aside}</div>
      ${type === 'password' ? `<span class="pw">${input}<button type="button" class="pw-eye" aria-label="Show password" aria-pressed="false">${EYE}</button></span>` : input}
      <p class="auth-msg" id="${id}-msg" data-hint="${esc(hint)}">${esc(hint)}</p>
    </div>`;
}
const EMAIL_ATTRS = 'autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" required placeholder="you@example.com"';

const msgOf = inp => inp.closest('.auth-field')?.querySelector('.auth-msg');
/** Shows text on an input's message line: an error (kind 'err'), a warning ('warn'), or its hint when text is empty. */
function setMsg(inp, text = '', kind = '') {
  const msg = msgOf(inp);
  if (!msg) return;
  msg.textContent = text || msg.dataset.hint;
  msg.className = 'auth-msg' + (text ? ' ' + kind : '');
  if (kind === 'err') inp.setAttribute('aria-invalid', 'true'); else inp.removeAttribute('aria-invalid');
  markLength(inp);
}
/** A new password's "At least 8 characters." hint turns green once it's long enough. */
function markLength(inp) {
  if (inp.autocomplete !== 'new-password') return;
  const msg = msgOf(inp);
  msg.classList.toggle('ok', !msg.classList.contains('err') && !msg.classList.contains('warn') && inp.value.length >= 8);
}

/** Checks the form in the browser before sending it. Marks each bad field, focuses the first and returns false. */
function checkFields(form) {
  let first = null;
  for (const inp of form.querySelectorAll('.auth-field input')) {
    const v = inp.value.trim(), isNew = inp.autocomplete === 'new-password';
    const err = inp.required && !v ? (inp.type === 'email' ? 'Enter your email address.' : 'Enter your password.')
      : inp.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'That email address doesn’t look right.'
      : isNew && inp.value.length < 8 ? 'Use at least 8 characters.'
      : '';
    if (err) { setMsg(inp, err, 'err'); first ||= inp; }
  }
  first?.focus();
  return !first;
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.pw-eye');
  if (!btn) return;
  const inp = btn.previousElementSibling, show = inp.type === 'password';
  const at = inp.selectionStart, end = inp.selectionEnd;
  inp.type = show ? 'text' : 'password';
  btn.innerHTML = show ? EYE_OFF : EYE;
  btn.setAttribute('aria-pressed', String(show));
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  inp.focus();
  if (at != null) inp.setSelectionRange(at, end);
});
// typing clears a field's error and keeps a new password's hint up to date
document.addEventListener('input', e => {
  const inp = e.target;
  if (!inp.closest?.('#auth .auth-field')) return;
  if (inp.getAttribute('aria-invalid')) setMsg(inp); else markLength(inp);
});
// warn about Caps Lock while typing a password
const capsCheck = e => {
  const inp = e.target;
  if (!inp.closest?.('#auth .pw') || !e.getModifierState || inp.getAttribute('aria-invalid')) return;
  const on = e.getModifierState('CapsLock');
  const msg = msgOf(inp);
  if (on && !msg.classList.contains('warn')) setMsg(inp, 'Caps Lock is on.', 'warn');
  else if (!on && msg.classList.contains('warn')) setMsg(inp);
};
document.addEventListener('keydown', capsCheck);
document.addEventListener('keyup', capsCheck);

/** The small sideways shake for a refused form; still when the system asks for less motion. */
function shake(wrap) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  wrap.querySelector('.auth-card').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 260 });
}

let turnstileLoading = null;
/** Loads the Cloudflare Turnstile script once. Widgets are drawn by stampOpen, since each screen and sign-in/sign-up switch makes a new form. */
function loadTurnstile() {
  if (turnstileLoading) return turnstileLoading;
  return turnstileLoading = new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    s.onload = resolve; s.onerror = resolve;
    document.head.append(s);
  });
}
/** Gets a new Turnstile token after a refused try: the server spends a token on each check, so the old one won't pass again. */
function resetTurnstile(wrap) {
  const el = wrap.querySelector('.cf-turnstile');
  if (el?.childElementCount) window.turnstile?.reset(el);
}

// server/src/Bot.php turns away forms sent sooner than this after they were shown (bots fill them in at once)
const MIN_OPEN_MS = 2000;

/** Hidden anti-bot fields: a honeypot and the time the form was open. Call stampOpen(form) right after it's shown. */
function botFields(config) {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const widget = config?.turnstile
    ? `<div class="cf-turnstile" data-sitekey="${esc(config.turnstile)}" data-theme="${theme}" data-size="flexible"></div>`
    : '';
  if (config?.turnstile) loadTurnstile();
  return `<div class="auth-hp" aria-hidden="true"><label>Website<input name="website" type="text" tabindex="-1" autocomplete="off"></label></div>
    <input type="hidden" name="ms" value="0">
    ${widget}`;
}
function stampOpen(form) {
  form.dataset.opened = String(Date.now());
  const el = form.querySelector('.cf-turnstile');
  if (el) loadTurnstile().then(() => { if (el.isConnected && !el.childElementCount) window.turnstile?.render(el); });
}
/** Fills in how long the form was open, first waiting out the rest of MIN_OPEN_MS, so a password manager that fills and sends at once isn't refused. */
async function stampSent(form) {
  const opened = Number(form.dataset.opened), wait = MIN_OPEN_MS + 100 - (Date.now() - opened);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  form.querySelector('input[name=ms]').value = String(Date.now() - opened);
}

/** Shows the busy spinner on the form's button, or takes it away. */
function busy(wrap, on) {
  const btn = wrap.querySelector('.auth-btn');
  btn.disabled = on; btn.classList.toggle('busy', on);
  btn.setAttribute('aria-busy', String(on));
}

/** Fades the screen out and gives the page back to the app. */
function leave(wrap) {
  wrap.classList.add('leaving');
  setTimeout(() => { wrap.remove(); document.body.classList.remove('auth-mode'); }, 260);
}

/**
 * invite: details of an invitation link being opened ({ token, email, by, title, kind, hasAccount }).
 * The address it was sent to can create an account even when sign-ups are closed.
 * join: a join link being opened ({ token, key, by, title, role, workspace }); anyone with it can create an account.
 * config: auth/me's config block ({ turnstile, site, verification, ... }).
 * start: 'signup' to open on "Create an account" (the app's /signup address), when sign-ups are allowed.
 */
export function showAuth({ signup = true, message = '', invite = null, join = null, config = null, start = null } = {}) {
  return new Promise(resolve => {
    document.body.classList.add('auth-mode');
    const wrap = document.createElement('div');
    wrap.id = 'auth';
    const canSignup = signup || !!invite || !!join;
    let mode = (invite && !invite.hasAccount) || (start === 'signup' && canSignup) ? 'signup' : 'login';
    const as = { editor: 'an editor', commenter: 'a commenter', viewer: 'a viewer' }[join?.role] || 'a viewer';
    // what was typed, kept when switching between signing in and creating an account
    const typed = { name: '', email: invite?.email || '', password: '' };
    const keepTyped = () => { for (const k in typed) { const inp = wrap.querySelector(`input[name=${k}]`); if (inp) typed[k] = inp.value; } };
    const draw = (err = message) => {
      const isNew = mode === 'signup';
      document.title = `${isNew ? 'Create your account' : 'Sign in'} · Kolam`;
      const sub = invite
        ? `<b>${esc(invite.by)}</b> invited you to ${invite.kind === 'workspace' ? 'the workspace' : 'the board'} <b>${esc(invite.title)}</b>. ${isNew ? 'Create an account' : 'Sign in'} with ${esc(invite.email)} to join.`
        : join ? `<b>${esc(join.by)}</b> shared the board <b>${esc(join.title)}</b>${join.workspace ? ` in ${esc(join.workspace)}` : ''} with you. ${isNew ? 'Create an account' : 'Sign in'} to join it as ${as}.`
        : isNew ? 'Your boards, notes and files in one place, ready on any device.' : 'Sign in to pick up where you left off.';
      const terms = isNew && config?.site
        ? `<p class="auth-terms">By creating an account you agree to the <a href="${esc(config.site)}/terms" target="_blank" rel="noopener">Terms</a> and <a href="${esc(config.site)}/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>`
        : '';
      wrap.innerHTML = `
        <main class="auth-card" aria-labelledby="authTitle">
          <div class="auth-logo">${LOGO}</div>
          <h1 id="authTitle">${isNew ? 'Create your account' : 'Welcome back'}</h1>
          <p class="auth-sub">${sub}</p>
          ${config?.google ? `<button type="button" class="auth-google" data-google>${GOOGLE_G}Continue with Google</button><p class="auth-or"><span>or</span></p>` : ''}
          <form novalidate>
            ${isNew ? field({ name: 'name', label: 'Name', attrs: 'autocomplete="name" autocapitalize="words" maxlength="120" placeholder="Your name"' }) : ''}
            ${field({ name: 'email', label: 'Email', type: 'email', attrs: EMAIL_ATTRS })}
            ${isNew
              ? field({ name: 'password', label: 'Password', type: 'password', attrs: 'autocomplete="new-password" required', hint: 'At least 8 characters.' })
              : field({ name: 'password', label: 'Password', type: 'password', attrs: 'autocomplete="current-password" required', aside: '<button type="button" class="auth-forgot" data-forgot>Forgot password?</button>' })}
            ${botFields(config)}
            <div class="auth-err" role="alert">${esc(err)}</div>
            <button class="auth-btn" type="submit">${isNew ? (invite || join ? 'Create account and join' : 'Create account') : (invite || join ? 'Sign in and join' : 'Sign in')}</button>
          </form>
          ${terms}
          ${canSignup ? `<p class="auth-switch">${isNew ? 'Already have an account?' : 'New here?'} <button type="button" data-switch>${isNew ? 'Sign in' : 'Create an account'}</button></p>` : ''}
        </main>`;
      for (const k in typed) { const inp = wrap.querySelector(`input[name=${k}]`); if (inp) { inp.value = typed[k]; markLength(inp); } }
      // start in the first field still to fill in (an invite's email is filled in for you)
      [...wrap.querySelectorAll('.auth-field input')].find(i => !i.value)?.focus() ?? wrap.querySelector('.auth-field input').focus();
      stampOpen(wrap.querySelector('form'));
    };
    wrap.addEventListener('click', e => {
      if (e.target.closest('[data-switch]')) { keepTyped(); mode = mode === 'login' ? 'signup' : 'login'; draw(''); }
      const g = e.target.closest('[data-google]');
      if (g) {
        g.disabled = true;
        startGoogle({ invite: invite?.token, join: join?.token, k: join?.key }).catch(err => {
          g.disabled = false;
          wrap.querySelector('.auth-err').textContent = err.message;
        });
      }
      if (e.target.closest('[data-forgot]')) {
        keepTyped();
        wrap.remove();
        showForgot(config, typed.email).then(() => {
          document.body.classList.add('auth-mode');   // showForgot's "Back" took it away; without it the booting page hides #auth
          document.body.append(wrap);
          draw('');   // a fresh form: taking the screen out of the page emptied the Turnstile widget's frame
          wrap.querySelector('input[name=password]').focus();
        });
      }
    });
    wrap.addEventListener('submit', async e => {
      e.preventDefault();
      const form = e.target;
      wrap.querySelector('.auth-err').textContent = '';
      if (!checkFields(form)) return shake(wrap);
      busy(wrap, true);
      await stampSent(form);
      const body = Object.fromEntries(new FormData(form));
      if (invite && mode === 'signup') body.invite = invite.token;
      if (join && mode === 'signup') { body.join = join.token; body.k = join.key; }
      try {
        const { user } = await api('auth/' + mode, { method: 'POST', body });
        track(mode === 'signup' ? 'sign_up' : 'login', { method: 'email' });
        leave(wrap);
        resolve(user);
      } catch (err) {
        busy(wrap, false); resetTurnstile(wrap);
        wrap.querySelector('.auth-err').textContent = err.message;
        shake(wrap);
      }
    });
    draw();
    document.body.append(wrap);
  });
}

/** "Forgot password?": ask for the email (filled in with the one typed so far), then show the same neutral confirmation either way. */
export function showForgot(config, email = '') {
  return new Promise(resolve => {
    document.body.classList.add('auth-mode');
    document.title = 'Reset your password · Kolam';
    const wrap = document.createElement('div');
    wrap.id = 'auth';
    const back = '<p class="auth-switch"><button type="button" data-back>Back to sign in</button></p>';
    const drawForm = () => {
      wrap.innerHTML = `
        <main class="auth-card" aria-labelledby="authTitle">
          <div class="auth-logo">${LOGO}</div>
          <h1 id="authTitle">Reset your password</h1>
          <p class="auth-sub">Enter your account’s email address and we’ll send you a link to choose a new password.</p>
          <form novalidate>
            ${field({ name: 'email', label: 'Email', type: 'email', attrs: EMAIL_ATTRS })}
            ${botFields(config)}
            <div class="auth-err" role="alert"></div>
            <button class="auth-btn" type="submit">Send reset link</button>
          </form>
          ${back}
        </main>`;
      const inp = wrap.querySelector('input[name=email]');
      inp.value = email;
      inp.focus();
      stampOpen(wrap.querySelector('form'));
    };
    const drawDone = sentTo => {
      wrap.innerHTML = `
        <main class="auth-card" aria-labelledby="authTitle">
          <div class="auth-logo">${LOGO}</div>
          <h1 id="authTitle">Check your email</h1>
          <p class="auth-sub">If an account exists for <b>${esc(sentTo)}</b>, we’ve sent a link to reset the password. It can take a minute to arrive, so check your spam folder too.</p>
          ${back}
        </main>`;
      wrap.querySelector('[data-back]').focus();
    };
    wrap.addEventListener('click', e => {
      if (!e.target.closest('[data-back]')) return;
      wrap.remove(); document.body.classList.remove('auth-mode');
      document.title = 'Sign in · Kolam';
      resolve();
    });
    wrap.addEventListener('submit', async e => {
      e.preventDefault();
      const form = e.target;
      wrap.querySelector('.auth-err').textContent = '';
      if (!checkFields(form)) return shake(wrap);
      busy(wrap, true);
      await stampSent(form);
      const body = Object.fromEntries(new FormData(form));
      try {
        await api('auth/forgot', { method: 'POST', body });
        drawDone(body.email);
      } catch (err) {
        busy(wrap, false); resetTurnstile(wrap);
        wrap.querySelector('.auth-err').textContent = err.message;
        shake(wrap);
      }
    });
    drawForm();
    document.body.append(wrap);
  });
}

/** The "Choose a new password" screen opened from a ?reset=<token> link. Resolves to the signed-in user. */
export function showReset(token) {
  return new Promise(resolve => {
    document.body.classList.add('auth-mode');
    document.title = 'Choose a new password · Kolam';
    const wrap = document.createElement('div');
    wrap.id = 'auth';
    wrap.innerHTML = `
      <main class="auth-card" aria-labelledby="authTitle">
        <div class="auth-logo">${LOGO}</div>
        <h1 id="authTitle">Choose a new password</h1>
        <p class="auth-sub">Pick a new password for your account.</p>
        <form novalidate>
          ${field({ name: 'password', label: 'New password', type: 'password', attrs: 'autocomplete="new-password" required', hint: 'At least 8 characters.' })}
          <div class="auth-err" role="alert"></div>
          <button class="auth-btn" type="submit">Set new password and sign in</button>
        </form>
      </main>`;
    wrap.addEventListener('submit', async e => {
      e.preventDefault();
      const form = e.target;
      wrap.querySelector('.auth-err').textContent = '';
      if (!checkFields(form)) return shake(wrap);
      busy(wrap, true);
      try {
        const { user } = await api('auth/reset', { method: 'POST', body: { token, password: form.password.value } });
        leave(wrap);
        resolve(user);
      } catch (err) {
        busy(wrap, false);
        wrap.querySelector('.auth-err').textContent = err.message;
        shake(wrap);
      }
    });
    document.body.append(wrap);
    wrap.querySelector('input').focus();
  });
}

/** A link with a password: ask for it before showing anything. Resolves to the key the server gives for it. */
export function showLinkPassword(token, message = '') {
  return new Promise(resolve => {
    document.body.classList.add('auth-mode');
    const wrap = document.createElement('div');
    wrap.id = 'auth';
    wrap.innerHTML = `
      <main class="auth-card" aria-labelledby="authTitle">
        <div class="auth-logo">${LOGO}</div>
        <h1 id="authTitle">This link has a password</h1>
        <p class="auth-sub">Enter the password you were given with the link.</p>
        <form novalidate>
          ${field({ name: 'password', label: 'Password', type: 'password', attrs: 'autocomplete="off" required' })}
          <div class="auth-err" role="alert">${esc(message)}</div>
          <button class="auth-btn" type="submit">Open</button>
        </form>
      </main>`;
    document.body.append(wrap);
    const inp = wrap.querySelector('input');
    inp.focus();
    wrap.addEventListener('submit', async e => {
      e.preventDefault();
      wrap.querySelector('.auth-err').textContent = '';
      if (!checkFields(e.target)) return shake(wrap);
      busy(wrap, true);
      try {
        const { key } = await api(`shared/${encodeURIComponent(token)}/unlock`, { method: 'POST', body: { password: inp.value } });
        wrap.remove(); document.body.classList.remove('auth-mode');
        resolve(key);
      } catch (err) {
        busy(wrap, false);
        wrap.querySelector('.auth-err').textContent = err.message;
        inp.select();
        shake(wrap);
      }
    });
  });
}

export async function signOut() {
  await forgetDevice().catch(() => {});   // no desktop notifications for this account here any more
  try { await api('auth/logout', { method: 'POST' }); } catch {}
  location.reload();
}
