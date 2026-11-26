/*
 * Icons straight on the board (the Icon element) and on group boxes, for architecture diagrams and the like.
 * What's drawn comes from one of:
 *   data.ref   a logo from src/vendor/logos (built by scripts/build-logos.mjs): 'aws/amazon-ec2', 'dev/docker',
 *              'brand/stripe', or 'lucide/<name>' for a plain Lucide icon (src/vendor/lucide.json)
 *   data.asset an uploaded picture, cropped to a square like a board icon
 * data.dark (from the logo index): 1 = a black logo, shown inverted on a dark board; 2 = AWS has its own dark-board version.
 * An icon element also has data.label, the words under it.
 * The same picker, with an Emoji tab, sets a board card's icon (showBoardIconPicker; drawn by cards/board-icon.js).
 */
import { $, esc } from '../core/util.js';
import { assetUrl } from '../core/api.js';
import { pal } from '../core/palette.js';
import { ctxmenu } from '../core/dom.js';
import { S, checkpoint, els, putAsset, save } from '../core/store.js';
import { icon } from '../ui/icons.js';
import { lineCol } from '../ui/theme.js';
import { hideMenu } from '../ui/menus.js';
import { toast } from '../ui/toast.js';
import { rebuildCard } from '../canvas/render.js';
import { ICON_RULES, LOGO_REF, iconImage, loadIcons, logoImg, logosUrl, lucideIcon, searchLucide } from './board-icon.js';

let index = null, loading = null;
function loadIndex() {
  return (loading ||= fetch(logosUrl('index.json'))
    .then(r => { if (!r.ok) throw new Error('Logos couldn’t load'); return r.json(); })
    .then(d => (index = d))
    .catch(e => { loading = null; throw e; }));
}

/** The picture for an icon's data, filling its box. color: a palette key for Lucide icons (they take a colour). */
export function iconArt(d, color) {
  if (d?.asset) return `<img src="${esc(assetUrl(d.asset))}" alt="" draggable="false">`;
  const ref = d?.ref || '';
  if (ref.startsWith('lucide/')) return `<span class="ic-lucide" style="color:${color ? lineCol(pal(color)) : 'var(--ink)'}">${lucideIcon(ref.slice(7), 24)}</span>`;
  if (LOGO_REF.test(ref)) return logoImg(ref, d.dark);
  return icon('image', 24);
}

/* ---------- the picker ---------- */
const TABS = [['logos', 'Logos'], ['aws', 'AWS'], ['icons', 'Icons'], ['image', 'Upload']];
const PREVIEW = 18;            // icons shown per group before "Show all"
const LIMIT = 240;             // icons shown for a search
let lastTab = 'logos';
const EMOJI = ['🎨', '💡', '📚', '🎬', '✏️', '📷', '🎵', '🗺️', '🧠', '📅', '🚀', '⭐', '💼', '🏠', '🍳', '✈️', '🎮', '🌱',
  '🛍️', '💬', '📈', '🔬', '❤️', '🎉', '📝', '📌', '🗂️', '🧩', '🎯', '🔥', '🌍', '☕', '🏋️', '🧘', '💰', '🛠️',
  '🎁', '🐾', '🌸', '🌙', '☀️', '⚡', '🔒', '👥', '🎓', '🩺', '🧪', '🏆'];
const oneEmoji = v => {
  const g = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v.trim())].map(x => x.segment);
  return g.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g[0]) ? g[0] : null;
};

/**
 * Let someone choose an icon: logos (by area, or search), AWS service icons, plain icons, or their own picture.
 * onPick({ref, dark, title} | {asset, title}) gets the choice; onClear, when given, adds a button that removes it
 * (labelled clearLabel). onEmoji, when given, adds an Emoji tab first; tab picks the tab it opens on.
 */
