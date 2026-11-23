/*
 * Text alignment for the cards that hold text (notes, to-dos, columns, comments, image captions, tables, documents):
 * left, centre, right or justified.
 * Stored on the card as `align` (absent = the type's usual alignment); the last one picked for a type is the default
 * for new cards of that type (see core/styles.js).
 */
import { S, checkpoint, els, save } from '../core/store.js';
import { remember } from '../core/styles.js';

export const ALIGNABLE = new Set(['note', 'todo', 'column', 'comment', 'image', 'table', 'doc']);
export const ALIGNS = [['left', 'Left', 'alignLeft'], ['center', 'Center', 'alignCenter'], ['right', 'Right', 'alignRight'], ['justify', 'Justify', 'alignJustify']];
const usual = type => (type === 'column' ? 'center' : 'left');

export const alignOf = it => it.align || usual(it.type);
export const alignIcon = v => ALIGNS.find(a => a[0] === v)[2];

/** Mark a card element with its alignment (CSS applies it to the card's own text only, not to cards inside a column). */
export function applyAlign(el, it) {
  if (it.align && ALIGNABLE.has(it.type)) { el.dataset.align = ''; el.style.setProperty('--ta', it.align); }
  else { delete el.dataset.align; el.style.removeProperty('--ta'); }
}

/** Align the text of these cards; returns false when nothing changed. */
export function setAlign(ids, v) {
  const items = [...ids].map(id => S.items[id]).filter(it => it && ALIGNABLE.has(it.type) && alignOf(it) !== v);
  if (!items.length) return false;
  checkpoint();
  for (const it of items) {
    it.align = v === usual(it.type) ? null : v;
    remember(it.type, { align: it.align });
    const el = els.get(it.id); if (el) applyAlign(el, it);
  }
  save();
  return true;
}
