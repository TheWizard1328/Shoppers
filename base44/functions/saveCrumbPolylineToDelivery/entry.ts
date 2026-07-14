import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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

    // 2. Decode polyline and calculate Haversine distance in km
    const decodePolyline = (encoded) => {
      const poly = [];
      let index = 0, len = encoded.length, lat = 0, lng = 0;
      while (index < len) {
        let b, shift = 0, result = 0;
        do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lat += ((result & 1) ? ~(result >> 1) : (result >> 1));
        shift = 0; result = 0;
        do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lng += ((result & 1) ? ~(result >> 1) : (result >> 1));
        poly.push([lat / 1e5, lng / 1e5]);
      }
      return poly;
    };
    const haversineKm = (lat1, lon1, lat2, lon2) => {
      const R = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    const points = decodePolyline(cleanedEncodedPolyline);
    let travelDistKm = 0;
    for (let i = 1; i < points.length; i++) {
      travelDistKm += haversineKm(points[i-1][0], points[i-1][1], points[i][0], points[i][1]);
    }
    const travelDist = Math.round(travelDistKm * 100) / 100;

    // 3. Update Delivery with new polyline + travel distance
    // Use user-scoped client (not asServiceRole) so the WebSocket subscription
    // fires on all connected devices and their offline DBs get updated.
    await base44.entities.Delivery.update(delivery.id, {
      encoded_polyline: cleanedEncodedPolyline,
      travel_dist: travelDist,
    });

    // 4. Update DeliveryBreadcrumbs record — save cleaned polyline and tag as saved_to_route
    const crumbs = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      stop_order: stopOrder,
    });

    let breadcrumbId = null;
    if (crumbs && crumbs.length > 0) {
      breadcrumbId = crumbs[0].id;
      await base44.entities.DeliveryBreadcrumbs.update(crumbs[0].id, {
        encoded_polyline: cleanedEncodedPolyline,
        saved_to_route: true,
      });
    }

    return Response.json({
      success: true,
      deliveryId: delivery.id,
      breadcrumbId,
      travelDistKm: travelDist,
      message: `Delivery stop #${stopOrder} polyline updated, travel_dist ${travelDist} km saved.`,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});