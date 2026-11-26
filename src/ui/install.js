/*
 * "Install app" in the top bar, while this browser can install Kolam and it isn't installed (never inside the installed
 * app), and at most once a day a small reminder under it, which "Don't show again" turns off (the button stays).
 */
import { $ } from '../core/util.js';
import { VIEW, user } from '../core/store.js';
import { installWay, promptInstall } from '../core/pwa.js';
import { icon } from './icons.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';

const btn = $('#installBtn');
const SHOWN = 'nk-install-nudge-at', NEVER = 'nk-install-nudge-off';
const DAY = 86400000;
let nudge = null, timer = 0;

const HOW = {
  browser: '<p>Click the install icon at the right end of the address bar. Or open the browser menu and choose <b>Install Kolam</b> (Chrome: <b>Cast, save and share</b>; Edge: <b>Apps</b>).</p>',
  safari: '<p>In Safari, choose <b>File → Add to Dock</b>. Kolam then opens in its own window from the Dock and Launchpad.</p>',
  ios: '<p>Tap <b>Share</b>, then <b>Add to Home Screen</b>. Kolam then opens from its icon like any app.</p>',
};

async function install() {
  hideNudge();
  const way = installWay();
  if (way === 'prompt') {
    if (await promptInstall()) toast('Kolam is installed. Open it from your Dock, Start menu or apps.');
    return paint();
  }
  if (HOW[way]) openModal(`<h2>Install Kolam</h2>${HOW[way]}<div class="m-actions"><button class="btn" data-close>Got it</button></div>`);
}

function paint() {
  const way = VIEW || !user ? null : installWay();
  btn.hidden = !way;
  if (!way) hideNudge();
}

/* ---------- the daily reminder ---------- */
function hideNudge() {
  nudge?.remove();
  nudge = null;
}

/** Something else needs the person's attention: a dialog, the account page, or the onboarding picker. */
const busy = () => document.hidden || !$('#modal').hidden || !!document.querySelector('.confirm-back') || document.body.classList.contains('account-open');

function place() {
  if (!nudge) return;
  const r = btn.getBoundingClientRect(), right = Math.max(10, innerWidth - r.right - 8);
  nudge.style.top = r.bottom + 10 + 'px';
  nudge.style.right = right + 'px';
  // the arrow (12 px wide) points at the button's middle
  nudge.style.setProperty('--arrow', innerWidth - right - (r.left + r.width / 2) - 6 + 'px');
}

function maybeNudge() {
  if (nudge || btn.hidden || localStorage.getItem(NEVER) || Date.now() - Number(localStorage.getItem(SHOWN) || 0) < DAY || busy()) return;
  localStorage.setItem(SHOWN, String(Date.now()));
  clearInterval(timer);
  nudge = document.createElement('div');
  nudge.id = 'installNudge';
  nudge.setAttribute('role', 'dialog');
  nudge.setAttribute('aria-label', 'Install Kolam');
  nudge.innerHTML = `<div class="in-top">${icon('download', 18)}<div><b>Install Kolam for a quick way back</b>` +
    '<p>It opens in its own window, straight from your Dock, Start menu or taskbar.</p></div></div>' +
    '<div class="in-actions"><button class="nt-link" type="button" data-never>Don’t show again</button>' +
    '<button class="btn ghost sm" type="button" data-later>Not now</button><button class="btn sm" type="button" data-install>Install</button></div>';
  nudge.addEventListener('click', e => {
    if (e.target.closest('[data-install]')) install();
    else if (e.target.closest('[data-later]')) hideNudge();
    else if (e.target.closest('[data-never]')) { localStorage.setItem(NEVER, '1'); hideNudge(); }
  });
  document.body.append(nudge);
  place();
}

export function init() {
  if (VIEW) return;
  btn.innerHTML = `${icon('download', 16)}<span>Install app</span>`;
  btn.addEventListener('click', install);
  addEventListener('nk:installable', paint);
  addEventListener('resize', place);
  addEventListener('keydown', e => { if (e.key === 'Escape') hideNudge(); });
  // once the boards are on screen: not straight away, and again later if something else was showing then
  addEventListener('nk:space', () => {
    paint();
    setTimeout(maybeNudge, 20000);
    timer = setInterval(maybeNudge, 60000);
  }, { once: true });
}
