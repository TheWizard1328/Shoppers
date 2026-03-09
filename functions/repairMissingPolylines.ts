import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// Minimal Google polyline encoder (no external deps)
function encodeSigned(value) {
  let sgn = value << 1;
  if (value < 0) sgn = ~sgn;
  let encoded = '';
  while (sgn >= 0x20) {
    encoded += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  encoded += String.fromCharCode(sgn + 63);
  return encoded;
}
function encodeGooglePolyline(points) {
  let lastLat = 0, lastLng = 0;
  let out = '';
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    out += encodeSigned(latE5 - lastLat);
    out += encodeSigned(lngE5 - lastLng);
    lastLat = latE5; lastLng = lngE5;
  }
  return out;
}

function round5(n) { return Number(Number(n).toFixed(5)); }

async function fetchDirectionsPolyline(origin, destination, googleKey) {
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&mode=driving&key=${googleKey}`;
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort('timeout'), 10000);
  const resp = await fetch(url, { signal: controller.signal });
  clearTimeout(to);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Directions error ${resp.status}: ${text.slice(0,200)}`);
  }
  const data = await resp.json();
  const route = Array.isArray(data?.routes) ? data.routes[0] : null;
  if (!route) return { coords: [[origin.lat, origin.lng], [destination.lat, destination.lng]], distKm: 0, durMin: 0 };
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const totalMeters = legs.reduce((s, l) => s + (l?.distance?.value || 0), 0);
  const totalSeconds = legs.reduce((s, l) => s + (l?.duration?.value || 0), 0);
  const polyline = route?.overview_polyline?.points || null;
  if (polyline) {
    return { encoded: polyline, distKm: Math.round((totalMeters/1000)*10)/10, durMin: Math.round(totalSeconds/60) };
  }
  // Fallback straight line
  return { coords: [[origin.lat, origin.lng],[destination.lat, destination.lng]], distKm: Math.round((totalMeters/1000)*10)/10, durMin: Math.round(totalSeconds/60) };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const me = await base44.auth.me();
    if (!me) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dateStr = body?.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Edmonton' });
    const includeDriverIds = Array.isArray(body?.driverIds) ? body.driverIds : null;

    // Role check (admins, dispatchers, drivers can run)
    let canRun = false;
    try {
      const myAppUser = (await base44.asServiceRole.entities.AppUser.filter({ user_id: me.id }, '-updated_date', 1))?.[0];
      const roles = myAppUser?.app_roles || [];
      canRun = roles.includes('admin') || roles.includes('dispatcher') || roles.includes('driver');
    } catch (_) {}
    if (!canRun) return Response.json({ error: 'Forbidden' }, { status: 403 });

    // Identify drivers to repair
    let driverIds = new Set();
    if (includeDriverIds && includeDriverIds.length) {
      includeDriverIds.forEach((id) => driverIds.add(String(id)));
    } else {
      const todays = await base44.asServiceRole.entities.Delivery.filter({ delivery_date: dateStr });
      (todays || []).forEach((d) => { if (d?.driver_id) driverIds.add(String(d.driver_id)); });
    }

    if (!driverIds.size) return Response.json({ success: true, repaired: [], message: 'No drivers to repair' });

    // Step 0: Deduplicate existing polylines ONLINE (keep most recent per leg)
    let existingPolys = [];
    if (includeDriverIds && includeDriverIds.length) {
      const batches = await Promise.all(Array.from(driverIds).map((did) =>
        base44.asServiceRole.entities.DriverRoutePolyline.filter({ driver_id: did, delivery_date: dateStr })
      ));
      batches.forEach(arr => { if (Array.isArray(arr)) existingPolys.push(...arr); });
    } else {
      existingPolys = await base44.asServiceRole.entities.DriverRoutePolyline.filter({ delivery_date: dateStr });
    }
    const byKey = new Map();
    const deletedIds = [];
    (existingPolys || []).forEach((rec) => {
      if (!rec) return;
      const key = [
        String(rec.driver_id || ''),
        String(rec.delivery_date || ''),
        Number(rec.segment_origin_lat)?.toFixed?.(5),
        Number(rec.segment_origin_lon)?.toFixed?.(5),
        Number(rec.segment_dest_lat)?.toFixed?.(5),
        Number(rec.segment_dest_lon)?.toFixed?.(5)
      ].join('|');
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(rec);
    });
    let keptOnlineCount = 0;
    for (const [_, arr] of byKey) {
      if (!arr || arr.length <= 1) { keptOnlineCount += (arr?.length || 0); continue; }
      arr.sort((a, b) => {
        const ta = new Date(a.last_generated_at || a.updated_date || a.created_date || 0).getTime();
        const tb = new Date(b.last_generated_at || b.updated_date || b.created_date || 0).getTime();
        return tb - ta; // most recent first
      });
      keptOnlineCount += 1;
      const toDelete = arr.slice(1);
      toDelete.forEach(r => r?.id && deletedIds.push(r.id));
    }
    if (deletedIds.length) {
      await Promise.all(deletedIds.map((id) => base44.asServiceRole.entities.DriverRoutePolyline.delete(id).catch(() => null)));
    }

    const allStores = await base44.asServiceRole.entities.Store.list();
    const storeById = new Map((allStores || []).filter(Boolean).map(s => [String(s.id), s]));
    const allPatients = await base44.asServiceRole.entities.Patient.list();
    const patientById = new Map((allPatients || []).filter(Boolean).map(p => [String(p.id), p]));
    const allAppUsers = await base44.asServiceRole.entities.AppUser.list();
    const appUserByKey = new Map((allAppUsers || []).filter(Boolean).flatMap(u => [[String(u.id), u], [String(u.user_id), u]]));

    const GOOGLE_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY');

    const FINISHED = new Set(['completed','failed','cancelled','returned']);
    const repaired = [];

    for (const driverId of Array.from(driverIds)) {
      const list = await base44.asServiceRole.entities.Delivery.filter({ driver_id: driverId, delivery_date: dateStr });
      const deliveries = (list || []).filter(Boolean).sort((a,b) => (a.stop_order||0)-(b.stop_order||0));
      if (!deliveries.length) continue;

      const incomplete = deliveries.filter(d => d.status === 'in_transit' || d.status === 'en_route');
      const completed = deliveries.filter(d => FINISHED.has(d.status)).sort((a,b) => new Date(b.actual_delivery_time || b.updated_date || 0) - new Date(a.actual_delivery_time || a.updated_date || 0));

      const getLatLon = (stop) => {
        if (!stop) return null;
        if (stop.patient_id) {
          const p = patientById.get(String(stop.patient_id));
          if (p?.latitude != null && p?.longitude != null) return { lat: Number(p.latitude), lon: Number(p.longitude) };
        }
        const s = storeById.get(String(stop.store_id));
        if (s?.latitude != null && s?.longitude != null) return { lat: Number(s.latitude), lon: Number(s.longitude) };
        return null;
      };

      // Generate all Type 2 legs (between every pair of consecutive active stops)
      for (let i = 0; i < incomplete.length - 1; i++) {
        const a = getLatLon(incomplete[i]);
        const b = getLatLon(incomplete[i+1]);
        if (!a || !b) continue;
        // Check if exists
        const existing = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
          driver_id: driverId,
          delivery_date: dateStr,
          segment_origin_lat: round5(a.lat),
          segment_origin_lon: round5(a.lon),
          segment_dest_lat: round5(b.lat),
          segment_dest_lon: round5(b.lon)
        }, '-updated_date', 1);
        const rec = Array.isArray(existing) ? existing[0] : null;
        if (!rec?.encoded_polyline) {
          // Fetch & save
          const origin = { lat: a.lat, lng: a.lon };
          const dest = { lat: b.lat, lng: b.lon };
          const data = await fetchDirectionsPolyline(origin, dest, GOOGLE_KEY);
          const encoded = data.encoded || encodeGooglePolyline((data.coords || []).map(([la,lo]) => [la, lo]));
          await (rec ? base44.asServiceRole.entities.DriverRoutePolyline.update(rec.id, {
            encoded_polyline: encoded,
            segment_origin_lat: round5(a.lat),
            segment_origin_lon: round5(a.lon),
            segment_dest_lat: round5(b.lat),
            segment_dest_lon: round5(b.lon),
            last_generated_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 10*60*1000).toISOString(),
            estimated_distance_km: data?.distKm || null,
            estimated_duration_minutes: data?.durMin || null,
          }) : base44.asServiceRole.entities.DriverRoutePolyline.create({
            driver_id: driverId,
            delivery_date: dateStr,
            encoded_polyline: encoded,
            segment_origin_lat: round5(a.lat),
            segment_origin_lon: round5(a.lon),
            segment_dest_lat: round5(b.lat),
            segment_dest_lon: round5(b.lon),
            last_generated_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 10*60*1000).toISOString(),
            estimated_distance_km: data?.distKm || null,
            estimated_duration_minutes: data?.durMin || null,
          }));
          repaired.push({ driverId, type: 'type2', from: a, to: b });
        }
      }

      // Type 1: last completed -> next active
      if (completed.length && incomplete.length) {
        const last = getLatLon(completed[0]);
        const nextStop = getLatLon(incomplete.find(s => s.isNextDelivery) || incomplete[0]);
        if (last && nextStop) {
          const existing = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
            driver_id: driverId,
            delivery_date: dateStr,
            segment_origin_lat: round5(last.lat),
            segment_origin_lon: round5(last.lon),
            segment_dest_lat: round5(nextStop.lat),
            segment_dest_lon: round5(nextStop.lon)
          }, '-updated_date', 1);
          const rec = Array.isArray(existing) ? existing[0] : null;
          if (!rec?.encoded_polyline) {
            const data = await fetchDirectionsPolyline({ lat: last.lat, lng: last.lon }, { lat: nextStop.lat, lng: nextStop.lon }, GOOGLE_KEY);
            const encoded = data.encoded || encodeGooglePolyline((data.coords || []).map(([la,lo]) => [la, lo]));
            await (rec ? base44.asServiceRole.entities.DriverRoutePolyline.update(rec.id, {
              encoded_polyline: encoded,
              last_generated_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 10*60*1000).toISOString(),
              estimated_distance_km: data?.distKm || null,
              estimated_duration_minutes: data?.durMin || null,
            }) : base44.asServiceRole.entities.DriverRoutePolyline.create({
              driver_id: driverId,
              delivery_date: dateStr,
              encoded_polyline: encoded,
              segment_origin_lat: round5(last.lat),
              segment_origin_lon: round5(last.lon),
              segment_dest_lat: round5(nextStop.lat),
              segment_dest_lon: round5(nextStop.lon),
              last_generated_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 10*60*1000).toISOString(),
              estimated_distance_km: data?.distKm || null,
              estimated_duration_minutes: data?.durMin || null,
            }));
            repaired.push({ driverId, type: 'type1_last_to_next' });
          }
        }
      }

      // Type 1 pre-route: home/current -> first active when route not started
      if (!completed.length && incomplete.length) {
        const next = getLatLon(incomplete[0]);
        const appUser = appUserByKey.get(String(driverId));
        const originLat = Number(appUser?.current_latitude) || Number(appUser?.home_latitude);
        const originLon = Number(appUser?.current_longitude) || Number(appUser?.home_longitude);
        if (next && isFinite(originLat) && isFinite(originLon)) {
          const existing = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
            driver_id: driverId,
            delivery_date: dateStr,
            segment_origin_lat: round5(originLat),
            segment_origin_lon: round5(originLon),
            segment_dest_lat: round5(next.lat),
            segment_dest_lon: round5(next.lon)
          }, '-updated_date', 1);
          const rec = Array.isArray(existing) ? existing[0] : null;
          if (!rec?.encoded_polyline) {
            const data = await fetchDirectionsPolyline({ lat: originLat, lng: originLon }, { lat: next.lat, lng: next.lon }, GOOGLE_KEY);
            const encoded = data.encoded || encodeGooglePolyline((data.coords || []).map(([la,lo]) => [la, lo]));
            await (rec ? base44.asServiceRole.entities.DriverRoutePolyline.update(rec.id, {
              encoded_polyline: encoded,
              last_generated_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 10*60*1000).toISOString(),
              estimated_distance_km: data?.distKm || null,
              estimated_duration_minutes: data?.durMin || null,
            }) : base44.asServiceRole.entities.DriverRoutePolyline.create({
              driver_id: driverId,
              delivery_date: dateStr,
              encoded_polyline: encoded,
              segment_origin_lat: round5(originLat),
              segment_origin_lon: round5(originLon),
              segment_dest_lat: round5(next.lat),
              segment_dest_lon: round5(next.lon),
              last_generated_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 10*60*1000).toISOString(),
              estimated_distance_km: data?.distKm || null,
              estimated_duration_minutes: data?.durMin || null,
            }));
            repaired.push({ driverId, type: 'type1_home_to_first' });
          }
        }
      }
    }

    // Broadcast for clients to hydrate from entity/offline DB
    try { self && self.dispatchEvent && self.dispatchEvent(new Event('polylineUpdated')); } catch (_) {}

    return Response.json({ success: true, date: dateStr, repaired, deleted_online: deletedIds.length, kept_online: keptOnlineCount });
  } catch (err) {
    return Response.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
});