import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ─── snapMasterTimeline ────────────────────────────────────────────────────────
// Surgical gap-fill snapping of the master GPS breadcrumb timeline (stop_order = -1).
//
// Strategy:
//   1. Decode all GPS points from the master record.
//   2. Identify "gap segments" where the Haversine distance between consecutive
//      points exceeds GAP_THRESHOLD_M (default 500m).
//   3. Consolidate adjacent/nearby gap segments into "snap zones" to minimize
//      API calls — if two gaps are separated by fewer than MIN_DENSE_POINTS
//      dense points, merge them into one zone.
//   4. For each snap zone, call HERE RouteMatch with the boundary points +
//      any sparse intermediate points inside the zone (≤100 total per call).
//   5. Stitch the snapped bridges back into the original dense array.
//   6. Re-encode the stitched result + preserve original timestamps.
//
// Modes:
//   analyze_only=true  → Return gap analysis (no API calls, no save)
//   preview_only=true  → Snap + return result (no save)
//   default            → Snap + save + optionally re-consolidate
// ─────────────────────────────────────────────────────────────────────────────

const GAP_THRESHOLD_M = 500;      // metres — gaps above this need fixing
const MIN_DENSE_POINTS = 3;       // fewer dense points between gaps → merge into one zone
const MAX_WAYPOINTS_PER_CALL = 98; // leave 2 slots for boundary overlap points

// ── Geometry ─────────────────────────────────────────────────────────────────
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

// ── Gap Analysis ─────────────────────────────────────────────────────────────
interface GapInfo {
  startIdx: number;  // index of the point BEFORE the gap
  endIdx: number;    // index of the point AFTER the gap
  distanceM: number;
}

interface SnapZone {
  startIdx: number;  // first point of the zone (inclusive — kept in output)
  endIdx: number;    // last point of the zone (inclusive — kept in output)
  gaps: GapInfo[];   // gaps consolidated into this zone
  pointsInZone: number; // total raw points from startIdx to endIdx
}

