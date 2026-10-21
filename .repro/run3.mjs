// REAL ROUTE repro: his live 15-stop route, geography-faithful HERE mock
// (nearest-neighbor from the request's own waypoints — emulates HERE's
// drive-time sequencing unbiasedly, ignoring time windows).
const today = (await import('fs')).readFileSync('/tmp/route.json','utf8');
const route = JSON.parse(today);
const patsRaw = JSON.parse((await import('fs')).readFileSync('/tmp/patients.json','utf8'));
const patMap = new Map(patsRaw.map(p=>[p.id,p]));
await import('./here-mock2.mjs');
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