export function showLogoPicker(x, y, { heading = 'Icon', current = null, tab: start = null, onPick, onEmoji, onClear, clearLabel = 'No icon', clearIcon = 'close' } = {}) {
  const R = ICON_RULES, mac = /Mac/.test(navigator.platform);
  const tabs = onEmoji ? [['emoji', 'Emoji'], ...TABS] : TABS;
  ctxmenu.innerHTML = `<div class="bip lgp">
    <div class="mhead">${esc(heading)}</div>
    <div class="bip-tabs" role="tablist">${tabs.map(([t, n]) => `<button role="tab" data-tab="${t}">${n}</button>`).join('')}</div>
    ${onEmoji ? `<div class="bip-pane" data-pane="emoji" hidden>
      <input class="bip-field" data-emoji-in placeholder="Type or paste any emoji" maxlength="32" spellcheck="false" aria-label="Any emoji">
      <div class="bip-note">${mac ? 'Press ⌃⌘Space for every emoji' : 'Press Win + . for every emoji'}</div>
      <div class="memoji">${EMOJI.map(e => `<button data-em="${e}">${e}</button>`).join('')}</div>
    </div>` : ''}
    <input class="bip-field" type="search" data-q placeholder="Search" spellcheck="false" aria-label="Search icons">
    <div class="lgp-list" data-list></div>
    <div class="bip-pane" data-pane="image" hidden>
      <button class="bip-up" data-upload>${icon('upload', 22)}<b>Upload an image</b><span>PNG, JPG, WebP, GIF or SVG · up to ${R.maxMB} MB</span></button>
      <div class="bip-note">At least ${R.min} × ${R.min} px and no more than ${R.ratio}:1; cropped to a square.</div>
      <div class="bip-err" role="alert" hidden></div>
      <input type="file" accept="${R.types.join(',')}" hidden data-file>
    </div>
    <div class="bip-note lgp-note" data-note></div>
    ${onClear ? `<div class="msep"></div><button class="mi" data-clear>${icon(clearIcon, 16)}<span>${esc(clearLabel)}</span></button>` : ''}
  </div>`;
  ctxmenu.hidden = false;
  const place = () => {
    ctxmenu.style.left = Math.max(8, Math.min(x, innerWidth - ctxmenu.offsetWidth - 8)) + 'px';
    ctxmenu.style.top = Math.max(8, Math.min(y, innerHeight - ctxmenu.offsetHeight - 8)) + 'px';
  };
  const q = $('[data-q]', ctxmenu), list = $('[data-list]', ctxmenu), note = $('[data-note]', ctxmenu);
  const open = new Set();      // groups opened with "Show all"
  let tab = start || (current?.startsWith('aws/') ? 'aws' : current?.startsWith('lucide/') ? 'icons' : lastTab);

  const cell = (ref, title, dark) => `<button data-ref="${esc(ref)}" data-dark="${dark || 0}" title="${esc(title)}"${ref === current ? ' class="on"' : ''}>` +
    (ref.startsWith('lucide/') ? lucideIcon(ref.slice(7), 22) : logoImg(ref, dark, ' loading="lazy"')) +
    `<span>${esc(title.replace(/^(Amazon|AWS) (?=\S)/, ''))}</span></button>`;

  function draw() {
    const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    note.textContent = '';
    if (tab === 'image' || tab === 'emoji') return;
    if (tab === 'icons') {
      list.innerHTML = '<div class="bip-note">Loading icons…</div>';
      return loadIcons().then(() => {
        const names = searchLucide(words.join('-'));
        const nice = n => n[0].toUpperCase() + n.slice(1).replace(/-/g, ' ');
        list.innerHTML = `<div class="lgp-grid">${names.slice(0, LIMIT).map(n => cell('lucide/' + n, nice(n), 0)).join('')}</div>` +
          (!names.length ? '<div class="bip-note">No icons match</div>' : names.length > LIMIT ? `<div class="bip-note">${LIMIT} of ${names.length}; search to find more</div>` : '');
        note.textContent = 'Lucide icons (ISC). Pick a colour for them from the selection toolbar.';
      }, () => { list.innerHTML = '<div class="bip-note">Icons couldn’t load. Check your connection.</div>'; });
    }
    list.innerHTML = '<div class="bip-note">Loading…</div>';
    return loadIndex().then(() => {
      const pack = index.packs.find(p => p.id === tab);
      note.textContent = pack.note;
      if (words.length) {
        // every word has to match the name or its search words; names that start with the search come first
        const hits = [];
        for (const g of pack.groups) for (const ic of g.icons) {
          const name = ic[1].toLowerCase(), hay = name + ' ' + ic[2], w0 = words[0], parts = name.split(/[\s.-]+/);
          // the name itself first ("Amazon EC2" for ec2), then a whole word of the name, then names starting with it, then the rest
          const rank = name.replace(/^(amazon|aws) /, '') === words.join(' ') ? 0 : parts.includes(w0) ? 1 : name.startsWith(w0) ? 2 : parts.some(p => p.startsWith(w0)) ? 3 : 4;
          if (words.every(w => hay.includes(w))) hits.push([rank, ic]);
        }
        hits.sort((a, b) => a[0] - b[0] || a[1][1].length - b[1][1].length);
        list.innerHTML = hits.length ? `<div class="lgp-grid">${hits.slice(0, LIMIT).map(([, i]) => cell(i[0], i[1], i[3])).join('')}</div>` +
          (hits.length > LIMIT ? `<div class="bip-note">${LIMIT} of ${hits.length}; add a word to narrow it down</div>` : '')
          : '<div class="bip-note">Nothing matches. Try another name, or upload your own picture.</div>';
        return;
      }
      // by group: a few of each, the rest one click away (the long tail of brands only by search)
      list.innerHTML = pack.groups.map((g, gi) => {
        const all = open.has(tab + gi), many = g.icons.length > 400;
        const shown = all ? g.icons : g.icons.slice(0, PREVIEW);
        return `<div class="lgp-head"><span>${esc(g.name)}</span>` +
          (g.icons.length > PREVIEW && !many ? `<button data-more="${gi}">${all ? 'Show fewer' : `Show all ${g.icons.length}`}</button>` : `<em>${g.icons.length}</em>`) + '</div>' +
          `<div class="lgp-grid">${shown.map(i => cell(i[0], i[1], i[3])).join('')}</div>` +
          (many && !all ? `<div class="bip-note">${g.icons.length - PREVIEW} more: search by name</div>` : '');
      }).join('');
    }, () => { list.innerHTML = '<div class="bip-note">Logos couldn’t load. Check your connection.</div>'; });
  }
  function pane(t) {
    tab = t; if (t !== 'image' && t !== 'emoji') lastTab = t;
    ctxmenu.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
    ctxmenu.querySelectorAll('[data-pane]').forEach(p => (p.hidden = p.dataset.pane !== t));
    q.hidden = list.hidden = t === 'image' || t === 'emoji';
    q.placeholder = t === 'aws' ? 'Search AWS (EC2, S3, Lambda, VPC…)' : t === 'icons' ? 'Search icons (server, user, lock…)' : 'Search logos (Postgres, Stripe, Docker…)';
    list.scrollTop = 0;
    // keep the whole picker on screen once its list has filled in
    Promise.resolve(draw()).then(place);
    if (t === 'emoji') $('[data-emoji-in]', ctxmenu).focus();
    else if (t !== 'image') q.focus();
  }

  let timer = 0;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { list.scrollTop = 0; draw(); }, 90); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') $('[data-ref]', list)?.click(); });
  const emojiIn = $('[data-emoji-in]', ctxmenu);
  emojiIn?.addEventListener('input', () => { const em = oneEmoji(emojiIn.value); if (em) { hideMenu(); onEmoji(em); } });
  emojiIn?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const em = oneEmoji(emojiIn.value);
    if (em) { hideMenu(); onEmoji(em); } else toast('Type or paste one emoji');
  });

  const err = $('.bip-err', ctxmenu), file = $('[data-file]', ctxmenu), up = $('[data-upload]', ctxmenu);
  file.addEventListener('change', async () => {
    const f = file.files[0]; file.value = ''; if (!f) return;
    err.hidden = true; up.disabled = true; up.querySelector('b').textContent = 'Uploading…';
    try {
      const asset = await putAsset(await iconImage(f), 'icon.png');
      hideMenu(); onPick({ asset, title: f.name.replace(/\.[^.]+$/, '') });
    } catch (e) {
      err.textContent = e.message || 'Upload failed'; err.hidden = false;
      if (ctxmenu.hidden) toast(`Couldn’t use that image: ${e.message}`);
    } finally { up.disabled = false; up.querySelector('b').textContent = 'Upload an image'; }
  });

  ctxmenu.onclick = e => {
    const t = e.target.closest('[data-tab]'); if (t) return pane(t.dataset.tab);
    if (e.target.closest('[data-upload]')) return file.click();
    const more = e.target.closest('[data-more]');
    if (more) { const k = tab + more.dataset.more; open.has(k) ? open.delete(k) : open.add(k); return draw(); }
    const em = e.target.closest('[data-em]');
    if (em) { hideMenu(); return onEmoji(em.dataset.em); }
    const b = e.target.closest('[data-ref]');
    if (b) { hideMenu(); return onPick({ ref: b.dataset.ref, dark: +b.dataset.dark || 0, title: b.title }); }
    if (e.target.closest('[data-clear]')) { hideMenu(); onClear(); }
  };
  pane(tab);
  place();
}

