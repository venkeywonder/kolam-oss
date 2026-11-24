import { uid } from '../core/util.js';
import { emptyHint } from '../core/dom.js';
import { S, checkpoint, cur, save } from '../core/store.js';
import { fit, viewCenter } from '../canvas/viewport.js';
import { childrenOf, itemsOf, maxZ } from '../core/model.js';
import { TYPES } from '../cards/types.js';
import { render } from '../canvas/render.js';
import { exitEdit } from '../canvas/editing.js';
import { closeModal, openModal } from '../ui/modal.js';
// shared with TemplateTools.php: the data (name/desc/colour/cards) lives in templates.json, this file only adds the
// thumbnail SVGs and interprets the build steps. Fetched in the background so the app never waits for it.
const TEMPLATES = [];
const loaded = fetch(new URL('../templates.json', import.meta.url)).then(r => r.json()).then(list => {
  TEMPLATES.push(...list.map(t => ({
    id: t.id, name: t.name, desc: t.desc, c: t.color,
    art(c) { return ART[t.id](c); },
    build(k) { runBuild(t.build, k); },
  })));
});

/* ================= templates ================= */

const ART = {
  mood: c => `<rect width="120" height="75" rx="8" fill="var(--field)"/><rect x="6" y="9" width="44" height="34" rx="4" fill="${c}" opacity=".15" stroke="${c}" stroke-width="2"/><path d="M12 36 L24 22 L33 32 L40 24 L46 36 Z" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/><circle cx="40" cy="16" r="3" fill="${c}"/><rect x="54" y="9" width="26" height="34" rx="4" fill="var(--muted)" opacity=".18"/><rect x="6" y="49" width="60" height="4" rx="2" fill="var(--muted)" opacity=".5"/><rect x="6" y="57" width="42" height="4" rx="2" fill="var(--muted)" opacity=".35"/><circle cx="92" cy="18" r="7" fill="#264653"/><circle cx="108" cy="18" r="7" fill="#2a9d8f"/><circle cx="92" cy="34" r="7" fill="#e9c46a"/><circle cx="108" cy="34" r="7" fill="#f4a261"/>`,
  kanban: c => `<rect width="120" height="75" rx="8" fill="var(--field)"/><rect x="6" y="9" width="24" height="58" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="9" y="15" width="18" height="10" rx="2" fill="var(--muted)" opacity=".32"/><rect x="9" y="29" width="18" height="10" rx="2" fill="var(--muted)" opacity=".18"/><rect x="33" y="9" width="24" height="58" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="36" y="15" width="18" height="10" rx="2" fill="var(--muted)" opacity=".3"/><rect x="60" y="9" width="24" height="58" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="63" y="15" width="18" height="10" rx="2" fill="var(--muted)" opacity=".18"/><rect x="87" y="9" width="24" height="58" rx="3" fill="none" stroke="${c}" stroke-width="2"/><rect x="90" y="15" width="18" height="10" rx="2" fill="${c}" opacity=".32"/>`,
  mind: c => `<rect width="120" height="75" rx="8" fill="var(--field)"/><line x1="60" y1="38" x2="60" y2="11" stroke="${c}" stroke-width="1.5" opacity=".55"/><line x1="60" y1="38" x2="83" y2="24" stroke="${c}" stroke-width="1.5" opacity=".55"/><line x1="60" y1="38" x2="83" y2="52" stroke="${c}" stroke-width="1.5" opacity=".55"/><line x1="60" y1="38" x2="60" y2="65" stroke="${c}" stroke-width="1.5" opacity=".55"/><line x1="60" y1="38" x2="37" y2="52" stroke="${c}" stroke-width="1.5" opacity=".55"/><line x1="60" y1="38" x2="37" y2="24" stroke="${c}" stroke-width="1.5" opacity=".55"/><circle cx="60" cy="11" r="5" fill="var(--muted)" opacity=".55"/><circle cx="83" cy="24" r="5" fill="var(--muted)" opacity=".55"/><circle cx="83" cy="52" r="5" fill="var(--muted)" opacity=".55"/><circle cx="60" cy="65" r="5" fill="var(--muted)" opacity=".55"/><circle cx="37" cy="52" r="5" fill="var(--muted)" opacity=".55"/><circle cx="37" cy="24" r="5" fill="var(--muted)" opacity=".55"/><circle cx="60" cy="38" r="11" fill="${c}"/>`,
  story: c => `<rect width="120" height="75" rx="8" fill="var(--field)"/><rect x="6" y="10" width="24" height="34" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><path d="M10 38 L18 26 L24 34 L28 28 L30 38 Z" fill="${c}" opacity=".3"/><rect x="6" y="48" width="20" height="3" rx="1.5" fill="var(--muted)" opacity=".5"/><rect x="33" y="10" width="24" height="34" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><path d="M37 38 L45 26 L51 34 L55 28 L57 38 Z" fill="${c}" opacity=".3"/><rect x="33" y="48" width="20" height="3" rx="1.5" fill="var(--muted)" opacity=".5"/><rect x="60" y="10" width="24" height="34" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><path d="M64 38 L72 26 L78 34 L82 28 L84 38 Z" fill="${c}" opacity=".3"/><rect x="60" y="48" width="20" height="3" rx="1.5" fill="var(--muted)" opacity=".5"/><rect x="87" y="10" width="24" height="34" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><path d="M91 38 L99 26 L105 34 L109 28 L111 38 Z" fill="${c}" opacity=".3"/><rect x="87" y="48" width="20" height="3" rx="1.5" fill="var(--muted)" opacity=".5"/><path d="M30 27 L33 27" stroke="${c}" stroke-width="2"/><path d="M57 27 L60 27" stroke="${c}" stroke-width="2"/><path d="M84 27 L87 27" stroke="${c}" stroke-width="2"/>`,
  brain: c => `<rect width="120" height="75" rx="8" fill="var(--field)"/><rect x="6" y="9" width="108" height="13" rx="3" fill="${c}" opacity=".15" stroke="${c}" stroke-width="1.5"/><rect x="6" y="28" width="33" height="26" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="43" y="28" width="33" height="26" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="80" y="28" width="33" height="26" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="9" y="33" width="27" height="6" rx="2" fill="var(--muted)" opacity=".4"/><rect x="46" y="33" width="27" height="6" rx="2" fill="var(--muted)" opacity=".4"/><rect x="83" y="33" width="27" height="6" rx="2" fill="var(--muted)" opacity=".4"/><rect x="6" y="60" width="9" height="9" rx="2" fill="none" stroke="${c}" stroke-width="1.5"/><rect x="33" y="60" width="9" height="9" rx="2" fill="none" stroke="${c}" stroke-width="1.5"/><rect x="60" y="60" width="9" height="9" rx="2" fill="none" stroke="${c}" stroke-width="1.5"/>`,
  week: c => `<rect width="120" height="75" rx="8" fill="var(--field)"/><rect x="6" y="9" width="28" height="58" rx="3" fill="${c}" opacity=".12" stroke="${c}" stroke-width="2"/><rect x="9" y="15" width="22" height="4" rx="2" fill="${c}" opacity=".55"/><rect x="9" y="23" width="22" height="4" rx="2" fill="${c}" opacity=".4"/><rect x="9" y="31" width="22" height="4" rx="2" fill="${c}" opacity=".3"/>${[0, 1, 2, 3, 4, 5].map(i => `<rect x="${38 + i * 13}" y="9" width="11" height="58" rx="2" fill="none" stroke="var(--line)" stroke-width="1.5"/><rect x="${40 + i * 13}" y="15" width="7" height="6" rx="1.5" fill="var(--muted)" opacity=".4"/>`).join('')}`,
  meeting: c => `<rect width="120" height="75" rx="8" fill="var(--field)"/><rect x="6" y="9" width="26" height="58" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="9" y="15" width="20" height="4" rx="2" fill="var(--muted)" opacity=".45"/><rect x="9" y="24" width="20" height="4" rx="2" fill="var(--muted)" opacity=".35"/><rect x="9" y="33" width="20" height="4" rx="2" fill="var(--muted)" opacity=".3"/><rect x="36" y="9" width="36" height="58" rx="3" fill="var(--muted)" opacity=".08" stroke="var(--line)" stroke-width="2"/><rect x="40" y="15" width="28" height="4" rx="2" fill="var(--muted)" opacity=".4"/><rect x="40" y="23" width="22" height="4" rx="2" fill="var(--muted)" opacity=".3"/><rect x="40" y="31" width="25" height="4" rx="2" fill="var(--muted)" opacity=".3"/><rect x="76" y="9" width="38" height="26" rx="3" fill="${c}" opacity=".15" stroke="${c}" stroke-width="2"/><rect x="80" y="15" width="28" height="4" rx="2" fill="${c}" opacity=".6"/><rect x="80" y="23" width="20" height="4" rx="2" fill="${c}" opacity=".5"/><rect x="76" y="39" width="38" height="28" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="80" y="45" width="7" height="7" rx="1.5" fill="none" stroke="${c}" stroke-width="1.5"/><rect x="90" y="47" width="18" height="4" rx="2" fill="var(--muted)" opacity=".4"/><rect x="80" y="56" width="7" height="7" rx="1.5" fill="none" stroke="${c}" stroke-width="1.5"/><rect x="90" y="58" width="18" height="4" rx="2" fill="var(--muted)" opacity=".4"/>`,
  research: c => `<rect width="120" height="75" rx="8" fill="var(--field)"/><rect x="6" y="9" width="33" height="42" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="43" y="9" width="33" height="42" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="80" y="9" width="33" height="42" rx="3" fill="${c}" opacity=".12" stroke="${c}" stroke-width="2"/><rect x="9" y="14" width="27" height="5" rx="2" fill="var(--muted)" opacity=".4"/><rect x="9" y="22" width="20" height="5" rx="2" fill="var(--muted)" opacity=".3"/><rect x="46" y="14" width="27" height="5" rx="2" fill="var(--muted)" opacity=".4"/><rect x="46" y="22" width="18" height="5" rx="2" fill="var(--muted)" opacity=".3"/><rect x="83" y="14" width="27" height="5" rx="2" fill="${c}" opacity=".6"/><rect x="83" y="22" width="20" height="5" rx="2" fill="${c}" opacity=".45"/><rect x="6" y="57" width="108" height="12" rx="3" fill="${c}" opacity=".1" stroke="${c}" stroke-width="1.5"/><circle cx="14" cy="63" r="4" fill="none" stroke="${c}" stroke-width="1.5"/><rect x="22" y="61" width="30" height="4" rx="2" fill="var(--muted)" opacity=".5"/><circle cx="64" cy="63" r="4" fill="none" stroke="${c}" stroke-width="1.5"/><rect x="72" y="61" width="30" height="4" rx="2" fill="var(--muted)" opacity=".5"/>`,
  writing: c => `<rect width="120" height="75" rx="8" fill="var(--field)"/><rect x="6" y="9" width="44" height="58" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="10" y="15" width="26" height="6" rx="2" fill="var(--muted)" opacity=".55"/><rect x="10" y="26" width="36" height="4" rx="2" fill="var(--muted)" opacity=".32"/><rect x="10" y="34" width="36" height="4" rx="2" fill="var(--muted)" opacity=".32"/><rect x="10" y="42" width="24" height="4" rx="2" fill="var(--muted)" opacity=".32"/><rect x="56" y="9" width="28" height="58" rx="3" fill="none" stroke="var(--line)" stroke-width="2"/><rect x="60" y="15" width="20" height="4" rx="2" fill="var(--muted)" opacity=".4"/><rect x="60" y="24" width="20" height="4" rx="2" fill="var(--muted)" opacity=".4"/><rect x="60" y="33" width="20" height="4" rx="2" fill="var(--muted)" opacity=".4"/><rect x="90" y="9" width="24" height="58" rx="3" fill="${c}" opacity=".14" stroke="${c}" stroke-width="2"/><rect x="94" y="15" width="16" height="4" rx="2" fill="${c}" opacity=".6"/><rect x="94" y="23" width="16" height="4" rx="2" fill="${c}" opacity=".45"/>`,
};

