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
  const isoLike = candidate.includes('Z') || /[+-]\d{2}:?\d{2}$/.test(candidate) ? candidate : `${candidate}-06:00`;
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
    if (Number.isFinite(lat) && Number.isFinite(lon) && timestampMs) return [lat, lon, timestampMs];
  }
  if (point && typeof point === 'object') {
    const lat = Number(point.latitude ?? point.lat);
    const lon = Number(point.longitude ?? point.lng ?? point.lon);
    const timestampMs = parseTimestampMs(point.timestamp_ms ?? point.timestamp ?? point.time);
    if (Number.isFinite(lat) && Number.isFinite(lon) && timestampMs) return [lat, lon, timestampMs];
  }
  return null;
}

function dedupeSequential(points) {
  const result = [];
  for (const point of points) {
    const prev = result[result.length - 1];
    if (!prev || prev[0] !== point[0] || prev[1] !== point[1] || prev[2] !== point[2]) result.push(point);
  }
  return result;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driverId, deliveryDate } = body || {};

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'driverId and deliveryDate are required' }, { status: 400 });
    }

    const deliveries = await base44.asServiceRole.entities.Delivery.filter({ driver_id: driverId, delivery_date: deliveryDate }, 'stop_order', 50000);
    const pendingRows = await base44.asServiceRole.entities.PendingBreadcrumbLive.filter({ driver_id: driverId }, '-updated_date', 50000);

    const updatedDeliveryIds = [];
    const pendingBreadcrumbIds = [];
    let sourceRows = 0;

    for (const delivery of deliveries || []) {
      const stopOrder = Number(delivery?.stop_order);
      if (!Number.isFinite(stopOrder)) continue;
      if (!TERMINAL_STATUSES.has(String(delivery?.status || ''))) continue;

      const previousStop = (deliveries || [])
        .filter((item) => Number(item?.stop_order) < stopOrder && TERMINAL_STATUSES.has(String(item?.status || '')))
        .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0] || null;

      const legEndMs = parseBoundaryTimeMs(delivery.actual_delivery_time || delivery.arrival_time || delivery.updated_date, deliveryDate);
      const legStartMs = previousStop ? parseBoundaryTimeMs(previousStop.actual_delivery_time || previousStop.arrival_time || previousStop.updated_date, deliveryDate) : null;
      if (!legEndMs) continue;

      const matchingRows = (pendingRows || []).filter((row) => Number(row?.stop_order) === stopOrder);
      if (!matchingRows.length) continue;

      const validPoints = [];
      for (const row of matchingRows) {
        const rawPoints = Array.isArray(row?.breadcrumbs) ? row.breadcrumbs : [];
        for (const rawPoint of rawPoints) {
          const point = normalizeBreadcrumbPoint(rawPoint);
          if (!point) continue;
          const timestampMs = point[2];
          const pointDate = getEdmontonDateString(timestampMs);
          if (pointDate !== deliveryDate) continue;
          if (timestampMs > legEndMs) continue;
          if (legStartMs && timestampMs < legStartMs) continue;
          validPoints.push(point);
        }
      }

      const sortedPoints = dedupeSequential(validPoints.sort((a, b) => a[2] - b[2]));
      await base44.asServiceRole.entities.Delivery.update(delivery.id, {
        delivery_route_breadcrumbs: JSON.stringify(sortedPoints)
      });

      updatedDeliveryIds.push(delivery.id);
      sourceRows += matchingRows.length;
      matchingRows.forEach((row) => pendingBreadcrumbIds.push(row.id));
    }

    return Response.json({
      success: true,
      updatedDeliveryIds,
      pendingBreadcrumbIds: Array.from(new Set(pendingBreadcrumbIds)),
      sourceRows
    });
  } catch (error) {
    console.error('[processOrphanedBreadcrumbs] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});