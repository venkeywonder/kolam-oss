/*
 * Connector style options shown in the contextual toolbar when a line is selected:
 * route (straight / curved / elbow), arrowheads, head shape, thickness and dash pattern.
 */
import { icon } from './icons.js';
import { S, checkpoint, save } from '../core/store.js';
import { endsOf, lineGeom, routeOf, widthOf } from '../canvas/lines.js';
import { remember } from '../core/styles.js';

const line = (w, dash = '') => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 12h18" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"${dash}/></svg>`;
const ROUTES = [['straight', 'Straight', 'straight'], ['curved', 'Curved', 'routeCurved'], ['elbow', 'Elbow', 'routeElbow']];
const ENDS = [['none', 'None', 'endsNone'], ['start', 'Start', 'endsStart'], ['end', 'End', 'arrow'], ['both', 'Both', 'endsBoth']];
const HEADS = [['triangle', 'Triangle', 'headTriangle'], ['open', 'Open', 'headOpen'], ['dot', 'Dot', 'headDot'], ['diamond', 'Diamond', 'headDiamond']];
const WIDTHS = [[1, 'Thin'], [2, 'Regular'], [3, 'Medium'], [5, 'Bold']];
const DASHES = [['solid', 'Solid', ''], ['dashed', 'Dashed', ' stroke-dasharray="5 4"'], ['dotted', 'Dotted', ' stroke-dasharray="0 4.5"']];

// toolbar button → popover sections; each option is [value, label, art]
export const LINE_POPS = {
  ltype: [{ key: 'route', title: 'Line type', opts: ROUTES.map(([v, l, i]) => [v, l, icon(i, 22)]) }],
  lends: [
    { key: 'ends', title: 'Arrowheads', opts: ENDS.map(([v, l, i]) => [v, l, icon(i, 22)]) },
    { key: 'head', title: 'Head shape', opts: HEADS.map(([v, l, i]) => [v, l, icon(i, 22)]) },
  ],
  lstyle: [
    { key: 'width', title: 'Thickness', opts: WIDTHS.map(([v, l]) => [String(v), l, line(v)]) },
    { key: 'dash', title: 'Pattern', opts: DASHES.map(([v, l, d]) => [v, l, line(2, d)]) },
  ],
};

export function lineOpt(ln, key) {
  switch (key) {
    case 'route': return routeOf(ln);
    case 'ends': return endsOf(ln);
    case 'head': return ln.head || 'triangle';
    case 'width': return String(widthOf(ln));
    case 'dash': return ln.dash || 'solid';
  }
}
// icon for the toolbar buttons that mirror the current value
export const lineGlyph = (act, ln) =>
  act === 'ltype' ? ROUTES.find(r => r[0] === routeOf(ln))[2]
  : act === 'lends' ? ENDS.find(r => r[0] === endsOf(ln))[2]
  : null;

export function linePopHtml(act, ln) {
  return LINE_POPS[act].map(s => `<div class="tp-head">${s.title}</div><div class="tp-row">` +
    s.opts.map(([v, l, art]) => `<button data-k="${s.key}" data-v="${v}" class="${lineOpt(ln, s.key) === v ? 'on' : ''}" title="${l}">${art}<span>${l}</span></button>`).join('') +
    '</div>').join('');
}

/** Apply one option to a line; returns false when nothing changed. */
export function setLineOpt(lid, key, v) {
  const ln = S.lines[lid];
  if (!ln || lineOpt(ln, key) === v) return false;
  checkpoint();
  switch (key) {
    case 'route': {
      // a curve needs a visible bend to start from; straight and elbow start centred
      const G = v === 'curved' ? lineGeom(ln) : null;
      ln.route = v;
      ln.bend = G ? Math.round(Math.max(40, G.len * 0.2)) : 0;
      break;
    }
    case 'ends': ln.arrow = v === 'end' || v === 'both'; ln.arrowStart = v === 'start' || v === 'both'; break;
    case 'head': ln.head = v; break;
    case 'width': ln.width = +v; break;
    case 'dash': ln.dash = v; break;
  }
  // new lines use what you picked last
  remember('line', key === 'ends' ? { arrow: !!ln.arrow, arrowStart: !!ln.arrowStart } : { [key]: key === 'width' ? +v : v });
  save();
  return true;
}
/** Point the arrowheads the other way (only meaningful with a single arrowhead). */
export const canReverse = ln => !!ln.arrow !== !!ln.arrowStart;
export function reverseLine(lid) {
  const ln = S.lines[lid]; if (!ln || !canReverse(ln)) return;
  checkpoint();
  [ln.arrow, ln.arrowStart] = [!!ln.arrowStart, !!ln.arrow];
  save();
}
