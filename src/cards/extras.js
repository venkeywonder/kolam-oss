import { isDark } from '../ui/theme.js';
import { $, clamp, esc, track } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { pal } from '../core/palette.js';
import { S, RO, checkpoint, editingId, els, getAsset, save, sel, spaceDown } from '../core/store.js';
import { countCards } from '../core/model.js';
import { TYPES } from './types.js';
import { rebuildCard } from '../canvas/render.js';
import { renderLines } from '../canvas/lines.js';
import { hideMenu } from '../ui/menus.js';
import { pickDate, todayYmd } from '../ui/datepicker.js';
import { glide, snap } from '../canvas/motion.js';
import { cardClick, dragBegin, dragEnd, dragMove } from '../canvas/drag.js';
import { selectOnly } from '../canvas/selection.js';
import { exitEdit } from '../canvas/editing.js';
import { drawMode } from './drawing.js';
import { boardIconHtml } from './board-icon.js';

// --- to-do due dates (local calendar days, "YYYY-MM-DD")
export const todayStr = todayYmd;
export function fmtDue(d) {
  const t = new Date(todayStr() + 'T00:00'), day = new Date(d + 'T00:00'), n = Math.round((day - t) / 864e5);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n > 1 && n < 7) return day.toLocaleDateString(undefined, { weekday: 'short' });
  return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(day.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}) });
}
/**
 * Press on a task (not editing): drag it up or down to reorder the list (the row follows the pointer, the others
 * slide out of its way, and on release everything glides into the new order); drag sideways to move the whole card;
 * or just click, as anywhere else on the card.
 */
function taskDown(e, id, li) {
  hideMenu();
  if (editingId) exitEdit();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const was = sel.has(id) && sel.size === 1;
  if (!was) selectOnly(id);
  const ul = li.parentNode, lis = [...ul.children], from = lis.indexOf(li), tid = li.dataset.tid;
  const rects = lis.map(n => n.getBoundingClientRect()), r = rects[from];
  const z = r.height / li.offsetHeight || 1;   // the board's zoom
  const sx = e.clientX, sy = e.clientY, target = e.target;
  let to = from, mode = null, card = null;
  track(ev => {
    if (!mode) {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (Math.hypot(dx, dy) < 4) return;
      mode = lis.length > 1 && Math.abs(dy) >= Math.abs(dx) ? 'sort' : 'card';
      if (mode === 'card') card = dragBegin(sx, sy);
      else { ul.classList.add('sorting'); li.classList.add('lifted'); document.body.classList.add('grabbing'); }
    }
    if (card) return dragMove(card, ev);
    const dy = clamp(ev.clientY - sy, rects[0].top - r.top, rects.at(-1).bottom - r.bottom);
    li.style.translate = `0 ${dy / z}px`;
    const mid = r.top + r.height / 2 + dy;
    to = rects.filter((o, i) => i !== from && o.top + o.height / 2 < mid).length;
    lis.forEach((o, i) => {
      if (i === from) return;
      const shift = i > from && i <= to ? -r.height : i < from && i >= to ? r.height : 0;
      o.style.translate = shift ? `0 ${shift / z}px` : '';
    });
  }, ev => {
    if (!mode) return cardClick(ev, id, was, target);
    if (card) return dragEnd(card);
    document.body.classList.remove('grabbing');
    const tids = lis.map(n => n.dataset.tid);
    const before = snap(tids, t => lis[tids.indexOf(t)]);
    ul.classList.remove('sorting'); li.classList.remove('lifted');
    lis.forEach(o => (o.style.translate = ''));
    let root = ul;
    const cur = S.items[id], tasks = cur?.data.tasks, i = tasks?.findIndex(t => t.id === tid) ?? -1;
    if (to !== from && i >= 0) {
      checkpoint();
      const [task] = tasks.splice(i, 1);
      const after = tids.filter(t => t !== tid)[to - 1];
      tasks.splice(after ? tasks.findIndex(t => t.id === after) + 1 : 0, 0, task);
      save();
      root = rebuildCard(id) || ul;
    }
    glide(before, t => root.querySelector(`li[data-tid="${t}"]`), { zoom: z, duration: 320 });
  });
}

