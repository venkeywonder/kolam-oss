/*
 * Kolam as an installed app (manifest.json, sw.js) and desktop notifications through Web Push (server/src/Push.php).
 * Desktop notifications are switched on per browser and per person: the choice is kept in this browser, and the server
 * ties the subscription to this sign-in, so the next person signing in here doesn't get them.
 */
import { api } from './api.js';

const canSW = 'serviceWorker' in navigator;
const pushable = canSW && 'PushManager' in window && 'Notification' in window;
let install = null;     // the browser's install prompt, kept for the Install button (src/ui/install.js)
let offered = false;    // the browser offered to install this page (its prompt can be used only once)
let done = false;       // installed from this tab just now
let serverKey = null;

export function init() {
  if (!canSW) return;
  navigator.serviceWorker.register(new URL('sw.js', document.baseURI), { scope: './', updateViaCache: 'none' })
    .catch(e => console.warn('Service worker not registered:', e));
  const changed = () => dispatchEvent(new Event('nk:installable'));
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); install = e; offered = true; changed(); });
  addEventListener('appinstalled', () => { install = null; done = true; changed(); });
}

/* ---------- installing ---------- */
/** Running as the installed app (its own window), not in a browser tab. */
export const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/**
 * How this browser installs Kolam, or null when it can't or already did ("nk:installable" fires when that changes):
 * prompt: its install dialog is ready; browser: it offered one already, now its address bar or menu installs;
 * safari: Safari on a Mac (File → Add to Dock); ios: iPhone or iPad (Share → Add to Home Screen).
 * Chrome and Edge don't offer it in a tab once Kolam is installed, so the button goes away there too.
 */
export function installWay() {
  if (installed() || done) return null;
  if (install) return 'prompt';
  if (offered) return 'browser';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  return /Macintosh/.test(ua) && /Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua) ? 'safari' : null;
}

/** Shows the browser's install dialog; true when the person installed Kolam. */
export async function promptInstall() {
  const e = install;
  install = null;
  if (!e) return false;
  e.prompt();
  return (await e.userChoice).outcome === 'accepted';
}

/* ---------- desktop notifications ---------- */
const prefKey = uid => 'nk-push:' + uid;
const bytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const same = (buf, arr) => { const a = new Uint8Array(buf || []); return a.length === arr.length && a.every((v, i) => v === arr[i]); };

/** unsupported | denied (blocked in the browser) | off | on — for this browser and this person. */
export function pushState(uid) {
  if (!pushable) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && localStorage.getItem(prefKey(uid)) === '1' ? 'on' : 'off';
}

async function subscribe() {
  serverKey ||= bytes((await api('push')).key);
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // made with another server key (another server at this address, or its key was reset): can't be used
  if (sub && !same(sub.options.applicationServerKey, serverKey)) { await sub.unsubscribe(); sub = null; }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  await api('push/subscriptions', { method: 'POST', body: sub.toJSON() });
}

/** Switch on from a click (browsers only ask for permission after one). Resolves to the new state. */
export async function enablePush(uid) {
  if (!pushable) return 'unsupported';
  const p = await Notification.requestPermission();
  if (p !== 'granted') return p === 'denied' ? 'denied' : 'off';
  await subscribe();
  localStorage.setItem(prefKey(uid), '1');
  return 'on';
}

export async function disablePush(uid) {
  localStorage.removeItem(prefKey(uid));
  await forgetDevice();
}

/** Stop this browser's notifications (signing out): the server forgets it and the browser drops the subscription. */
export async function forgetDevice() {
  if (!pushable) return;
  const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
  if (!sub) return;
  await api('push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/** After signing in: someone who switched them on here gets them again (a new sign-in is a new subscription). */
export function resumePush(uid) {
  if (pushState(uid) === 'on') subscribe().catch(e => console.warn('Desktop notifications:', e));
}

/** Messages from the service worker: {t: 'note', at} a notification arrived, {t: 'open', id} one was clicked. */
export function onWorkerMessage(fn) {
  if (canSW) navigator.serviceWorker.addEventListener('message', e => fn(e.data || {}));
}

/** The unread count on the installed app's icon. */
export function setBadge(n) {
  if (!installed() || !navigator.setAppBadge) return;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
