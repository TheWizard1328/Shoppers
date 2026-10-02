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
const files = fs.readdirSync('/tmp/tops').filter(f => f.endsWith('.pgm'));
const out = {};
for (const f of files) {
  const { w, h, data } = readPGM('/tmp/tops/' + f);
  // whole top crop + sliding 300px windows
  const found = new Set();
  let arr = new Uint8ClampedArray(w * h);
  for (let k = 0; k < w * h; k++) arr[k] = data[k];
  const whole = tryDecode(arr, w, h);
  if (whole) found.add(whole);
  const win = 300;
  for (let t = 0; t + win <= h; t += 60) {
    const c = new Uint8ClampedArray(w * win);
    for (let y = 0; y < win; y++) for (let x = 0; x < w; x++) c[y * w + x] = data[(t + y) * w + x];
    const r = tryDecode(c, w, win);
    if (r) found.add(r);
  }
  if (found.size) { const store = f.split('_')[0]; out[store] = [...new Set([...(out[store]||[]), ...found])]; console.log(f, JSON.stringify([...found])); }
}
fs.writeFileSync('/tmp/tops.json', JSON.stringify(out, null, 1));
