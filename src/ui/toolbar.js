/*
 * Left toolbar. Normal mode: card tools you click or drag onto the board.
 * When cards (or a line) are selected it switches to that selection's actions, like a contextual inspector.
 */
import { $, $$, esc } from '../core/util.js';
import { icon } from './icons.js';
import { tile } from './tool-icons.js';
import { PALETTE, pal } from '../core/palette.js';
import { canvas } from '../core/dom.js';
import { S, editingId, els, sel, selLine, setSelLine } from '../core/store.js';
import { toWorld } from '../canvas/viewport.js';
import { TYPES } from '../cards/types.js';
import { findDropTarget } from '../canvas/drag.js';
import { goHome, sway } from '../canvas/motion.js';
import { createFromTool } from '../actions/create.js';
import { togglePanel } from './drawer.js';
import { refreshSel } from '../canvas/selection.js';
import { startEdit } from '../canvas/editing.js';
import { deleteSelection, duplicate, setColor } from '../actions/edit.js';
import { openBoard } from '../app/navigation.js';
import { lightbox } from './modal.js';
import { openDoc } from '../cards/doc.js';
import { editLineLabel } from '../canvas/line-labels.js';
import { renderLines } from '../canvas/lines.js';
import { canReverse, lineGlyph, lineOpt, linePopHtml, reverseLine, setLineOpt } from './line-options.js';
import { showArrangeMenu, toggleLock } from '../canvas/arrange.js';
import { showIconPicker } from '../cards/extras.js';
import { moveToDialog } from '../actions/move.js';
import { ALIGNABLE, ALIGNS, alignIcon, alignOf, setAlign } from '../cards/align.js';
import { originalOf, shortcutTo, showOriginal } from '../features/shortcuts.js';

export const TOOLS = [
  ['note', 'Note'], ['link', 'Link'], ['todo', 'To-do'], ['line', 'Line'], ['board', 'Board'], ['shortcut', 'Shortcut'], ['column', 'Column'],
  ['comment', 'Comment'], ['table', 'Table'], ['doc', 'Doc'], ['sketch', 'Sketch'], ['swatch', 'Color'],
  '-', ['image', 'Add image'], ['upload', 'Upload'], ['draw', 'Draw'],
];
const tools = $('#tools'), ctx = $('#ctxtools'), bar = $('#toolbar');
const btn = (attrs, art, label, extra = '') => `<button class="tool" ${attrs}><span class="tile-wrap">${art}</span><span class="tool-name">${label}</span>${extra}</button>`;
const glyph = (name, cls = '') => `<span class="glyph ${cls}">${icon(name, 19)}</span>`;

/* ---------- contextual mode ---------- */
let ctxShown = false;
export function setToolbarMode(show) {
  if (show === ctxShown) return;
  ctxShown = show;
  bar.classList.toggle('ctx', show);
  tools.hidden = show; ctx.hidden = !show;
  if (!show) closePop();
}
export function renderCtxTools() {
  closePop();
  if (editingId || (!sel.size && !selLine)) { ctx.innerHTML = ''; return; }
  let h = btn('data-act="back" title="Back to tools (Esc)"', glyph('arrowLeft', 'plain'), '');
  let colorKey;
  if (selLine) colorKey = S.lines[selLine]?.color;
  else if (sel.size === 1) colorKey = S.items[[...sel][0]]?.color;
  const sw = selLine ? pal(colorKey).line : (colorKey ? pal(colorKey).bg : '#fff');
  h += btn('data-act="color" title="Color"', `<span class="glyph swatch-glyph" style="--c:${sw}">${colorKey ? '' : '<i></i>'}</span>`, 'Color');
  if (selLine) {
    const ln = S.lines[selLine];
    if (ln) {
      h += btn('data-act="label" title="Label (double-click the line)"', glyph('text'), 'Label');
      h += btn('data-act="ltype" title="Line type"', glyph(lineGlyph('ltype', ln)), 'Type');
      h += btn('data-act="lends" title="Arrowheads"', glyph(lineGlyph('lends', ln)), 'Arrows');
      h += btn(`data-act="reverse" title="Reverse direction"${canReverse(ln) ? '' : ' disabled'}`, glyph('reverse'), 'Reverse');
      h += btn('data-act="lstyle" title="Thickness and pattern"', glyph('lineStyle'), 'Style');
    }
  } else {
    const one = sel.size === 1 ? S.items[[...sel][0]] : null;
    if (one?.type === 'board') h += btn('data-act="open" title="Open board"', glyph('open'), 'Open') + btn('data-act="icon" title="Change icon"', glyph('board'), 'Icon') +
      (S.boards[one.data.target] ? btn('data-act="shortcut" title="Put a shortcut to this board on another board"', glyph('shortcut'), 'Shortcut') : '');
    if (one?.type === 'shortcut') h += btn('data-act="open" title="Go to the board"', glyph('open'), 'Open') +
      (originalOf(one.data.target) ? btn('data-act="original" title="Show where the board lives"', glyph('board'), 'Original') : '');
    if (one?.type === 'link' && one.data.url) h += btn('data-act="openlink" title="Open link in a new tab"', glyph('open'), 'Open');
    if (one?.type === 'image') h += btn('data-act="view" title="View full size"', glyph('expand'), 'View');
    if (one?.type === 'doc') h += btn('data-act="opendoc" title="Open document"', glyph('open'), 'Open');
    if (one && TYPES[one.type].edit && !one.locked) h += btn('data-act="edit" title="Edit (Enter)"', glyph(one.type === 'sketch' ? 'sketch' : 'edit'), one.type === 'sketch' ? 'Draw' : 'Edit');
    const texts = [...sel].map(id => S.items[id]).filter(Boolean);
    if (texts.length && texts.every(it => ALIGNABLE.has(it.type) && !it.locked)) h += btn('data-act="align" title="Text alignment"', glyph(alignIcon(alignOf(texts[0]))), 'Align');
    if (sel.size > 1) h += btn('data-act="arrange" title="Align and arrange"', glyph('align'), 'Arrange');
    const allLocked = [...sel].every(id => S.items[id]?.locked);
    h += btn(`data-act="lock" class="${allLocked ? 'on' : ''}" title="${allLocked ? 'Unlock position' : 'Lock position'}"`, glyph(allLocked ? 'lock' : 'unlock'), allLocked ? 'Locked' : 'Lock');
    h += btn('data-act="dup" title="Duplicate (⌘D)"', glyph('copy'), 'Duplicate');
    h += btn('data-act="move" title="Move to another board"', glyph('move'), 'Move');
    h += `<div class="sel-count">${sel.size > 1 ? sel.size + ' cards' : ''}</div>`;
  }
  ctx.innerHTML = h + '<div class="tool-spacer"></div>' + btn('data-act="del" class="trash-tool" title="Move to Trash (Delete)"', tile('trash'), 'Trash');
}

