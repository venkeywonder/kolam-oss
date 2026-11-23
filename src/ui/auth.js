/* Sign-in / create-account screen shown before the app loads. */
import { esc } from '../core/util.js';
import { api } from '../core/api.js';
import { track } from '../core/analytics.js';

const LOGO = '<svg viewBox="12.5 12.5 231 231" width="36" height="36" aria-hidden="true"><path d="M128 128V78A50 50 0 1 0 78 128H178A50 50 0 0 0 228 78V28H178A50 50 0 0 0 128 78V178A50 50 0 0 0 178 228H228V178A50 50 0 0 0 178 128H78A50 50 0 1 0 128 178Z" fill="none" stroke="currentColor" stroke-width="31"/></svg>';

const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.9 3.9M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/></svg>';
/** A password input with a show/hide eye button. attrs: the input's other attributes, already escaped. */
const pwField = attrs => `<span class="pw"><input type="password" ${attrs}><button type="button" class="pw-eye" aria-label="Show password" aria-pressed="false">${EYE}</button></span>`;
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

let turnstileLoading = null;
/** Loads the Cloudflare Turnstile script once; the widget then auto-renders any .cf-turnstile div. */
function loadTurnstile() {
  if (turnstileLoading) return turnstileLoading;
  return turnstileLoading = new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true; s.defer = true;
    s.onload = resolve; s.onerror = resolve;
    document.head.append(s);
  });
}

/** Hidden anti-bot fields: a honeypot and the time the form was open. Call stampOpen(form) right after it's shown. */
function botFields(config) {
  const widget = config?.turnstile
    ? `<div class="cf-turnstile" data-sitekey="${esc(config.turnstile)}" data-theme="light"></div>`
    : '';
  if (config?.turnstile) loadTurnstile();
  return `<div class="auth-hp" aria-hidden="true"><label>Website<input name="website" type="text" tabindex="-1" autocomplete="off"></label></div>
    <input type="hidden" name="ms" value="0">
    ${widget}`;
}
function stampOpen(form) {
  const opened = Date.now();
  const ms = form.querySelector('input[name=ms]');
  form.addEventListener('submit', () => { ms.value = String(Date.now() - opened); }, { capture: true });
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
    const draw = (err = message) => {
      const isNew = mode === 'signup';
      const sub = invite
        ? `<b>${esc(invite.by)}</b> invited you to ${invite.kind === 'workspace' ? 'the workspace' : 'the board'} <b>${esc(invite.title)}</b>. ${isNew ? 'Create an account' : 'Sign in'} with ${esc(invite.email)} to join.`
        : join ? `<b>${esc(join.by)}</b> shared the board <b>${esc(join.title)}</b>${join.workspace ? ` in ${esc(join.workspace)}` : ''} with you. ${isNew ? 'Create an account' : 'Sign in'} to join it as ${as}.`
        : isNew ? 'Your boards, notes and files in one place, ready on any device.' : 'Sign in to pick up where you left off.';
      const terms = isNew && config?.site
        ? `<p class="auth-terms">By creating an account you agree to the <a href="${esc(config.site)}/terms" target="_blank" rel="noopener">Terms</a> and <a href="${esc(config.site)}/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>`
        : '';
      wrap.innerHTML = `
        <div class="auth-card" role="dialog" aria-labelledby="authTitle">
          <div class="auth-logo">${LOGO}</div>
          <h1 id="authTitle">${isNew ? 'Create your account' : 'Welcome back'}</h1>
          <p class="auth-sub">${sub}</p>
          <form novalidate>
            ${isNew ? '<label>Name<input name="name" autocomplete="name" maxlength="120" placeholder="Your name"></label>' : ''}
            <label>Email<input name="email" type="email" autocomplete="email" required placeholder="you@example.com" value="${esc(invite?.email || '')}"></label>
            <label>Password${pwField(`name="password" autocomplete="${isNew ? 'new-password' : 'current-password'}" required minlength="8" placeholder="${isNew ? 'At least 8 characters' : ''}"`)}</label>
            ${botFields(config)}
            <div class="auth-err" role="alert">${esc(err)}</div>
            <button class="auth-btn" type="submit">${isNew ? (invite || join ? 'Create account and join' : 'Create account') : (invite || join ? 'Sign in and join' : 'Sign in')}</button>
          </form>
          ${!isNew ? '<p class="auth-forgot"><button type="button" data-forgot>Forgot password?</button></p>' : ''}
          ${terms}
          ${canSignup ? `<p class="auth-switch">${isNew ? 'Already have an account?' : 'New here?'} <button type="button" data-switch>${isNew ? 'Sign in' : 'Create an account'}</button></p>` : ''}
        </div>`;
      wrap.querySelector(invite && isNew ? 'input[name=name]' : invite ? 'input[name=password]' : 'input').focus();
      stampOpen(wrap.querySelector('form'));
    };
    wrap.addEventListener('click', e => {
      if (e.target.closest('[data-switch]')) { mode = mode === 'login' ? 'signup' : 'login'; draw(''); }
      if (e.target.closest('[data-forgot]')) {
        wrap.remove();
        showForgot(config).then(() => document.body.append(wrap));
      }
    });
    wrap.addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target), btn = wrap.querySelector('.auth-btn');
      const body = Object.fromEntries(f);
      if (invite && mode === 'signup') body.invite = invite.token;
      if (join && mode === 'signup') { body.join = join.token; body.k = join.key; }
      btn.disabled = true; btn.classList.add('busy');
      try {
        const { user } = await api('auth/' + mode, { method: 'POST', body });
        track(mode === 'signup' ? 'sign_up' : 'login', { method: 'email' });
        wrap.classList.add('leaving');
        setTimeout(() => { wrap.remove(); document.body.classList.remove('auth-mode'); }, 260);
        resolve(user);
      } catch (err) {
        btn.disabled = false; btn.classList.remove('busy');
        wrap.querySelector('.auth-err').textContent = err.message;
        wrap.querySelector('.auth-card').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 260 });
      }
    });
    draw();
    document.body.append(wrap);
  });
}

