import { $ } from '../core/util.js';
import { canvas } from '../core/dom.js';
import { S, RO, checkpoint, cur, clip, clipText, els, lastPointer, redo, save, sel, selLine, setSelLine, setSpaceDown, spaceDown, undo } from '../core/store.js';
import { V, applyView, fit, zoomAt, zoomCenter } from '../canvas/viewport.js';
import { itemsOf } from '../core/model.js';
import { renderLines } from '../canvas/lines.js';
import { refreshSel, selectOnly } from '../canvas/selection.js';
import { startEdit } from '../canvas/editing.js';
import { createFromTool, handleFiles, insertText, spawnPoint } from '../actions/create.js';
import { copySel, deleteSelection, duplicate, pasteClip } from '../actions/edit.js';
import { positionBars } from '../ui/floatbars.js';
import { hideMenu, selectAll } from '../ui/menus.js';
import { searchEl } from '../ui/search.js';
import { closeModal } from '../ui/modal.js';
import { accountOpen, closeAccount } from '../ui/account.js';
import { drawMode, exitDraw } from '../cards/drawing.js';
import { panel, renderPanel, setPanel } from '../ui/drawer.js';
import { showHelp } from '../ui/help.js';

/* ================= keyboard & clipboard ================= */
export let nudgeT = 0;

const TOOL_KEYS = { n: 'note', t: 'todo', b: 'board', c: 'column' };
function scrollIntoView(id) {
  const el = els.get(id); if (!el) return;
  const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
  if (r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom) return;
  const v = V();
  v.x += c.left + c.width / 2 - (r.left + r.width / 2); v.y += c.top + c.height / 2 - (r.top + r.height / 2);
  applyView(); save(true);
}
export function init() {
  document.addEventListener('keydown', e => {
    if (!$('#modal').hidden) { if (e.key === 'Escape') { e.preventDefault(); closeModal(); } return; }
    // the account settings page covers the board: none of the board's shortcuts apply
    if (accountOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); if (e.target.closest?.('input,select,textarea')) e.target.blur(); else closeAccount(); }
      return;
    }
    if (drawMode && e.key === 'Escape') { e.preventDefault(); return exitDraw(); }
    const inField = e.target.closest?.('input,textarea,[contenteditable=true]');
    const m = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (e.key === ' ' && !inField) { if (!spaceDown) { setSpaceDown(true); canvas.classList.add('space'); } e.preventDefault(); return; }
    if (m && k === 'z' && !inField) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (m && k === 'y' && !inField) { e.preventDefault(); redo(); return; }
    if (m && (k === '=' || k === '+')) { e.preventDefault(); zoomCenter(1.2); return; }
    if (m && k === '-') { e.preventDefault(); zoomCenter(1 / 1.2); return; }
    if (m && k === '0') { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomAt(1, r.left + r.width / 2, r.top + r.height / 2); return; }
    if (m && k === 'f') { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }
    if (inField || RO) return;
    if (e.key === '?') { e.preventDefault(); return showHelp(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
    else if (m && k === 'd') { e.preventDefault(); duplicate(); }
    else if (m && k === 'a') { e.preventDefault(); selectAll(); }
    else if (e.key === 'Escape') { hideMenu(); if (panel) { setPanel(null); renderPanel(); } sel.clear(); setSelLine(null); refreshSel(); }
    else if (e.key === 'Enter' && sel.size === 1) { e.preventDefault(); startEdit([...sel][0]); }
    else if (e.key.startsWith('Arrow') && sel.size) {
      e.preventDefault();
      if (Date.now() - nudgeT > 700) checkpoint();
      nudgeT = Date.now();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      for (const id of sel) { const it = S.items[id]; if (it && !it.col) { it.x += dx; it.y += dy; const el = els.get(id); el.style.left = it.x + 'px'; el.style.top = it.y + 'px'; } }
      save(); renderLines(); positionBars();
    } else if (!m && !e.altKey && TOOL_KEYS[k]) {
      e.preventDefault();
      createFromTool(TOOL_KEYS[k], lastPointer ? { x: lastPointer.x - 20, y: lastPointer.y - 20 } : null);
    } else if (e.shiftKey && (e.code === 'Digit1')) { e.preventDefault(); fit(); }
    else if (e.key === 'Tab') {   // walk the selection through the cards on this board
      const list = itemsOf(cur).filter(i => !i.col).sort((a, b) => a.y - b.y || a.x - b.x);
      if (!list.length) return;
      e.preventDefault();
      const at = list.findIndex(i => sel.has(i.id));
      const next = list[(at + (e.shiftKey ? -1 : 1) + list.length) % list.length];
      selectOnly(next.id); scrollIntoView(next.id);
    }
  });
  document.addEventListener('keyup', e => { if (e.key === ' ') { setSpaceDown(false); canvas.classList.remove('space'); } });
  addEventListener('blur', () => { setSpaceDown(false); canvas.classList.remove('space'); });
  document.addEventListener('copy', e => {
    if (RO || accountOpen()) return;
    if (e.target.closest?.('input,textarea,[contenteditable=true]')) return;
    if (!copySel()) return;
    e.clipboardData.setData('text/plain', clipText);
    e.preventDefault();
  });
  document.addEventListener('cut', e => {
    if (RO || accountOpen()) return;
    if (e.target.closest?.('input,textarea,[contenteditable=true]')) return;
    if (!copySel()) return;
    e.clipboardData.setData('text/plain', clipText);
    e.preventDefault(); deleteSelection();
  });
  document.addEventListener('paste', e => {
    const ce = e.target.closest?.('[contenteditable=true]');
    if (ce) {  // keep pasted text clean inside cards
      e.preventDefault();
      const t = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, t);
      return;
    }
    if (e.target.closest?.('input,textarea') || RO || accountOpen()) return;
    e.preventDefault();
    const at = lastPointer ? { x: lastPointer.x - 20, y: lastPointer.y - 20 } : spawnPoint();
    const files = [...e.clipboardData.files];
    if (files.length) return handleFiles(files, at);
    const t = e.clipboardData.getData('text/plain');
    if (clip && t === clipText) return pasteClip(at);
    insertText(t, at);
  });
}

