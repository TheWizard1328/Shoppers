import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);
const EDMONTON_TZ = 'America/Edmonton';

function getEdmontonDateString(value: any) {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EDMONTON_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function parseTimestampMs(value: any) {
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
  // Edmonton is BEHIND UTC, so offset is negative.
  // offsetMs = UTC - Edmonton wall-clock = positive (e.g. +6h in summer MDT)
  // The timezone string needs the NEGATIVE: "-06:00" means local is 6h behind UTC
  const offsetMs = date.getTime() - edmontonAsUTC;
  const offsetHours = Math.trunc(offsetMs / 3600000);
  const sign = offsetHours >= 0 ? '-' : '+';  // Inverted: positive offset means behind UTC
  const absHours = Math.abs(offsetHours);
  const absMinutes = Math.abs((offsetMs % 3600000) / 60000);
  return `${sign}${String(absHours).padStart(2, '0')}:${String(absMinutes).padStart(2, '0')}`;
}

function parseDeliveryTimeMs(timeValue: any, deliveryDate: string) {
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

function encodePolylineValue(value: number) {
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

function encodePolyline(points: number[][]) {
  let prevLat = 0, prevLon = 0, result = '';
  for (const point of points) {
    result += encodePolylineValue(point[0] - prevLat);
    result += encodePolylineValue(point[1] - prevLon);
    prevLat = point[0];
    prevLon = point[1];
  }
  return result;
}

function decodePolyline(encoded: string) {
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

function dedupeSequential(points: any[]) {
  const result: any[] = [];
  for (const point of points) {
    const prev = result[result.length - 1];
    if (!prev || prev[0] !== point[0] || prev[1] !== point[1] || prev[2] !== point[2]) {
      result.push(point);
    }
  }
  return result;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const ANCHOR_BUFFER_MS = 10 * 60 * 1000;

function findBestAnchorIndex(masterPoints: any[], timestampMs: number, stopLat: number, stopLon: number) {
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    // Support both direct call and entity automation payload
    const deliveryData = body.data || null;
    const driver_id = body.driver_id || deliveryData?.driver_id;
    const delivery_date = body.delivery_date || deliveryData?.delivery_date;

    if (!driver_id || !delivery_date) {
      return Response.json({ error: 'driver_id and delivery_date are required' }, { status: 400 });
    }

    // ── 1. Fetch the master 'TODAY' breadcrumb record (stop_order = -1) ──────
    const masterRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: -1,
    }).catch(() => []);
    const masterRecord = masterRecords?.[0] || null;

    if (!masterRecord?.encoded_polyline || !masterRecord?.timestamps) {
      return Response.json({
        success: true,
        driver_id,
        delivery_date,
        master_point_count: 0,
        stops_sliced: 0,
        stops_skipped_saved: 0,
        stops_skipped_other: 0,
        stops_missing: 0,
        stops_thin: 0,
        results: [],
        reason: 'no_master_timeline_record',
      });
    }

    // Parse master timeline into [[lat, lon, ts_ms], ...] sorted by time
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
        success: true,
        driver_id,
        delivery_date,
        master_point_count: 0,
        stops_sliced: 0,
        stops_skipped_saved: 0,
        stops_skipped_other: 0,
        stops_missing: 0,
        stops_thin: 0,
        results: [],
        reason: 'empty_master_timeline',
      });
    }

    // ── 2. Fetch all deliveries for this driver/date, sorted by stop_order ───
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter(
      { driver_id, delivery_date },
      'stop_order',
      50000
    );

    // Only process terminal (completed/failed/etc) stops
    const terminalStops = (allDeliveries || [])
      .filter((d) => d && d.stop_order != null && TERMINAL_STATUSES.has(String(d.status || '')))
      .sort((a, b) => Number(a.stop_order) - Number(b.stop_order));

    // ── 2b. Fetch patient GPS coords in one bulk call ─────────────────────────
    const patientIds = [...new Set(
      (allDeliveries || []).map((d) => d.patient_id).filter((id): id is string => id !== null && id !== undefined)
    )];
    const patientGpsMap = new Map(); // patient_id → { lat, lon }
    if (patientIds.length > 0) {
      const patients = await base44.asServiceRole.entities.Patient.filter(
        { id: { $in: patientIds } },
        'id',
        50000
      ).catch(() => []);
      for (const p of (patients || [])) {
        if (p?.id && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude))) {
          patientGpsMap.set(p.id, { lat: Number(p.latitude), lon: Number(p.longitude) });
        }
      }
    }

    if (terminalStops.length === 0) {
      return Response.json({
        success: true,
        driver_id,
        delivery_date,
        master_point_count: masterPoints.length,
        stops_sliced: 0,
        stops_skipped_saved: 0,
        stops_skipped_other: 0,
        stops_missing: 0,
        stops_thin: 0,
        results: [],
        reason: 'no_terminal_stops',
      });
    }

    // ── 3. Fetch existing per-stop breadcrumb records ─────────────────────────
    const existingStopRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter(
      { driver_id, delivery_date },
      'stop_order',
      50000
    ).catch(() => []);

    // Build a lookup: stop_order -> existing record (exclude master sentinel)
    const existingByStopOrder = new Map();
    for (const rec of (existingStopRecords || [])) {
      if (rec?.stop_order != null && Number(rec.stop_order) !== -1) {
        existingByStopOrder.set(Number(rec.stop_order), rec);
      }
    }

    // ── 4. Process each terminal stop ───────────────────────
    let stops_sliced = 0;
    let stops_skipped_saved = 0;
    let stops_skipped_other = 0;
    let stops_missing = 0;     // No existing record at all
    let stops_thin = 0;         // Existing record had ≤2 points (origin/destination only)
    const results: any[] = [];

    for (let i = 0; i < terminalStops.length; i++) {
      const stop = terminalStops[i];
      const numericStopOrder = Number(stop.stop_order);

      // Check if existing record has saved_to_route === true (manually edited — skip)
      const existingRec = existingByStopOrder.get(numericStopOrder);
      if (existingRec?.saved_to_route === true) {
        stops_skipped_saved++;
        results.push({
          stop_order: numericStopOrder,
          skipped: true,
          reason: 'saved_to_route',
        });
        continue;
      }

      // Track whether this stop was missing or thin
      if (!existingRec) {
        stops_missing++;
      } else if (Number(existingRec.point_count) <= 2) {
        stops_thin++;
      }

      // Upper boundary: this stop's completion time (timestamp anchor)
      const stopEndMs = parseDeliveryTimeMs(
        stop.actual_delivery_time || stop.delivery_time_end || stop.arrival_time,
        delivery_date
      );

      if (!stopEndMs) {
        stops_skipped_other++;
        results.push({
          stop_order: numericStopOrder,
          skipped: true,
          reason: 'no_end_time',
        });
        continue;
      }

      // Lower boundary: the previous terminal stop's completion time (if any)
      const prevTerminalStop = terminalStops
        .filter((d) => Number(d.stop_order) < numericStopOrder)
        .at(-1) || null;

      const prevStopEndMs = prevTerminalStop
        ? parseDeliveryTimeMs(
            prevTerminalStop.actual_delivery_time || prevTerminalStop.delivery_time_end || prevTerminalStop.arrival_time,
            delivery_date
          )
        : null;

      // ── Two-stage spatial anchor refinement ───────────────────────────────
      const stopGps = patientGpsMap.get(stop.patient_id) || null;
      const stopLat = stopGps?.lat ?? NaN;
      const stopLon = stopGps?.lon ?? NaN;

      const endAnchorIdx = findBestAnchorIndex(masterPoints, stopEndMs, stopLat, stopLon);
      const endAnchorTs  = masterPoints[endAnchorIdx]?.[2] ?? stopEndMs;

      let startAnchorTs = null;
      if (prevTerminalStop && prevStopEndMs) {
        const prevGps = patientGpsMap.get(prevTerminalStop.patient_id) || null;
        const prevLat = prevGps?.lat ?? NaN;
        const prevLon = prevGps?.lon ?? NaN;
        const startAnchorIdx = findBestAnchorIndex(masterPoints, prevStopEndMs, prevLat, prevLon);
        startAnchorTs = masterPoints[startAnchorIdx]?.[2] ?? prevStopEndMs;
      }

      // Slice: include all master points between the two spatially-anchored timestamps
      const slicedPoints = masterPoints.filter((pt) => {
        const ts = pt[2];
        if (ts > endAnchorTs) return false;
        if (startAnchorTs && ts < startAnchorTs) return false;
        return true;
      });

      if (slicedPoints.length === 0) {
        stops_skipped_other++;
        results.push({
          stop_order: numericStopOrder,
          skipped: true,
          reason: 'no_points_in_window',
          startAnchorTs,
          endAnchorTs,
        });
        continue;
      }

      const dedupedPoints = dedupeSequential(slicedPoints);
      const encodedPolyline = encodePolyline(dedupedPoints);
      const timestamps = dedupedPoints.map((p) => p[2]).join(',');

      const breadcrumbData = {
        driver_id,
        delivery_date,
        stop_order: numericStopOrder,
        encoded_polyline: encodedPolyline,
        timestamps,
        transport_mode: stop.transport_mode || 'driving',
        point_count: dedupedPoints.length,
      };

      if (existingRec?.id) {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existingRec.id, breadcrumbData);
      } else {
        await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(breadcrumbData);
      }

      stops_sliced++;
      results.push({
        stop_order: numericStopOrder,
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
