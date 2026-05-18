// Redeployed on 2026-06-17 - Via Superagent The Boss
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
    
    // CRITICAL: Update ALL deliveries with correct stop_order and isNextDelivery.
    // first_leg_origin_lat/lng logic:
    //   - isNextDelivery stop (the one being started): STAMP it with the last completed stop's
    //     coords (or live GPS if available) so optimizeRemainingStops can cache-hit on next run.
    //   - All other non-completed stops: CLEAR their first_leg_origin so stale origins don't
    //     pollute polyline generation after a re-order.
    //   - Completed stops: leave unchanged.
    const lastCompletedStop = completedStops[completedStops.length - 1] || null;
    const liveOriginLat = driverCurrentLatitude != null ? Number(driverCurrentLatitude) : null;
    const liveOriginLng = driverCurrentLongitude != null ? Number(driverCurrentLongitude) : null;

    // Resolve the ACTUAL coordinates of the last completed stop (its destination, not its origin).
    // We need to look up patient or store coordinates for that stop.
    let lastCompletedCoords = null;
    if (lastCompletedStop) {
      try {
        if (lastCompletedStop.patient_id) {
          const patients = await base44.asServiceRole.entities.Patient.filter({ id: lastCompletedStop.patient_id }, '-created_date', 1);
          const patient = patients?.[0];
          if (patient?.latitude != null && patient?.longitude != null) {
            lastCompletedCoords = { lat: Number(patient.latitude), lng: Number(patient.longitude) };
          }
        } else if (lastCompletedStop.store_id) {
          const stores = await base44.asServiceRole.entities.Store.filter({ id: lastCompletedStop.store_id }, '-created_date', 1);
          const store = stores?.[0];
          if (store?.latitude != null && store?.longitude != null) {
            lastCompletedCoords = { lat: Number(store.latitude), lng: Number(store.longitude) };
          }
        }
      } catch (_) {/* non-critical, fall through */}
    }

    // Departure origin for the isNextDelivery stop:
    // Prefer live GPS, fall back to last completed stop's ACTUAL location (patient/store coords).
    const departureOriginLat = Number.isFinite(liveOriginLat) ? liveOriginLat
      : (lastCompletedCoords ? lastCompletedCoords.lat : null);
    const departureOriginLng = Number.isFinite(liveOriginLng) ? liveOriginLng
      : (lastCompletedCoords ? lastCompletedCoords.lng : null);

    const finishedSet = new Set(['completed', 'failed', 'cancelled', 'returned']);

    const allUpdates = reorderedRoute.map((delivery, index) => {
      const nextOrder = index + 1;
      const isTargetDelivery = delivery.id === deliveryId;
      const isFinished = finishedSet.has(delivery.status);
      const payload = {
        stop_order: nextOrder,
        display_stop_order: nextOrder,
        isNextDelivery: isTargetDelivery
      };

      if (isTargetDelivery) {
        // Stamp departure origin onto the isNextDelivery stop for cache-hit on next optimize run
        if (departureOriginLat != null) payload.first_leg_origin_lat = departureOriginLat;
        if (departureOriginLng != null) payload.first_leg_origin_lng = departureOriginLng;
      } else if (!isFinished) {
        // Clear stale first_leg_origin from all other active stops so they get fresh values
        if (delivery.first_leg_origin_lat != null) payload.first_leg_origin_lat = null;
        if (delivery.first_leg_origin_lng != null) payload.first_leg_origin_lng = null;
      }

      return { delivery, payload };
    });

    // Only update if there's an actual change
    const updatesToPersist = allUpdates.filter(({ delivery, payload }) => {
      if (Number(delivery?.stop_order || 0) !== Number(payload.stop_order)) return true;
      if (Number(delivery?.display_stop_order || 0) !== Number(payload.display_stop_order)) return true;
      if (Boolean(delivery?.isNextDelivery) !== Boolean(payload.isNextDelivery)) return true;
      if ('first_leg_origin_lat' in payload && payload.first_leg_origin_lat !== (delivery.first_leg_origin_lat ?? null)) return true;
      if ('first_leg_origin_lng' in payload && payload.first_leg_origin_lng !== (delivery.first_leg_origin_lng ?? null)) return true;
      return false;
    });

    await Promise.all(
      updatesToPersist.map(({ delivery, payload }) =>
        base44.asServiceRole.entities.Delivery.update(delivery.id, payload).catch((error) => {
          if (!isNotFoundError(error) && !isRateLimitError(error)) {
            console.warn(`âš ï¸ [handleStartDelivery] Failed updating stop ${delivery.id}:`, error?.message || error);
          }
          if (isRateLimitError(error)) throw error;
          return null;
        })
      )
    );

    console.log(`ðŸ”„ [handleStartDelivery] Route serialized for stop ${deliveryId} (${updatesToPersist.length}/${allUpdates.length} updated)`);

    return Response.json({
      success: true,
      newNextDeliveryId: deliveryId,
      oldNextDeliveryId: previousNextDelivery?.id || null,
      selectedStopOrder: reorderedRoute.findIndex((d) => d?.id === deliveryId) + 1,
      routeChanged: Boolean(updatesToPersist.length > 0)
    });

  } catch (error) {
    console.error('[handleStartDelivery] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});