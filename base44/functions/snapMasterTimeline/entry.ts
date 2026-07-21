import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ─── snapMasterTimeline ────────────────────────────────────────────────────────
// Surgical gap-fill snapping of the master GPS breadcrumb timeline (stop_order = -1).
//
// Strategy:
//   1. Decode all GPS points from the master record.
//   2. Identify "gap segments" where the Haversine distance between consecutive
//      points exceeds GAP_THRESHOLD_M (default 500m).
//   3. Consolidate adjacent/nearby gap segments into "snap zones".
//   4. Collect all zone boundary points and call getHereDirections ONCE (or once
//      per transport-mode group) via the same multi-segment pattern used by
//      purgeAndRegeneratePolylines — no more per-zone RouteMatch calls.
//   5. Stitch the routed bridges back into the original dense array.
//   6. Re-encode the stitched result + preserve original timestamps.
//
// Modes:
//   analyze_only=true  → Return gap analysis (no API calls, no save)
//   preview_only=true  → Snap + return result (no save)
//   default            → Snap + save + optionally re-consolidate
// ─────────────────────────────────────────────────────────────────────────────

const GAP_THRESHOLD_M = 500;   // metres — gaps above this need fixing
const MIN_DENSE_POINTS = 3;    // fewer dense points between gaps → merge into one zone

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
  startIdx: number;
  endIdx: number;
  distanceM: number;
}