// one formatted date, substituted into {{date}} in template html (matches the meeting template's old client-side format)
const tplDate = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/** Runs one template's build steps (from templates.json) against a kit of cards already placed at `origin`. */
function runBuild(steps, k) {
  const refs = {};
  let prevCol = null;
  const fill = s => typeof s === 'string' ? s.replace('{{date}}', tplDate()) : s;
  for (const s of steps) {
    const col = s.col === '$prev' ? prevCol : (s.col ? refs[s.col] : null);
    let made;
    switch (s.op) {
      case 'note': made = k.add('note', s.x, s.y, { html: fill(s.html) }, { w: s.w, color: s.color || null }); break;
      case 'doc': made = k.add('doc', s.x, s.y, { title: s.title, html: fill(s.html) }, { w: s.w, color: s.color || null }); break;
      case 'swatch': made = k.add('swatch', s.x, s.y, { hex: s.hex }); break;
      case 'todo': made = k.add('todo', s.x, s.y, { title: s.title, tasks: k.tasks(s.tasks) }, { w: s.w, color: s.color || null }); break;
      case 'column':
        made = k.add('column', s.x, s.y, { title: s.title }, { w: s.w, color: s.color || null });
        prevCol = made;
        break;
      case 'inCol': {
        const data = s.type === 'todo' ? { title: s.title, tasks: k.tasks(s.tasks) } : { html: fill(s.html) };
        const extra = s.h ? { h: s.h } : {};
        made = k.inCol(col, s.type, data, extra);
        break;
      }
      case 'line': k.line(refs[s.from], refs[s.to], { arrow: s.arrow !== false, color: s.color || null }); break;
    }
    if (s.ref && made) refs[s.ref] = made;
  }
}

