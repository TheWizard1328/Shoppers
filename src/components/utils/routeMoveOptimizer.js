import { performRouteOptimization } from './routeOptimizationCoordinator';

/**
 * Route-move optimizer (owner report, Oct 13 2026)
 *
 * When a stop is moved OFF a route — different driver, different date — the
 * SOURCE route keeps polylines chained through the moved stop and the TARGET
 * route never re-sequences, because none of the move paths (bulk edit panel,
 * edit-form date change, dual-driver reassign) triggered an optimization.
 *
 * This util re-optimizes every affected (driver, date) route pair:
 *  - Data source is IDB (local-first authority), NOT the React-state closures
 *    the callers hold — those are pre-move snapshots and would make the engine
 *    re-optimize the moved stop back onto its OLD route (same stale-closure
 *    class as the Oct 13 completed-revert Start fix).
 *  - The engine's Oct 7 adjacency validation detects legs whose stored
 *    polyline is anchored at a stop that is no longer the predecessor (the
 *    stop that followed the moved one) and regenerates exactly those routes.
 *  - Pairs run SEQUENTIALLY to avoid parallel HERE sequencing bursts (429s).
 *
 * @param {Array<{driverId: string, deliveryDate: string}>} pairs - deduped route pairs
 * @param {string} source - audit label for the coordinator
 * @param {object} [ctx] - optional { patients, stores, appUsers } local arrays
 */
export async function optimizeRoutesForMovePairs({ pairs, source, patients, stores, appUsers }) {
  if (!Array.isArray(pairs) || pairs.length === 0) return [];

  const seen = new Set();
  const dedupedPairs = pairs.filter((p) => {
    if (!p?.driverId || !p?.deliveryDate) return false;
    const key = `${String(p.driverId)}|${String(p.deliveryDate)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (dedupedPairs.length === 0) return [];

  // ── Local-first route data: IDB already holds the post-move truth ─────────
  // (the callers' React-state lists may still show the moved stop on its old
  // route; the backend fetch may race the queued server write).
  // Oct 16 2026 (owner rule): read each affected route by the date_driver
  // compound index instead of getAll()-ing the ENTIRE multi-month store.
  const results = [];
  for (const { driverId, deliveryDate } of dedupedPairs) {
    try {
      // Scope the local list to this route so the coordinator's active-stop
      // gate judges THIS route, not the whole day across drivers.
      const { offlineDB } = await import('./offlineDatabase');
      const idbRouteDeliveries = (await offlineDB.getByCompoundIndex(
        offlineDB.STORES.DELIVERIES, 'date_driver', [deliveryDate, driverId]
      ).catch(() => null)) || null;
      const scoped = Array.isArray(idbRouteDeliveries) ? idbRouteDeliveries : null;
      const result = await performRouteOptimization({
        driverId,
        deliveryDate,
        deliveries: scoped,
        patients: patients || (typeof window !== 'undefined' ? window.__appPatients : null),
        stores,
        appUsers,
        source,
        bypassDriverStatus: true,
      });
      results.push({ driverId, deliveryDate, result });
      console.log(`✅ [routeMoveOptimizer] ${source} — route re-optimized: ${driverId} @ ${deliveryDate}`);
    } catch (err) {
      console.warn(`⚠️ [routeMoveOptimizer] ${source} — optimization failed for ${driverId} @ ${deliveryDate}:`, err?.message || err);
      results.push({ driverId, deliveryDate, error: err?.message || String(err) });
    }
  }
  return results;
}

/**
 * Derive the affected (driver, date) route pairs from a bulk-edit apply.
 * Returns [] when nothing in the payload moved a stop between routes.
 *
 * A pair is emitted for the SOURCE route (pre-move driver+date) and the TARGET
 * route (post-move driver+date) of every delivery whose driver, date, or store
 * changed (a store move changes the stop's coordinates/geometry on the same
 * route; transport_mode changes leg geometry the same way).
 */
export const collectRouteMovePairs = (perDeliveryPayloads = []) => {
  const pairs = [];
  const push = (driverId, date) => {
    if (!driverId || !date) return; // unassigned driver targets are skipped
    if (!pairs.some((p) => p.driverId === driverId && p.deliveryDate === date)) {
      pairs.push({ driverId, deliveryDate: date });
    }
  };
  (perDeliveryPayloads || []).forEach(({ delivery, payload }) => {
    if (!delivery || !payload) return;
    const driverMoved =
      payload.driver_id !== undefined &&
      (payload.driver_id ?? null) !== (delivery.driver_id ?? null);
    const dateMoved =
      payload.delivery_date !== undefined &&
      payload.delivery_date !== delivery.delivery_date;
    const storeMoved =
      payload.store_id !== undefined &&
      payload.store_id !== delivery.store_id;
    const modeMoved =
      payload.transport_mode !== undefined &&
      payload.transport_mode !== (delivery.transport_mode ?? 'driving');
    if (!driverMoved && !dateMoved && !storeMoved && !modeMoved) return;
    // SOURCE route (pre-move)
    push(delivery.driver_id, delivery.delivery_date);
    // TARGET route (post-move)
    push(
      payload.driver_id !== undefined ? payload.driver_id : delivery.driver_id,
      payload.delivery_date !== undefined ? payload.delivery_date : delivery.delivery_date
    );
  });
  return pairs;
};
