/*
 * Kolam's service worker: makes the app installable, shows desktop notifications (Web Push, server/src/Push.php) and
 * opens the right board when one is clicked. Pages always come from the network; without one, a short offline page.
 */
const SCOPE = new URL(self.registration.scope);
const ICON = new URL('src/assets/icons/icon-192.png', SCOPE).href;

const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kolam</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#ebedee;color:#323b4a;
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;text-align:center}
@media (prefers-color-scheme:dark){body{background:#1b1f26;color:#e6e8ec}}h1{font-size:20px;margin:0 0 6px}p{margin:0 0 18px;opacity:.75}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:9px 16px;background:#f4511c;color:#fff;cursor:pointer}</style></head>
<body><div><h1>You’re offline</h1><p>Kolam needs a connection to load your boards.</p><button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.mode !== 'navigate' || new URL(req.url).pathname.startsWith(SCOPE.pathname + 'api/')) return;
  e.respondWith(fetch(req).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

/** Open windows of the app itself (not share links or the website preview). */
async function appWindows() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.filter(c => {
    const u = new URL(c.url);
    return u.origin === SCOPE.origin && !u.searchParams.has('view') &&
      [SCOPE.pathname, SCOPE.pathname + 'index.html', SCOPE.pathname + 'login', SCOPE.pathname + 'signup'].includes(u.pathname);
  });
}

self.addEventListener('push', e => {
  let n = {};
  try { n = e.data?.json() || {}; } catch {}
  e.waitUntil((async () => {
    // open windows update their bell now, even in the background
    for (const w of await appWindows()) w.postMessage({ t: 'note', at: n.at });
    if (typeof n.unread === 'number' && self.navigator.setAppBadge) {
      await (n.unread ? self.navigator.setAppBadge(n.unread) : self.navigator.clearAppBadge()).catch(() => {});
    }
    await self.registration.showNotification(n.title || 'Kolam', {
      body: n.body || '', icon: ICON, tag: n.id, timestamp: n.at, data: { id: n.id },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const id = e.notification.data?.id;
  e.waitUntil((async () => {
    const [w] = await appWindows();
    if (w) {
      await w.focus();
      if (id) w.postMessage({ t: 'open', id });
      return;
    }
    await self.clients.openWindow(new URL(id ? './?n=' + encodeURIComponent(id) : './', SCOPE).href);
  })());
});

// the push service replaced this browser's subscription: tell the server the new one
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const key = e.oldSubscription?.options?.applicationServerKey;
    const sub = e.newSubscription || (key && await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    if (!sub) return;
    await fetch(new URL('api/push/subscriptions', SCOPE), {
      method: 'POST', credentials: 'same-origin', body: JSON.stringify(sub.toJSON()),
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kolam' },
    });
  })());
});
