import { $ } from '../core/util.js';
import { API_BASE } from '../core/api.js';
import { S, SPACE, putAsset, redoStack, save, setCur, setS, undoStack } from '../core/store.js';
import { render } from '../canvas/render.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/modal.js';
import { zipBlob, zipEntries } from '../core/zip.js';

/*
 * Backups: the server streams the space as a ZIP (data.json, boards as Markdown, every file as it is: Export.php), so
 * a board with gigabytes of files never has to fit in the browser. Restoring reads that ZIP in place and uploads its
 * files one by one; an older .json backup (files inside as data: URLs) still restores too.
 */
export function exportAll() {
  location.href = `${API_BASE}spaces/${encodeURIComponent(SPACE)}/backup`;
}

/** The backup in a file: { o: data.json, file: id -> () => Promise<File> } */
async function readBackup(f) {
  if (!/\.zip$/i.test(f.name) && !/zip/.test(f.type)) {
    const o = JSON.parse(await f.text());
    const file = {};
    for (const [id, d] of Object.entries(o.assets || {})) {
      if (typeof d === 'string' && d.startsWith('data:')) file[id] = async () => new File([await (await fetch(d)).blob()], id);
    }
    return { o, file };
  }
  const entries = await zipEntries(f);
  const found = [...entries.keys()].filter(n => n === 'data.json' || n.endsWith('/data.json'));
  if (!found.length) throw new Error('there’s no data.json in it');
  // a whole-account export has a folder per workspace
  if (found.length > 1) throw new Error('it holds several workspaces. Unzip it and zip the folder of the one to restore');
  const base = found[0].slice(0, -'data.json'.length);
  const o = JSON.parse(await (await zipBlob(f, entries.get(found[0]))).text());
  const file = {};
  for (const [id, m] of Object.entries(o.files || {})) {
    const e = entries.get(base + m.path);
    if (e) file[id] = async () => new File([await zipBlob(f, e)], m.name || id, { type: m.mime || '' });
  }
  return { o, file };
}

export function init() {
  $('#importPick').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const { o, file } = await readBackup(f);
      if (o.app !== 'kolam' || !o.state?.boards?.home) throw new Error('not a Kolam backup');
      if (!await confirmDialog('Replace your current boards?', { body: 'Your boards will be replaced with the imported file.', ok: 'Replace', danger: true })) return;
      // files go up a few at a time (each in parts, resuming after a dropped connection: core/upload.js)
      const ids = Object.keys(file), remap = {};
      let done = 0;
      const next = async () => {
        for (let id; (id = ids.shift());) {
          const blob = await file[id]();
          remap[id] = await putAsset(blob, blob.name);
          toast(`Importing files… ${++done} of ${Object.keys(file).length}`);
        }
      };
      toast('Importing…');
      await Promise.all([next(), next(), next()]);
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
