import { $, esc } from '../core/util.js';
import { icon } from './icons.js';
import { canvas, toastEl } from '../core/dom.js';
import { S, cur, editingId, flush, redo, saveT, undo } from '../core/store.js';
import { fit, zoomAt, zoomCenter } from '../canvas/viewport.js';
import { itemsOf } from '../core/model.js';
import { rebuildCard } from '../canvas/render.js';

/* ================= misc UI ================= */
export let toastT;
export function toast(msg, actLabel, act) {
  toastEl.innerHTML = `<span>${esc(msg)}</span>` + (actLabel ? `<button>${esc(actLabel)}</button>` : '');
  if (actLabel) $('button', toastEl).onclick = () => { toastEl.hidden = true; act(); };
  toastEl.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (toastEl.hidden = true), actLabel ? 5000 : 2400);
}

export function init() {
  $('#undoBtn').innerHTML = icon('undo', 18);
  $('#redoBtn').innerHTML = icon('redo', 18);
  $('#menuBtn').innerHTML = icon('more', 18);
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#zoomCtl').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'zoomPct') { const r = canvas.getBoundingClientRect(); return zoomAt(1, r.left + r.width / 2, r.top + r.height / 2); }
    ({ in: () => zoomCenter(1.2), out: () => zoomCenter(1 / 1.2), fit })[b.dataset.z]?.();
  });
  addEventListener('beforeunload', () => { if (saveT) flush(); });
  // refresh relative timestamps on comments occasionally
  setInterval(() => { if (!S) return; for (const it of itemsOf(cur)) if (it.type === 'comment' && editingId !== it.id && !document.activeElement?.closest?.(`[data-id="${it.id}"]`)) rebuildCard(it.id); }, 60000);
}

