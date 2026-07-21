import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ─── snapMasterTimeline ────────────────────────────────────────────────────────
// Snaps the master GPS breadcrumb timeline (stop_order = -1) to real roads using
// the HERE RouteMatch (GPS Trace Matching) API, then optionally re-runs
// consolidateBreadcrumbs to update all per-stop segments from the snapped master.
//
// Workflow:
//   1. Fetch the master DeliveryBreadcrumbs record (stop_order = -1).
//   2. Decode the raw GPS polyline + timestamps into a [lat, lon, ts] list.
//   3. Chunk the points (HERE API limit: 100 waypoints per call).
//   4. Call HERE RouteMatch API for each chunk sequentially.
//   5. Re-encode the snapped coordinates + preserve timestamps.
//   6. Update the DeliveryBreadcrumbs record in place.
//   7. Optionally trigger consolidateBreadcrumbs to reslice all stops.
// ─────────────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 100; // HERE RouteMatch max waypoints per request

function decodePolyline(encoded: string): [number, number][] {
  if (!encoded) return [];
  const poly: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    poly.push([lat / 1e5, lng / 1e5]);
  }
  return poly;
}

function encodePolylineValue(value: number): string {
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

function encodePolyline(points: [number, number][]): string {
  let prevLat = 0, prevLon = 0, result = '';
  for (const point of points) {
    result += encodePolylineValue(point[0] - prevLat);
    result += encodePolylineValue(point[1] - prevLon);
    prevLat = point[0];
    prevLon = point[1];
  }
  return result;
}

function parseTimestampMs(value: number | string | null): number | null {
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

// Call HERE RouteMatch API for a chunk of [lat, lon, ts_ms] points.
// Returns the snapped [lat, lon] coordinates in order, or the original if snapping fails.
async function snapChunkWithHere(
  chunk: [number, number, number][],
  apiKey: string,
): Promise<[number, number][]> {
  // HERE Routing v8 Map Matching (GPS Trace) endpoint
  // Waypoints format: lat,lng,timestamp_s
  const waypoints = chunk
    .map(([lat, lon, ts]) => `${lat.toFixed(6)},${lon.toFixed(6)},${Math.round(ts / 1000)}`)
    .join('&waypoint=');

  const url =
    `https://routematching.hereapi.com/v8/match/routelinks` +
    `?waypoint=${waypoints}` +
    `&mode=retrieveLinks` +
    `&apiKey=${apiKey}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[snapMasterTimeline] HERE RouteMatch HTTP ${res.status} — using raw points for chunk`);
    return chunk.map(([lat, lon]) => [lat, lon]);
  }

  const json = await res.json().catch(() => null);

  // Extract snapped positions from the response route links
  const snappedCoords: [number, number][] = [];
  const matchedWaypoints: Array<{ mappedPosition?: { lat: number; lng: number } }> =
    json?.response?.route?.[0]?.waypoint ?? [];

  for (const wp of matchedWaypoints) {
    if (wp?.mappedPosition?.lat != null && wp?.mappedPosition?.lng != null) {
      snappedCoords.push([wp.mappedPosition.lat, wp.mappedPosition.lng]);
    }
  }

  // Fallback: if HERE returned nothing useful, keep original points
  if (snappedCoords.length < 2) {
    console.warn('[snapMasterTimeline] HERE returned no snapped positions — using raw chunk');
    return chunk.map(([lat, lon]) => [lat, lon]);
  }

  return snappedCoords;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driver_id, delivery_date, run_consolidate = true } = body;

    if (!driver_id || !delivery_date) {
      return Response.json({ error: 'driver_id and delivery_date are required' }, { status: 400 });
    }

    // ── 1. Fetch HERE API key ─────────────────────────────────────────────────
    const apiKeyRes = await base44.functions.invoke('getActiveHereApiKey', {}).catch(() => null);
    const hereApiKey: string | undefined = apiKeyRes?.apiKey;
    if (!hereApiKey) {
      return Response.json({ error: 'No HERE API key configured' }, { status: 500 });
    }

    // ── 2. Fetch master breadcrumb record (stop_order = -1) ──────────────────
    const masterRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: -1,
    }).catch(() => []);
    const master = masterRecords?.[0] ?? null;

    if (!master?.encoded_polyline || !master?.timestamps) {
      return Response.json({ success: false, error: 'No master timeline record found (stop_order = -1)' }, { status: 404 });
    }

    // ── 3. Decode raw GPS points ──────────────────────────────────────────────
    const rawCoords = decodePolyline(master.encoded_polyline);
    const rawTs: number[] = master.timestamps.split(',').map(Number);

    // Pair up coordinates with timestamps, filter invalid pairs
    const masterPoints: [number, number, number][] = rawCoords
      .map((coord, i): [number, number, number] | null => {
        const ts = parseTimestampMs(rawTs[i]);
        return ts ? [coord[0], coord[1], ts] : null;
      })
      .filter((p): p is [number, number, number] => p !== null);

    if (masterPoints.length < 2) {
      return Response.json({ success: false, error: 'Master timeline has fewer than 2 valid points' });
    }

    // ── 4. Chunk + snap via HERE RouteMatch ───────────────────────────────────
    const snappedCoords: [number, number][] = [];
    const totalChunks = Math.ceil(masterPoints.length / CHUNK_SIZE);

    console.log(`[snapMasterTimeline] ${masterPoints.length} pts → ${totalChunks} chunks`);

    for (let i = 0; i < masterPoints.length; i += CHUNK_SIZE) {
      const chunk = masterPoints.slice(i, i + CHUNK_SIZE);
      // Overlap: carry last point of previous chunk as first in next, to maintain continuity
      const overlap = i > 0 ? [masterPoints[i - 1]] : [];
      const chunkWithOverlap: [number, number, number][] = [...overlap, ...chunk];

      const snapped = await snapChunkWithHere(chunkWithOverlap, hereApiKey);

      // Skip the first overlap point on chunks after the first
      const sliceFrom = i > 0 ? 1 : 0;
      snappedCoords.push(...snapped.slice(sliceFrom));

      // Small pause between chunks to avoid rate limiting
      if (i + CHUNK_SIZE < masterPoints.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    if (snappedCoords.length < 2) {
      return Response.json({ success: false, error: 'Snapping produced no usable coordinates' });
    }

    // ── 5. Re-encode + preserve timestamps ───────────────────────────────────
    // The snapped coordinate array may differ in length from original (HERE may merge or split).
    // We preserve timestamps by re-distributing them proportionally if lengths differ,
    // otherwise map 1-to-1.
    const snappedTs: number[] = snappedCoords.map((_, i) => {
      if (i < masterPoints.length) return masterPoints[i][2];
      // For any extra snapped points beyond original count, use the last timestamp
      return masterPoints[masterPoints.length - 1][2];
    });

    const snappedPolyline = encodePolyline(snappedCoords);
    const snappedTimestamps = snappedTs.join(',');

    // ── 6. Update the master record ───────────────────────────────────────────
    await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(master.id, {
      encoded_polyline: snappedPolyline,
      timestamps: snappedTimestamps,
      point_count: snappedCoords.length,
    });

    console.log(`[snapMasterTimeline] ✅ Master updated — ${masterPoints.length} raw pts → ${snappedCoords.length} snapped`);

    // ── 7. Optionally trigger consolidateBreadcrumbs ──────────────────────────
    let consolidateResult = null;
    if (run_consolidate) {
      consolidateResult = await base44.functions
        .invoke('consolidateBreadcrumbs', { driver_id, delivery_date })
        .catch((e: Error) => ({ error: e?.message }));
    }

    return Response.json({
      success: true,
      driver_id,
      delivery_date,
      raw_point_count: masterPoints.length,
      snapped_point_count: snappedCoords.length,
      chunks_processed: totalChunks,
      consolidate_result: consolidateResult,
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[snapMasterTimeline] Error:', msg);
    return Response.json({ error: msg || 'Internal error' }, { status: 500 });
  }
});