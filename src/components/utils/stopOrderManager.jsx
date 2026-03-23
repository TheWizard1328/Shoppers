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

  // Preserve visible stop positions; only repair missing/duplicate orders, with pending always last.
  const sortedDeliveries = [...driverDeliveries].sort((a, b) => {
    const isAPending = a.status === 'pending';
    const isBPending = b.status === 'pending';
    if (isAPending && !isBPending) return 1;
    if (!isAPending && isBPending) return -1;

    const aOrder = Number(a.stop_order);
    const bOrder = Number(b.stop_order);
    const hasAOrder = Number.isFinite(aOrder) && aOrder > 0;
    const hasBOrder = Number.isFinite(bOrder) && bOrder > 0;
    if (hasAOrder && hasBOrder && aOrder !== bOrder) return aOrder - bOrder;

    const isAFinished = finishedStatuses.includes(a.status);
    const isBFinished = finishedStatuses.includes(b.status);
    if (isAFinished && isBFinished) {
      const timeA = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER;
      const timeB = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER;
      if (timeA !== timeB) return timeA - timeB;
    }

    const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
    const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
    if (etaA !== etaB) return etaA.localeCompare(etaB);
    if (hasAOrder) return -1;
    if (hasBOrder) return 1;
    return 0;
  });

  const existingOrders = sortedDeliveries
    .map((delivery) => Number(delivery.stop_order))
    .filter((order) => Number.isFinite(order) && order > 0);
  const usedOrders = new Set();
  let nextGeneratedOrder = existingOrders.length > 0 ? Math.max(...existingOrders) + 1 : 1;

  const updates = [];
  for (const delivery of sortedDeliveries) {
    const currentStopOrder = Number(delivery.stop_order);
    const newStopOrder = Number.isFinite(currentStopOrder) && currentStopOrder > 0 && !usedOrders.has(currentStopOrder)
      ? currentStopOrder
      : nextGeneratedOrder++;
    usedOrders.add(newStopOrder);

    if (currentStopOrder !== newStopOrder) {
      updates.push({ id: delivery.id, stop_order: newStopOrder });
      await updateDeliveryLocal(
        delivery.id,
        { stop_order: newStopOrder },
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
          slice.map(u => base44.entities.Delivery.update(u.id, { stop_order: u.stop_order }))
        );
      } catch (err) {
        console.warn('[StopOrderManager] Partial backend update failed (continuing):', err?.message || err);
      }
    }

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