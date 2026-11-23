/* First-run onboarding: the "What will you use Kolam for?" picker (shown once, right after a fresh account's
 * first sign-in) and a small dismissible getting-started checklist. Server state lives in users.onboarding
 * (server/src/Onboarding.php); `user.onboarding` comes back from auth/me. */
import { esc } from '../core/util.js';
import { api } from '../core/api.js';
import { VIEW } from '../core/store.js';
import { openModal, closeModal } from '../ui/modal.js';
import { createItem, spawnPoint } from '../actions/create.js';
import { startEdit } from '../canvas/editing.js';
import { openBoard } from '../app/navigation.js';
import { applyTemplate } from './templates.js';
import { openShare } from './share.js';
import { toggle as toggleAi } from '../ui/ai.js';
import { track } from '../core/analytics.js';

// picker choices: each maps to an existing template (features/templates.js) where one fits, so the starter board
// is built and synced by the normal "apply a template" code path
const CHOICES = [
  { tpl: 'kanban', label: 'Team projects' },
  { tpl: 'week', label: 'Personal notes and planning' },
  { tpl: 'research', label: 'Research and moodboards' },
  { tpl: 'writing', label: 'Writing and docs' },
  { tpl: 'mind', label: 'Studying' },
  { tpl: null, label: 'Something else' },
];
const ITEMS = [
  { key: 'card', label: 'Add your first card' },
  { key: 'invite', label: 'Invite a teammate' },
  { key: 'share', label: 'Share a board with a link' },
  { key: 'ai', label: 'Connect your AI' },
];

let state = null;
let box = null;

export function init(user, config) {
  if (VIEW || !user || !user.onboarding) return;
  state = user.onboarding;
  // boards aren't loaded yet at this point in boot (see main.js); wait for the "space ready" event it fires
  // once load() and the first render are done, so the picker never creates a board before S exists
  addEventListener('nk:space', mount, { once: true });
  watchForCard();
  watchActions();
}

function mount() {
  if (state.fresh && !state.picked) showPicker();
  if (!state.dismissed && !allDone()) showChecklist();
}

const allDone = () => ITEMS.every(it => state.done[it.key]);

/* ================= picker ================= */
function showPicker() {
  let chosen = false;
  const card = openModal(
    '<h2>What will you use Kolam for?</h2><p>Pick one to start with a matching board. You can always add more, or change everything afterwards.</p>' +
    `<div class="ob-grid">${CHOICES.map(c => `<button type="button" class="ob-choice" data-tpl="${c.tpl || ''}">${esc(c.label)}</button>`).join('')}</div>`,
    { cls: 'onboarding-modal', onClose: () => { if (!chosen) patch({ picked: null }); } });
  card.addEventListener('click', e => {
    const b = e.target.closest('[data-tpl]'); if (!b) return;
    chosen = true;
    closeModal();
    pick(b.dataset.tpl || null);
  });
}

function pick(tplId) {
  if (tplId) {
    const choice = CHOICES.find(c => c.tpl === tplId);
    const it = createItem('board', spawnPoint(), { title: choice.label });
    openBoard(it.data.target);
    applyTemplate(tplId);
  }
  patch({ picked: tplId || 'other' });
  track('onboarding_choice', { template: tplId || 'other' });
}

/* ================= checklist ================= */
function showChecklist() {
  if (box) return;
  box = document.createElement('div');
  box.id = 'onboardChecklist';
  box.innerHTML = '<div class="ob-head"><b>Getting started</b><button type="button" class="ob-hide">Hide</button></div><ul class="ob-list"></ul>';
  box.querySelector('.ob-hide').addEventListener('click', () => {
    box.remove(); box = null;
    state.dismissed = true;
    patch({ dismissed: true });
  });
  box.querySelector('.ob-list').addEventListener('click', e => {
    const li = e.target.closest('[data-key]'); if (li) go(li.dataset.key);
  });
  document.body.append(box);
  renderChecklist();
}

function renderChecklist() {
  if (!box) return;
  box.querySelector('.ob-list').innerHTML = ITEMS.map(it =>
    `<li data-key="${it.key}" class="${state.done[it.key] ? 'done' : ''}"><span class="ob-chk" aria-hidden="true"></span>${esc(it.label)}</li>`).join('');
}

function go(key) {
  if (key === 'card') { const it = createItem('note', spawnPoint()); startEdit(it.id); }
  else if (key === 'invite' || key === 'share') openShare();
  else if (key === 'ai') toggleAi(true);
}

function mark(key) {
  if (!state || state.done[key]) return;
  state.done[key] = true;
  renderChecklist();
  patch({ done: { [key]: true } });
  if (box && allDone()) setTimeout(() => { box?.remove(); box = null; }, 1400);
}

function patch(body) {
  api('onboarding', { method: 'PATCH', body }).catch(() => {});
}

/* ================= cheap signals: a new card, an invite sent, a link created, the AI connected ================= */
// createItem (actions/create.js) dispatches this for every card made through the toolbar, paste, drop or drag —
// never for the seed board, a synced/remote change, or a template's own cards, so this only fires for something
// the person actually added; a new board doesn't count (the picker makes one of those for them)
function watchForCard() {
  addEventListener('nk:created', e => { if (e.detail.type !== 'board') mark('card'); });
}

// the share, workspace and AI panels announce these when they succeed
function watchActions() {
  addEventListener('nk:invited', () => mark('invite'));
  addEventListener('nk:link-created', () => mark('share'));
  addEventListener('nk:ai-connected', () => mark('ai'));
}
