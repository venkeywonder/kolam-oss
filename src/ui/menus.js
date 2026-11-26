import { $ } from '../core/util.js';
import { icon } from './icons.js';
import { PALETTE } from '../core/palette.js';
import { ctxmenu } from '../core/dom.js';
import { S, checkpoint, clip, cur, isHome, lastPointer, redoStack, save, sel, selLine, serverOK, setCur, setS, setSelLine, undoStack } from '../core/store.js';
import { confirmMove } from '../features/spaces.js';
import { seed } from '../core/seed.js';
import { fit } from '../canvas/viewport.js';
import { itemsOf } from '../core/model.js';
import { setColumnDir, TYPES } from '../cards/types.js';
import { render, renderBoard } from '../canvas/render.js';
import { refreshSel } from '../canvas/selection.js';
import { startEdit } from '../canvas/editing.js';
import { moveToBoard } from '../canvas/drag.js';
import { createFromTool } from '../actions/create.js';
import { copyToClipboard, deleteSelection, duplicate, pasteClip, reorder, setColor } from '../actions/edit.js';
import { openBoard } from '../app/navigation.js';
import { exportAll } from '../features/io.js';
import { toast } from './toast.js';
import { lightbox } from './modal.js';
import { openDoc } from '../cards/doc.js';
import { showIconPicker } from '../cards/board-icon.js';
import { setIconOf, showLogoPicker } from '../cards/icon.js';
import { foldGroup, groupAround, setGroupBorder } from '../cards/group.js';
import { editLineLabel } from '../canvas/line-labels.js';
import { endsOf, routeOf } from '../canvas/lines.js';
import { canReverse, reverseLine, setLineOpt } from './line-options.js';
import { showArrangeMenu, toggleLock } from '../canvas/arrange.js';
import { moveToDialog } from '../actions/move.js';
import { renderPanel } from './drawer.js';
import { templateGallery } from '../features/templates.js';
import { openVersions } from '../features/history.js';
import { originalOf, shortcutTo, showOriginal } from '../features/shortcuts.js';
import { ended, setPollEnd } from '../cards/poll.js';

