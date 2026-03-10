import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, driverId, deliveryDate } = await req.json();

    if (!deliveryId || !driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required fields: deliveryId, driverId, deliveryDate' }, { status: 400 });
    }

    // Step 1: Get current driver location from AppUser
    const appUsers = await base44.entities.AppUser.filter({ user_id: driverId });
    if (!appUsers || appUsers.length === 0) {
      return Response.json({ error: 'Driver AppUser not found' }, { status: 404 });
    }

    const driverAppUser = appUsers[0];
    const currentLat = driverAppUser.current_latitude;
    const currentLng = driverAppUser.current_longitude;

    // Step 2: Find ALL OLD isNextDelivery flags and reset them
    const oldNextDeliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      isNextDelivery: true
    });

    let distanceToTransfer = 0;
    let oldNextDeliveryId = null;

    if (oldNextDeliveries && oldNextDeliveries.length > 0) {
      console.log(`🔄 [handleStartDelivery] Found ${oldNextDeliveries.length} deliveries with isNextDelivery=true, resetting all...`);
      
      // Transfer distance from first one only
      const oldNextDelivery = oldNextDeliveries[0];
      oldNextDeliveryId = oldNextDelivery.id;
      distanceToTransfer = oldNextDelivery.travel_dist || 0;
      console.log(`🔄 [handleStartDelivery] Transferring ${distanceToTransfer} km from ${oldNextDelivery.patient_name}`);

      // CRITICAL: Reset ALL old next delivery flags in parallel
      const resetPromises = oldNextDeliveries.map(delivery => 
        base44.entities.Delivery.update(delivery.id, {
          isNextDelivery: false,
          travel_dist: 0
        })
      );
      await Promise.all(resetPromises);
      console.log(`✅ [handleStartDelivery] Reset ${oldNextDeliveries.length} isNextDelivery flags`);
    }

    // Step 3: Set new delivery as isNextDelivery and transfer accumulated distance
    await base44.entities.Delivery.update(deliveryId, {
      isNextDelivery: true,
      travel_dist: distanceToTransfer
    });

    // Step 3.5: Re-sequence stop orders so the started stop becomes the first active stop
    const allDeliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order');

    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const completedDeliveries = (allDeliveries || []).filter((delivery) => finishedStatuses.includes(delivery.status));
    const activeDeliveries = (allDeliveries || []).filter((delivery) => !finishedStatuses.includes(delivery.status));

    completedDeliveries.sort((a, b) => {
      if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
      return new Date(a.actual_delivery_time).getTime() - new Date(b.actual_delivery_time).getTime();
    });

    activeDeliveries.sort((a, b) => {
      if (a.id === deliveryId) return -1;
      if (b.id === deliveryId) return 1;
      const orderDelta = (a.stop_order || 999999) - (b.stop_order || 999999);
      if (orderDelta !== 0) return orderDelta;
      const etaA = String(a.delivery_time_eta || a.delivery_time_start || '99:99');
      const etaB = String(b.delivery_time_eta || b.delivery_time_start || '99:99');
      return etaA.localeCompare(etaB);
    });

    const reorderedStops = [...completedDeliveries, ...activeDeliveries];
    await Promise.all(
      reorderedStops.map((delivery, index) => {
        const nextOrder = index + 1;
        if (delivery.stop_order === nextOrder) return Promise.resolve(null);
        return base44.entities.Delivery.update(delivery.id, {
          stop_order: nextOrder,
          display_stop_order: nextOrder
        });
      })
    );
    
    // CRITICAL: Notify frontend to reset live distance tracker's accumulated counter
    // The distance has been transferred, so the tracker should reset to 0
    console.log(`🔄 [handleStartDelivery] Notifying frontend - distance transferred: ${distanceToTransfer} km`);

    // Step 4: Update driver's current location (mark start point for new leg)
    if (currentLat && currentLng) {
      await base44.entities.AppUser.update(driverAppUser.id, {
        current_latitude: currentLat,
        current_longitude: currentLng,
        location_updated_at: new Date().toISOString()
      });
    }

    console.log(`✅ [handleStartDelivery] Started new delivery: ${deliveryId}, transferred ${distanceToTransfer} km`);

    return Response.json({
      success: true,
      distanceTransferred: distanceToTransfer,
      newNextDeliveryId: deliveryId,
      oldNextDeliveryId,
      routeChanged: false,
      optimization: null
    });

  } catch (error) {
    console.error('[handleStartDelivery] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});