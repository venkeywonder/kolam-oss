import { $, $$, clamp, esc } from '../core/util.js';
import { S } from '../core/store.js';
import { centerOn } from '../canvas/viewport.js';
import { TYPES } from '../cards/types.js';
import { selectOnly } from '../canvas/selection.js';
import { openBoard } from '../app/navigation.js';
import { panel, renderPanel, setPanel } from './drawer.js';

/* ================= search ================= */
export const searchEl = $('#search'), resultsEl = $('#searchResults');
export let results = [], activeR = 0;
export const plain = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
export function runSearch() {
  const q = searchEl.value.trim().toLowerCase();
  if (!q) { resultsEl.hidden = true; return; }
  results = [];
  for (const b of Object.values(S.boards)) if (b.title.toLowerCase().includes(q)) results.push({ kind: 'board', board: b.id, title: b.title, where: 'Board' });
  for (const it of Object.values(S.items)) {
    if (it.type === 'board' || it.type === 'shortcut') continue;   // boards are listed by name already
    const t = plain(TYPES[it.type]?.text?.(it));
    const i = t.toLowerCase().indexOf(q);
    if (i < 0) continue;
    const snip = (i > 30 ? '…' : '') + t.slice(Math.max(0, i - 30), i + 70);
    results.push({ kind: 'item', id: it.id, board: it.board, title: snip, where: `${TYPES[it.type].label} in ${it.board === '__unsorted' ? 'Unsorted' : S.boards[it.board]?.title || '?'}` });
    if (results.length > 40) break;
  }
  activeR = 0;
  resultsEl.innerHTML = results.length ? results.map((r, i) => `<button class="sr${i === 0 ? ' active' : ''}" data-r="${i}"><b>${esc(r.title)}</b><small>${esc(r.where)}</small></button>`).join('') : '<div class="sr-empty">No matches</div>';
  resultsEl.hidden = false;
}
export function goResult(r) {
  if (!r) return;
  resultsEl.hidden = true; searchEl.blur();
  if (r.kind === 'board') return openBoard(r.board);
  if (r.board === '__unsorted') { setPanel('unsorted'); return renderPanel(); }
  openBoard(r.board);
  const it = S.items[r.id];
  const target = it?.col || r.id;
  selectOnly(r.id);
  centerOn(target);
}

export function init() {
  searchEl.addEventListener('input', runSearch);
  searchEl.addEventListener('focus', runSearch);
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeR = clamp(activeR + (e.key === 'ArrowDown' ? 1 : -1), 0, results.length - 1);
      $$('.sr', resultsEl).forEach((b, i) => b.classList.toggle('active', i === activeR));
    } else if (e.key === 'Enter') goResult(results[activeR]);
    else if (e.key === 'Escape') { searchEl.value = ''; resultsEl.hidden = true; searchEl.blur(); }
  });
  resultsEl.addEventListener('mousedown', e => { e.preventDefault(); const b = e.target.closest('[data-r]'); if (b) goResult(results[+b.dataset.r]); });
  searchEl.addEventListener('blur', () => setTimeout(() => (resultsEl.hidden = true), 150));
}

