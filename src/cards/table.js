import { $, $$, esc } from '../core/util.js';
import { S, editingId, els, save } from '../core/store.js';
import { remember } from '../core/styles.js';
import { TYPES } from './types.js';
import { rebuildCard } from '../canvas/render.js';
import { caretEnd } from '../canvas/editing.js';

/* ================= extra card types ================= */
// --- table with simple formulas
export let tbFocus = null;
export const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
export const colIdx = s => [...s].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
export const toNum = x => { const n = parseFloat(String(x).replace(/[,\s$€£%]/g, '')); return isNaN(n) ? 0 : n; };
export function evalCell(rows, r, c, depth = 0) {
  const v = String(rows[r]?.[c] ?? '');
  if (!v.startsWith('=')) return v;
  if (depth > 30) return '#CYCLE';
  return evalFormula(v.slice(1), rows, depth);
}
export function evalFormula(expr, rows, depth) {
  let s = expr.toUpperCase();
  const ref = a => { const m = a.match(/^([A-Z]{1,3})(\d{1,5})$/); return m ? [+m[2] - 1, colIdx(m[1])] : null; };
  const val = a => { const p = ref(a); if (!p) return 0; const x = evalCell(rows, p[0], p[1], depth + 1); return String(x).startsWith('#') ? NaN : toNum(x); };
  const rangeVals = (a, b) => {
    const p = ref(a), q = ref(b); if (!p || !q) return [];
    const out = [];
    for (let r = Math.min(p[0], q[0]); r <= Math.max(p[0], q[0]); r++)
      for (let c = Math.min(p[1], q[1]); c <= Math.max(p[1], q[1]); c++) {
        if ((rows[r]?.[c] ?? '') === '') continue;
        out.push(val(colName(c) + (r + 1)));
      }
    return out;
  };
  for (let guard = 0; guard < 10 && /(SUM|AVERAGE|AVG|MIN|MAX|COUNT)\(/.test(s); guard++) {
    s = s.replace(/(SUM|AVERAGE|AVG|MIN|MAX|COUNT)\(([^()]*)\)/g, (m, fn, args) => {
      const v = args.split(',').flatMap(a => {
        a = a.trim(); if (!a) return [];
        if (a.includes(':')) { const [x, y] = a.split(':'); return rangeVals(x.trim(), y.trim()); }
        return ref(a) ? [val(a)] : [toNum(a)];
      });
      const sum = v.reduce((a, b) => a + b, 0);
      const r = { SUM: sum, AVERAGE: v.length ? sum / v.length : 0, AVG: v.length ? sum / v.length : 0, MIN: v.length ? Math.min(...v) : 0, MAX: v.length ? Math.max(...v) : 0, COUNT: v.length }[fn];
      return '(' + r + ')';
    });
  }
  s = s.replace(/\b[A-Z]{1,3}\d{1,5}\b/g, m => '(' + val(m) + ')');
  if (!/^[\d+\-*/().\se]*$/i.test(s) || /[a-z]{2}/i.test(s)) return '#ERR';
  try {
    const r = Function('"use strict";return (' + s + ');')();
    return Number.isFinite(r) ? String(Math.round(r * 1e8) / 1e8) : '#ERR';
  } catch { return '#ERR'; }
}

export function init() {
  TYPES.table = {
    label: 'Table', w: 380, fitH: true,
    init: () => ({ rows: [['Item', 'Qty', 'Price'], ['', '', ''], ['', '', ''], ['Total', '=SUM(B2:B3)', '=SUM(C2:C3)']], header: true }),
    html: it => {
      const rows = it.data.rows;
      return `<div class="tb-wrap"><table class="tb${it.data.header ? ' hdr' : ''}"><tr class="tb-letters">${rows[0].map((_, i) => `<th>${colName(i)}</th>`).join('')}</tr>` +
        rows.map((r, ri) => `<tr>${r.map((c, ci) => `<td data-r="${ri}" data-c="${ci}" data-raw="${esc(c)}" title="${colName(ci)}${ri + 1}"${String(c).startsWith('=') ? ' class="fx"' : ''}>${esc(evalCell(rows, ri, ci))}</td>`).join('')}</tr>`).join('') +
        `</table></div><div class="tb-tools" data-nodrag><button data-tb="row">+ Row</button><button data-tb="col">+ Column</button><button data-tb="delrow">− Row</button><button data-tb="delcol">− Column</button><button data-tb="hdr">Header row</button></div>`;
    },
    mount(el, it) {
      el.addEventListener('focusin', e => { const td = e.target.closest('td'); if (td) tbFocus = { id: it.id, r: +td.dataset.r, c: +td.dataset.c }; });
      $('.tb-tools', el).addEventListener('mousedown', e => e.preventDefault());
      $('.tb-tools', el).addEventListener('click', e => {
        const b = e.target.closest('[data-tb]'); if (!b) return;
        const cur = S.items[it.id], node = els.get(it.id);
        TYPES.table.read(node, cur);
        const rows = cur.data.rows;
        const f = tbFocus?.id === it.id ? { ...tbFocus } : { r: rows.length - 1, c: rows[0].length - 1 };
        switch (b.dataset.tb) {
          case 'row': rows.splice(f.r + 1, 0, rows[0].map(() => '')); f.r++; break;
          case 'col': rows.forEach(r => r.splice(f.c + 1, 0, '')); f.c++; break;
          case 'delrow': if (rows.length > 1) rows.splice(f.r, 1); f.r = Math.min(f.r, rows.length - 1); break;
          case 'delcol': if (rows[0].length > 1) rows.forEach(r => r.splice(f.c, 1)); f.c = Math.min(f.c, rows[0].length - 1); break;
          case 'hdr': cur.data.header = !cur.data.header; remember('table', { header: cur.data.header }); break;
        }
        save();
        const nel = rebuildCard(it.id);
        caretEnd($(`td[data-r="${f.r}"][data-c="${f.c}"]`, nel));
      });
      el.addEventListener('keydown', e => {
        if (editingId !== it.id) return;
        const td = e.target.closest('td'); if (!td) return;
        if (e.key !== 'Tab' && !(e.key === 'Enter' && !e.shiftKey)) return;
        e.preventDefault();
        const cur = S.items[it.id];
        TYPES.table.read(el, cur);
        const rows = cur.data.rows;
        let r = +td.dataset.r, c = +td.dataset.c;
        if (e.key === 'Tab') {
          if (e.shiftKey) { c--; if (c < 0) { r = Math.max(0, r - 1); c = rows[0].length - 1; } }
          else { c++; if (c >= rows[0].length) { c = 0; r++; } }
        } else r++;
        let node = els.get(it.id);
        if (r >= rows.length) { rows.push(rows[0].map(() => '')); save(); node = rebuildCard(it.id); }
        caretEnd($(`td[data-r="${r}"][data-c="${c}"]`, node));
      });
    },
    edit: el => { $$('td', el).forEach(td => { td.textContent = td.dataset.raw; td.contentEditable = 'true'; }); return $('td', el); },
    read: (el, it) => { $$('td', el).forEach(td => { const r = +td.dataset.r, c = +td.dataset.c; if (it.data.rows[r]) { it.data.rows[r][c] = td.innerText.replace(/\n/g, ' ').trim(); td.dataset.raw = it.data.rows[r][c]; } }); },
    stop: () => true,
    text: it => it.data.rows.flat().join(' '),
  };
}

