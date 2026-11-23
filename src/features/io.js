import { $ } from '../core/util.js';
import { S, cur, getAsset, putAsset, redoStack, save, setCur, setS, undoStack } from '../core/store.js';
import { render } from '../canvas/render.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/modal.js';

/* ---------- full backup export / import (JSON with embedded files) ---------- */
const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

export async function exportAll() {
  toast('Preparing your backup…');
  const used = new Set(Object.values(S.items).map(i => i.data?.asset).filter(Boolean));
  const out = {};
  for (const id of used) {
    try { const r = await fetch(await getAsset(id)); if (r.ok) out[id] = await blobToDataUrl(await r.blob()); } catch {}
  }
  const { views, ...state } = S;
  const blob = new Blob([JSON.stringify({ app: 'kolam', version: 2, exportedAt: new Date().toISOString(), state, assets: out })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `kolam-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function init() {
  $('#importPick').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const o = JSON.parse(await f.text());
      if (o.app !== 'kolam' || !o.state?.boards?.home) throw new Error('not a Kolam export');
      if (!await confirmDialog('Replace your current boards?', { body: 'Your boards will be replaced with the imported file.', ok: 'Replace', danger: true })) return;
      toast('Importing…');
      const remap = {};
      for (const [id, d] of Object.entries(o.assets || {})) {
        if (typeof d !== 'string' || !d.startsWith('data:')) continue;
        const blob = await (await fetch(d)).blob();
        remap[id] = await putAsset(blob, id);
      }
      for (const it of Object.values(o.state.items || {})) if (it.data?.asset && remap[it.data.asset]) it.data.asset = remap[it.data.asset];
      // comments in the backup go back to their cards; the server turns them into comments by you
      const { comments, threads, cnames, ...state } = o.state;
      for (const c of Object.values(comments || {})) {
        const it = state.items?.[c.item];
        if (it && c.body) (it.data.thread ||= []).push({ text: c.body, at: c.at });
      }
      setS({ ...state, views: S.views || {}, items: state.items || {}, lines: state.lines || {}, trash: state.trash || [] });
      undoStack.length = redoStack.length = 0;
      setCur('home'); location.hash = '#/b/home';
      save(); render(); toast('Imported');
    } catch (err) { toast('Import failed: ' + err.message); }
  });
}
