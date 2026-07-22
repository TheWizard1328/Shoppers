import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Breadcrumb polylines use 1e7 precision (client encoder in locationBreadcrumbService.jsx)
// Delivery route polylines use 1e5 precision (HERE API standard Google format)
const BREADCRUMB_PRECISION = 1e7;
const DELIVERY_PRECISION = 1e5;

function decodePolylineAt(encoded, precision) {
  const poly = [];
  let index = 0, len = encoded.length, lat = 0, lng = 0;
  while (index < len) {
    let b, result = 0, multiplier = 1;
    do { b = encoded.charCodeAt(index++) - 63; result += (b % 32) * multiplier; multiplier *= 32; } while (b >= 0x20);
    lat += ((result % 2 !== 0) ? -((result + 1) / 2) : (result / 2));
    result = 0; multiplier = 1;
    do { b = encoded.charCodeAt(index++) - 63; result += (b % 32) * multiplier; multiplier *= 32; } while (b >= 0x20);
    lng += ((result % 2 !== 0) ? -((result + 1) / 2) : (result / 2));
    poly.push([lat / precision, lng / precision]);
  }
  return poly;
}

function encodePolylineAt(points, precision) {
  const encodeValue = (val) => {
    let v = Math.round(val * precision);
    v = v < 0 ? (-v * 2 - 1) : (v * 2);
    let result = '';
    while (v >= 0x20) { result += String.fromCharCode((0x20 + (v % 0x20)) + 63); v = Math.floor(v / 0x20); }
    result += String.fromCharCode(v + 63);
    return result;
  };
  let prevLat = 0, prevLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    encoded += encodeValue(lat - prevLat) + encodeValue(lng - prevLng);
    prevLat = lat; prevLng = lng;
  }
  return encoded;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { driverId, deliveryDate, stopOrder, cleanedEncodedPolyline } = await req.json();

    if (!driverId || !deliveryDate || stopOrder == null || !cleanedEncodedPolyline) {
      return Response.json({ error: 'Missing required fields: driverId, deliveryDate, stopOrder, cleanedEncodedPolyline' }, { status: 400 });
    }

    // 1. Find the matching Delivery record
    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      stop_order: stopOrder,
    });

    if (!deliveries || deliveries.length === 0) {
      return Response.json({ error: `No delivery found for driver ${driverId}, date ${deliveryDate}, stop ${stopOrder}` }, { status: 404 });
    }

    const delivery = deliveries[0];

    // 2. Decode polyline at breadcrumb precision (1e7) and calculate Haversine distance
    const haversineKm = (lat1, lon1, lat2, lon2) => {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    const points = decodePolylineAt(cleanedEncodedPolyline, BREADCRUMB_PRECISION);
    let travelDistKm = 0;
    for (let i = 1; i < points.length; i++) {
      travelDistKm += haversineKm(points[i-1][0], points[i-1][1], points[i][0], points[i][1]);
    }
    const travelDist = Math.round(travelDistKm * 100) / 100;

    // 3. Re-encode at delivery precision (1e5) for the Delivery entity.
    //    Delivery polylines are consumed by route rendering code that expects 1e5 (HERE API standard).
    const deliveryEncodedPolyline = encodePolylineAt(points, DELIVERY_PRECISION);

    // Update Delivery with re-encoded polyline + travel distance + timestamp in ONE write.
    await base44.asServiceRole.entities.Delivery.update(delivery.id, {
      encoded_polyline: deliveryEncodedPolyline,
      travel_dist: travelDist,
      polyline_saved_at: new Date().toISOString(),
    });

    // 4. Update DeliveryBreadcrumbs record — save cleaned polyline at breadcrumb precision (1e7)
    const crumbs = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      stop_order: stopOrder,
    });

    let breadcrumbId = null;
    if (crumbs && crumbs.length > 0) {
      breadcrumbId = crumbs[0].id;
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(crumbs[0].id, {
        encoded_polyline: cleanedEncodedPolyline,
        saved_to_route: true,
      });
    }

    return Response.json({
      success: true,
      deliveryId: delivery.id,
      breadcrumbId,
      travelDistKm: travelDist,
      deliveryEncodedPolyline,
      message: `Delivery stop #${stopOrder} polyline updated, travel_dist ${travelDist} km saved.`,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
