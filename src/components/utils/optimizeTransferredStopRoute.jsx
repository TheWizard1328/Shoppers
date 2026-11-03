/**
 * TRANSFER RE-OPTIMIZATION (owner report Nov 3 2026)
 *
 * A stop moved to another date and/or driver arrived on the new route with the
 * right PUID and start time but as the LAST stop, still drawn on its old leg and
 * wearing the old TR#. Two findings from the owner's future-date test:
 *
 *   1. The old post-save side effect fired performRouteOptimization on a fixed
 *      1000 ms timer. The delivery write is IDB-first with the server write in
 *      the background, and a fetch-only coordinator run either missed the moved
 *      stop or tripped the fresh-commit / fresh-order guards.
 *   2. Even when it ran, the run resolved the route from the SERVER. The engine
 *      therefore sequenced the PRE-transfer snapshot.
 *
 * Fix: run the optimizer with the route read straight from LOCAL IDB (which the
 * transfer write already updated), pass stores + patients so TR# bases resolve,
 * force a full pass and, for a future date, include planned polylines for
 * pending stops. Then verify against IDB and retry once.
 */
import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dayOf = (v) => String(v || '').slice(0, 10);

const IN_HAND = ['in_transit', 'en_route'];

/** Local IDB route rows for a driver + date (written before the server sync). */
async function readLocalRoute(driverId, deliveryDate) {
  try {
    const rows = await offlineDB.getByCompoundIndex('deliveries', 'date_driver', [dayOf(deliveryDate), driverId]);
    return Array.isArray(rows) ? rows.filter(Boolean) : [];
  } catch (_) { return []; }
}

/** Read the moved stop from IDB: only there can we see the engine's own writes first. */
async function readLocalStop(deliveryId) {
  try {
    const row = await offlineDB.getById(offlineDB.STORES.DELIVERIES, deliveryId);
    if (row) return row;
  } catch (_) { /* fall through to the server copy */ }
  try {
    const rows = await base44.entities.Delivery.filter({ id: deliveryId }, undefined, 1, 0);
    return Array.isArray(rows) ? rows[0] : rows;
  } catch (_) { return null; }
}

const placementOf = (row) => (!row ? null : {
  stopOrder: Number(row.stop_order),
  hasPolyline: !!(row.encoded_polyline && String(row.encoded_polyline).length > 10),
  status: String(row.status || '').toLowerCase(),
  track: row.tracking_number || '',
});

/**
 * Place a transferred stop on its new route.
 *
 * @param {object} params
 * @param {string} params.deliveryId
 * @param {string} params.driverId        - target driver
 * @param {string} params.deliveryDate    - target date (YYYY-MM-DD)
 * @param {Array}  [params.stores]        - needed so TR# pickup bases resolve
 * @param {Array}  [params.patients]
 * @param {boolean} [params.recalcTrackingNumbers=true]
 * @param {string} [params.source]
 */
export async function optimizeTransferredStopRoute({
  deliveryId,
  driverId,
  deliveryDate,
  stores = null,
  patients = null,
  recalcTrackingNumbers = true,
  source = 'transferred_stop',
} = {}) {
  if (!driverId || !deliveryDate) return { success: false, error: 'missing target route' };

  const isFuture = dayOf(deliveryDate) > dayOf(new Date().toISOString());

  // The engine reads local data, so give it a beat for the optimistic IDB write.
  let localRoute = await readLocalRoute(driverId, deliveryDate);
  for (let i = 0; i < 6 && !localRoute.some((d) => String(d.id) === String(deliveryId)); i++) {
    await sleep(250);
    localRoute = await readLocalRoute(driverId, deliveryDate);
  }
  if (!localRoute.some((d) => String(d.id) === String(deliveryId))) {
    console.warn(`[TransferOptimize] ${source} — moved stop not in the local ${driverId} / ${deliveryDate} route yet; optimizing the route anyway`);
  }

  const { performRouteOptimization } = await import('./routeOptimizationCoordinator');

  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const route = attempt === 1 ? localRoute : await readLocalRoute(driverId, deliveryDate);
    try {
      result = await performRouteOptimization({
        driverId,
        deliveryDate: dayOf(deliveryDate),
        deliveries: route,
        stores,
        patients,
        bypassDriverStatus: true,
        // A transfer is a deliberate, rare event: always run the full pass rather
        // than risk a guard skipping the very run that would place the stop.
        forceRegenerate: true,
        includePendingPolylines: isFuture,
        recalcTrackingNumbers,
        source: attempt === 1 ? source : `${source}_retry`,
      });
    } catch (err) {
      console.warn(`[TransferOptimize] ${source} attempt ${attempt} threw:`, err?.message || err);
      result = { success: false, error: err?.message || String(err) };
    }

    const placed = placementOf(await readLocalStop(deliveryId));
    const sequenced = !!placed && Number.isFinite(placed.stopOrder) && placed.stopOrder > 0;
    // Pending stops never carry a polyline (owner rule); only require one when the
    // moved stop is actually in hand.
    const drawn = !placed || !IN_HAND.includes(placed.status) || placed.hasPolyline;

    if (result?.success && sequenced && drawn) {
      console.log(`[TransferOptimize] ${source} — placed as stop ${placed.stopOrder}${placed.track ? ` / TR${placed.track}` : ''} on ${dayOf(deliveryDate)}`);
      // Repaint NOW: the optimizer commits silently (bulk + route_commit marker), so
      // nothing else tells the dashboard/map that stop_order and the legs moved. The
      // owner's symptom was a stop that only looked right after a manual refresh.
      try {
        const fresh = await readLocalRoute(driverId, deliveryDate);
        if (fresh.length && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: { immediate: true, preserveLocalState: true, freshDeliveries: fresh, triggeredBy: 'transferredStopPlacement' },
          }));
        }
      } catch (_) { /* cosmetic — the commit already landed */ }
      return { success: true, placed, result };
    }

    console.warn(`[TransferOptimize] ${source} attempt ${attempt} — stop_order=${placed?.stopOrder} polyline=${placed?.hasPolyline} success=${!!result?.success}${result?.error ? ` error=${result.error}` : ''}${result?.skipped ? ` skipped=${result.skipped}` : ''}`);
    if (attempt === 1) await sleep(1500);
  }

  return { success: false, placed: placementOf(await readLocalStop(deliveryId)), result };
}

export default optimizeTransferredStopRoute;
