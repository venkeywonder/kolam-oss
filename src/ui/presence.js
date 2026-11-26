/* Who else is here: avatars in the board bar, and an "X is editing" marker on the card someone is typing in. */
import { $, $$, esc } from '../core/util.js';
import { S, cur, els, user } from '../core/store.js';
import { avatarHtml, hue } from './avatars.js';

let people = [];                   // everyone else in this space: { id, name, board, editing }
const first = n => (n || '?').trim().split(/\s+/)[0];

export function setPeople(list) {
  people = list.filter(p => p.id !== user?.id);
  paintPresence();
  paintEditing();
}

/** Who else is typing in this card right now (null if nobody). */
export const editorOf = id => people.find(p => p.board === cur && p.editing === id) || null;

export function paintPresence() {
  const el = $('#presence'); if (!el) return;
  const list = [...people.filter(p => p.board === cur), ...people.filter(p => p.board !== cur)];
  el.hidden = !list.length;
  el.innerHTML = list.slice(0, 5).map(p => {
    const where = p.board === cur ? 'on this board' : p.board && S?.boards[p.board] ? `on “${S.boards[p.board].title}”` : 'in this space';
    return avatarHtml(p.id, p.name, { cls: 'pr-av' + (p.board === cur ? '' : ' away'), attrs: `title="${esc(p.name)} · ${esc(where)}"` });
  }).join('') + (list.length > 5 ? `<span class="pr-more" title="${esc(list.slice(5).map(p => p.name).join(', '))}">+${list.length - 5}</span>` : '');
}

/** Mark the cards others are typing in. Called after every redraw of the board. */
export function paintEditing() {
  $$('.ed-mark').forEach(x => x.remove());
  $$('.card.remote-editing').forEach(x => x.classList.remove('remote-editing'));
  for (const p of people) {
    if (p.board !== cur || !p.editing) continue;
    const el = els.get(p.editing); if (!el) continue;
    el.classList.add('remote-editing');
    el.style.setProperty('--h', hue(p.id));
    el.insertAdjacentHTML('beforeend', `<div class="ed-mark">${esc(first(p.name))} is editing</div>`);
  }
}
