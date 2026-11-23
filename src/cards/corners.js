/*
 * Card corners, a setting of each board (S.boards[id].corners): sharp, curved or rounded for every card on that
 * board. Boards inside it keep their own setting. Set from the View menu.
 */
import { S, checkpoint, save } from '../core/store.js';
import { remember } from '../core/styles.js';

export const CORNERS = [['sharp', 'Sharp corners'], ['curved', 'Curved corners'], ['rounded', 'Rounded corners']];
const KINDS = new Set(CORNERS.map(c => c[0]));
const RADIUS = { sharp: 0, curved: 6, rounded: 11 };   // for the glyphs (24px box)

export const boardCorners = bid => (KINDS.has(S.boards[bid]?.corners) ? S.boards[bid].corners : 'sharp');

/** Set the corners of every card on board bid (sharp is the default, so it's stored as no setting). */
export function setBoardCorners(bid, kind) {
  const b = S.boards[bid];
  if (!b || !KINDS.has(kind) || boardCorners(bid) === kind) return;
  checkpoint();
  if (kind === 'sharp') delete b.corners; else b.corners = kind;
  remember('board', { corners: kind });   // new boards get these corners
  save();
}

/** A corner drawn as a glyph: the top-left corner of a box. */
export function cornerGlyph(kind, size = 16) {
  const r = RADIUS[kind] ?? 0, s = 5;
  const d = r ? `M${s} 21V${s + r}A${r} ${r} 0 0 1 ${s + r} ${s}H21` : `M${s} 21V${s}H21`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
