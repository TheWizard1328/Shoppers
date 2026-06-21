/**
 * Centralized Stop Order Management
 * Handles sequential stop order calculation for deliveries
 *
 * Sort spec:
 *   1. Finished stops (completed/failed/cancelled/returned) first, sorted by
 *      actual_delivery_time ASC. Cycling markers follow the same rule.
 *   2. Incomplete stops sorted by their existing stop_order (optimizer order),
 *      with pending last. Cycling markers follow the same rule.
 *   3. ALL stops (finished + incomplete) receive a fresh sequential stop_order 1..N.
 */

import { base44 } from '@/api/base44Client';
import { updateDeliveryLocal } from './entityMutations';
// Note: base44 is still needed for updateNextDeliveryFlags below

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

/**
 * Recalculates and updates stop orders for all deliveries for a given driver/date.
 * Finished stops sort by actual_delivery_time; incomplete by existing stop_order.
 * Cycling markers follow the same rules as regular stops.
 * Updates all stop orders sequentially from 1 to N.
 */
export const recalculateAndUpdateStopOrders = async (driverId, deliveryDate, skipPolylineRegeneration = false, skipPolylineIfNoOrderChange = false) => {
  // Read from offline DB first to avoid unnecessary network calls
  const driverDeliveries = await (async () => {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const all = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      return (all || []).filter(d => d?.driver_id === driverId && d?.delivery_date === deliveryDate);
    } catch (err) {
      console.warn('[StopOrderManager] Offline DB read failed:', err?.message || err);
      return [];
    }
  })();

  if (!driverDeliveries.length) {
    return { sortedDeliveries: [], orderChanged: false };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  const getCompletionTime = (d) => {
    if (!d) return Number.MAX_SAFE_INTEGER;
    if (d.actual_delivery_time) {
      const t = new Date(d.actual_delivery_time).getTime();
      if (Number.isFinite(t)) return t;
    }
    const fallback = d.arrival_time || d.updated_date || d.created_date;
    if (fallback) {
      const t = new Date(fallback).getTime();
      if (Number.isFinite(t)) return t;
    }
    return Number.MAX_SAFE_INTEGER;
  };

  const getExistingOrder = (d) => {
    const n = Number(d?.stop_order);
    return Number.isFinite(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
  };

  // ── Partition ──────────────────────────────────────────────────────────────
  const finishedDeliveries  = driverDeliveries.filter(d => FINISHED_STATUSES.includes(d?.status));
  const incompleteDeliveries = driverDeliveries.filter(d => !FINISHED_STATUSES.includes(d?.status));

  // ── Sort finished by actual_delivery_time (cycling markers treated equally) ─
  const sortedFinished = [...finishedDeliveries].sort((a, b) => getCompletionTime(a) - getCompletionTime(b));

  // ── Sort incomplete: pending last; within non-pending sort by existing stop_order ──
  // Cycling markers are typically in_transit/en_route so they flow through the
  // stop_order sort path and keep their optimizer-assigned position.
  const nextDeliveryId = incompleteDeliveries.find(
    d => d?.isNextDelivery && d?.status !== 'pending'
  )?.id || null;

  const sortedIncomplete = [...incompleteDeliveries].sort((a, b) => {
    // "next delivery" always first among incomplete
    const aNext = nextDeliveryId && a?.id === nextDeliveryId;
    const bNext = nextDeliveryId && b?.id === nextDeliveryId;
    if (aNext && !bNext) return -1;
    if (!aNext && bNext) return 1;

    // Pending last (but cycling markers are never pending in practice)
    const aPending = a?.status === 'pending' && !a?.is_cycling_marker;
    const bPending = b?.status === 'pending' && !b?.is_cycling_marker;
    if (aPending && !bPending) return 1;
    if (!aPending && bPending) return -1;

    // Both pending or both non-pending: sort by existing stop_order (preserves optimizer result)
    return getExistingOrder(a) - getExistingOrder(b);
  });

  // ── Merge: finished first, then incomplete ──────────────────────────────────
  const ordered = [...sortedFinished, ...sortedIncomplete];

  // ── Assign sequential stop_order 1..N to ALL stops ─────────────────────────
  const updates = [];
  for (let i = 0; i < ordered.length; i++) {
    const delivery = ordered[i];
    if (!delivery?.id) continue;
    const newStopOrder = i + 1;
    const currentStopOrder = Number(delivery.stop_order);
    if (currentStopOrder !== newStopOrder) {
      updates.push({ id: delivery.id, stop_order: newStopOrder });
      await updateDeliveryLocal(
        delivery.id,
        { stop_order: newStopOrder },
        { skipSmartRefresh: true, isBatchOperation: true }
      );
      // Small delay to prevent rate limits when updating many stops sequentially
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  if (updates.length > 0) {
    try {
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { triggeredBy: 'stopOrderRecalc', driverId, deliveryDate, preserveLocalState: true }
      }));
    } catch (_) {}
  }

  // Polyline regeneration is intentionally NOT done here.
  // The optimizationDebouncer is the single authority for triggering purgeAndRegeneratePolylines
  // after form saves. Direct calls from stopOrderManager caused duplicate API calls.

  try {
    window.dispatchEvent(new CustomEvent('routeReordered', {
      detail: { driverId, deliveryDate, suppressFabIfPhase1: true }
    }));
  } catch (_) {}

  return { sortedDeliveries: ordered, orderChanged: updates.length > 0 };
};

/**
 * Updates isNextDelivery flags for a driver/date.
 * Sets the first non-completed, non-pending delivery as the next delivery.
 */
export const updateNextDeliveryFlags = async (driverId, deliveryDate) => {
  const allDeliveries = await base44.entities.Delivery.filter({
    driver_id: driverId,
    delivery_date: deliveryDate
  }, 'stop_order');

  // Reset all flags
  const resetPromises = allDeliveries
    .filter((d) => d.isNextDelivery)
    .map((d) => base44.entities.Delivery.update(d.id, { isNextDelivery: false }));
  if (resetPromises.length > 0) {
    await Promise.all(resetPromises);
  }

  // Find first incomplete (SKIP PENDING)
  const firstIncomplete = allDeliveries
    .filter((d) => !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending')
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];

  if (firstIncomplete) {
    await base44.entities.Delivery.update(firstIncomplete.id, { isNextDelivery: true });
  }
};
