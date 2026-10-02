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
  page1: ['Hamptons','Callingwood','Beverly','Londonderry','Kingsway','Bonnie Doon','Sherwood Pk Mall','Lakeland Ridge','Scona','Meadows'],
  page2: ['WestPark','SouthPoint'],
};
const CELL = 600, OX = Math.floor((2550 - 4*CELL)/2), OY = 150;
let allOk = true;
for (const [page, stores] of Object.entries(pages)) {
  const { w, h, data } = readPGM('/tmp/vfy9/' + page + '.pgm');
  stores.forEach((store, idx) => {
    const [u, p] = creds[store];
    const row = Math.floor(idx / 2), pairCol = (idx % 2) * 2;
    for (let copy = 0; copy < 2; copy++) {
      const cx = OX + (pairCol + copy) * CELL, cy = OY + row * CELL;
      const cell = new Uint8ClampedArray(CELL * CELL);
      for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) cell[y*CELL+x] = data[(cy+y)*w + (cx+x)];
      const found = [];
      for (let t = 0; t + 240 <= CELL; t += 30) {
        const cc = new Uint8ClampedArray(CELL * 240);
        for (let y = 0; y < 240; y++) for (let x = 0; x < CELL; x++) cc[y*CELL+x] = cell[(t+y)*CELL+x];
        const r = tryDecode(cc, CELL, 240);
        if (r && !found.includes(r)) found.push(r);
      }
      const expectU = u + '\r', expectP = p + '\r';
      const ok = found.length === 2 && found[0] === expectU && found[1] === expectP;
      if (!ok) { allOk = false; console.log('MISMATCH', page, store, 'copy'+(copy+1), 'expected:', JSON.stringify(expectU), JSON.stringify(expectP), 'got:', JSON.stringify(found)); }
    }
  });
}
console.log(allOk ? 'ALL 24 OK on 4x5 grid (20/sheet) layout' : 'FAILURES');