/* ================= menus ================= */
export function hideMenu() { ctxmenu.hidden = true; }
export function showMenu(x, y, entries) {
  ctxmenu.innerHTML = entries.map((m, i) => {
    if (m === '-') return '<div class="msep"></div>';
    if (m.colors) return `<div class="mcolors">${PALETTE.map(p => `<button data-mc="${p.k ?? ''}" title="${p.name}" style="--c:${m.line ? p.line : p.bg}"></button>`).join('')}</div>`;
    if (m.row) return `<div class="mrow">${m.row.map((o, j) => `<button class="mri${o.on ? ' on' : ''}" data-i="${i}" data-j="${j}" title="${o.title}" aria-label="${o.title}" aria-pressed="${!!o.on}">${o.svg || icon(o.icon, 17)}</button>`).join('')}</div>`;
    return `<button class="mi${m.danger ? ' danger' : ''}" data-i="${i}">${m.svg || (m.icon ? icon(m.icon, 16) : '')}<span>${m.label}</span>${m.kbd ? `<kbd>${m.kbd}</kbd>` : ''}</button>`;
  }).join('');
  ctxmenu.hidden = false;
  const w = ctxmenu.offsetWidth, h = ctxmenu.offsetHeight;
  ctxmenu.style.left = Math.min(x, innerWidth - w - 8) + 'px';
  ctxmenu.style.top = Math.min(y, innerHeight - h - 8) + 'px';
  ctxmenu.onclick = e => {
    const mc = e.target.closest('[data-mc]');
    if (mc) { hideMenu(); return setColor(mc.dataset.mc || null); }
    const b = e.target.closest('[data-i]'); if (!b) return;
    hideMenu();
    const m = entries[+b.dataset.i];
    (b.dataset.j != null ? m.row[+b.dataset.j] : m).act();
  };
}
export const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';
/** Change the icon of an icon element, or of a group's label (which can also go without one). */
export function pickIconFor(it, x, y) {
  showLogoPicker(x, y, {
    heading: it.type === 'group' ? 'Group icon' : 'Icon', current: it.data.ref || null,
    onPick: p => setIconOf(it.id, p),
    onClear: it.type === 'group' && (it.data.ref || it.data.asset) ? () => setIconOf(it.id, null) : undefined,
  });
}
export function showItemMenu(x, y) {
  const one = sel.size === 1 ? S.items[[...sel][0]] : null;
  const m = [];
  if (one?.type === 'board' || one?.type === 'shortcut') m.push({ label: 'Open board', icon: 'open', act: () => openBoard(one.data.target) });
  if (one?.type === 'shortcut' && originalOf(one.data.target)) m.push({ label: 'Show where it lives', icon: 'board', act: () => showOriginal(one.data.target) });
  if (one?.type === 'link' && one.data.url) m.push({ label: 'Open link', icon: 'open', act: () => window.open(one.data.url, '_blank', 'noopener') });
  if (one?.type === 'doc') m.push({ label: 'Open document', icon: 'open', act: () => openDoc(one.id) });
  if (one?.type === 'image') m.push({ label: 'View full size', icon: 'expand', act: () => lightbox(one.id) });
  if (one && TYPES[one.type].edit && !one.locked) m.push({ label: one.type === 'sketch' ? 'Draw' : 'Edit', icon: 'edit', kbd: '↵', act: () => startEdit(one.id) });
  if (one?.type === 'board') m.push({ label: 'Change icon…', icon: 'board', act: () => showIconPicker(one.id, x, y) });
  if ((one?.type === 'icon' || one?.type === 'group') && !one.locked) m.push({ label: one.type === 'icon' ? 'Change icon…' : one.data.ref || one.data.asset ? 'Change icon…' : 'Add icon…', icon: 'logo', act: () => pickIconFor(one, x, y) });
  if (one?.type === 'group' && !one.locked) m.push({ label: one.data.solid ? 'Dashed border' : 'Solid border', icon: 'group', act: () => setGroupBorder([one.id], !one.data.solid) });
  if (one?.type === 'group') m.push(one.data.collapsed ? { label: 'Maximize group', icon: 'expand', act: () => foldGroup(one.id, false) }
    : { label: 'Minimize group', icon: 'chevR', act: () => foldGroup(one.id, true) });
  if (one?.type === 'column' && !one.locked) m.push({ label: one.data.dir === 'row' ? 'Arrange vertically' : 'Arrange horizontally', icon: 'column', act: () => setColumnDir([one.id], one.data.dir === 'row' ? 'col' : 'row') });
  if (one?.type === 'poll' && !one.locked) m.push(ended(one) ? { label: 'Reopen poll', icon: 'unlock', act: () => setPollEnd(one.id, null) }
    : { label: 'End poll now', icon: 'lock', act: () => setPollEnd(one.id, Date.now()) });
  if ([...sel].some(id => S.items[id] && !S.items[id].col)) m.push({ label: sel.size > 1 ? 'Group these' : 'Put in a group', icon: 'group', act: () => groupAround(sel) });
  if (one?.type === 'board' && S.boards[one.data.target]) m.push({ label: 'Put a shortcut on another board…', icon: 'shortcut', act: () => shortcutTo(one.data.target) });
  if (m.length) m.push('-');
  m.push({ colors: true }, '-');
  m.push({ label: 'Duplicate', icon: 'copy', kbd: mod + 'D', act: duplicate });
  m.push({ label: 'Copy', icon: 'copy', kbd: mod + 'C', act: () => { copyToClipboard(); toast('Copied'); } });
  const allLocked = [...sel].every(id => S.items[id]?.locked);
  m.push({ label: allLocked ? 'Unlock' : 'Lock position', icon: allLocked ? 'unlock' : 'lock', act: toggleLock });
  m.push({ label: 'Move to board…', icon: 'move', act: moveToDialog });
  if (isHome()) m.push({ label: 'Send to Unsorted', icon: 'inbox', act: async () => {
    const ids = [...sel];
    if (!await confirmMove(cur, '__unsorted', ids.length)) return;
    checkpoint(); moveToBoard(ids, '__unsorted'); save(); renderBoard(); renderPanel(); toast('Moved to Unsorted');
  } });
  if (sel.size > 1) m.push({ label: 'Align & arrange…', icon: 'align', act: () => showArrangeMenu(x, y) });
  m.push({ label: 'Bring to front', icon: 'front', act: () => reorder(true) });
  m.push({ label: 'Send to back', icon: 'back', act: () => reorder(false) });
  if (one) m.push({ label: 'Version history', icon: 'history', act: () => openVersions(one.id) });
  m.push('-', { label: 'Delete', icon: 'trash', kbd: '⌫', danger: true, act: deleteSelection });
  showMenu(x, y, m);
}
export function showLineMenu(x, y) {
  const ln = S.lines[selLine]; if (!ln) return;
  const opt = (k, v) => () => { if (setLineOpt(ln.id, k, v)) refreshSel(); };
  const route = routeOf(ln), ends = endsOf(ln);
  const m = [{ label: ln.label ? 'Edit label' : 'Add label', icon: 'text', act: () => editLineLabel(ln.id) }];
  m.push({ label: ends === 'none' ? 'Add arrowhead' : 'Remove arrowheads', icon: ends === 'none' ? 'arrow' : 'endsNone', act: opt('ends', ends === 'none' ? 'end' : 'none') });
  if (canReverse(ln)) m.push({ label: 'Reverse direction', icon: 'reverse', act: () => { reverseLine(ln.id); refreshSel(); } });
  m.push('-');
  if (route !== 'straight') m.push({ label: 'Make straight', icon: 'straight', act: opt('route', 'straight') });
  if (route !== 'curved') m.push({ label: 'Make curved', icon: 'routeCurved', act: opt('route', 'curved') });
  if (route !== 'elbow') m.push({ label: 'Make elbow', icon: 'routeElbow', act: opt('route', 'elbow') });
  m.push({ colors: true, line: true }, '-', { label: 'Delete line', icon: 'trash', kbd: '⌫', danger: true, act: deleteSelection });
  showMenu(x, y, m);
}
export function showCanvasMenu(x, y) {
  const at = lastPointer;
  const m = [
    { label: 'Add text', icon: 'text', act: () => createFromTool('text', at) },
    { label: 'Add icon…', icon: 'logo', act: () => createFromTool('icon', at) },
    { label: 'Add group', icon: 'group', act: () => createFromTool('group', at) },
    { label: 'Add note', icon: 'note', act: () => createFromTool('note', at) },
    { label: 'Add to-do list', icon: 'todo', act: () => createFromTool('todo', at) },
    { label: 'Add board', icon: 'board', act: () => createFromTool('board', at) },
    { label: 'Add shortcut to a board…', icon: 'shortcut', act: () => createFromTool('shortcut', at) },
    { label: 'Add column', icon: 'column', act: () => createFromTool('column', at) },
    { label: 'Add table', icon: 'table', act: () => createFromTool('table', at) },
    { label: 'Add poll', icon: 'poll', act: () => createFromTool('poll', at) },
    { label: 'Insert template…', icon: 'template', act: () => templateGallery(at) },
  ];
  if (S.boards[cur]) m.push({ label: 'Put a shortcut to this board on…', icon: 'shortcut', act: () => shortcutTo(cur) });
  if (clip) m.push('-', { label: 'Paste', icon: 'copy', kbd: mod + 'V', act: () => pasteClip(at) });
  m.push('-', { label: 'Select all', kbd: mod + 'A', act: selectAll }, { label: 'Fit to screen', icon: 'fit', act: fit });
  showMenu(x, y, m);
}
export function selectAll() { sel.clear(); setSelLine(null); itemsOf(cur).filter(i => !i.col).forEach(i => sel.add(i.id)); refreshSel(); }

export function init() {
  document.addEventListener('pointerdown', e => { if (!ctxmenu.hidden && !ctxmenu.contains(e.target) && !e.target.closest('[data-menu-btn]')) hideMenu(); }, true);
}