/** "Forgot password?": ask for the email, then show the same neutral confirmation either way. */
export function showForgot(config) {
  return new Promise(resolve => {
    document.body.classList.add('auth-mode');
    const wrap = document.createElement('div');
    wrap.id = 'auth';
    const drawForm = (err = '') => {
      wrap.innerHTML = `
        <div class="auth-card" role="dialog" aria-labelledby="authTitle">
          <div class="auth-logo">${LOGO}</div>
          <h1 id="authTitle">Reset your password</h1>
          <p class="auth-sub">Enter your account's email address and we'll send you a link to choose a new password.</p>
          <form novalidate>
            <label>Email<input name="email" type="email" autocomplete="email" required placeholder="you@example.com"></label>
            ${botFields(config)}
            <div class="auth-err" role="alert">${esc(err)}</div>
            <button class="auth-btn" type="submit">Send reset link</button>
          </form>
          <p class="auth-switch"><button type="button" data-back>Back to sign in</button></p>
        </div>`;
      wrap.querySelector('input[name=email]').focus();
      stampOpen(wrap.querySelector('form'));
    };
    const drawDone = email => {
      wrap.innerHTML = `
        <div class="auth-card" role="dialog" aria-labelledby="authTitle">
          <div class="auth-logo">${LOGO}</div>
          <h1 id="authTitle">Check your email</h1>
          <p class="auth-sub">If an account exists for ${esc(email)}, we've sent a link to reset the password.</p>
          <p class="auth-switch"><button type="button" data-back>Back to sign in</button></p>
        </div>`;
    };
    wrap.addEventListener('click', e => { if (e.target.closest('[data-back]')) { wrap.remove(); document.body.classList.remove('auth-mode'); resolve(); } });
    wrap.addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target), btn = wrap.querySelector('.auth-btn');
      const body = Object.fromEntries(f);
      btn.disabled = true; btn.classList.add('busy');
      try {
        await api('auth/forgot', { method: 'POST', body });
        drawDone(body.email);
      } catch (err) {
        btn.disabled = false; btn.classList.remove('busy');
        wrap.querySelector('.auth-err').textContent = err.message;
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
    const wrap = document.createElement('div');
    wrap.id = 'auth';
    wrap.innerHTML = `
      <div class="auth-card" role="dialog" aria-labelledby="authTitle">
        <div class="auth-logo">${LOGO}</div>
        <h1 id="authTitle">Choose a new password</h1>
        <p class="auth-sub">Pick a new password for your account.</p>
        <form novalidate>
          <label>New password${pwField('name="password" autocomplete="new-password" required minlength="8" placeholder="At least 8 characters"')}</label>
          <div class="auth-err" role="alert"></div>
          <button class="auth-btn" type="submit">Set new password and sign in</button>
        </form>
      </div>`;
    wrap.querySelector('input').focus();
    wrap.addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target), btn = wrap.querySelector('.auth-btn');
      btn.disabled = true; btn.classList.add('busy');
      try {
        const { user } = await api('auth/reset', { method: 'POST', body: { token, password: f.get('password') } });
        wrap.classList.add('leaving');
        setTimeout(() => { wrap.remove(); document.body.classList.remove('auth-mode'); }, 260);
        resolve(user);
      } catch (err) {
        btn.disabled = false; btn.classList.remove('busy');
        wrap.querySelector('.auth-err').textContent = err.message;
        wrap.querySelector('.auth-card').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 260 });
      }
    });
    document.body.append(wrap);
  });
}

/** A link with a password: ask for it before showing anything. Resolves to the key the server gives for it. */
export function showLinkPassword(token, message = '') {
  return new Promise(resolve => {
    document.body.classList.add('auth-mode');
    const wrap = document.createElement('div');
    wrap.id = 'auth';
    wrap.innerHTML = `
      <div class="auth-card" role="dialog" aria-labelledby="authTitle">
        <div class="auth-logo">${LOGO}</div>
        <h1 id="authTitle">This link has a password</h1>
        <p class="auth-sub">Enter the password you were given with the link.</p>
        <form novalidate>
          <label>Password${pwField('name="password" autocomplete="off" required')}</label>
          <div class="auth-err" role="alert">${esc(message)}</div>
          <button class="auth-btn" type="submit">Open</button>
        </form>
      </div>`;
    document.body.append(wrap);
    const inp = wrap.querySelector('input'), btn = wrap.querySelector('.auth-btn');
    inp.focus();
    wrap.addEventListener('submit', async e => {
      e.preventDefault();
      if (!inp.value) return;
      btn.disabled = true; btn.classList.add('busy');
      try {
        const { key } = await api(`shared/${encodeURIComponent(token)}/unlock`, { method: 'POST', body: { password: inp.value } });
        wrap.remove(); document.body.classList.remove('auth-mode');
        resolve(key);
      } catch (err) {
        btn.disabled = false; btn.classList.remove('busy');
        wrap.querySelector('.auth-err').textContent = err.message;
        inp.select();
        wrap.querySelector('.auth-card').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 260 });
      }
    });
  });
}

export async function signOut() {
  try { await api('auth/logout', { method: 'POST' }); } catch {}
  location.reload();
}
