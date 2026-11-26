/*
 * Uploading a profile picture: check the file against PIC_RULES, then crop (drag and zoom inside the circle), rotate,
 * flip and adjust brightness, contrast and saturation. The result is a PIC_RULES.side square WebP (PNG where the
 * browser can't write WebP; the server re-encodes either as WebP, see server/src/Avatars.php).
 */
import { $, clamp, track } from '../core/util.js';
import { icon } from './icons.js';
import { closeModal, openModal } from './modal.js';
import { toast } from './toast.js';

export const PIC_RULES = { types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxMB: 10, min: 128, max: 8000, ratio: 3, side: 256 };
export const PIC_HINT = `PNG, JPG, WebP or GIF up to ${PIC_RULES.maxMB} MB, at least ${PIC_RULES.min} × ${PIC_RULES.min} px and at most `
  + `${PIC_RULES.max} px on a side, no wider or taller than ${PIC_RULES.ratio}:1.`;

/** The file as an image, or throws saying which rule it breaks. */
export async function readPicture(file) {
  const R = PIC_RULES;
  // some systems leave a file's type blank; the extension says the same
  const ext = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[(file.name || '').split('.').pop().toLowerCase()];
  if (!R.types.includes(file.type || ext || '')) throw new Error('Use a PNG, JPG, WebP or GIF image');
  if (file.size > R.maxMB * 1048576) throw new Error(`That image is larger than ${R.maxMB} MB`);
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That image can’t be read')); i.src = url; });
    const w = im.naturalWidth, h = im.naturalHeight;
    if (Math.min(w, h) < R.min) throw new Error(`That image is ${w} × ${h} px; use one at least ${R.min} × ${R.min} px`);
    if (Math.max(w, h) > R.max) throw new Error(`That image is ${w} × ${h} px; use one at most ${R.max} px on each side`);
    if (Math.max(w, h) / Math.min(w, h) > R.ratio) throw new Error(`That image is too ${w > h ? 'wide' : 'tall'}; use one no more than ${R.ratio}:1`);
    return shrink(im, w, h);
  } finally { URL.revokeObjectURL(url); }
}

/** A canvas copy whose short side is at most 1024 px (enough for the largest zoom), halved in steps so it stays smooth. */
function shrink(im, w, h) {
  let src = im, k = Math.min(1, 1024 / Math.min(w, h));
  do {
    const step = Math.max(k, 0.5), nw = Math.round(w * step), nh = Math.round(h * step);
    const next = document.createElement('canvas'); next.width = nw; next.height = nh;
    const g = next.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, nw, nh);
    src = next; w = nw; h = nh; k /= step;
  } while (k < 0.999);
  return src;
}

const RANGES = [
  ['bri', 'Brightness', 0.5, 1.5],
  ['con', 'Contrast', 0.5, 1.5],
  ['sat', 'Saturation', 0, 2],
];
const FRESH = { zoom: 1, x: 0, y: 0, rot: 0, flip: false, bri: 1, con: 1, sat: 1 };

