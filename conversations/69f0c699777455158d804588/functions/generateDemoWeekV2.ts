import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Compact demo week generator — fetches real stores/drivers from DB
const toRad = (d: number) => d * Math.PI / 180;
const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};
const offsetCoords = (lat: number, lon: number, km: number, angle: number) => {
  const R = 6371, br = toRad(angle), lr = toRad(lat), ad = km/R;
  const nl = Math.asin(Math.sin(lr)*Math.cos(ad) + Math.cos(lr)*Math.sin(ad)*Math.cos(br));
  const nlon = toRad(lon) + Math.atan2(Math.sin(br)*Math.sin(ad)*Math.cos(lr), Math.cos(ad)-Math.sin(lr)*Math.sin(nl));
  return { latitude: +(nl*180/Math.PI).toFixed(6), longitude: +(nlon*180/Math.PI).toFixed(6) };
};
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random()*arr.length)];
const randInt = (a: number, b: number) => Math.floor(Math.random()*(b-a+1))+a;
const rand = (a: number, b: number) => Math.random()*(b-a)+a;
const addDays = (d: Date, n: number) => { const r = new Date(d); r.setDate(r.getDate()+n); return r; };
const fmtDate = (d: Date) => d.toISOString().split('T')[0];
const buildDT = (d: Date, time: string) => `${fmtDate(d)}T${time}:00`;
const h2m = (t: string) => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const m2h = (m: number) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const addMin = (t: string, n: number) => m2h(h2m(t)+n);
const genId = (len: number) => Array.from({length:len}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[randInt(0,53)]).join('');

const streetNames = ['Maple','Oak','Cedar','Pine','Spruce','River','Lake','Hill','Park','Elm','Sunset','Meadow','82','104','118','137','156','170','178','199','Jasper','Whyte','Calgary','St Albert','111','124','66','50'];
const streetTypes = ['Street','Avenue','Road','Drive','Boulevard','Lane','Court','Crescent','Place','Way'];
const firstNames = ['Emma','Olivia','Sophia','Ava','Mia','Amelia','Sarah','Jennifer','Michael','David','James','Robert','William','Linda','Patricia','Susan','Karen','Nancy','Lisa','Betty','Margaret','Sandra','Ashley','Kimberly','Emily','Donna','Carol','Michelle','Laura','Heather','Stephen','Chris','Mark','Daniel','Matthew','Andrew','Joseph','Thomas'];
const lastNames = ['Johnson','Smith','Brown','Taylor','Wilson','Martin','Lee','Clark','Young','Hall','Allen','King','Wright','Lopez','Hill','Scott','Green','Adams','Baker','Nelson','Carter','Mitchell','Roberts','Turner','Phillips','Campbell','Parker','Evans','Edwards','Collins','Stewart','Sanchez','Morris','Rogers','Reed','Cook','Morgan','Bell','Murphy','Bailey','Rivera','Cooper','Cox','Howard','Ward','Torres','Peterson','Gray','Ramirez','James','Watson','Brooks','Russell','Griffin','Hayes','Myers','Price','Bennett','Wood','Barnes','Ross','Henderson','Coleman','Jenkins','Perry','Powell','Long','Patterson','Hughes','Flores','Washington','Butler','Simmons','Foster','Bryant','Alexander','Robinson','Shaw','Garcia'];

