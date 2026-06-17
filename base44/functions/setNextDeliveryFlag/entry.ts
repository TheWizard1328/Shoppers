import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

/**
 * Recalculates correct stop_order for all deliveries after a completion event.
 * Order: finished stops (sorted by completion time asc) → active stops (sorted by current stop_order) → pending stops (sorted by current stop_order)
 * Returns a map of { deliveryId -> newStopOrder } for stops that need updating.
 */
function buildStopOrderRepairs(deliveries) {
  const getCompletionTime = (delivery) => {
    if (!delivery) return Number.MAX_SAFE_INTEGER;
    if (delivery.actual_delivery_time) {
      const t = new Date(delivery.actual_delivery_time).getTime();
      if (Number.isFinite(t)) return t;
    }
    const fallback = delivery.arrival_time || delivery.updated_date || delivery.created_date;
    if (fallback) {
      const t = new Date(fallback).getTime();
      if (Number.isFinite(t)) return t;
    }
    return Number.MAX_SAFE_INTEGER;
  };

  const getStopOrder = (delivery) => {
    const v = Number(delivery?.stop_order);
    return Number.isFinite(v) && v > 0 ? v : Number.MAX_SAFE_INTEGER;
  };

  const getEta = (delivery) => delivery?.delivery_time_eta || delivery?.delivery_time_start || '99:99';

  // Sort: finished first (by completion time), then active (by stop_order, then ETA), then pending (by stop_order)
  const sorted = [...(deliveries || [])].sort((a, b) => {
    const aFinished = FINISHED_STATUSES.has(a?.status);
    const bFinished = FINISHED_STATUSES.has(b?.status);

    if (aFinished && !bFinished) return -1;
    if (!aFinished && bFinished) return 1;

    if (aFinished && bFinished) {
      const timeDiff = getCompletionTime(a) - getCompletionTime(b);
      if (timeDiff !== 0) return timeDiff;
      return getStopOrder(a) - getStopOrder(b);
    }

    const aPending = a?.status === 'pending';
    const bPending = b?.status === 'pending';
    if (aPending && !bPending) return 1;
    if (!aPending && bPending) return -1;

    const stopOrderDiff = getStopOrder(a) - getStopOrder(b);
    if (stopOrderDiff !== 0) return stopOrderDiff;

    return getEta(a).localeCompare(getEta(b));
  });

  // Return only stops whose stop_order needs to change
  return sorted
    .map((delivery, index) => ({ delivery, newOrder: index + 1 }))
    .filter(({ delivery, newOrder }) => Number(delivery?.stop_order) !== newOrder)
    .map(({ delivery, newOrder }) => ({ id: delivery.id, stop_order: newOrder }));
}

const ACTIVE_STATUSES = new Set(['in_transit', 'en_route']);

