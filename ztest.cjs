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
const { w, h, data } = readPGM('/tmp/pgms/test128.pgm');
const arr = new Uint8ClampedArray(w * h);
for (let k = 0; k < w * h; k++) arr[k] = data[k];
const src = new RGBLuminanceSource(arr, w, h);
for (const B of [GlobalHistogramBinarizer, HybridBinarizer]) {
  try {
    const reader = new BrowserMultiFormatReader();
    const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
    const bitmap = new BinaryBitmap(new B(src));
    const res = reader.decodeBitmap(bitmap, hints) || reader.decode(bitmap, hints);
    console.log('DECODED:', B.name, JSON.stringify(res.getText()));
    process.exit(0);
  } catch (e) { console.log(B.name, 'failed:', e.message, '| has decodeBitmap:', typeof reader.decodeBitmap, '| decode:', typeof reader.decode); }
}
