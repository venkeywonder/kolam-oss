import { $, esc } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { S, RO, els, redoStack, save, setDocOpen, snap, snapshot, undoStack, updUndo } from '../core/store.js';
import { cleanRT, sanitize } from '../core/sanitize.js';
import { TYPES } from './types.js';
import { rebuildCard } from '../canvas/render.js';
import { caretEnd, exitEdit } from '../canvas/editing.js';
import { FMT } from '../ui/floatbars.js';
import { plain } from '../ui/search.js';
import { openModal } from '../ui/modal.js';
import { keepIn, shift } from '../core/caret.js';
import { open as openText } from '../core/ytext.js';
import { ALIGNS, alignIcon, alignOf, applyAlign, setAlign } from './align.js';

// the document open in the editor, so other people's changes can be shown in it as they arrive
let shown = null;   // { id, card, html: what the editor shows }

/** Show changes that came in for the open document, keeping your cursor in place. */
export function refreshDoc() {
  if (!shown?.card.isConnected) return;
  const it = S.items[shown.id];
  if (!it) return;
  const body = $('.doc-body', shown.card), title = $('.doc-title', shown.card);
  if ((it.data.html || '') !== shown.html) {
    keepIn(body, () => { body.innerHTML = sanitize(it.data.html); });
    shown.html = it.data.html || '';
  }
  const t = it.data.title || '';
  if (title.value.trim() !== t) {
    if (document.activeElement !== title) title.value = t;
    else { const before = title.value, c = title.selectionStart; title.value = t; const p = shift(before, t, c); title.setSelectionRange(p, p); }
  }
}

export function openDoc(id) {
  const it = S.items[id]; if (!it) return;
  exitEdit();
  const ro = RO, before = ro ? null : snap();
  const card = openModal(
    `<div class="doc-top"><div class="doc-tb">${FMT.filter(f => f !== '|' && f[0] !== 'done').map(f => `<button data-f="${f[0]}" title="${f[2]}">${f[1]}</button>`).join('')}</div><button class="btn" data-close>Done</button></div>` +
    `<div class="doc-page"><input class="doc-title" placeholder="Untitled document" value="${esc(it.data.title)}"${ro ? ' readonly' : ''}>` +
    `<div class="rt doc-body" data-ph="Start writing…" ${ro ? '' : 'contenteditable="true"'}>${sanitize(it.data.html)}</div></div>`,
    {
      cls: 'doc-modal',
      onClose() {
        setDocOpen(null);
        shown = null;
        if (ro) return;
        const cur = S.items[id]; if (!cur) return;
        cur.data.title = $('.doc-title', card).value.trim();
        cur.data.html = cleanRT($('.doc-body', card));
        if (snapshot() !== before.s) { undoStack.push(before); redoStack.length = 0; updUndo(); save(); }
        if (els.has(id)) rebuildCard(id);
      },
    });
  if (!ro) { setDocOpen(id); openText(id); }
  const body = $('.doc-body', card), title = $('.doc-title', card);
  shown = { id, card, html: it.data.html || '' };
  const sync = () => {
    const cur = S.items[id]; if (!cur) return;
    cur.data.title = title.value.trim(); cur.data.html = shown.html = cleanRT(body);
    save();
  };
  body.addEventListener('input', sync); title.addEventListener('input', sync);
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); caretEnd(body); } });
  $('.doc-tb', card).addEventListener('mousedown', e => e.preventDefault());
  const page = $('.doc-page', card), ab = $('[data-f="align"]', card);
  const showAlign = () => {
    const v = alignOf(S.items[id]);
    applyAlign(page, S.items[id]);
    ab.innerHTML = icon(alignIcon(v), 16); ab.title = `Text alignment: ${ALIGNS.find(a => a[0] === v)[1]} (click to change)`;
  };
  showAlign();
  if (ro) ab.hidden = true;
  $('.doc-tb', card).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const f = b.dataset.f;
    if (f === 'align') {
      const i = ALIGNS.findIndex(a => a[0] === alignOf(S.items[id]));
      setAlign([id], ALIGNS[(i + 1) % ALIGNS.length][0]);
      return showAlign();
    }
    if (document.activeElement !== body) return;
    if (f === 'h1' || f === 'h2' || f === 'blockquote') {
      const curBlock = (document.queryCommandValue('formatBlock') || '').toLowerCase();
      document.execCommand('formatBlock', false, curBlock === f ? 'p' : f);
    } else if (f === 'link') {
      const u = prompt('Link address'); if (u) document.execCommand('createLink', false, /^(https?:|mailto:)/i.test(u) ? u : 'https://' + u);
    } else document.execCommand(f);
    sync();
  });
  if (!ro) (it.data.title ? caretEnd(body) : title.focus());
}

export function init() {
  // --- long-form document
  TYPES.doc = {
    label: 'Document', w: 260,
    init: () => ({ title: '', html: '' }),
    html: it => `<div class="dc-ic">${icon('doc', 22)}</div><div class="dc-main"><div class="dc-title">${esc(it.data.title || 'Untitled document')}</div><div class="dc-snip">${esc(plain(it.data.html).slice(0, 160)) || 'Empty document'}</div><button class="dc-open" data-nodrag>Open</button></div>`,
    mount(el, it) { $('.dc-open', el).addEventListener('click', () => openDoc(it.id)); },
    text: it => it.data.title + ' ' + it.data.html,
  };
}

