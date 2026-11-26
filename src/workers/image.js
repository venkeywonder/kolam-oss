/*
 * Prepares a photo for upload off the main thread, so the board stays smooth while many are dropped at once:
 * decodes it, scales it to fit 2400 px when it's bigger (or re-encodes a heavy one), and makes the smaller sizes the
 * board shows when zoomed out (canvas/images.js): ≤128, ≤512 and ≤1280 px on the longest side.
 * In: { file }. Out: { blob, w, h, variants: { t?, s?, m? } } or { error }.
 */
const MAX = 2400;
const TIERS = [['m', 1280], ['s', 512], ['t', 128]];

let webp = null;   // whether this browser can write WebP (Safari writes PNG instead)
async function encode(c, alpha, quality) {
  if (webp !== false) {
    const b = await c.convertToBlob({ type: 'image/webp', quality });
    webp = b.type === 'image/webp';
    if (webp) return b;
  }
  return c.convertToBlob({ type: alpha ? 'image/png' : 'image/jpeg', quality });
}

/** src scaled to fit `long` px, in halving steps so big reductions stay sharp. */
function shrink(src, long) {
  let w = src.width, h = src.height;
  const s = Math.min(1, long / Math.max(w, h)), tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  let cur = src;
  while (w / 2 >= tw * 1.5) { w = Math.round(w / 2); h = Math.round(h / 2); cur = draw(cur, w, h); }
  return draw(cur, tw, th);
}
function draw(src, w, h) {
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return c;
}

self.onmessage = async ({ data: { file } }) => {
  try {
    const bmp = await createImageBitmap(file);
    const w = bmp.width, h = bmp.height, long = Math.max(w, h);
    // formats that may have see-through parts keep them (PNG where WebP can't be written)
    const alpha = !/jpe?g/.test(file.type);
    let blob = file, out = bmp, W = w, H = h;
    if (long > MAX || file.size >= 3e6) {
      out = shrink(bmp, MAX); W = out.width; H = out.height;
      blob = await out.convertToBlob(file.type === 'image/png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.88 });
    }
    const variants = {};
    let from = out;   // each size is made from the one above it
    for (const [t, px] of TIERS) {
      if (px >= Math.max(W, H)) continue;
      from = shrink(from, px);
      variants[t] = await encode(from, alpha, t === 't' ? 0.7 : 0.82);
    }
    bmp.close();
    self.postMessage({ blob, w: W, h: H, variants });
  } catch (e) {
    self.postMessage({ error: String(e?.message || e) });
  }
};
