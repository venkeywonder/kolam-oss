/* ================= sanitising ================= */
export const OK_TAGS = new Set(['P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'SPAN', 'CODE', 'PRE']);
export function sanitize(html) {
  const t = document.createElement('template');
  t.innerHTML = html || '';
  const walk = node => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 1) {
        if (!OK_TAGS.has(ch.tagName)) { ch.replaceWith(...ch.childNodes); continue; }
        for (const a of [...ch.attributes]) {
          if (ch.tagName === 'A' && a.name === 'href' && /^(https?:|mailto:)/i.test(a.value)) continue;
          ch.removeAttribute(a.name);
        }
        if (ch.tagName === 'A') { ch.target = '_blank'; ch.rel = 'noopener'; }
        walk(ch);
      } else if (ch.nodeType !== 3) ch.remove();
    }
  };
  walk(t.content);
  return t.innerHTML;
}
export const cleanRT = n => (n.innerText.trim() === '' ? '' : n.innerHTML);
export const safeHex = h => (/^#[0-9a-f]{6}$/i.test(h || '') ? h : '#cccccc');
export const fmtSize = b => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
export function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
