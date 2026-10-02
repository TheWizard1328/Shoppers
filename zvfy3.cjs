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
const pages = {
  page1: ['Beverly','Bonnie Doon','Callingwood','Hamptons','Kingsway','Lakeland Ridge'],
  page2: ['Londonderry','Meadows','Scona','Sherwood Pk Mall','SouthPoint','WestPark'],
};
const CELL = 600, OX = Math.floor((2550 - 4*CELL)/2), OY = Math.floor((3300 - 3*CELL)/2);
let allOk = true;
for (const [page, stores] of Object.entries(pages)) {
  const { w, h, data } = readPGM('/tmp/vfy3/' + page + '.pgm');
  stores.forEach((store, idx) => {
    const [u, p] = creds[store];
    const row = Math.floor(idx / 2);
    const pairCol = (idx % 2) * 2;
    for (let copy = 0; copy < 2; copy++) {
      const cx = OX + (pairCol + copy) * CELL;
      const cy = OY + row * CELL;
      const c = new Uint8ClampedArray(CELL * CELL);
      for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) c[y*CELL+x] = data[(cy+y)*w + (cx+x)];
      const found = new Set();
      for (let t = 0; t + 240 <= CELL; t += 40) {
        const cc = new Uint8ClampedArray(CELL * 240);
        for (let y = 0; y < 240; y++) for (let x = 0; x < CELL; x++) cc[y*CELL+x] = c[(t+y)*CELL+x];
        const r = tryDecode(cc, CELL, 240);
        if (r) found.add(r);
      }
      const okU = found.has(u), okP = found.has(p);
      if (!okU || !okP) allOk = false;
      console.log(page, store, 'copy'+(copy+1), 'user:', okU?'OK':'MISS', 'pass:', okP?'OK':'MISS');
    }
  });
}
console.log(allOk ? 'ALL 24 STICKER INSTANCES ROUND-TRIP OK' : 'SOME FAILED');
