import { $, esc, uid } from '../core/util.js';
import { api } from '../core/api.js';
import { curveNew, lineStyle, styleOf } from '../core/styles.js';
import { canvas } from '../core/dom.js';
import { S, RO, checkpoint, cur, els, freshId, save, sel, selLine, serverOK, setFreshId, setSelLine } from '../core/store.js';
import { V, toWorld, viewCenter } from '../canvas/viewport.js';
import { childrenOf, maxZ } from '../core/model.js';
import { TYPES } from '../cards/types.js';
import { rebuildCard, renderBoard } from '../canvas/render.js';
import { refreshSel, selectOnly } from '../canvas/selection.js';
import { queueUpload } from './uploads.js';
import { exitEdit, startEdit } from '../canvas/editing.js';
import { toast } from '../ui/toast.js';
import { openDoc } from '../cards/doc.js';
import { drawMode, enterDraw, exitDraw } from '../cards/drawing.js';
import { embedOf } from '../cards/embeds.js';
import { icon } from '../ui/icons.js';
import { appear } from '../canvas/motion.js';
import { shortcutHere } from '../features/shortcuts.js';
import { showLogoPicker } from '../cards/icon.js';

/* ================= creating items ================= */
export function createItem(type, at, opts = {}) {
  exitEdit();
  checkpoint();
  const it = addItem(type, at, opts);
  save(); renderBoard(); selectOnly(it.id);
  appear(els.get(it.id));
  dispatchEvent(new CustomEvent('nk:created', { detail: { type } }));
  return it;
}
/** A new card in the state of the board, without an undo step, save or redraw (the caller does those). */
function addItem(type, at, opts) {
  const T = TYPES[type];
  // your last colour for this kind of card (and header row for tables, text alignment) unless the caller sets one
  const it = { id: uid(), board: cur, type, x: Math.round(at.x), y: Math.round(at.y), w: T.w, z: maxZ() + 1, col: null, order: 0, color: styleOf(type).color ?? null, data: T.init ? T.init() : {}, ...opts };
  if (T.h && !it.h) it.h = T.h;
  if (type === 'table' && !opts.data && styleOf('table').header != null) it.data.header = styleOf('table').header;
  if (styleOf(type).align && !('align' in opts)) it.align = styleOf(type).align;
  if (type === 'board') {
    const { bg, corners } = styleOf('board');
    const b = { id: uid(), title: opts.title || 'Untitled board', parent: cur, ...(bg ? { bg } : {}), ...(corners && corners !== 'sharp' ? { corners } : {}) };
    S.boards[b.id] = b; it.data = { target: b.id };
  }
  if (opts.col) {
    const kids = childrenOf(opts.col);
    kids.splice(opts.order ?? kids.length, 0, it);
    S.items[it.id] = it;
    kids.forEach((k, i) => (k.order = i));
  } else S.items[it.id] = it;
  return it;
}
export let cascade = 0;
export function spawnPoint(w = 260) {
  const c = viewCenter();
  cascade = (cascade + 1) % 6;
  return { x: c.x - w / 2 + cascade * 24 - 60, y: c.y - 120 + cascade * 24 - 60 };
}
export function createFromTool(tool, at, colTarget) {
  const T = TYPES[tool];
  const pos = at || spawnPoint(T?.w || 260);
  const extra = colTarget ? { col: colTarget.id, order: colTarget.idx } : {};
  switch (tool) {
    case 'line': {
      exitEdit(); checkpoint();
      const ln = { id: uid(), board: cur, a: { x: Math.round(pos.x), y: Math.round(pos.y + 40) }, b: { x: Math.round(pos.x + 220), y: Math.round(pos.y + 40) }, ...lineStyle() };
      curveNew(ln);
      S.lines[ln.id] = ln; sel.clear(); setSelLine(ln.id); save(); renderBoard(); return;
    }
    case 'draw': return drawMode ? exitDraw() : enterDraw();
    case 'image': pendingAt = { pos, extra }; $('#imgPick').click(); return;
    case 'upload': pendingAt = { pos, extra }; $('#filePick').click(); return;
    case 'shortcut': return shortcutHere(pos, extra);
    case 'icon': return pickNewIcon(pos);
  }
  if (colTarget && (tool === 'column' || tool === 'group')) return toast(tool === 'group' ? 'Groups can’t go inside columns' : 'Columns can’t go inside columns');
  const it = createItem(tool, pos, extra);
  if (tool === 'note' || tool === 'text') { setFreshId(it.id); startEdit(it.id); }
  else if (tool === 'todo' || tool === 'column' || tool === 'group') startEdit(it.id);
  else if (tool === 'board') { startEdit(it.id); document.execCommand('selectAll'); }
  else if (tool === 'link' || tool === 'comment') $('input', els.get(it.id))?.focus();
  else if (tool === 'sketch' || tool === 'table' || tool === 'poll') startEdit(it.id);
  else if (tool === 'doc') openDoc(it.id);
}
/** The Icon tool: choose a logo or icon first, then it lands where the tool was dropped (or in view). */
function pickNewIcon(pos) {
  const r = canvas.getBoundingClientRect(), v = V();
  const sx = r.left + v.x + pos.x * v.z, sy = r.top + v.y + pos.y * v.z;
  showLogoPicker(sx, sy, {
    heading: 'Add an icon',
    onPick: p => {
      const data = { label: p.title, auto: p.title };
      if (p.ref) { data.ref = p.ref; if (p.dark) data.dark = p.dark; } else data.asset = p.asset;
      createItem('icon', pos, { data });
    },
  });
}
export async function setLink(id, raw) {
  let u = raw.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { u = new URL(u).href; } catch { return toast('That doesn’t look like a link'); }
  const it = S.items[id]; if (!it) return;
  it.data = { url: u, loading: serverOK };
  if (embedOf(u) && (it.w || 0) < 400) it.w = 420;
  save(); rebuildCard(id);
  if (!serverOK) return;
  try {
    const m = await api('unfurl?url=' + encodeURIComponent(u));
    Object.assign(it.data, { title: m.title || '', desc: m.desc || '', img: m.img || '', siteName: m.siteName || '' });
  } catch {}
  if (!S.items[id]) return;
  it.data.loading = false;
  save();
  if (it.board === cur) rebuildCard(id);
}
/* ---------- files & images ---------- */
export let pendingAt = null;
export const readFile = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
/**
 * Files dropped, pasted or picked: a card for each straight away, which then fills in while the file uploads in the
 * background (actions/uploads.js), so a hundred photos never hold up the board.
 */
