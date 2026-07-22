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

// Decode a Google-format polyline. Supports both 1e5 (standard) and 1e7 (high-precision)
// encoded data. We auto-detect precision by checking whether the raw accumulated integer
// values are in a plausible coordinate range for 1e5 first; if not, we fall back to 1e7.
// In practice breadcrumbs stored by this app may have been written at either precision,
// so auto-detection is the safest approach.
function decodePolyline(encoded: string): [number, number][] {
  if (!encoded) return [];
  const rawLats: number[] = [];
  const rawLngs: number[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    rawLats.push(lat);
    rawLngs.push(lng);
  }
  // Auto-detect precision: 1e5 values for valid earth coords are in ±9000000 (lat) / ±18000000 (lng).
  // 1e7 values would be in ±900000000 / ±1800000000. Check the first point.
  const firstLat = rawLats[0] ?? 0;
  const divisor = Math.abs(firstLat) > 9_000_000 ? 1e7 : 1e5;
  return rawLats.map((rawLat, i) => [rawLat / divisor, rawLngs[i] / divisor]);
}

// Breadcrumb polylines use 1e7 precision (client encoder in locationBreadcrumbService.jsx)
const BREADCRUMB_PRECISION = 1e7;

function encodePolylineValue(value: number): string {
  let v = Math.round(value * BREADCRUMB_PRECISION);
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

// ── HERE API key cache (mirrors getHereDirections to avoid extra DB round-trip) ──
const _HERE_SECRET_MAP_SNAP: Record<string, string> = {
  HERE_API_KEY: 'HERE_API_KEY',
  Here_API_Key_2: 'Here_API_Key_2',
  Here_API_Key_3: 'Here_API_Key_3',
};
let _snapHereSecretName: string | null = null;
let _snapHereSecretExpiresAt = 0;

async function getSnapHereApiKey(base44: any): Promise<string | null> {
  const now = Date.now();
  if (_snapHereSecretName && now < _snapHereSecretExpiresAt) {
    return Deno.env.get(_snapHereSecretName) || null;
  }
  const settings = await base44.asServiceRole.entities.AppSettings.filter(
    { setting_key: 'refresh_intervals' }, '-updated_date', 1
  );
  const val = settings?.[0]?.setting_value || {};
  const selected = val.selected_api_key || val.selected_here_api_key || 'HERE_API_KEY';
  _snapHereSecretName = _HERE_SECRET_MAP_SNAP[selected] || 'HERE_API_KEY';
  _snapHereSecretExpiresAt = now + 5 * 60 * 1000;
  return Deno.env.get(_snapHereSecretName) || null;
}

// ── Decode Google polyline returned by HERE (via encodeGooglePolyline in getHereDirections) ──
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

// ── HERE flexible polyline decoder ───────────────────────────────────────────
const HERE_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HERE_DECODE_MAP: Record<string, number> = {};
for (let i = 0; i < HERE_ALPHA.length; i++) HERE_DECODE_MAP[HERE_ALPHA[i]] = i;

function decodeHereFlexiblePolyline(encoded: string): [number, number][] {
  if (!encoded) return [];
  const values: number[] = [];
  let cur = 0, shift = 0;
  for (const ch of encoded) {
    const v = HERE_DECODE_MAP[ch];
    if (v == null) return [];
    cur |= (v & 0x1f) << shift;
    if (v & 0x20) { shift += 5; continue; }
    values.push(cur); cur = 0; shift = 0;
  }
  if (values.length < 2 || values[0] !== 1) return [];
  const precision = values[1] & 15;
  const thirdDim = (values[1] >> 4) & 7;
  const factor = 10 ** precision;
  const dim = thirdDim ? 3 : 2;
  const toSigned = (v: number) => (v & 1) ? ~(v >> 1) : v >> 1;
  let latAcc = 0, lngAcc = 0;
  const coords: [number, number][] = [];
  for (let i = 2; i < values.length; i += dim) {
    latAcc += toSigned(values[i]);
    lngAcc += toSigned(values[i + 1]);
    coords.push([latAcc / factor, lngAcc / factor]);
  }
  return coords;
}

// ── Route a single gap segment directly via HERE Router v8 ───────────────────
// Strategy: use a few dense breadcrumb points BEFORE the gap as a via passThrough
// near the origin, and a few AFTER the gap as a via passThrough near the destination.
// This tells HERE which specific road to anchor to — preventing it from choosing a
// parallel highway, ramp, or service road — without forcing walkway connections.
// We do NOT clamp endpoints back to raw GPS coords; we let HERE's road-snap work
// correctly, anchored by the context vias.
//
// contextBefore: up to 3 real GPS points immediately before the gap (closest last)
// contextAfter:  up to 3 real GPS points immediately after the gap (closest first)
async function routeOneSegment(
  hereApiKey: string,
  fromLat: number, fromLon: number,
  toLat: number, toLon: number,
  transportMode: 'car' | 'bicycle',
  contextBefore: [number, number][] = [],
  contextAfter: [number, number][] = [],
): Promise<[number, number][]> {
  const mode = transportMode === 'bicycle' ? 'bicycle' : 'car';
  const fmt = (v: number) => v.toFixed(7);

  // Use the closest pre-gap point as origin (it's ON the road the driver was on)
  // and the closest post-gap point as destination (it's ON the road they resumed on).
  // The raw gap boundary points are just used for passThrough vias to keep HERE
  // from detouring through a completely different road.
  const originPt = contextBefore.length > 0 ? contextBefore[contextBefore.length - 1] : [fromLat, fromLon];
  const destPt   = contextAfter.length > 0  ? contextAfter[0]                          : [toLat, toLon];

  const params = new URLSearchParams();
  params.set('apiKey', hereApiKey);
  params.set('transportMode', mode);
  params.set('origin', `${fmt(originPt[0])},${fmt(originPt[1])}`);
  params.set('destination', `${fmt(destPt[0])},${fmt(destPt[1])}`);
  params.set('return', 'polyline,summary');

  // Add the gap boundary points as passThrough vias so HERE must cross them.
  // passThrough=true means no stop-over — it just constrains the route to pass
  // through that map location, keeping the route on the correct road.
  params.append('via', `${fmt(fromLat)},${fmt(fromLon)}!passThrough=true`);
  params.append('via', `${fmt(toLat)},${fmt(toLon)}!passThrough=true`);

  try {
    const resp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/json' },
    });
    const data = await resp.json().catch(() => null);

    // Collect all sections (origin→via1, via1→via2, via2→dest) and merge them
    const sections: any[] = data?.routes?.[0]?.sections ?? [];
    if (sections.length === 0) {
      console.warn('[snapMasterTimeline] HERE returned no sections', { fromLat, fromLon, toLat, toLon, status: resp.status });
      return [[fromLat, fromLon], [toLat, toLon]];
    }

    const allCoords: [number, number][] = [];
    for (const section of sections) {
      const decoded = section?.polyline ? decodeHereFlexiblePolyline(section.polyline) : [];
      if (decoded.length < 2) continue;
      if (allCoords.length === 0) {
        allCoords.push(...decoded);
      } else {
        // Skip first point of subsequent sections to avoid duplicates at junctions
        allCoords.push(...decoded.slice(1));
      }
    }

    if (allCoords.length < 2) {
      return [[fromLat, fromLon], [toLat, toLon]];
    }

    return allCoords;
  } catch (err: unknown) {
    console.warn('[snapMasterTimeline] HERE direct route failed:', (err as Error)?.message);
    return [[fromLat, fromLon], [toLat, toLon]];
  }
}

