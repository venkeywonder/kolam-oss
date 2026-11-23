/*
 * Keeping the text cursor in place while other people's changes redraw what you're typing in.
 * The cursor is remembered as a character offset into the text, moved by however much text changed before it.
 */
import { editingId, els } from './store.js';

/** Character offset of the cursor inside root, or null when it isn't there. */
export function caretOf(root) {
  const s = getSelection();
  if (!s?.rangeCount || !root.contains(s.focusNode)) return null;
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(s.focusNode, s.focusOffset);
  return r.toString().length;
}

export function setCaret(root, off) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n, last = null;
  while ((n = w.nextNode())) {
    if (off <= n.length) return place(n, off);
    off -= n.length; last = n;
  }
  if (last) place(last, last.length);
  else place(root, 0);
}

function place(node, off) {
  const r = document.createRange(); r.setStart(node, off); r.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

/** Where offset c in text a ends up after a became b (one changed stretch, found from the common start and end). */
export function shift(a, b, c) {
  let p = 0; const n = Math.min(a.length, b.length);
  while (p < n && a[p] === b[p]) p++;
  let q = 0;
  while (q < n - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  if (c <= p) return c;
  if (c >= a.length - q) return c + b.length - a.length;
  return b.length - q;
}

/** Replace what's in root (by running fn) and put the cursor back where it was relative to the text. */
export function keepIn(root, fn) {
  const c = document.activeElement && root.contains(document.activeElement) ? caretOf(root) : null;
  const before = root.textContent;
  fn();
  if (c !== null) setCaret(root, shift(before, root.textContent, c));
}

// which editable part of a card the cursor is in, found again after the card is redrawn
function keyOf(n) {
  const li = n.closest('[data-tid]');
  if (li) return `[data-tid="${CSS.escape(li.dataset.tid)}"] .tt`;
  if (n.matches('td[data-r]')) return `td[data-r="${n.dataset.r}"][data-c="${n.dataset.c}"]`;
  return n.classList.length ? '.' + [...n.classList].map(c => CSS.escape(c)).join('.') : null;
}

/** Redraw (fn) while you're typing in a card, keeping the cursor in the same field at the same place in its text. */
export function keepCaret(fn) {
  const ae = document.activeElement;
  const card = editingId && els.get(editingId);
  if (!card || !ae?.isContentEditable || !card.contains(ae)) return fn();
  const key = keyOf(ae), c = caretOf(ae), before = ae.textContent, id = editingId;
  fn();
  const now = els.get(id), n = key && now?.querySelector(key);
  if (!n || n.contentEditable !== 'true') return;
  n.focus();
  if (c !== null) setCaret(n, shift(before, n.textContent, c));
}
