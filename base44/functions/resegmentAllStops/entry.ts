import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);
const EDMONTON_TZ = 'America/Edmonton';

// ── Delivery ID prefix classification ────────────────────────────────────────
function classifyDelivery(d: any): 'delivery' | 'cycling' | 'interstore' | 'store_pickup' {
  const did = String(d.delivery_id || '').toUpperCase();
  if (did.startsWith('BIK')) return 'cycling';
  if (did.startsWith('ISP') || did.startsWith('ISD')) return 'interstore';
  if (did.startsWith('DID')) return 'delivery';
  // No delivery_id or unrecognized prefix → store pickup
  return 'store_pickup';
}

function getEdmontonOffsetString(date: Date): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: EDMONTON_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const edmontonAsUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour === '24' ? '00' : map.hour), Number(map.minute), Number(map.second)
  );
  const offsetMs = date.getTime() - edmontonAsUTC;
  const offsetHours = Math.trunc(offsetMs / 3600000);
  const sign = offsetHours >= 0 ? '-' : '+';
  const absHours = Math.abs(offsetHours);
  const absMinutes = Math.abs((offsetMs % 3600000) / 60000);
  return `${sign}${String(absHours).padStart(2, '0')}:${String(absMinutes).padStart(2, '0')}`;
}

function parseTimestampMs(value: any): number | null {
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

function parseDeliveryTimeMs(timeValue: any, deliveryDate: string): number | null {
  if (!timeValue || !deliveryDate) return null;
  const trimmed = String(timeValue).trim();
  if (trimmed.includes('T') || trimmed.includes(' ')) {
    const normalized = trimmed.replace(' ', 'T');
    const withTz = /[Zz]|[+-]\d{2}:?\d{2}$/.test(normalized)
      ? normalized
      : `${normalized}${getEdmontonOffsetString(new Date(normalized + 'Z'))}`;
    const ms = new Date(withTz).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) {
    const candidate = `${deliveryDate}T${trimmed}`;
    const withTz = `${candidate}${getEdmontonOffsetString(new Date(candidate + 'Z'))}`;
    const ms = new Date(withTz).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return parseTimestampMs(trimmed);
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
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
}

function dedupeSequential(points: any[]): any[] {
  const result: any[] = [];
  for (const point of points) {
    const prev = result[result.length - 1];
    if (!prev || prev[0] !== point[0] || prev[1] !== point[1] || prev[2] !== point[2]) {
      result.push(point);
    }
  }
  return result;
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

const ANCHOR_BUFFER_MS = 10 * 60 * 1000;

function findBestAnchorIndex(masterPoints: any[], timestampMs: number, stopLat: number, stopLon: number): number {
  let closestTimeIdx = 0;
  let minTimeDiff = Infinity;
  for (let i = 0; i < masterPoints.length; i++) {
    const diff = Math.abs(masterPoints[i][2] - timestampMs);
    if (diff < minTimeDiff) { minTimeDiff = diff; closestTimeIdx = i; }
  }
  if (!Number.isFinite(stopLat) || !Number.isFinite(stopLon)) {
    return closestTimeIdx;
  }
  const windowStart = timestampMs - ANCHOR_BUFFER_MS;
  const windowEnd   = timestampMs + ANCHOR_BUFFER_MS;
  let bestIdx = closestTimeIdx;
  let minDist = Infinity;
  for (let i = 0; i < masterPoints.length; i++) {
    const ts = masterPoints[i][2];
    if (ts < windowStart || ts > windowEnd) continue;
    const dist = haversineMeters(stopLat, stopLon, masterPoints[i][0], masterPoints[i][1]);
    if (dist < minDist) { minDist = dist; bestIdx = i; }
  }
  return bestIdx;
}

// ── Unified waypoint type ─────────────────────────────────────────────────────
interface UnifiedStop {
  stop_order: number;
  lat: number;
  lon: number;
  endMs: number;           // anchor timestamp for this stop's completion
  type: 'delivery' | 'cycling' | 'interstore' | 'store_pickup';
  deliveryId: string;      // original DB record ID
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

    if (!masterRecord?.encoded_polyline || !masterRecord?.timestamps) {
      return Response.json({
        success: true, driver_id, delivery_date,
        master_point_count: 0, stops_sliced: 0, stops_skipped_saved: 0,
        stops_skipped_other: 0, stops_missing: 0, stops_thin: 0,
        results: [], reason: 'no_master_timeline_record',
      });
    }

    // Parse master timeline → [[lat, lon, ts_ms], ...] sorted by time
    const masterCoords = decodePolyline(masterRecord.encoded_polyline);
    const masterTs = masterRecord.timestamps.split(',').map(Number);
    const masterPoints = masterCoords
      .map((coord, i) => {
        const ts = parseTimestampMs(masterTs[i]);
        return ts ? [coord[0], coord[1], ts] : null;
      })
      .filter((p): p is [number, number, number] => p !== null)
      .sort((a, b) => a[2] - b[2]);

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

    // Only process terminal stops that have a stop_order
    const terminalDeliveries = (allDeliveries || [])
      .filter((d: any) => d && d.stop_order != null && TERMINAL_STATUSES.has(String(d.status || '')));

    // ── 3. Collect all unique store_ids and patient_ids to resolve coordinates ─
    const storeIds = [...new Set(
      terminalDeliveries.map((d: any) => d.store_id).filter(Boolean)
    )];
    const patientIds = [...new Set(
      terminalDeliveries.map((d: any) => d.patient_id).filter(Boolean)
    )];

    // Collect interstore location IDs (source + dest)
    const interstoreIds = [...new Set([
      ...terminalDeliveries.map((d: any) => d._interstore_source_id).filter(Boolean),
      ...terminalDeliveries.map((d: any) => d._interstore_dest_id).filter(Boolean),
    ])];

    // ── 4. Bulk fetch coordinates in parallel ────────────────────────────────
    const [stores, patients, interstoreLocations, appUsers] = await Promise.all([
      storeIds.length > 0
        ? base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }, 'id', 50000).catch(() => [])
        : Promise.resolve([]),
      patientIds.length > 0
        ? base44.asServiceRole.entities.Patient.filter({ id: { $in: patientIds } }, 'id', 50000).catch(() => [])
        : Promise.resolve([]),
      interstoreIds.length > 0
        ? base44.asServiceRole.entities.InterStoreLocation.filter({ id: { $in: interstoreIds } }, 'id', 50000).catch(() => [])
        : Promise.resolve([]),
      base44.asServiceRole.entities.AppUser.filter({ user_id: driver_id }, 'id', 1).catch(() => []),
    ]);

    // Build coordinate lookup maps
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

    // Driver home coords
    const driverAppUser = appUsers?.[0] || null;
    const driverHomeLat = driverAppUser?.home_latitude ? Number(driverAppUser.home_latitude) : NaN;
    const driverHomeLon = driverAppUser?.home_longitude ? Number(driverAppUser.home_longitude) : NaN;

    // ── 5. Resolve coordinates for each terminal stop ─────────────────────────
    // Coordinate resolution priority per type:
    //   delivery     → patient GPS
    //   cycling      → cycling_latitude/longitude on the Delivery record
    //   interstore   → _interstore_dest_id → InterStoreLocation GPS
    //   store_pickup → store_id → Store GPS
    function resolveStopCoords(d: any): { lat: number; lon: number } {
      const type = classifyDelivery(d);
      if (type === 'delivery') {
        const gps = patientGpsMap.get(d.patient_id);
        return gps ?? { lat: NaN, lon: NaN };
      }
      if (type === 'cycling') {
        return {
          lat: Number.isFinite(Number(d.cycling_latitude)) ? Number(d.cycling_latitude) : NaN,
          lon: Number.isFinite(Number(d.cycling_longitude)) ? Number(d.cycling_longitude) : NaN,
        };
      }
      if (type === 'interstore') {
        // Use destination for dropoffs (ISD), source for pickups (ISP)
        const did = String(d.delivery_id || '').toUpperCase();
        const locationId = did.startsWith('ISD') ? d._interstore_dest_id : d._interstore_source_id;
        const gps = interstoreGpsMap.get(locationId);
        return gps ?? { lat: NaN, lon: NaN };
      }
      if (type === 'store_pickup') {
        const gps = storeGpsMap.get(d.store_id);
        return gps ?? { lat: NaN, lon: NaN };
      }
      return { lat: NaN, lon: NaN };
    }

    // ── 6. Build unified sorted stop list ─────────────────────────────────────
    const unifiedStops: UnifiedStop[] = [];

    for (const d of terminalDeliveries) {
      const endMs = parseDeliveryTimeMs(
        d.actual_delivery_time || d.delivery_time_end || d.arrival_time,
        delivery_date
      );
      if (!endMs) continue; // can't anchor without a time

      const coords = resolveStopCoords(d);

      unifiedStops.push({
        stop_order: Number(d.stop_order),
        lat: coords.lat,
        lon: coords.lon,
        endMs,
        type: classifyDelivery(d),
        deliveryId: d.id,
        transport_mode: d.transport_mode || 'driving',
      });
    }

    // Sort chronologically by their completion time (spatial anchoring is stable to this)
    unifiedStops.sort((a, b) => a.endMs - b.endMs);

    if (unifiedStops.length === 0) {
      return Response.json({
        success: true, driver_id, delivery_date,
        master_point_count: masterPoints.length,
        stops_sliced: 0, stops_skipped_saved: 0, stops_skipped_other: 0,
        stops_missing: 0, stops_thin: 0, results: [],
        reason: 'no_terminal_stops_with_timestamps',
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

    // ── 8. Slice master breadcrumb per unified stop ───────────────────────────
    let stops_sliced = 0;
    let stops_skipped_saved = 0;
    let stops_skipped_other = 0;
    let stops_missing = 0;
    let stops_thin = 0;
    const results: any[] = [];

    for (let i = 0; i < unifiedStops.length; i++) {
      const stop = unifiedStops[i];
      const existingRec = existingByStopOrder.get(stop.stop_order);

      // Skip manually edited stops
      if (existingRec?.saved_to_route === true) {
        stops_skipped_saved++;
        results.push({ stop_order: stop.stop_order, skipped: true, reason: 'saved_to_route', type: stop.type });
        continue;
      }

      if (!existingRec) stops_missing++;
      else if (Number(existingRec.point_count) <= 2) stops_thin++;

      // Spatial anchor: project this stop's endMs onto the nearest master point
      const endAnchorIdx = findBestAnchorIndex(masterPoints, stop.endMs, stop.lat, stop.lon);
      const endAnchorTs  = masterPoints[endAnchorIdx]?.[2] ?? stop.endMs;

      // Lower boundary: previous stop's spatially-anchored end time
      let startAnchorTs: number | null = null;
      if (i > 0) {
        const prevStop = unifiedStops[i - 1];
        const prevAnchorIdx = findBestAnchorIndex(masterPoints, prevStop.endMs, prevStop.lat, prevStop.lon);
        startAnchorTs = masterPoints[prevAnchorIdx]?.[2] ?? prevStop.endMs;
      }

      // Slice master points between the two anchors
      const slicedPoints = masterPoints.filter((pt) => {
        const ts = pt[2];
        if (ts > endAnchorTs) return false;
        if (startAnchorTs !== null && ts < startAnchorTs) return false;
        return true;
      });

      if (slicedPoints.length === 0) {
        stops_skipped_other++;
        results.push({
          stop_order: stop.stop_order, type: stop.type,
          skipped: true, reason: 'no_points_in_window',
          startAnchorTs, endAnchorTs,
        });
        continue;
      }

      const dedupedPoints = dedupeSequential(slicedPoints);
      const encodedPolyline = encodePolyline(dedupedPoints);
      const timestamps = dedupedPoints.map((p) => p[2]).join(',');

      const breadcrumbData = {
        driver_id,
        delivery_date,
        stop_order: stop.stop_order,
        encoded_polyline: encodedPolyline,
        timestamps,
        transport_mode: stop.transport_mode,
        point_count: dedupedPoints.length,
      };

      if (existingRec?.id) {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existingRec.id, breadcrumbData);
      } else {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(breadcrumbData);
      }

      stops_sliced++;
      results.push({
        stop_order: stop.stop_order,
        type: stop.type,
        point_count: dedupedPoints.length,
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