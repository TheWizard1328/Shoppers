import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';

// ─── migrateBreadcrumbPrecision ──────────────────────────────────────────────
// One-time migration: re-encode every DeliveryBreadcrumbs.encoded_polyline from
// the legacy 1e5 (5dp) precision to the new 1e7 (7dp) precision, in place.
//
// This normalizes historical breadcrumb trails so the new 1e7 decoders render them
// at full precision. Idempotent: records already at 1e7 (decoded at 1e5 → coords
// outside the valid ±90/±180 degree range) are skipped, so re-running is safe.
//
// Admin-only. Run once after deploying the 1e7 encoder bump. Existing
// Delivery.encoded_polyline records (HERE/Google route polylines, 1e5) are NOT
// touched — they stay at 1e5 for the standard route renderer.
// ──────────────────────────────────────────────────────────────────────────────

// Decode at a fixed precision (used to probe 1e5).
function decodeAt(encoded, precision) {
  if (!encoded || typeof encoded !== 'string') return [];
  const poly = [];
  let index = 0, len = encoded.length, lat = 0, lng = 0;
  while (index < len) {
    let b, result = 0, multiplier = 1;
    do { b = encoded.charCodeAt(index++) - 63; result += (b % 32) * multiplier; multiplier *= 32; } while (b >= 0x20);
    lat += ((result % 2 !== 0) ? -((result + 1) / 2) : (result / 2));
    result = 0; multiplier = 1;
    do { b = encoded.charCodeAt(index++) - 63; result += (b % 32) * multiplier; multiplier *= 32; } while (b >= 0x20);
    lng += ((result % 2 !== 0) ? -((result + 1) / 2) : (result / 2));
    poly.push([lat / precision, lng / precision]);
  }
  return poly;
}

// Arithmetic (non-bitwise) encoder — safe at 1e7 for Edmonton longitudes.
function encodeAt(points, precision) {
  const encodeValue = (val) => {
    let v = Math.round(val * precision);
    v = v < 0 ? (-v * 2 - 1) : (v * 2);
    let result = '';
    while (v >= 0x20) { result += String.fromCharCode((0x20 + (v % 0x20)) + 63); v = Math.floor(v / 0x20); }
    result += String.fromCharCode(v + 63);
    return result;
  };
  let prevLat = 0, prevLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    encoded += encodeValue(lat - prevLat) + encodeValue(lng - prevLng);
    prevLat = lat; prevLng = lng;
  }
  return encoded;
}

function looksLikeLegacy1e5(coords) {
  // Legacy 1e5 data decoded at 1e5 yields valid earth coords (|lat|<=90, |lng|<=180).
  // Already-migrated 1e7 data decoded at 1e5 yields coords ~100× too large.
  if (!Array.isArray(coords) || coords.length === 0) return false;
  return coords.every(([lat, lng]) =>
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  );
}

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dry_run === true;
    // One-time admin migration: fetch all breadcrumb records in a single high-limit
    // pass. Idempotent (already-1e7 records are skipped), so re-run if has_more is
    // true (the store exceeded the fetch limit). Uses bulkUpdate (up to 500/call)
    // to avoid per-record API rate limits.
    const fetchLimit = Math.min(Number(body?.batch_size) || 50000, 100000);
    const BULK_CHUNK = 200;

    let migrated = 0;
    let skippedAlready1e7 = 0;
    let skippedEmpty = 0;
    let skippedInvalid = 0;
    let processed = 0;

    const records = await base44.asServiceRole.entities.DeliveryBreadcrumbs.list('id', fetchLimit).catch(() => []);
    const list = Array.isArray(records) ? records : [];

    // Build the list of records that need migration.
    const pendingUpdates = [];
    for (const rec of list) {
      processed++;
      if (!rec?.encoded_polyline) { skippedEmpty++; continue; }

      const as1e5 = decodeAt(rec.encoded_polyline, 1e5);
      if (!looksLikeLegacy1e5(as1e5)) {
        if (as1e5.length === 0) skippedEmpty++;
        else skippedAlready1e7++;
        continue;
      }

      if (dryRun) { migrated++; continue; }

      pendingUpdates.push({
        id: rec.id,
        encoded_polyline: encodeAt(as1e5, 1e7),
        point_count: as1e5.length,
      });
    }

    // Apply updates in bulk chunks to stay under the API rate limit.
    for (let i = 0; i < pendingUpdates.length; i += BULK_CHUNK) {
      const chunk = pendingUpdates.slice(i, i + BULK_CHUNK);
      try {
        const res = await base44.asServiceRole.entities.DeliveryBreadcrumbs.bulkUpdate(chunk);
        // bulkUpdate returns the count of updated records (or an array). Count what we can.
        const count = typeof res === 'number' ? res : (Array.isArray(res) ? res.length : chunk.length);
        migrated += count > 0 ? count : chunk.length;
      } catch (err) {
        console.warn(`⚠️ [migrateBreadcrumbPrecision] bulkUpdate chunk failed:`, err?.message || err);
        skippedInvalid += chunk.length;
      }
    }

    return Response.json({
      success: true,
      dry_run: dryRun,
      processed,
      migrated,
      skipped_already_1e7: skippedAlready1e7,
      skipped_empty: skippedEmpty,
      skipped_invalid: skippedInvalid,
      has_more: list.length >= fetchLimit,
    });
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
}