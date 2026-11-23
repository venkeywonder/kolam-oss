/*
 * Live updates and presence.
 * - When the server runs server/bin/realtime (REALTIME_URL), a WebSocket says the moment the space changes (we then pull)
 *   and who else is here. If it drops, we reconnect with backoff and poll in the meantime.
 * - Without it (shared hosting), sync polls every second and presence goes through POST /api/presence.
 */
import { api } from './api.js';
import { SPACE, VIEW, cur, docOpen, editingId, user } from './store.js';
import { poke } from './sync.js';
import { setPeople } from '../ui/presence.js';
import { noteSeen } from '../ui/notify.js';

const client = Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
let ws = null, live = false, connecting = false, retry = 0, lastSent = '', lastHttp = 0;
export const isLive = () => live;

async function connect() {
  if (VIEW || !user || ws || connecting) return;
  connecting = true;
  let t;
  try { t = await api('realtime/ticket', { method: 'POST' }); } catch { connecting = false; return later(); }
  connecting = false;
  if (!t.url) return;   // this server has no realtime process: polling only
  try { ws = new WebSocket(t.url + (t.url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(t.ticket)); }
  catch { ws = null; return later(); }
  ws.onopen = () => { live = true; retry = 0; subscribe(); };
  ws.onmessage = e => { try { onMessage(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => { live = false; ws = null; later(); };
}
const later = () => setTimeout(connect, Math.min(30000, 2000 * 2 ** retry++));
const send = m => { if (live) ws.send(JSON.stringify(m)); };

function subscribe() {
  setPeople([]);
  lastSent = '';
  if (SPACE) { send({ t: 'sub', space: SPACE, client }); announce(true); }
}

function onMessage(m) {
  if (m.t === 'note') return noteSeen(m.at);
  if (m.space && m.space !== SPACE) return;
  if (m.t === 'rev') poke(m.rev, m.acl);
  else if (m.t === 'presence') setPeople(m.people || []);
  else if (m.t === 'gone') dispatchEvent(new CustomEvent('nk:lost', { detail: { space: m.space } }));
}

/** Where this tab is: the board on screen and the card being typed in (or the document open). */
const here = () => ({ board: cur, editing: editingId || docOpen || null });

function announce(force = false) {
  if (VIEW || !user || !SPACE || (document.hidden && !live)) return;
  const s = JSON.stringify(here());
  if (live) {
    if (force || s !== lastSent) { send({ t: 'here', ...here() }); lastSent = s; }
    return;
  }
  // polling: report every 2 s (or at once when something changed); the answer is everyone else
  if (!force && s === lastSent && Date.now() - lastHttp < 2000) return;
  lastHttp = Date.now(); lastSent = s;
  const space = SPACE;
  api('presence', { method: 'POST', body: { space, client, ...here() } })
    .then(r => { noteSeen(r.note); if (space === SPACE) { setPeople(r.people || []); poke(r.rev); } }, () => {});
}

export function init() {
  if (VIEW) return;
  // the first space shown (after sign-in) also opens the connection
  addEventListener('nk:space', () => { if (!ws) connect(); live ? subscribe() : (setPeople([]), announce(true)); });
  setInterval(() => announce(), 300);   // only sends when something changed (polling: at most every 2 s otherwise)
  addEventListener('pagehide', () => {
    if (!live && SPACE) api('presence', { method: 'DELETE', body: { space: SPACE, client }, keepalive: true }).catch(() => {});
  });
}
