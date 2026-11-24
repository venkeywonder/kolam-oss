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
  const k = [['Pan the board', 'Scroll · right-drag · Space + drag'], ['Select a card, show its options', 'Right-click it'], ['More options (card or board)', 'Ctrl/Alt + right-click'], ['Zoom', mod + 'scroll · pinch'], ['Zoom in / out / 100%', `${mod}+ · ${mod}− · ${mod}0`], ['New note / to-do / board / column', 'N · T · B · C'], ['Fit everything on screen', '⇧1'], ['Select next / previous card', 'Tab · ⇧Tab'], ['New note anywhere', 'Double-click'], ['Edit selected card', 'Enter'], ['Stop editing', 'Esc'], ['Select several', 'Shift-click · drag a box'], ['Duplicate', mod + 'D'], ['Copy / cut / paste', `${mod}C · ${mod}X · ${mod}V`], ['Delete (to Trash)', '⌫'], ['Undo / redo', `${mod}Z · ⇧${mod}Z`], ['Save now', mod + 'S'], ['Nudge', 'Arrow keys (Shift = 10px)'], ['Move without snapping', 'Hold Alt while dragging'], ['Label a line', 'Double-click the line'], ['Attach a line end to a point', 'Drop it on a card edge (middle = auto)'], ['Search', mod + 'F'], ['This help', '?']];
  openModal(`<h2>Keyboard shortcuts</h2><p>Work faster on the board.</p><div class="kbd-grid">${k.map(([a, b]) => `<span>${a}</span><kbd>${b}</kbd>`).join('')}</div><div class="m-actions"><button class="btn" data-close>Got it</button></div>`);
}
