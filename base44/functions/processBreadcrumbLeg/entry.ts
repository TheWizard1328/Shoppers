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

// Pick N evenly-spaced interior indices from an array (not including 0 and last)
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

  // If no breadcrumb interior points, just return origin + dest directly
  if (points.length < 2) {
    return [origin, dest];
  }

  const totalKm = pathDistanceKm(points);

  // Scale interior waypoints: 0 for <1km, 1 for 1–5km, 2 for 5–15km, 3 for >15km
  let interiorCount = 0;
  if (totalKm >= 15) interiorCount = 3;
  else if (totalKm >= 5) interiorCount = 2;
  else if (totalKm >= 1) interiorCount = 1;

  const interior = interiorCount > 0 ? evenlySpacedInterior(points, interiorCount) : [];
  return [origin, ...interior, dest];
};

// Call HERE Routing API to get an encoded flexible polyline
const fetchHerePolyline = async (waypoints, apiKey, mode = 'driving') => {
  const transportMode = mode === 'cycling' ? 'bicycle' : mode === 'pedestrian' ? 'pedestrian' : 'car';
  const origin = `${waypoints[0][0]},${waypoints[0][1]}`;
  const dest = `${waypoints[waypoints.length - 1][0]},${waypoints[waypoints.length - 1][1]}`;

  let url = `https://router.hereapi.com/v8/routes?transportMode=${transportMode}&origin=${origin}&destination=${dest}&return=polyline&apiKey=${apiKey}`;

  // Add intermediate via points if any
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

// Get coordinates for a delivery stop: patient coords if patient delivery, store coords if store pickup
const getStopCoords = async (delivery, base44) => {
  if (delivery.patient_id) {
    const lat = Number(delivery.patient_latitude);
    const lng = Number(delivery.patient_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng];
    return null;
  }
  // Store pickup — fetch store coords
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

    // Support both: manual call (delivery_id etc.) and entity automation (event + data)
    const deliveryData = payload.data || null;
    const delivery_id = payload.delivery_id || payload.event?.entity_id || deliveryData?.id;
    const driver_id = payload.driver_id || deliveryData?.driver_id;
    const delivery_date = payload.delivery_date || deliveryData?.delivery_date;
    const stop_order = payload.stop_order ?? deliveryData?.stop_order;

    if (!delivery_id || !driver_id || !delivery_date || stop_order == null) {
      return Response.json({ error: 'delivery_id, driver_id, delivery_date, and stop_order are required', received: { delivery_id, driver_id, delivery_date, stop_order } }, { status: 400 });
    }

    // Use inline delivery data from automation payload if available, else fetch
    const delivery = deliveryData?.id === delivery_id ? deliveryData : await base44.asServiceRole.entities.Delivery.get(delivery_id);
    if (!delivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    // Skip if polyline already exists
    if (delivery.encoded_polyline) {
      return Response.json({ success: true, skipped: true, reason: 'polyline_already_exists', delivery_id });
    }

    // ── Resolve destination coords (current stop) ────────────────────────────
    const destCoords = await getStopCoords(delivery, base44);
    if (!destCoords) {
      return Response.json({ success: false, skipped: true, reason: 'no_destination_coords', delivery_id });
    }

    // ── Resolve origin coords (previous stop or driver home) ─────────────────
    let originCoords = null;

    if (Number(stop_order) > 1) {
      // Look up the previous stop in this route
      const prevDeliveries = await base44.asServiceRole.entities.Delivery.filter({
        driver_id,
        delivery_date,
        stop_order: Number(stop_order) - 1,
      });
      const prevDelivery = prevDeliveries?.[0];
      if (prevDelivery) {
        originCoords = await getStopCoords(prevDelivery, base44);
      }
    }

    // Fallback to driver's home coordinates for first stop or if previous stop has no coords
    if (!originCoords) {
      const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driver_id });
      const appUser = appUsers?.[0];
      if (appUser) {
        const lat = Number(appUser.home_latitude);
        const lng = Number(appUser.home_longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          originCoords = [lat, lng];
        }
      }
    }

    if (!originCoords) {
      return Response.json({ success: false, skipped: true, reason: 'no_origin_coords', delivery_id });
    }

    // ── Fetch PendingBreadcrumbLive records ──────────────────────────────────
    const pendingRecords = await base44.asServiceRole.entities.PendingBreadcrumbLive.filter({
      driver_id,
      delivery_date,
      stop_order: Number(stop_order),
    });

    // Merge and sort all breadcrumb points by timestamp
    const allRaw = (pendingRecords || []).flatMap(r => Array.isArray(r.breadcrumbs) ? r.breadcrumbs : []);
    const normalized = allRaw.map(normalizePoint).filter(Boolean);

    const sorted = normalized.length >= 2 && normalized[0].length >= 3
      ? [...normalized].sort((a, b) => a[2] - b[2])
      : normalized;

    // Build strategic waypoints — always uses originCoords + destCoords as anchors
    // If no breadcrumbs, subsamplePoints will just return [origin, dest]
    const strategicPoints = subsamplePoints(sorted, originCoords, destCoords);

    if (!strategicPoints || strategicPoints.length < 2) {
      return Response.json({ success: false, skipped: true, reason: 'insufficient_waypoints', delivery_id });
    }

    // ── Get HERE API key ─────────────────────────────────────────────────────
    const hereApiKeyRes = await base44.asServiceRole.functions.invoke('getActiveHereApiKey', {});
    const hereApiKey = hereApiKeyRes?.api_key || Deno.env.get('HERE_API_KEY');

    if (!hereApiKey) {
      return Response.json({ error: 'No HERE API key available' }, { status: 500 });
    }

    const transportMode = delivery.transport_mode || 'driving';

    // ── Fetch encoded polyline from HERE ─────────────────────────────────────
    const encodedPolyline = await fetchHerePolyline(strategicPoints, hereApiKey, transportMode);

    // ── Save strategic points + encoded polyline back to Delivery ────────────
    await base44.asServiceRole.entities.Delivery.update(delivery_id, {
      delivery_route_breadcrumbs: strategicPoints,
      encoded_polyline: encodedPolyline,
    });

    // ── Clean up PendingBreadcrumbLive records (if any) ───────────────────────
    if (pendingRecords && pendingRecords.length > 0) {
      await Promise.all(pendingRecords.map(r => base44.asServiceRole.entities.PendingBreadcrumbLive.delete(r.id)));
    }

    return Response.json({
      success: true,
      delivery_id,
      stop_order,
      had_breadcrumbs: normalized.length >= 2,
      raw_point_count: normalized.length,
      strategic_point_count: strategicPoints.length,
      pending_records_deleted: pendingRecords?.length || 0,
      origin_source: Number(stop_order) > 1 ? 'previous_stop' : 'driver_home',
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});