// InterStore locations
const IS_LOCS = [
  { name: 'Millbourne Mall', lat: 53.4718923, lon: -113.4509796, addr: '188 38 Ave & Millwoods Rd', phone: '7804624704', num: '319' },
  { name: 'Millwoods TC', lat: 53.4558049, lon: -113.4297839, addr: '2331 66th St NW', phone: '7804611121', num: '346' },
  { name: 'Oliver Place', lat: 53.5413027, lon: -113.5238734, addr: '11720 Jasper Ave NW', phone: '7804821011', num: '365' },
  { name: 'Cromdale', lat: 53.5702047, lon: -113.466827, addr: '8121 118 Ave NW', phone: '7804771540', num: '370' },
  { name: 'West Edmonton Mall', lat: 53.5221441, lon: -113.6185465, addr: '8882 170th Street NW', phone: '7804444591', num: '3241' },
  { name: 'Jasper Gate Mall', lat: 53.5417269, lon: -113.5809445, addr: '10116 150 Street NW', phone: '7804879636', num: '2443' },
  { name: 'Calgary Trail', lat: 53.4877045, lon: -113.4927316, addr: '5050 Gateway Blvd NW', phone: '7804092011', num: '3734' },
  { name: 'Skyview', lat: 53.60008449999999, lon: -113.5464838, addr: '13040 137th Ave', phone: '7804564330', num: '397' },
];

function genPatients(storeLat: number, storeLon: number, count: number) {
  const patients = [];
  for (let i = 0; i < count; i++) {
    const dist = rand(0.3, 18);
    const angle = rand(0, 360);
    const coords = offsetCoords(storeLat, storeLon, dist, angle);
    patients.push({
      full_name: `${pick(firstNames)} ${pick(lastNames)}`,
      address: `${randInt(100, 9999)} ${pick(streetNames)} ${pick(streetTypes)}`,
      latitude: coords.latitude, longitude: coords.longitude,
      distance_from_store: +dist.toFixed(2),
      phone: `(780) ${randInt(200, 999)}-${String(randInt(1000, 9999)).padStart(4, '0')}`,
      notes: pick(['Leave at front desk', 'Ring bell twice', 'Call on arrival', 'Side entrance', 'Fragile package', 'Mailbox OK', 'Back door', '']),
      mailbox_ok: Math.random() > 0.5, call_upon_arrival: Math.random() > 0.6,
      ring_bell: Math.random() > 0.2, dont_ring_bell: Math.random() > 0.85,
      back_door: Math.random() > 0.8,
      time_window_start: pick(['09:00','10:00','11:00','13:00','14:00']),
      time_window_end: pick(['12:00','14:00','16:00','18:00','20:00']),
    });
  }
  return patients;
}

