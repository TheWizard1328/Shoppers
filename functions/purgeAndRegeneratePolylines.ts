import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const ACTIVE_STATUSES = new Set(['in_transit', 'en_route']);
const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);

function round5(value) {
  return Number(Number(value).toFixed(5));
}

function encodeSigned(value) {
  let signed = value << 1;
  if (value < 0) signed = ~signed;
  let encoded = '';
  while (signed >= 0x20) {
    encoded += String.fromCharCode((0x20 | (signed & 0x1f)) + 63);
    signed >>= 5;
  }
  encoded += String.fromCharCode(signed + 63);
  return encoded;
}

function encodeGooglePolyline(points) {
  let lastLat = 0;
  let lastLng = 0;
  let encoded = '';

  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    encoded += encodeSigned(latE5 - lastLat);
    encoded += encodeSigned(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }

  return encoded;
}

function makeSegmentKey(driverId, date, from, to) {
  return [
    String(driverId || ''),
    String(date || ''),
    round5(from.lat),
    round5(from.lon),
    round5(to.lat),
    round5(to.lon)
  ].join('|');
}

async function getSegmentDirections(base44, from, to) {
  const response = await base44.asServiceRole.functions.invoke('getHereDirections', {
    origin: { lat: from.lat, lng: from.lon },
    destination: { lat: to.lat, lng: to.lon }
  });

  const data = response?.data || response || {};
  const polyline = typeof data?.polyline === 'string' && data.polyline
    ? data.polyline
    : encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]);

  return {
    encoded_polyline: polyline,
    estimated_distance_km: data?.estimated_distance_km ?? null,
    estimated_duration_minutes: data?.estimated_duration_minutes ?? null
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { driverId, deliveryDate } = body || {};

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'driverId and deliveryDate are required' }, { status: 400 });
    }

    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);

    const existingPolylines = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, '-updated_date', 50000);

    const previousGenerationCount = Array.isArray(existingPolylines) && existingPolylines.length
      ? Math.max(...existingPolylines.map((row) => Number(row?.daily_generation_count || 0)))
      : 0;

    if (Array.isArray(existingPolylines) && existingPolylines.length) {
      await Promise.all(existingPolylines.map((row) => base44.asServiceRole.entities.DriverRoutePolyline.delete(row.id)));
    }

    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      return Response.json({ success: true, deleted: existingPolylines?.length || 0, created: 0, apiCallsMade: 0, segments: [] });
    }

    const patientIds = [...new Set(deliveries.filter((d) => d?.patient_id).map((d) => d.patient_id))];
    const storeIds = [...new Set(deliveries.filter((d) => d?.store_id).map((d) => d.store_id))];

    const [patients, stores, appUsers] = await Promise.all([
      patientIds.length ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }, '', 50000) : [],
      storeIds.length ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }, '', 50000) : [],
      base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-updated_date', 1)
    ]);

    const patientMap = new Map((patients || []).map((patient) => [patient.id, patient]));
    const storeMap = new Map((stores || []).map((store) => [store.id, store]));
    const driverAppUser = Array.isArray(appUsers) ? appUsers[0] : null;

    const getLatLon = (delivery) => {
      if (!delivery) return null;

      if (delivery.patient_id) {
        const patient = patientMap.get(delivery.patient_id);
        if (patient?.latitude != null && patient?.longitude != null) {
          return { lat: Number(patient.latitude), lon: Number(patient.longitude) };
        }
      }

      if (delivery.store_id) {
        const store = storeMap.get(delivery.store_id);
        if (store?.latitude != null && store?.longitude != null) {
          return { lat: Number(store.latitude), lon: Number(store.longitude) };
        }
      }

      return null;
    };

    const completedStops = deliveries
      .filter((delivery) => FINISHED_STATUSES.has(delivery.status))
      .sort((a, b) => {
        const aTime = new Date(a.actual_delivery_time || a.updated_date || a.created_date || 0).getTime();
        const bTime = new Date(b.actual_delivery_time || b.updated_date || b.created_date || 0).getTime();
        return bTime - aTime;
      });

    const activeStops = deliveries
      .filter((delivery) => ACTIVE_STATUSES.has(delivery.status))
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    if (activeStops.length === 0) {
      return Response.json({ success: true, deleted: existingPolylines?.length || 0, created: 0, apiCallsMade: 0, segments: [] });
    }

    const segmentSpecs = [];
    const seen = new Set();

    const pushSegment = (from, to) => {
      if (!from || !to) return;
      if (![from.lat, from.lon, to.lat, to.lon].every((value) => Number.isFinite(value))) return;
      const key = makeSegmentKey(driverId, deliveryDate, from, to);
      if (seen.has(key)) return;
      seen.add(key);
      segmentSpecs.push({ from, to });
    };

    if (completedStops.length > 0) {
      const lastCompleted = getLatLon(completedStops[0]);
      const nextActive = getLatLon(activeStops.find((stop) => stop.isNextDelivery === true) || activeStops[0]);
      pushSegment(lastCompleted, nextActive);
    } else {
      const firstActive = getLatLon(activeStops[0]);
      const homeLat = Number(driverAppUser?.home_latitude);
      const homeLon = Number(driverAppUser?.home_longitude);
      const currentLat = Number(driverAppUser?.current_latitude);
      const currentLon = Number(driverAppUser?.current_longitude);

      let originLat = Number.isFinite(homeLat) ? homeLat : currentLat;
      let originLon = Number.isFinite(homeLon) ? homeLon : currentLon;

      if (Number.isFinite(homeLat) && Number.isFinite(homeLon) && Number.isFinite(currentLat) && Number.isFinite(currentLon)) {
        if (Math.abs(currentLat - homeLat) < 0.0006 && Math.abs(currentLon - homeLon) < 0.0006) {
          originLat = homeLat;
          originLon = homeLon;
        }
      }

      if (Number.isFinite(originLat) && Number.isFinite(originLon)) {
        pushSegment({ lat: originLat, lon: originLon }, firstActive);
      }
    }

    for (let index = 0; index < activeStops.length - 1; index += 1) {
      const from = getLatLon(activeStops[index]);
      const to = getLatLon(activeStops[index + 1]);
      pushSegment(from, to);
    }

    let apiCallsMade = 0;
    const createdSegments = [];

    for (const spec of segmentSpecs) {
      const directions = await getSegmentDirections(base44, spec.from, spec.to);
      apiCallsMade += 1;
      createdSegments.push({
        driver_id: driverId,
        delivery_date: deliveryDate,
        encoded_polyline: directions.encoded_polyline,
        segment_origin_lat: round5(spec.from.lat),
        segment_origin_lon: round5(spec.from.lon),
        segment_dest_lat: round5(spec.to.lat),
        segment_dest_lon: round5(spec.to.lon),
        estimated_distance_km: directions.estimated_distance_km,
        estimated_duration_minutes: directions.estimated_duration_minutes,
        daily_generation_count: previousGenerationCount + apiCallsMade,
        last_generated_at: new Date().toISOString()
      });
    }

    if (createdSegments.length > 0) {
      await base44.asServiceRole.entities.DriverRoutePolyline.bulkCreate(createdSegments);
    }

    return Response.json({
      success: true,
      deleted: existingPolylines?.length || 0,
      created: createdSegments.length,
      apiCallsMade,
      segments: createdSegments
    });
  } catch (error) {
    console.error('[purgeAndRegeneratePolylines] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});