/** Opens the editor for a picture from readPicture(); resolves with the finished square (a Blob), or null if cancelled. */
export function editPicture(pic) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const card = openModal(`
      <h2>Edit your picture</h2>
      <p>Drag to move it in the circle, and zoom to crop.</p>
      <div class="avx">
        <div class="avx-stage" tabindex="0" role="img" aria-label="Your picture. Drag or use the arrow keys to move it.">
          <canvas></canvas><div class="avx-ring" aria-hidden="true"></div>
        </div>
        <div class="avx-side">
          <label class="avx-range"><span>Zoom</span><input type="range" data-k="zoom" min="1" max="4" step="0.01"></label>
          <div class="avx-btns">
            <button class="btn ghost" type="button" data-act="left" title="Rotate left" aria-label="Rotate left">${icon('rotL', 17)}</button>
            <button class="btn ghost" type="button" data-act="right" title="Rotate right" aria-label="Rotate right">${icon('rotR', 17)}</button>
            <button class="btn ghost" type="button" data-act="flip" title="Flip" aria-label="Flip" aria-pressed="false">${icon('flip', 17)}</button>
          </div>
          ${RANGES.map(([k, label, min, max]) => `<label class="avx-range"><span>${label}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="0.01"></label>`).join('')}
          <button class="ac-link" type="button" data-act="reset">Reset</button>
        </div>
      </div>
      <div class="m-actions"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn" type="button" data-save>Save picture</button></div>`,
      { cls: 'avx-modal', onClose: () => finish(null) });

    const st = { ...FRESH };
    const stage = $('.avx-stage', card), canvas = $('canvas', stage), save = $('[data-save]', card);
    const W = pic.width, H = pic.height;

    // the picture's size on screen relative to the square, after rotating: at zoom 1 its short side just fills it
    const cover = () => {
      const turned = st.rot % 180 !== 0, iw = turned ? H : W, ih = turned ? W : H, k = st.zoom / Math.min(iw, ih);
      return { k, fw: iw * k, fh: ih * k };
    };
    // the picture always covers the whole square
    const keepIn = () => {
      const { fw, fh } = cover();
      st.x = clamp(st.x, -(fw - 1) / 2, (fw - 1) / 2);
      st.y = clamp(st.y, -(fh - 1) / 2, (fh - 1) / 2);
    };
    /** Draws the crop into a size × size square of g. */
    const paint = (g, size) => {
      const { k } = cover(), s = k * size;
      g.clearRect(0, 0, size, size);
      g.save();
      g.imageSmoothingQuality = 'high';
      g.translate(size / 2 + st.x * size, size / 2 + st.y * size);
      if (st.flip) g.scale(-1, 1);
      g.rotate(st.rot * Math.PI / 180);
      g.drawImage(pic, -W * s / 2, -H * s / 2, W * s, H * s);
      g.restore();
    };
    const redraw = () => {
      const px = Math.round(stage.clientWidth * devicePixelRatio);
      if (canvas.width !== px) canvas.width = canvas.height = px;
      paint(canvas.getContext('2d'), px);
      canvas.style.filter = `brightness(${st.bri}) contrast(${st.con}) saturate(${st.sat})`;
      for (const r of card.querySelectorAll('[data-k]')) r.value = st[r.dataset.k];
      $('[data-act=flip]', card).setAttribute('aria-pressed', st.flip);
    };

    card.addEventListener('input', e => {
      const k = e.target.dataset.k; if (!k) return;
      st[k] = +e.target.value;
      if (k === 'zoom') keepIn();
      redraw();
    });
    card.addEventListener('click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'left' || act === 'right') {
        // a quarter turn on screen (the other way round in the picture once it's flipped); the crop turns with it,
        // so the same part stays in the circle
        const d = act === 'left' ? -90 : 90;
        st.rot = (st.rot + (st.flip ? -d : d) + 360) % 360;
        [st.x, st.y] = d > 0 ? [-st.y, st.x] : [st.y, -st.x];
        keepIn(); redraw();
      } else if (act === 'flip') { st.flip = !st.flip; st.x = -st.x; redraw(); }
      else if (act === 'reset') { Object.assign(st, FRESH); redraw(); }
    });
    stage.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); stage.focus();
      const size = stage.clientWidth, x0 = e.clientX, y0 = e.clientY, sx = st.x, sy = st.y;
      stage.classList.add('dragging');
      track(m => { st.x = sx + (m.clientX - x0) / size; st.y = sy + (m.clientY - y0) / size; keepIn(); redraw(); },
        () => stage.classList.remove('dragging'));
    });
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      st.zoom = clamp(st.zoom * Math.exp(-e.deltaY / 400), 1, 4);
      keepIn(); redraw();
    }, { passive: false });
    stage.addEventListener('keydown', e => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault();
      st.x += d[0] * 0.02; st.y += d[1] * 0.02;
      keepIn(); redraw();
    });

    save.addEventListener('click', async () => {
      save.disabled = true;
      try { finish(await render(paint, st)); } catch (err) { save.disabled = false; return toast(err.message); }
      closeModal();
    });
    redraw();
    stage.focus();
  });
}

/** The finished square: the crop at PIC_RULES.side px with the adjustments baked in, as WebP where the browser can. */
async function render(paint, st) {
  const n = PIC_RULES.side, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d', { willReadFrequently: true });
  paint(g, n);
  if (st.bri !== 1 || st.con !== 1 || st.sat !== 1) {
    const im = g.getImageData(0, 0, n, n);
    adjust(im.data, st);
    g.putImageData(im, 0, 0);
  }
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('That picture can’t be saved'))), 'image/webp', 0.86));
}

/** CSS's brightness(), contrast() and saturate() in that order (what the preview shows), on RGBA pixels. */
function adjust(d, { bri, con, sat }) {
  const c255 = (0.5 - 0.5 * con) * 255;
  const s = sat, m = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  const f = v => clamp(clamp(v * bri, 0, 255) * con + c255, 0, 255);
  for (let i = 0; i < d.length; i += 4) {
    const r = f(d[i]), gr = f(d[i + 1]), b = f(d[i + 2]);
    d[i] = m[0] * r + m[1] * gr + m[2] * b;
    d[i + 1] = m[3] * r + m[4] * gr + m[5] * b;
    d[i + 2] = m[6] * r + m[7] * gr + m[8] * b;
  }
}
