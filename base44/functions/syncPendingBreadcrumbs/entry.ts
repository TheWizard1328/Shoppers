import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ─── syncPendingBreadcrumbs ────────────────────────────────────────────────────
// Receives the full 'TODAY' master breadcrumb timeline from the mobile client and
// appends any new points to the single master record for that driver/date.
// stop_order = -1 is the sentinel for the unsegmented master timeline.
// The consolidateBreadcrumbs function is responsible for slicing this into stops.
// ──────────────────────────────────────────────────────────────────────────────

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

function parseTimestampMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : null;
    }
    const parsed = new Date(trimmed).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driver_id, delivery_date, encoded_polyline: incomingPolyline, timestamps: incomingTimestamps, point_count } = body;

    if (!driver_id || !delivery_date || !incomingPolyline) {
      return Response.json({ error: 'driver_id, delivery_date, and encoded_polyline are required' }, { status: 400 });
    }

    // Security: driver can only write their own record (admins may pass any driver_id)
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const appUser = appUsers?.[0] || null;
    const isAdmin = Array.isArray(appUser?.app_roles) && appUser.app_roles.includes('admin');
    if (driver_id !== user.id && !isAdmin) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Decode incoming points from the client
    const incomingCoords = decodePolyline(incomingPolyline);
    const incomingTs = (incomingTimestamps || '').split(',').map(Number);
    const incomingPoints = incomingCoords.map((coord, i) => [coord[0], coord[1], incomingTs[i] || 0]);

    // Fetch existing master record (stop_order = -1)
    const existingRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: -1,
    }).catch(() => []);
    const existingRecord = existingRecords?.[0] || null;

    // Merge: existing points + incoming points, de-duplicated by timestamp, sorted
    const existingPoints = [];
    if (existingRecord?.encoded_polyline && existingRecord?.timestamps) {
      const coords = decodePolyline(existingRecord.encoded_polyline);
      const tsArr = existingRecord.timestamps.split(',').map(Number);
      coords.forEach((coord, i) => {
        const ts = parseTimestampMs(tsArr[i]);
        if (ts) existingPoints.push([coord[0], coord[1], ts]);
      });
    }

    // Merge by timestamp — prefer incoming points (they are the latest from client)
    const tsMap = new Map();
    for (const pt of existingPoints) tsMap.set(pt[2], pt);
    for (const pt of incomingPoints) { if (pt[2]) tsMap.set(pt[2], pt); }

    const mergedPoints = Array.from(tsMap.values()).sort((a, b) => a[2] - b[2]);

    if (mergedPoints.length === 0) {
      return Response.json({ status: 'skipped', reason: 'no_valid_points' });
    }

    const encodedPolyline = encodePolyline(mergedPoints);
    const timestamps = mergedPoints.map((p) => p[2]).join(',');

    const masterRecord = {
      driver_id,
      delivery_date,
      stop_order: -1, // Sentinel: master timeline
      encoded_polyline: encodedPolyline,
      timestamps,
      transport_mode: 'driving',
      point_count: mergedPoints.length,
    };

    if (existingRecord?.id) {
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existingRecord.id, masterRecord);
    } else {
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(masterRecord);
    }

    return Response.json({
      status: 'synced',
      driver_id,
      delivery_date,
      point_count: mergedPoints.length,
      new_points: incomingPoints.length,
      merged: existingPoints.length > 0,
    });
  } catch (error) {
    console.error('❌ [syncPendingBreadcrumbs] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
});