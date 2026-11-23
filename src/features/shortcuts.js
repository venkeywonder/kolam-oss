/*
 * Shortcuts: cards that jump straight to a board anywhere in the space, however deep it is.
 * A shortcut only points at its board (data.target): deleting, copying or moving it never touches the board,
 * and the board keeps its one place in the tree. People who can't open the board see a locked card.
 */
import { $, esc, uid } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { ROOT, RO, S, can, checkpoint, cur, els, save } from '../core/store.js';
import { styleOf } from '../core/styles.js';
import { boardCardOf, boardPath, maxZ } from '../core/model.js';
import { TYPES } from '../cards/types.js';
import { boardTree } from '../actions/move.js';
import { createItem } from '../actions/create.js';
import { belowAll } from '../canvas/drag.js';
import { renderBoard } from '../canvas/render.js';
import { centerOn } from '../canvas/viewport.js';
import { selectOnly } from '../canvas/selection.js';
import { appear } from '../canvas/motion.js';
import { openBoard } from '../app/navigation.js';
import { closeModal, openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

/** Where a board lives: the titles of the boards above it. */
const where = bid => boardPath(bid).slice(0, -1).map(b => b.title).join(' / ') || 'Top board';

/** Pick a board from the tree, or find one by name. Resolves its id, or null when the dialog is closed. */
function pickBoard(title, text, allow) {
  const rows = boardTree().filter(r => allow(r.b.id));
  if (!rows.length) { toast('There’s no board to pick'); return Promise.resolve(null); }
  return new Promise(res => {
    let picked = null;
    const card = openModal(`<h2>${esc(title)}</h2><p>${esc(text)}</p>` +
      `<input class="field sc-find" type="search" placeholder="Find a board…" autocomplete="off" spellcheck="false">` +
      `<div class="board-list sc-list"></div><div class="m-actions"><button class="btn ghost" data-close>Cancel</button></div>`,
    { onClose: () => res(picked) });
    const list = $('.sc-list', card), find = $('.sc-find', card);
    // the tree, or while searching a flat list that says where each board lives
    const draw = () => {
      const q = find.value.trim().toLowerCase();
      const shown = q ? rows.filter(r => r.b.title.toLowerCase().includes(q)) : rows;
      list.innerHTML = shown.map(r => `<button data-b="${esc(r.b.id)}" style="padding-left:${10 + (q ? 0 : r.depth * 18)}px">` +
        `${icon(r.b.id === ROOT ? 'home' : 'board', 16)}<span class="sc-name">${esc(r.b.title)}${q ? `<small>${esc(where(r.b.id))}</small>` : ''}</span></button>`).join('') ||
        '<div class="sc-none">No board has that name</div>';
    };
    draw();
    find.addEventListener('input', draw);
    find.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('[data-b]', list)?.click(); } });
    list.addEventListener('click', e => {
      const b = e.target.closest('[data-b]'); if (!b) return;
      picked = b.dataset.b;
      closeModal();
    });
    find.focus();
  });
}

/** Add a shortcut card here (toolbar, canvas menu): asks which board it opens. */
export async function shortcutHere(at, extra = {}) {
  if (RO) return;
  const target = await pickBoard('Add a shortcut', 'Pick the board it opens. One click on the shortcut takes you there, however deep the board is.', b => b !== cur);
  if (!target || !S.boards[target]) return;
  createItem('shortcut', at, { ...extra, data: { target } });
}

/** Put a shortcut to this board on another board (board card menu, canvas menu): asks where. */
export async function shortcutTo(target) {
  if (!S.boards[target]) return;
  const on = await pickBoard(`Add a shortcut to “${S.boards[target].title}”`, 'Pick the board to put it on. The board itself stays where it is.', b => b !== target && can(b, 'editor'));
  if (!on || !S.boards[on] || !S.boards[target]) return;
  checkpoint();
  const it = { id: uid(), board: on, type: 'shortcut', x: 40, y: belowAll(on), w: TYPES.shortcut.w, z: maxZ(on) + 1, col: null, order: 0, color: styleOf('shortcut').color ?? null, data: { target } };
  S.items[it.id] = it;
  save();
  dispatchEvent(new CustomEvent('nk:created', { detail: { type: 'shortcut' } }));
  const show = () => { selectOnly(it.id); centerOn(it.id); };
  if (on === cur) { renderBoard(); show(); appear(els.get(it.id)); return; }
  toast(`Shortcut added to “${S.boards[on].title}”`, 'Go there', () => { openBoard(on); show(); });
}

/** The board card a shortcut stands in for, on the board that holds it (null for a top board or one you can't see). */
export function originalOf(target) {
  const card = boardCardOf(target);
  return card && S.boards[card.board] ? card : null;
}
/** Open the board that holds a board's own card, with that card selected: where the board really lives. */
export function showOriginal(target) {
  const card = originalOf(target); if (!card) return;
  openBoard(card.board); selectOnly(card.id); centerOn(card.col || card.id);
}
