import { esc } from '../core/util.js';
import { pal } from '../core/palette.js';
import { handlesSvg, linesSvg } from '../core/dom.js';
import { S, cur, selLine } from '../core/store.js';
import { V, itemRect } from './viewport.js';
import { lineCol } from '../ui/theme.js';

/* ---------- line style ----------
 * route: 'straight' | 'curved' | 'elbow' (older lines have none: a bend makes them curved)
 * arrow / arrowStart: arrowhead at the b / a end
 * head: 'triangle' | 'open' | 'dot' | 'diamond'
 * width: stroke width in px; dash: 'solid' | 'dashed' | 'dotted'
 * Ends: { x, y } free point, { item } attached to a card automatically (nearest edge),
 *       or { item, side, t } pinned to a point on one side, t = 0..1 along it (left→right, top→bottom).
 */
export const routeOf = ln => ln.route || (ln.bend ? 'curved' : 'straight');
export const widthOf = ln => ln.width || 2;
export const endsOf = ln => ln.arrow ? (ln.arrowStart ? 'both' : 'end') : (ln.arrowStart ? 'start' : 'none');
const SEL_COLOR = '#4f5bd5';
const ELBOW_RADIUS = 10;
const STUB = 14; // how far an elbow line travels straight out of a side before turning
export const SIDES = ['top', 'right', 'bottom', 'left'];
const SIDE_DIR = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- geometry ---------- */
/** Point on a card side, `pad` px outside the edge. */
export function portPoint(r, side, t, pad = 0) {
  switch (side) {
    case 'top': return { x: r.x + t * r.w, y: r.y - pad };
    case 'bottom': return { x: r.x + t * r.w, y: r.y + r.h + pad };
    case 'left': return { x: r.x - pad, y: r.y + t * r.h };
    default: return { x: r.x + r.w + pad, y: r.y + t * r.h };
  }
}
function resolveEnd(e, pad) {
  if (!e.item) return { r: null, c: { x: e.x, y: e.y } };
  const r = itemRect(e.item); if (!r) return null;
  const end = { r, c: { x: r.x + r.w / 2, y: r.y + r.h / 2 } };
  if (SIDE_DIR[e.side]) { end.pin = portPoint(r, e.side, clamp(e.t ?? 0.5, 0, 1), pad); end.dir = SIDE_DIR[e.side]; }
  return end;
}
export function lineGeom(ln) {
  // gap between a card and the line end, wide enough for the arrowhead tip
  const pad = 4 + 1.5 * widthOf(ln);
  const ea = resolveEnd(ln.a, pad), eb = resolveEnd(ln.b, pad);
  if (!ea || !eb) return null;
  const route = routeOf(ln);
  if (route === 'elbow') return elbowGeom(ln, ea, eb, pad);
  // pinned ends use their point; automatic ends aim from the card centre and are clipped to its edge
  const pa = ea.pin || ea.c, pb = eb.pin || eb.c;
  const M = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
  const dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.hypot(dx, dy) || 1;
  const n = { x: -dy / len, y: dx / len }, bend = route === 'curved' ? ln.bend || 0 : 0;
  const C = { x: M.x + n.x * bend, y: M.y + n.y * bend };
  const A = ea.r && !ea.pin ? clipRect(ea.r, pa, bend ? C : pb, pad) : pa;
  const B = eb.r && !eb.pin ? clipRect(eb.r, pb, bend ? C : pa, pad) : pb;
  const H = { x: M.x + n.x * bend / 2, y: M.y + n.y * bend / 2 };
  const P = { x: 0.25 * A.x + 0.5 * C.x + 0.25 * B.x, y: 0.25 * A.y + 0.5 * C.y + 0.25 * B.y };
  const d = bend ? `M${A.x},${A.y} Q${C.x},${C.y} ${B.x},${B.y}` : `M${A.x},${A.y} L${B.x},${B.y}`;
  return { A, B, H, P, d, len, bendAt: p => 2 * ((p.x - M.x) * n.x + (p.y - M.y) * n.y) };
}
// Orthogonal route. Pinned ends leave through their side; automatic ends use the side facing the other end.
function elbowGeom(ln, ea, eb, pad) {
  const box = e => e.pin ? { x: e.pin.x, y: e.pin.y, w: 0, h: 0 }
    : e.r ? { x: e.r.x - pad, y: e.r.y - pad, w: e.r.w + 2 * pad, h: e.r.h + 2 * pad } : { x: e.c.x, y: e.c.y, w: 0, h: 0 };
  const auto = (e, other) => {
    const a = box(e), o = box(other), oc = other.pin || other.c;
    const gapX = Math.max(o.x - (a.x + a.w), a.x - (o.x + o.w));
    const gapY = Math.max(o.y - (a.y + a.h), a.y - (o.y + o.h));
    if (gapX >= gapY) { const s = Math.sign(oc.x - e.c.x) || 1; return { P: { x: e.c.x + s * a.w / 2, y: e.c.y }, d: { x: s, y: 0 } }; }
    const s = Math.sign(oc.y - e.c.y) || 1; return { P: { x: e.c.x, y: e.c.y + s * a.h / 2 }, d: { x: 0, y: s } };
  };
  const A = ea.pin ? { P: ea.pin, d: ea.dir } : auto(ea, eb);
  const B = eb.pin ? { P: eb.pin, d: eb.dir } : auto(eb, ea);
  const cardBox = e => e.r && { x: e.r.x - pad, y: e.r.y - pad, w: e.r.w + 2 * pad, h: e.r.h + 2 * pad };
  const R = orthoRoute(A.P, A.d, B.P, B.d, ln.bend || 0, cardBox(ea), cardBox(eb));
  return { A: A.P, B: B.P, H: R.H, P: R.H, d: roundedPath(R.pts, ELBOW_RADIUS), len: Math.hypot(eb.c.x - ea.c.x, eb.c.y - ea.c.y), bendAt: R.bendAt };
}
// A leaves along direction da, B is entered against db (both unit axis vectors pointing out of their card).
// ra/rb: padded card boxes to route around, when known. bend shifts the movable middle segment.
function orthoRoute(A, da, B, db, bend, ra, rb) {
  if (da.y && db.y) {
    // both vertical: solve the horizontal case with x and y swapped
    const sw = p => ({ x: p.y, y: p.x }), swr = r => r && { x: r.y, y: r.x, w: r.h, h: r.w };
    const R = orthoRoute(sw(A), sw(da), sw(B), sw(db), bend, swr(ra), swr(rb));
    return { pts: R.pts.map(sw), H: sw(R.H), bendAt: p => R.bendAt(sw(p)) };
  }
  if (da.y) { const R = orthoRoute(B, db, A, da, bend, rb, ra); return { ...R, pts: R.pts.slice().reverse() }; }
  if (db.y) {
    // horizontal out of A, vertical into B: one corner when it lies ahead of both ends, else step out first
    const C = { x: B.x, y: A.y };
    if ((C.x - A.x) * da.x > 0 && (C.y - B.y) * db.y > 0) return { pts: [A, C, B], H: C, bendAt: () => 0 };
    const a0 = { x: A.x + da.x * STUB, y: A.y }, b0 = { x: B.x, y: B.y + db.y * STUB };
    return { pts: [A, a0, { x: a0.x, y: b0.y }, b0, B], H: { x: a0.x, y: (a0.y + b0.y) / 2 }, bendAt: () => 0 };
  }
  // both horizontal: a vertical middle segment at x, kept ahead of both sides when possible
  const range = stub => {
    let lo = -Infinity, hi = Infinity;
    for (const [P, d] of [[A, da], [B, db]]) { const x = P.x + d.x * stub; if (d.x > 0) lo = Math.max(lo, x); else hi = Math.min(hi, x); }
    return [lo, hi];
  };
  let [lo, hi] = range(STUB);
  if (lo > hi) [lo, hi] = range(0);
  if (lo <= hi) {
    const base = clamp((A.x + B.x) / 2, lo, hi), mx = clamp(base + bend, lo, hi);
    return { pts: [A, { x: mx, y: A.y }, { x: mx, y: B.y }, B], H: { x: mx, y: (A.y + B.y) / 2 }, bendAt: p => p.x - base };
  }
  // sides face away from each other: step out of both and run a horizontal segment between or around the cards
  const ax = A.x + da.x * STUB, bx = B.x + db.x * STUB;
  let base;
  if (ra && rb && ra.y + ra.h < rb.y) base = (ra.y + ra.h + rb.y) / 2;
  else if (ra && rb && rb.y + rb.h < ra.y) base = (rb.y + rb.h + ra.y) / 2;
  else base = Math.max(ra ? ra.y + ra.h : A.y, rb ? rb.y + rb.h : B.y) + STUB;
  const my = base + bend;
  return {
    pts: [A, { x: ax, y: A.y }, { x: ax, y: my }, { x: bx, y: my }, { x: bx, y: B.y }, B],
    H: { x: (ax + bx) / 2, y: my }, bendAt: p => p.y - base,
  };
}
function roundedPath(pts, r) {
  const p = pts.filter((q, i) => !i || q.x !== pts[i - 1].x || q.y !== pts[i - 1].y);
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], c = p[i], b = p[i + 1];
    const l1 = Math.hypot(c.x - a.x, c.y - a.y), l2 = Math.hypot(b.x - c.x, b.y - c.y);
    const k = Math.min(r, l1 / 2, l2 / 2);
    d += ` L${c.x + (a.x - c.x) / l1 * k},${c.y + (a.y - c.y) / l1 * k} Q${c.x},${c.y} ${c.x + (b.x - c.x) / l2 * k},${c.y + (b.y - c.y) / l2 * k}`;
  }
  const z = p[p.length - 1];
  return d + ` L${z.x},${z.y}`;
}
export function clipRect(r, c, t, pad) {
  const dx = t.x - c.x, dy = t.y - c.y;
  if (!dx && !dy) return c;
  const hw = r.w / 2 + pad, hh = r.h / 2 + pad;
  const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  if (s >= 1) return c;
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/* ---------- rendering ---------- */
// Arrowhead markers in px (userSpaceOnUse) so heads grow gently with the stroke; tips sit 1.5×width past the path end
// so the round line cap stays hidden under the head.
function marker(id, head, w, col) {
  const s = 9 + 2.5 * w, h = s / 2, t = 1.5 * w;
  let shape, refX;
  if (head === 'open') {
    const i = Math.max(w, 1.5) / 2 + 0.5;
    shape = `<path d="M${i} ${i}L${s - i} ${h}L${i} ${s - i}" fill="none" stroke="${col}" stroke-width="${Math.max(w, 1.5)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    refX = s - i;
  } else if (head === 'dot') {
    const r = s * 0.32;
    shape = `<circle cx="${h}" cy="${h}" r="${r}" fill="${col}"/>`;
    refX = h + r - t;
  } else if (head === 'diamond') {
    shape = `<path d="M0 ${h}L${h} ${s * 0.15}L${s} ${h}L${h} ${s * 0.85}z" fill="${col}"/>`;
    refX = s - t;
  } else {
    shape = `<path d="M0 0L${s} ${h}L0 ${s}z" fill="${col}"/>`;
    refX = s - t;
  }
  return `<marker id="${id}" viewBox="0 0 ${s} ${s}" refX="${refX}" refY="${h}" markerWidth="${s}" markerHeight="${s}" markerUnits="userSpaceOnUse" orient="auto-start-reverse">${shape}</marker>`;
}
function dashOf(ln, w) {
  const u = Math.max(w, 1.5);
  if (ln.dash === 'dashed') return ` stroke-dasharray="${3 * u} ${3.5 * u}"`;
  if (ln.dash === 'dotted') return ` stroke-dasharray="0 ${2.5 * u}"`;
  return '';
}
export function renderLines() {
  let defs = '', g = '';
  for (const ln of Object.values(S.lines)) {
    if (ln.board !== cur) continue;
    const G = lineGeom(ln); if (!G) continue;
    const isSel = selLine === ln.id, col = lineCol(pal(ln.color)), w = widthOf(ln);
    let mk = '';
    if (ln.arrow || ln.arrowStart) {
      const id = `ah-${ln.id}`;
      defs += marker(id, ln.head, w, isSel ? SEL_COLOR : col);
      if (ln.arrowStart) mk += ` marker-start="url(#${id})"`;
      if (ln.arrow) mk += ` marker-end="url(#${id})"`;
    }
    const lab = ln.label ? `<text class="ln-label" x="${G.P.x}" y="${G.P.y}" text-anchor="middle" dominant-baseline="middle">${esc(ln.label)}</text>` : '';
    g += `<g class="ln${isSel ? ' sel' : ''}" data-lid="${ln.id}"><path class="hit" d="${G.d}"/><path class="vis" d="${G.d}" stroke="${col}" style="--w:${w}px"${dashOf(ln, w)}${mk}/>${lab}</g>`;
  }
  linesSvg.innerHTML = `<defs>${defs}</defs><g transform="translate(50000,50000)">${g}</g>`;
  renderHandles();
}
// While a line end is dragged over a card, its side midpoints are shown as connection points.
let portHint = null;
export function setPortHint(id) { portHint = id; }
export function renderHandles() {
  if (!selLine || !S.lines[selLine]) { handlesSvg.innerHTML = ''; return; }
  const ln = S.lines[selLine], G = lineGeom(ln); if (!G) { handlesSvg.innerHTML = ''; return; }
  const z = V().z, r = 6 / z, sw = 2 / z;
  let ports = '';
  const hr = portHint && itemRect(portHint);
  if (hr) {
    const pinned = [ln.a, ln.b].find(e => e.item === portHint && e.side && (e.t ?? 0.5) === 0.5)?.side;
    ports = SIDES.map(s => { const p = portPoint(hr, s, 0.5); return `<circle class="port${s === pinned ? ' on' : ''}" cx="${p.x}" cy="${p.y}" r="${4 / z}" stroke-width="${1.5 / z}"/>`; }).join('');
  }
  handlesSvg.innerHTML = `<g transform="translate(50000,50000)">${ports}` +
    `<circle data-h="a" cx="${G.A.x}" cy="${G.A.y}" r="${r}" stroke-width="${sw}"/>` +
    `<circle data-h="b" cx="${G.B.x}" cy="${G.B.y}" r="${r}" stroke-width="${sw}"/>` +
    `<circle class="mid" data-h="m" cx="${G.H.x}" cy="${G.H.y}" r="${r * 0.8}" stroke-width="${sw}"/></g>`;
}
