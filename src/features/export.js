import { $ } from '../core/util.js';
import { canvas, world } from '../core/dom.js';
import { S, cur, sel, selLine, setSelLine } from '../core/store.js';
import { V, applyView, itemRect } from '../canvas/viewport.js';
import { childrenOf, itemsOf } from '../core/model.js';
import { sanitize } from '../core/sanitize.js';
import { refreshSel } from '../canvas/selection.js';
import { exitEdit } from '../canvas/editing.js';
import { plain } from '../ui/search.js';
import { toast } from '../ui/toast.js';
import { fileSafe } from '../ui/modal.js';
import { evalCell } from '../cards/table.js';
import { bodyText, commentsOf } from './comments.js';

/* ================= export ================= */
export function loadScript(src) {
  return new Promise((res, rej) => {
    if ($(`script[src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
export async function exportPNG() {
  const tops = itemsOf(cur).filter(i => !i.col);
  if (!tops.length) return toast('Nothing on this board to export');
  exitEdit(); sel.clear(); setSelLine(null); refreshSel();
  toast('Rendering image…');
  try { await loadScript('https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/dist/html-to-image.js'); }
  catch { return toast('Couldn’t load the image exporter (offline?)'); }
  const v = V(), saved = { ...v };
  v.x = 0; v.y = 0; v.z = 1; applyView();
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const it of tops) { const r = itemRect(it.id); if (!r) continue; x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h); }
  for (const ln of Object.values(S.lines)) { if (ln.board !== cur) continue; for (const e of [ln.a, ln.b]) if (!e.item) { x1 = Math.min(x1, e.x); y1 = Math.min(y1, e.y); x2 = Math.max(x2, e.x); y2 = Math.max(y2, e.y); } }
  const pad = 48; x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
  const opts = {
    width: Math.ceil(x2 - x1), height: Math.ceil(y2 - y1), pixelRatio: Math.min(2, 8000 / Math.max(x2 - x1, y2 - y1)),
    backgroundColor: getComputedStyle(canvas).backgroundColor,
    style: { transform: `translate(${-x1}px,${-y1}px)` },
    imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    filter: n => !(n.tagName === 'IFRAME' || n.classList?.contains('conn') || n.classList?.contains('rz-set')),
  };
  let url = null;
  try { url = await htmlToImage.toPng(world, opts); }
  catch { try { url = await htmlToImage.toPng(world, { ...opts, skipFonts: true }); } catch (e) { console.error(e); } }
  Object.assign(v, saved); applyView();
  if (!url) return toast('Export failed');
  const a = document.createElement('a'); a.href = url; a.download = fileSafe(S.boards[cur].title) + '.png'; a.click();
  toast('PNG downloaded');
}
export function htmlToMd(html) {
  const t = document.createElement('template'); t.innerHTML = sanitize(html);
  const walk = n => {
    let out = '';
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { out += c.textContent; continue; }
      const inner = () => walk(c);
      switch (c.tagName) {
        case 'H1': out += '\n# ' + inner().trim() + '\n\n'; break;
        case 'H2': out += '\n## ' + inner().trim() + '\n\n'; break;
        case 'H3': out += '\n### ' + inner().trim() + '\n\n'; break;
        case 'P': case 'DIV': out += inner().trim() + '\n\n'; break;
        case 'BR': out += '\n'; break;
        case 'B': case 'STRONG': { const x = inner(); out += x.trim() ? `**${x}**` : x; break; }
        case 'I': case 'EM': { const x = inner(); out += x.trim() ? `*${x}*` : x; break; }
        case 'S': case 'STRIKE': out += `~~${inner()}~~`; break;
        case 'CODE': out += '`' + inner() + '`'; break;
        case 'A': out += `[${inner()}](${c.getAttribute('href') || ''})`; break;
        case 'UL': [...c.children].forEach(li => (out += '- ' + walk(li).trim() + '\n')); out += '\n'; break;
        case 'OL': [...c.children].forEach((li, i) => (out += `${i + 1}. ` + walk(li).trim() + '\n')); out += '\n'; break;
        case 'BLOCKQUOTE': out += inner().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n'; break;
        default: out += inner();
      }
    }
    return out;
  };
  return walk(t.content).replace(/\n{3,}/g, '\n\n').trim();
}
export function itemToMd(it, depth) {
  const d = it.data || {}, hd = n => '#'.repeat(Math.min(6, n));
  switch (it.type) {
    case 'note': case 'text': return htmlToMd(d.html);
    case 'todo': return `**${d.title || 'To-do'}**\n\n` + (d.tasks || []).map(t => `- [${t.done ? 'x' : ' '}] ${t.t}${t.due ? ` (due ${t.due})` : ''}`).join('\n');
    case 'link': return d.url ? `[${d.title || d.url}](${d.url})${d.desc ? '\n\n' + d.desc : ''}` : '';
    case 'image': return `*[Image${d.caption ? ': ' + plain(d.caption) : ''}]*`;
    case 'file': return `*[File: ${d.name}]*`;
    case 'column': return `${hd(depth + 1)} ${d.title || 'Column'}\n\n` + childrenOf(it.id).map(k => itemToMd(k, depth + 1)).filter(Boolean).join('\n\n');
    case 'board': return boardToMd(d.target, depth + 1);
    case 'shortcut': return `*[Shortcut to: ${S.boards[d.target]?.title || 'a board'}]*`;
    case 'comment': return commentsOf(it.id).map(c => `> **${c.name}:** ${bodyText(c.body)}`).join('\n>\n');
    case 'table': {
      const rows = d.rows.map((r, ri) => r.map((_, ci) => String(evalCell(d.rows, ri, ci)).replace(/\|/g, '\\|')));
      const head = rows[0], body = rows.slice(1);
      return `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n` + body.map(r => `| ${r.join(' | ')} |`).join('\n');
    }
    case 'doc': return `${hd(depth + 1)} ${d.title || 'Untitled document'}\n\n` + htmlToMd(d.html);
    case 'swatch': return `Colour \`${d.hex}\``;
    case 'icon': return d.label ? `*[Icon: ${d.label}]*` : '';
    case 'group': return d.title ? `${hd(depth + 1)} ${d.title}` : '';
    default: return '';
  }
}
export function boardToMd(bid, depth = 1) {
  const b = S.boards[bid]; if (!b) return '';
  const tops = itemsOf(bid).filter(i => !i.col).sort((a, c) => (Math.round(a.y / 80) - Math.round(c.y / 80)) || a.x - c.x);
  return `${'#'.repeat(Math.min(6, depth))} ${b.title}\n\n` + tops.map(i => itemToMd(i, depth)).filter(Boolean).join('\n\n');
}
export const mdToText = md => md.replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/~~(.*?)~~/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)').replace(/^> ?/gm, '');
