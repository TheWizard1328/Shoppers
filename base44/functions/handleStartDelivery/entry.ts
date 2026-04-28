import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const isRateLimitError = (error) => error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isValidObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const getCurrentLocalTimeString = () => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
};

const normalizeLocalTimeString = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const getTimeStringFromTimestamp = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : null;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId, driverId, deliveryDate, currentLocalTime } = await req.json();

    if (!deliveryId || !driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required fields: deliveryId, driverId, deliveryDate' }, { status: 400 });
    }

    if (!isValidObjectId(deliveryId) || !isValidObjectId(driverId)) {
      return Response.json({ error: 'Start was blocked because this stop is still syncing.' }, { status: 400 });
    }

    const routeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 5000);

    const finishedStatuses = new Set(['completed', 'failed', 'cancelled', 'returned']);
    const activeStatuses = new Set(['in_transit', 'en_route']);
    const selectedDelivery = (routeDeliveries || []).find((delivery) => delivery.id === deliveryId) || null;

    if (!selectedDelivery) {
      return Response.json({ error: 'Selected stop was not found' }, { status: 404 });
    }

    const oldNextDeliveries = (routeDeliveries || []).filter((delivery) => delivery?.isNextDelivery === true);
    const oldNextDeliveryId = oldNextDeliveries.find((delivery) => delivery.id !== deliveryId)?.id || null;

    const completedDeliveries = (routeDeliveries || [])
      .filter((delivery) => finishedStatuses.has(delivery?.status))
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));

    const activeDeliveries = (routeDeliveries || [])
      .filter((delivery) => activeStatuses.has(delivery?.status))
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));

    const pendingDeliveries = (routeDeliveries || [])
      .filter((delivery) => delivery?.status === 'pending')
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));

    const remainingActiveDeliveries = activeDeliveries.filter((delivery) => delivery.id !== deliveryId);
    const reorderedActiveDeliveries = [selectedDelivery, ...remainingActiveDeliveries];
    const reorderedRoute = [...completedDeliveries, ...reorderedActiveDeliveries, ...pendingDeliveries];

    const selectedStopOrder = completedDeliveries.length + 1;
    const routeUpdates = reorderedRoute.map((delivery, index) => ({
      id: delivery.id,
      stop_order: index + 1,
      isNextDelivery: delivery.id === deliveryId,
      travel_dist: delivery.id === deliveryId ? 0 : delivery.travel_dist ?? null
    }));

    for (const update of routeUpdates) {
      try {
        await base44.asServiceRole.entities.Delivery.update(update.id, {
          stop_order: update.stop_order,
          isNextDelivery: update.isNextDelivery,
          travel_dist: update.travel_dist
        });
      } catch (error) {
        if (!isNotFoundError(error) && !isRateLimitError(error)) {
          console.warn(`⚠️ [handleStartDelivery] Failed updating route stop ${update.id}:`, error?.message || error);
        }
        if (isRateLimitError(error)) {
          return Response.json({ error: 'Start was delayed by too many requests. Please tap Start again.' }, { status: 429 });
        }
      }
    }

    const startResult = selectedDelivery;

    if (!startResult) {
      return Response.json({ error: 'Failed to mark selected delivery as started' }, { status: 409 });
    }

    console.log('🔄 [handleStartDelivery] Selected delivery marked as next stop');

    const latestFinishedTime = getTimeStringFromTimestamp(completedDeliveries[completedDeliveries.length - 1]?.actual_delivery_time);
    const optimizationSeedTime = normalizeLocalTimeString(currentLocalTime) || latestFinishedTime || getCurrentLocalTimeString();

    let optimization = {
      skipped: true,
      reason: 'start_delivery_no_full_reoptimization'
    };

    try {
      const optimizationResponse = await base44.asServiceRole.functions.invoke('optimizeRemainingStops', {
        driverId,
        deliveryDate,
        currentLocalTime: optimizationSeedTime,
        preserveExistingOrder: false
      });
      const optimizationData = optimizationResponse?.data || optimizationResponse || {};
      optimization = {
        ...optimizationData,
        skipped: optimizationData?.success !== true
      };
    } catch (error) {
      if (isRateLimitError(error)) {
        optimization = {
          deferred: true,
          reason: 'rate_limited'
        };
      } else {
        console.warn('⚠️ [handleStartDelivery] optimizeRemainingStops failed:', error?.message || error);
      }
    }

    console.log(`✅ [handleStartDelivery] Started new delivery: ${deliveryId}`);

    return Response.json({
      success: true,
      distanceTransferred: 0,
      newNextDeliveryId: deliveryId,
      oldNextDeliveryId,
      selectedStopOrder,
      routeChanged: optimization?.routeChanged === true,
      optimization
    });

  } catch (error) {
    console.error('[handleStartDelivery] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});