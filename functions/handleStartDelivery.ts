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

    // Step 1: Find old isNextDelivery flags and clear only the ones we no longer need
    const oldNextDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      isNextDelivery: true
    }, 'stop_order', 10);

    const oldNextDeliveriesToReset = (oldNextDeliveries || []).filter((delivery) => delivery.id !== deliveryId);
    let distanceToTransfer = 0;
    let oldNextDeliveryId = null;

    if (oldNextDeliveriesToReset.length > 0) {
      console.log(`🔄 [handleStartDelivery] Found ${oldNextDeliveriesToReset.length} previous next deliveries, resetting...`);

      const oldNextDelivery = oldNextDeliveriesToReset[0];
      oldNextDeliveryId = oldNextDelivery.id;
      distanceToTransfer = oldNextDelivery.travel_dist || 0;
      console.log(`🔄 [handleStartDelivery] Transferring ${distanceToTransfer} km from ${oldNextDelivery.patient_name}`);
    }

    const resetPromises = oldNextDeliveriesToReset.map((delivery) =>
      base44.asServiceRole.entities.Delivery.update(delivery.id, {
        isNextDelivery: false,
        travel_dist: 0
      })
    );

    await Promise.all([
      ...resetPromises,
      base44.asServiceRole.entities.Delivery.update(deliveryId, {
        isNextDelivery: true,
        travel_dist: distanceToTransfer
      })
    ]);

    console.log(`🔄 [handleStartDelivery] Notifying frontend - distance transferred: ${distanceToTransfer} km`);

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