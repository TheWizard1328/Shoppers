// REAL ROUTE repro: his live 15-stop route, geography-faithful HERE mock
// (nearest-neighbor from the request's own waypoints — emulates HERE's
// drive-time sequencing unbiasedly, ignoring time windows).
const today = (await import('fs')).readFileSync('/tmp/route.json','utf8');
const route = JSON.parse(today);
const patsRaw = JSON.parse((await import('fs')).readFileSync('/tmp/patients.json','utf8'));
const patMap = new Map(patsRaw.map(p=>[p.id,p]));
globalThis.fetch = async (url) => {
  if (String(url).includes('findsequence2')) {
    const u = new URL(String(url));
    const parse = (s) => { const [id, c] = s.split(';'); const [lat, lng] = c.split(',').map(Number); return { id, lat, lng }; };
    const start = parse(u.searchParams.get('start'));
    const dests = []; for (const [k, v] of u.searchParams) if (k.startsWith('destination')) dests.push(parse(v));
    // nearest neighbor
    const out = []; let cur = start; const rem = [...dests];
    while (rem.length) { let bi=0, bd=Infinity; rem.forEach((d,i)=>{const dd=(d.lat-cur.lat)**2+(d.lng-cur.lng)**2; if(dd<bd){bd=dd;bi=i;}}); const [n]=rem.splice(bi,1); out.push(n); cur=n; }
    return { ok: true, json: async () => ({ results: [{ waypoints: [start, ...out] }] }) };
  }
  if (String(url).includes('router.hereapi.com')) {
    return { ok: true, json: async () => ({ routes: [{ sections: [{ polyline: 'CgoCAOIDvwIA', summary: { duration: 240, length: 3000 } }] }] }) };
  }
  return { ok: true, json: async () => ({}) };
};
const mod = await import('./engine.mjs');
const real = route.map(d => {
  const p = patMap.get(d.patient_id) || {};
  return { ...d,
    latitude: p.latitude ?? d.latitude ?? null,
    longitude: p.longitude ?? d.longitude ?? null };
});
const res = await mod.optimizeRouteClientSide({
  deliveries: real, driverId: '68570f3cd01bfa2d2408a9d7', deliveryDate: '2026-10-21',
  patients: patsRaw, stores: [], appUsers: [{ id:'au1', user_id:'68570f3cd01bfa2d2408a9d7', driver_status:'on_duty', home_latitude:53.5461, home_longitude:-113.4938 }],
  hereApiKey: 'TESTKEY', source: 'repro_real_route',
});
console.log('success:', res?.success, 'keys:', Object.keys(res||{}).join(','));
console.log('orderedDeliveryIds:', JSON.stringify((res?.orderedDeliveryIds||[]).map(x=>String(x).slice(0,8))));
const wb = res?.writeBatch || [];
console.log('writeBatch entries:', wb.length, 'sample:', JSON.stringify(wb[0]||{}).slice(0,220));
const order = wb.slice().sort((a,b)=>(a.data?.stop_order||0)-(b.data?.stop_order||0));
console.log('=== ENGINE ORDER ===');
for (const w of order) {
  const d = real.find(r=>r.id===w.id) || {};
  console.log(w.data?.stop_order, '|', (d.delivery_id||'').slice(0,12), '| dts=', d.delivery_time_start, '| eta=', w.data?.delivery_time_eta, '|', w.data?.encoded_polyline ? 'poly' : (w.data?.encoded_polyline===null?'null':'-'));
}
