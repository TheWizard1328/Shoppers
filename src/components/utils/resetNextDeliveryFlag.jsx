import { base44 } from "@/api/base44Client";
import { offlineDB } from './offlineDatabase';

/**
 * Reset and set isNextDelivery flags for a driver's route
 * This ensures the first incomplete delivery is marked as isNextDelivery=true
 * 
 * @param {string} driverId - The driver's user_id
 * @param {string} deliveryDate - The delivery date (YYYY-MM-DD)
 * @param {Array} allDeliveries - All deliveries for context
 * @returns {Promise<string|null>} - The ID of the next delivery, or null if none
 */
export async function resetNextDeliveryFlag({ driverId, deliveryDate, allDeliveries = [] }) {
  if (!driverId || !deliveryDate) return null;

  try {
    // Get all deliveries for this driver on this date
    const routeDeliveries = allDeliveries.filter(
      (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate
    );

    if (routeDeliveries.length === 0) return null;

    // Sort by stop_order to find the first incomplete delivery
    const sortedDeliveries = [...routeDeliveries].sort(
      (a, b) => (a.stop_order || 0) - (b.stop_order || 0)
    );

    // Find the first incomplete delivery (not completed, failed, cancelled, or returned)
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const nextDelivery = sortedDeliveries.find(
      (d) => !finishedStatuses.includes(d.status) && d.status !== 'pending'
    );

    // Clear all existing isNextDelivery flags and set the new one
    const updatedDeliveries = routeDeliveries.map((d) => ({
      ...d,
      isNextDelivery: nextDelivery && d.id === nextDelivery.id
    }));

    // Update offline DB immediately
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, updatedDeliveries);

    // Sync to backend in background (don't block)
    Promise.resolve().then(async () => {
      try {
        await base44.functions.invoke('setNextDeliveryFlag', {
          driverId,
          deliveryDate,
          targetDeliveryId: nextDelivery?.id || null
        });
      } catch (error) {
        console.warn('[resetNextDeliveryFlag] Background sync failed:', error?.message || error);
      }
    });

    // Dispatch event to notify UI
    if (typeof window !== 'undefined' && nextDelivery?.id) {
      window.dispatchEvent(
        new CustomEvent('nextDeliveryReset', {
          detail: { driverId, deliveryDate, nextDeliveryId: nextDelivery.id }
        })
      );
    }

    return nextDelivery?.id || null;
  } catch (error) {
    console.error('[resetNextDeliveryFlag] Error:', error?.message || error);
    return null;
  }
}

/**
 * Reset isNextDelivery flags for multiple drivers
 * Useful for initial app load when showing all drivers
 * 
 * @param {Array} drivers - Array of driver objects with id
 * @param {string} deliveryDate - The delivery date
 * @param {Array} allDeliveries - All deliveries
 * @returns {Promise<void>}
 */
export async function resetNextDeliveryFlagsForDrivers({ drivers = [], deliveryDate, allDeliveries = [] }) {
  const promises = drivers.map((driver) =>
    resetNextDeliveryFlag({
      driverId: driver.id,
      deliveryDate,
      allDeliveries
    })
  );
  await Promise.allSettled(promises);
}