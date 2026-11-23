import { crumbsEl } from '../core/dom.js';
import { ROOT, RO, S, SPACE, boardHash, cur, parseHash, redoStack, save, sel, setCur, setSelLine, snap, undoStack, updUndo, user } from '../core/store.js';
import { render, renderCrumbs } from '../canvas/render.js';
import { caretEnd, exitEdit } from '../canvas/editing.js';
import { switchSpace } from '../features/spaces.js';
import { routeAccount } from '../ui/account.js';
import { toast } from '../ui/toast.js';

/* ================= navigation ================= */
export function openBoard(id, push = true) {
  if (!S.boards[id]) { if (push) toast('You don’t have access to this board'); return; }
  exitEdit();
  setCur(id); sel.clear(); setSelLine(null);
  if (push && location.hash !== boardHash(id)) location.hash = boardHash(id);
  render();
}

export function init() {
  window.addEventListener('hashchange', e => {
    if (routeAccount(e.oldURL)) return;   // #/account: the account settings page covers the board
    const h = parseHash();
    const space = h?.space || user?.space;
    if (user && space && space !== SPACE) return switchSpace(space, h.board);
    const b = h && S.boards[h.board] ? h.board : ROOT;
    if (b !== cur) openBoard(b, false);
  });
  const rename = c => {
    if (RO) return;
    const before = snap();
    c.contentEditable = 'true'; caretEnd(c);
    const done = () => {
      c.removeAttribute('contenteditable');
      const t = c.innerText.trim() || 'Untitled board';
      if (t !== S.boards[cur].title) { undoStack.push(before); redoStack.length = 0; S.boards[cur].title = t; save(); }
      renderCrumbs(); updUndo();
    };
    c.addEventListener('blur', done, { once: true });
    c.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === 'Escape') { ev.preventDefault(); c.blur(); } });
  };
  document.getElementById('boardTitle').addEventListener('dblclick', e => rename(e.currentTarget));
  crumbsEl.addEventListener('dblclick', e => { if (e.target.closest('.cur')) rename(document.getElementById('boardTitle')); });
}
