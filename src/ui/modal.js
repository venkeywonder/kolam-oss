import { $, esc, seeThrough } from '../core/util.js';
import { S, getAsset } from '../core/store.js';

/* ================= modal ================= */
export const modal = $('#modal');
export let modalClose = null;
export function openModal(html, { cls = '', onClose } = {}) {
  closeModal();
  modal.innerHTML = `<div class="modal-card ${cls}">${html}</div>`;
  modal.hidden = false;
  modalClose = onClose || null;
  modal.onclick = e => { if (e.target === modal || e.target.closest('[data-close]')) closeModal(); };
  return $('.modal-card', modal);
}
export function closeModal() {
  if (modal.hidden) return;
  modal.hidden = true;
  const f = modalClose; modalClose = null;
  f?.();
  modal.innerHTML = '';
}
/** In-app replacement for window.confirm: resolves true on OK, false on Cancel / Escape / backdrop.
 *  It has its own overlay, so it stacks over an open modal without closing it. */
export function confirmDialog(title, { body = '', ok = 'OK', danger = false } = {}) {
  return new Promise(res => {
    const back = document.createElement('div');
    back.className = 'confirm-back';
    back.innerHTML = `<div class="modal-card confirm-card" role="alertdialog" aria-modal="true"><h2>${esc(title)}</h2>` +
      (body ? `<p>${esc(body)}</p>` : '') +
      `<div class="m-actions"><button class="btn ghost" data-no>Cancel</button><button class="btn${danger ? ' danger' : ''}" data-ok>${esc(ok)}</button></div></div>`;
    const prev = document.activeElement;
    const done = v => { removeEventListener('keydown', key, true); back.remove(); prev?.focus?.(); res(v); };
    const key = e => {
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === btnOk ? btnNo : btnOk).focus(); }
    };
    back.onclick = e => {
      e.stopPropagation();
      if (e.target.closest('[data-ok]')) done(true);
      else if (e.target === back || e.target.closest('[data-no]')) done(false);
    };
    addEventListener('keydown', key, true);
    document.body.append(back);
    const btnOk = $('[data-ok]', back), btnNo = $('[data-no]', back);
    btnOk.focus();
  });
}
export function lightbox(id) {
  const it = S.items[id]; if (!it) return;
  const card = openModal('<img alt="">', { cls: 'lightbox' });
  const img = $('img', card);
  img.onload = () => img.classList.toggle('see-through', seeThrough(img));
  if (it.data.src) img.src = it.data.src; else getAsset(it.data.asset).then(u => { if (u) img.src = u; });
}
export function downloadText(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export const fileSafe = s => (s || 'board').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'board';
