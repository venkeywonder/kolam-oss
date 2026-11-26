/*
 * Group boxes: a labelled box drawn around cards ("VPC", "Backend", "Region"…). A group always sits under the other
 * cards (bigger groups under smaller ones, so groups nest). Only its label (to select and move it) and its edges (to
 * resize it) take the pointer, so you can still click and box-select what's inside; moving it takes along everything
 * that lies wholly inside it.
 * A card is in a group or out of it, never across its edge: a card dropped with its middle in a group joins it (the
 * group grows to take it in) and one dropped with its middle outside slides off the edge.
 * A minimised group shows only its label: the cards inside are hidden and move along with it, until it's maximised.
 * On the card: data.title, data.solid (a solid border instead of dashes), an optional icon by its title
 * (data.ref / data.asset / data.dark, as on icon elements: cards/icon.js) and, while minimised, data.collapsed with
 * data.members (the cards it held when it was minimised).
 */
import { RO, S, checkpoint, cur, els, save, sel } from '../core/store.js';
import { clamp } from '../core/util.js';
import { itemsOf } from '../core/model.js';
import { itemRect, rectWorld } from '../canvas/viewport.js';
import { remember } from '../core/styles.js';
import { createItem } from '../actions/create.js';
import { startEdit } from '../canvas/editing.js';
import { renderBoard } from '../canvas/render.js';
import { calm } from '../canvas/motion.js';

const PAD = 28, HEAD = 44, GAP = 12;

const folded = it => it?.type === 'group' && !!it.data?.collapsed;
/** Box a lies wholly over box b (a pixel either way still counts). */
const covers = (a, b) => b.x >= a.x - 1 && b.y >= a.y - 1 && b.x + b.w <= a.x + a.w + 1 && b.y + b.h <= a.y + a.h + 1;
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Draw order on a board: groups first (largest first), then everything else (minimised groups too) by z. */
export function drawOrder(a, b) {
  const ga = a.type === 'group' && !folded(a), gb = b.type === 'group' && !folded(b);
  if (ga !== gb) return ga ? -1 : 1;
  if (ga) return (b.w || 0) * (b.h || 0) - (a.w || 0) * (a.h || 0);
  return (a.z || 0) - (b.z || 0);
}

/**
 * The cards (and smaller groups) inside a group: those lying wholly inside it on the board, or for a minimised one
 * those it hides; either way with what minimised groups among them hide. Not the ones locked in place (the group
 * doesn't carry those), unless `locked` asks for them too.
 */
export function contentsOf(id, locked = false) {
  const keep = k => locked || !S.items[k]?.locked;
  if (folded(S.items[id])) return hiddenBy(id).filter(keep);
  const g = itemRect(id); if (!g) return [];
  const inside = itemsOf(cur).filter(it => {
    if (it.id === id || it.col || !keep(it.id)) return false;
    const r = itemRect(it.id);
    return r && covers(g, r);
  }).map(it => it.id);
  return [...new Set([...inside, ...inside.flatMap(k => hiddenBy(k).filter(keep))])];
}

/** Where a card is drawn on the board, including an icon's name hanging under it. */
function drawnRect(id) {
  const r = itemRect(id), label = els.get(id)?.querySelector('.ic-label');
  if (!r || !label?.offsetParent) return r;
  const l = rectWorld(label), x = Math.min(r.x, l.x), y = Math.min(r.y, l.y);
  return { x, y, w: Math.max(r.x + r.w, l.x + l.w) - x, h: Math.max(r.y + r.h, l.y + l.h) - y };
}

/** The box around these cards (by id) with the room a group leaves for its edges and label, or null for none. */
function boxAround(ids) {
  const rs = ids.map(id => S.items[id]?.col ? null : drawnRect(id)).filter(Boolean);
  if (!rs.length) return null;
  return {
    x1: Math.min(...rs.map(r => r.x)) - PAD, y1: Math.min(...rs.map(r => r.y)) - HEAD,
    x2: Math.max(...rs.map(r => r.x + r.w)) + PAD, y2: Math.max(...rs.map(r => r.y + r.h)) + PAD,
  };
}

/** The box a group has to keep covering when it's resized: what lies wholly inside it, with that same room. */
export const contentBox = id => boxAround(contentsOf(id, true));

/** Draw a group around these cards, with room for its label, and start naming it. */
export function groupAround(ids) {
  const b = boxAround([...ids]);
  if (!b) return;
  const it = createItem('group', { x: b.x1, y: b.y1 }, { w: Math.round(b.x2 - b.x1), h: Math.round(b.y2 - b.y1) });
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

/* ---------- dropping cards in and out of groups ---------- */

/** The groups on the board cards can be dropped into (shown in full, not among `moving`), smallest first, with their boxes. */
export function dropGroups(moving) {
  return itemsOf(cur).filter(it => it.type === 'group' && !folded(it) && !moving.has(it.id) && !away.has(it.id))
    .map(it => ({ id: it.id, r: itemRect(it.id), locked: !!it.locked })).filter(g => g.r)
    .sort((a, b) => a.r.w * a.r.h - b.r.w * b.r.h);
}

/** The groups (from dropGroups) a card with box b lands in: its middle is inside them, and it doesn't cover them whole. */
export function landsIn(groups, b) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return groups.filter(({ r }) => cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h && !covers(b, r));
}
/**
 * Cards just dropped on the board ({id, w, h, carry}; their place is on the card) end up wholly in a group or clear of
 * it. A card landing in a group joins it: the group, and the ones around it, grow to take it in (a locked group pulls
 * the card in instead, if it fits). A card landing outside every group slides off the edge of any it lies across, with
 * the cards it carries (`carry`, a dropped group's contents). Changes the groups' boxes in `groups` and the cards;
 * returns the groups that grew (with their box before).
 */
