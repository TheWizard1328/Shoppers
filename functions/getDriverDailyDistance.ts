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

    // Sort deliveries by stop_order to process them in sequence
    deliveries.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    // Helper: Calculate time difference between two stops in minutes
    const getTimeDifferenceMinutes = (delivery1, delivery2) => {
      const time1 = delivery1.actual_delivery_time 
        ? new Date(delivery1.actual_delivery_time)
        : delivery1.delivery_time_eta 
          ? new Date(`2000-01-01T${delivery1.delivery_time_eta}:00`)
          : delivery1.delivery_time_start 
            ? new Date(`2000-01-01T${delivery1.delivery_time_start}:00`)
            : null;
      
      const time2 = delivery2.actual_delivery_time 
        ? new Date(delivery2.actual_delivery_time)
        : delivery2.delivery_time_eta 
          ? new Date(`2000-01-01T${delivery2.delivery_time_eta}:00`)
          : delivery2.delivery_time_start 
            ? new Date(`2000-01-01T${delivery2.delivery_time_start}:00`)
            : null;
      
      if (!time1 || !time2) return 0;
      
      return Math.abs(time2 - time1) / (1000 * 60); // Convert to minutes
    };

    // Calculate total distance by summing travel_dist for all deliveries
    // CRITICAL: Exclude segments with > 90 minute gaps
    let totalDistance = 0;
    
    for (let i = 0; i < deliveries.length; i++) {
      const delivery = deliveries[i];
      const travelDist = delivery.travel_dist || 0;
      
      // Check if this segment should be excluded (gap > 90 min from previous stop)
      if (i > 0) {
        const prevDelivery = deliveries[i - 1];
        const timeDiffMinutes = getTimeDifferenceMinutes(prevDelivery, delivery);
        
        if (timeDiffMinutes > 90) {
          console.log(`⏭️ Excluding segment - ${timeDiffMinutes.toFixed(0)} min gap exceeds 90 min threshold`);
          continue; // Skip this segment's travel_dist
        }
      }
      
      totalDistance += travelDist;
    }

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