import { placeDragged } from './drag.js';
import { $ } from '../core/util.js';
import { S, can, checkpoint, cur, save, sel, user } from '../core/store.js';
import { V, itemRect } from './viewport.js';
import { renderBoard } from './render.js';
import { showMenu } from '../ui/menus.js';
import { toast } from '../ui/toast.js';

/* ================= lock / arrange / snapping ================= */
export function toggleLock() {
  const ids = [...sel].filter(id => S.items[id]); if (!ids.length) return;
  const lock = !ids.every(id => S.items[id].locked);
  // a lock someone else set can only be lifted by them or the board's owner
  const theirs = lock ? [] : ids.filter(id => S.items[id].lockedBy !== user?.id);
  if (theirs.length && !can(cur, 'owner')) return toast('Only the owner can unlock a card someone else locked');
  checkpoint();
  ids.forEach(id => { if (lock) S.items[id].locked = true; else { delete S.items[id].locked; delete S.items[id].lockedBy; } });
  save(); renderBoard();
  toast(lock ? 'Locked in place' : 'Unlocked');
}
export function arrange(kind) {
  const its = [...sel].map(id => S.items[id]).filter(i => i && !i.col && !i.locked);
  if (its.length < 2) return toast('Select two or more unlocked cards');
  checkpoint();
  const R = new Map(its.map(i => [i.id, itemRect(i.id)]));
  const rs = [...R.values()];
  const minX = Math.min(...rs.map(r => r.x)), maxX = Math.max(...rs.map(r => r.x + r.w));
  const minY = Math.min(...rs.map(r => r.y)), maxY = Math.max(...rs.map(r => r.y + r.h));
  const gap = 24;
  const w = i => R.get(i.id).w, h = i => R.get(i.id).h;
  switch (kind) {
    case 'left': its.forEach(i => (i.x = minX)); break;
    case 'right': its.forEach(i => (i.x = maxX - w(i))); break;
    case 'hcenter': its.forEach(i => (i.x = (minX + maxX) / 2 - w(i) / 2)); break;
    case 'top': its.forEach(i => (i.y = minY)); break;
    case 'bottom': its.forEach(i => (i.y = maxY - h(i))); break;
    case 'vmiddle': its.forEach(i => (i.y = (minY + maxY) / 2 - h(i) / 2)); break;
    case 'dist-h': {
      const s = its.sort((a, b) => a.x - b.x), sum = s.reduce((a, i) => a + w(i), 0), g = (maxX - minX - sum) / (s.length - 1);
      let x = minX; s.forEach(i => { i.x = x; x += w(i) + g; }); break;
    }
    case 'dist-v': {
      const s = its.sort((a, b) => a.y - b.y), sum = s.reduce((a, i) => a + h(i), 0), g = (maxY - minY - sum) / (s.length - 1);
      let y = minY; s.forEach(i => { i.y = y; y += h(i) + g; }); break;
    }
    case 'row': { let x = minX; its.sort((a, b) => a.x - b.x).forEach(i => { i.x = x; i.y = minY; x += w(i) + gap; }); break; }
    case 'stack': { let y = minY; its.sort((a, b) => a.y - b.y).forEach(i => { i.y = y; i.x = minX; y += h(i) + gap; }); break; }
    case 'grid': {
      const s = its.sort((a, b) => (Math.round(a.y / 60) - Math.round(b.y / 60)) || a.x - b.x);
      const cols = Math.ceil(Math.sqrt(s.length)), colW = Math.max(...s.map(w)) + gap;
      let y = minY;
      for (let r = 0; r < Math.ceil(s.length / cols); r++) {
        const row = s.slice(r * cols, r * cols + cols);
        row.forEach((i, c) => { i.x = minX + c * colW; i.y = y; });
        y += Math.max(...row.map(h)) + gap;
      }
      break;
    }
  }
  its.forEach(i => { i.x = Math.round(i.x); i.y = Math.round(i.y); });
  save(); renderBoard();
}
export function showArrangeMenu(x, y) {
  showMenu(x, y, [
    { label: 'Align left edges', act: () => arrange('left') },
    { label: 'Align centres', act: () => arrange('hcenter') },
    { label: 'Align right edges', act: () => arrange('right') },
    '-',
    { label: 'Align top edges', act: () => arrange('top') },
    { label: 'Align middles', act: () => arrange('vmiddle') },
    { label: 'Align bottom edges', act: () => arrange('bottom') },
    '-',
    { label: 'Distribute horizontally', act: () => arrange('dist-h') },
    { label: 'Distribute vertically', act: () => arrange('dist-v') },
    '-',
    { label: 'Arrange in a row', act: () => arrange('row') },
    { label: 'Stack vertically', act: () => arrange('stack') },
    { label: 'Tidy into a grid', icon: 'board', act: () => arrange('grid') },
  ]);
}
export function snapGuides(d) {
  const g = $('#guides');
  if (!d || !d.list.length || !d.others.length) { if (g.dataset.h) { g.innerHTML = ''; g.dataset.h = ''; } return; }
  const z = V().z, th = 6 / z;
  const items = d.list.map(o => ({ o, it: S.items[o.id] }));
  const gx1 = Math.min(...items.map(({ it }) => it.x)), gy1 = Math.min(...items.map(({ it }) => it.y));
  const gx2 = Math.max(...items.map(({ o, it }) => it.x + o.w)), gy2 = Math.max(...items.map(({ o, it }) => it.y + o.h));
  let bx = null, by = null;
  for (const r of d.others) {
    for (const gv of [gx1, (gx1 + gx2) / 2, gx2]) for (const ov of [r.x, r.x + r.w / 2, r.x + r.w]) {
      const diff = ov - gv; if (Math.abs(diff) < th && (!bx || Math.abs(diff) < Math.abs(bx.d))) bx = { d: diff, v: ov, r };
    }
    for (const gv of [gy1, (gy1 + gy2) / 2, gy2]) for (const ov of [r.y, r.y + r.h / 2, r.y + r.h]) {
      const diff = ov - gv; if (Math.abs(diff) < th && (!by || Math.abs(diff) < Math.abs(by.d))) by = { d: diff, v: ov, r };
    }
  }
  const dx = bx ? bx.d : 0, dy = by ? by.d : 0;
  if (dx || dy) for (const { o, it } of items) { it.x = Math.round(it.x + dx); it.y = Math.round(it.y + dy); placeDragged(o, it); }
  const t = 1 / z;
  let h = '';
  if (bx) { const y1 = Math.min(gy1 + dy, bx.r.y), y2 = Math.max(gy2 + dy, bx.r.y + bx.r.h); h += `<i style="left:${bx.v}px;top:${y1}px;width:${t}px;height:${y2 - y1}px"></i>`; }
  if (by) { const x1 = Math.min(gx1 + dx, by.r.x), x2 = Math.max(gx2 + dx, by.r.x + by.r.w); h += `<i style="top:${by.v}px;left:${x1}px;height:${t}px;width:${x2 - x1}px"></i>`; }
  if (g.dataset.h !== h) { g.innerHTML = h; g.dataset.h = h; }
}