export function settleDrop(groups, drops) {
  const grown = new Map();
  for (const d of drops) {
    const it = S.items[d.id]; if (!it) continue;
    const b = { x: it.x, y: it.y, w: d.w, h: d.h };
    const into = landsIn(groups, b);
    if (into.length) {
      let need = b;
      for (const g of into) {
        const r = g.r;
        if (!covers(r, need)) {
          if (g.locked) {
            if (need !== b || b.w > r.w - 2 * PAD || b.h > r.h - HEAD - PAD) break;
            b.x = clamp(b.x, r.x + PAD, r.x + r.w - PAD - b.w); b.y = clamp(b.y, r.y + HEAD, r.y + r.h - PAD - b.h);
          } else {
            if (!grown.has(g.id)) grown.set(g.id, { ...r });
            const x1 = need.x < r.x ? need.x - PAD : r.x, y1 = need.y < r.y ? need.y - HEAD : r.y;
            const x2 = Math.max(r.x + r.w, need.x + need.w + (need.x + need.w > r.x + r.w ? PAD : 0));
            const y2 = Math.max(r.y + r.h, need.y + need.h + (need.y + need.h > r.y + r.h ? PAD : 0));
            Object.assign(r, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
          }
        }
        need = r;
      }
    } else {
      // off the nearest edge of each group it lies across (a few rounds, in case that puts it across another)
      for (let n = 0; n < 4; n++) {
        const g = groups.find(({ r }) => overlaps(r, b) && !covers(b, r));
        if (!g) break;
        const r = g.r;
        const ways = [[r.x - GAP - b.x - b.w, 0], [r.x + r.w + GAP - b.x, 0], [0, r.y - GAP - b.y - b.h], [0, r.y + r.h + GAP - b.y]];
        const [dx, dy] = ways.sort((p, q) => Math.abs(p[0] + p[1]) - Math.abs(q[0] + q[1]))[0];
        b.x += dx; b.y += dy;
      }
    }
    const dx = Math.round(b.x) - it.x, dy = Math.round(b.y) - it.y;
    if (dx || dy) for (const k of [d.id, ...(d.carry || [])]) { const c = S.items[k]; if (c) { c.x += dx; c.y += dy; } }
  }
  for (const [id] of grown) {
    const g = S.items[id], r = groups.find(x => x.id === id).r;
    g.x = Math.round(r.x); g.y = Math.round(r.y); g.w = Math.round(r.w); g.h = Math.round(r.h);
  }
  return [...grown].map(([id, from]) => ({ id, from }));
}

/** After the board was redrawn: grow the groups settleDrop enlarged from their old box to the new one. */
export function showGrowth(grown) {
  if (calm()) return;
  for (const { id, from } of grown) {
    const el = els.get(id); if (!el) continue;
    const to = { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height };
    el.animate([{ left: from.x + 'px', top: from.y + 'px', width: from.w + 'px', height: from.h + 'px' }, to], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

/* ---------- minimised groups ---------- */

// card id -> the minimised group showing for it (the outermost one hiding it), on the board on screen; set by refreshFolds
let away = new Map();

/** The cards a minimised group hides: the ones it held when minimised, and what minimised groups among them hide. */
export function hiddenBy(id) {
  const out = new Set([id]);
  const hide = gid => {
    const g = S.items[gid];
    if (!folded(g)) return;
    for (const k of g.data.members || []) {
      const it = S.items[k];
      if (!it || out.has(k) || it.board !== g.board || it.col) continue;
      out.add(k); hide(k);
    }
  };
  hide(id);
  out.delete(id);
  return [...out];
}

/** Work out which cards of the board on screen minimised groups hide (renderBoard calls this before drawing). */
export function refreshFolds() {
  away = new Map();
  const groups = itemsOf(cur).filter(folded);
  if (!groups.length) return;
  const hidden = new Set(groups.flatMap(g => hiddenBy(g.id)));
  for (const g of groups) if (!hidden.has(g.id)) for (const k of hiddenBy(g.id)) away.set(k, g.id);
}
/** A card hidden in a minimised group: it isn't drawn and can't be picked. */
export const isAway = id => away.has(id);
/** What stands in for a card on the board: the minimised group hiding it, else the card itself (lines end there). */
export const shownAs = id => away.get(id) || id;

/** Minimise a group (only its label shows; the cards inside hide and move with it) or show it in full again. */
export function foldGroup(id, fold) {
  const g = S.items[id];
  if (g?.type !== 'group' || folded(g) === fold) return;
  if (!RO) checkpoint();   // someone who can only view folds it just for themselves
  if (fold) {
    g.data.members = contentsOf(id, true);   // while it's still shown in full
    g.data.collapsed = true;
    for (const k of hiddenBy(id)) sel.delete(k);
  } else { delete g.data.collapsed; delete g.data.members; }
  if (!RO) save();
  renderBoard();
}

/** Show every minimised group hiding this card, so it can be shown (a search result, a comment). */
export function reveal(id) {
  if (!away.has(id)) return;
  const hiding = itemsOf(cur).filter(g => folded(g) && hiddenBy(g.id).includes(id));
  if (!RO) checkpoint();
  for (const g of hiding) { delete g.data.collapsed; delete g.data.members; }
  if (!RO) save();
  renderBoard();
}

/** These cards plus what minimised groups among them hide: copying, moving or deleting a minimised group takes its cards. */
export function withHidden(ids) {
  const out = new Set(ids);
  for (const id of ids) for (const k of hiddenBy(id)) out.add(k);
  return [...out];
}
