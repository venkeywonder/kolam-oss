/*
 * Reads a .zip File without loading it whole: the central directory from the end of the file, then each entry as a
 * slice of the file (stored) or streamed through DecompressionStream (deflated). Handles ZIP64, which Kolam's own
 * exports use once they pass 4 GB (server/src/ZipStream.php).
 */
const u32 = (v, at) => v.getUint32(at, true), u16 = (v, at) => v.getUint16(at, true);
const u64 = (v, at) => Number(v.getBigUint64(at, true));
const bad = () => new Error('the ZIP file is damaged');
const view = async (file, from, to) => new DataView(await file.slice(from, to).arrayBuffer());

/** Map of entry path -> { name, method, size, csize, off }. */
export async function zipEntries(file) {
  const tailFrom = Math.max(0, file.size - (22 + 65535 + 20));
  const tail = await view(file, tailFrom, file.size);
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('that isn’t a ZIP file');
  let count = u16(tail, end + 10), cdSize = u32(tail, end + 12), cdOff = u32(tail, end + 16);
  // ZIP64: a locator just before the end record points at the 64-bit end record
  if (end >= 20 && u32(tail, end - 20) === 0x07064b50) {
    const at = u64(tail, end - 12), z = await view(file, at, at + 56);
    if (u32(z, 0) !== 0x06064b50) throw bad();
    count = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48);
  }
  const cd = await view(file, cdOff, cdOff + cdSize), dec = new TextDecoder();
  const out = new Map();
  for (let n = 0, p = 0; n < count; n++) {
    if (u32(cd, p) !== 0x02014b50) throw bad();
    const method = u16(cd, p + 10), nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
    let csize = u32(cd, p + 20), size = u32(cd, p + 24), off = u32(cd, p + 42);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    // ZIP64 extra field: 64-bit values for those of size, compressed size and offset that read 0xFFFFFFFF, in that order
    for (let q = p + 46 + nlen, stop = q + xlen; q + 4 <= stop; q += 4 + u16(cd, q + 2)) {
      if (u16(cd, q) !== 1) continue;
      let r = q + 4;
      if (size === 0xFFFFFFFF) { size = u64(cd, r); r += 8; }
      if (csize === 0xFFFFFFFF) { csize = u64(cd, r); r += 8; }
      if (off === 0xFFFFFFFF) off = u64(cd, r);
    }
    out.set(name, { name, method, size, csize, off });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** An entry's contents as a Blob (a stored entry is a slice of the file: nothing is read until it's used). */
export async function zipBlob(file, e) {
  const h = await view(file, e.off, e.off + 30);
  if (u32(h, 0) !== 0x04034b50) throw bad();
  const start = e.off + 30 + u16(h, 26) + u16(h, 28), raw = file.slice(start, start + e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
  throw new Error('the ZIP file uses a compression Kolam can’t read');
}
