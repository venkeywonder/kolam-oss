import { esc } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { ROOT, S, can, checkpoint, cur, isPersonal, save, sel } from '../core/store.js';
import { confirmMove } from '../features/spaces.js';
import { isDescendantBoard } from '../core/model.js';
import { renderBoard } from '../canvas/render.js';
import { moveToBoard } from '../canvas/drag.js';
import { openBoard } from '../app/navigation.js';
import { toast } from '../ui/toast.js';
import { closeModal, openModal } from '../ui/modal.js';
import { renderPanel, togglePanel } from '../ui/drawer.js';

/* ================= move to board ================= */
export function boardTree() {
  const out = [];
  const kids = p => Object.values(S.boards).filter(b => b.parent === p).sort((a, b) => a.title.localeCompare(b.title));
  const walk = (b, depth) => { out.push({ b, depth }); kids(b.id).forEach(k => walk(k, depth + 1)); };
  if (S.boards[ROOT]) walk(S.boards[ROOT], 0);
  return out;
}
export function moveToDialog() {
  const ids = [...sel].filter(id => S.items[id]); if (!ids.length) return;
  const banned = new Set();
  ids.forEach(id => { const it = S.items[id]; if (it.type === 'board') Object.keys(S.boards).forEach(b => { if (isDescendantBoard(b, it.data.target)) banned.add(b); }); });
  const rows = boardTree().filter(r => r.b.id !== cur && !banned.has(r.b.id) && can(r.b.id, 'editor'));
  const card = openModal(`<h2>Move ${ids.length === 1 ? 'card' : ids.length + ' cards'} to…</h2><p>Pick a board. Connected lines to cards left behind are removed.</p><div class="board-list">` +
    rows.map(r => `<button data-b="${r.b.id}" style="padding-left:${10 + r.depth * 18}px">${icon(r.b.id === 'home' ? 'home' : 'board', 16)} ${esc(r.b.title)}</button>`).join('') +
    (isPersonal() ? `<button data-b="__unsorted">${icon('inbox', 16)} Unsorted</button>` : '') + `</div><div class="m-actions"><button class="btn ghost" data-close>Cancel</button></div>`);
  card.addEventListener('click', async e => {
    const b = e.target.closest('[data-b]'); if (!b) return;
    const to = b.dataset.b;
    closeModal();
    if (!await confirmMove(cur, to, ids.length)) return;
    checkpoint();
    moveToBoard(ids, to);
    save(); renderBoard(); renderPanel();
    toast(`Moved to “${to === '__unsorted' ? 'Unsorted' : S.boards[to].title}”`, 'Go there', () => to === '__unsorted' ? togglePanel('unsorted') : openBoard(to));
  });
}
