import { $, esc } from '../core/util.js';
import { S, checkpoint, cur, save } from '../core/store.js';
import { renderBoard } from '../canvas/render.js';
import { hideBars } from './floatbars.js';
import { mod } from './menus.js';
import { toast } from './toast.js';
import { getPref, setPref, setTheme, userName } from './theme.js';
import { api } from '../core/api.js';
import { user } from '../core/store.js';
import { signOut } from './auth.js';
import { downloadText, fileSafe, openModal } from './modal.js';
import { templateGallery } from '../features/templates.js';
import { boardToMd, exportPNG, mdToText } from '../features/export.js';

/* ================= help, settings, clipper ================= */
export function showHelp() {
  const k = [['Pan the board', 'Scroll · Space + drag'], ['Zoom', mod + 'scroll · pinch'], ['Zoom in / out / 100%', `${mod}+ · ${mod}− · ${mod}0`], ['New note / to-do / board / column', 'N · T · B · C'], ['Fit everything on screen', '⇧1'], ['Select next / previous card', 'Tab · ⇧Tab'], ['New note anywhere', 'Double-click'], ['Edit selected card', 'Enter'], ['Stop editing', 'Esc'], ['Select several', 'Shift-click · drag a box'], ['Duplicate', mod + 'D'], ['Copy / cut / paste', `${mod}C · ${mod}X · ${mod}V`], ['Delete (to Trash)', '⌫'], ['Undo / redo', `${mod}Z · ⇧${mod}Z`], ['Nudge', 'Arrow keys (Shift = 10px)'], ['Move without snapping', 'Hold Alt while dragging'], ['Label a line', 'Double-click the line'], ['Attach a line end to a point', 'Drop it on a card edge (middle = auto)'], ['Search', mod + 'F'], ['This help', '?']];
  openModal(`<h2>Keyboard shortcuts</h2><p>Work faster on the board.</p><div class="kbd-grid">${k.map(([a, b]) => `<span>${a}</span><kbd>${b}</kbd>`).join('')}</div><div class="m-actions"><button class="btn" data-close>Got it</button></div>`);
}
export function clipperDialog() {
  const base = location.origin + location.pathname;
  const js = `javascript:(()=>{window.open('${base}?clip='+encodeURIComponent(location.href)+'&t='+encodeURIComponent(document.title),'kolam','width=440,height=320')})()`;
  const card = openModal(`<h2>Web clipper</h2><p>Drag the button below to your bookmarks bar. On any web page, click it to save that page into <b>Unsorted</b> as a link card.</p><p><a class="bm" href="${esc(js)}" onclick="return false">Save to Kolam</a></p><p style="font-size:12.5px">Works while Kolam is reachable at ${esc(base)}.</p><div class="m-actions"><button class="btn" data-close>Done</button></div>`);
  $('.bm', card).setAttribute('href', js);
}