export function handleFiles(files, at, extra = {}) {
  if (!files.length) return;
  exitEdit();
  checkpoint();
  const made = files.map((f, i) => {
    const pos = { x: at.x + i * 28, y: at.y + i * 28 };
    const image = f.type.startsWith('image/');
    const it = addItem(image ? 'image' : 'file', pos, image
      ? { ...extra, data: { caption: '', ratio: null, upload: uid() } }
      : { ...extra, data: { name: f.name, size: f.size, mime: f.type, upload: uid() } });
    return [it, f];
  });
  save(); renderBoard();
  sel.clear(); setSelLine(null);
  for (const [it] of made) { sel.add(it.id); appear(els.get(it.id)); dispatchEvent(new CustomEvent('nk:created', { detail: { type: it.type } })); }
  refreshSel();
  for (const [it, f] of made) queueUpload(it, f);
}
export function insertText(txt, at) {
  txt = (txt || '').trim(); if (!txt) return;
  if (/^https?:\/\/\S+$/i.test(txt)) {
    if (/\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(txt)) return createItem('image', at, { data: { src: txt, caption: '' } });
    const it = createItem('link', at); setLink(it.id, txt); return;
  }
  createItem('note', at, { data: { html: txt.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('') } });
}

export function init() {
  $('#imgPick').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length && pendingAt) handleFiles(f, pendingAt.pos, pendingAt.extra); });
  $('#filePick').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length && pendingAt) handleFiles(f, pendingAt.pos, pendingAt.extra); });
  // things dragged in from outside (files, links, text): a landing pad follows the pointer
  let depth = 0, pad = null;
  const padOff = () => { depth = 0; canvas.classList.remove('file-over'); pad?.remove(); pad = null; };
  canvas.addEventListener('dragenter', e => {
    if (RO || !e.dataTransfer) return;
    if (depth++ || pad) return;
    const items = [...(e.dataTransfer.items || [])].filter(i => i.kind === 'file');
    const imgs = items.length && items.every(i => i.type.startsWith('image/'));
    const what = items.length ? (items.length === 1 ? (imgs ? 'this image' : 'this file') : `${items.length} ${imgs ? 'images' : 'files'}`) : 'it';
    pad = document.createElement('div');
    pad.className = 'drop-pad';
    pad.innerHTML = `<i class="dp-ring"></i><span class="dp-ic">${icon(items.length ? (imgs ? 'image' : 'upload') : 'link', 26)}</span><b>Drop ${what} here</b>`;
    canvas.appendChild(pad);
    canvas.classList.add('file-over');
  });
  canvas.addEventListener('dragleave', () => { if (--depth <= 0) padOff(); });
  canvas.addEventListener('dragover', e => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    if (!pad) return;
    const r = canvas.getBoundingClientRect();
    pad.style.translate = `${e.clientX - r.left}px ${e.clientY - r.top}px`;
  });
  canvas.addEventListener('drop', e => {
    e.preventDefault();
    padOff();
    if (RO) return;
    const p = toWorld(e.clientX, e.clientY);
    const files = [...(e.dataTransfer.files || [])];
    if (files.length) return handleFiles(files, p);
    const url = e.dataTransfer.getData('text/uri-list') || '';
    const txt = e.dataTransfer.getData('text/plain') || '';
    insertText(url || txt, p);
  });
}