const getSortedActiveDeliveries = (deliveries) =>
  (deliveries || [])
    .filter((delivery) =>
      delivery && (
        ACTIVE_STATUSES.has(delivery.status) ||
        delivery.is_cycling_marker === true
      ) &&
      !FINISHED_STATUSES.has(delivery.status)
    )
    .sort((a, b) => {
      const stopOrderDiff = (a.stop_order || 0) - (b.stop_order || 0);
      if (stopOrderDiff !== 0) return stopOrderDiff;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { driverId, deliveryDate, targetDeliveryId } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required fields: driverId, deliveryDate' }, { status: 400 });
    }

    const routeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 5000);

    // CRITICAL: Repair stop_order immediately on completion so completed stops
    // are always sequenced before active stops, regardless of where they were in the order.
    const stopOrderRepairs = buildStopOrderRepairs(routeDeliveries);
    if (stopOrderRepairs.length > 0) {
      console.log(`[setNextDeliveryFlag] Repairing stop_order for ${stopOrderRepairs.length} stop(s) | driver=${driverId} | date=${deliveryDate}`);
      await Promise.all(
        stopOrderRepairs.map(({ id, stop_order }) =>
          base44.asServiceRole.entities.Delivery.update(id, { stop_order }).catch((error) => {
            if (isNotFoundError(error)) return null;
            console.warn(`[setNextDeliveryFlag] stop_order repair failed for ${id}:`, error?.message || error);
            return null;
          })
        )
      );
    }

    // Re-fetch after repairs so isNextDelivery is set against the corrected order
    const repairedDeliveries = stopOrderRepairs.length > 0
      ? await base44.asServiceRole.entities.Delivery.filter({
          driver_id: driverId,
          delivery_date: deliveryDate
        }, 'stop_order', 5000)
      : routeDeliveries;

    const activeDeliveries = getSortedActiveDeliveries(repairedDeliveries);

    // CRITICAL: Only set isNextDelivery if the driver is on_duty
    const driverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-updated_date', 1);
    const driverAppUser = Array.isArray(driverAppUsers) ? driverAppUsers[0] : null;
    const driverIsOnDuty = driverAppUser?.driver_status === 'on_duty';

    // Helper: parse "HH:mm" to total minutes from midnight
    const parseTimeToMinutes = (timeStr) => {
      if (!timeStr || typeof timeStr !== 'string') return null;
      const parts = timeStr.split(':');
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
      return h * 60 + m;
    };

    // Current local time in Edmonton (minutes from midnight)
    const now = new Date();
    const edmontonTimeStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(now);
    const currentMinutes = parseTimeToMinutes(edmontonTimeStr) ?? (now.getUTCHours() * 60 + now.getUTCMinutes());

    let nextDelivery = null;
    if (driverIsOnDuty) {
      if (targetDeliveryId) {
        nextDelivery = activeDeliveries.find((delivery) => delivery.id === targetDeliveryId) || null;
      }
      if (!nextDelivery) {
        nextDelivery = activeDeliveries[0] || null;
      }

      // Note: removed 2-hour suppression — isNextDelivery is always set on the next active stop
      // so the driver always has a clearly identified next delivery regardless of time.
    }

    // CRITICAL: Find the last finished delivery to use as origin for next leg
    const lastFinishedDelivery = repairedDeliveries
      .filter((d) => FINISHED_STATUSES.has(d?.status))
      .sort((a, b) => {
        const aTime = new Date(a?.actual_delivery_time || a?.arrival_time || a?.updated_date || 0).getTime();
        const bTime = new Date(b?.actual_delivery_time || b?.arrival_time || b?.updated_date || 0).getTime();
        return bTime - aTime;
      })[0] || null;

    // Resolve coordinates for the last finished delivery
    let lastFinishedOriginLat = null;
    let lastFinishedOriginLng = null;
    if (lastFinishedDelivery) {
      if (lastFinishedDelivery.patient_id) {
        const patientList = await base44.asServiceRole.entities.Patient.filter({ id: lastFinishedDelivery.patient_id }, undefined, 1);
        const patient = Array.isArray(patientList) ? patientList[0] : null;
        if (patient?.latitude && patient?.longitude) {
          lastFinishedOriginLat = Number(patient.latitude);
          lastFinishedOriginLng = Number(patient.longitude);
        }
      } else if (lastFinishedDelivery.store_id) {
        const storeList = await base44.asServiceRole.entities.Store.filter({ id: lastFinishedDelivery.store_id }, undefined, 1);
        const store = Array.isArray(storeList) ? storeList[0] : null;
        if (store?.latitude && store?.longitude) {
          lastFinishedOriginLat = Number(store.latitude);
          lastFinishedOriginLng = Number(store.longitude);
        }
      }
    }

    console.log('[setNextDeliveryFlag] Resolving next stop', {
      driverId,
      deliveryDate,
      targetDeliveryId: targetDeliveryId || null,
      activeCount: activeDeliveries.length,
      resolvedNextDeliveryId: nextDelivery?.id || null,
      lastFinishedDeliveryId: lastFinishedDelivery?.id || null,
      lastFinishedOriginLat,
      lastFinishedOriginLng,
      stopOrderRepairsCount: stopOrderRepairs.length
    });

    const deliveriesToUpdate = activeDeliveries
      .filter((delivery) => Boolean(delivery?.isNextDelivery) !== Boolean(nextDelivery && delivery.id === nextDelivery.id))
      .map((delivery) => {
        const update = {
          isNextDelivery: !!nextDelivery && delivery.id === nextDelivery.id
        };
        // CRITICAL: When marking a delivery as next, update its first_leg_origin with last finished coords
        if (nextDelivery && delivery.id === nextDelivery.id && lastFinishedOriginLat != null && lastFinishedOriginLng != null) {
          update.first_leg_origin_lat = lastFinishedOriginLat;
          update.first_leg_origin_lng = lastFinishedOriginLng;
        }
        return { id: delivery.id, ...update };
      });

    const updates = deliveriesToUpdate.map((delivery) =>
      base44.asServiceRole.entities.Delivery.update(delivery.id, {
        isNextDelivery: delivery.isNextDelivery,
        ...(delivery.first_leg_origin_lat != null && { first_leg_origin_lat: delivery.first_leg_origin_lat }),
        ...(delivery.first_leg_origin_lng != null && { first_leg_origin_lng: delivery.first_leg_origin_lng })
      }).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      })
    );

    if (updates.length > 0) {
      await Promise.all(updates);
    }

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      targetDeliveryId: targetDeliveryId || null,
      resolvedNextDeliveryId: nextDelivery?.id || null,
      updatedCount: updates.length,
      stopOrderRepairsCount: stopOrderRepairs.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});