import { editingId, els, sel, selLine, setSelLine } from '../core/store.js';
import { renderLines } from './lines.js';
import { buildSelbar, positionBars } from '../ui/floatbars.js';

/* ---------- selection ---------- */
export function selectOnly(id) { sel.clear(); if (id) sel.add(id); setSelLine(null); refreshSel(); }
export function refreshSel() {
  for (const [id, el] of els) el.classList.toggle('selected', sel.has(id) && editingId !== id);
  renderLines();
  buildSelbar();
  positionBars();
}
