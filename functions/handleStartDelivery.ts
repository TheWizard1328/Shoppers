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

    // Step 2: Find the OLD isNextDelivery (the one being changed FROM)
    const oldNextDeliveries = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      isNextDelivery: true
    });

    let distanceToTransfer = 0;
    let oldNextDeliveryId = null;

    if (oldNextDeliveries && oldNextDeliveries.length > 0) {
      const oldNextDelivery = oldNextDeliveries[0];
      oldNextDeliveryId = oldNextDelivery.id;
      
      // Transfer its accumulated travel_dist to the NEW isNextDelivery
      distanceToTransfer = oldNextDelivery.travel_dist || 0;
      console.log(`🔄 [handleStartDelivery] Transferring ${distanceToTransfer} km from old next delivery`);

      // Reset old next delivery's travel_dist to 0
      await base44.entities.Delivery.update(oldNextDelivery.id, {
        isNextDelivery: false,
        travel_dist: 0
      });
    }

    // Step 3: Set new delivery as isNextDelivery and transfer accumulated distance
    await base44.entities.Delivery.update(deliveryId, {
      isNextDelivery: true,
      travel_dist: distanceToTransfer
    });

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