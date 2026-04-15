import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const isValidObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);

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

    if (!isValidObjectId(deliveryId) || !isValidObjectId(driverId)) {
      return Response.json({ error: 'Start was blocked because this stop is still syncing.' }, { status: 400 });
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
      }).catch((error) => {
        if (isNotFoundError(error)) return null;
        console.warn(`⚠️ [handleStartDelivery] Failed resetting old next delivery ${delivery.id}:`, error?.message || error);
        return null;
      })
    );

    const startResult = await base44.asServiceRole.entities.Delivery.update(deliveryId, {
      isNextDelivery: true,
      travel_dist: distanceToTransfer
    }).catch((error) => {
      if (isNotFoundError(error)) return null;
      console.error(`❌ [handleStartDelivery] Failed updating selected delivery ${deliveryId}:`, error?.message || error);
      return null;
    });

    await Promise.allSettled(resetPromises);

    if (!startResult) {
      return Response.json({ error: 'Failed to mark selected delivery as started' }, { status: 409 });
    }

    console.log(`🔄 [handleStartDelivery] Notifying frontend - distance transferred: ${distanceToTransfer} km`);

    let optimization = null;
    try {
      const now = new Date();
      const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const optimizationResponse = await base44.functions.invoke('optimizeRouteRealTime', {
        driverId,
        deliveryDate,
        currentLocalTime,
        deviceTime: now.toISOString(),
        generatePolyline: true
      });
      optimization = optimizationResponse?.data || optimizationResponse || null;
    } catch (error) {
      console.warn(`⚠️ [handleStartDelivery] optimizeRouteRealTime failed:`, error?.message || error);
      optimization = null;
    }

    console.log(`✅ [handleStartDelivery] Started new delivery: ${deliveryId}, transferred ${distanceToTransfer} km`);

    return Response.json({
      success: true,
      distanceTransferred: distanceToTransfer,
      newNextDeliveryId: deliveryId,
      oldNextDeliveryId,
      routeChanged: !!optimization?.routeChanged,
      optimization
    });

  } catch (error) {
    console.error('[handleStartDelivery] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});