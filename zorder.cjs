const { BrowserMultiFormatReader, RGBLuminanceSource, BinaryBitmap, GlobalHistogramBinarizer, HybridBinarizer, DecodeHintType } = require('@zxing/library');
const fs = require('fs');
function readPGM(p) {
  const buf = fs.readFileSync(p);
  const s = buf.toString('latin1');
  const m = s.match(/^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/);
  const w = +m[1], h = +m[2];
  const off = buf.indexOf(Buffer.from(m[3]), 0) + m[3].length + 1;
  return { w, h, data: buf.subarray(off, off + w * h) };
}
function tryDecode(arr, w, h) {
  const src = new RGBLuminanceSource(arr, w, h);
  for (const B of [GlobalHistogramBinarizer, HybridBinarizer]) {
    try {
      const reader = new BrowserMultiFormatReader();
      const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
      return reader.decodeBitmap(new BinaryBitmap(new B(src)), hints).getText();
    } catch (e) {}
  }
  return null;
}
const { w, h, data } = readPGM('/tmp/all2x.pgm');
const hits = [];
const band = 400, step = 50;
for (let t = 0; t + band <= h; t += step) {
  const c = new Uint8ClampedArray(w * band);
  for (let y = 0; y < band; y++) for (let x = 0; x < w; x++) c[y * w + x] = data[(t + y) * w + x];
  // split left/right halves to catch side-by-side entries
  for (const [half, x0, xw] of [['L', 0, w / 2], ['R', w / 2, w / 2]]) {
    const cc = new Uint8ClampedArray(xw * band);
    for (let y = 0; y < band; y++) for (let x = 0; x < xw; x++) cc[y * xw + x] = data[(t + y) * w + (x0 + x)];
    const r = tryDecode(cc, xw, band);
    if (r) hits.push({ y: t, half, text: r });
  }
}
// dedupe: keep first hit per unique text by y
const seen = new Map();
for (const hit of hits.sort((a, b) => a.y - b.y)) {
  if (!seen.has(hit.text)) seen.set(hit.text, hit);
}
const ordered = [...seen.values()].sort((a, b) => a.y - b.y || a.half.localeCompare(b.half));
for (const o of ordered) console.log(o.y, o.half, o.text);
