/*
 * "Connect your AI": how to use Kolam from Claude Code or Codex on your own computer (Kolam's MCP server), with your own
 * subscription. Kolam runs no AI itself. Lists what's connected (signed-in apps and the access key) so it can be disconnected.
 */
import { $, $$, esc } from '../core/util.js';
import { icon } from './icons.js';
import { api, API_BASE } from '../core/api.js';
import { VIEW } from '../core/store.js';
import { panel as drawerPanel, renderPanel, setPanel } from './drawer.js';
import { toggle as toggleComments } from '../features/comments.js';
import { toast } from './toast.js';
import { confirmDialog } from './modal.js';

const API_ROOT = API_BASE.replace(/\/$/, '');
const KINDS = { app: 'Signed in', key: 'Access key' };

const el = $('#aiPanel');
let open = false;
let links = null;                // signed-in apps and access keys, from GET ai/state
let token = null;                // freshly created access key (shown once)

async function refresh() {
  if (!open) return;
  try {
    links = (await api('ai/state')).links || [];
    if (links.length) dispatchEvent(new CustomEvent('nk:ai-connected'));
    render();
  } catch (e) { if (e.status !== 401) toast(e.message); }
}

async function createToken() {
  if (links?.some(l => l.kind === 'key') && !await confirmDialog('Create a new access key?', { body: 'Anything still using the old key will stop working.', ok: 'Create key' })) return;
  try { token = (await api('ai/token', { method: 'POST' })).token; render(); refresh(); }
  catch (e) { toast(e.message); }
}

async function revoke(id) {
  const l = links?.find(x => x.id === id);
  if (!l || !await confirmDialog(`Disconnect “${l.name}”?`, { body: 'It will have to sign in again to reach your boards.', ok: 'Disconnect', danger: true })) return;
  try { await api(`ai/tokens/${id}`, { method: 'DELETE' }); refresh(); }
  catch (e) { toast(e.message); }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { prompt('Copy this command', text); }
}

const cmd = (label, text) => (label ? `<div class="ai-cmd-label">${label}</div>` : '') +
  `<div class="ai-cmd"><code>${esc(text)}</code><button class="icon-btn" data-act="copy" title="Copy">${icon('copy', 15)}</button></div>`;

function ago(t) {
  if (!t) return 'not used yet';
  const s = Date.now() / 1000 - t;
  return s < 120 ? 'used just now' : s < 7200 ? `used ${Math.round(s / 60)} min ago`
    : s < 172800 ? `used ${Math.round(s / 3600)} h ago` : `used ${Math.round(s / 86400)} days ago`;
}

function setupHtml() {
  const mcp = `${API_ROOT}/mcp`, list = links || [];
  const hasKey = list.some(l => l.kind === 'key');
  let h = `<div class="ai-setup"><p>Let Claude Code or Codex on your own computer read and change your boards, using your own subscription. ` +
    `Add Kolam once, sign in through your browser, then ask it things like “turn this board into a to-do list”.</p>` +
    `<details data-k="mcp" open><summary>Add Kolam to Claude Code or Codex</summary>` +
    cmd('Claude Code: then run <code>claude</code>, type <code>/mcp</code>, pick kolam and choose Authenticate.', `claude mcp add --transport http kolam '${mcp}'`) +
    cmd('Codex: your browser opens so you can allow it. Later, <code>codex mcp login kolam</code> signs in again.', `codex mcp add kolam --url '${mcp}'`) +
    `</details><details data-k="key"${token ? ' open' : ''}><summary>Access key for scripts and other apps</summary>`;
  if (token) {
    h += `<p class="ai-warn">This key is shown only once. It lets anything holding it read and change your boards.</p>` +
      cmd('Claude Code', `claude mcp add --transport http kolam '${mcp}' --header 'Authorization: Bearer ${token}'`) +
      cmd('Codex: add to ~/.codex/config.toml, then export KOLAM_TOKEN', `[mcp_servers.kolam]\nurl = "${mcp}"\nbearer_token_env_var = "KOLAM_TOKEN"`) +
      cmd('Codex token', `export KOLAM_TOKEN='${token}'`);
  } else {
    h += `<p>For tools that can’t sign in through a browser.${hasKey ? ' A new key replaces your current one.' : ''}</p>` +
      `<button class="ai-btn" data-act="token">${hasKey ? 'Create a new key' : 'Create access key'}</button>`;
  }
  h += '</details>';
  if (list.length) {
    h += `<h4>Connected to your boards</h4><ul class="ai-links">` + list.map(l =>
      `<li><span><b>${esc(l.name)}</b><small>${KINDS[l.kind] || ''} · ${ago(l.used)}</small></span>` +
      `<button class="ai-link" data-act="revoke" data-id="${esc(l.id)}">Disconnect</button></li>`).join('') + '</ul>';
  }
  return h + '</div>';
}

function render() {
  if (!open) return;
  if (!$('.ai-log', el)) {
    el.innerHTML = `<div class="ai-head"><span class="ai-mark">${icon('ai', 18)}</span><b>Connect your AI</b>` +
      `<button class="icon-btn" data-act="close" title="Close" aria-label="Close">${icon('close', 16)}</button></div><div class="ai-log"></div>`;
    el.addEventListener('click', e => {
      const t = e.target.closest('[data-act]'), a = t?.dataset.act;
      if (a === 'close') toggle(false);
      else if (a === 'token') createToken();
      else if (a === 'revoke') revoke(t.dataset.id);
      else if (a === 'copy') copy(t.previousElementSibling.textContent);
    });
    el.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false); });
  }
  const log = $('.ai-log', el);
  // keep what the person opened or closed across refreshes
  const had = $$('details[data-k]', log).length, wasOpen = new Set($$('details[open]', log).map(d => d.dataset.k));
  log.innerHTML = setupHtml();
  if (had) for (const d of $$('details[data-k]', log)) d.open = wasOpen.has(d.dataset.k) || (d.dataset.k === 'key' && !!token);
}

export function toggle(on = !open) {
  if (VIEW) return;
  open = on;
  el.hidden = !open;
  $('#aiBtn').classList.toggle('open', open);
  if (open) {
    if (drawerPanel) { setPanel(null); renderPanel(); }
    toggleComments(false);
    dispatchEvent(new CustomEvent('nk:panel', { detail: 'ai' }));
    render();
    refresh();
  } else token = null;
}

export function init() {
  if (VIEW) { $('#aiBtn').hidden = true; return; }
  $('#aiBtn').innerHTML = icon('ai', 16) + '<span>Connect AI</span>';
  $('#aiBtn').title = 'Use Kolam from Claude Code or Codex on your own computer';
  $('#aiBtn').addEventListener('click', () => toggle());
  // the Unsorted/Trash drawer and this panel share the right edge: opening one closes the other
  new MutationObserver(() => { if (!$('#drawer').hidden && open) toggle(false); })
    .observe($('#drawer'), { attributes: true, attributeFilter: ['hidden'] });
}
