import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);

// ── Delivery ID prefix classification ────────────────────────────────────────
function classifyDelivery(d: any): 'delivery' | 'cycling' | 'interstore' | 'store_pickup' {
  const did = String(d.delivery_id || '').toUpperCase();
  if (did.startsWith('BIK')) return 'cycling';
  if (did.startsWith('ISP') || did.startsWith('ISD')) return 'interstore';
  if (did.startsWith('DID')) return 'delivery';
  return 'store_pickup';
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Polyline encoding — 1e7 precision ────────────────────────────────────────
const POLY_PRECISION = 1e7;

function encodePolylineValue(value: number): string {
  let v = Math.round(value * POLY_PRECISION);
  v = v < 0 ? ~(v << 1) : v << 1;
  let result = '';
  while (v >= 0x20) {
    result += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  result += String.fromCharCode(v + 63);
  return result;
}

function encodePolyline(points: number[][]): string {
  let prevLat = 0, prevLon = 0, result = '';
  for (const point of points) {
    result += encodePolylineValue(point[0] - prevLat);
    result += encodePolylineValue(point[1] - prevLon);
    prevLat = point[0];
    prevLon = point[1];
  }
  return result;
}

function decodePolyline(encoded: string): number[][] {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates: number[][] = [];
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
    coordinates.push([lat / POLY_PRECISION, lng / POLY_PRECISION]);
  }
  return coordinates;
}

function dedupeSequential(points: number[][]): number[][] {
  const result: number[][] = [];
  for (const point of points) {
    const prev = result[result.length - 1];
    if (!prev || prev[0] !== point[0] || prev[1] !== point[1]) {
      result.push(point);
    }
  }
  return result;
}

/**
 * Starting from searchFromIndex, find the index in masterPoints that is
 * spatially closest to (stopLat, stopLon). The search is strictly forward-only.
 *
 * To avoid snapping to a brief coincidental close-pass before the driver
 * actually arrives at the stop, we scan the entire remaining segment and
 * return the index of the globally-closest point from searchFromIndex onward.
 */
function findClosestPointFromIndex(
  masterPoints: number[][],
  searchFromIndex: number,
  stopLat: number,
  stopLon: number
): number {
  let bestIdx = searchFromIndex;
  let bestDist = Infinity;

  for (let i = searchFromIndex; i < masterPoints.length; i++) {
    const dist = haversineMeters(stopLat, stopLon, masterPoints[i][0], masterPoints[i][1]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// ── Unified waypoint type ─────────────────────────────────────────────────────
interface UnifiedStop {
  stop_order: number;
  lat: number;
  lon: number;
  type: 'delivery' | 'cycling' | 'interstore' | 'store_pickup';
  deliveryId: string;
  transport_mode: string;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const deliveryData = body.data || null;
    const driver_id = body.driver_id || deliveryData?.driver_id;
    const delivery_date = body.delivery_date || deliveryData?.delivery_date;

    if (!driver_id || !delivery_date) {
      return Response.json({ error: 'driver_id and delivery_date are required' }, { status: 400 });
    }

    // ── 1. Fetch master breadcrumb (stop_order = -1) ──────────────────────────
    const masterRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: -1,
    }).catch(() => []);
    const masterRecord = masterRecords?.[0] || null;

    if (!masterRecord?.encoded_polyline) {
      return Response.json({
        success: true, driver_id, delivery_date,
        master_point_count: 0, stops_sliced: 0, stops_skipped_saved: 0,
        stops_skipped_other: 0, stops_missing: 0, stops_thin: 0,
        results: [], reason: 'no_master_timeline_record',
      });
    }

    // Parse master timeline as a plain ordered array of [lat, lon] — NO timestamp sorting.
    // The polyline is already in sequential GPS order as recorded.
    const masterPoints: number[][] = decodePolyline(masterRecord.encoded_polyline);
    // Also parse timestamps in parallel so we can carry them through to the per-stop records
    const masterTs: (number | null)[] = (masterRecord.timestamps || '')
      .split(',')
      .map((v: string) => { const n = Number(v.trim()); return Number.isFinite(n) && n > 1e9 ? n : null; });

    if (masterPoints.length === 0) {
      return Response.json({
        success: true, driver_id, delivery_date,
        master_point_count: 0, stops_sliced: 0, stops_skipped_saved: 0,
        stops_skipped_other: 0, stops_missing: 0, stops_thin: 0,
        results: [], reason: 'empty_master_timeline',
      });
    }

    // ── 2. Fetch all deliveries for this driver/date ──────────────────────────
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter(
      { driver_id, delivery_date },
      'stop_order',
      50000
    );

    // Only terminal stops with a stop_order
    const terminalDeliveries = (allDeliveries || [])
      .filter((d: any) => d && d.stop_order != null && TERMINAL_STATUSES.has(String(d.status || '')));

    // ── 3. Collect coordinate IDs for bulk fetch ──────────────────────────────
    const storeIds = [...new Set(terminalDeliveries.map((d: any) => d.store_id).filter(Boolean))];
    const patientIds = [...new Set(terminalDeliveries.map((d: any) => d.patient_id).filter(Boolean))];
    const interstoreIds = [...new Set([
      ...terminalDeliveries.map((d: any) => d._interstore_source_id).filter(Boolean),
      ...terminalDeliveries.map((d: any) => d._interstore_dest_id).filter(Boolean),
    ])];

    // ── 4. Bulk fetch coordinates in parallel ────────────────────────────────
    const [stores, patients, interstoreLocations] = await Promise.all([
      storeIds.length > 0
        ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }, 'id', 50000).catch(() => [])
        : Promise.resolve([]),
      patientIds.length > 0
        ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }, 'id', 50000).catch(() => [])
        : Promise.resolve([]),
      interstoreIds.length > 0
        ? base44.asServiceRole.entities.InterStoreLocation.filter({ id: { $in: interstoreIds } }, 'id', 50000).catch(() => [])
        : Promise.resolve([]),
    ]);

    const storeGpsMap = new Map<string, { lat: number; lon: number }>();
    for (const s of (stores || [])) {
      if (s?.id && Number.isFinite(Number(s.latitude)) && Number.isFinite(Number(s.longitude))) {
        storeGpsMap.set(s.id, { lat: Number(s.latitude), lon: Number(s.longitude) });
      }
    }

    const patientGpsMap = new Map<string, { lat: number; lon: number }>();
    for (const p of (patients || [])) {
      if (p?.id && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude))) {
        patientGpsMap.set(p.id, { lat: Number(p.latitude), lon: Number(p.longitude) });
      }
    }

    const interstoreGpsMap = new Map<string, { lat: number; lon: number }>();
    for (const loc of (interstoreLocations || [])) {
      if (loc?.id && Number.isFinite(Number(loc.store_latitude)) && Number.isFinite(Number(loc.store_longitude))) {
        interstoreGpsMap.set(loc.id, { lat: Number(loc.store_latitude), lon: Number(loc.store_longitude) });
      }
    }

    // ── 5. Resolve GPS coords for each stop ──────────────────────────────────
    function resolveStopCoords(d: any): { lat: number; lon: number } {
      const type = classifyDelivery(d);
      if (type === 'delivery') {
        return patientGpsMap.get(d.patient_id) ?? { lat: NaN, lon: NaN };
      }
      if (type === 'cycling') {
        return {
          lat: Number.isFinite(Number(d.cycling_latitude)) ? Number(d.cycling_latitude) : NaN,
          lon: Number.isFinite(Number(d.cycling_longitude)) ? Number(d.cycling_longitude) : NaN,
        };
      }
      if (type === 'interstore') {
        const did = String(d.delivery_id || '').toUpperCase();
        const locationId = did.startsWith('ISD') ? d._interstore_dest_id : d._interstore_source_id;
        return interstoreGpsMap.get(locationId) ?? { lat: NaN, lon: NaN };
      }
      if (type === 'store_pickup') {
        return storeGpsMap.get(d.store_id) ?? { lat: NaN, lon: NaN };
      }
      return { lat: NaN, lon: NaN };
    }

    // ── 6. Build stop list sorted strictly by stop_order ─────────────────────
    const unifiedStops: UnifiedStop[] = terminalDeliveries
      .map((d: any) => {
        const coords = resolveStopCoords(d);
        return {
          stop_order: Number(d.stop_order),
          lat: coords.lat,
          lon: coords.lon,
          type: classifyDelivery(d),
          deliveryId: d.id,
          transport_mode: d.transport_mode || 'driving',
        };
      })
      .sort((a: UnifiedStop, b: UnifiedStop) => a.stop_order - b.stop_order);

    if (unifiedStops.length === 0) {
      return Response.json({
        success: true, driver_id, delivery_date,
        master_point_count: masterPoints.length,
        stops_sliced: 0, stops_skipped_saved: 0, stops_skipped_other: 0,
        stops_missing: 0, stops_thin: 0, results: [],
        reason: 'no_terminal_stops',
      });
    }

    // ── 7. Fetch existing per-stop breadcrumb records ─────────────────────────
    const existingStopRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter(
      { driver_id, delivery_date },
      'stop_order',
      50000
    ).catch(() => []);

    const existingByStopOrder = new Map<number, any>();
    for (const rec of (existingStopRecords || [])) {
      if (rec?.stop_order != null && Number(rec.stop_order) !== -1) {
        existingByStopOrder.set(Number(rec.stop_order), rec);
      }
    }

    // ── 8. Sequential GPS-based slicing ──────────────────────────────────────
    // Walk the master polyline forward in index order.
    // For each stop (in stop_order sequence), find the closest point to that
    // stop's GPS coordinates, starting from where the previous stop ended.
    // Slice from prevCutIdx..currentCutIdx inclusive.

    let stops_sliced = 0;
    let stops_skipped_saved = 0;
    let stops_skipped_other = 0;
    let stops_missing = 0;
    let stops_thin = 0;
    const results: any[] = [];

    let prevCutIdx = 0; // pointer into masterPoints — always moves forward

    for (let i = 0; i < unifiedStops.length; i++) {
      const stop = unifiedStops[i];
      const existingRec = existingByStopOrder.get(stop.stop_order);

      // Skip manually saved stops but still advance the pointer
      if (existingRec?.saved_to_route === true) {
        // Even though we're skipping, we need to advance prevCutIdx to this
        // stop's closest point so the next stop's search starts correctly.
        if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) {
          const advanceIdx = findClosestPointFromIndex(masterPoints, prevCutIdx, stop.lat, stop.lon);
          prevCutIdx = advanceIdx; // advance so next stop doesn't backtrack
        }
        stops_skipped_saved++;
        results.push({ stop_order: stop.stop_order, skipped: true, reason: 'saved_to_route', type: stop.type });
        continue;
      }

      if (!existingRec) stops_missing++;
      else if (Number(existingRec.point_count) <= 2) stops_thin++;

      // If we have no GPS for this stop, skip it but don't advance pointer
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
        stops_skipped_other++;
        results.push({ stop_order: stop.stop_order, type: stop.type, skipped: true, reason: 'no_gps_coords' });
        continue;
      }

      // Find the closest master point to this stop, searching only forward from prevCutIdx
      const cutIdx = findClosestPointFromIndex(masterPoints, prevCutIdx, stop.lat, stop.lon);

      // Slice from prevCutIdx to cutIdx (inclusive)
      const slicedPoints = masterPoints.slice(prevCutIdx, cutIdx + 1);
      const slicedTs = masterTs.slice(prevCutIdx, cutIdx + 1);

      if (slicedPoints.length === 0) {
        stops_skipped_other++;
        results.push({
          stop_order: stop.stop_order, type: stop.type,
          skipped: true, reason: 'no_points_in_window',
          prevCutIdx, cutIdx,
        });
        continue;
      }

      const dedupedPoints = dedupeSequential(slicedPoints);
      const dedupedTs = slicedTs.filter((_, idx) => {
        // Keep timestamps aligned with deduped points — simple: just carry all
        return true;
      });

      const encodedPolyline = encodePolyline(dedupedPoints);
      const timestamps = slicedTs.filter(Boolean).join(',');

      const breadcrumbData = {
        driver_id,
        delivery_date,
        stop_order: stop.stop_order,
        encoded_polyline: encodedPolyline,
        timestamps,
        transport_mode: stop.transport_mode,
        point_count: dedupedPoints.length,
        saved_to_route: false,
      };

      if (existingRec?.id) {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existingRec.id, breadcrumbData);
      } else {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(breadcrumbData);
      }

      // Advance pointer to one past the cut point for the next stop
      prevCutIdx = cutIdx + 1;

      stops_sliced++;
      results.push({
        stop_order: stop.stop_order,
        type: stop.type,
        point_count: dedupedPoints.length,
        cut_at_master_idx: cutIdx,
        sliced: true,
      });
    }

    return Response.json({
      success: true,
      driver_id,
      delivery_date,
      master_point_count: masterPoints.length,
      stops_sliced,
      stops_skipped_saved,
      stops_skipped_other,
      stops_missing,
      stops_thin,
      results,
    });

  } catch (error: any) {
    console.error('[resegmentAllStops] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});