function findGaps(points: [number, number, number][], thresholdM: number): GapInfo[] {
  const gaps: GapInfo[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const d = haversineM(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
    if (d > thresholdM) {
      gaps.push({ startIdx: i, endIdx: i + 1, distanceM: d });
    }
  }
  return gaps;
}

function consolidateGapsIntoZones(gaps: GapInfo[], minDensePoints: number): SnapZone[] {
  if (gaps.length === 0) return [];
  const zones: SnapZone[] = [];
  let current: SnapZone = {
    startIdx: gaps[0].startIdx,
    endIdx: gaps[0].endIdx,
    gaps: [gaps[0]],
    pointsInZone: gaps[0].endIdx - gaps[0].startIdx + 1,
  };

  for (let i = 1; i < gaps.length; i++) {
    const gap = gaps[i];
    const denseBetween = gap.startIdx - current.endIdx; // # of dense points between zones
    if (denseBetween <= minDensePoints) {
      // Merge into current zone
      current.endIdx = gap.endIdx;
      current.gaps.push(gap);
      current.pointsInZone = current.endIdx - current.startIdx + 1;
    } else {
      zones.push(current);
      current = {
        startIdx: gap.startIdx,
        endIdx: gap.endIdx,
        gaps: [gap],
        pointsInZone: gap.endIdx - gap.startIdx + 1,
      };
    }
  }
  zones.push(current);
  return zones;
}

// ── HERE RouteMatch call ──────────────────────────────────────────────────────
async function snapZoneWithHere(
  waypoints: [number, number, number][],
  apiKey: string,
): Promise<[number, number][]> {
  const wpStr = waypoints
    .map(([lat, lon, ts]) => `${lat.toFixed(6)},${lon.toFixed(6)},${Math.round(ts / 1000)}`)
    .join('&waypoint=');

  const url =
    `https://routematching.hereapi.com/v8/match/routelinks` +
    `?waypoint=${wpStr}` +
    `&mode=retrieveLinks` +
    `&apiKey=${apiKey}`;

  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url);
    if (res.status !== 429) break;
    const delay = 1000 * Math.pow(2, attempt);
    console.warn(`[snapMasterTimeline] HERE 429 — retry ${attempt + 1} in ${delay}ms`);
    await new Promise(r => setTimeout(r, delay));
  }

  if (!res || !res.ok) {
    console.warn(`[snapMasterTimeline] HERE HTTP ${res?.status} — keeping raw zone points`);
    return waypoints.map(([lat, lon]) => [lat, lon]);
  }

  const json = await res.json().catch(() => null);
  const matched: Array<{ mappedPosition?: { lat: number; lng: number } }> =
    json?.response?.route?.[0]?.waypoint ?? [];

  const snapped: [number, number][] = matched
    .filter(wp => wp?.mappedPosition?.lat != null)
    .map(wp => [wp.mappedPosition!.lat, wp.mappedPosition!.lng]);

  if (snapped.length < 2) {
    console.warn('[snapMasterTimeline] HERE returned no usable snapped positions — keeping raw');
    return waypoints.map(([lat, lon]) => [lat, lon]);
  }
  return snapped;
}

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const {
      driver_id,
      delivery_date,
      run_consolidate = true,
      preview_only = false,
      analyze_only = false,
      gap_threshold_m = GAP_THRESHOLD_M,
    } = body;

    if (!driver_id || !delivery_date) {
      return Response.json({ error: 'driver_id and delivery_date are required' }, { status: 400 });
    }

    // ── 1. Fetch master record ────────────────────────────────────────────────
    const masterRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: -1,
    }).catch(() => []);
    const master = (masterRecords as any[])?.[0] ?? null;

    if (!master?.encoded_polyline || !master?.timestamps) {
      return Response.json({ success: false, error: 'No master timeline record found (stop_order = -1)' }, { status: 404 });
    }

    // ── 2. Decode points ──────────────────────────────────────────────────────
    const rawCoords = decodePolyline(master.encoded_polyline);
    const rawTs: number[] = (master.timestamps as string).split(',').map(Number);

    const masterPoints: [number, number, number][] = rawCoords
      .map((coord, i): [number, number, number] | null => {
        const ts = parseTimestampMs(rawTs[i]);
        return ts ? [coord[0], coord[1], ts] : null;
      })
      .filter((p): p is [number, number, number] => p !== null);

    if (masterPoints.length < 2) {
      return Response.json({ success: false, error: 'Master timeline has fewer than 2 valid points' });
    }

    // ── 3. Gap analysis ───────────────────────────────────────────────────────
    const gaps = findGaps(masterPoints, gap_threshold_m);
    const zones = consolidateGapsIntoZones(gaps, MIN_DENSE_POINTS);

    const analysisResult = {
      total_points: masterPoints.length,
      gap_threshold_m,
      raw_gaps_found: gaps.length,
      snap_zones: zones.length,
      estimated_api_calls: zones.length,
      zone_details: zones.map((z, i) => ({
        zone_index: i + 1,
        start_idx: z.startIdx,
        end_idx: z.endIdx,
        points_in_zone: z.pointsInZone,
        gaps_in_zone: z.gaps.length,
        max_gap_m: Math.round(Math.max(...z.gaps.map(g => g.distanceM))),
        total_gap_distance_m: Math.round(z.gaps.reduce((s, g) => s + g.distanceM, 0)),
      })),
    };

    // analyze_only → return analysis without making any API calls
    if (analyze_only) {
      return Response.json({ success: true, analyze_only: true, ...analysisResult });
    }

    // No gaps → nothing to snap
    if (zones.length === 0) {
      return Response.json({
        success: true,
        message: 'No gaps found above threshold — master timeline is already clean.',
        ...analysisResult,
      });
    }

    // ── 4. Fetch HERE API key ─────────────────────────────────────────────────
    const HERE_SECRET_MAP: Record<string, string> = {
      HERE_API_KEY: 'HERE_API_KEY',
      Here_API_Key_2: 'Here_API_Key_2',
      Here_API_Key_3: 'Here_API_Key_3',
    };
    const settings = await base44.asServiceRole.entities.AppSettings.filter(
      { setting_key: 'refresh_intervals' }, '-updated_date', 1
    ).catch(() => []);
    const settingValue = (settings as any[])?.[0]?.setting_value || {};
    const selectedKey = settingValue.selected_api_key || settingValue.selected_here_api_key || 'HERE_API_KEY';
    const secretName = HERE_SECRET_MAP[selectedKey] || 'HERE_API_KEY';
    const hereApiKey: string | undefined = Deno.env.get(secretName);
    if (!hereApiKey) {
      return Response.json({ error: `No HERE API key configured (secret: ${secretName})` }, { status: 500 });
    }

    // ── 5. Surgical snapping — build a mutable copy of master coords ──────────
    // We'll replace the points inside each snap zone with snapped bridge points,
    // leaving all points outside zones completely untouched.
    const resultCoords: [number, number][] = masterPoints.map(p => [p[0], p[1]]);
    const resultTs: number[] = masterPoints.map(p => p[2]);

    // Track offset as we splice zones (splicing changes array length)
    let offset = 0;

    for (let zi = 0; zi < zones.length; zi++) {
      const zone = zones[zi];
      const adjStart = zone.startIdx + offset;
      const adjEnd   = zone.endIdx + offset;

      // Collect all raw points inside the zone (inclusive of boundary points)
      const zonePoints = masterPoints.slice(zone.startIdx, zone.endIdx + 1);

      // If the zone has more points than HERE allows, thin it by keeping
      // the gap boundary points and picking evenly spaced intermediates.
      let waypoints: [number, number, number][];
      if (zonePoints.length <= MAX_WAYPOINTS_PER_CALL) {
        waypoints = zonePoints;
      } else {
        // Always keep first and last; sample MAX-2 intermediates evenly
        const intermediates = zonePoints.slice(1, -1);
        const step = Math.max(1, Math.floor(intermediates.length / (MAX_WAYPOINTS_PER_CALL - 2)));
        const sampled = intermediates.filter((_, i) => i % step === 0).slice(0, MAX_WAYPOINTS_PER_CALL - 2);
        waypoints = [zonePoints[0], ...sampled, zonePoints[zonePoints.length - 1]];
      }

      console.log(`[snapMasterTimeline] Zone ${zi + 1}/${zones.length}: idx ${zone.startIdx}–${zone.endIdx} (${waypoints.length} waypoints → HERE)`);

      const snappedZone = await snapZoneWithHere(waypoints, hereApiKey);

      // Assign timestamps to snapped points proportionally from original zone timestamps
      const zoneTs = zonePoints.map(p => p[2]);
      const snappedZoneTs: number[] = snappedZone.map((_, i) => {
        const ratio = snappedZone.length > 1 ? i / (snappedZone.length - 1) : 0;
        const srcIdx = Math.min(Math.round(ratio * (zoneTs.length - 1)), zoneTs.length - 1);
        return zoneTs[srcIdx];
      });

      // Replace zone slice in result arrays
      const deleteCount = adjEnd - adjStart + 1;
      resultCoords.splice(adjStart, deleteCount, ...snappedZone);
      resultTs.splice(adjStart, deleteCount, ...snappedZoneTs);
      offset += snappedZone.length - deleteCount;

      // Pause between calls
      if (zi < zones.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    const snappedPolyline = encodePolyline(resultCoords);
    const snappedTimestamps = resultTs.join(',');

    // ── 6. Preview-only → return without saving ───────────────────────────────
    if (preview_only) {
      return Response.json({
        success: true,
        preview_only: true,
        driver_id,
        delivery_date,
        ...analysisResult,
        snapped_point_count: resultCoords.length,
        zones_snapped: zones.length,
        snapped_polyline: snappedPolyline,
        snapped_timestamps: snappedTimestamps,
      });
    }

    // ── 7. Save ───────────────────────────────────────────────────────────────
    await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(master.id, {
      encoded_polyline: snappedPolyline,
      timestamps: snappedTimestamps,
      point_count: resultCoords.length,
    });

    console.log(`[snapMasterTimeline] ✅ Saved — ${masterPoints.length} pts → ${resultCoords.length} pts, ${zones.length} zones snapped`);

    // ── 8. Re-consolidate stop segments ──────────────────────────────────────
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
      ...analysisResult,
      snapped_point_count: resultCoords.length,
      zones_snapped: zones.length,
      consolidate_result: consolidateResult,
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[snapMasterTimeline] Error:', msg);
    return Response.json({ error: msg || 'Internal error' }, { status: 500 });
  }
});