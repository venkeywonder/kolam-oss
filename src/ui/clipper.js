import { $, $$, esc } from '../core/util.js';
import { openModal } from './modal.js';
import { shake, calm } from '../canvas/motion.js';
import { mod } from './menus.js';

/* ================= web clipper dialog ================= */
const macLike = navigator.platform.includes('Mac') || /Mac/i.test(navigator.userAgentData?.platform || '');
const barKey = macLike ? '⌘⇧B' : 'Ctrl+Shift+B';

// phases of the looping illustration, in ms into the 8s loop (kept in sync with the CSS keyframes below)
const LOOP = 8000;
const PHASES = [
  { at: 0, cap: 'Drag the button up to the bookmarks bar' },
  { at: 3000, cap: 'Drop it there: it stays as a bookmark' },
  { at: 4500, cap: 'On any page, click it: the page is saved to Kolam' },
];

const CURSOR = `<svg viewBox="0 0 24 24" width="20" height="20" style="display:block"><path d="M4 2 4 20 9 16 12 22 15 20.5 12 14.5 19 14.5Z" fill="#fff" stroke="#20242c" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

export function clipperDialog() {
  const base = location.origin + location.pathname;
  const js = `javascript:(()=>{window.open('${base}?clip='+encodeURIComponent(location.href)+'&t='+encodeURIComponent(document.title),'kolam','width=440,height=320')})()`;
  const used = localStorage.getItem('nk:clipped') === '1';
  const reduced = calm();
  const card = openModal(`
    <h2>Web clipper</h2>
    <p>Save any web page to Kolam in one click — it lands in <b>Unsorted</b> as a link card with its preview.</p>
    ${used ? `<p class="clip-used">✓ You’re set up: the clipper has saved pages before.</p>` : ''}
    <div class="clip-illus${reduced ? ' clip-static' : ''}" aria-hidden="true">
      <div class="clip-browser">
        <div class="clip-browser-top">
          <span class="clip-dot"></span><span class="clip-dot"></span><span class="clip-dot"></span>
          <div class="clip-tab">Recipes</div>
        </div>
        <div class="clip-addr">recipes.example.com</div>
        <div class="clip-bookmarks">
          <i class="clip-bm-tag">Bookmarks bar</i>
          <div class="clip-chip"><i></i>News</div>
          <div class="clip-chip"><i></i>Mail</div>
          <div class="clip-slot"></div>
          <div class="clip-chip clip-chip-new"><i class="clip-chip-k">K</i>Save to Kolam</div>
        </div>
        <div class="clip-page">
          <div class="clip-page-title"></div>
          <div class="clip-page-img"></div>
          <div class="clip-page-line"></div>
          <div class="clip-page-line short"></div>
        </div>
      </div>
      <div class="clip-mini-row">
        <div class="clip-mini-btn">Save to Kolam</div>
        <div class="clip-kolam-badge">Kolam · Unsorted<span class="clip-plus">+1</span></div>
      </div>
      <div class="clip-card-fly"><i></i><div class="clip-card-fly-txt"><b></b><b></b></div></div>
      <div class="clip-ghost-btn">Save to Kolam</div>
      <div class="clip-ptr">${CURSOR}</div>
      <p class="clip-caption">${esc(PHASES[0].cap)}</p>
    </div>
    <ol class="clip-steps">
      <li><span class="clip-num">1</span> Show your bookmarks bar <kbd>${barKey}</kbd></li>
      <li><span class="clip-num">2</span> Drag the button below up to the bar</li>
      <li><span class="clip-num">3</span> On any page, click it</li>
    </ol>
    <div class="clip-grab">
      <a class="bm" href="${esc(js)}" draggable="true">Save to Kolam</a>
      <span class="clip-hint">Drag me ↑</span>
    </div>
    <p class="clip-note">Works while Kolam is reachable at ${esc(base)}.</p>
    <div class="m-actions"><button class="btn" data-close>Done</button></div>`,
    { cls: 'clip-modal', onClose: () => timer && clearInterval(timer) });
  const bm = $('.bm', card), hint = $('.clip-hint', card);
  bm.setAttribute('href', js);
  bm.addEventListener('click', e => { e.preventDefault(); shake(bm); hint.textContent = 'Drag it, don’t click it — up to your bookmarks bar'; });
  bm.addEventListener('dragstart', () => { card.classList.add('clip-dragging'); hint.textContent = 'Now drop it on your bookmarks bar ↑'; });
  bm.addEventListener('dragend', () => { card.classList.remove('clip-dragging'); hint.textContent = 'Dropped it? Try it on any page'; });

  let timer = null;
  if (!reduced) {
    const caption = $('.clip-caption', card);
    const steps = $$('.clip-steps li', card);
    const t0 = performance.now();
    const tick = () => {
      const el = (performance.now() - t0) % LOOP;
      let i = 0;
      for (let n = 0; n < PHASES.length; n++) if (el >= PHASES[n].at) i = n;
      if (caption.textContent !== PHASES[i].cap) caption.textContent = PHASES[i].cap;
      steps.forEach((li, n) => li.classList.toggle('on', n === i));
    };
    tick();
    timer = setInterval(tick, 150);
  }
}
