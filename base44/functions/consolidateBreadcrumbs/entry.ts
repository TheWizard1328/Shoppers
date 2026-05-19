import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);
const EDMONTON_TZ = 'America/Edmonton';

function getEdmontonDateString(value) {
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

function parseTimestampMs(value) {
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
      if (!Number.isFinite(numeric)) return null;
      if (numeric > 1e12) return numeric;
      if (numeric > 1e9) return numeric * 1000;
      return null;
    }
    const parsed = new Date(trimmed).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function parseLocalDateTimeMs(value, fallbackDate) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasDate = /^\d{4}-\d{2}-\d{2}/.test(trimmed);
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const candidate = hasDate ? normalized : `${fallbackDate}T${normalized}`;
  const isoLike = candidate.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(candidate)
    ? candidate : `${candidate}-06:00`;
  const parsed = new Date(isoLike).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function parseBoundaryTimeMs(value, fallbackDate) {
  return parseTimestampMs(value) ?? parseLocalDateTimeMs(value, fallbackDate);
}

function normalizeBreadcrumbPoint(point) {
  if (Array.isArray(point) && point.length >= 3) {
    const lat = Number(point[0]);
    const lon = Number(point[1]);
    const timestampMs = parseTimestampMs(point[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && timestampMs) {
      return [lat, lon, timestampMs];
    }
  }
  if (point && typeof point === 'object') {
    const lat = Number(point.latitude ?? point.lat);
    const lon = Number(point.longitude ?? point.lng ?? point.lon);
    const timestampMs = parseTimestampMs(point.timestamp_ms ?? point.timestamp ?? point.time);
    if (Number.isFinite(lat) && Number.isFinite(lon) && timestampMs) {
      return [lat, lon, timestampMs];
    }
  }
  return null;
}

function dedupeSequential(points) {
  const result = [];
  for (const point of points) {
    const prev = result[result.length - 1];
    if (!prev || prev[0] !== point[0] || prev[1] !== point[1] || prev[2] !== point[2]) {
      result.push(point);
    }
  }
  return result;
}

// --- Polyline encoding (Google/flexible format) ---
function encodePolylineValue(value) {
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

function encodePolyline(points) {
  let prevLat = 0, prevLon = 0;
  let result = '';
  for (const point of points) {
    const lat = point[0];
    const lon = point[1];
    result += encodePolylineValue(lat - prevLat);
    result += encodePolylineValue(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return result;
}

// Decode existing encoded polyline back to [[lat, lon], ...] for merging
function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
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

// Parse existing DeliveryBreadcrumbs record back to [[lat, lon, ts], ...]
function parseExistingBreadcrumbRecord(record) {
  if (!record?.encoded_polyline || !record?.timestamps) return [];
  const coords = decodePolyline(record.encoded_polyline);
  const tsStrings = record.timestamps.split(',');
  return coords.map((coord, i) => {
    const ts = parseTimestampMs(tsStrings[i]);
    return ts ? [coord[0], coord[1], ts] : null;
  }).filter(Boolean);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driver_id, delivery_date, stop_order, delivery_status } = body || {};

    if (!driver_id || !delivery_date || !Number.isFinite(Number(stop_order))) {
      return Response.json({ error: 'driver_id, delivery_date, and stop_order are required' }, { status: 400 });
    }

    if (delivery_status && !TERMINAL_STATUSES.has(String(delivery_status))) {
      return Response.json({ success: true, skipped: true, reason: 'non_terminal_status' });
    }

    const numericStopOrder = Number(stop_order);
    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id, delivery_date
    }, 'stop_order', 50000);

    const currentDelivery = (deliveries || []).find((d) => Number(d?.stop_order) === numericStopOrder) || null;
    if (!currentDelivery?.id) {
      return Response.json({ success: true, skipped: true, reason: 'delivery_not_found', driver_id, delivery_date, stop_order: numericStopOrder });
    }

    const currentStatus = String(currentDelivery.status || delivery_status || '');
    if (!TERMINAL_STATUSES.has(currentStatus)) {
      return Response.json({ success: true, skipped: true, reason: 'delivery_not_terminal', delivery_id: currentDelivery.id });
    }

    const previousStop = (deliveries || [])
      .filter((d) => Number(d?.stop_order) < numericStopOrder && TERMINAL_STATUSES.has(String(d?.status || '')))
      .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0] || null;

    const legEndMs = parseBoundaryTimeMs(currentDelivery.actual_delivery_time || currentDelivery.arrival_time || currentDelivery.updated_date, delivery_date);
    const legStartMs = previousStop
      ? parseBoundaryTimeMs(previousStop.actual_delivery_time || previousStop.arrival_time || previousStop.updated_date, delivery_date)
      : null;

    if (!legEndMs) {
      return Response.json({ success: true, skipped: true, reason: 'missing_leg_end_time', delivery_id: currentDelivery.id });
    }

    // Fetch existing DeliveryBreadcrumbs record by composite key (driver_id + delivery_date + stop_order)
    const existingBreadcrumbRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id, delivery_date, stop_order: numericStopOrder
    }).catch(() => []);
    const existingRecord = existingBreadcrumbRecords?.[0] || null;

    const existingPoints = parseExistingBreadcrumbRecord(existingRecord)
      .filter((point) => {
        const timestampMs = point[2];
        const pointDate = getEdmontonDateString(timestampMs);
        if (pointDate !== delivery_date) return false;
        if (timestampMs > legEndMs) return false;
        if (legStartMs && timestampMs < legStartMs) return false;
        return true;
      });

    const sortedPoints = dedupeSequential([...existingPoints].sort((a, b) => a[2] - b[2]));

    if (sortedPoints.length === 0) {
      return Response.json({ success: true, message: 'No valid breadcrumb points to consolidate', delivery_id: currentDelivery.id, breadcrumb_count: 0 });
    }

    // Encode to compact polyline + timestamps string
    const encodedPolyline = encodePolyline(sortedPoints);
    const timestamps = sortedPoints.map((p) => p[2]).join(',');

    // Save or update DeliveryBreadcrumbs record (no delivery_id — composite key is the canonical lookup)
    const breadcrumbData = {
      driver_id,
      delivery_date,
      stop_order: numericStopOrder,
      encoded_polyline: encodedPolyline,
      timestamps,
      transport_mode: currentDelivery.transport_mode || 'driving',
      point_count: sortedPoints.length,
    };

    if (existingRecord?.id) {
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existingRecord.id, breadcrumbData);
    } else {
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(breadcrumbData);
    }

    return Response.json({
      success: true,
      delivery_id: currentDelivery.id,
      breadcrumb_count: sortedPoints.length,
      leg_start_ms: legStartMs,
      leg_end_ms: legEndMs
    });
  } catch (error) {
    console.error('[consolidateBreadcrumbs] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});