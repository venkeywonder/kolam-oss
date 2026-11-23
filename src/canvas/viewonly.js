import { S } from '../core/store.js';
import { opensBoard } from '../core/model.js';
import { panStart } from './pointer.js';
import { openBoard } from '../app/navigation.js';

/* ================= view-only interactions ================= */
export function viewCardDown(e, id) {
  if (e.button !== 0 && e.button !== 1) return;
  const it = S.items[id]; if (!it) return;
  if (e.target.closest('a,audio,video,iframe,input,button,[data-nodrag]')) return;
  if (opensBoard(it) && e.target.closest('.bd-icon')) return openBoard(it.data.target);
  panStart(e);
}
