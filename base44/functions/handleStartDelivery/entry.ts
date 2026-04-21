import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const isRateLimitError = (error) => error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    const oldNextDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      isNextDelivery: true
    }, 'stop_order', 50);

    const oldNextDeliveriesToReset = (oldNextDeliveries || []).filter((delivery) => delivery.id !== deliveryId);
    const oldNextDeliveryId = oldNextDeliveriesToReset[0]?.id || null;

    for (const delivery of oldNextDeliveriesToReset) {
      try {
        await base44.asServiceRole.entities.Delivery.update(delivery.id, {
          isNextDelivery: false,
          travel_dist: 0
        });
      } catch (error) {
        if (!isNotFoundError(error) && !isRateLimitError(error)) {
          console.warn(`⚠️ [handleStartDelivery] Failed resetting old next delivery ${delivery.id}:`, error?.message || error);
        }
        if (isRateLimitError(error)) {
          return Response.json({ error: 'Start was delayed by too many requests. Please tap Start again.' }, { status: 429 });
        }
      }
    }

    const startResult = await base44.asServiceRole.entities.Delivery.update(deliveryId, {
      isNextDelivery: true,
      travel_dist: 0
    }).catch((error) => {
      if (isNotFoundError(error)) return null;
      if (isRateLimitError(error)) throw error;
      console.error(`❌ [handleStartDelivery] Failed updating selected delivery ${deliveryId}:`, error?.message || error);
      return null;
    });

    if (!startResult) {
      return Response.json({ error: 'Failed to mark selected delivery as started' }, { status: 409 });
    }

    console.log('🔄 [handleStartDelivery] Selected delivery marked as next stop');

    console.log(`✅ [handleStartDelivery] Started new delivery: ${deliveryId}`);

    return Response.json({
      success: true,
      distanceTransferred: 0,
      newNextDeliveryId: deliveryId,
      oldNextDeliveryId,
      routeChanged: false,
      optimization: {
        skipped: true,
        reason: 'start_delivery_no_full_reoptimization'
      }
    });

  } catch (error) {
    console.error('[handleStartDelivery] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});