/* ---------- popovers (colour, line options) ---------- */
let popEl = null, popAct = null;
function closePop() { popEl?.remove(); popEl = popAct = null; }
// Opens a popover beside a toolbar button; clicking the same button again closes it.
function openPop(anchor, act, cls, html) {
  const same = popAct === act;
  closePop();
  if (same) return null;
  popEl = document.createElement('div');
  popEl.className = cls; popEl.innerHTML = html; popAct = act;
  document.body.append(popEl);
  const r = anchor.getBoundingClientRect();
  popEl.style.left = (r.right + 8) + 'px';
  popEl.style.top = Math.max(8, Math.min(r.top, innerHeight - popEl.offsetHeight - 8)) + 'px';
  popEl.addEventListener('pointerdown', e => e.stopPropagation());
  return popEl;
}
function openPalette(anchor) {
  const cur = selLine ? S.lines[selLine]?.color : (sel.size === 1 ? S.items[[...sel][0]]?.color : undefined);
  const el = openPop(anchor, 'color', 'palette-pop', PALETTE.map(p => `<button data-color="${p.k ?? ''}" class="${(p.k ?? null) === (cur ?? null) && cur !== undefined ? 'on' : ''}" title="${esc(p.name)}" style="--c:${selLine ? p.line : (p.k ? p.bg : '#fff')}"></button>`).join(''));
  el?.addEventListener('click', e => {
    const b = e.target.closest('[data-color]'); if (!b) return;
    setColor(b.dataset.color || null);
  });
}
function openAlignPop(anchor) {
  const now = () => { const it = S.items[[...sel][0]]; return it ? alignOf(it) : null; };
  const el = openPop(anchor, 'align', 'tool-pop', '<div class="tp-head">Text alignment</div><div class="tp-row">' +
    ALIGNS.map(([v, l, art]) => `<button data-align="${v}" class="${now() === v ? 'on' : ''}" title="${l}">${icon(art, 20)}<span>${l}</span></button>`).join('') + '</div>');
  el?.addEventListener('click', e => {
    const b = e.target.closest('[data-align]');
    if (!b || !setAlign(sel, b.dataset.align)) return;
    for (const x of $$('[data-align]', el)) x.classList.toggle('on', x.dataset.align === b.dataset.align);
    const g = $('[data-act="align"] .glyph', ctx); if (g) g.innerHTML = icon(alignIcon(b.dataset.align), 19);
  });
}
// Line options stay open so several can be tried in a row; the line and toolbar update live.
function openLinePop(anchor, act) {
  const ln = S.lines[selLine]; if (!ln) return;
  const el = openPop(anchor, act, 'tool-pop', linePopHtml(act, ln));
  el?.addEventListener('click', e => {
    const b = e.target.closest('[data-k]');
    if (!b || !setLineOpt(selLine, b.dataset.k, b.dataset.v)) return;
    renderLines();
    for (const x of $$('[data-k]', el)) x.classList.toggle('on', lineOpt(ln, x.dataset.k) === x.dataset.v);
    for (const a of ['ltype', 'lends']) { const g = $(`[data-act="${a}"] .glyph`, ctx); if (g) g.innerHTML = icon(lineGlyph(a, ln), 19); }
    const rv = $('[data-act="reverse"]', ctx); if (rv) rv.disabled = !canReverse(ln);
  });
}

