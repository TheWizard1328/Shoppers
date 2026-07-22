/* global Deno */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// ── Polyline encode/decode (Google polyline format) ──────────────────────────
// 1e5 precision (~1m accuracy, standard Google/HERE polyline format)
// MUST match the client encoder in locationBreadcrumbService.jsx and breadcrumbsManager.jsx.
const POLY_PRECISION = 1e5;

function encodePolylineValue(value) {
  let v = Math.round(value * POLY_PRECISION);
  v = v < 0 ? (-v * 2 - 1) : (v * 2);
  let result = '';
  while (v >= 0x20) {
    result += String.fromCharCode((0x20 + (v % 0x20)) + 63);
    v = Math.floor(v / 0x20);
  }
  result += String.fromCharCode(v + 63);
  return result;
}

function encodePolyline(points) {
  let prevLat = 0, prevLon = 0, result = '';
  for (const point of points) {
    result += encodePolylineValue(point[0] - prevLat);
    result += encodePolylineValue(point[1] - prevLon);
    prevLat = point[0];
    prevLon = point[1];
  }
  return result;
}

function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let result = 0, multiplier = 1, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += (byte % 32) * multiplier;
      multiplier *= 32;
    } while (byte >= 0x20);
    lat += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    result = 0; multiplier = 1;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += (byte % 32) * multiplier;
      multiplier *= 32;
    } while (byte >= 0x20);
    lng += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    coordinates.push([lat / POLY_PRECISION, lng / POLY_PRECISION]);
  }
  return coordinates;
}

// ── Time parsing ──────────────────────────────────────────────────────────────
// actual_delivery_time is stored as a NAIVE local ISO string (e.g. "2026-07-21T14:30:00")
// with NO timezone suffix. It represents Edmonton local time (America/Edmonton).
// The Deno runtime would interpret a naive ISO string as UTC, which is 6-7 hours ahead
// of Edmonton. This caused every breadcrumb segment to start at the driver's home because
// the slicing window ended 6-7 hours before any master trail GPS points existed.
//
// This function detects naive strings and applies the correct Edmonton UTC offset
// (dynamically, to handle DST: -07:00 in summer MDT, -06:00 in winter MST).

function getEdmontonOffsetMs(date) {
  // Use Intl.DateTimeFormat to get the timezone offset for a given date.
  // We compare the wall-clock time in Edmonton vs UTC to derive the offset.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Edmonton',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // Build a UTC date from the Edmonton wall-clock parts
  const edmontonAsUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour === '24' ? '00' : map.hour), Number(map.minute), Number(map.second)
  );
  // Offset = actual UTC - Edmonton wall-clock-as-UTC
  return date.getTime() - edmontonAsUTC;
}

