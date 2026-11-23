import { uid } from '../core/util.js';
import { emptyHint } from '../core/dom.js';
import { S, checkpoint, cur, save } from '../core/store.js';
import { fit, viewCenter } from '../canvas/viewport.js';
import { childrenOf, itemsOf, maxZ } from '../core/model.js';
import { TYPES } from '../cards/types.js';
import { render } from '../canvas/render.js';
import { exitEdit } from '../canvas/editing.js';
import { closeModal, openModal } from '../ui/modal.js';

/* ================= templates ================= */
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
export const TEMPLATES = [
  { id: 'mood', name: 'Moodboard', desc: 'Imagery, colours and words that set the tone.', c: '#7b55d9', build(k) {
    k.add('note', 0, 0, { html: '<h1>Moodboard</h1><p>What feeling should this project leave people with?</p>' }, { w: 320 });
    const img = k.add('column', 0, 170, { title: 'Imagery' }, { w: 300 });
    k.inCol(img, 'note', { html: '<p>Drop reference images into this column.</p>' });
    const words = k.add('column', 330, 170, { title: 'Words' }, { w: 220 });
    ['Calm', 'Tactile', 'Honest', 'Warm'].forEach(w => k.inCol(words, 'note', { html: `<h2>${w}</h2>` }));
    ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'].forEach((hex, i) => k.add('swatch', 360 + i * 150, 0, { hex }));
    k.add('note', 580, 170, { html: '<h2>Typography</h2><p>Headings: a confident serif. Body: a quiet sans.</p>' }, { w: 280 });
  } },
  { id: 'kanban', name: 'Project plan', desc: 'Backlog, to do, doing and done columns.', c: '#3478e5', build(k) {
    k.add('note', 0, 0, { html: '<h1>Project plan</h1><p>Move cards from left to right as work progresses.</p>' }, { w: 380 });
    [['Backlog', ['Research competitors', 'Collect user quotes']], ['To do', ['Write the brief', 'Sketch first concepts']], ['Doing', ['Kick-off meeting prep']], ['Done', ['Set up this board']]].forEach(([t, cards], i) => {
      const c = k.add('column', i * 300, 130, { title: t }, { w: 280, color: i === 3 ? 'green' : null });
      cards.forEach(x => k.inCol(c, 'note', { html: `<p>${x}</p>` }));
    });
    k.add('todo', 1200, 130, { title: 'Milestones', tasks: k.tasks(['Brief approved', 'Concepts reviewed', 'Launch']) }, { color: 'yellow' });
  } },
  { id: 'mind', name: 'Mind map', desc: 'A central idea branching into topics.', c: '#db4c9a', build(k) {
    const c = k.add('note', 360, 220, { html: '<h1>Central idea</h1>' }, { w: 240, color: 'pink' });
    const pts = [[0, 0], [360, -40], [720, 0], [740, 420], [360, 470], [0, 420]];
    ['Who is it for?', 'Why now?', 'How might it work?', 'Risks', 'What success looks like', 'Open questions'].forEach((t, i) => {
      const n = k.add('note', pts[i][0], pts[i][1], { html: `<h2>${t}</h2>` }, { w: 220 });
      k.line(c, n, { arrow: false, color: 'pink' });
    });
  } },
  { id: 'story', name: 'Storyboard', desc: 'Scenes in sequence with shot and audio notes.', c: '#ee8a26', build(k) {
    k.add('note', 0, 0, { html: '<h1>Storyboard</h1><p>One column per scene. Sketch the frame, then note the shot and sound.</p>' }, { w: 420 });
    let prev = null;
    for (let i = 0; i < 4; i++) {
      const c = k.add('column', i * 320, 130, { title: `Scene ${i + 1}` }, { w: 290 });
      k.inCol(c, 'sketch', { strokes: [] }, { h: 170 });
      k.inCol(c, 'note', { html: '<p><b>Shot:</b> </p><p><b>Audio:</b> </p><p><b>Duration:</b> </p>' });
      if (prev) k.line(prev, c);
      prev = c;
    }
  } },
  { id: 'brain', name: 'Brainstorm', desc: 'A prompt, idea columns and a shortlist.', c: '#e2b000', build(k) {
    k.add('note', 0, 0, { html: '<h1>How might we…?</h1><p>Write the challenge here. Quantity first, judgement later.</p>' }, { w: 420, color: 'yellow' });
    ['Wild ideas', 'Practical ideas', 'Questions'].forEach((t, i) => { const c = k.add('column', i * 300, 170, { title: t }, { w: 280 }); k.inCol(c, 'note', { html: '' }); });
    k.add('todo', 900, 170, { title: 'Shortlist', tasks: k.tasks(['', '', '']) }, { color: 'green' });
  } },
  { id: 'week', name: 'Weekly planner', desc: 'One column per day plus priorities.', c: '#35a35a', build(k) {
    k.add('todo', 0, 0, { title: 'Top priorities this week', tasks: k.tasks(['', '', '']) }, { w: 300, color: 'yellow' });
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Weekend'].forEach((d, i) => {
      const c = k.add('column', 330 + i * 270, 0, { title: d }, { w: 250 });
      k.inCol(c, 'todo', { title: '', tasks: k.tasks(['']) });
    });
  } },
  { id: 'meeting', name: 'Meeting notes', desc: 'Agenda, notes, decisions and actions.', c: '#1a9e93', build(k) {
    k.add('note', 0, 0, { html: `<h1>Meeting · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</h1><p><b>Attendees:</b> </p>` }, { w: 420 });
    const a = k.add('column', 0, 150, { title: 'Agenda' }, { w: 260 });
    ['Updates', 'Discussion', 'Next steps'].forEach(x => k.inCol(a, 'note', { html: `<p>${x}</p>` }));
    k.add('note', 290, 150, { html: '<h2>Notes</h2><p></p>' }, { w: 320 });
    k.add('note', 640, 150, { html: '<h2>Decisions</h2><ul><li></li></ul>' }, { w: 260, color: 'blue' });
    k.add('todo', 640, 330, { title: 'Action items', tasks: k.tasks(['', '']) }, { w: 260, color: 'yellow' });
  } },
  { id: 'research', name: 'Research', desc: 'Sources, quotes, insights and open questions.', c: '#e5534b', build(k) {
    k.add('note', 0, 0, { html: '<h1>Research</h1><p>Paste links into Sources. Pull key quotes out, then group them into insights.</p>' }, { w: 420 });
    [['Sources', 'Paste a link anywhere on the board to add a preview card.'], ['Quotes', '“Add memorable quotes here.”'], ['Insights', 'What patterns are you seeing?']].forEach(([t, p], i) => {
      const c = k.add('column', i * 300, 150, { title: t }, { w: 280 });
      k.inCol(c, 'note', { html: `<p>${p}</p>` });
    });
    k.add('todo', 900, 150, { title: 'Open questions', tasks: k.tasks(['']) }, { color: 'purple' });
  } },
  { id: 'writing', name: 'Writing', desc: 'A document, an outline and a notes column.', c: '#6b5b95', build(k) {
    k.add('doc', 0, 0, { title: 'Draft', html: '<p>Start writing here.</p>' }, { w: 360 });
    const outline = k.add('column', 400, 0, { title: 'Outline' }, { w: 260 });
    ['Introduction', 'Main point', 'Conclusion'].forEach(x => k.inCol(outline, 'note', { html: `<p>${x}</p>` }));
    k.add('note', 690, 0, { html: '<h2>Notes</h2><p>Stray ideas and references go here.</p>' }, { w: 280, color: 'teal' });
  } },
];
export function applyTemplate(id, at) {
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
export function templateGallery(at) {
  const card = openModal(`<h2>Start from a template</h2><p>Templates add ready-made cards to the current board. You can change everything afterwards.</p><div class="tpl-grid">` +
    TEMPLATES.map(t => `<button class="tpl" data-tpl="${t.id}"><i style="--c:${t.c}"></i><b>${t.name}</b><span>${t.desc}</span></button>`).join('') + '</div>');
  card.addEventListener('click', e => { const b = e.target.closest('[data-tpl]'); if (b) applyTemplate(b.dataset.tpl, at); });
}

export function init() {
  emptyHint.innerHTML = '<strong>This board is empty</strong><span>Drag in a card from the left, drop files from your computer, or double-click anywhere to write a note. Or start from a template:</span>' +
    `<div class="eh-tpl">${TEMPLATES.slice(0, 6).map(t => `<button data-tpl="${t.id}">${t.name}</button>`).join('')}<button data-tpl-all>More…</button></div>`;
  emptyHint.addEventListener('pointerdown', e => { if (e.target.closest('button')) e.stopPropagation(); });
  emptyHint.addEventListener('click', e => {
    const b = e.target.closest('[data-tpl]'); if (b) return applyTemplate(b.dataset.tpl);
    if (e.target.closest('[data-tpl-all]')) templateGallery();
  });
}

