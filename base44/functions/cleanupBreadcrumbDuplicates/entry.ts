import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const POLY_PRECISION = 1e5;

function encodePolylineValue(value) {
  let v = Math.round(value * POLY_PRECISION);
  v = v < 0 ? (-v * 2 - 1) : (v * 2);
  let result = '';
  while (v >= 0x20) { result += String.fromCharCode((0x20 + (v % 0x20)) + 63); v = Math.floor(v / 0x20); }
  result += String.fromCharCode(v + 63);
  return result;
}

function encodePolyline(points) {
  let prevLat = 0, prevLon = 0, result = '';
  for (const p of points) { result += encodePolylineValue(p[0] - prevLat); result += encodePolylineValue(p[1] - prevLon); prevLat = p[0]; prevLon = p[1]; }
  return result;
}

function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0; const coords = [];
  while (index < encoded.length) {
    let result = 0, multiplier = 1, byte;
    do { byte = encoded.charCodeAt(index++) - 63; result += (byte % 32) * multiplier; multiplier *= 32; } while (byte >= 0x20);
    lat += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    result = 0; multiplier = 1;
    do { byte = encoded.charCodeAt(index++) - 63; result += (byte % 32) * multiplier; multiplier *= 32; } while (byte >= 0x20);
    lng += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    coords.push([lat / POLY_PRECISION, lng / POLY_PRECISION]);
  }
  return coords;
}

function isCorruptedPoint(lat, lng) { return Math.abs(lat) > 1 && Math.abs(lng) < 0.01; }

function parseTimestampMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) { return value > 1e12 ? value : value > 1e9 ? value * 1000 : null; }
  if (typeof value === 'string') { const t = value.trim(); if (/^\d+$/.test(t)) { const n = Number(t); return n > 1e12 ? n : n > 1e9 ? n * 1000 : null; } const p = new Date(t).getTime(); return Number.isNaN(p) ? null : p; }
  return null;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driver_id, delivery_date } = body;

    if (!driver_id || !delivery_date) {
      return Response.json({ error: 'driver_id and delivery_date are required' }, { status: 400 });
    }

    const records = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id, delivery_date, stop_order: -1,
    }).catch(() => []);

    if (!Array.isArray(records) || records.length <= 1) {
      return Response.json({ status: 'no_duplicates', count: records?.length || 0 });
    }

    console.warn(`⚠️ [cleanup] Found ${records.length} duplicate master records for driver=${driver_id} date=${delivery_date} — merging.`);

    const sorted = [...records].sort((a, b) => {
      const aT = a?.created_date ? new Date(a.created_date).getTime() : 0;
      const bT = b?.created_date ? new Date(b.created_date).getTime() : 0;
      return aT - bT;
    });

    const oldest = sorted[0];
    const dupIds = sorted.slice(1).map(r => r.id).filter(Boolean);

    const pointsMap = new Map();
    let corruptedSkipped = 0;
    for (const rec of sorted) {
      if (!rec?.encoded_polyline || !rec?.timestamps) continue;
      const coords = decodePolyline(rec.encoded_polyline);
      const tsArr = rec.timestamps.split(',').map(Number);
      coords.forEach((coord, i) => {
        const ts = parseTimestampMs(tsArr[i]);
        if (!ts) return;
        if (isCorruptedPoint(coord[0], coord[1])) { corruptedSkipped++; return; }
        pointsMap.set(ts, [coord[0], coord[1], ts]);
      });
    }

    const mergedPoints = Array.from(pointsMap.values()).sort((a, b) => a[2] - b[2]);

    if (mergedPoints.length === 0) {
      return Response.json({ status: 'no_valid_points', count: records.length });
    }

    await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(oldest.id, {
      driver_id, delivery_date, stop_order: -1,
      encoded_polyline: encodePolyline(mergedPoints),
      timestamps: mergedPoints.map(p => p[2]).join(','),
      transport_mode: 'driving',
      point_count: mergedPoints.length,
    });

    let deletedCount = 0;
    for (const id of dupIds) {
      try { await base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(id); deletedCount++; }
      catch (err) { console.warn(`⚠️ [cleanup] Failed to delete ${id}:`, err?.message || err); }
    }

    return Response.json({
      status: 'merged', original_count: records.length,
      merged_points: mergedPoints.length, duplicates_deleted: deletedCount,
      corrupted_skipped: corruptedSkipped, kept_record_id: oldest.id,
    });
  } catch (error) {
    console.error('❌ [cleanup] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
});
