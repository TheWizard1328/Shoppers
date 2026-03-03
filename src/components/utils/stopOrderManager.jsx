/**
 * Centralized Stop Order Management
 * Handles sequential stop order calculation for deliveries
 */

import { base44 } from '@/api/base44Client';
import { updateDeliveryLocal } from './offlineMutations';

/**
 * Recalculates and updates stop orders for all deliveries for a given driver/date
 * Ensures completed stops are first (sorted by completion time), then incomplete (sorted by stop_order), pending always last
 * Updates all stop orders sequentially from 1 to N
 */
export const recalculateAndUpdateStopOrders = async (driverId, deliveryDate) => {
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  
  // Fetch fresh data from backend to ensure accuracy; fallback to offline DB on network error
  const driverDeliveries = await (async () => {
    try {
      return await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });
    } catch (err) {
      console.warn('[StopOrderManager] Network error fetching deliveries, falling back to offline DB:', err?.message || err);
      try {
        const { offlineDB } = await import('./offlineDatabase');
        const all = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        return (all || []).filter(d => d?.driver_id === driverId && d?.delivery_date === deliveryDate);
      } catch (offlineErr) {
        console.warn('[StopOrderManager] Offline fallback failed:', offlineErr?.message || offlineErr);
        return [];
      }
    }
  })();

  // Sort: completed first by time, then incomplete by stop_order, pending always last
  const sortedDeliveries = [...driverDeliveries].sort((a, b) => {
    const isACompleted = finishedStatuses.includes(a.status);
    const isBCompleted = finishedStatuses.includes(b.status);
    const isAPending = a.status === 'pending';
    const isBPending = b.status === 'pending';

    // Completed stops first
    if (isACompleted && !isBCompleted) return -1;
    if (!isACompleted && isBCompleted) return 1;

    // Among completed, sort by completion time
    if (isACompleted) {
      const timeA = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : 0;
      const timeB = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : 0;
      return timeA - timeB;
    }

    // Among incomplete: pending always last
    if (isAPending && !isBPending) return 1;
    if (!isAPending && isBPending) return -1;

    // Among non-pending incomplete, sort by ETA (then stop_order as fallback)
    const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
    const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
    
    if (etaA !== etaB) {
      return etaA.localeCompare(etaB);
    }
    
    // If ETAs are equal, use stop_order as tiebreaker
    return (a.stop_order || 999) - (b.stop_order || 999);
  });

  // Reassign stop_order sequentially to ALL deliveries
  const updates = [];
  for (let i = 0; i < sortedDeliveries.length; i++) {
    const delivery = sortedDeliveries[i];
    const newStopOrder = i + 1;

    if (delivery.stop_order !== newStopOrder || delivery.display_stop_order !== newStopOrder) {
      updates.push({ id: delivery.id, stop_order: newStopOrder, display_stop_order: newStopOrder });
      await updateDeliveryLocal(
        delivery.id,
        { stop_order: newStopOrder, display_stop_order: newStopOrder },
        { skipSmartRefresh: true, isBatchOperation: true }
      );
    }
  }

  // Persist updated stop orders to backend in small batches with retries
  if (updates.length > 0) {
    const { base44 } = await import('@/api/base44Client');
    const chunkSize = 10;
    for (let i = 0; i < updates.length; i += chunkSize) {
      const slice = updates.slice(i, i + chunkSize);
      try {
        await Promise.all(
          slice.map(u => base44.entities.Delivery.update(u.id, { stop_order: u.stop_order, display_stop_order: u.display_stop_order }))
        );
      } catch (err) {
        console.warn('[StopOrderManager] Partial backend update failed (continuing):', err?.message || err);
      }
    }
  }

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