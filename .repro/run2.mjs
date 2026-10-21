// Degrado-repro: appUsers EMPTY + DB fallback HANGS (pool hot) — the exact
// state his device was in at 17:17-17:18.
await import('./here-mock.mjs');
const mod = await import('./engine.mjs');
function mk(i, status, patientId, puid, stopId, win) {
  return { id: `D${i}`, stop_id: stopId || `S${i}`, delivery_id: `D${i}`, driver_id: 'drv1', delivery_date: '2026-10-21',
    status, patient_id: patientId || null, puid: puid || null, delivery_time_start: win || null, delivery_time_end: null,
    extra_time: null, is_cycling_marker: false, transport_mode: 'driving',
    latitude: 53.54 + i * 0.01, longitude: -113.49 + i * 0.01, address: `Addr ${i}`, store_id: 'st1',
    stop_order: i };
}
const deliveries = [
  mk(1, 'pending', 'pt1', 'PU1', null, null),
  mk(2, 'en_route', 'pt2', null, null, '10:00'),
  { ...mk(3, 'pending', null, null, 'PU1', '12:00'), latitude: 53.545, longitude: -113.5 },
  { ...mk(4, 'completed', 'pt3', 'PU1', null, '12:00'), status: 'completed', actual_delivery_time: '2026-10-21T11:00:00' },
];
const patients = [
  { id: 'pt1', name: 'P1', latitude: 53.551, longitude: -113.491 },
  { id: 'pt2', name: 'P2', latitude: 53.561, longitude: -113.501 },
  { id: 'pt3', name: 'P3', latitude: 53.555, longitude: -113.495 },
];
const stores = [{ id: 'st1', name: 'Store', latitude: 53.546, longitude: -113.4938, delivery_time_start: '09:00', delivery_time_end: '21:00' }];
try {
  const res = await mod.optimizeRouteClientSide({
    allDeliveries: deliveries, driverId: 'drv1', deliveryDate: '2026-10-21',
    patients, stores, appUsers: [], hereApiKey: 'TESTKEY', source: 'repro_degraded',
  });
  console.log('RESULT success:', res?.success, 'keys:', Object.keys(res || {}).join(','));
} catch (e) {
  console.log('CRASH:', (e && e.stack ? e.stack.split('\n').slice(0,6).join('\n') : String(e)));
}
