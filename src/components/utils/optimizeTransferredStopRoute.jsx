/**
 * TRANSFER RE-OPTIMIZATION (owner report Nov 3 2026)
 *
 * A stop moved to another date and/or driver used to arrive on the new route with
 * the right PUID and start time but as the LAST stop, wearing the previous route's
 * leg — the new route never re-ran. Root cause: the old post-save side effect fired
 * performRouteOptimization on a 500/1000 ms timer, while the delivery write is IDB
 * first and only reaches the server in the background. The optimizer reads the
 * route from the SERVER, so it either did not see the moved stop at all (nothing to
 * sequence) or hit the coordinator's fresh-order / recent-commit skips.
 *
 * This helper makes the transfer run deterministic:
 *   1. Wait until the moved delivery is visible server-side on the TARGET route.
 *   2. Run the optimizer with recalcTrackingNumbers so stop_order and TR# land
 *      together (TR# must read in step with the new day's route).
 *   3. Verify the moved stop actually got a stop_order and a leg polyline; retry
 *      once when it did not (a skip or a stale fetch can leave it untouched).
 */
import { base44 } from '@/api/base44Client';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dayOf = (v) => String(v || '').slice(0, 10);

const matchesRoute = (row, driverId, deliveryDate) =>
  !!row &&
  String(row.driver_id || '') === String(driverId || '') &&
  dayOf(row.delivery_date) === dayOf(deliveryDate);

/** Poll the server until the moved delivery sits on the target route. */
async function waitForTargetRoute(deliveryId, driverId, deliveryDate, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 350;
  while (Date.now() < deadline) {
    try {
      const rows = await base44.entities.Delivery.filter({ id: deliveryId }, undefined, 1, 0);
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (matchesRoute(row, driverId, deliveryDate)) return true;
    } catch (_) { /* transient — keep polling */ }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.6), 2000);
  }
  return false;
}

/** Read the moved stop's own record to confirm it was sequenced + drawn. */
async function readPlacedStop(deliveryId) {
  try {
    const rows = await base44.entities.Delivery.filter({ id: deliveryId }, undefined, 1, 0);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return null;
    return {
      stopOrder: Number(row.stop_order),
      hasPolyline: !!row.encoded_polyline,
      status: row.status,
      track: row.tracking_number || '',
    };
  } catch (_) { return null; }
}

/**
 * Optimize the target route of a transferred stop.
 *
 * @param {object}  params
 * @param {string}  params.deliveryId     - the transferred delivery
 * @param {string}  params.driverId       - target driver
 * @param {string}  params.deliveryDate   - target date (YYYY-MM-DD)
 * @param {boolean} [params.recalcTrackingNumbers=true] - renumber TR# with stop_order
 * @param {string}  [params.source]       - log/source tag
 */
export async function optimizeTransferredStopRoute({
  deliveryId,
  driverId,
  deliveryDate,
  recalcTrackingNumbers = true,
  source = 'transferred_stop',
} = {}) {
  if (!driverId || !deliveryDate) return { success: false, error: 'missing target route' };

  const visible = await waitForTargetRoute(deliveryId, driverId, deliveryDate);
  if (!visible) {
    console.warn(`[TransferOptimize] ${source} — moved stop not visible on ${driverId} / ${deliveryDate} after 9s; optimizing anyway so the route still refreshes`);
  }

  const { performRouteOptimization } = await import('./routeOptimizationCoordinator');

  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await performRouteOptimization({
        driverId,
        deliveryDate,
        bypassDriverStatus: true,
        source: attempt === 1 ? source : `${source}_retry`,
        recalcTrackingNumbers,
      });
    } catch (err) {
      console.warn(`[TransferOptimize] ${source} attempt ${attempt} threw:`, err?.message || err);
      result = { success: false, error: err?.message || String(err) };
    }

    if (result?.success && !result?.skipped) {
      const placed = await readPlacedStop(deliveryId);
      // A pending stop never receives a polyline (owner rule), so only require one
      // when the moved stop is in hand/active.
      const needsPolyline = placed && ['in_transit', 'en_route'].includes(String(placed.status || '').toLowerCase());
      const sequenced = !!placed && Number.isFinite(placed.stopOrder);
      const drawn = !needsPolyline || placed?.hasPolyline;
      if (sequenced && drawn) {
        console.log(`[TransferOptimize] ${source} — placed as stop ${placed.stopOrder}${placed.track ? ` / TR${placed.track}` : ''} on ${deliveryDate}`);
        return { success: true, placed, result };
      }
      console.warn(`[TransferOptimize] ${source} attempt ${attempt} — moved stop still unsequenced (stop_order=${placed?.stopOrder}, polyline=${placed?.hasPolyline}); retrying`);
    }

    if (attempt === 1) await sleep(1500);
  }

  return { success: false, placed: await readPlacedStop(deliveryId), result };
}

export default optimizeTransferredStopRoute;
