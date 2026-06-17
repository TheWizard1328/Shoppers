import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');
const isRateLimitError = (error) => error?.status === 429 || error?.response?.status === 429 || String(error?.message || '').toLowerCase().includes('rate limit');
const isValidObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const {
      deliveryId,
      driverId,
      deliveryDate,
      currentLocalTime,
      driverCurrentLatitude,
      driverCurrentLongitude,
      hereApiKey
    } = await req.json();

    if (!deliveryId || !driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required fields: deliveryId, driverId, deliveryDate' }, { status: 400 });
    }

    if (!isValidObjectId(deliveryId) || !isValidObjectId(driverId)) {
      return Response.json({ error: 'Start was blocked because this stop is still syncing.' }, { status: 400 });
    }

    // Fetch only what we need: the target delivery and the current isNextDelivery stop
    const routeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 5000);

    const selectedDelivery = (routeDeliveries || []).find((d) => d?.id === deliveryId) || null;
    if (!selectedDelivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    const previousNextDelivery = (routeDeliveries || []).find((d) => d?.id !== deliveryId && d?.isNextDelivery === true) || null;

    // Determine the next stop_order: the lowest active (non-finished, non-pending) stop_order
    // that is >= the first active stop — or just put it right after completed stops.
    const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);
    const completedStops = (routeDeliveries || []).filter((d) => FINISHED_STATUSES.has(d?.status));
    const nextStopOrder = completedStops.length + 1;

    // Resolve departure origin for first_leg_origin stamping
    const liveOriginLat = driverCurrentLatitude != null ? Number(driverCurrentLatitude) : null;
    const liveOriginLng = driverCurrentLongitude != null ? Number(driverCurrentLongitude) : null;

    let departureOriginLat = Number.isFinite(liveOriginLat) ? liveOriginLat : null;
    let departureOriginLng = Number.isFinite(liveOriginLng) ? liveOriginLng : null;

    // If no live GPS, try last completed stop's patient/store coords
    if (departureOriginLat == null && completedStops.length > 0) {
      const lastCompleted = completedStops.sort((a, b) => Number(b.stop_order || 0) - Number(a.stop_order || 0))[0];
      try {
        if (lastCompleted.patient_id) {
          const patients = await base44.asServiceRole.entities.Patient.filter({ id: lastCompleted.patient_id }, '-created_date', 1);
          const p = patients?.[0];
          if (p?.latitude != null) { departureOriginLat = Number(p.latitude); departureOriginLng = Number(p.longitude); }
        } else if (lastCompleted.store_id) {
          const stores = await base44.asServiceRole.entities.Store.filter({ id: lastCompleted.store_id }, '-created_date', 1);
          const s = stores?.[0];
          if (s?.latitude != null) { departureOriginLat = Number(s.latitude); departureOriginLng = Number(s.longitude); }
        }
      } catch (_) {/* non-critical */}
    }

    // STEP 1: Two targeted writes — clear old isNextDelivery, set new one
    const newStopPayload = {
      isNextDelivery: true,
      stop_order: nextStopOrder,
      display_stop_order: nextStopOrder,
      ...(departureOriginLat != null ? { first_leg_origin_lat: departureOriginLat } : {}),
      ...(departureOriginLng != null ? { first_leg_origin_lng: departureOriginLng } : {})
    };

    const writes = [
      base44.asServiceRole.entities.Delivery.update(deliveryId, newStopPayload).catch((e) => {
        if (!isNotFoundError(e)) console.warn('[handleStartDelivery] Failed to update new next stop:', e?.message);
        return null;
      })
    ];

    if (previousNextDelivery) {
      writes.push(
        base44.asServiceRole.entities.Delivery.update(previousNextDelivery.id, {
          isNextDelivery: false
        }).catch((e) => {
          if (!isNotFoundError(e)) console.warn('[handleStartDelivery] Failed to clear old next stop:', e?.message);
          return null;
        })
      );
    }

    await Promise.all(writes);

    console.log(`[handleStartDelivery] Set isNextDelivery on ${deliveryId} (stop_order=${nextStopOrder}), cleared ${previousNextDelivery?.id || 'none'}`);

    // STEP 2: Fire optimizeRemainingStops to reorder remaining stops, update polylines and ETAs
    // isNextDelivery stop is now stamped — optimizer will lock it as route origin and sequence the rest
    base44.functions.invoke('optimizeRemainingStops', {
      driverId,
      deliveryDate,
      currentLocalTime,
      bypassDriverStatus: true,
      triggerSource: 'handleStartDelivery',
      ...(hereApiKey ? { hereApiKey } : {})
    }).catch((e) => {
      console.warn('[handleStartDelivery] optimizeRemainingStops fire-and-forget failed:', e?.message);
    });

    return Response.json({
      success: true,
      newNextDeliveryId: deliveryId,
      oldNextDeliveryId: previousNextDelivery?.id || null,
      selectedStopOrder: nextStopOrder,
      routeChanged: true
    });

  } catch (error) {
    if (isRateLimitError(error)) {
      return Response.json({ success: false, deferred: true, reason: 'rate_limited' });
    }
    console.error('[handleStartDelivery] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});