import { updateDeliveryLocal } from '@/components/utils/offlineMutations';

/**
 * Quick per-stop travel mode toggle (Sep 4 2026).
 *
 * The on-card travel mode button previously showed/toggled the DRIVER's
 * app-wide preferred_travel_mode (currentDriverAppUser.preferred_travel_mode) —
 * every stop card for that driver showed the same icon regardless of what mode
 * was actually used for that specific delivery's leg. It also had no working
 * onChange (disabled, onChange=null) — display only.
 *
 * This now targets delivery.transport_mode — the field the route engine
 * actually reads per-leg (see clientRouteEngine.js `existingMode` handling,
 * which preserves an explicitly-set per-stop transport_mode across
 * re-optimizations instead of overwriting it with the driver's global mode).
 *
 * Flow:
 *  1. Write transport_mode (+ finished_leg_transport_mode, kept in sync so a
 *     later completion doesn't revert the leg's recorded mode) to the single
 *     delivery via updateDeliveryLocal — local IDB + server, offline-safe.
 *  2. Re-run performRouteOptimization with preserveExistingOrder so the
 *     engine recomputes THIS leg's polyline/distance/ETA using the new mode
 *     (HERE cycling vs driving routing differ meaningfully) without
 *     reshuffling stop order. performRouteOptimization writes stop_order
 *     atomically as part of its own writeBatch (same pattern as
 *     handleQuickReorder), satisfying the repair-after-stop-edit rule.
 */
export async function handleQuickTravelModeChange(delivery, newMode, currentUser) {
  if (!delivery?.id || !delivery?.driver_id || !delivery?.delivery_date) return null;
  if (!['driving', 'cycling', 'pedestrian'].includes(newMode)) return null;

  const updated = await updateDeliveryLocal(delivery.id, {
    transport_mode: newMode,
    finished_leg_transport_mode: newMode,
  });

  try {
    const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');
    await performRouteOptimization({
      driverId: delivery.driver_id,
      deliveryDate: delivery.delivery_date,
      preserveExistingOrder: true,
      bypassDriverStatus: true,
      source: 'travel_mode_toggle',
    });
  } catch (err) {
    console.warn('⚠️ [TravelModeToggle] Route re-optimization after mode change failed:', err?.message || err);
  }

  window.dispatchEvent(new CustomEvent('driverTravelModeChanged', {
    detail: { deliveryId: delivery.id, driverId: delivery.driver_id, travelMode: newMode, scope: 'stop' }
  }));

  return updated;
}
