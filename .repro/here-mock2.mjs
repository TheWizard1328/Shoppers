// Shared realistic HERE mock: NN findsequence2 + Router v8 returning one
// proper flexible-polyline section per leg (header included, curved points).
const encVarint = (v) => {
  let value = v, chunks = [];
  do { let c = value & 0x1f; value >>>= 5; if (value > 0) c |= 0x20; chunks.push(String.fromCharCode(c + 63)); } while (value > 0);
  return chunks.join('');
};
const zig = (n) => (n < 0 ? (-n << 1) - 1 : n << 1); // unsafe >2^31 but coords*1e5 < 2^31 ok for Edmonton
const flexEnc = (coords) => {
  let out = encVarint(1) + encVarint(5); // version=1, precision 5, thirdDim absent
  let pl = 0, pg = 0;
  for (const [la, ln] of coords) {
    const l = Math.round(la * 1e5), g = Math.round(ln * 1e5);
    out += encVarint(zig(l - pl)) + encVarint(zig(g - pg));
    pl = l; pg = g;
  }
  return out;
};
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('findsequence2')) {
    const U = new URL(u);
    const parse = (s) => { const [id, c] = s.split(';'); const [lat, lng] = c.split(',').map(Number); return { id, lat, lng }; };
    const start = parse(U.searchParams.get('start'));
    const dests = []; for (const [k, v] of U.searchParams) if (k.startsWith('destination')) dests.push(parse(v));
    const out = []; let cur = start; const rem = [...dests];
    while (rem.length) { let bi=0, bd=Infinity; rem.forEach((d,i)=>{const dd=(d.lat-cur.lat)**2+(d.lng-cur.lng)**2; if(dd<bd){bd=dd;bi=i;}}); const [n]=rem.splice(bi,1); out.push(n); cur=n; }
    return { ok: true, json: async () => ({ results: [{ waypoints: [start, ...out] }] }) };
  }
  if (u.includes('router.hereapi.com')) {
    const U = new URL(u);
    const o = U.searchParams.get('origin').split(',').map(Number);
    const d = U.searchParams.get('destination').split(',').map(Number);
    const vias = (U.searchParams.get('via') ? [U.searchParams.get('via')] : []).flatMap(x => [x]);
    // via may appear multiple times
    const all = [o, ...U.searchParams.getAll('via').map(v=>v.split(',').map(Number)), d];
    const sections = [];
    for (let i = 0; i < all.length - 1; i++) {
      const [a, b] = [all[i], all[i+1]];
      const mid = [(a[0]+b[0])/2 + 0.001, (a[1]+b[1])/2 + 0.001]; // curved mid point
      sections.push({ polyline: flexEnc([[a[0], a[1]], mid, [b[0], b[1]]]), summary: { duration: 180 + i * 17, length: 2500 + i * 400 } });
    }
    return { ok: true, json: async () => ({ routes: [{ sections }] }) };
  }
  return { ok: true, json: async () => ({}) };
};
// Google Directions mock (server parity test)
const gEnc = (coords) => { // standard Google polyline encode 1e5
  const ev = (v) => { let s=''; v = v < 0 ? (-v*2-1) : (v*2); while (v >= 0x20) { s += String.fromCharCode((0x20+(v%0x20))+63); v = Math.floor(v/0x20); } return s + String.fromCharCode(v+63); };
  let pl=0, pg=0, out='';
  for (const [la,ln] of coords) { const l=Math.round(la*1e5), g=Math.round(ln*1e5); out += ev(l-pl)+ev(g-pg); pl=l; pg=g; }
  return out;
};
const _origFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('maps.googleapis.com')) {
    const U = new URL(String(url));
    const o = U.searchParams.get('origin').split(',').map(Number);
    const d = U.searchParams.get('destination').split(',').map(Number);
    const wps = (U.searchParams.get('waypoints') || '').split('|').filter(Boolean).map(w=>w.split(',').map(Number));
    const all = [o, ...wps, d];
    const legs = [];
    for (let i = 0; i < all.length - 1; i++) {
      const [a,b] = [all[i], all[i+1]];
      const mid = [(a[0]+b[0])/2 + 0.002, (a[1]+b[1])/2 + 0.002];
      const pts = gEnc([[a[0],a[1]], mid, [b[0],b[1]]]);
      legs.push({ distance: { value: 2100 + i*350 }, duration: { value: 200 + i*21 }, steps: [{ polyline: { points: pts } }, { polyline: { points: gEnc([mid, [b[0], b[1]]]) } }] });
    }
    return { ok: true, json: async () => ({ routes: [{ legs }] }) };
  }
  return _origFetch(url);
};
