import { base44 } from '@/api/base44Client';

/**
 * Handles ETA recalculation and route optimization when a delivery status changes.
 * Called when a stop is marked as completed, failed, or cancelled.
 */
export async function handleStatusUpdateOptimization(driverId, deliveryDate) {
  const now = new Date();
  const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  try {
    // CRITICAL: First recalculate ETAs based on completion time + remaining estimated durations
    await base44.functions.invoke('recalculateRemainingETAs', {
      driverId,
      deliveryDate,
      completionTime: localTimeString
    }).catch((error) => console.warn('⚠️ [recalculateRemainingETAs] Failed:', error));

    // Then run full optimization for route reordering
    const response = await base44.functions.invoke('optimizeRemainingStops', {
      driverId,
      deliveryDate,
      currentLocalTime: localTimeString,
      deviceTime: now.toISOString()
    });

    const data = response?.data || response;
    if (!data?.success || !Array.isArray(data.optimizedRoute) || !data.optimizedRoute.length) {
      return;
    }

    window.dispatchEvent(new CustomEvent('etaUpdated', {
      detail: {
        driverId,
        updates: data.optimizedRoute
          .map((stop) => ({
            deliveryId: stop.deliveryId || stop.delivery_id,
            newEta: stop.newETA || stop.eta
          }))
          .filter((stop) => stop.deliveryId && stop.newEta)
      }
    }));

    window.dispatchEvent(new CustomEvent('routeReordered', {
      detail: { driverId, deliveryDate, source: 'statusUpdateAutoOptimize' }
    }));

    window.dispatchEvent(new CustomEvent('routeOptimizationComplete', {
      detail: { driverId, deliveryDate, source: 'statusUpdateAutoOptimize' }
    }));

  } catch (error) {
    console.warn('⚠️ [handleStatusUpdateOptimization] Error:', error);
  }
}