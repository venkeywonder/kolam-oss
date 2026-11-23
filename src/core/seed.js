import { uid } from './util.js';

/* ================= seed content ================= */
export function seed() {
  const st = { v: 1, updatedAt: Date.now(), views: {}, items: {}, lines: {},
    boards: { home: { id: 'home', title: 'Home', parent: null } } };
  let z = 1;
  const add = (board, type, x, y, w, data, extra = {}) => {
    const it = { id: uid(), board, type, x, y, w, z: z++, col: null, order: 0, color: null, data, ...extra };
    st.items[it.id] = it; return it;
  };
  const welcome = add('home', 'note', 40, 40, 300, { html:
    '<h1>Welcome to Kolam</h1><p>A visual board for collecting and arranging ideas.</p><ul>' +
    '<li>Drag a tool from the left onto the board</li><li>Drop images or files straight from your computer</li>' +
    '<li>Drag cards into a column, or onto a board card to move them inside</li>' +
    '<li>Hover a card and drag the blue dot to connect it to another</li>' +
    '<li>Scroll to pan, ⌘/Ctrl + scroll or pinch to zoom</li></ul>' });
  const todo = add('home', 'todo', 400, 40, 260, { title: 'Getting started', tasks: [
    { id: uid(), t: 'Open the Mood board', done: true },
    { id: uid(), t: 'Add a column and drag notes into it', done: false },
    { id: uid(), t: 'Connect two cards with a line', done: false },
    { id: uid(), t: 'Drop an image onto the board', done: false } ] }, { color: 'yellow' });
  const mood = { id: uid(), title: 'Mood board', parent: 'home' };
  st.boards[mood.id] = mood;
  add('home', 'board', 400, 300, 150, { target: mood.id }, { color: 'purple' });
  const research = { id: uid(), title: 'Research', parent: 'home' };
  st.boards[research.id] = research;
  add('home', 'board', 570, 300, 150, { target: research.id }, { color: 'teal' });
  const col = add('home', 'column', 740, 40, 270, { title: 'Ideas' });
  ['<p><b>Morning routine app</b></p><p>Gentle nudges instead of alarms.</p>',
   '<p>Short-form recipe cards with a single photo each</p>',
   '<p>Weekly review template — what worked, what didn’t, what next?</p>'].forEach((html, i) => {
    add('home', 'note', 0, 0, 260, { html }, { col: col.id, order: i, color: i === 0 ? 'blue' : null });
  });
  add('home', 'comment', 40, 470, 260, { thread: [{ text: 'Tip: double-click empty space to drop a quick note.', at: Date.now() }] });
  const l = { id: uid(), board: 'home', a: { item: welcome.id }, b: { item: todo.id }, arrow: true, color: null, bend: 0 };
  st.lines[l.id] = l;
  // mood board content
  add(mood.id, 'note', 40, 40, 260, { html: '<h2>Palette</h2><p>Warm, calm, slightly retro.</p>' });
  [['#2f3e46', 40], ['#cad2c5', 200], ['#e9c46a', 360], ['#e76f51', 520]].forEach(([hex, x]) => add(mood.id, 'swatch', x, 170, 140, { hex }));
  add(mood.id, 'sketch', 40, 330, 320, { strokes: [] }, { h: 220 });
  add(research.id, 'link', 40, 40, 280, { url: 'https://developer.mozilla.org/', title: 'MDN Web Docs', desc: 'Resources for developers, by developers.' });
  return st;
}
