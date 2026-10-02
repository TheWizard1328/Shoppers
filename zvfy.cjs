const { BrowserMultiFormatReader, RGBLuminanceSource, BinaryBitmap, GlobalHistogramBinarizer, HybridBinarizer, DecodeHintType } = require('@zxing/library');
const fs = require('fs');
const creds = JSON.parse(fs.readFileSync('/app/conversations/69f0c699777455158d804588/store_credentials.json'));
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
let allOk = true;
for (const [store, [u, p]] of Object.entries(creds)) {
  const f = '/tmp/vfy/' + store.replace(/ /g, '_') + '.pgm';
  const { w, h, data } = readPGM(f);
  const arr = new Uint8ClampedArray(w * h);
  for (let k = 0; k < w * h; k++) arr[k] = data[k];
  // slide a 500px-tall window to find both barcodes
  const found = new Set();
  for (let t = 0; t + 500 <= h; t += 100) {
    const c = new Uint8ClampedArray(w * 500);
    for (let y = 0; y < 500; y++) for (let x = 0; x < w; x++) c[y * w + x] = data[(t + y) * w + x];
    const r = tryDecode(c, w, 500);
    if (r) found.add(r);
  }
  const okU = found.has(u), okP = found.has(p);
  if (!(okU && okP)) allOk = false;
  console.log(store, 'user:', okU ? 'OK' : 'MISS', 'pass:', okP ? 'OK' : 'MISS', found.size ? '' : JSON.stringify([...found]));
}
console.log(allOk ? 'ALL STICKERS ROUND-TRIP OK' : 'FAILURES PRESENT');
