/* Google Analytics for Firebase, only when the server sets FIREBASE_* (config.analytics from auth/me). Loads the
 * Firebase SDK from Google's CDN on demand, so self-hosted installs without it never contact Google. Browsers that
 * send Global Privacy Control or Do Not Track are not tracked. Visitors from the EU, EEA, UK and Switzerland (the
 * server tells from the country, the browser's time zone when it can't) are tracked only after they agree in the
 * cookie banner (ui/consent.js); their choice is kept in this browser. Events carry no board names or content. */
const SDK = 'https://www.gstatic.com/firebasejs/13.4.0/';
const CHOICE = 'kolam-consent';
const QUEUE_MAX = 200;

let cfg = null;       // the Firebase web config while analytics may run on this page
let fa = null;        // { analytics, logEvent, setUserId, setAnalyticsCollectionEnabled } once loaded
let queue = [];       // events tracked before the SDK finished loading (or before a choice); null when analytics is off
let loading = null;
const once = new Set();

const optedOut = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1';

/** 'granted', 'denied' or null: what this browser chose in the cookie banner. */
export function consentChoice() {
  try { return localStorage.getItem(CHOICE); } catch { return null; }
}

/** Time zones of the EU, EEA, UK and Switzerland, for when the server can't tell the country. */
function europeanTimeZone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  return tz.startsWith('Europe/') || /^(Atlantic\/(Canary|Madeira|Azores|Reykjavik|Faroe)|Asia\/(Nicosia|Famagusta)|Indian\/(Reunion|Mayotte)|America\/(Martinique|Guadeloupe|Cayenne|Marigot)|Arctic\/Longyearbyen)$/.test(tz);
}

/**
 * Starts analytics with the Firebase web config, or turns tracking off for this page when there is none.
 * `consentRequired` comes from the server (null: unknown country). Returns true when the visitor still has to choose,
 * so the caller shows the cookie banner; events wait until then.
 */
export function initAnalytics(config, consentRequired) {
  if (!config || optedOut()) { queue = null; return false; }
  cfg = config;
  const choice = consentChoice();
  if (choice === 'denied') { queue = null; return false; }
  if (choice === 'granted' || !(consentRequired ?? europeanTimeZone())) { start(); return false; }
  return true;
}

/** Whether this page could run analytics at all (so "Cookie settings" has something to change). */
export const analyticsAvailable = () => !!cfg;

/** The cookie banner's answer: start analytics, or stop it and remove its cookies. */
export function setAnalyticsConsent(granted) {
  try { localStorage.setItem(CHOICE, granted ? 'granted' : 'denied'); } catch {}
  if (granted) {
    if (fa) fa.setAnalyticsCollectionEnabled(fa.analytics, true);
    else { if (!queue) queue = []; start(); }
    return;
  }
  queue = null;
  if (fa) fa.setAnalyticsCollectionEnabled(fa.analytics, false);
  // Google Analytics' own cookies (_ga, _ga_<id>), on this host and its parent domains
  const names = document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(n => /^_ga(_|$)/.test(n));
  const parts = location.hostname.split('.');
  for (const n of names) {
    for (let i = 0; i < parts.length; i++) {
      const domain = parts.slice(i).join('.');
      document.cookie = `${n}=; Max-Age=0; path=/; domain=${domain}`;
    }
    document.cookie = `${n}=; Max-Age=0; path=/`;
  }
}

async function start() {
  if (!cfg || loading) return loading;
  loading = (async () => {
    try {
      const [{ initializeApp }, { getAnalytics, logEvent, setUserId, setAnalyticsCollectionEnabled }] = await Promise.all([
        import(SDK + 'firebase-app.js'), import(SDK + 'firebase-analytics.js'),
      ]);
      fa = { analytics: getAnalytics(initializeApp(cfg)), logEvent, setUserId, setAnalyticsCollectionEnabled };
      for (const [fn, args] of queue || []) fn(...args);
    } catch (e) { console.warn('Analytics unavailable', e); }
    queue = null;
  })();
  return loading;
}

function run(fn, args) {
  if (fa && consentChoice() !== 'denied') fn(...args);
  else if (queue && queue.length < QUEUE_MAX) queue.push([fn, args]);
}

/** The signed-in account's opaque id (u_…), so events from one person count as one user. */
export function setAnalyticsUser(id) {
  run(id => fa.setUserId(fa.analytics, id), [id]);
}

/** Logs an event; `onceKey` keeps it to once per page load (for things the app notices repeatedly). */
export function track(name, params = {}, onceKey = null) {
  if (onceKey) { if (once.has(onceKey)) return; once.add(onceKey); }
  run((n, p) => fa.logEvent(fa.analytics, n, p), [name, params]);
}

/** The product funnel: first board and cards, teammates invited, links shared, AI connected. */
export function trackAppEvents() {
  addEventListener('nk:created', e => track(e.detail.type === 'board' ? 'board_created' : 'card_created', { type: e.detail.type }));
  addEventListener('nk:invited', () => track('invite_sent'));
  addEventListener('nk:link-created', () => track('share_link_created'));
  addEventListener('nk:ai-connected', () => track('ai_connected', {}, 'ai_connected'));
}
