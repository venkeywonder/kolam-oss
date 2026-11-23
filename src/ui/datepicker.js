/*
 * The due-date picker for to-do tasks: a small month calendar with Today / Tomorrow and Remove.
 * Dates are local calendar days as "YYYY-MM-DD".
 *
 * pickDate({ anchor, value, onPick, onClose }) opens it next to anchor; onPick(date | null) runs once a day is chosen
 * (null = remove the date), onClose() when it goes away. Only one is open at a time.
 */
import { esc } from '../core/util.js';
import { icon } from './icons.js';
import { calm } from '../canvas/motion.js';

const LANG = navigator.language || 'en-US';
const pad2 = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const day0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const todayYmd = () => ymd(day0());
const fromYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const add = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

// first day of the week for this locale: 0 = Sunday … 6 = Saturday
const WEEK_START = (() => {
  try {
    const l = new Intl.Locale(LANG), w = l.getWeekInfo?.() || l.weekInfo;
    if (w?.firstDay) return w.firstDay % 7;
  } catch { /* older browsers */ }
  return /-(US|CA|MX|BR|JP|KR|TW|HK|IL|PH|IN|ZA|AU)$/i.test(LANG) ? 0 : 1;
})();
const fmt = (o, d) => new Intl.DateTimeFormat(LANG, o).format(d);

let open = null;   // { el, anchor, close }

export function closeDatePicker() { open?.close(); }

export function pickDate({ anchor, value = null, onPick, onClose }) {
  if (open?.anchor === anchor) { closeDatePicker(); return; }   // its chip again: toggle off
  closeDatePicker();
  const today = day0(), todayS = ymd(today);
  let view = value ? fromYmd(value) : today;
  view = new Date(view.getFullYear(), view.getMonth(), 1);

  const el = document.createElement('div');
  el.className = 'cal';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Due date');
  el.innerHTML =
    `<div class="cal-head"><div class="cal-title"></div>` +
    `<button class="cal-nav" data-nav="-1" title="Previous month" aria-label="Previous month">${icon('chevR', 14)}</button>` +
    `<button class="cal-nav" data-nav="1" title="Next month" aria-label="Next month">${icon('chevR', 14)}</button></div>` +
    `<div class="cal-dow">${Array.from({ length: 7 }, (_, i) => `<span>${esc(fmt({ weekday: 'narrow' }, new Date(2026, 1, 1 + (WEEK_START + i) % 7)))}</span>`).join('')}</div>` +
    `<div class="cal-days" role="grid"></div>` +
    `<div class="cal-foot"><button data-pick="${todayS}">Today</button><button data-pick="${ymd(add(today, 1))}">Tomorrow</button>` +
    `${value ? '<button class="cal-clear" data-clear>Remove</button>' : ''}</div>`;
  document.body.appendChild(el);
  const days = el.querySelector('.cal-days');

  const paint = (focus = null) => {
    const y = view.getFullYear(), mo = view.getMonth();
    el.querySelector('.cal-title').textContent = fmt({ month: 'long', year: 'numeric' }, view);
    const start = add(view, -((view.getDay() - WEEK_START + 7) % 7));
    const tab = focus || (value && fromYmd(value).getMonth() === mo && fromYmd(value).getFullYear() === y ? value
      : today.getMonth() === mo && today.getFullYear() === y ? todayS : ymd(view));
    let h = '';
    for (let i = 0; i < 42; i++) {
      const d = add(start, i), s = ymd(d);
      const cls = ['cal-d', d.getMonth() !== mo && 'out', s === todayS && 'today', s === value && 'on', d < today && 'past'].filter(Boolean).join(' ');
      h += `<button class="${cls}" data-d="${s}" tabindex="${s === tab ? 0 : -1}" aria-label="${esc(fmt({ weekday: 'long', month: 'long', day: 'numeric' }, d))}"${s === value ? ' aria-selected="true"' : ''}>${d.getDate()}</button>`;
    }
    days.innerHTML = h;
    if (focus) days.querySelector(`[data-d="${focus}"]`)?.focus();
  };
  const show = (s, focus) => {   // bring a day's month into view
    const d = fromYmd(s);
    view = new Date(d.getFullYear(), d.getMonth(), 1);
    paint(focus ? s : null);
  };

  let done = false;
  const choose = s => {
    if (done) return;
    done = true;
    onPick?.(s);
    close();
  };

  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.d) return choose(b.dataset.d);
    if (b.dataset.pick) return choose(b.dataset.pick);
    if (b.dataset.nav) { view = new Date(view.getFullYear(), view.getMonth() + +b.dataset.nav, 1); return paint(); }
    if (b.hasAttribute('data-clear')) return choose(null);
  });

  // keys stay in the picker (the board would move or delete the selected cards otherwise)
  el.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); return close(); }
    const b = e.target.closest?.('[data-d]'); if (!b) return;
    const d = fromYmd(b.dataset.d);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    let to = null;
    if (step) to = add(d, step);
    else if (e.key === 'PageUp' || e.key === 'PageDown') to = new Date(d.getFullYear(), d.getMonth() + (e.key === 'PageUp' ? -1 : 1), Math.min(d.getDate(), 28));
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); return choose(b.dataset.d); }
    if (!to) return;
    e.preventDefault();
    show(ymd(to), true);
  });

  // place it under the anchor (or above, when there's no room below)
  const place = () => {
    const a = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    const below = a.bottom + 6 + h <= innerHeight - 8 || a.top - 6 - h < 8;
    const left = Math.max(8, Math.min(a.left + a.width / 2 - w / 2, innerWidth - w - 8));
    el.style.left = left + 'px';
    el.style.top = (below ? Math.min(a.bottom + 6, innerHeight - h - 8) : a.top - 6 - h) + 'px';
    el.classList.toggle('up', !below);
  };

  const outside = e => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onWheel = e => { if (!el.contains(e.target)) close(); };
  function close() {
    if (open?.el !== el) return;
    open = null;
    onClose?.();
    removeEventListener('pointerdown', outside, true);
    removeEventListener('wheel', onWheel, true);
    removeEventListener('resize', close);
    removeEventListener('hashchange', close);
    if (calm()) { el.remove(); return; }
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: 'ease-in' }).finished.then(() => el.remove(), () => el.remove());
  }
  open = { el, anchor, close };
  paint();
  place();
  addEventListener('pointerdown', outside, true);
  addEventListener('wheel', onWheel, { capture: true, passive: true });
  addEventListener('resize', close);
  addEventListener('hashchange', close);
  days.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
}