function toEpochMs(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') {
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  // Check if the string has a timezone suffix (Z, +HH:MM, -HH:MM)
  const hasTZ = /([Zz]|[+-]\d{2}:?\d{2})$/.test(value.trim());
  if (hasTZ) {
    // Already has timezone info — parse normally
    const ts = new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  // Naive ISO string — treat as Edmonton local time.
  // Parse the naive string as if it were UTC, then subtract the Edmonton offset
  // to get the true UTC epoch.
  const asUTC = new Date(value + 'Z').getTime(); // Temporarily treat as UTC
  if (!Number.isFinite(asUTC)) return null;
  // The Edmonton offset for this date (positive = Edmonton is behind UTC)
  const offsetMs = getEdmontonOffsetMs(new Date(asUTC));
  // asUTC is "14:30 treated as UTC". Real UTC is 14:30 + offset (e.g. +7h in summer)
  return asUTC + offsetMs;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const {
      driver_id,
      delivery_date,
      delivery_id,
      stop_order,
      actual_delivery_time,
      transport_mode = 'driving'
    } = body || {};

    // ── Validate inputs ───────────────────────────────────────────────────────
    if (!driver_id || !delivery_date) {
      return Response.json({ success: false, error: 'driver_id and delivery_date are required' }, { status: 400 });
    }
    if (!Number.isFinite(Number(stop_order))) {
      return Response.json({ success: false, error: 'stop_order must be a finite number' }, { status: 400 });
    }

    const currentStopOrder = Number(stop_order);
    const currentStopTime = toEpochMs(actual_delivery_time);

    if (!currentStopTime) {
      return Response.json({ success: false, error: 'Could not parse actual_delivery_time' }, { status: 400 });
    }

    // ── 1. Read the master trail (stop_order = -1) ─────────────────────────────
    const masterRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: -1
    });

    const masterRecord = Array.isArray(masterRecords) && masterRecords.length > 0
      ? masterRecords[0]
      : null;

    if (!masterRecord?.encoded_polyline || !masterRecord?.timestamps) {
      return Response.json({
        success: false,
        error: 'No master breadcrumb trail found for this driver/date',
        driver_id,
        delivery_date,
        point_count: 0
      }, { status: 404 });
    }

    // Decode master trail into [lat, lng, timestamp] points
    const masterCoords = decodePolyline(masterRecord.encoded_polyline);
    const masterTsArr = masterRecord.timestamps.split(',').map(Number);
    const masterPoints = masterCoords
      .map((coord, i) => [coord[0], coord[1], masterTsArr[i] || 0])
      .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]) && Number.isFinite(pt[2]));

    if (masterPoints.length === 0) {
      return Response.json({ success: false, error: 'Master trail has no valid points', point_count: 0 }, { status: 500 });
    }

    // ── 2. Find the previous completed stop's actual_delivery_time ─────────────
    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id,
      delivery_date
    });

    const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);
    const previousStops = (allDeliveries || [])
      .filter((d) => {
        if (!d || d.id === delivery_id) return false;
        if (!FINISHED_STATUSES.has(d.status)) return false;
        const dStopOrder = Number(d.stop_order || 0);
        return dStopOrder < currentStopOrder;
      })
      .sort((a, b) => Number(b.stop_order || 0) - Number(a.stop_order || 0));

    // Determine the time window start:
    // - If there's a previous completed stop, use its actual_delivery_time
    // - If this is the first stop, use the earliest master trail point
    let windowStart = null;
    if (previousStops.length > 0) {
      const prevTime = toEpochMs(
        previousStops[0].actual_delivery_time ||
        previousStops[0].arrival_time ||
        previousStops[0].updated_date
      );
      if (prevTime) windowStart = prevTime;
    }

    if (!windowStart) {
      // First stop — use the earliest master trail timestamp
      windowStart = masterPoints[0][2];
    }

    // ── 3. Slice the master trail between windowStart and currentStopTime ──────
    const startBuffer = 5000; // 5 seconds
    const adjustedStart = windowStart - startBuffer;

    const segmentPoints = masterPoints.filter(
      (pt) => pt[2] >= adjustedStart && pt[2] <= currentStopTime
    );

    // If no points in the window, find the closest master point to currentStopTime
    if (segmentPoints.length === 0) {
      let closest = masterPoints[0];
      let minDiff = Math.abs(masterPoints[0][2] - currentStopTime);
      for (const pt of masterPoints) {
        const diff = Math.abs(pt[2] - currentStopTime);
        if (diff < minDiff) {
          minDiff = diff;
          closest = pt;
        }
      }
      segmentPoints.push(closest);
    }

    // ── 4. Encode the sliced segment ──────────────────────────────────────────
    const segmentCoords = segmentPoints.map((pt) => [pt[0], pt[1]]);
    const segmentEncoded = encodePolyline(segmentCoords);
    const segmentTimestamps = segmentPoints.map((pt) => pt[2]).join(',');

    // ── 5. Create or update the per-stop DeliveryBreadcrumbs record ────────────
    const existingSegments = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id,
      delivery_date,
      stop_order: currentStopOrder
    });

    const existingRecord = Array.isArray(existingSegments) && existingSegments.length > 0
      ? existingSegments[0]
      : null;

    const segmentPayload = {
      driver_id,
      delivery_date,
      stop_order: currentStopOrder,
      delivery_id: delivery_id || null,
      encoded_polyline: segmentEncoded,
      timestamps: segmentTimestamps,
      transport_mode,
      point_count: segmentPoints.length,
      saved_to_route: false
    };

    let savedRecord;
    if (existingRecord?.id) {
      // Update existing segment — merge points by timestamp to avoid losing data
      const existingCoords = decodePolyline(existingRecord.encoded_polyline || '');
      const existingTsArr = (existingRecord.timestamps || '').split(',').map(Number);
      const existingPoints = existingCoords
        .map((coord, i) => [coord[0], coord[1], existingTsArr[i] || 0])
        .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]) && Number.isFinite(pt[2]));

      const mergedMap = new Map();
      [...existingPoints, ...segmentPoints]
        .sort((a, b) => a[2] - b[2])
        .forEach((pt) => {
          mergedMap.set(String(pt[2]), pt);
        });
      const mergedPoints = Array.from(mergedMap.values()).sort((a, b) => a[2] - b[2]);

      const mergedEncoded = encodePolyline(mergedPoints.map((pt) => [pt[0], pt[1]]));
      const mergedTimestamps = mergedPoints.map((pt) => pt[2]).join(',');

      segmentPayload.encoded_polyline = mergedEncoded;
      segmentPayload.timestamps = mergedTimestamps;
      segmentPayload.point_count = mergedPoints.length;

      savedRecord = await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(
        existingRecord.id,
        segmentPayload
      );
    } else {
      savedRecord = await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(segmentPayload);
    }

    console.log(`✅ [consolidateBreadcrumbSegment] Created/updated segment for stop ${currentStopOrder}: ${segmentPayload.point_count} points, driver=${driver_id}, date=${delivery_date}`);

    return Response.json({
      success: true,
      segment: {
        id: savedRecord?.id || existingRecord?.id,
        stop_order: currentStopOrder,
        point_count: segmentPayload.point_count,
        has_polyline: !!segmentPayload.encoded_polyline
      },
      point_count: segmentPayload.point_count,
      window_start: windowStart,
      window_end: currentStopTime,
      master_point_count: masterPoints.length
    });

  } catch (error) {
    console.error('❌ [consolidateBreadcrumbSegment] Error:', error?.message || error);
    return Response.json({
      success: false,
      error: error?.message || 'Unknown error during breadcrumb consolidation'
    }, { status: 500 });
  }
});
