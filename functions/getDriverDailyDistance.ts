import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { driverId, deliveryDate } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required fields: driverId and deliveryDate' }, { status: 400 });
    }

    // Fetch all deliveries for this driver and date
    const deliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    });

    // Calculate total distance by summing travel_dist for all deliveries
    // This includes completed stops AND the current isNextDelivery stop
    const totalDistance = deliveries.reduce((sum, delivery) => {
      const travelDist = delivery.travel_dist || 0;
      return sum + travelDist;
    }, 0);

    return Response.json({
      driverId,
      deliveryDate,
      totalDistanceKm: parseFloat(totalDistance.toFixed(2)),
      deliveryCount: deliveries.length
    });

  } catch (error) {
    console.error('[getDriverDailyDistance] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});