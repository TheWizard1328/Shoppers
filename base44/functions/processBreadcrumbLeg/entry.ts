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
  // Build full point list: prefer delivery stop coords for origin/dest for accuracy
  const origin = originCoords ? [...originCoords] : points[0];
  const dest = destCoords ? [...destCoords] : points[points.length - 1];

  if (points.length <= 2) {
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const payload = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    const { delivery_id, driver_id, delivery_date, stop_order } = payload;

    if (!delivery_id || !driver_id || !delivery_date || stop_order == null) {
      return Response.json({ error: 'delivery_id, driver_id, delivery_date, and stop_order are required' }, { status: 400 });
    }

    // Fetch the delivery record
    const delivery = await base44.asServiceRole.entities.Delivery.get(delivery_id);
    if (!delivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    // Skip if polyline already exists
    if (delivery.encoded_polyline) {
      return Response.json({ success: true, skipped: true, reason: 'polyline_already_exists', delivery_id });
    }

    // Fetch matching PendingBreadcrumbLive records
    const pendingRecords = await base44.asServiceRole.entities.PendingBreadcrumbLive.filter({
      driver_id,
      delivery_date,
      stop_order: Number(stop_order),
    });

    if (!pendingRecords || pendingRecords.length === 0) {
      return Response.json({ success: false, skipped: true, reason: 'no_pending_breadcrumbs', delivery_id });
    }

    // Merge and sort all breadcrumb points by timestamp
    const allRaw = pendingRecords.flatMap(r => Array.isArray(r.breadcrumbs) ? r.breadcrumbs : []);
    const normalized = allRaw.map(normalizePoint).filter(Boolean);

    if (normalized.length < 2) {
      return Response.json({ success: false, skipped: true, reason: 'insufficient_points', delivery_id, point_count: normalized.length });
    }

    // Sort by timestamp if available
    const sorted = normalized[0].length >= 3
      ? [...normalized].sort((a, b) => a[2] - b[2])
      : normalized;

    // Get origin/dest from delivery patient or store coords (prefer actual stop coords)
    // Previous stop coords would be the origin — we use the first breadcrumb as proxy if not available
    // Destination is the delivery's patient coords
    const destLat = delivery.patient_latitude ?? null;
    const destLng = delivery.patient_longitude ?? null;
    const destCoords = (Number.isFinite(destLat) && Number.isFinite(destLng)) ? [destLat, destLng] : null;

    const strategicPoints = subsamplePoints(sorted, null, destCoords);

    // Get HERE API key
    const hereApiKeyRes = await base44.asServiceRole.functions.invoke('getActiveHereApiKey', {});
    const hereApiKey = hereApiKeyRes?.api_key || Deno.env.get('HERE_API_KEY');

    if (!hereApiKey) {
      return Response.json({ error: 'No HERE API key available' }, { status: 500 });
    }

    const transportMode = delivery.transport_mode || 'driving';

    // Fetch encoded polyline from HERE
    const encodedPolyline = await fetchHerePolyline(strategicPoints, hereApiKey, transportMode);

    // Save strategic points + encoded polyline back to Delivery
    await base44.asServiceRole.entities.Delivery.update(delivery_id, {
      delivery_route_breadcrumbs: strategicPoints,
      encoded_polyline: encodedPolyline,
    });

    // Clean up PendingBreadcrumbLive records
    await Promise.all(pendingRecords.map(r => base44.asServiceRole.entities.PendingBreadcrumbLive.delete(r.id)));

    return Response.json({
      success: true,
      delivery_id,
      stop_order,
      raw_point_count: normalized.length,
      strategic_point_count: strategicPoints.length,
      pending_records_deleted: pendingRecords.length,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});