import { $, esc } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { canvas, world } from '../core/dom.js';
import { RO, sel, selLine, setSelLine } from '../core/store.js';
import { V, toWorld } from '../canvas/viewport.js';
import { TYPES } from './types.js';
import { refreshSel } from '../canvas/selection.js';
import { exitEdit } from '../canvas/editing.js';
import { panStart } from '../canvas/pointer.js';
import { createItem } from '../actions/create.js';
import { toast } from '../ui/toast.js';
import { inkCol } from '../ui/theme.js';

// --- freehand drawing placed on the board
export function strokePath(p) {
  if (p.length < 4) return `M${p[0]},${p[1]} l0.1,0`;
  let d = `M${p[0]},${p[1]}`;
  for (let i = 2; i < p.length - 2; i += 2) d += ` Q${p[i]},${p[i + 1]} ${(p[i] + p[i + 2]) / 2},${(p[i + 1] + p[i + 3]) / 2}`;
  return d + ` L${p[p.length - 2]},${p[p.length - 1]}`;
}
export let drawMode = false, drawStrokes = [], drawColor = '#1f1f24', drawWidth = 3, drawTemp = null;
export const drawbar = $('#drawbar');
export function buildDrawbar() {
  const cols = ['#1f1f24', '#e5534b', '#ee8a26', '#e2b000', '#35a35a', '#3478e5', '#7b55d9'];
  drawbar.innerHTML = cols.map(c => `<button class="dotbtn${c === drawColor ? ' on' : ''}" data-dc="${c}" style="--c:${inkCol(c)}" title="Pen colour"></button>`).join('') +
    '<span class="div"></span>' + [2, 4, 8].map(w => `<button class="wbtn${w === drawWidth ? ' on' : ''}" data-dw="${w}" style="--w:${w + 2}px" title="Pen size"></button>`).join('') +
    `<span class="div"></span><button data-da="undo" title="Undo stroke">${icon('undo', 16)}</button><button data-da="done">Done</button>`;
}
export function enterDraw() {
  if (RO) return;
  exitEdit();
  drawMode = true; drawStrokes = [];
  canvas.classList.add('drawing');
  sel.clear(); setSelLine(null); refreshSel();
  buildDrawbar(); drawbar.hidden = false;
  $('.tool[data-tool="draw"]')?.classList.add('active');
  drawTemp = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  drawTemp.id = 'drawTemp'; drawTemp.classList.add('bigsvg');
  world.appendChild(drawTemp);
  toast('Draw anywhere on the board. Press Esc or Done when finished.');
}
export function renderDrawTemp() {
  if (!drawTemp) return;
  drawTemp.innerHTML = '<g transform="translate(50000,50000)">' + drawStrokes.map(s => `<path d="${strokePath(s.p)}" stroke="${inkCol(s.c)}" stroke-width="${s.w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`).join('') + '</g>';
}
export function drawDown(e) {
  if (e.button !== 0) { if (e.button === 1) panStart(e); return; }
  e.preventDefault(); e.stopPropagation();
  const r1 = n => Math.round(n * 10) / 10;
  const p0 = toWorld(e.clientX, e.clientY);
  const s = { c: drawColor, w: drawWidth, p: [r1(p0.x), r1(p0.y)] };
  drawStrokes.push(s);
  let lx = p0.x, ly = p0.y;
  const mv = ev => {
    const p = toWorld(ev.clientX, ev.clientY);
    if (Math.hypot(p.x - lx, p.y - ly) < 1.5 / V().z) return;
    lx = p.x; ly = p.y;
    s.p.push(r1(p.x), r1(p.y));
    renderDrawTemp();
  };
  const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); renderDrawTemp(); };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
  renderDrawTemp();
}
export function exitDraw() {
  if (!drawMode) return;
  drawMode = false;
  canvas.classList.remove('drawing');
  drawbar.hidden = true;
  $('.tool[data-tool="draw"]')?.classList.remove('active');
  drawTemp?.remove(); drawTemp = null;
  if (!drawStrokes.length) return;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, pad = 0;
  for (const s of drawStrokes) {
    pad = Math.max(pad, s.w);
    for (let i = 0; i < s.p.length; i += 2) { x1 = Math.min(x1, s.p[i]); x2 = Math.max(x2, s.p[i]); y1 = Math.min(y1, s.p[i + 1]); y2 = Math.max(y2, s.p[i + 1]); }
  }
  x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
  const vw = Math.max(10, Math.round(x2 - x1)), vh = Math.max(10, Math.round(y2 - y1));
  const strokes = drawStrokes.map(s => ({ c: s.c, w: s.w, p: s.p.map((v, i) => Math.round((v - (i % 2 ? y1 : x1)) * 10) / 10) }));
  drawStrokes = [];
  createItem('drawing', { x: x1, y: y1 }, { w: vw, data: { strokes, vw, vh } });
}

export function init() {
  TYPES.drawing = {
    label: 'Drawing', w: 200, ratio: true,
    init: () => ({ strokes: [], vw: 200, vh: 100 }),
    html: it => {
      const d = it.data;
      return `<svg viewBox="0 0 ${d.vw} ${d.vh}" preserveAspectRatio="none" style="display:block;width:100%;height:auto;aspect-ratio:${d.vw}/${d.vh}">` +
        d.strokes.map(s => { const pd = strokePath(s.p); return `<path d="${pd}" stroke="${esc(inkCol(s.c))}" stroke-width="${s.w}" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path class="dhit" d="${pd}" stroke-width="${Math.max(14, s.w + 10)}"/>`; }).join('') + '</svg>';
    },
    text: () => '',
  };
  drawbar.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.dc) drawColor = b.dataset.dc;
    if (b.dataset.dw) drawWidth = +b.dataset.dw;
    if (b.dataset.da === 'undo') { drawStrokes.pop(); renderDrawTemp(); }
    if (b.dataset.da === 'done') return exitDraw();
    buildDrawbar();
  });
}

