import { base44 } from '@/api/base44Client';
import { performRouteOptimization } from '@/components/utils/routeOptimizationCoordinator';

/**
 * Re-optimize BOTH drivers' remaining stops when a delivery is re-assigned
 * between drivers (dual-driver optimization). Extracted from Dashboard.jsx.
 *
 * Uses the HERE-based performRouteOptimization coordinator (clientRouteEngine.js)
 * instead of the old nearest-neighbor Haversine optimizer. This ensures
 * HERE findsequence2 is used for stop sequencing, matching the FAB re-optimize
 * and deferred-optimization paths.
 */
export async function runDualDriverOptimization({
  originalDriverId, newDriverId, deliveryDate,
  drivers, patients, stores, appUsers, deliveriesWithStopOrder, updateDeliveryLocal,
  updateDeliveriesLocally,
}) {
  for (const driverId of [originalDriverId, newDriverId].filter(Boolean)) {
    const driver = drivers.find((d) => d && d.id === driverId);
    if (!driver) continue;

    // Use the HERE-based coordinator — it handles completed/incomplete separation,
    // stop_order assignment, polyline generation, and ETA calculation internally.
    await performRouteOptimization({
      driverId,
      deliveryDate,
      deliveries: deliveriesWithStopOrder,
      patients,
      stores,
      appUsers,
      source: 'dual_driver_reassign',
      bypassDriverStatus: true,
    }).catch((err) => {
      console.warn(`⚠️ [runDualDriverOptimization] HERE optimization failed for driver ${driverId}:`, err?.message || err);
    });
  }
}