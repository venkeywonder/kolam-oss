/* Slim "confirm your email" banner, shown while EMAIL_VERIFICATION is on and the signed-in user hasn't verified yet.
 * It's a full-width strip above the app bars; --banner-h (read by account-email.css) pushes #topbar/#boardbar/#canvas/
 * #toolbar down by its real height so it never covers app controls. */
import { esc } from '../core/util.js';
import { api } from '../core/api.js';
import { toast } from './toast.js';

let el = null;
let dismissed = false;
let watching = false;
let resizeBound = false;

export function init(user, config) {
  if (!config?.verification || !user || user.verified) return;
  show(user.email);
  if (!watching) { addEventListener('focus', recheck); watching = true; }
}

function show(email) {
  if (dismissed) return;
  if (!el) {
    el = document.createElement('div');
    el.id = 'verifyBanner';
    el.innerHTML = `<span>Confirm your email to invite people, share links and upload files. We sent a link to <b>${esc(email)}</b>.</span>
      <button type="button" class="vb-resend">Send again</button>
      <button type="button" class="vb-close" aria-label="Dismiss">×</button>`;
    el.querySelector('.vb-close').onclick = () => { el.hidden = true; dismissed = true; updateOffset(); };
    el.querySelector('.vb-resend').onclick = async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const r = await api('auth/verify/resend', { method: 'POST' });
        toast(r.message || 'Email sent');
      } catch (err) {
        toast(err.message);
      }
      btn.disabled = false;
    };
    document.body.append(el);
  }
  el.hidden = false;
  updateOffset();
  if (!resizeBound) { addEventListener('resize', updateOffset); resizeBound = true; }
}

/** Measures the banner's real (possibly wrapped) height and offsets the app's fixed bars by exactly that much. */
function updateOffset() {
  const h = el && !el.hidden ? el.offsetHeight : 0;
  document.documentElement.style.setProperty('--banner-h', h + 'px');
}

/** The user may have verified in another tab; re-check auth/me when this tab regains focus. */
async function recheck() {
  if (!el || el.hidden) return;
  try {
    const me = await api('auth/me');
    if (me.user?.verified) { el.hidden = true; updateOffset(); removeEventListener('focus', recheck); watching = false; }
  } catch {}
}
