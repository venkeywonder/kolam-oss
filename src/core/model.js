import { S, cur } from './store.js';

/* ================= model queries ================= */
export const itemsOf = b => Object.values(S.items).filter(i => i.board === b);
export const childrenOf = colId => Object.values(S.items).filter(i => i.col === colId).sort((a, b) => a.order - b.order);
export const maxZ = (b = cur) => itemsOf(b).reduce((m, i) => Math.max(m, i.z || 0), 0);
export const countCards = bid => Object.values(S.items).filter(i => i.board === bid).length;
export function isDescendantBoard(bid, ancestor) {
  let b = S.boards[bid], n = 0;
  while (b && n++ < 100) { if (b.id === ancestor) return true; b = S.boards[b.parent]; }
  return false;
}
/** Board cards and shortcuts: cards that open a board (data.target). */
export const opensBoard = it => it?.type === 'board' || it?.type === 'shortcut';
/** The board card that opens a board (shortcuts don't count): it holds the board's icon and colour. */
export const boardCardOf = bid => Object.values(S.items).find(i => i.type === 'board' && i.data?.target === bid) || null;
/** The boards from the top one you can see down to this one. */
export function boardPath(bid) {
  const out = []; let b = S.boards[bid], n = 0;
  while (b && n++ < 100) { out.unshift(b); b = S.boards[b.parent]; }
  return out;
}
