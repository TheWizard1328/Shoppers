/**
 * clientNextDelivery.js — Client-side replacement for the backend `setNextDeliveryFlag` function.
 *
 * Computes stop_order repairs and isNextDelivery flags locally so the originating device
 * can write authoritative state to the server in a single batch, eliminating the need for
 * a second backend function call and its associated WS broadcast.
 *
 * Logic mirrors the backend implementation in base44/functions/setNextDeliveryFlag/entry.ts.
 */

const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['in_transit', 'en_route']);

/**
 * Recalculates correct 1-based stop_order for all route deliveries.
 * Returns array of { id, stop_order } for deliveries requiring updates.
 */
export function buildStopOrderRepairs(deliveries) {
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

    const aEta = getEta(a);
    const bEta = getEta(b);
    if (aEta !== bEta) return aEta.localeCompare(bEta);

    return getStopOrder(a) - getStopOrder(b);
  });

  return sorted
    .map((delivery, index) => ({ delivery, newOrder: index + 1 }))
    .filter(({ delivery, newOrder }) => Number(delivery?.stop_order) !== newOrder)
    .map(({ delivery, newOrder }) => ({ id: delivery.id, stop_order: newOrder }));
}

/**
 * Returns candidate active stops sorted by priority and stop_order.
 * Primary: in_transit/en_route/cycling markers.
 * Fallback: pending stops (if no active mid-route stops exist).
 */
export function getSortedActiveDeliveries(deliveries) {
  const activeStops = (deliveries || [])
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

  if (activeStops.length > 0) return activeStops;

  return (deliveries || [])
    .filter((delivery) => delivery && delivery.status === 'pending' && !delivery.is_cycling_marker)
    .sort((a, b) => {
      const stopOrderDiff = (a.stop_order || 0) - (b.stop_order || 0);
      if (stopOrderDiff !== 0) return stopOrderDiff;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
}

/**
 * Find the most recently completed stop and resolve its origin coordinates.
 */
function resolveLastFinishedOrigin(deliveries, patientLookup, storeLookup) {
  const finished = (deliveries || [])
    .filter((d) => FINISHED_STATUSES.has(d?.status))
    .sort((a, b) => {
      const ta = new Date(a?.actual_delivery_time || a?.arrival_time || a?.updated_date || a?.created_date || 0).getTime();
      const tb = new Date(b?.actual_delivery_time || b?.arrival_time || b?.updated_date || b?.created_date || 0).getTime();
      return tb - ta;
    });

  const last = finished[0];
  if (!last) return null;

  if (last.patient_id && patientLookup) {
    const patient = patientLookup(last.patient_id);
    if (patient?.latitude != null && patient?.longitude != null) {
      return { lat: patient.latitude, lng: patient.longitude };
    }
  }

  if (last.store_id && storeLookup) {
    const store = storeLookup(last.store_id);
    if (store?.latitude != null && store?.longitude != null) {
      return { lat: store.latitude, lng: store.longitude };
    }
  }

  if (last.latitude != null && last.longitude != null) {
    return { lat: last.latitude, lng: last.longitude };
  }

  return null;
}

/**
 * Main client-side calculation. Computes stop_order repairs and isNextDelivery flags.
 *
 * @param {Object} params
 * @param {Array}  params.deliveries — All route deliveries for the driver+date
 * @param {string} params.driverStatus — 'on_duty' | 'off_duty' | 'on_break'
 * @param {string|null} params.targetDeliveryId — Optional explicit next delivery target
 * @param {Function|null} params.patientLookup — (patientId) => patient record
 * @param {Function|null} params.storeLookup — (storeId) => store record
 * @returns {Object} { updatedDeliveries, nextDeliveryId, repairsCount, changedDeliveries }
 */
export function computeNextDeliveryState({
  deliveries,
  driverStatus,
  targetDeliveryId = null,
  patientLookup = null,
  storeLookup = null,
}) {
  const repairs = buildStopOrderRepairs(deliveries);
  const repairMap = new Map(repairs.map((r) => [r.id, r.stop_order]));

  const repairedDeliveries = (deliveries || []).map((d) => ({
    ...d,
    stop_order: repairMap.has(d.id) ? repairMap.get(d.id) : d.stop_order,
  }));

  const activeDeliveries = getSortedActiveDeliveries(repairedDeliveries);

  let nextDelivery = null;
  if (driverStatus === 'on_duty') {
    if (targetDeliveryId) {
      nextDelivery = activeDeliveries.find((d) => d.id === targetDeliveryId) || null;
    }
    if (!nextDelivery) {
      nextDelivery = activeDeliveries[0] || null;
    }
  }

  const lastFinishedOrigin = resolveLastFinishedOrigin(repairedDeliveries, patientLookup, storeLookup);

  const changedDeliveries = [];
  const updatedDeliveries = repairedDeliveries.map((delivery) => {
    const isNext = Boolean(nextDelivery && delivery.id === nextDelivery.id);
    const wasNext = Boolean(delivery.isNextDelivery);

    const stopOrderChanged = repairMap.has(delivery.id);
    const isNextChanged = isNext !== wasNext;
    const needsOriginStamp = isNext && lastFinishedOrigin &&
      (delivery.first_leg_origin_lat !== lastFinishedOrigin.lat ||
       delivery.first_leg_origin_lng !== lastFinishedOrigin.lng);

    if (!stopOrderChanged && !isNextChanged && !needsOriginStamp) {
      return delivery;
    }

    const update = { ...delivery, isNextDelivery: isNext };
    if (needsOriginStamp) {
      update.first_leg_origin_lat = lastFinishedOrigin.lat;
      update.first_leg_origin_lng = lastFinishedOrigin.lng;
    }

    changedDeliveries.push(update);
    return update;
  });

  return {
    updatedDeliveries,
    nextDeliveryId: nextDelivery?.id || null,
    repairsCount: repairs.length,
    changedDeliveries,
  };
}