export function tplKit(origin) {
  let z = maxZ();
  const add = (type, x, y, data = {}, extra = {}) => {
    const T = TYPES[type];
    const it = { id: uid(), board: cur, type, x: Math.round(origin.x + x), y: Math.round(origin.y + y), w: extra.w || T.w, z: ++z, col: null, order: 0, color: null, data: { ...(T.init ? T.init() : {}), ...data }, ...extra };
    if (T.h && !it.h) it.h = T.h;
    if (type === 'board') { const b = { id: uid(), title: data.title || 'Board', parent: cur }; S.boards[b.id] = b; it.data = { target: b.id, emoji: data.emoji }; }
    S.items[it.id] = it;
    return it;
  };
  const inCol = (col, type, data = {}, extra = {}) => add(type, 0, 0, data, { ...extra, col: col.id, order: childrenOf(col.id).length });
  const line = (a, b, o = {}) => { const l = { id: uid(), board: cur, a: { item: a.id }, b: { item: b.id }, arrow: true, color: null, bend: 0, ...o }; S.lines[l.id] = l; return l; };
  const tasks = arr => arr.map(t => ({ id: uid(), t, done: false }));
  const note = (h, p) => `<h2>${h}</h2>${p ? `<p>${p}</p>` : ''}`;
  return { add, inCol, line, tasks, note };
}
export async function applyTemplate(id, at) {
  await loaded;
  const T = TEMPLATES.find(t => t.id === id); if (!T) return;
  exitEdit(); closeModal();
  checkpoint();
  const wasEmpty = !itemsOf(cur).length;
  const origin = at || (wasEmpty ? { x: 40, y: 40 } : (() => { const c = viewCenter(); return { x: c.x - 300, y: c.y - 200 }; })());
  T.build(tplKit(origin));
  const b = S.boards[cur];
  if (wasEmpty && b && /^Untitled board$/.test(b.title)) b.title = T.name;
  save(); render();
  if (wasEmpty) fit();
}
export async function templateGallery(at) {
  await loaded;
  const card = openModal(`<h2>Start from a template</h2><p>Templates add ready-made cards to the current board. You can change everything afterwards.</p><div class="tpl-grid">` +
    TEMPLATES.map(t => `<button class="tpl" data-tpl="${t.id}"><span class="tpl-thumb"><svg viewBox="0 0 120 75" aria-hidden="true">${t.art(t.c)}</svg></span><b>${t.name}</b><span>${t.desc}</span></button>`).join('') + '</div>', { cls: 'tpl-modal' });
  card.addEventListener('click', e => { const b = e.target.closest('[data-tpl]'); if (b) applyTemplate(b.dataset.tpl, at); });
}

export function init() {
  loaded.then(() => {
    emptyHint.innerHTML = '<strong>This board is empty</strong><span>Drag in a card from the left, drop files from your computer, or double-click anywhere to write a note. Or start from a template:</span>' +
      `<div class="eh-tpl">${TEMPLATES.slice(0, 6).map(t => `<button data-tpl="${t.id}">${t.name}</button>`).join('')}<button data-tpl-all>More…</button></div>`;
  });
  emptyHint.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.stopPropagation(); });
  emptyHint.addEventListener('click', e => {
    const b = e.target.closest('[data-tpl]'); if (b) return applyTemplate(b.dataset.tpl);
    if (e.target.closest('[data-tpl-all]')) templateGallery();
  });
}