/* ---------- dragging a new card out of the toolbar ---------- */
function toolDown(e) {
  const b = e.target.closest('.tool'); if (!b || e.button !== 0) return;
  e.preventDefault();
  const tool = b.dataset.tool;
  if (tool === 'draw') return createFromTool('draw');
  const sx = e.clientX, sy = e.clientY;
  let ghost = null, colT = null, raf = 0, last = null, sw = null, ang = 0;
  b.classList.add('pressed');
  const place = () => { ghost.style.transform = `translate3d(${last.clientX}px,${last.clientY}px,0) translate(-50%,-50%) rotate(${(ang - 2).toFixed(2)}deg)`; };
  const frame = () => {
    raf = 0; const ev = last;
    place();
    ghost.hidden = true;
    const t = findDropTarget(ev.clientX, ev.clientY, new Set(), tool === 'column' || tool === 'line');
    ghost.hidden = false;
    $$('.drop-target').forEach(x => x.classList.remove('drop-target'));
    colT = null;
    if (t?.type === 'col') {
      const tel = els.get(t.id); tel.classList.add('drop-target');
      const kids = $$('.col-body > .card', tel);
      const idx = kids.findIndex(k => { const r = k.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      colT = { id: t.id, idx: idx < 0 ? kids.length : idx };
    }
  };
  const mv = ev => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      ghost = document.createElement('div'); ghost.className = 'tool-ghost t-' + tool;
      ghost.innerHTML = `${tile(tool)}<span>${esc(TOOLS.find(t => t[0] === tool)?.[1] || '')}</span>`;
      document.body.appendChild(ghost);
      document.body.classList.add('grabbing');
      sw = sway(a => { ang = a; if (last) place(); }, .8);
    }
    sw.move(ev.clientX);
    last = ev; if (!raf) raf = requestAnimationFrame(frame);
  };
  const up = ev => {
    removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
    cancelAnimationFrame(raf); b.classList.remove('pressed');
    document.body.classList.remove('grabbing');
    $$('.drop-target').forEach(x => x.classList.remove('drop-target'));
    if (!ghost) return createFromTool(tool);
    sw.stop();
    const cr = canvas.getBoundingClientRect();
    // let go off the board: the new card goes back into its button
    if (ev.clientX < cr.left || ev.clientY < cr.top) return goHome(ghost, b, { scale: .3 });
    ghost.remove();
    const p = toWorld(ev.clientX, ev.clientY);
    const w = TYPES[tool]?.w || 260;
    createFromTool(tool, { x: p.x - Math.min(w, 260) / 2, y: p.y - 24 }, colT);
  };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
}

function ctxClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const one = S.items[[...sel][0]];
  switch (b.dataset.act) {
    case 'back': sel.clear(); setSelLine(null); refreshSel(); break;
    case 'color': openPalette(b); break;
    case 'align': openAlignPop(b); break;
    case 'del': deleteSelection(); break;
    case 'dup': duplicate(); break;
    case 'move': moveToDialog(); break;
    case 'open': openBoard(one.data.target); break;
    case 'shortcut': shortcutTo(one.data.target); break;
    case 'original': showOriginal(one.data.target); break;
    case 'icon': { const r = b.getBoundingClientRect(); showIconPicker(one.id, r.right + 8, r.top); break; }
    case 'openlink': window.open(one.data.url, '_blank', 'noopener'); break;
    case 'edit': startEdit(one.id); break;
    case 'view': lightbox(one.id); break;
    case 'opendoc': openDoc(one.id); break;
    case 'lock': toggleLock(); break;
    case 'arrange': { const r = b.getBoundingClientRect(); showArrangeMenu(r.right + 8, r.top); break; }
    case 'ltype': case 'lends': case 'lstyle': openLinePop(b, b.dataset.act); break;
    case 'reverse': reverseLine(selLine); refreshSel(); break;
    case 'label': editLineLabel(selLine); break;
  }
}

export function init() {
  tools.innerHTML = TOOLS.map(t => t === '-' ? '<div class="tool-sep"></div>'
    : btn(`data-tool="${t[0]}" title="${t[0] === 'draw' ? 'Draw freehand on the board' : `${t[1]} — click, or drag onto the board`}"`, tile(t[0]), t[1])).join('') +
    '<div class="tool-spacer"></div>' + btn('data-panel="trash" title="Trash"', tile('trash'), 'Trash');
  tools.addEventListener('pointerdown', e => {
    const pb = e.target.closest('[data-panel]');
    if (pb) { e.preventDefault(); return togglePanel(pb.dataset.panel); }
    toolDown(e);
  });
  ctx.addEventListener('pointerdown', e => e.stopPropagation());
  ctx.addEventListener('click', ctxClick);
  document.addEventListener('pointerdown', () => closePop());
  $('#unsortedPill').addEventListener('click', () => togglePanel('unsorted'));
}
