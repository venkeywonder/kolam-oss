import { canvas } from '../core/dom.js';
import { S, RO, checkpoint, save } from '../core/store.js';
import { V } from './viewport.js';
import { lineGeom, renderLines } from './lines.js';

/* ================= line labels ================= */
export function editLineLabel(lid) {
  const ln = S.lines[lid]; if (!ln || RO) return;
  const G = lineGeom(ln); if (!G) return;
  const P = G.P;
  const v = V(), cr = canvas.getBoundingClientRect();
  const inp = document.createElement('input');
  inp.className = 'ln-input'; inp.value = ln.label || ''; inp.placeholder = 'Add a label';
  inp.style.left = cr.left + v.x + P.x * v.z + 'px';
  inp.style.top = cr.top + v.y + P.y * v.z + 'px';
  document.body.appendChild(inp);
  inp.focus(); inp.select();
  const done = ok => {
    if (!inp.isConnected) return;
    const val = inp.value.trim(); inp.remove();
    if (ok && val !== (ln.label || '')) { checkpoint(); ln.label = val; save(); renderLines(); }
  };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
  inp.addEventListener('blur', () => done(true));
}