/** Put a picked icon on an element (an icon element or a group), keeping its other settings. */
export function setIconOf(id, pick) {
  const it = S.items[id]; if (!it) return;
  checkpoint();
  delete it.data.ref; delete it.data.asset; delete it.data.dark;
  if (pick?.ref) { it.data.ref = pick.ref; if (pick.dark) it.data.dark = pick.dark; }
  else if (pick?.asset) it.data.asset = pick.asset;
  // an icon still named after the old logo takes the new one's name
  if (it.type === 'icon' && pick?.title && (!it.data.label || it.data.label === it.data.auto)) it.data.label = it.data.auto = pick.title;
  save(); rebuildCard(id);
}

/* ---------- a board card's icon ---------- */
/** Pick the icon on a board's card: an emoji, a logo, an AWS icon, a plain icon or an uploaded picture. */
export function showBoardIconPicker(id, x, y) {
  const d = S.items[id]?.data || {};
  const set = patch => {
    const it = S.items[id]; if (!it) return;
    checkpoint();
    for (const k of ['emoji', 'icon', 'logo', 'dark', 'asset']) delete it.data[k];
    Object.assign(it.data, patch);
    save(); rebuildCard(id);
    // shortcuts to the board on screen show its icon too
    for (const s of Object.values(S.items)) if (s.type === 'shortcut' && s.data.target === it.data.target && els.get(s.id)) rebuildCard(s.id);
  };
  showLogoPicker(x, y, {
    heading: 'Board icon',
    current: d.logo || (d.icon ? 'lucide/' + d.icon : null),
    tab: d.asset ? 'image' : d.logo?.startsWith('aws/') ? 'aws' : d.logo ? 'logos' : d.icon ? 'icons' : 'emoji',
    onEmoji: emoji => set({ emoji }),
    onPick: p => {
      if (p.asset) set({ asset: p.asset });
      else if (p.ref.startsWith('lucide/')) set({ icon: p.ref.slice(7) });
      else set(p.dark ? { logo: p.ref, dark: p.dark } : { logo: p.ref });
    },
    onClear: () => set({}),
    clearLabel: 'Default icon',
    clearIcon: 'board',
  });
}
