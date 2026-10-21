// SERVER engine harness: same real route + same NN HERE mock as run3.
// Quantifies the client-vs-server divergence (owner Oct 21 report).
const fs = await import('fs');
const route = JSON.parse(fs.readFileSync('/tmp/route.json','utf8'));
const patsRaw = JSON.parse(fs.readFileSync('/tmp/patients.json','utf8'));
const patMap = new Map(patsRaw.map(p=>[p.id,p]));
// SAME NN mock as run3 — identical geography emulation
globalThis.fetch = async (url) => {
  if (String(url).includes('findsequence2')) {
    const u = new URL(String(url));
    const parse = (s) => { const [id, c] = s.split(';'); const [lat, lng] = c.split(',').map(Number); return { id, lat, lng }; };
    const start = parse(u.searchParams.get('start'));
    const dests = []; for (const [k, v] of u.searchParams) if (k.startsWith('destination')) dests.push(parse(v));
    const out = []; let cur = start; const rem = [...dests];
    while (rem.length) { let bi=0, bd=Infinity; rem.forEach((d,i)=>{const dd=(d.lat-cur.lat)**2+(d.lng-cur.lng)**2; if(dd<bd){bd=dd;bi=i;}}); const [n]=rem.splice(bi,1); out.push(n); cur=n; }
    return { ok: true, json: async () => ({ results: [{ waypoints: [start, ...out] }] }) };
  }
  if (String(url).includes('router.hereapi.com')) {
    return { ok: true, json: async () => ({ routes: [{ sections: [{ polyline: 'CgoCAOIDvwIA', summary: { duration: 240, length: 3000 } }] }] }) };
  }
  return { ok: true, json: async () => ({}) };
};
globalThis.Deno = { env: { get: () => null }, serve: (h) => { globalThis.__handler = h; } };
await import('./server.mjs');
const handler = globalThis.__handler;
// Build payload ~ buildServerWaypoints
const locked = route.find(r=>r.isNextDelivery);
const stops = [];
for (const d of route) {
  if (['completed','failed','cancelled'].includes(d.status)) continue;
  if (d.isNextDelivery) continue; // locked stays origin
  const p = patMap.get(d.patient_id) || {};
  const lat = p.latitude ?? d.latitude, lng = p.longitude ?? d.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  const isPickup = !d.patient_id && !d.is_cycling_marker;
  stops.push({ id: d.id, stopId: d.stop_id || d.delivery_id, deliveryId: d.delivery_id,
    puid: d.puid || null, lat, lng, status: d.status, isPickup, isInterStore: String(d.delivery_id||'').startsWith('IS'),
    isCyclingMarker: !!d.is_cycling_marker, deliveryNotes: d.delivery_notes || null, transportMode: d.transport_mode || 'driving',
    extraTime: d.extra_time || null,
    windowStart: d.delivery_time_start || p.time_window_start || null, windowEnd: d.delivery_time_end || p.time_window_end || null,
    deliveryTimeStart: d.delivery_time_start || null,
    currentStopOrder: Number(d.stop_order) || null, estimatedDurationMinutes: Number(d.estimated_duration_minutes) || null,
    patientId: d.patient_id || null });
}
const payload = {
  driverId: '68570f3cd01bfa2d2408a9d7', driverName: 'Robert', deliveryDate: '2026-10-21',
  currentMinutes: 12*60+38,
  origin: { lat: (locked && patMap.get(locked.patient_id)?.latitude) || 53.5461, lng: (locked && patMap.get(locked.patient_id)?.longitude) || -113.4938 },
  home: { lat: 53.5461, lng: -113.4938 },
  startOrder: 13, stops,
  options: { routeInProgress: true, preserveExistingOrder: false, explicitNextDeliveryId: null },
  hereApiKey: 'TESTKEY-1234567890',
};
const res = await handler(new Request('https://test/fn', { method: 'POST', body: JSON.stringify(payload) }));
const out = await res.json();
console.log('raw keys:', Object.keys(out).join(','));
console.log('raw:', JSON.stringify(out).slice(0, 600));
console.log('server success:', out.success, 'orderChanged:', out.routeChanged);
const wb = (out.writeBatch||[]).slice().sort((a,b)=>(a.data?.stop_order||0)-(b.data?.stop_order||0));
console.log('=== SERVER ORDER ===');
for (const w of wb) {
  const d = route.find(r=>r.id===w.id) || {};
  console.log(w.data?.stop_order, '|', (d.delivery_id||'').slice(0,12), '| dts=', d.delivery_time_start, '| eta=', w.data?.delivery_time_eta, '|', w.data?.encoded_polyline ? 'poly' : 'nopoly');
}
