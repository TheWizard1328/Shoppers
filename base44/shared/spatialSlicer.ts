// ═══════════════════════════════════════════════════════════════════════════════
// spatialSlicer — First-Local-Minimum Spatial Breadcrumb Slicing
// ═══════════════════════════════════════════════════════════════════════════════
//
// Timestamp-free boundary matching for consolidateBreadcrumbSegment.
// Walks the master trail by array index; for each stop (in stop_order) tracks
// the running minimum-distance trail point and accepts it only once the trail
// has genuinely DEPARTED (moved DEPARTURE_THRESHOLD_M past the minimum). This
// locks onto the real arrive-then-leave cluster instead of a later drive-by
// pass, and works on hand-edited / road-snapped trails whose injected points
// carry no timestamp.
//
// When a stop has no trail coverage (never reached, GPS dropout, completed
// before tracking), a 2-point synthetic leg connects the previous boundary
// (or the route origin) to the stop's coordinates.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Haversine distance (meters) ─────────────────────────────────────────────
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Accept the running minimum only once the trail has moved this far PAST it.
// Confirms a real depart-after-arrival, not a GPS jitter dip.
export const DEPARTURE_THRESHOLD_M = 60;

// Beyond this, an accepted minimum is treated as "driver never reached the stop"
// → synthesize a 2-point leg instead of a bogus long one.
export const SANITY_MAX_M = 1000;

export interface StopWithCoords {
  delivery: any;
  coords: { lat: number; lng: number };
}

export interface SlicedSegment {
  delivery: any;
  stopOrder: number;
  points: number[][]; // [lat, lng, ts]
  pointCount: number;
  matchDistance: number;
  method: string;
  synthetic: boolean;
}

/**
 * Slice the master trail into one segment per stop using first-local-minimum
 * spatial matching.
 *
 * @param masterPoints  Decoded trail points as [lat, lng, ts] in recorded order.
 * @param stopsWithCoords  Stops with resolved coordinates, in stop_order.
 * @param originCoords  Route origin (store/home) for the first synthetic leg.
 * @returns One SlicedSegment per stop, in stop_order.
 */
export function sliceSegmentsByFirstLocalMinimum(
  masterPoints: number[][],
  stopsWithCoords: StopWithCoords[],
  originCoords: { lat: number; lng: number } | null,
): SlicedSegment[] {
  const segments: SlicedSegment[] = [];
  let cursor = 0;                 // first unconsumed trail index
  let lastRealTrailIdx = -1;       // trail index of the last accepted boundary
  let lastRealCoords: number[] | null =
    originCoords ? [originCoords.lat, originCoords.lng] : null;

  for (let s = 0; s < stopsWithCoords.length; s++) {
    const swc = stopsWithCoords[s];
    const stopLat = swc.coords.lat;
    const stopLng = swc.coords.lng;
    const stopOrder = Number(swc.delivery.stop_order);

    let bestIdx: number | null = null;
    let bestDist = Infinity;
    let accepted = false;

    // Scan from the cursor forward; track the running minimum; accept it once
    // the trail departs DEPARTURE_THRESHOLD_M past that minimum.
    for (let i = cursor; i < masterPoints.length; i++) {
      const dist = haversineMeters(stopLat, stopLng, masterPoints[i][0], masterPoints[i][1]);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
      if (bestIdx !== null && dist > bestDist + DEPARTURE_THRESHOLD_M) {
        accepted = true;
        break;
      }
    }

    const hasCoverage = accepted && bestDist <= SANITY_MAX_M;

    if (hasCoverage && bestIdx !== null) {
      // Real segment: trail points from just after the previous real boundary
      // to this boundary (inclusive).
      const startIdx = lastRealTrailIdx + 1;
      const endIdx = bestIdx;
      const points = masterPoints.slice(startIdx, endIdx + 1);
      segments.push({
        delivery: swc.delivery,
        stopOrder,
        points,
        pointCount: points.length,
        matchDistance: bestDist,
        method: 'first-local-min',
        synthetic: false,
      });
      lastRealTrailIdx = endIdx;
      lastRealCoords = [masterPoints[endIdx][0], masterPoints[endIdx][1]];
      cursor = endIdx + 1;
    } else {
      // No coverage: synthesize a 2-point leg [origin, stopCoords].
      const origin = lastRealCoords
        || (masterPoints.length > 0 ? [masterPoints[0][0], masterPoints[0][1]] : [stopLat, stopLng]);
      segments.push({
        delivery: swc.delivery,
        stopOrder,
        points: [
          [origin[0], origin[1], 0],
          [stopLat, stopLng, 0],
        ],
        pointCount: 2,
        matchDistance: bestIdx !== null ? bestDist : Infinity,
        method: 'no-coverage',
        synthetic: true,
      });
      // cursor and lastRealTrailIdx unchanged — no trail consumed.
    }
  }

  return segments;
}