import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const POLY_PRECISION = 1e5;
function encodePolylineValue(value) { let v = Math.round(value * POLY_PRECISION); v = v < 0 ? (-v * 2 - 1) : (v * 2); let r = ''; while (v >= 0x20) { r += String.fromCharCode((0x20 + (v % 0x20)) + 63); v = Math.floor(v / 0x20); } r += String.fromCharCode(v + 63); return r; }
function encodePolyline(points) { let pL = 0, pN = 0, r = ''; for (const p of points) { r += encodePolylineValue(p[0] - pL); r += encodePolylineValue(p[1] - pN); pL = p[0]; pN = p[1]; } return r; }
function decodePolyline(e) { if (!e || typeof e !== 'string') return []; let i = 0, lat = 0, lng = 0; const c = []; while (i < e.length) { let r = 0, m = 1, b; do { b = e.charCodeAt(i++) - 63; r += (b % 32) * m; m *= 32; } while (b >= 0x20); lat += (r % 2 !== 0) ? -((r + 1) / 2) : (r / 2); r = 0; m = 1; do { b = e.charCodeAt(i++) - 63; r += (b % 32) * m; m *= 32; } while (b >= 0x20); lng += (r % 2 !== 0) ? -((r + 1) / 2) : (r / 2); c.push([lat / POLY_PRECISION, lng / POLY_PRECISION]); } return c; }
function isCorruptedPoint(lat, lng) { return Math.abs(lat) > 1 && Math.abs(lng) < 0.01; }
function parseTs(v) { if (v == null) return null; if (typeof v === 'number' && Number.isFinite(v)) { return v > 1e12 ? v : v > 1e9 ? v * 1000 : null; } if (typeof v === 'string') { const t = v.trim(); if (/^\d+$/.test(t)) { const n = Number(t); return n > 1e12 ? n : n > 1e9 ? n * 1000 : null; } const p = new Date(t).getTime(); return Number.isNaN(p) ? null : p; } return null; }

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driver_id, delivery_date, scan_all } = body;

    // If scan_all is true, find ALL driver/date combos with duplicates
    if (scan_all) {
      // Get all master breadcrumb records
      const allMaster = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({ stop_order: -1 }).catch(() => []);
      
      // Group by driver_id + delivery_date
      const groups = {};
      for (const rec of (allMaster || [])) {
        const key = `${rec.driver_id}|${rec.delivery_date}`;
        if (!groups[key]) groups[key] = [];
        groups[key].push(rec);
      }
      
      // Find groups with >1 record
      const duplicates = [];
      for (const [key, recs] of Object.entries(groups)) {
        if (recs.length > 1) {
          const [did, dd] = key.split('|');
          duplicates.push({ driver_id: did, delivery_date: dd, count: recs.length });
        }
      }
      
      return Response.json({ total_groups_with_duplicates: duplicates.length, duplicates });
    }

    if (!driver_id || !delivery_date) {
      return Response.json({ error: 'driver_id and delivery_date required (or scan_all=true)' }, { status: 400 });
    }

    const records = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({ driver_id, delivery_date, stop_order: -1 }).catch(() => []);
    if (!Array.isArray(records) || records.length <= 1) {
      return Response.json({ status: 'no_duplicates', count: records?.length || 0 });
    }

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
      coords.forEach((coord, i) => { const ts = parseTs(tsArr[i]); if (!ts) return; if (isCorruptedPoint(coord[0], coord[1])) { corruptedSkipped++; return; } pointsMap.set(ts, [coord[0], coord[1], ts]); });
    }
    const mergedPoints = Array.from(pointsMap.values()).sort((a, b) => a[2] - b[2]);
    if (mergedPoints.length === 0) return Response.json({ status: 'no_valid_points', count: records.length });

    await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(oldest.id, {
      driver_id, delivery_date, stop_order: -1,
      encoded_polyline: encodePolyline(mergedPoints),
      timestamps: mergedPoints.map(p => p[2]).join(','),
      transport_mode: 'driving', point_count: mergedPoints.length,
    });

    let deletedCount = 0;
    for (const id of dupIds) { try { await base44.asServiceRole.entities.DeliveryBreadcrumbs.delete(id); deletedCount++; } catch (err) {} }

    return Response.json({ status: 'merged', original_count: records.length, merged_points: mergedPoints.length, duplicates_deleted: deletedCount, corrupted_skipped: corruptedSkipped, kept_record_id: oldest.id });
  } catch (error) {
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
});
