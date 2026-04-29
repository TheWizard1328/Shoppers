import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);
const EDMONTON_TZ = 'America/Edmonton';

function getEdmontonDateString(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EDMONTON_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
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
    ? candidate
    : `${candidate}-06:00`;

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

function parseStoredBreadcrumbs(value) {
  if (!value) return [];
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeBreadcrumbPoint).filter(Boolean);
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
      driver_id,
      delivery_date
    }, 'stop_order', 50000);

    const currentDelivery = (deliveries || []).find((delivery) => Number(delivery?.stop_order) === numericStopOrder) || null;
    if (!currentDelivery?.id) {
      return Response.json({ success: true, skipped: true, reason: 'delivery_not_found', driver_id, delivery_date, stop_order: numericStopOrder });
    }

    const currentStatus = String(currentDelivery.status || delivery_status || '');
    if (!TERMINAL_STATUSES.has(currentStatus)) {
      return Response.json({ success: true, skipped: true, reason: 'delivery_not_terminal', delivery_id: currentDelivery.id });
    }

    const previousStop = (deliveries || [])
      .filter((delivery) => Number(delivery?.stop_order) < numericStopOrder && TERMINAL_STATUSES.has(String(delivery?.status || '')))
      .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0] || null;

    const legEndMs = parseBoundaryTimeMs(currentDelivery.actual_delivery_time || currentDelivery.arrival_time || currentDelivery.updated_date, delivery_date);
    const legStartMs = previousStop
      ? parseBoundaryTimeMs(previousStop.actual_delivery_time || previousStop.arrival_time || previousStop.updated_date, delivery_date)
      : null;

    if (!legEndMs) {
      return Response.json({ success: true, skipped: true, reason: 'missing_leg_end_time', delivery_id: currentDelivery.id });
    }

    const pendingRows = await base44.asServiceRole.entities.PendingBreadcrumbLive.filter({ driver_id }, '-updated_date', 50000);
    const matchingRows = (pendingRows || []).filter((row) => Number(row?.stop_order) === numericStopOrder);

    if (!matchingRows.length) {
      return Response.json({ success: true, message: 'No pending breadcrumbs found', delivery_id: currentDelivery.id, breadcrumb_count: 0 });
    }

    const validPoints = [];
    for (const row of matchingRows) {
      const rawPoints = Array.isArray(row?.breadcrumbs) ? row.breadcrumbs : [];
      for (const rawPoint of rawPoints) {
        const point = normalizeBreadcrumbPoint(rawPoint);
        if (!point) continue;

        const timestampMs = point[2];
        const pointDate = getEdmontonDateString(timestampMs);
        if (pointDate !== delivery_date) continue;
        if (timestampMs > legEndMs) continue;
        if (legStartMs && timestampMs < legStartMs) continue;
        validPoints.push(point);
      }
    }

    const existingPoints = parseStoredBreadcrumbs(currentDelivery.delivery_route_breadcrumbs)
      .filter((point) => {
        const timestampMs = point[2];
        const pointDate = getEdmontonDateString(timestampMs);
        if (pointDate !== delivery_date) return false;
        if (timestampMs > legEndMs) return false;
        if (legStartMs && timestampMs < legStartMs) return false;
        return true;
      });

    const sortedPoints = dedupeSequential([...existingPoints, ...validPoints].sort((a, b) => a[2] - b[2]));

    await base44.asServiceRole.entities.Delivery.update(currentDelivery.id, {
      delivery_route_breadcrumbs: JSON.stringify(sortedPoints),
      PolylineUpdated: true
    });

    for (const row of matchingRows) {
      await base44.asServiceRole.entities.PendingBreadcrumbLive.delete(row.id).catch(() => null);
    }

    return Response.json({
      success: true,
      delivery_id: currentDelivery.id,
      breadcrumb_count: sortedPoints.length,
      source_rows: matchingRows.length,
      leg_start_ms: legStartMs,
      leg_end_ms: legEndMs
    });
  } catch (error) {
    console.error('[consolidateBreadcrumbs] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});