// ── Route one snap zone, loading the HERE key on first call ─────────────────
async function getRoutedSegments(
  base44: any,
  segments: Array<{
    fromLat: number; fromLon: number;
    toLat: number; toLon: number;
    contextBefore?: [number, number][];
    contextAfter?: [number, number][];
  }>,
  transportMode: 'car' | 'bicycle',
): Promise<Array<[number, number][]>> {
  if (segments.length === 0) return [];
  const hereApiKey = await getSnapHereApiKey(base44);
  if (!hereApiKey) {
    console.warn('[snapMasterTimeline] No HERE API key — using straight-line fallback');
    return segments.map(s => [[s.fromLat, s.fromLon], [s.toLat, s.toLon]]);
  }
  return Promise.all(
    segments.map(s => routeOneSegment(
      hereApiKey, s.fromLat, s.fromLon, s.toLat, s.toLon, transportMode,
      s.contextBefore ?? [], s.contextAfter ?? [],
    ))
  );
}

// ── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  let totalApiCalls = 0;

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
      // ── Enrich zone_details with the stop numbers the gap falls between ──────
      // Fetch all delivery stops for this driver/date, sorted by stop_order.
      // For each zone, find the stop whose breadcrumb timestamps bracket the gap.
      try {
        const stops = await base44.asServiceRole.entities.Delivery.filter(
          { driver_id, delivery_date },
          'stop_order',
          200
        ) as any[];

        // Build a sorted list of [stop_order, arrival_time_ms] for stops that have an arrival_time
        const MDT_OFFSET = '-06:00';
        const toUtcMs = (localStr: string): number | null => {
          if (!localStr) return null;
          const trimmed = localStr.trim();
          if (/[Z+-]\d{2}:?\d{2}$/.test(trimmed) || trimmed.endsWith('Z')) {
            const ms = new Date(trimmed).getTime();
            return Number.isNaN(ms) ? null : ms;
          }
          const ms = new Date(trimmed + MDT_OFFSET).getTime();
          return Number.isNaN(ms) ? null : ms;
        };

        const stopTimeline = stops
          .filter((s: any) => !s.is_cycling_marker && s.stop_order != null && s.arrival_time)
          .map((s: any) => ({ stop_order: s.stop_order as number, ts: toUtcMs(s.arrival_time) }))
          .filter((s: any) => s.ts !== null)
          .sort((a: any, b: any) => a.ts - b.ts);

        // For each zone, find the stop BEFORE and AFTER based on the GPS timestamps at zone boundaries
        const enrichedZones = analysisResult.zone_details.map((z: any) => {
          const zoneStartTs = masterPoints[z.start_idx]?.[2] ?? null;
          const zoneEndTs   = masterPoints[z.end_idx]?.[2] ?? null;

          let stop_before: number | null = null;
          let stop_after: number | null = null;

          if (zoneStartTs && stopTimeline.length > 0) {
            // Last stop that arrived before or at the zone start
            const before = stopTimeline.filter((s: any) => s.ts <= zoneStartTs);
            if (before.length > 0) stop_before = before[before.length - 1].stop_order;

            // First stop that arrived after or at the zone end
            const after = stopTimeline.filter((s: any) => s.ts >= (zoneEndTs ?? zoneStartTs));
            if (after.length > 0) stop_after = after[0].stop_order;
          }

          return { ...z, stop_before, stop_after };
        });

        return Response.json({ success: true, analyze_only: true, ...analysisResult, zone_details: enrichedZones });
      } catch (_) {
        // Fall back to plain analysis without stop enrichment
        return Response.json({ success: true, analyze_only: true, ...analysisResult });
      }
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

      // arrival_time is stored as local device time (e.g. "2026-07-20T15:31:00") with NO
      // timezone suffix. The Deno runtime is UTC, so new Date("2026-07-20T15:31:00") would
      // be parsed as UTC — 6 hours too early for Edmonton (MDT = UTC-6).
      // breadcrumb timestamps are true UTC epoch ms, so we must shift arrival_time to UTC
      // by appending the MDT offset before parsing.
      const MDT_OFFSET = '-06:00'; // Mountain Daylight Time (UTC-6, May–Nov)
      const toUtcMs = (localStr: string): number | null => {
        if (!localStr) return null;
        const trimmed = localStr.trim();
        // Already has a timezone designator — parse as-is
        if (/[Z+-]\d{2}:?\d{2}$/.test(trimmed) || trimmed.endsWith('Z')) {
          const ms = new Date(trimmed).getTime();
          return Number.isNaN(ms) ? null : ms;
        }
        // No offset — treat as local MDT and convert to UTC
        const ms = new Date(trimmed + MDT_OFFSET).getTime();
        return Number.isNaN(ms) ? null : ms;
      };

      let pendingStartMs: number | null = null;
      for (const stop of markerStops) {
        const notes: string = (stop.delivery_notes || '').trim();
        const ts = toUtcMs(stop.arrival_time);
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
      contextBefore: [number, number][];
      contextAfter: [number, number][];
    }

    // How many dense real GPS points to use as road-context anchors on each side of a gap.
    const CONTEXT_PTS = 3;

    const zoneSegments: ZoneSegment[] = zones.map((zone, zi) => {
      const startPt = masterPoints[zone.startIdx];
      const endPt = masterPoints[zone.endIdx];
      const travelMode = isZoneCycling(startPt[2], endPt[2]) ? 'bicycle' : 'car';

      // Points immediately BEFORE the gap — these are real GPS points on the road
      // the driver was on. Use up to CONTEXT_PTS of them, closest to gap last.
      const beforeStart = Math.max(0, zone.startIdx - CONTEXT_PTS);
      const contextBefore: [number, number][] = masterPoints
        .slice(beforeStart, zone.startIdx)
        .map(p => [p[0], p[1]]);

      // Points immediately AFTER the gap — these are real GPS points on the road
      // the driver resumed on. Use up to CONTEXT_PTS of them, closest to gap first.
      const afterEnd = Math.min(masterPoints.length, zone.endIdx + 1 + CONTEXT_PTS);
      const contextAfter: [number, number][] = masterPoints
        .slice(zone.endIdx + 1, afterEnd)
        .map(p => [p[0], p[1]]);

      return {
        zoneIndex: zi,
        zone,
        fromLat: startPt[0], fromLon: startPt[1],
        toLat: endPt[0], toLon: endPt[1],
        travelMode,
        contextBefore,
        contextAfter,
      };
    });

    // ── 6. Call getHereDirections once per snap zone (each zone is independent) ──
    // Zones are spatially disjoint — they must NOT be batched together into one
    // multi-waypoint call, as the routing engine would try to connect them as a
    // single continuous route across distant unrelated legs.
    const routedCoordsByZoneIndex = new Map<number, [number, number][]>();

    for (const seg of zoneSegments) {
      console.log(`[snapMasterTimeline] Snapping zone ${seg.zoneIndex + 1}/${zoneSegments.length} mode=${seg.travelMode}`);
      const routedResults = await getRoutedSegments(base44, [{
        fromLat: seg.fromLat, fromLon: seg.fromLon,
        toLat: seg.toLat, toLon: seg.toLon,
        contextBefore: seg.contextBefore,
        contextAfter: seg.contextAfter,
      }], seg.travelMode);
      totalApiCalls += 1;
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

    console.log(`[snapMasterTimeline] ✅ Saved — ${masterPoints.length} pts → ${resultCoords.length} pts, ${zones.length} zones snapped in ${totalApiCalls} API call(s)`);

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
      api_calls_made: totalApiCalls,
      consolidate_result: consolidateResult,
    });

  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[snapMasterTimeline] Error:', msg);
    return Response.json({ error: msg || 'Internal error' }, { status: 500 });
  }
});