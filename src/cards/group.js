/*
 * Group boxes: a labelled box drawn around cards ("VPC", "Backend", "Region"…). A group always sits under the other
 * cards (bigger groups under smaller ones, so groups nest). Only its label (to select and move it) and its edges (to
 * resize it) take the pointer, so you can still click and box-select what's inside; moving it takes along everything
 * that lies wholly inside it.
 * On the card: data.title, data.solid (a solid border instead of dashes) and an optional icon by its title
 * (data.ref / data.asset / data.dark, as on icon elements: cards/icon.js).
 */
import { S, checkpoint, cur, els, save } from '../core/store.js';
import { itemsOf } from '../core/model.js';
import { itemRect, rectWorld } from '../canvas/viewport.js';
import { remember } from '../core/styles.js';
import { createItem } from '../actions/create.js';
import { startEdit } from '../canvas/editing.js';

const PAD = 28, HEAD = 44;

/** Draw order on a board: groups first (largest first), then everything else by z. */
export function drawOrder(a, b) {
  const ga = a.type === 'group', gb = b.type === 'group';
  if (ga !== gb) return ga ? -1 : 1;
  if (ga) return (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0);
  return (a.z || 0) - (b.z || 0);
}

/** The cards (and smaller groups) lying wholly inside a group on the board, unless locked in place. */
export function contentsOf(id) {
  const g = itemRect(id); if (!g) return [];
  return itemsOf(cur).filter(it => {
    if (it.id === id || it.col || it.locked) return false;
    const r = itemRect(it.id);
    return r && r.x >= g.x - 1 && r.y >= g.y - 1 && r.x + r.w <= g.x + g.w + 1 && r.y + r.h <= g.y + g.h + 1;
  }).map(it => it.id);
}

/** Where a card is drawn on the board, including an icon's name hanging under it. */
function drawnRect(id) {
  const r = itemRect(id), label = els.get(id)?.querySelector('.ic-label');
  if (!r || !label?.offsetParent) return r;
  const l = rectWorld(label), x = Math.min(r.x, l.x), y = Math.min(r.y, l.y);
  return { x, y, w: Math.max(r.x + r.w, l.x + l.w) - x, h: Math.max(r.y + r.h, l.y + l.h) - y };
}

/** Draw a group around these cards, with room for its label, and start naming it. */
export function groupAround(ids) {
  const rs = [...ids].map(id => S.items[id]?.col ? null : drawnRect(id)).filter(Boolean);
  if (!rs.length) return;
  const x1 = Math.min(...rs.map(r => r.x)) - PAD, y1 = Math.min(...rs.map(r => r.y)) - HEAD;
  const x2 = Math.max(...rs.map(r => r.x + r.w)) + PAD, y2 = Math.max(...rs.map(r => r.y + r.h)) + PAD;
  const it = createItem('group', { x: x1, y: y1 }, { w: Math.round(x2 - x1), h: Math.round(y2 - y1) });
  startEdit(it.id);
}

/** Solid or dashed border for these groups; the choice becomes the one new groups get. */
export function setGroupBorder(ids, solid) {
  const gs = [...ids].map(id => S.items[id]).filter(it => it?.type === 'group' && !it.locked);
  if (!gs.length) return;
  checkpoint();
  for (const g of gs) { if (solid) g.data.solid = true; else delete g.data.solid; els.get(g.id)?.classList.toggle('grp-solid', solid); }
  remember('group', { solid: solid || null });
  save();
}
