import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const isRateLimitError = (error) => error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');

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

    const selectedDelivery = (routeDeliveries || []).find((d) => d.id === deliveryId) || null;
    if (!selectedDelivery) {
      return Response.json({ error: 'Selected stop was not found' }, { status: 404 });
    }

    const oldNextDeliveryId = (routeDeliveries || [])
      .find((d) => d?.isNextDelivery === true && d.id !== deliveryId)?.id || null;

    // ── Correctly count finished stops ──────────────────────────────────────────
    // Sort by stop_order so we get the true highest completed position.
    const completedDeliveries = (routeDeliveries || [])
      .filter((d) => finishedStatuses.has(d?.status))
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));

    const numCompleted = completedDeliveries.length;

    // ── BUG FIX 1: stop_order = (# finished stops) + 1 ─────────────────────────
    // The selected stop should become the NEXT stop after the last finished one.
    // It does NOT matter where it currently sits in the incomplete list.
    const selectedStopOrder = numCompleted + 1;

    const selectedStatus = activeStatuses.has(selectedDelivery?.status)
      ? selectedDelivery.status
      : (selectedDelivery?.patient_id ? 'in_transit' : 'en_route');

    // ── BUG FIX 2: Never set delivery_time_end on Start ──────────────────────────
    // delivery_time_end is the must-deliver-before DEADLINE, not a completion time.
    // Only set delivery_time_start if it hasn't been set yet.
    // delivery_time_eta will be recalculated by optimizeRemainingStops.
    const normalizedTime = normalizeLocalTimeString(currentLocalTime) || getCurrentLocalTimeString();

    const startPayload = {
      status: selectedStatus,
      isNextDelivery: true,
      stop_order: selectedStopOrder,
      display_stop_order: selectedStopOrder,
      travel_dist: 0,
      // Only set delivery_time_start if not already set (don't overwrite a re-started stop)
      ...(selectedDelivery?.delivery_time_start ? {} : { delivery_time_start: normalizedTime }),
      // BUG FIX: Do NOT set delivery_time_end — it is the must-deliver-before deadline, set from patient data only
      // BUG FIX: Do NOT set delivery_time_eta here — optimizeRemainingStops will set it correctly
    };

    // Clear isNextDelivery on any other stop that had it
    const nextFlagResetUpdates = (routeDeliveries || [])
      .filter((d) => d?.id !== deliveryId && d?.isNextDelivery === true)
      .map((d) =>
        base44.asServiceRole.entities.Delivery.update(d.id, { isNextDelivery: false }).catch((error) => {
          if (!isNotFoundError(error) && !isRateLimitError(error)) {
            console.warn(`⚠️ [handleStartDelivery] Failed clearing next-stop flag ${d.id}:`, error?.message || error);
          }
          if (isRateLimitError(error)) throw error;
          return null;
        })
      );

    await Promise.all([
      ...nextFlagResetUpdates,
      base44.asServiceRole.entities.Delivery.update(deliveryId, startPayload)
    ]);

    console.log(`🔄 [handleStartDelivery] Stop ${deliveryId} set as next (stop_order=${selectedStopOrder}, numCompleted=${numCompleted})`);

    // ── BUG FIX 3: Seed time for optimization comes from last finished stop ──────
    // If stops are finished, use the actual completion time of the last one as
    // the optimization seed so ETAs cascade correctly from there.
    // Only fall back to currentLocalTime if no stops have been completed yet.
    const lastFinished = completedDeliveries[completedDeliveries.length - 1];
    // Only actual_delivery_time is valid — delivery_time_end is the deadline, not completion time
    const lastFinishedTime = getTimeStringFromTimestamp(lastFinished?.actual_delivery_time) || null;
    const optimizationSeedTime = lastFinishedTime || normalizedTime;

    console.log(`🕐 [handleStartDelivery] Optimization seed time: ${optimizationSeedTime} (from ${lastFinishedTime ? 'last finished stop actual_delivery_time' : 'current time'})`);

    let optimization = {
      skipped: true,
      reason: 'start_delivery_no_full_reoptimization'
    };

    try {
      const optimizationResponse = await base44.asServiceRole.functions.invoke('optimizeRemainingStops', {
        driverId,
        deliveryDate,
        // BUG FIX 4: Pass the seed time — ETAs cascade from last finished stop, not from 'now'
        currentLocalTime: optimizationSeedTime,
        preserveExistingOrder: false,
        // BUG FIX 5: forceFullRemainingRouteOptimization = false means isNextDelivery lock IS respected
        forceFullRemainingRouteOptimization: false
      });
      const optimizationData = optimizationResponse?.data || optimizationResponse || {};
      optimization = {
        ...optimizationData,
        skipped: optimizationData?.success !== true
      };
    } catch (error) {
      if (isRateLimitError(error)) {
        optimization = { deferred: true, reason: 'rate_limited' };
      } else {
        console.warn('⚠️ [handleStartDelivery] optimizeRemainingStops failed:', error?.message || error);
      }
    }

    console.log(`✅ [handleStartDelivery] Done — stop_order=${selectedStopOrder}, optimization=${JSON.stringify({ skipped: optimization?.skipped, routeChanged: optimization?.routeChanged })}`);

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
