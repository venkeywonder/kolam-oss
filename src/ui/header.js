/* Top bar and board bar: Export / View / More / account menus, search toggle, avatar. */
import { $, esc } from '../core/util.js';
import { icon } from './icons.js';
import { ACC, RO, S, VIEW, checkpoint, cur, isHome, resetUndo, save, setCur, setS, user } from '../core/store.js';
import { seed } from '../core/seed.js';
import { render, renderBoard } from '../canvas/render.js';
import { fit, zoomCenter } from '../canvas/viewport.js';
import { hideMenu, showMenu } from './menus.js';
import { ctxmenu } from '../core/dom.js';
import { hideBars } from './floatbars.js';
import { confirmDialog, downloadText, fileSafe } from './modal.js';
import { boardToMd, exportPNG, mdToText } from '../features/export.js';
import { exportAll } from '../features/io.js';
import { templateGallery } from '../features/templates.js';
import { showHelp } from './help.js';
import { clipperDialog } from './clipper.js';
import { getPref, setTheme, userName } from './theme.js';
import { signOut } from './auth.js';
import { CORNERS, boardCorners, cornerGlyph, setBoardCorners } from '../cards/corners.js';
import { hasStyles, remember, resetStyles } from '../core/styles.js';
import { openAccountSettings } from './account.js';
import { openAdmin } from './admin.js';
import { getConfig, hasUnseenChangelog, helpMenuEntries } from '../features/support.js';
import { paintAvatarEl } from './avatars.js';

const tick = on => (on ? '<span class="tick">✓</span>' : '');

function menuFrom(btn, entries, alignRight = true) {
  if (!ctxmenu.hidden && ctxmenu.dataset.owner === btn.id) { hideMenu(); return; }
  const r = btn.getBoundingClientRect();
  showMenu(alignRight ? r.right - 250 : r.left, r.bottom + 6, entries);
  ctxmenu.dataset.owner = btn.id;
  btn.classList.add('open');
  const off = new MutationObserver(() => { if (ctxmenu.hidden) { btn.classList.remove('open'); off.disconnect(); } });
  off.observe(ctxmenu, { attributes: true, attributeFilter: ['hidden'] });
}

const exportMenu = () => VIEW ? exportMenuBase().slice(0, 4) : isHome() ? exportMenuBase() : exportMenuBase().slice(0, -1);
const exportMenuBase = () => [
  { label: 'Image (PNG)', icon: 'png', act: exportPNG },
  { label: 'Markdown', icon: 'text', act: () => downloadText(fileSafe(S.boards[cur].title) + '.md', boardToMd(cur), 'text/markdown') },
  { label: 'Plain text', icon: 'text', act: () => downloadText(fileSafe(S.boards[cur].title) + '.txt', mdToText(boardToMd(cur))) },
  { label: 'Print or save as PDF', icon: 'print', kbd: '⌘P', act: () => { hideBars(); setTimeout(() => print(), 50); } },
  '-',
  { label: 'Back up everything (.zip)', icon: 'exportI', act: exportAll },
  { label: 'Restore from backup…', icon: 'importI', act: () => $('#importPick').click() },
];

function viewMenu() {
  const bg = S.boards[cur]?.bg || 'dots', th = getPref('theme', 'system');
  const setBg = v => { checkpoint(); S.boards[cur].bg = v; remember('board', { bg: v }); save(); renderBoard(); };
  const zoom = [
    { label: 'Fit everything on screen', icon: 'fit', kbd: '⇧1', act: fit },
    { label: 'Zoom in', kbd: '⌘+', act: () => zoomCenter(1.2) },
    { label: 'Zoom out', kbd: '⌘−', act: () => zoomCenter(1 / 1.2) },
    '-',
  ];
  const themes = [
    { label: 'Light theme' + tick(th === 'light'), icon: 'reset', act: () => setTheme('light') },
    { label: 'Dark theme' + tick(th === 'dark'), icon: 'moon', act: () => setTheme('dark') },
    { label: 'Match system' + tick(th === 'system'), icon: 'keyboard', act: () => setTheme('system') },
  ];
  if (RO) return [...zoom, ...themes];
  const corners = boardCorners(cur);
  return [...zoom,
    { row: [
      { icon: 'bg', title: 'Dotted background', on: bg === 'dots', act: () => setBg('dots') },
      { icon: 'table', title: 'Grid background', on: bg === 'grid', act: () => setBg('grid') },
      { icon: 'template', title: 'Plain background', on: bg === 'plain', act: () => setBg('plain') },
    ] },
    { row: [
      ...CORNERS.map(([k, label]) => ({ svg: cornerGlyph(k, 17), title: label, on: corners === k, act: () => { setBoardCorners(cur, k); renderBoard(); } })),
    ] },
    '-', ...themes,
  ];
}

