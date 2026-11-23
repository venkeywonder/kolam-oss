/*
 * Field-level merging of concurrent edits to one record, the same rules as server/src/Merge.php.
 * Fields are top-level keys ("x", "color") and the keys of data ("data.html", "data.tasks").
 * - objects merge key by key;
 * - lists of objects with ids (to-do tasks) merge by id, keeping both sides' additions and removals;
 * - lists both sides only appended to keep both sides' additions;
 * - lists of the same length (table rows and cells) merge position by position;
 * - anything else: this side wins. Rich text is merged character by character with Yjs (ytext.js).
 */

export function eq(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(k => Object.hasOwn(b, k) && eq(a[k], b[k]));
}

const isMap = x => !!x && typeof x === 'object' && !Array.isArray(x);
const hasIds = l => { const s = new Set(); return l.every(e => isMap(e) && typeof e.id === 'string' && !s.has(e.id) && s.add(e.id)); };

/** Fields that differ between two versions of a record. */
export function fieldsOf(a, b) {
  const out = new Set();
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'data' && isMap(a.data) && isMap(b.data)) {
      for (const d of new Set([...Object.keys(a.data), ...Object.keys(b.data)])) if (!eq(a.data[d], b.data[d])) out.add('data.' + d);
    } else if (!eq(a[k], b[k])) out.add(k);
  }
  return out;
}

const at = (r, p) => { const [a, b] = p.split('.'); return b === undefined ? r?.[a] : r?.data?.[b]; };

/** What a push sends besides the record: the changed fields, and the starting value of those holding objects or lists. */
export function patchOf(base, mine) {
  const f = [...fieldsOf(base, mine)], b = {};
  for (const p of f) { const v = at(base, p); if (v && typeof v === 'object') b[p] = v; }
  return { f, b };
}

export function merge3(b, m, t) {
  if (eq(m, b)) return t;
  if (eq(t, b) || eq(m, t)) return m;
  if (isMap(b) && isMap(m) && isMap(t)) {
    const out = {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(m)])) {
      const v = merge3(b[k], m[k], t[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (Array.isArray(b) && Array.isArray(m) && Array.isArray(t)) {
    if (hasIds(b) && hasIds(m) && hasIds(t)) return byId(b, m, t);
    const n = b.length;
    if (eq(m.slice(0, n), b) && eq(t.slice(0, n), b)) return [...t, ...m.slice(n)];
    if (m.length === n && t.length === n) return b.map((x, i) => merge3(x, m[i], t[i]));
  }
  return m;
}

function byId(b, m, t) {
  const B = new Map(b.map(e => [e.id, e])), M = new Map(m.map(e => [e.id, e])), T = new Map(t.map(e => [e.id, e]));
  // theirs' order wins, unless only this side moved the elements both sides still have
  const seq = l => l.filter(e => B.has(e.id) && M.has(e.id) && T.has(e.id)).map(e => e.id).join();
  const mineOrder = seq(m) !== seq(b) && seq(t) === seq(b);
  const [lead, Other, other, Lead] = mineOrder ? [m, T, t, M] : [t, M, m, T];
  const out = [];
  for (const e of lead) {
    if (B.has(e.id) && !Other.has(e.id)) continue;   // removed on the other side
    out.push(M.has(e.id) && T.has(e.id) ? merge3(B.get(e.id), M.get(e.id), T.get(e.id)) : e);
  }
  // added on the other side: after the element it follows there, or first
  let prev = null;
  for (const e of other) {
    if (!B.has(e.id) && !Lead.has(e.id)) out.splice(prev === null ? 0 : out.findIndex(o => o.id === prev) + 1, 0, e);
    if (out.some(o => o.id === e.id)) prev = e.id;
  }
  return out;
}

/** Merge two versions of a whole record that both started from base. */
export function mergeRecord(base, mine, theirs) {
  if (!base) return mine;
  const out = structuredClone(theirs);
  for (const p of fieldsOf(base, mine)) {
    const [a, k] = p.split('.');
    const v = merge3(at(base, p), at(mine, p), at(theirs, p));
    if (k === undefined) { if (v === undefined) delete out[a]; else out[a] = v; }
    else { out.data = isMap(out.data) ? out.data : {}; if (v === undefined) delete out.data[k]; else out.data[k] = v; }
  }
  return out;
}