interface SnapZone {
  startIdx: number;
  endIdx: number;
  gaps: GapInfo[];
  pointsInZone: number;
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
    const denseBetween = gap.startIdx - current.endIdx;
    if (denseBetween <= minDensePoints) {
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

// ── Decode Google polyline returned by getHereDirections ──────────────────────
function decodeGooglePolyline(encoded: string): [number, number][] {
  if (!encoded) return [];
  const coords: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

// ── Call getHereDirections for a batch of segments ────────────────────────────
// Uses the same multi-segment / preserveWaypointOrder pattern as purgeAndRegeneratePolylines.
// Returns one decoded [lat,lon][] per segment (falls back to straight-line on error).
async function getRoutedSegments(
  base44: any,
  segments: Array<{ fromLat: number; fromLon: number; toLat: number; toLon: number }>,
  transportMode: 'car' | 'bicycle',
): Promise<Array<[number, number][]>> {
  if (segments.length === 0) return [];

  const hereMode = transportMode === 'bicycle' ? 'cycling' : 'driving';
  const origin = { lat: segments[0].fromLat, lng: segments[0].fromLon };
  const destination = { lat: segments[segments.length - 1].toLat, lng: segments[segments.length - 1].toLon };
  // All intermediate "to" points become waypoints
  const waypoints = segments.slice(0, -1).map(s => ({ lat: s.toLat, lng: s.toLon }));

  try {
    const response = await base44.functions.invoke('getHereDirections', {
      origin,
      destination,
      waypoints,
      preserveWaypointOrder: true,
      skipSequenceApi: true,
      transportMode: hereMode,
      caller: 'snapMasterTimeline',
      caller_context: { segmentCount: segments.length },
    });

    const data = response?.data || response || {};
    const sections: any[] = Array.isArray(data?.sections) ? data.sections : [];

    return segments.map((seg, i) => {
      const section = sections[i];
      const ep: string | null = section?.encoded_polyline || null;
      if (ep) {
        const decoded = decodeGooglePolyline(ep);
        if (decoded.length >= 2) return decoded;
      }
      // Fallback: straight line
      return [[seg.fromLat, seg.fromLon], [seg.toLat, seg.toLon]];
    });
  } catch (err: unknown) {
    console.warn('[snapMasterTimeline] getHereDirections batch failed:', (err as Error)?.message);
    return segments.map(seg => [[seg.fromLat, seg.fromLon], [seg.toLat, seg.toLon]]);
  }
}

// ── API Usage Logger ──────────────────────────────────────────────────────────
async function logApiUsage(base44: any, {
  userId, userName, success, durationMs, callCount, errorMessage, metadata = {}
}: {
  userId?: string; userName?: string; success: boolean; durationMs: number;
  callCount: number; errorMessage?: string; metadata?: Record<string, unknown>;
}) {
  try {
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Directions (HERE)',
      purpose: 'snapMasterTimeline — batch gap-fill via HERE Router',
      function_name: 'snapMasterTimeline',
      user_id: userId || null,
      user_name: userName || null,
      metadata: {
        api_provider: 'here',
        call_count: callCount,
        success,
        duration_ms: durationMs,
        error_message: errorMessage || undefined,
        ...metadata,
      },
    });
  } catch (e: unknown) {
    console.warn('[snapMasterTimeline] Failed to write API log:', (e as Error)?.message);
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const startedAt = Date.now();
  let totalApiCalls = 0;
  let logUserId: string | undefined;
  let logUserName: string | undefined;

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    logUserId = user.id;
    logUserName = user.full_name || user.email;

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
      estimated_api_calls: zones.length, // 1 call per snap zone (each zone is independent)
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

    if (analyze_only) {
      return Response.json({ success: true, analyze_only: true, ...analysisResult });
    }

    if (zones.length === 0) {
      return Response.json({
        success: true,
        message: 'No gaps found above threshold — master timeline is already clean.',
        ...analysisResult,
      });
    }

    // ── 4. Build cycling brackets from marker stops ───────────────────────────
    interface CyclingBracket { startMs: number; endMs: number; }
    const cyclingBrackets: CyclingBracket[] = [];
    try {
      const markerStops = await base44.asServiceRole.entities.Delivery.filter(
        { driver_id, delivery_date, is_cycling_marker: true },
        'arrival_time',
        100
      ) as any[];

      markerStops.sort((a: any, b: any) =>
        (a.arrival_time || '').localeCompare(b.arrival_time || '')
      );

      let pendingStartMs: number | null = null;
      for (const stop of markerStops) {
        const notes: string = (stop.delivery_notes || '').trim();
        const ts = parseTimestampMs(stop.arrival_time);
        if (!ts) continue;
        if (notes === 'Cycling Route Start') {
          pendingStartMs = ts;
        } else if (notes === 'Cycling Route End' && pendingStartMs !== null) {
          cyclingBrackets.push({ startMs: pendingStartMs, endMs: ts });
          pendingStartMs = null;
        }
      }
    } catch (e: unknown) {
      console.warn('[snapMasterTimeline] Could not fetch cycling markers:', (e as Error)?.message);
    }

    const isZoneCycling = (zoneStartMs: number, zoneEndMs: number): boolean =>
      cyclingBrackets.some(b => zoneStartMs >= b.startMs && zoneEndMs <= b.endMs);

    // ── 5. Build segment specs for all zones ──────────────────────────────────
    // Each zone is represented as a single segment: start-point → end-point.
    // We send them all to getHereDirections in one batch per transport-mode group.
    interface ZoneSegment {
      zoneIndex: number;
      zone: SnapZone;
      fromLat: number; fromLon: number;
      toLat: number; toLon: number;
      travelMode: 'car' | 'bicycle';
    }

    const zoneSegments: ZoneSegment[] = zones.map((zone, zi) => {
      const startPt = masterPoints[zone.startIdx];
      const endPt = masterPoints[zone.endIdx];
      const travelMode = isZoneCycling(startPt[2], endPt[2]) ? 'bicycle' : 'car';
      return {
        zoneIndex: zi,
        zone,
        fromLat: startPt[0], fromLon: startPt[1],
        toLat: endPt[0], toLon: endPt[1],
        travelMode,
      };
    });

    // ── 6. Call getHereDirections once per snap zone (each zone is independent) ──
    // Zones are spatially disjoint — they must NOT be batched together into one
    // multi-waypoint call, as the routing engine would try to connect them as a
    // single continuous route across distant unrelated legs.
    const routedCoordsByZoneIndex = new Map<number, [number, number][]>();

    for (const seg of zoneSegments) {
      console.log(`[snapMasterTimeline] Snapping zone ${seg.zoneIndex + 1}/${zoneSegments.length} mode=${seg.travelMode}`);
      const zoneStart = Date.now();
      const routedResults = await getRoutedSegments(base44, [seg], seg.travelMode);
      totalApiCalls += 1;
      await logApiUsage(base44, {
        userId: logUserId,
        userName: logUserName,
        success: true,
        durationMs: Date.now() - zoneStart,
        callCount: 1,
        metadata: {
          transport_mode: seg.travelMode,
          zone_index: seg.zoneIndex + 1,
          zone_count: zoneSegments.length,
          driver_id,
          delivery_date,
        },
      });
      routedCoordsByZoneIndex.set(seg.zoneIndex, routedResults[0]);
    }

    // ── 7. Stitch results back into master points ─────────────────────────────
    const resultCoords: [number, number][] = masterPoints.map(p => [p[0], p[1]]);
    const resultTs: number[] = masterPoints.map(p => p[2]);

    let offset = 0;
    for (const seg of zoneSegments) {
      const zi = seg.zoneIndex;
      const zone = seg.zone;
      const snappedZone = routedCoordsByZoneIndex.get(zi) ?? [[seg.fromLat, seg.fromLon], [seg.toLat, seg.toLon]];

      const adjStart = zone.startIdx + offset;
      const adjEnd = zone.endIdx + offset;

      // Assign timestamps proportionally across snapped points
      const zoneTs = masterPoints.slice(zone.startIdx, zone.endIdx + 1).map(p => p[2]);
      const snappedZoneTs: number[] = snappedZone.map((_, i) => {
        const ratio = snappedZone.length > 1 ? i / (snappedZone.length - 1) : 0;
        const srcIdx = Math.min(Math.round(ratio * (zoneTs.length - 1)), zoneTs.length - 1);
        return zoneTs[srcIdx];
      });

      const deleteCount = adjEnd - adjStart + 1;
      resultCoords.splice(adjStart, deleteCount, ...snappedZone);
      resultTs.splice(adjStart, deleteCount, ...snappedZoneTs);
      offset += snappedZone.length - deleteCount;
    }

    const snappedPolyline = encodePolyline(resultCoords);
    const snappedTimestamps = resultTs.join(',');

    if (preview_only) {
      // Return only the per-zone bridging segments so the UI can overlay just the gaps,
      // not the entire merged route.
      const previewZoneSegments = zoneSegments.map(seg => {
        const coords = routedCoordsByZoneIndex.get(seg.zoneIndex) ?? [[seg.fromLat, seg.fromLon], [seg.toLat, seg.toLon]];
        return {
          zone_index: seg.zoneIndex,
          from: [seg.fromLat, seg.fromLon],
          to: [seg.toLat, seg.toLon],
          encoded_polyline: encodePolyline(coords as [number, number][]),
          point_count: coords.length,
        };
      });

      return Response.json({
        success: true,
        preview_only: true,
        driver_id,
        delivery_date,
        ...analysisResult,
        snapped_point_count: resultCoords.length,
        zones_snapped: zones.length,
        api_calls_made: totalApiCalls,
        snapped_polyline: snappedPolyline,
        snapped_timestamps: snappedTimestamps,
        preview_zone_segments: previewZoneSegments,
      });
    }

    // ── 8. Save ───────────────────────────────────────────────────────────────
    await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(master.id, {
      encoded_polyline: snappedPolyline,
      timestamps: snappedTimestamps,
      point_count: resultCoords.length,
    });

    console.log(`[snapMasterTimeline] ✅ Saved — ${masterPoints.length} pts → ${resultCoords.length} pts, ${zones.length} zones snapped in ${groups.length} API call(s)`);

    // ── 9. Re-consolidate stop segments ──────────────────────────────────────
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
      api_calls_made: groups.length,
      consolidate_result: consolidateResult,
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[snapMasterTimeline] Error:', msg);
    // Log the failure if we got far enough to have a base44 client
    try {
      const base44Err = createClientFromRequest(req);
      await logApiUsage(base44Err, {
        userId: logUserId,
        userName: logUserName,
        success: false,
        durationMs: Date.now() - startedAt,
        callCount: totalApiCalls,
        errorMessage: msg,
      });
    } catch (_) { /* swallow */ }
    return Response.json({ error: msg || 'Internal error' }, { status: 500 });
  }
});