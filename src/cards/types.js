import { $, $$, esc, seeThrough, uid } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { PALETTE, pal } from '../core/palette.js';
import { S, RO, checkpoint, editingId, els, getAsset, save } from '../core/store.js';
import { V } from '../canvas/viewport.js';
import { boardCardOf, boardPath, childrenOf, countCards } from '../core/model.js';
import { cleanRT, fmtSize, hostOf, safeHex, sanitize } from '../core/sanitize.js';
import { makeCard, rebuildCard } from '../canvas/render.js';
import { renderLines } from '../canvas/lines.js';
import { caretEnd, exitEdit, startEdit } from '../canvas/editing.js';
import { setLink } from '../actions/create.js';
import { positionBars } from '../ui/floatbars.js';
import { toast } from '../ui/toast.js';
import { inkCol, isDark, lineCol } from '../ui/theme.js';
import { bodyText, commentCardHtml, commentsOf, mountCommentCard } from '../features/comments.js';
import { remember, styleOf } from '../core/styles.js';
import { boardIconHtml } from './board-icon.js';
import { newTextData, paintText } from './text.js';
import { iconArt } from './icon.js';

/* ================= card types ================= */
// the sketch pen colour: the last one you picked, on any device
const skColor = () => styleOf('sketch').pen || '#1f1f24';
export const TYPES = {
  // words straight on the board, no card (cards/text.js): as wide as the text until resized
  text: {
    label: 'Text', rich: true, autoW: true,
    init: newTextData,
    html: it => `<div class="rt tx-body" data-ph="Type something…">${sanitize(it.data.html)}</div>`,
    mount: (el, it) => paintText(el, it),
    edit: el => { const n = $('.tx-body', el); n.contentEditable = 'true'; return n; },
    read: (el, it) => { it.data.html = cleanRT($('.tx-body', el)); },
    text: it => it.data.html,
  },
  note: {
    label: 'Note', w: 260, rich: true,
    init: () => ({ html: '' }),
    html: it => `<div class="rt note-body" data-ph="Type something…">${sanitize(it.data.html)}</div>`,
    edit: el => { const n = $('.note-body', el); n.contentEditable = 'true'; return n; },
    read: (el, it) => { it.data.html = cleanRT($('.note-body', el)); },
    text: it => it.data.html,
  },
  todo: {
    label: 'To-do', w: 260, fitH: true,
    init: () => ({ title: '', tasks: [{ id: uid(), t: '', done: false }] }),
    html: it => {
      const tasks = it.data.tasks || [], done = tasks.filter(t => t.done).length;
      return `<div class="todo-title" data-ph="To-do list">${esc(it.data.title)}</div>` +
        (tasks.length ? `<div class="todo-prog"><i style="width:${(done / tasks.length) * 100}%"></i></div>` : '') +
        `<ul>${tasks.map(t => `<li data-tid="${t.id}" class="${t.done ? 'done' : ''}"><button class="chk" data-nodrag title="Toggle"></button><span class="tt">${esc(t.t)}</span></li>`).join('')}</ul>` +
        `<div class="todo-add" data-nodrag>+ Add a task</div>`;
    },
    mount(el, it) {
      el.addEventListener('click', e => {
        if (RO) return;
        const chk = e.target.closest('.chk');
        if (chk) {
          const id = it.id, cur = S.items[id];
          if (editingId === id) TYPES.todo.read(el, cur); else checkpoint();
          const t = cur.data.tasks.find(t => t.id === chk.parentNode.dataset.tid);
          if (t) t.done = !t.done;
          save(); rebuildCard(id);
          return;
        }
        if (e.target.closest('.todo-add')) {
          const id = it.id;
          if (editingId !== id) startEdit(id);
          const cur = S.items[id];
          TYPES.todo.read(els.get(id), cur);
          const nt = { id: uid(), t: '', done: false };
          cur.data.tasks.push(nt);
          const nel = rebuildCard(id);
          caretEnd($(`li[data-tid="${nt.id}"] .tt`, nel));
        }
      });
      el.addEventListener('keydown', e => {
        if (editingId !== it.id) return;
        const cur = S.items[it.id];
        const tt = e.target.closest('.tt'), title = e.target.closest('.todo-title');
        if (e.key === 'Enter' && !e.shiftKey && (tt || title)) {
          e.preventDefault();
          TYPES.todo.read(el, cur);
          const idx = tt ? cur.data.tasks.findIndex(t => t.id === tt.parentNode.dataset.tid) + 1 : 0;
          const nt = { id: uid(), t: '', done: false };
          cur.data.tasks.splice(idx, 0, nt);
          const nel = rebuildCard(it.id);
          caretEnd($(`li[data-tid="${nt.id}"] .tt`, nel));
          save();
        } else if (e.key === 'Backspace' && tt && tt.innerText.trim() === '') {
          e.preventDefault();
          TYPES.todo.read(el, cur);
          const idx = cur.data.tasks.findIndex(t => t.id === tt.parentNode.dataset.tid);
          cur.data.tasks.splice(idx, 1);
          const prev = cur.data.tasks[idx - 1];
          const nel = rebuildCard(it.id);
          caretEnd(prev ? $(`li[data-tid="${prev.id}"] .tt`, nel) : $('.todo-title', nel));
          save();
        } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (tt || title) && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
          // up from a task's first line / down from its last line moves into the task above / below
          const up = e.key === 'ArrowUp', field = tt || title, fields = $$('.todo-title,.tt', el);
          const next = fields[fields.indexOf(field) + (up ? -1 : 1)];
          const caret = caretRect();
          if (!next || !onEdgeLine(field, caret, up)) return;
          e.preventDefault();
          caretInto(next, caret ? caret.left : null, up);
        }
      });
    },
    edit: el => { $$('.todo-title,.tt', el).forEach(n => (n.contentEditable = 'true')); return $('.todo-title', el); },
    read: (el, it) => {
      it.data.title = $('.todo-title', el).innerText.trim();
      $$('li', el).forEach(li => {
        const t = it.data.tasks.find(t => t.id === li.dataset.tid);
        if (t) t.t = $('.tt', li).innerText.replace(/\n/g, ' ').trim();
      });
    },
    stop: (el, it) => { const before = it.data.tasks.length; it.data.tasks = it.data.tasks.filter(t => t.t); if (it.data.tasks.length !== before) return true; },
    text: it => it.data.title + ' ' + (it.data.tasks || []).map(t => t.t).join(' '),
  },
  link: {
    label: 'Link', w: 280, fitH: true,
    init: () => ({ url: '' }),
    html: it => {
      const d = it.data;
      if (!d.url) return `<div class="lk-new" data-nodrag><input class="lk-input" placeholder="Paste a link and press Enter" spellcheck="false"></div>`;
      const host = hostOf(d.url);
      return (d.img ? `<div class="lk-img"><img src="${esc(d.img)}" alt="" draggable="false" referrerpolicy="no-referrer"></div>` : '') +
        `<div class="lk-body"><div class="lk-title">${esc(d.title || host)}</div>` +
        (d.desc ? `<div class="lk-desc">${esc(d.desc)}</div>` : '') +
        `<a class="lk-site" href="${esc(d.url)}" target="_blank" rel="noopener" data-nodrag>${icon('open', 13)} ${esc(d.siteName || host)}</a></div>` +
        (d.loading ? '<div class="lk-loading">Fetching preview…</div>' : '');
    },
    mount(el, it) {
      const img = $('.lk-img img', el);
      if (img) { img.onerror = () => { img.parentNode.remove(); renderLines(); }; img.onload = () => renderLines(); }
      const inp = $('.lk-input', el);
      if (inp) inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' && inp.value.trim()) setLink(it.id, inp.value);
        if (e.key === 'Escape') inp.blur();
      });
    },
    text: it => (it.data.title || '') + ' ' + it.data.url,
  },
  image: {
    label: 'Image', w: 300, rich: true, ratio: true,
    init: () => ({}),
    html: it => `<div class="im"><img alt="" draggable="false"></div><div class="rt cap" data-ph="Add a caption">${sanitize(it.data.caption)}</div>`,
    mount(el, it) {
      const img = $('img', el);
      // a picture with transparent parts sits straight on the board: no card colour or frame behind it
      img.onload = () => { img.classList.add('loaded'); el.classList.toggle('see-through', seeThrough(img)); renderLines(); positionBars(); };
      if (it.data.src) img.src = it.data.src;
      else getAsset(it.data.asset).then(u => { if (u) img.src = u; else el.classList.add('missing'); });
    },
    edit: el => { const c = $('.cap', el); c.contentEditable = 'true'; return c; },
    read: (el, it) => { it.data.caption = cleanRT($('.cap', el)); },
    text: it => it.data.caption || '',
  },
  file: {
    label: 'File', w: 260,
    html: it => {
      const ext = (it.data.name || '').split('.').pop().slice(0, 4) || 'file';
      return `<div class="fl"><div class="fl-ic">${esc(ext)}</div><div class="fl-meta"><div class="fl-name" title="${esc(it.data.name)}">${esc(it.data.name)}</div><div class="fl-size">${fmtSize(it.data.size || 0)}</div></div><button class="fl-dl" data-nodrag title="Download">${icon('download', 16)}</button></div>`;
    },
    mount(el, it) {
      $('.fl-dl', el).addEventListener('click', async () => {
        const u = await getAsset(it.data.asset);
        if (!u) return toast('File data is missing');
        const a = document.createElement('a'); a.href = u; a.download = it.data.name || 'file'; a.click();
      });
    },
    text: it => it.data.name,
  },
  board: {
    label: 'Board', w: 150,
    html: it => {
      const b = S.boards[it.data.target] || { title: 'Missing board' };
      const n = countCards(it.data.target);
      return `<div class="bd-icon" title="Open board" style="--tile:${it.color ? pal(it.color).line : 'var(--accent)'}">${icon('board', 32)}</div>` +
        `<div class="bd-title" data-ph="Untitled board">${esc(b.title)}</div><div class="bd-meta">${n} card${n === 1 ? '' : 's'}</div>`;
    },
    edit: el => { const t = $('.bd-title', el); t.contentEditable = 'true'; return t; },
    read: (el, it) => { const b = S.boards[it.data.target]; if (b) { b.title = $('.bd-title', el).innerText.trim() || 'Untitled board'; } },
    enterExits: true,
    text: it => S.boards[it.data.target]?.title || '',
  },
  // a card that jumps straight to a board anywhere in the space; deleting or copying it never touches the board
  shortcut: {
    label: 'Shortcut', w: 150,
    html: it => {
      const b = S.boards[it.data.target], badge = `<span class="sc-badge">${icon('shortcut', 14)}</span>`;
      if (!b) return `<div class="bd-icon bd-noaccess" title="The board was deleted, or you don’t have access to it">${icon('lock', 26)}${badge}</div>` +
        `<div class="bd-title">Board not found</div><div class="bd-meta">Shortcut</div>`;
      // looks like the board's own card: its icon, and its colour unless the shortcut has one
      const card = boardCardOf(b.id), p = pal(it.color || card?.color || 'purple');
      const up = boardPath(b.id).slice(0, -1).map(x => x.title);
      const where = up.length ? (up.length > 2 ? '… / ' : '') + up.slice(-2).join(' / ') : 'Top board';
      return `<div class="bd-icon" title="Go to board" style="--tile:${isDark() ? p.dbg : p.bg};--tile-ink:${p.line}">${boardIconHtml(card?.data, 30)}${badge}</div>` +
        `<div class="bd-title">${esc(b.title)}</div><div class="bd-meta sc-path" title="${esc([...up, b.title].join(' / '))}">${esc(where)}</div>`;
    },
    text: it => S.boards[it.data.target]?.title || '',
  },
  column: {
    label: 'Column', w: 280, fitH: true,
    init: () => ({ title: '' }),
    html: it => `<div class="col-head"><div class="col-title" data-ph="Untitled column">${esc(it.data.title)}</div><span class="col-count"></span></div><div class="col-body"></div>`,
    mount(el, it) {
      const body = $('.col-body', el), kids = childrenOf(it.id);
      for (const k of kids) body.appendChild(makeCard(k));
      if (!kids.length) body.innerHTML = '<div class="col-empty">Drag cards here</div>';
      $('.col-count', el).textContent = `${kids.length} card${kids.length === 1 ? '' : 's'}`;
    },
    edit: el => { const t = $('.col-title', el); t.contentEditable = 'true'; return t; },
    read: (el, it) => { it.data.title = $('.col-title', el).innerText.trim(); },
    enterExits: true,
    text: it => it.data.title,
  },
  comment: {
    label: 'Comment', w: 260,
    init: () => ({}),
    html: it => commentCardHtml(it),
    mount: (el, it) => mountCommentCard(el, it),
    text: it => commentsOf(it.id).map(c => bodyText(c.body)).join(' '),
  },
  sketch: {
    label: 'Sketch', w: 320, h: 220, resizeH: true,
    init: () => ({ strokes: [] }),
    html: it => `<canvas class="sk"></canvas>${(it.data.strokes || []).length ? '' : '<div class="sk-empty">Double-click to draw</div>'}` +
      `<div class="sk-tools" data-nodrag>${['#1f1f24', '#e5534b', '#3478e5', '#35a35a', '#ee8a26'].map(c => `<button data-c="${c}" style="--c:${c}" class="${c === skColor() ? 'on' : ''}" title="Pen colour"></button>`).join('')}` +
      `<button data-act="undo" title="Undo stroke">${icon('undo', 15)}</button><button data-act="clear">Clear</button><button data-act="done">Done</button></div>`,
    mount(el, it) {
      el.style.height = (it.h || 220) + 'px';
      drawSketch(el, it);
      const cv = $('canvas', el);
      cv.addEventListener('pointerdown', e => {
        if (editingId !== it.id || e.button !== 0) return;
        e.preventDefault();
        const z = V().z, r = cv.getBoundingClientRect();
        const pt = ev => [Math.round((ev.clientX - r.left) / z * 10) / 10, Math.round((ev.clientY - r.top) / z * 10) / 10];
        const cur = S.items[it.id];
        const stroke = { c: skColor(), w: 3, p: pt(e) };
        cur.data.strokes.push(stroke);
        $('.sk-empty', el)?.remove();
        const mv = ev => { stroke.p.push(...pt(ev)); drawSketch(el, cur); };
        const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); save(); };
        addEventListener('pointermove', mv); addEventListener('pointerup', up);
      });
      $('.sk-tools', el).addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        const cur = S.items[it.id];
        if (b.dataset.c) { remember('sketch', { pen: b.dataset.c }); $$('[data-c]', el).forEach(x => x.classList.toggle('on', x === b)); }
        else if (b.dataset.act === 'undo') { cur.data.strokes.pop(); drawSketch(el, cur); save(); }
        else if (b.dataset.act === 'clear') { cur.data.strokes = []; drawSketch(el, cur); save(); }
        else if (b.dataset.act === 'done') exitEdit();
      });
    },
    edit: () => null,
    onResize: (el, it) => drawSketch(el, it),
    text: () => '',
  },
  swatch: {
    label: 'Colour', w: 140, fitH: true,
    init: () => ({ hex: PALETTE[1 + Math.floor(Math.random() * 8)].line }),
    html: it => `<div class="sw" style="background:${safeHex(it.data.hex)}"><button class="sw-pick" data-nodrag title="Change colour" aria-label="Change colour">${icon('picker', 15)}</button></div>` +
      `<div class="sw-hex">${safeHex(it.data.hex).toUpperCase()}</div><input type="color" value="${safeHex(it.data.hex)}" data-nodrag tabindex="-1">`,
    mount(el, it) {
      const inp = $('input', el);
      $('.sw-pick', el).addEventListener('click', e => { e.stopPropagation(); if (!RO && !S.items[it.id]?.locked) pickSwatch(el); });
      inp.addEventListener('input', () => {
        S.items[it.id].data.hex = inp.value;
        $('.sw', el).style.background = inp.value;
        $('.sw-hex', el).textContent = inp.value.toUpperCase();
      });
      inp.addEventListener('change', () => save());
    },
    text: it => it.data.hex,
  },
  // a logo or icon straight on the board with its name under it (cards/icon.js); the width is the icon's size
  icon: {
    label: 'Icon', w: 64,
    init: () => ({ ref: 'lucide/server', label: 'Server', auto: 'Server' }),
    html: it => `<div class="ic-art">${iconArt(it.data, it.color)}</div><div class="ic-label" data-ph="Label">${esc(it.data.label || '')}</div>`,
    edit: el => { const n = $('.ic-label', el); n.contentEditable = 'true'; return n; },
    read: (el, it) => { it.data.label = $('.ic-label', el).innerText.replace(/\s+/g, ' ').trim(); },
    enterExits: true,
    text: it => it.data.label || '',
  },
  // a labelled box drawn around cards (cards/group.js): sits under everything, and moving it moves what's inside
  group: {
    label: 'Group', w: 480, h: 300, resizeH: true,
    init: () => ({ title: '', solid: styleOf('group').solid || undefined }),
    html: it => `<div class="grp-head">${it.data.ref || it.data.asset ? `<span class="grp-ic">${iconArt(it.data, it.color)}</span>` : ''}` +
      `<span class="grp-title" data-ph="Group">${esc(it.data.title || '')}</span></div>`,
    mount(el, it) {
      el.style.setProperty('--grp', it.color ? lineCol(pal(it.color)) : 'var(--muted)');
      el.classList.toggle('grp-solid', !!it.data.solid);
    },
    edit: el => { const t = $('.grp-title', el); t.contentEditable = 'true'; return t; },
    read: (el, it) => { it.data.title = $('.grp-title', el).innerText.replace(/\s+/g, ' ').trim(); },
    enterExits: true,
    text: it => it.data.title || '',
  },
};
/** Open a colour card's colour picker. */
export function pickSwatch(el) {
  checkpoint();
  const inp = $('input', el);
  inp.style.pointerEvents = 'auto';
  inp.click();
}
// their colour isn't a card background (a text element's colour is its text colour)
export const noBg = new Set(['board', 'shortcut', 'swatch', 'text', 'icon', 'group']);
export function drawSketch(el, it) {
  const cv = $('canvas', el); if (!cv) return;
  const w = it.w || 320, h = it.h || 220, dpr = 2;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr); g.lineCap = 'round'; g.lineJoin = 'round';
  for (const s of it.data.strokes || []) {
    const p = s.p; if (p.length < 2) continue;
    g.strokeStyle = inkCol(s.c); g.lineWidth = s.w;
    g.beginPath(); g.moveTo(p[0], p[1]);
    if (p.length === 2) g.lineTo(p[0] + 0.1, p[1]);
    for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
    g.stroke();
  }
}
/* ---------- moving the cursor between a to-do list's title and tasks ---------- */
/** Where the caret is on screen ({left, top, bottom, height}), or null when it can't be measured (an empty field). */
function caretRect() {
  const s = getSelection(); if (!s?.rangeCount || !s.focusNode) return null;
  let n = s.focusNode, o = s.focusOffset;
  if (n.nodeType !== 3) {
    const after = n.childNodes[o], before = n.childNodes[o - 1];
    if (after?.nodeType === 3) { n = after; o = 0; } else if (before?.nodeType === 3) { n = before; o = before.length; } else return null;
  }
  // a collapsed range often has no box (at the start or end of the text), so measure the character next to the caret
  const r = document.createRange();
  if (o < n.length) { r.setStart(n, o); r.setEnd(n, o + 1); const b = r.getClientRects()[0]; if (b) return { left: b.left, top: b.top, bottom: b.bottom, height: b.height }; }
  if (o > 0) { r.setStart(n, o - 1); r.setEnd(n, o); const rs = r.getClientRects(), b = rs[rs.length - 1]; if (b) return { left: b.right, top: b.top, bottom: b.bottom, height: b.height }; }
  return null;
}
const lineRects = field => { const r = document.createRange(); r.selectNodeContents(field); return [...r.getClientRects()].filter(x => x.height); };
/** Is the caret on the field's first line (up) or last line (down)? An empty field is one line. */
function onEdgeLine(field, caret, up) {
  const rs = lineRects(field);
  if (!caret || !rs.length) return true;
  const mid = (caret.top + caret.bottom) / 2, lh = caret.height || 18;
  return up ? mid - Math.min(...rs.map(r => r.top)) < lh : Math.max(...rs.map(r => r.bottom)) - mid < lh;
}
/** Put the caret in a field at the same horizontal spot, on its last line coming from below or its first line from above. */
function caretInto(field, x, up) {
  field.focus({ preventScroll: true });
  const rs = lineRects(field);
  let range = null;
  if (x != null && rs.length) {
    const line = rs.reduce((a, b) => (up ? b.bottom > a.bottom : b.top < a.top) ? b : a), y = (line.top + line.bottom) / 2;
    const fr = field.getBoundingClientRect(), px = Math.min(Math.max(x, fr.left + 1), fr.right - 1);
    const p = document.caretPositionFromPoint?.(px, y);
    if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
    else range = document.caretRangeFromPoint?.(px, y) || null;
    if (range && !field.contains(range.startContainer)) range = null;
  }
  if (!range) { range = document.createRange(); range.selectNodeContents(field); range.collapse(!up); }
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
}