const moreMenu = () => [
  ...(RO ? [] : [{ label: 'Templates…', icon: 'template', act: () => templateGallery() }]),
  { label: 'Web clipper…', icon: 'bookmark', act: clipperDialog },
  { label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', act: showHelp },
  ...(!RO && hasStyles() ? [{ label: 'Reset styles for new elements', icon: 'undo', act: resetStyles }] : []),
  // only while nobody else can see these boards: it replaces all of them
  ...(isHome() && Object.keys(ACC?.people || {}).length <= 1 ? ['-', { label: 'Reset to demo content…', icon: 'reset', danger: true, act: async () => {
    if (!await confirmDialog('Reset to demo content?', { body: 'All of your boards will be replaced with the demo content. Everything else will be removed.', ok: 'Reset', danger: true })) return;
    setS({ ...seed(), views: {} }); resetUndo(); setCur('home'); location.hash = '#/b/home'; save(); render();
  } }] : []),
];

const accountMenu = () => [
  { label: `<b>${esc(userName())}</b><small>${esc(user?.email || '')}</small>`, act: () => openAccountSettings('profile') },
  '-',
  { label: 'Account settings', icon: 'user', act: () => openAccountSettings() },
  ...(user?.admin ? [{ label: 'Admin…', icon: 'lock', act: openAdmin }] : []),
  '-',
  { label: 'Sign out', icon: 'close', act: async () => { if (await confirmDialog('Sign out?', { body: 'You will need to sign in again on this device.', ok: 'Sign out' })) signOut(); } },
];

export function paintAvatar() {
  const a = $('#avatarBtn'); if (!a || !user) return;
  const n = userName();
  paintAvatarEl(a, user.id, n);
  a.title = `${n}${user.email ? ' · ' + user.email : ''}`;
}
let helpConfig = {};
/** Loads the help menu's config and unread "What's new" dot; call again once a user signs in. */
export function refreshHelp() {
  if (VIEW || !user) return;
  getConfig().then(c => { helpConfig = c; });
  hasUnseenChangelog().then(has => $('#helpBtn')?.classList.toggle('has-unread', has));
}


export function init() {
  $('#searchBtn').innerHTML = icon('search', 19);
  $('#helpBtn').innerHTML = icon('help', 19);
  $('#shareBtn').innerHTML = `<span class="share-ic">${icon('userPlus', 15)}</span>Share`;
  for (const id of ['exportBtn', 'viewBtn', 'menuBtn', 'avatarBtn']) $('#' + id).dataset.menuBtn = '';
  $('#exportBtn').addEventListener('click', e => menuFrom(e.currentTarget, exportMenu()));
  $('#viewBtn').addEventListener('click', e => menuFrom(e.currentTarget, viewMenu()));
  $('#menuBtn').addEventListener('click', e => menuFrom(e.currentTarget, moreMenu()));
  $('#avatarBtn').addEventListener('click', e => menuFrom(e.currentTarget, accountMenu()));
  refreshHelp();
  $('#helpBtn').addEventListener('click', e => {
    if (VIEW || !user) return showHelp();
    const btn = e.currentTarget;
    menuFrom(btn, helpMenuEntries(helpConfig, showHelp, () => btn.classList.remove('has-unread'), btn.classList.contains('has-unread')));
  });

  const wrap = $('#searchWrap'), input = $('#search');
  $('#searchBtn').addEventListener('click', () => { wrap.classList.add('open'); input.focus(); });
  input.addEventListener('blur', () => { if (!input.value) setTimeout(() => wrap.classList.remove('open'), 150); });
  input.addEventListener('focus', () => wrap.classList.add('open'));
  if (VIEW) $('#avatarBtn').hidden = true; else paintAvatar();
}
