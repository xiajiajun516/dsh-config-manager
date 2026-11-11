
import fs from 'node:fs';
import zlib from 'node:zlib';
function decode(p) {
  const b = fs.readFileSync(p);
  let off = 8, w = 0, h = 0, bitDepth = 8, colorType = 6, idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off); const type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const row = raw.subarray(pos, pos + stride); pos += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, bb = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (ft === 1) v += a; else if (ft === 2) v += bb; else if (ft === 3) v += (a + bb) >> 1;
      else if (ft === 4) { const pp = a + bb - c; const pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c); }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, px: out };
}
function avg(img, x0, y0, x1, y1) {
  let r = 0, g = 0, bl = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.w + x) * img.ch;
    r += img.px[i]; g += img.px[i + 1]; bl += img.px[i + 2]; n++;
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
}
const file = process.argv[2];
const img = decode(file);
console.log(file, img.w + 'x' + img.h);
for (const spec of process.argv.slice(3)) {
  const [x0, y0, x1, y1] = spec.split(',').map(Number);
  console.log('  ' + spec + ' -> #' + avg(img, x0, y0, x1, y1).map(v => v.toString(16).padStart(2, '0')).join(''));
}