export function init() {
  // --- audio / video uploads play inline
  {
    const baseHtml = TYPES.file.html, baseMount = TYPES.file.mount;
    TYPES.file.html = it => {
      const m = it.data.mime || '';
      if (m.startsWith('video/')) return `<video controls preload="metadata" data-nodrag></video>` + baseHtml(it);
      if (m.startsWith('audio/')) return baseHtml(it) + `<audio controls preload="metadata" data-nodrag></audio>`;
      return baseHtml(it);
    };
    TYPES.file.mount = (el, it) => {
      baseMount(el, it);
      const media = $('video,audio', el);
      if (media) { getAsset(it.data.asset).then(u => { if (u) media.src = u; }); media.addEventListener('loadedmetadata', () => renderLines()); }
    };
  }
  {
    const baseMount = TYPES.todo.mount;
    TYPES.todo.html = it => {
      const tasks = it.data.tasks || [], done = tasks.filter(t => t.done).length, today = todayStr();
      return `<div class="todo-title" data-ph="To-do list">${esc(it.data.title)}</div>` +
        (tasks.length ? `<div class="todo-prog"><i style="width:${(done / tasks.length) * 100}%"></i></div>` : '') +
        `<ul>${tasks.map(t => {
          const cls = t.due && !t.done ? (t.due < today ? ' late' : t.due === today ? ' soon' : '') : '';
          return `<li data-tid="${t.id}" class="${t.done ? 'done' : ''}"><button class="chk" data-nodrag title="Toggle"></button><span class="tt">${esc(t.t)}</span>` +
            (t.due ? `<button class="due${cls}" data-nodrag data-due title="Due ${esc(new Date(t.due + 'T00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))} · change">${fmtDue(t.due)}</button>` : `<button class="due-add" data-nodrag data-due title="Add due date">${icon('calendar', 13)}</button>`) +
            `</li>`;
        }).join('')}</ul><div class="todo-add" data-nodrag>+ Add a task</div>`;
    };
    TYPES.todo.mount = (el, it) => {
      baseMount(el, it);
      // tasks are dragged by themselves (while the list isn't being edited)
      el.addEventListener('pointerdown', e => {
        const li = e.target.closest('li');
        if (!li || e.button !== 0 || RO || drawMode || spaceDown || editingId === it.id || S.items[it.id]?.locked) return;
        if (e.target.closest('[data-nodrag],.rz,.conn') || e.shiftKey || e.metaKey || e.ctrlKey) return;
        e.preventDefault(); e.stopImmediatePropagation();
        taskDown(e, it.id, li);
      });
      el.addEventListener('click', e => {
        const b = e.target.closest('[data-due]'); if (!b || RO) return;
        const tid = b.closest('li')?.dataset.tid;
        const task = S.items[it.id]?.data.tasks?.find(t => t.id === tid); if (!task) return;
        b.classList.add('picking');
        pickDate({
          anchor: b, value: task.due || null,
          onPick: v => {
            const cur = S.items[it.id], cel = els.get(it.id); if (!cur) return;
            if (editingId === it.id && cel) TYPES.todo.read(cel, cur); else checkpoint();
            const t = cur.data.tasks.find(t => t.id === tid); if (!t) return;
            t.due = v;
            save();
            // the chip pops in with its new date
            const nel = rebuildCard(it.id);
            nel?.querySelector(`li[data-tid="${tid}"] .due`)?.classList.add('pop');
          },
          // the chip stays highlighted while its picker is open
          onClose: () => b.classList.remove('picking'),
        });
      });
    };
    const baseText = TYPES.todo.text;
    TYPES.todo.text = it => baseText(it);
  }
  // --- collapsible columns
  {
    const baseMount = TYPES.column.mount;
    TYPES.column.html = it => `<div class="col-head"><button class="col-tg" data-nodrag title="${it.data.collapsed ? 'Expand' : 'Collapse'}">${icon(it.data.collapsed ? 'chevR' : 'chevD', 14)}</button><div class="col-title" data-ph="Untitled column">${esc(it.data.title)}</div><span class="col-count"></span></div><div class="col-body"></div>`;
    TYPES.column.mount = (el, it) => {
      baseMount(el, it);
      if (it.data.collapsed) el.classList.add('collapsed');
      $('.col-tg', el).addEventListener('click', () => {
        const cur = S.items[it.id];
        if (RO) { cur.data.collapsed = !cur.data.collapsed; rebuildCard(it.id); return; }   // only for you, not saved
        checkpoint();
        cur.data.collapsed = !cur.data.collapsed;
        save(); rebuildCard(it.id);
      });
    };
  }
  // --- board card icons (emoji, icon or picture: cards/board-icon.js)
  {
    TYPES.board.html = it => {
      const b = S.boards[it.data.target];
      // someone restricted this board, so its card shows without its contents
      if (!b) return `<div class="bd-icon bd-noaccess" title="You don’t have access to this board">${icon('lock', 26)}</div>` +
        `<div class="bd-title">${esc(it.data.title || 'Private board')}</div><div class="bd-meta">No access</div>`;
      const n = countCards(it.data.target);
      const kids = Object.values(S.boards).filter(x => x.parent === it.data.target).length;
      const p = pal(it.color || 'purple');
      const meta = [kids ? `${kids} board${kids === 1 ? '' : 's'}` : '', `${n} card${n === 1 ? '' : 's'}`].filter(Boolean).join(', ');
      return `<div class="bd-icon" title="Open board" style="--tile:${isDark() ? p.dbg : p.bg};--tile-ink:${p.line}">${boardIconHtml(it.data, 30)}</div>` +
        `<div class="bd-title" data-ph="Untitled board">${esc(b.title)}</div><div class="bd-meta">${meta}</div>`;
    };
  }
}

