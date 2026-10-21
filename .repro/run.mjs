// Mock HERE/Google fetch, then call optimizeRouteClientSide with a 4-stop route.
await import('./here-mock2.mjs');
const mod = await import('./engine.mjs');
const stops = [];
function mk(i, status, patientId, puid, stopId, win) {
  return { id: `D${i}`, stop_id: stopId || `S${i}`, delivery_id: `D${i}`, driver_id: 'drv1', delivery_date: '2026-10-21',
    status, patient_id: patientId || null, puid: puid || null, delivery_time_start: win || null, delivery_time_end: null,
    extra_time: null, is_cycling_marker: false, transport_mode: 'driving',
    latitude: 53.54 + i * 0.01, longitude: -113.49 + i * 0.01, address: `Addr ${i}`, store_id: 'st1' };
}
const deliveries = [
  mk(1, 'pending', 'pt1', 'PU1', null, null),          // windowless pending, has pickup
  mk(2, 'en_route', 'pt2', null, null, '10:00'),        // in-hand with window
  { ...mk(3, 'pending', null, null, 'PU1', '12:00'), latitude: 53.545, longitude: -113.5 }, // pickup 12:00
];
const patients = [
  { id: 'pt1', name: 'P1', latitude: 53.551, longitude: -113.491 },
  { id: 'pt2', name: 'P2', latitude: 53.561, longitude: -113.501 },
];
const stores = [{ id: 'st1', name: 'Store', latitude: 53.546, longitude: -113.4938, delivery_time_start: '09:00', delivery_time_end: '21:00' }];
const appUsers = [{ id: 'au1', user_id: 'drv1', driver_status: 'on_duty', home_latitude: 53.5461, home_longitude: -113.4938 }];
try {
  const res = await mod.optimizeRouteClientSide({
    allDeliveries: deliveries, driverId: 'drv1', deliveryDate: '2026-10-21',
    patients, stores, appUsers, hereApiKey: 'TESTKEY', source: 'repro_test',
  });
  console.log('RESULT success:', res?.success);
  console.log('order:', (res?.stopOrderUpdates || res?.writeBatch || res?.updatedDeliveries || []).length ?? 'n/a');
  console.log('keys:', Object.keys(res || {}).join(','));
  if (res?.debugOrder) console.log('debugOrder:', res.debugOrder.join(' -> '));
} catch (e) {
  console.log('CRASH:', e?.stack?.split('\n').slice(0,4).join('\n') || e);
}
