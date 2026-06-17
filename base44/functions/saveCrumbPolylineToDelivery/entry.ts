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

    // Find the matching Delivery record
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

    return Response.json({ success: true, deliveryId: delivery.id, message: `Delivery stop #${stopOrder} polyline updated.` });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});