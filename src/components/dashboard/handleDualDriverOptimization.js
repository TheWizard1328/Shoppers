import { performRouteOptimization } from '@/components/utils/routeOptimizationCoordinator';
import { optimizeRoutesForMovePairs } from '@/components/utils/routeMoveOptimizer';

/**
 * Re-optimize BOTH drivers' remaining stops when a delivery is re-assigned
 * between drivers (dual-driver optimization). Extracted from Dashboard.jsx.
 *
 * Uses the HERE-based performRouteOptimization coordinator (clientRouteEngine.js)
 * instead of the old nearest-neighbor Haversine optimizer. This ensures
 * HERE findsequence2 is used for stop sequencing, matching the FAB re-optimize
 * and deferred-optimization paths.
 *
 * Owner report (Oct 13 2026): when the reassign ALSO moved the date, the
 * ORIGINAL date's route (which lost the stop) was never re-optimized — its
 * polylines stayed chained through the moved stop. Pass originalDeliveryDate
 * to cover that route as well.
 *
 * Route data is re-read from IDB inside optimizeRoutesForMovePairs — the
 * deliveriesWithStopOrder closure from Dashboard is a PRE-move snapshot and
 * would make the engine re-assert the moved stop onto its old route.
 */
export async function runDualDriverOptimization({
  originalDriverId, newDriverId, deliveryDate, originalDeliveryDate,
  patients, stores, appUsers,
  // legacy params kept for call-site compatibility (unused)
  drivers: _drivers, deliveriesWithStopOrder: _dws, updateDeliveryLocal: _u, updateDeliveriesLocally: _uu,
  performRouteOptimization: _legacy,
}) {
  const pairs = [];
  const push = (driverId, date) => {
    if (!driverId || !date) return;
    if (!pairs.some((p) => p.driverId === driverId && p.deliveryDate === date)) {
      pairs.push({ driverId, deliveryDate: date });
    }
  };
  for (const driverId of [originalDriverId, newDriverId].filter(Boolean)) {
    push(driverId, deliveryDate);
  }
  // Driver + date moved together: the ORIGINAL date's route lost the stop too
  if (originalDeliveryDate && originalDeliveryDate !== deliveryDate) {
    push(originalDriverId, originalDeliveryDate);
  }
  if (pairs.length === 0) return [];
  return optimizeRoutesForMovePairs({ pairs, source: 'dual_driver_reassign', patients, stores, appUsers });
}