function sortNN(storeLat: number, storeLon: number, patients: any[]) {
  const remaining = [...patients], sorted: any[] = [];
  let cLat = storeLat, cLon = storeLon;
  while (remaining.length > 0) {
    let minIdx = 0, minDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(cLat, cLon, remaining[i].latitude, remaining[i].longitude);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    const next = remaining.splice(minIdx, 1)[0];
    sorted.push(next); cLat = next.latitude; cLon = next.longitude;
  }
  return sorted;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const weekStart = body.week_start_date ? new Date(body.week_start_date) : (() => {
      const d = new Date(); const dow = d.getDay();
      const daysUntilMon = dow === 0 ? 1 : 8 - dow;
      d.setDate(d.getDate() + daysUntilMon); return d;
    })();
    const shouldClear = body.clear_existing !== false;
    const db = base44.asServiceRole;
    const stats = { stores: 0, drivers: 0, patients: 0, routes: 0, cycling_markers: 0, interstore: 0, failed: 0, returns: 0 };

    // Clear existing demo data
    if (shouldClear) {
      const [routes, patients, appUsers, stores] = await Promise.all([
        db.entities.DemoRoute.filter({}, 'created_date', 500, 0),
        db.entities.DemoPatient.filter({}, 'created_date', 500, 0),
        db.entities.DemoAppUser.filter({}, 'created_date', 500, 0),
        db.entities.DemoStore.filter({}, 'created_date', 500, 0),
      ]);
      await Promise.all([
        ...routes.map((r: any) => db.entities.DemoRoute.delete(r.id).catch(() => {})),
        ...patients.map((p: any) => db.entities.DemoPatient.delete(p.id).catch(() => {})),
        ...appUsers.map((u: any) => db.entities.DemoAppUser.delete(u.id).catch(() => {})),
        ...stores.map((s: any) => db.entities.DemoStore.delete(s.id).catch(() => {})),
      ]);
    }

    // Fetch real stores and drivers from DB
    const realStores = await db.entities.Store.filter({ status: 'active' }, 'sort_order', 500, 0);
    const realDrivers = await db.entities.AppUser.filter({ status: 'active' }, 'sort_order', 500, 0);
    const driverUsers = realDrivers.filter((d: any) => d.app_roles?.includes('driver') || d.app_roles?.includes('admin'));

    // Create DemoAppUsers
    for (const d of driverUsers) {
      await db.entities.DemoAppUser.create({
        user_id: d.user_id || d.id, app_roles: d.app_roles || ['driver'],
        user_name: d.user_name || d.full_name || 'Driver',
        home_latitude: d.home_latitude, home_longitude: d.home_longitude,
        city_id: d.city_id, store_ids: d.store_ids || [],
        sort_order: d.sort_order || 99, status: 'active', driver_status: 'off_duty',
        location_tracking_enabled: true,
        pay_rate_per_delivery: d.pay_rate_per_delivery || 5.50,
        extra_km_rate: d.extra_km_rate || 0.55, extra_km_limit: d.extra_km_limit || 10,
        oversized_item_rate: d.oversized_item_rate || 1.5,
        pay_cycle_type: d.pay_cycle_type || 'semimonthly',
        gst_hst_enabled: d.gst_hst_enabled || false, is_demo: true,
      });
      stats.drivers++;
    }

    // Create DemoStores
    for (const s of realStores) {
      await db.entities.DemoStore.create({
        name: s.name, abbreviation: s.abbreviation || s.name?.substring(0, 2).toUpperCase(),
        address: s.address || '', phone: s.phone || '(780) 555-0000',
        latitude: s.latitude, longitude: s.longitude,
        city_id: s.city_id, color: s.color || '#008282', status: 'active',
        sort_order: s.sort_order || 99, base_tracking_number: 0,
        weekday_am_enabled: !!s.weekday_am_enabled,
        weekday_am_start: s.weekday_am_start || '', weekday_am_end: s.weekday_am_end || '',
        weekday_am_driver_id: s.weekday_am_driver_id || null,
        weekday_pm_enabled: !!s.weekday_pm_enabled,
        weekday_pm_start: s.weekday_pm_start || '', weekday_pm_end: s.weekday_pm_end || '',
        weekday_pm_driver_id: s.weekday_pm_driver_id || null,
        saturday_am_enabled: !!s.saturday_am_enabled,
        saturday_am_start: s.saturday_am_start || '', saturday_am_end: s.saturday_am_end || '',
        saturday_am_driver_id: s.saturday_am_driver_id || null,
        sunday_am_enabled: !!s.sunday_am_enabled,
        sunday_am_start: s.sunday_am_start || '', sunday_am_end: s.sunday_am_end || '',
        sunday_am_driver_id: s.sunday_am_driver_id || null,
        is_demo: true,
      });
      stats.stores++;
    }

    // Create DemoSettings
    const existingSettings = await db.entities.DemoSettings.filter({ user_id: user.id });
    if (existingSettings.length > 0) {
      await db.entities.DemoSettings.update(existingSettings[0].id, { is_demo_mode_active: true, demo_store_id: null });
    } else {
      await db.entities.DemoSettings.create({ user_id: user.id, is_demo_mode_active: true, demo_store_id: null });
    }

    // Generate week of routes using store pickup windows
    const stopIdSet = new Set<string>();
    const genStopId = () => { let id: string; do { id = genId(3); } while (stopIdSet.has(id)); stopIdSet.add(id); return id; };
    const patientPools = new Map<string, any[]>();
    for (const s of realStores) {
      patientPools.set(s.id, genPatients(s.latitude, s.longitude, 25));
    }

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const dayDate = addDays(weekStart, dayIdx);
      const dateStr = fmtDate(dayDate);
      const isWeekend = dayIdx >= 5;
      const dow = dayDate.getDay();

      for (const store of realStores) {
        // Determine pickup slots for this day
        const slots: { key: string; start: string; end: string; driverId: string }[] = [];
        if (dow >= 1 && dow <= 5) {
          if (store.weekday_am_enabled && store.weekday_am_driver_id) {
            slots.push({ key: 'am', start: store.weekday_am_start, end: store.weekday_am_end, driverId: store.weekday_am_driver_id });
          }
          if (store.weekday_pm_enabled && store.weekday_pm_driver_id) {
            slots.push({ key: 'pm', start: store.weekday_pm_start, end: store.weekday_pm_end, driverId: store.weekday_pm_driver_id });
          }
        } else if (dow === 6) {
          if (store.saturday_am_enabled && store.saturday_am_driver_id) {
            slots.push({ key: 'sat_am', start: store.saturday_am_start, end: store.saturday_am_end, driverId: store.saturday_am_driver_id });
          }
        } else if (dow === 0) {
          if (store.sunday_am_enabled && store.sunday_am_driver_id) {
            slots.push({ key: 'sun_am', start: store.sunday_am_start, end: store.sunday_am_end, driverId: store.sunday_am_driver_id });
          }
        }

        for (const slot of slots) {
          const driver = driverUsers.find((d: any) => (d.user_id || d.id) === slot.driverId);
          if (!driver) continue;
          const driverId = slot.driverId;
          const driverName = driver.user_name || driver.full_name || 'Driver';
          const isAM = slot.key.includes('am');
          const numDeliveries = isWeekend ? randInt(5, 10) : randInt(5, 12);
          const pool = patientPools.get(store.id)!;
          const slotPatients: any[] = [];
          for (let i = 0; i < numDeliveries; i++) {
            slotPatients.push(pool[(dayIdx * 7 + i) % pool.length]);
          }
          const sortedPatients = sortNN(store.latitude, store.longitude, slotPatients);

          // Check for cycling (store has cycling location)
          const hasCycling = !!(store as any).cycling_latitude;
          let pickupStopOrder = 1;
          let pickupStopId = genStopId();

          if (hasCycling) {
            const cycLat = (store as any).cycling_latitude, cycLon = (store as any).cycling_longitude;
            // Cycling Start marker
            await db.entities.DemoRoute.create({
              delivery_id: `DEMO-CYC-START-${store.id}-${driverId}-${dateStr}`,
              patient_id: '', driver_id: driverId, driver_name: driverName,
              created_by_app_user_id: user.id, delivery_date: dateStr,
              delivery_time_start: slot.start, delivery_time_end: addMin(slot.start, 5),
              delivery_time_eta: slot.start,
              actual_delivery_time: buildDT(dayDate, addMin(slot.start, randInt(3, 10))),
              status: 'completed', store_id: store.id, tracking_number: '00',
              stop_order: 1, stop_id: genStopId(),
              delivery_notes: 'Cycling Route Start', delivery_instructions: 'Drive to cycling location',
              ampm_deliveries: isAM ? 'AM' : 'PM', extra_time: 5,
              is_cycling_marker: true, cycling_latitude: cycLat, cycling_longitude: cycLon,
              transport_mode: 'driving', latitude: cycLat, longitude: cycLon, is_demo: true,
            });
            stats.cycling_markers++;
            // Cycling End marker
            await db.entities.DemoRoute.create({
              delivery_id: `DEMO-CYC-END-${store.id}-${driverId}-${dateStr}`,
              patient_id: '', driver_id: driverId, driver_name: driverName,
              created_by_app_user_id: user.id, delivery_date: dateStr,
              delivery_time_start: addMin(slot.start, 10), delivery_time_end: addMin(slot.start, 20),
              delivery_time_eta: addMin(slot.start, 15),
              actual_delivery_time: buildDT(dayDate, addMin(slot.start, randInt(15, 25))),
              status: 'completed', store_id: store.id, tracking_number: '00',
              stop_order: 2, stop_id: genStopId(),
              delivery_notes: 'Cycling Route End', delivery_instructions: 'Bike to store',
              ampm_deliveries: isAM ? 'AM' : 'PM', extra_time: 10,
              is_cycling_marker: true, cycling_latitude: cycLat, cycling_longitude: cycLon,
              transport_mode: 'cycling', latitude: store.latitude, longitude: store.longitude, is_demo: true,
            });
            stats.cycling_markers++;
            pickupStopOrder = 3; pickupStopId = genStopId();
          }

          // Random InterStore pickup (10% chance)
          const doISP = Math.random() < 0.1 && !isWeekend;
          if (doISP) {
            const isp = pick(IS_LOCS);
            await db.entities.DemoRoute.create({
              delivery_id: `DEMO-ISP-${store.id}-${driverId}-${dateStr}-${slot.key}`,
              patient_id: '', driver_id: driverId, driver_name: driverName,
              created_by_app_user_id: user.id, delivery_date: dateStr,
              delivery_time_start: addMin(slot.start, -30), delivery_time_end: addMin(slot.start, -15),
              delivery_time_eta: addMin(slot.start, -20),
              actual_delivery_time: buildDT(dayDate, addMin(slot.start, randInt(-25, -15))),
              status: 'completed', store_id: store.id, tracking_number: 'ISP',
              stop_order: pickupStopOrder, stop_id: genStopId(),
              puid: pickupStopId,
              delivery_notes: `InterStore Pickup from ${isp.name}`,
              delivery_instructions: `Pick up items from ${isp.name} (${isp.addr})`,
              ampm_deliveries: isAM ? 'AM' : 'PM', extra_time: 15,
              _interstore_source_id: isp.num, _interstore_source_name: isp.name,
              latitude: isp.lat, longitude: isp.lon, transport_mode: 'driving', is_demo: true,
            });
            stats.interstore++; stats.routes++; pickupStopOrder++;
          }

          // Store pickup
          const pickupActualTime = buildDT(dayDate, addMin(slot.start, randInt(3, 15)));
          await db.entities.DemoRoute.create({
            delivery_id: `DEMO-PICKUP-${store.id}-${driverId}-${dateStr}-${slot.key}`,
            patient_id: '', driver_id: driverId, driver_name: driverName,
            created_by_app_user_id: user.id, delivery_date: dateStr,
            delivery_time_start: slot.start, delivery_time_end: slot.end,
            delivery_time_eta: slot.start, actual_delivery_time: pickupActualTime,
            status: 'completed', store_id: store.id, tracking_number: '00',
            stop_order: pickupStopOrder, stop_id: pickupStopId, puid: pickupStopId,
            delivery_notes: `Store pickup: ${store.name}`, delivery_instructions: 'Store pickup',
            ampm_deliveries: isAM ? 'AM' : 'PM', extra_time: 5,
            latitude: store.latitude, longitude: store.longitude,
            transport_mode: hasCycling ? 'cycling' : 'driving', is_demo: true,
          });
          stats.routes++;

          // Delivery stops
          let lastTimeMin = h2m(slot.start) + 20;
          for (let i = 0; i < sortedPatients.length; i++) {
            const patient = sortedPatients[i];
            const stopOrder = pickupStopOrder + 1 + i;
            const trackingNumber = String(stopOrder).padStart(2, '0');
            const deliveryDuration = randInt(15, 30);
            lastTimeMin += deliveryDuration;
            const deliveryTime = m2h(Math.min(lastTimeMin, 20 * 60));

            const statusRoll = Math.random();
            let status = 'completed';
            if (statusRoll < 0.05) status = 'failed';
            else if (statusRoll < 0.08) status = 'cancelled';

            const codRoll = Math.random();
            let codType = 'No Payment', codAmount = '', codRequired = 0;
            if (codRoll < 0.15) { codType = 'Cash'; codAmount = String(randInt(10, 80)); codRequired = parseFloat(codAmount); }
            else if (codRoll < 0.25) { codType = 'Debit'; codAmount = String(randInt(15, 120)); codRequired = parseFloat(codAmount); }
            else if (codRoll < 0.30) { codType = 'Credit'; codAmount = String(randInt(15, 120)); codRequired = parseFloat(codAmount); }

            const actualTime = (status !== 'pending') ? buildDT(dayDate, deliveryTime) : '';
            let patientId = `DEMO-P-${store.id?.slice(-6)}-${genId(5)}`;
            const createdPatient = await db.entities.DemoPatient.create({
              store_id: store.id, full_name: patient.full_name, patient_id: patientId,
              address: patient.address, latitude: patient.latitude, longitude: patient.longitude,
              distance_from_store: patient.distance_from_store, phone: patient.phone,
              notes: patient.notes, mailbox_ok: patient.mailbox_ok, call_upon_arrival: patient.call_upon_arrival,
              ring_bell: patient.ring_bell, dont_ring_bell: patient.dont_ring_bell, back_door: patient.back_door,
              time_window_start: patient.time_window_start, time_window_end: patient.time_window_end,
              status: 'active', is_demo: true,
            }).catch(() => null);
            if (createdPatient) stats.patients++;

            const isFirstDelivery = Math.random() < 0.15;
            const isFridge = Math.random() < 0.12;
            const isOversized = Math.random() < 0.08;
            const needsSignature = Math.random() < 0.35;

            await db.entities.DemoRoute.create({
              delivery_id: `DEMO-DEL-${store.id?.slice(-6)}-${driverId?.slice(-4)}-${dateStr}-${slot.key.toUpperCase()}-${i+1}`,
              patient_id: createdPatient?.id || patientId,
              driver_id: driverId, driver_name: driverName,
              created_by_app_user_id: user.id, delivery_date: dateStr,
              delivery_time_start: patient.time_window_start || addMin(slot.start, 30 + i * 25),
              delivery_time_end: patient.time_window_end || addMin(patient.time_window_start || slot.start, 120),
              delivery_time_eta: addMin(deliveryTime, -randInt(0, 15)),
              arrival_time: buildDT(dayDate, addMin(deliveryTime, -randInt(2, 8))),
              actual_delivery_time: actualTime, status, store_id: store.id,
              tracking_number: trackingNumber, stop_order: stopOrder,
              stop_id: genStopId(), puid: pickupStopId,
              delivery_notes: status === 'failed' ? pick(['Patient not home','Address issue','Delivery delayed','Wrong address']) :
                             status === 'cancelled' ? 'Cancelled by pharmacy' : patient.notes || 'Delivered successfully',
              delivery_instructions: patient.notes || '',
              ampm_deliveries: isAM ? 'AM' : 'PM', extra_time: 5,
              cod_payment_type: codType, cod_amount: codAmount, cod_total_amount_required: codRequired,
              signature_needed: needsSignature,
              signature_image_url: needsSignature && status === 'completed' ? 'demo-signature.png' : '',
              fridge_item: isFridge, oversized: isOversized, first_delivery: isFirstDelivery,
              latitude: patient.latitude, longitude: patient.longitude,
              estimated_distance_km: +haversineKm(store.latitude, store.longitude, patient.latitude, patient.longitude).toFixed(2),
              transport_mode: hasCycling ? 'cycling' : 'driving', is_demo: true,
            });
            stats.routes++;

            // Failed delivery follow-up
            if (status === 'failed') {
              stats.failed++;
              const followUpType = Math.random() < 0.6 ? 'retry' : 'return';
              if (followUpType === 'retry') {
                const retryDate = addDays(dayDate, 1);
                await db.entities.DemoRoute.create({
                  delivery_id: `DEMO-RETRY-${store.id?.slice(-6)}-${driverId?.slice(-4)}-${fmtDate(retryDate)}-${i+1}`,
                  patient_id: createdPatient?.id || patientId,
                  driver_id: driverId, driver_name: driverName,
                  created_by_app_user_id: user.id, delivery_date: fmtDate(retryDate),
                  delivery_time_start: addMin(patient.time_window_start || slot.start, 60),
                  delivery_time_end: addMin(patient.time_window_end || '18:00', 60),
                  actual_delivery_time: buildDT(retryDate, addMin(patient.time_window_start || slot.start, randInt(60, 90))),
                  status: 'completed', store_id: store.id,
                  tracking_number: `${trackingNumber}R`, stop_order: stopOrder + 100,
                  stop_id: genStopId(), puid: pickupStopId,
                  delivery_notes: 'Retry: delivered successfully after failed attempt',
                  ampm_deliveries: isAM ? 'AM' : 'PM', extra_time: 5,
                  latitude: patient.latitude, longitude: patient.longitude, is_demo: true,
                });
                stats.routes++;
              } else {
                stats.returns++;
                await db.entities.DemoRoute.create({
                  delivery_id: `DEMO-RETURN-${store.id?.slice(-6)}-${driverId?.slice(-4)}-${dateStr}-${i+1}`,
                  patient_id: '', driver_id: driverId, driver_name: driverName,
                  created_by_app_user_id: user.id, delivery_date: dateStr,
                  delivery_time_start: addMin(slot.end || '17:00', 30),
                  delivery_time_end: addMin(slot.end || '17:00', 45),
                  actual_delivery_time: buildDT(dayDate, addMin(slot.end || '17:00', randInt(30, 45))),
                  status: 'completed', store_id: store.id,
                  tracking_number: `${trackingNumber}T`, stop_order: 999,
                  stop_id: genStopId(), puid: pickupStopId,
                  delivery_notes: `Return: ${store.name} Return\nFor: ${patient.full_name}`,
                  ampm_deliveries: isAM ? 'AM' : 'PM', extra_time: 5,
                  latitude: store.latitude, longitude: store.longitude, is_demo: true,
                });
                stats.routes++;
              }
            }

            // Random InterStore dropoff (8% chance, mid-route)
            if (Math.random() < 0.08 && !isWeekend && i === Math.floor(sortedPatients.length / 2)) {
              const isd = pick(IS_LOCS);
              const isdTime = m2h(lastTimeMin + 15);
              await db.entities.DemoRoute.create({
                delivery_id: `DEMO-ISD-${store.id?.slice(-6)}-${driverId?.slice(-4)}-${dateStr}-${slot.key}`,
                patient_id: '', driver_id: driverId, driver_name: driverName,
                created_by_app_user_id: user.id, delivery_date: dateStr,
                delivery_time_start: isdTime, delivery_time_end: addMin(isdTime, 15),
                actual_delivery_time: buildDT(dayDate, addMin(isdTime, randInt(5, 12))),
                status: 'completed', store_id: store.id, tracking_number: 'ISD',
                stop_order: stopOrder + 0.5, stop_id: genStopId(), puid: pickupStopId,
                delivery_notes: `InterStore Dropoff to ${isd.name}`,
                delivery_instructions: `Drop off items at ${isd.name} (${isd.addr})`,
                ampm_deliveries: isAM ? 'AM' : 'PM', extra_time: 15,
                _interstore_dest_id: isd.num, _interstore_dest_name: isd.name,
                latitude: isd.lat, longitude: isd.lon, transport_mode: 'driving', is_demo: true,
              });
              stats.interstore++; stats.routes++;
            }
          }
        }
      }
    }

    return Response.json({
      success: true,
      week_start: fmtDate(weekStart),
      stats: { ...stats, total_routes_in_db: (await db.entities.DemoRoute.filter({}, 'created_date', 500, 0)).length },
    });
  } catch (error) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
});
