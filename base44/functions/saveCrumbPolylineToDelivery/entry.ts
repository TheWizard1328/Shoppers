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

    // 1. Update the Delivery record's encoded_polyline
    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      stop_order: stopOrder,
    });

    if (!deliveries || deliveries.length === 0) {
      return Response.json({ error: `No delivery found for driver ${driverId}, date ${deliveryDate}, stop ${stopOrder}` }, { status: 404 });
    }

    const delivery = deliveries[0];
    await base44.asServiceRole.entities.Delivery.update(delivery.id, {
      encoded_polyline: cleanedEncodedPolyline,
    });

    // 2. Update the DeliveryBreadcrumbs record — save cleaned polyline and tag as saved_to_route
    const crumbs = await base44.asServiceRole.entities.DeliveryBreadcrumbs.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      stop_order: stopOrder,
    });

    let breadcrumbId = null;
    if (crumbs && crumbs.length > 0) {
      breadcrumbId = crumbs[0].id;
      // Count points by decoding length heuristic — just store the polyline and flag it
      await base44.asServiceRole.entities.DeliveryBreadcrumbs.update(crumbs[0].id, {
        encoded_polyline: cleanedEncodedPolyline,
        saved_to_route: true,
      });
    }

    return Response.json({
      success: true,
      deliveryId: delivery.id,
      breadcrumbId,
      message: `Delivery stop #${stopOrder} polyline updated and breadcrumb saved.`,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});