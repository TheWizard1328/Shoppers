import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Haversine distance in km between two [lat, lng] points
const haversineKm = (a, b) => {
  const R = 6371;
  const dLat = (b[0] - a[0]) * Math.PI / 180;
  const dLon = (b[1] - a[1]) * Math.PI / 180;
  const lat1 = a[0] * Math.PI / 180;
  const lat2 = b[0] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

// Total path distance in km
const pathDistanceKm = (points) => {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineKm(points[i - 1], points[i]);
  }
  return total;
};

// Normalize a raw breadcrumb point to [lat, lng, ts?]
const normalizePoint = (point) => {
  if (Array.isArray(point) && point.length >= 2) {
    const lat = Number(point[0]);
    const lng = Number(point[1]);
    const ts = point.length >= 3 ? Number(point[2]) : null;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return ts !== null && Number.isFinite(ts) ? [lat, lng, ts] : [lat, lng];
    }
  }
  if (point && typeof point === 'object') {
    const lat = Number(point.latitude ?? point.lat);
    const lng = Number(point.longitude ?? point.lng ?? point.lon);
    const rawTs = point.timestamp ?? point.timestamp_ms ?? point.time;
    const ts = rawTs == null ? null : Number(rawTs);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return ts !== null && Number.isFinite(ts) ? [lat, lng, ts] : [lat, lng];
    }
  }
  return null;
};

// Pick N evenly-spaced interior indices from an array
const evenlySpacedInterior = (points, count) => {
  const result = [];
  const step = (points.length - 1) / (count + 1);
  for (let i = 1; i <= count; i++) {
    result.push(points[Math.round(step * i)]);
  }
  return result;
};

// Subsample points: always keep origin + destination, add 0–3 interior points based on distance
const subsamplePoints = (points, originCoords, destCoords) => {
  const origin = originCoords ? [...originCoords] : (points.length > 0 ? points[0] : null);
  const dest = destCoords ? [...destCoords] : (points.length > 0 ? points[points.length - 1] : null);
  if (!origin || !dest) return null;
  if (points.length < 2) return [origin, dest];

  const totalKm = pathDistanceKm(points);
  let interiorCount = 0;
  if (totalKm >= 15) interiorCount = 3;
  else if (totalKm >= 5) interiorCount = 2;
  else if (totalKm >= 1) interiorCount = 1;

  const interior = interiorCount > 0 ? evenlySpacedInterior(points, interiorCount) : [];
  return [origin, ...interior, dest];
};

// Polyline encoding (Google format)
function encodePolylineValue(value) {
  let v = Math.round(value * 1e5);
  v = v < 0 ? ~(v << 1) : v << 1;
  let result = '';
  while (v >= 0x20) {
    result += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  result += String.fromCharCode(v + 63);
  return result;
}

function encodePolyline(points) {
  let prevLat = 0, prevLon = 0, result = '';
  for (const point of points) {
    result += encodePolylineValue(point[0] - prevLat);
    result += encodePolylineValue(point[1] - prevLon);
    prevLat = point[0];
    prevLon = point[1];
  }
  return result;
}

// Decode existing polyline string for merging
function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
}

// Call HERE Routing API to get an encoded flexible polyline
const fetchHerePolyline = async (waypoints, apiKey, mode = 'driving') => {
  const transportMode = mode === 'cycling' ? 'bicycle' : mode === 'pedestrian' ? 'pedestrian' : 'car';
  const origin = `${waypoints[0][0]},${waypoints[0][1]}`;
  const dest = `${waypoints[waypoints.length - 1][0]},${waypoints[waypoints.length - 1][1]}`;
  let url = `https://router.hereapi.com/v8/routes?transportMode=${transportMode}&origin=${origin}&destination=${dest}&return=polyline&apiKey=${apiKey}`;
  for (let i = 1; i < waypoints.length - 1; i++) {
    url += `&via=${waypoints[i][0]},${waypoints[i][1]}`;
  }
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HERE API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const polyline = data?.routes?.[0]?.sections?.[0]?.polyline;
  if (!polyline) throw new Error('HERE API returned no polyline');
  return polyline;
};

