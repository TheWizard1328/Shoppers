import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Polyline encoding (Google format)
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

function parseBreadcrumbPayload(payload) {
  if (!payload) return [];
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((point) => Array.isArray(point) && point.length >= 2);
  } catch {
    return [];
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, breadcrumbPayload, sourcePendingKey, stopOrder, breadcrumbDate, overwrite = false } = await req.json();

    if (!deliveryId) {
      return Response.json({ error: 'Missing deliveryId' }, { status: 400 });
    }

    const newPoints = parseBreadcrumbPayload(breadcrumbPayload);
    if (!newPoints.length) {
      return Response.json({ status: 'skipped', reason: 'empty_breadcrumbs', deliveryId, sourcePendingKey, stopOrder, breadcrumbDate });
    }

    // Fetch the delivery to get the composite key fields
    const deliveries = await base44.asServiceRole.entities.Delivery.filter({ id: deliveryId });
    const delivery = deliveries?.[0];
    if (!delivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const appUser = appUsers?.[0] || null;
    const isAdmin = Array.isArray(appUser?.app_roles) && appUser.app_roles.includes('admin');

    if (delivery.driver_id !== user.id && !isAdmin) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Look up existing record by composite key (driver_id + delivery_date + stop_order)
    const existingRecords = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id: delivery.driver_id,
      delivery_date: delivery.delivery_date,
      stop_order: Number(delivery.stop_order),
    }).catch(() => []);
    const existingRecord = existingRecords?.[0] || null;

    // Always append new points to existing ones (merge by timestamp order)
    let allPoints = newPoints;
    if (existingRecord?.encoded_polyline && existingRecord?.timestamps && !overwrite) {
      const existingCoords = decodePolyline(existingRecord.encoded_polyline);
      const existingTs = existingRecord.timestamps.split(',').map(Number);
      const existingPoints = existingCoords.map((coord, i) => [coord[0], coord[1], existingTs[i] || 0]);
      allPoints = [...existingPoints, ...newPoints].sort((a, b) => (a[2] || 0) - (b[2] || 0));
    }

    const encodedPolyline = encodePolyline(allPoints);
    const timestamps = allPoints.map((p) => p[2] || 0).join(',');

    const breadcrumbData = {
      driver_id: delivery.driver_id,
      delivery_date: delivery.delivery_date,
      stop_order: Number(delivery.stop_order),
      encoded_polyline: encodedPolyline,
      timestamps,
      transport_mode: delivery.transport_mode || 'driving',
      point_count: allPoints.length,
    };

    if (existingRecord?.id) {
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(existingRecord.id, breadcrumbData);
    } else {
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.create(breadcrumbData);
    }

    return Response.json({
      status: 'synced',
      deliveryId,
      sourcePendingKey,
      stopOrder,
      breadcrumbDate,
      breadcrumbCount: allPoints.length
    });
  } catch (error) {
    console.error('❌ [syncPendingBreadcrumbs] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
});