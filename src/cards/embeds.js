import { esc } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { RO } from '../core/store.js';
import { hostOf } from '../core/sanitize.js';
import { TYPES } from './types.js';

// --- embeds for video / music / design links
export function embedOf(url) {
  let u; try { u = new URL(url); } catch { return null; }
  const h = u.hostname.replace(/^(www|m)\./, '');
  if (h === 'youtube.com' || h === 'youtu.be' || h === 'music.youtube.com') {
    const id = h === 'youtu.be' ? u.pathname.slice(1) : (u.searchParams.get('v') || (u.pathname.match(/^\/(shorts|embed|live)\/([\w-]+)/) || [])[2]);
    if (id && /^[\w-]{6,}$/.test(id)) return { src: `https://www.youtube-nocookie.com/embed/${id}`, ratio: '16/9', kind: 'Video' };
  }
  if (h === 'vimeo.com') { const m = u.pathname.match(/^\/(\d+)/); if (m) return { src: `https://player.vimeo.com/video/${m[1]}`, ratio: '16/9', kind: 'Video' }; }
  if (h === 'open.spotify.com') {
    const m = u.pathname.match(/^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/(\w+)/);
    if (m) return { src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`, height: m[1] === 'track' || m[1] === 'episode' ? 152 : 352, kind: 'Audio' };
  }
  if (h === 'soundcloud.com' && u.pathname.split('/').filter(Boolean).length >= 2) return { src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}&visual=true`, height: 300, kind: 'Audio' };
  if (h === 'loom.com') { const m = u.pathname.match(/^\/share\/(\w+)/); if (m) return { src: `https://www.loom.com/embed/${m[1]}`, ratio: '16/9', kind: 'Video' }; }
  if (h === 'codepen.io') { const m = u.pathname.match(/^\/([\w-]+)\/pen\/(\w+)/); if (m) return { src: `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`, height: 320, kind: 'Pen' }; }
  if (h === 'figma.com' && /^\/(file|design|proto|board)\//.test(u.pathname)) return { src: `https://www.figma.com/embed?embed_host=kolam&url=${encodeURIComponent(url)}`, ratio: '4/3', kind: 'Design' };
  return null;
}

export function init() {
  {
    const baseHtml = TYPES.link.html;
    TYPES.link.html = it => {
      const d = it.data, em = d.url && embedOf(d.url);
      if (!em) return baseHtml(it);
      const host = hostOf(d.url);
      return `<div class="embed" style="${em.ratio ? `aspect-ratio:${em.ratio}` : `height:${em.height}px`}"><iframe src="${esc(em.src)}" loading="lazy" title="${esc(d.title || host)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>` +
        `<div class="lk-body"><div class="lk-title">${esc(d.title || host)}</div><a class="lk-site" href="${esc(d.url)}" target="_blank" rel="noopener" data-nodrag>${icon('open', 13)} ${esc(d.siteName || host)}</a></div>` +
        (RO ? '' : '<div class="embed-hint">Click to select, then play</div>');
    };
  }
}

