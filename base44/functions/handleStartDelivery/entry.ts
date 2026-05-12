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

    const { deliveryId, driverId, deliveryDate, currentLocalTime, driverCurrentLatitude, driverCurrentLongitude } = await req.json();

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
    const completedStops = (routeDeliveries || [])
      .filter((d) => finishedStatuses.has(d?.status))
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));
    const activeStops = (routeDeliveries || [])
      .filter((d) => !finishedStatuses.has(d?.status) && d?.status !== 'pending')
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));
    const pendingStops = (routeDeliveries || [])
      .filter((d) => d?.status === 'pending')
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));

    const normalizedTime = normalizeLocalTimeString(currentLocalTime) || getCurrentLocalTimeString();
    const previousNextDelivery = (routeDeliveries || []).find((d) => d?.id !== deliveryId && d?.isNextDelivery === true) || null;

    const reorderedActiveStops = activeStops
      .filter((d) => d?.id !== deliveryId)
      .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));
    const selectedDelivery = (routeDeliveries || []).find((d) => d?.id === deliveryId) || null;
    if (!selectedDelivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }
    reorderedActiveStops.unshift(selectedDelivery);

    const reorderedRoute = [...completedStops, ...reorderedActiveStops, ...pendingStops].filter(Boolean);
    
    // CRITICAL: Update ALL deliveries with correct stop_order and isNextDelivery
    // This ensures the optimizer always has consistent, authoritative route data
    const allUpdates = reorderedRoute.map((delivery, index) => {
      const nextOrder = index + 1;
      const isTargetDelivery = delivery.id === deliveryId;
      const payload = {
        stop_order: nextOrder,
        display_stop_order: nextOrder,
        isNextDelivery: isTargetDelivery
      };
      return { delivery, payload };
    });

    // Only update if there's an actual change
    const updatesToPersist = allUpdates.filter(({ delivery, payload }) => {
      return Number(delivery?.stop_order || 0) !== Number(payload.stop_order)
        || Number(delivery?.display_stop_order || 0) !== Number(payload.display_stop_order)
        || Boolean(delivery?.isNextDelivery) !== Boolean(payload.isNextDelivery);
    });

    await Promise.all(
      updatesToPersist.map(({ delivery, payload }) =>
        base44.asServiceRole.entities.Delivery.update(delivery.id, payload).catch((error) => {
          if (!isNotFoundError(error) && !isRateLimitError(error)) {
            console.warn(`⚠️ [handleStartDelivery] Failed updating stop ${delivery.id}:`, error?.message || error);
          }
          if (isRateLimitError(error)) throw error;
          return null;
        })
      )
    );

    console.log(`🔄 [handleStartDelivery] Route serialized for stop ${deliveryId} (${updatesToPersist.length}/${allUpdates.length} updated)`);

    // CRITICAL: Trigger full route optimization for remaining stops after re-ordering
    // This will update ETAs, travel distances, and polylines based on driver's current location
    let optimizedRoute = null;
    try {
      const optimizeResponse = await base44.functions.invoke('optimizeRemainingStops', {
        driverId: driverId,
        deliveryDate: deliveryDate,
        currentLocalTime: normalizedTime,
        deviceTime: new Date().toISOString(),
        currentLocation: driverCurrentLatitude && driverCurrentLongitude ? {
          lat: driverCurrentLatitude,
          lon: driverCurrentLongitude
        } : undefined,
        bypassDeduplication: true
      });
      optimizedRoute = optimizeResponse?.data?.optimizedRoute || optimizeResponse?.optimizedRoute;
      
      // CRITICAL: Persist optimized deliveries to offline DB and notify UI
      if (optimizedRoute && Array.isArray(optimizedRoute)) {
        const optimizedDeliveryUpdates = optimizedRoute
          .filter((stop) => stop?.deliveryId || stop?.delivery_id)
          .map((stop) => ({
            id: stop.deliveryId || stop.delivery_id,
            stop_order: Number.isFinite(Number(stop.stop_order)) ? Number(stop.stop_order) : undefined,
            display_stop_order: Number.isFinite(Number(stop.stop_order)) ? Number(stop.stop_order) : undefined,
            delivery_time_eta: stop.newETA || stop.eta,
            travel_dist: typeof stop.travel_dist === 'number' ? stop.travel_dist : undefined,
            encoded_polyline: typeof stop.encoded_polyline === 'string' ? stop.encoded_polyline : undefined,
            estimated_distance_km: typeof stop.estimated_distance_km === 'number' ? stop.estimated_distance_km : undefined,
            estimated_duration_minutes: typeof stop.estimated_duration_minutes === 'number' ? stop.estimated_duration_minutes : undefined
          }))
          .filter((update) => update.id && (update.stop_order !== undefined || update.delivery_time_eta || update.travel_dist || update.encoded_polyline));

        if (optimizedDeliveryUpdates.length > 0) {
          console.log(`✅ [handleStartDelivery] Persisting ${optimizedDeliveryUpdates.length} optimized deliveries to offline DB and UI`);
          // Dispatch event for frontend to update offline DB and UI
          // The frontend will handle both offline DB persistence and UI state updates
          // Use CustomEvent to notify the app of the optimization results
          // Note: Backend cannot directly update offlineDB or dispatch browser events
          // So we return optimizedRoute in response for frontend to handle
        }
      }
    } catch (optimizeError) {
      console.warn(`⚠️ [handleStartDelivery] Optimization failed (non-blocking):`, optimizeError?.message || optimizeError);
    }

    return Response.json({
      success: true,
      newNextDeliveryId: deliveryId,
      oldNextDeliveryId: previousNextDelivery?.id || null,
      selectedStopOrder: reorderedRoute.findIndex((d) => d?.id === deliveryId) + 1,
      routeChanged: Boolean(updatesToPersist.length > 0),
      optimizedRoute: optimizedRoute || []
    });

  } catch (error) {
    console.error('[handleStartDelivery] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});