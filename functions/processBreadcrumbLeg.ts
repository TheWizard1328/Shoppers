import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const normalizePoint = (point) => {
  if (Array.isArray(point) && point.length >= 2) {
    const latitude = Number(point[0]);
    const longitude = Number(point[1]);
    const timestamp = point.length >= 3 ? Number(point[2]) : null;

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return timestamp !== null && Number.isFinite(timestamp)
        ? [latitude, longitude, timestamp]
        : [latitude, longitude];
    }
  }

  if (point && typeof point === 'object') {
    const latitude = Number(point.latitude ?? point.lat);
    const longitude = Number(point.longitude ?? point.lng ?? point.lon);
    const rawTimestamp = point.timestamp ?? point.timestamp_ms ?? point.time;
    const timestamp = rawTimestamp == null ? null : Number(rawTimestamp);

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return timestamp !== null && Number.isFinite(timestamp)
        ? [latitude, longitude, timestamp]
        : [latitude, longitude];
    }
  }

  return null;
};

const getPerpendicularDistance = (point, start, end) => {
  const x = point[0];
  const y = point[1];
  const x1 = start[0];
  const y1 = start[1];
  const x2 = end[0];
  const y2 = end[1];

  const dx = x2 - x1;
  const dy = y2 - y1;

  if (dx === 0 && dy === 0) {
    return Math.hypot(x - x1, y - y1);
  }

  const numerator = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1);
  const denominator = Math.hypot(dx, dy);
  return numerator / denominator;
};

const simplifyRdp = (points, epsilon) => {
  if (points.length <= 2) {
    return points;
  }

  let maxDistance = 0;
  let maxIndex = 0;

  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = getPerpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }

  if (maxDistance > epsilon) {
    const firstHalf = simplifyRdp(points.slice(0, maxIndex + 1), epsilon);
    const secondHalf = simplifyRdp(points.slice(maxIndex), epsilon);
    return [...firstHalf.slice(0, -1), ...secondHalf];
  }

  return [points[0], points[points.length - 1]];
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = req.method === 'POST'
      ? await req.json().catch(() => ({}))
      : {};

    const deliveryId = payload.delivery_id;
    const rawPoints = Array.isArray(payload.raw_points)
      ? payload.raw_points
      : Array.isArray(payload.breadcrumbs)
        ? payload.breadcrumbs
        : [];
    const epsilon = Number(payload.epsilon ?? 0.00005);

    if (!deliveryId) {
      return Response.json({ error: 'delivery_id is required' }, { status: 400 });
    }

    if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
      return Response.json({ error: 'raw_points or breadcrumbs array is required' }, { status: 400 });
    }

    const normalizedPoints = rawPoints
      .map(normalizePoint)
      .filter(Boolean);

    if (normalizedPoints.length === 0) {
      return Response.json({ error: 'No valid GPS points were provided' }, { status: 400 });
    }

    const simplifiedPoints = simplifyRdp(normalizedPoints, epsilon);

    try {
      await base44.entities.Delivery.update(deliveryId, {
        delivery_route_breadcrumbs: JSON.stringify(simplifiedPoints),
      });
    } catch (error) {
      if (error?.message?.includes('not found')) {
        return Response.json({
          success: false,
          skipped: true,
          reason: 'delivery_not_found',
          delivery_id: deliveryId,
          stop_order: payload.stop_order ?? null,
          raw_point_count: normalizedPoints.length,
          simplified_point_count: simplifiedPoints.length,
          epsilon,
        });
      }
      throw error;
    }

    return Response.json({
      success: true,
      delivery_id: deliveryId,
      stop_order: payload.stop_order ?? null,
      raw_point_count: normalizedPoints.length,
      simplified_point_count: simplifiedPoints.length,
      reduction_count: normalizedPoints.length - simplifiedPoints.length,
      epsilon,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});