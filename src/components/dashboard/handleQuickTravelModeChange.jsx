import { updateDeliveryLocal } from '@/components/utils/offlineMutations';
import { offlineDB } from '@/components/utils/offlineDatabase';

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
 *
 * FIX (Sep 11 2026): updateDeliveryLocal's server sync is fire-and-forget —
 * it returns as soon as the IDB write lands, while the backend write for
 * transport_mode is still in flight. The optimizer call below used to omit
 * `deliveries`, so performRouteOptimization fell back to fetching straight
 * from the backend (base44.entities.Delivery.filter) — a race that often
 * read the OLD transport_mode (server hadn't caught up yet) and wrote it
 * right back into stop_order/transport_mode, silently reverting the toggle.
 * Fix: read the driver+date set from local IDB (already fresh — it was just
 * written above) and pass it explicitly as `deliveries`, so the engine never
 * has to race the backend for this leg's mode.
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

    // Pull the fresh driver+date set from local IDB — updateDeliveryLocal has
    // already written the new transport_mode there, so this is guaranteed to
    // reflect the just-made change (no race with the in-flight server sync).
    const allLocal = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    let localDeliveries = (allLocal || []).filter(
      (d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
    );
    // Defensive: ensure the target stop's transport_mode is definitely the new
    // value in the array we hand to the engine, even if the IDB read raced
    // updateDeliveryLocal's own write somehow.
    localDeliveries = localDeliveries.map((d) =>
      d.id === delivery.id ? { ...d, ...(updated || {}), transport_mode: newMode, finished_leg_transport_mode: newMode } : d
    );
    if (!localDeliveries.some((d) => d.id === delivery.id) && updated) {
      localDeliveries.push({ ...updated, transport_mode: newMode, finished_leg_transport_mode: newMode });
    }

    await performRouteOptimization({
      driverId: delivery.driver_id,
      deliveryDate: delivery.delivery_date,
      deliveries: localDeliveries,
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
