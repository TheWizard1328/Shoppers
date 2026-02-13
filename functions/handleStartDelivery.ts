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
      oldNextDeliveryId
    });

  } catch (error) {
    console.error('[handleStartDelivery] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});