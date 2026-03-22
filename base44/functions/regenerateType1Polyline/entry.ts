import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const ACTIVE_STATUSES = new Set(['in_transit', 'en_route']);
const HERE_POLYLINE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HERE_POLYLINE_DECODER = HERE_POLYLINE_ALPHABET.split('').reduce((acc, char, index) => {
  acc[char] = index;
  return acc;
}, {});
const DEFAULT_MIN_MOVE_METERS = 75;
const DEFAULT_MIN_INTERVAL_MS = 30000;

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

function decodeHereFlexiblePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];

  const values = [];
  let current = 0;
  let shift = 0;

  for (const char of encoded) {
    const value = HERE_POLYLINE_DECODER[char];
    if (value == null) return [];
    current |= (value & 0x1f) << shift;
    if (value & 0x20) {
      shift += 5;
      continue;
    }
    values.push(current);
    current = 0;
    shift = 0;
  }

  if (shift > 0 || values.length < 2) return [];
  if (values[0] !== 1) return [];

  const header = values[1];
  const precision = header & 15;
  const thirdDimension = (header >> 4) & 7;
  const factor = 10 ** precision;
  const dimension = thirdDimension ? 3 : 2;
  const toSigned = (value) => ((value & 1) ? ~(value >> 1) : (value >> 1));

  let latitude = 0;
  let longitude = 0;
  let third = 0;
  const coordinates = [];

  for (let i = 2; i < values.length; i += dimension) {
    latitude += toSigned(values[i]);
    longitude += toSigned(values[i + 1]);
    if (thirdDimension) {
      third += toSigned(values[i + 2]);
    }
    coordinates.push([latitude / factor, longitude / factor]);
  }

  return coordinates;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getSegmentDirections(base44, from, to) {
  const response = await base44.functions.invoke('getHereDirections', {
    origin: { lat: from.lat, lng: from.lon },
    destination: { lat: to.lat, lng: to.lon }
  });

  const data = response?.data || response || {};
  let polyline = null;

  if (Array.isArray(data?.coordinates) && data.coordinates.length > 1) {
    polyline = encodeGooglePolyline(
      data.coordinates.map((point) => [Number(point?.lat ?? point?.latitude), Number(point?.lng ?? point?.longitude)])
    );
  } else if (data?.polyline_format === 'flexible' && typeof data?.polyline === 'string') {
    const coords = decodeHereFlexiblePolyline(data.polyline);
    if (coords.length > 1) {
      polyline = encodeGooglePolyline(coords);
    }
  } else if (typeof data?.polyline === 'string' && data.polyline) {
    polyline = data.polyline;
  }

  if (!polyline) {
    polyline = encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]);
  }

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
    const driverId = body?.driverId;
    const deliveryDate = body?.deliveryDate;
    const rawLocation = body?.currentLocation || {};
    const currentLat = Number(rawLocation?.lat);
    const currentLon = Number(rawLocation?.lon ?? rawLocation?.lng);
    const minMoveMeters = Number(body?.minMoveMeters || DEFAULT_MIN_MOVE_METERS);

    if (!driverId || !deliveryDate || !Number.isFinite(currentLat) || !Number.isFinite(currentLon)) {
      return Response.json({ error: 'driverId, deliveryDate, and currentLocation are required' }, { status: 400 });
    }

    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);

    const activeStops = (deliveries || [])
      .filter((delivery) => ACTIVE_STATUSES.has(delivery.status))
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    if (activeStops.length === 0) {
      return Response.json({ success: true, skipped: true, reason: 'no_active_route' });
    }

    const patientIds = [...new Set(activeStops.filter((d) => d?.patient_id).map((d) => d.patient_id))];
    const storeIds = [...new Set(activeStops.filter((d) => d?.store_id).map((d) => d.store_id))];

    const [patients, stores, existingPolylines] = await Promise.all([
      patientIds.length ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }, undefined, 50000) : [],
      storeIds.length ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }, undefined, 50000) : [],
      base44.asServiceRole.entities.DriverRoutePolyline.filter({ driver_id: driverId, delivery_date: deliveryDate }, '-updated_date', 50000)
    ]);

    const patientMap = new Map((patients || []).map((patient) => [patient.id, patient]));
    const storeMap = new Map((stores || []).map((store) => [store.id, store]));

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

    const nextActiveStop = activeStops.find((stop) => stop.isNextDelivery === true) || activeStops[0];
    const nextStopCoords = getLatLon(nextActiveStop);

    if (!nextStopCoords) {
      return Response.json({ success: true, skipped: true, reason: 'missing_next_stop_coordinates' });
    }

    const exactExistingType1 = (existingPolylines || []).find((row) =>
      round5(row?.segment_origin_lat) === round5(currentLat) &&
      round5(row?.segment_origin_lon) === round5(currentLon) &&
      round5(row?.segment_dest_lat) === round5(nextStopCoords.lat) &&
      round5(row?.segment_dest_lon) === round5(nextStopCoords.lon) &&
      typeof row?.encoded_polyline === 'string' && row.encoded_polyline.trim().length > 0
    ) || null;

    if (exactExistingType1) {
      return Response.json({ success: true, skipped: true, reason: 'cached_exact_segment', driverId, deliveryDate, nextStopId: nextActiveStop.id });
    }

    const existingType1 = (existingPolylines || []).find((row) =>
      round5(row?.segment_dest_lat) === round5(nextStopCoords.lat) &&
      round5(row?.segment_dest_lon) === round5(nextStopCoords.lon)
    ) || null;

    if (existingType1) {
      const movedMeters = distanceMeters(
        Number(existingType1.segment_origin_lat),
        Number(existingType1.segment_origin_lon),
        currentLat,
        currentLon
      );
      const ageMs = Date.now() - new Date(existingType1.last_generated_at || 0).getTime();

      if (movedMeters < minMoveMeters) {
        return Response.json({ success: true, skipped: true, reason: 'within_threshold', movedMeters });
      }

      if (Number.isFinite(ageMs) && ageMs < DEFAULT_MIN_INTERVAL_MS) {
        return Response.json({ success: true, skipped: true, reason: 'throttled', movedMeters, ageMs });
      }
    }

    const directions = await getSegmentDirections(base44, { lat: currentLat, lon: currentLon }, nextStopCoords);

    const payload = {
      driver_id: driverId,
      delivery_date: deliveryDate,
      encoded_polyline: directions.encoded_polyline,
      segment_origin_lat: round5(currentLat),
      segment_origin_lon: round5(currentLon),
      segment_dest_lat: round5(nextStopCoords.lat),
      segment_dest_lon: round5(nextStopCoords.lon),
      estimated_distance_km: directions.estimated_distance_km,
      estimated_duration_minutes: directions.estimated_duration_minutes,
      daily_generation_count: Number(existingType1?.daily_generation_count || 0) + 1,
      last_generated_at: new Date().toISOString()
    };

    if (existingType1?.id) {
      await base44.asServiceRole.entities.DriverRoutePolyline.update(existingType1.id, payload);
    } else {
      await base44.asServiceRole.entities.DriverRoutePolyline.create(payload);
    }

    return Response.json({
      success: true,
      updated: true,
      driverId,
      deliveryDate,
      nextStopId: nextActiveStop.id
    });
  } catch (error) {
    console.error('[regenerateType1Polyline] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});