// Get coordinates for a delivery stop
const getStopCoords = async (delivery, base44) => {
  if (delivery.patient_id) {
    const lat = Number(delivery.patient_latitude);
    const lng = Number(delivery.patient_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
    return null;
  }
  if (delivery.store_id) {
    const store = await base44.asServiceRole.entities.Store.get(delivery.store_id);
    if (store) {
      const lat = Number(store.latitude);
      const lng = Number(store.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
    }
  }
  return null;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const payload = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    const deliveryData = payload.data || null;
    const delivery_id = payload.delivery_id || payload.event?.entity_id || deliveryData?.id;
    const driver_id = payload.driver_id || deliveryData?.driver_id;
    const delivery_date = payload.delivery_date || deliveryData?.delivery_date;
    const stop_order = payload.stop_order ?? deliveryData?.stop_order;

    if (!delivery_id || !driver_id || !delivery_date || stop_order == null) {
      return Response.json({ error: 'delivery_id, driver_id, delivery_date, and stop_order are required' }, { status: 400 });
    }

    const delivery = deliveryData?.id === delivery_id
      ? deliveryData
      : await base44.asServiceRole.entities.Delivery.get(delivery_id);
    if (!delivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    // Skip if polyline already exists
    if (delivery.encoded_polyline) {
      return Response.json({ success: true, skipped: true, reason: 'polyline_already_exists', delivery_id });
    }

    // Resolve destination coords
    const destCoords = await getStopCoords(delivery, base44);
    if (!destCoords) {
      return Response.json({ success: false, skipped: true, reason: 'no_destination_coords', delivery_id });
    }

    // Resolve origin coords (previous stop or driver home)
    let originCoords = null;
    if (Number(stop_order) > 1) {
      const prevDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id, delivery_date, stop_order: Number(stop_order) - 1,
      });
      const prevDelivery = prevDeliveries?.[0];
      if (prevDelivery) {
        originCoords = await getStopCoords(prevDelivery, base44);
      }
    }

    if (!originCoords) {
      const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driver_id });
      const appUser = appUsers?.[0];
      if (appUser) {
        const lat = Number(appUser.home_latitude);
        const lng = Number(appUser.home_longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) originCoords = [lat, lng];
      }
    }

    if (!originCoords) {
      return Response.json({ success: false, skipped: true, reason: 'no_origin_coords', delivery_id });
    }

    // Fetch breadcrumbs from DeliveryBreadcrumbs entity (new) or PendingBreadcrumbLive (legacy fallback)
    let allRaw = [];

    const breadcrumbRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id, delivery_date, stop_order: Number(stop_order),
    }).catch(() => []);

    if (breadcrumbRecords && breadcrumbRecords.length > 0) {
      // Decode from compact polyline + timestamps format
      for (const record of breadcrumbRecords) {
        if (!record.encoded_polyline || !record.timestamps) continue;
        const coords = decodePolyline(record.encoded_polyline);
        const tsStrings = record.timestamps.split(',');
        coords.forEach((coord, i) => {
          const ts = Number(tsStrings[i]);
          if (Number.isFinite(ts)) allRaw.push([coord[0], coord[1], ts]);
          else allRaw.push([coord[0], coord[1]]);
        });
      }
    } else {
      // Legacy: PendingBreadcrumbLive
      const pendingRecords = await base44.asServiceRole.entities.PendingBreadcrumbLive.filter({
        driver_id, delivery_date, stop_order: Number(stop_order),
      }).catch(() => []);
      allRaw = (pendingRecords || []).flatMap((r) => Array.isArray(r.breadcrumbs) ? r.breadcrumbs : []);
    }

    const normalized = allRaw.map(normalizePoint).filter(Boolean);
    const sorted = normalized.length >= 2 && normalized[0].length >= 3
      ? [...normalized].sort((a, b) => a[2] - b[2])
      : normalized;

    // Build strategic waypoints
    const strategicPoints = subsamplePoints(sorted, originCoords, destCoords);
    if (!strategicPoints || strategicPoints.length < 2) {
      return Response.json({ success: false, skipped: true, reason: 'insufficient_waypoints', delivery_id });
    }

    // Get HERE API key
    const hereApiKeyRes = await base44.asServiceRole.functions.invoke('getActiveHereApiKey', {});
    const hereApiKey = hereApiKeyRes?.api_key || Deno.env.get('HERE_API_KEY');
    if (!hereApiKey) {
      return Response.json({ error: 'No HERE API key available' }, { status: 500 });
    }

    const transportMode = delivery.transport_mode || 'driving';

    // Fetch encoded polyline from HERE (this is the planned/snapped-to-road polyline for Delivery)
    const encodedPolyline = await fetchHerePolyline(strategicPoints, hereApiKey, transportMode);

    // Save encoded polyline to Delivery record
    await base44.asServiceRole.entities.Delivery.update(delivery_id, {
      encoded_polyline: encodedPolyline,
    });

    // Save/update DeliveryBreadcrumbs record with strategic points (compact format)
    const breadcrumbPolyline = encodePolyline(strategicPoints);
    const timestamps = strategicPoints.map((p) => p[2] || 0).join(',');

    const existingBreadcrumb = breadcrumbRecords?.[0] || null;
    const breadcrumbData = {
      driver_id,
      delivery_date,
      stop_order: Number(stop_order),
      delivery_id,
      encoded_polyline: breadcrumbPolyline,
      timestamps,
      transport_mode: transportMode,
      point_count: strategicPoints.length,
    };

    if (existingBreadcrumb?.id) {
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existingBreadcrumb.id, breadcrumbData);
    } else {
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(breadcrumbData);
    }

    // Clean up legacy PendingBreadcrumbLive records if any
    if (breadcrumbRecords.length === 0) {
      const pendingRecords = await base44.asServiceRole.entities.PendingBreadcrumbLive.filter({
        driver_id, delivery_date, stop_order: Number(stop_order),
      }).catch(() => []);
      if (pendingRecords && pendingRecords.length > 0) {
        await Promise.all(pendingRecords.map((r) => base44.asServiceRole.entities.PendingBreadcrumbLive.delete(r.id)));
      }
    }

    return Response.json({
      success: true,
      delivery_id,
      stop_order,
      had_breadcrumbs: normalized.length >= 2,
      raw_point_count: normalized.length,
      strategic_point_count: strategicPoints.length,
      origin_source: Number(stop_order) > 1 ? 'previous_stop' : 'driver_home',
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});