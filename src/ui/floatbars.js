import { $, $$, clamp } from '../core/util.js';
import { renderCtxTools, setToolbarMode } from './toolbar.js';
import { icon } from './icons.js';
import { PALETTE } from '../core/palette.js';
import { fmtbar, handlesSvg, selbar } from '../core/dom.js';
import { S, checkpoint, dragging, editingId, els, save, sel, selLine } from '../core/store.js';
import { TYPES } from '../cards/types.js';
import { renderLines } from '../canvas/lines.js';
import { refreshSel } from '../canvas/selection.js';
import { exitEdit, startEdit } from '../canvas/editing.js';
import { deleteSelection, duplicate, setColor } from '../actions/edit.js';
import { openBoard } from '../app/navigation.js';
import { lightbox } from './modal.js';
import { openDoc } from '../cards/doc.js';
import { editLineLabel } from '../canvas/line-labels.js';
import { showArrangeMenu, toggleLock } from '../canvas/arrange.js';
import { ALIGNABLE, ALIGNS, alignIcon, alignOf, setAlign } from '../cards/align.js';

/* ================= floating bars ================= */
export function hideBars() { fmtbar.hidden = true; setToolbarMode(false); }
export const FMT = [
  ['bold', '<b>B</b>', 'Bold (⌘B)'], ['italic', '<i>I</i>', 'Italic (⌘I)'], ['underline', '<u>U</u>', 'Underline (⌘U)'], ['strikeThrough', '<s>S</s>', 'Strikethrough'], '|',
  ['h1', 'H1', 'Large heading'], ['h2', 'H2', 'Heading'], ['insertUnorderedList', icon('bullets', 16), 'Bulleted list'], ['insertOrderedList', icon('numbers', 16), 'Numbered list'], ['blockquote', icon('quote', 16), 'Quote'], '|',
  ['align', icon('alignLeft', 16), 'Text alignment'], ['link', icon('hyperlink', 16), 'Link'], ['done', 'Done', 'Finish editing (Esc)'],
];
export function buildSelbar() { renderCtxTools(); }
export function positionBars() {
  // formatting bar for rich text editing
  const ed = editingId && S.items[editingId];
  if (ed && TYPES[ed.type].rich && els.get(editingId)) {
    const r = els.get(editingId).getBoundingClientRect();
    fmtbar.hidden = false;
    const ab = $('[data-f="align"]', fmtbar);
    ab.hidden = !ALIGNABLE.has(ed.type);
    if (!ab.hidden) { const v = alignOf(ed); ab.innerHTML = icon(alignIcon(v), 16); ab.title = `Text alignment: ${ALIGNS.find(a => a[0] === v)[1]} (click to change)`; }
    const fw = fmtbar.offsetWidth;
    fmtbar.style.left = clamp(r.left, 90, innerWidth - fw - 10) + 'px';
    fmtbar.style.top = Math.max(60, r.top - 48) + 'px';
  } else fmtbar.hidden = true;
  // contextual toolbar for the current selection
  setToolbarMode(!editingId && (sel.size > 0 || !!selLine) && !!selbar.innerHTML);
}

export function init() {
  fmtbar.innerHTML = FMT.map(f => f === '|' ? '<span class="div"></span>' : `<button data-f="${f[0]}" title="${f[2]}">${f[1]}</button>`).join('');
  fmtbar.addEventListener('mousedown', e => e.preventDefault());
  fmtbar.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !editingId) return;
    const f = b.dataset.f;
    if (f === 'done') return exitEdit();
    if (f === 'align') {
      const it = S.items[editingId], i = ALIGNS.findIndex(a => a[0] === alignOf(it));
      setAlign([editingId], ALIGNS[(i + 1) % ALIGNS.length][0]);
      return positionBars();
    }
    if (f === 'h1' || f === 'h2' || f === 'blockquote') {
      const curBlock = (document.queryCommandValue('formatBlock') || '').toLowerCase();
      document.execCommand('formatBlock', false, curBlock === f ? 'p' : f);
    } else if (f === 'link') {
      const u = prompt('Link address'); if (u) document.execCommand('createLink', false, /^(https?:|mailto:)/i.test(u) ? u : 'https://' + u);
    } else document.execCommand(f);
    const it = S.items[editingId], el = els.get(editingId);
    TYPES[it.type].read?.(el, it); save(); positionBars(); renderLines();
  });
  document.addEventListener('selectionchange', () => {
    if (fmtbar.hidden) return;
    for (const b of $$('button', fmtbar)) {
      const f = b.dataset.f;
      let on = false;
      try {
        if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].includes(f)) on = document.queryCommandState(f);
        else if (['h1', 'h2', 'blockquote'].includes(f)) on = (document.queryCommandValue('formatBlock') || '').toLowerCase() === f;
      } catch {}
      b.classList.toggle('on', on);
    }
  });
  addEventListener('resize', positionBars);
}

