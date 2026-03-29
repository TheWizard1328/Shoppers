/**
 * Centralized Stop Order Management
 * Handles sequential stop order calculation for deliveries
 */

import { base44 } from '@/api/base44Client';
import { updateDeliveryLocal } from './entityMutations';

/**
 * Recalculates and updates stop orders for all deliveries for a given driver/date
 * Ensures completed stops are first (sorted by completion time), then incomplete (sorted by stop_order), pending always last
 * Updates all stop orders sequentially from 1 to N
 */
export const recalculateAndUpdateStopOrders = async (driverId, deliveryDate, skipPolylineRegeneration = false) => {
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

  // Use offline data first to avoid rate-limit bursts during batch saves
  const driverDeliveries = await (async () => {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const all = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      const offlineMatches = (all || []).filter(d => d?.driver_id === driverId && d?.delivery_date === deliveryDate);
      if (offlineMatches.length > 0) return offlineMatches;
    } catch (offlineErr) {
      console.warn('[StopOrderManager] Offline read failed, falling back to network:', offlineErr?.message || offlineErr);
    }

    try {
      return await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });
    } catch (err) {
      console.warn('[StopOrderManager] Network error fetching deliveries, falling back to empty list:', err?.message || err);
      return [];
    }
  })();

  const getSortableCompletionTime = (delivery) => {
    if (!delivery) return Number.MAX_SAFE_INTEGER;
    if (delivery.actual_delivery_time) {
      const time = new Date(delivery.actual_delivery_time).getTime();
      if (Number.isFinite(time)) return time;
    }
    const fallback = delivery.arrival_time || delivery.updated_date || delivery.created_date;
    if (fallback) {
      const time = new Date(fallback).getTime();
      if (Number.isFinite(time)) return time;
    }
    return Number.MAX_SAFE_INTEGER;
  };

  const getSortableEta = (delivery) => delivery?.delivery_time_eta || delivery?.delivery_time_start || '99:99';

  // Always rebuild the full route order from actual route data.
  const nextDeliveryId = driverDeliveries.find((delivery) => delivery?.isNextDelivery && !finishedStatuses.includes(delivery?.status) && delivery?.status !== 'pending')?.id || null;

  const sortedDeliveries = [...driverDeliveries].sort((a, b) => {
    const isAFinished = finishedStatuses.includes(a?.status);
    const isBFinished = finishedStatuses.includes(b?.status);
    if (isAFinished && !isBFinished) return -1;
    if (!isAFinished && isBFinished) return 1;

    if (isAFinished && isBFinished) {
      return getSortableCompletionTime(a) - getSortableCompletionTime(b);
    }

    const aIsLockedNext = !!nextDeliveryId && a?.id === nextDeliveryId;
    const bIsLockedNext = !!nextDeliveryId && b?.id === nextDeliveryId;
    if (aIsLockedNext && !bIsLockedNext) return -1;
    if (!aIsLockedNext && bIsLockedNext) return 1;

    const isAPending = a?.status === 'pending';
    const isBPending = b?.status === 'pending';
    if (isAPending && !isBPending) return 1;
    if (!isAPending && isBPending) return -1;

    return getSortableEta(a).localeCompare(getSortableEta(b));
  });

  const updates = [];
  for (let index = 0; index < sortedDeliveries.length; index += 1) {
    const delivery = sortedDeliveries[index];
    const newStopOrder = index + 1;
    const currentStopOrder = Number(delivery.stop_order);

    if (currentStopOrder !== newStopOrder) {
      updates.push({ id: delivery.id, stop_order: newStopOrder });
      await updateDeliveryLocal(
        delivery.id,
        { stop_order: newStopOrder },
        { skipSmartRefresh: true, isBatchOperation: false }
      );
      // Small delay to prevent rate limits when updating many stops sequentially
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  if (updates.length > 0 && !skipPolylineRegeneration) {
    try {
      await base44.functions.invoke('purgeAndRegeneratePolylines', {
        driverId,
        deliveryDate,
        scope: 'active_only'
      });
    } catch (err) {
      console.warn('[StopOrderManager] Polyline regeneration failed (non-fatal):', err?.message || err);
    }
  }

  try { window.dispatchEvent(new CustomEvent('routeReordered', { detail: { driverId, deliveryDate } })); } catch (_) {}
  return sortedDeliveries;
};

/**
 * Updates isNextDelivery flags for a driver/date
 * Sets the first non-completed, non-pending delivery as the next delivery
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
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  const firstIncomplete = allDeliveries
    .filter((d) => !finishedStatuses.includes(d.status) && d.status !== 'pending')
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];

  if (firstIncomplete) {
    await base44.entities.Delivery.update(firstIncomplete.id, { isNextDelivery: true });
  }
};