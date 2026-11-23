/* Cookie banner: asks visitors from the EU, EEA, UK and Switzerland before analytics runs (core/analytics.js decides
 * who). Accept and Reject are equal; the choice stays in this browser and "Cookie settings" in the ? menu reopens it. */
import { esc } from '../core/util.js';
import { consentChoice, setAnalyticsConsent } from '../core/analytics.js';

let el = null;

/** Shows the banner; `site` is the public website (for the cookie policy link), or null. */
export function showConsentBanner(site) {
  if (!el) {
    el = document.createElement('div');
    el.id = 'consentBanner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Cookies');
    el.innerHTML = `<p>We'd like to use analytics cookies (Google Analytics) to see which parts of Kolam get used. They never record your boards' content.${site ? ` <a href="${esc(site)}/cookies" target="_blank" rel="noopener">Cookie policy</a>` : ''}</p>
      <div class="cb-actions"><button type="button" class="btn ghost" data-consent="no">Reject</button><button type="button" class="btn ghost" data-consent="yes">Accept</button></div>`;
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-consent]');
      if (!b) return;
      setAnalyticsConsent(b.dataset.consent === 'yes');
      el.hidden = true;
    });
    document.body.append(el);
  }
  const current = consentChoice();
  el.querySelectorAll('[data-consent]').forEach(b => b.setAttribute('aria-pressed', String(current === (b.dataset.consent === 'yes' ? 'granted' : 'denied'))));
  el.hidden = false;
}
