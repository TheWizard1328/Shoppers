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
import { commitDeliveryUpdatesSilently } from './routeCommitMarker';
import { unlockDeliveryFields } from './completionLockout';

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

const ACTIVE_ONLY = ['pending', 'en_route', 'in_transit'];

/**
 * OWNER RULE (Nov 3 2026): "the isNextDelivery flag was still set for the original
 * first stop before the stop was transferred — we need to remove the isNextDelivery
 * flag for the new date route, then run the optimizer, and reset the flag."
 *
 * The engine pins whatever stop currently owns the flag at position 1, so on the
 * target route that stale owner swallowed the transfer and the moved stop landed
 * last. Sweep every ACTIVE flag on that route (IDB first — the engine reads local —
 * plus ONE silent bulk write so other devices converge), release any per-device
 * field lock that would reject the clear, then let the run re-assign the flag.
 */
async function sweepNextFlags(route) {
  const flagged = (route || []).filter(
    (d) => d && d.isNextDelivery === true && ACTIVE_ONLY.includes(String(d.status || '').toLowerCase()),
  );
  if (flagged.length === 0) return [];
  for (const row of flagged) {
    try { unlockDeliveryFields(row.id); } catch (_) { /* no lock */ }
    try {
      await offlineDB.save(offlineDB.STORES.DELIVERIES, { ...row, isNextDelivery: false });
    } catch (_) { /* IDB best effort */ }
  }
  try {
    await commitDeliveryUpdatesSilently(flagged.map((row) => ({ id: row.id, data: { isNextDelivery: false } })));
  } catch (err) {
    console.warn('[TransferOptimize] next-flag sweep write failed:', err?.message || err);
  }
  return flagged.map((row) => String(row.id));
}

/**
 * After the run exactly ONE active stop must own the flag. The engine normally
 * assigns it, but when a guard or a stale flag-lock ate that write the route can
 * end up with no next stop at all — put it on the first active stop by stop_order.
 */
async function ensureOneNextFlag(route) {
  const active = (route || [])
    .filter((d) => d && ACTIVE_ONLY.includes(String(d.status || '').toLowerCase()))
    .sort((a, b) => (Number(a.stop_order) || 9999) - (Number(b.stop_order) || 9999));
  if (active.length === 0) return null;
  const owners = active.filter((d) => d.isNextDelivery === true);
  if (owners.length === 1) return String(owners[0].id);
  const winner = active[0];
  for (const row of owners) {
    if (String(row.id) === String(winner.id)) continue;
    try {
      await offlineDB.save(offlineDB.STORES.DELIVERIES, { ...row, isNextDelivery: false });
    } catch (_) { /* best effort */ }
  }
  try {
    await offlineDB.save(offlineDB.STORES.DELIVERIES, { ...winner, isNextDelivery: true });
  } catch (_) { /* best effort */ }
  try {
    const updates = owners
      .filter((row) => String(row.id) !== String(winner.id))
      .map((row) => ({ id: row.id, data: { isNextDelivery: false } }));
    updates.push({ id: winner.id, data: { isNextDelivery: true } });
    await commitDeliveryUpdatesSilently(updates);
  } catch (err) {
    console.warn('[TransferOptimize] next-flag reset write failed:', err?.message || err);
  }
  return String(winner.id);
}

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

  // OWNER RULE (Nov 3 2026): clear the stale next-delivery flag on the target
  // route BEFORE optimizing, or the engine pins that stop at position 1 and the
  // transferred stop stays last. The flag is restored right after the run.
  const sweptIds = await sweepNextFlags(localRoute);
  if (sweptIds.length > 0) {
    console.log(`[TransferOptimize] ${source} — swept stale isNextDelivery off ${sweptIds.length} stop(s) before sequencing`);
    localRoute = await readLocalRoute(driverId, deliveryDate);
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
        // Contest mode: with the flags swept, every active stop competes for
        // position 1 instead of a stale owner holding the lock.
        clearNextDeliveryLock: sweptIds.length > 0,
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
      // OWNER RULE (Nov 3 2026): reset the next-delivery flag after the run — the
      // first active stop on the new order owns it, and nobody else does.
      try {
        const resetRoute = await readLocalRoute(driverId, deliveryDate);
        const nextOwner = await ensureOneNextFlag(resetRoute);
        if (nextOwner) console.log(`[TransferOptimize] ${source} — isNextDelivery reset to ${nextOwner}`);
      } catch (err) {
        console.warn('[TransferOptimize] next-flag reset skipped:', err?.message || err);
      }
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

  // The record write went out SILENT (silentServer), so if the run could not
  // sequence the stop the receiving device would learn nothing until its next
  // sync. Fire ONE marker here so it still refreshes exactly once.
  try {
    const fallback = await readLocalStop(deliveryId);
    if (fallback?.id) {
      const { fireRouteCommitMarker } = await import('./routeCommitMarker');
      await fireRouteCommitMarker(fallback.id, 1, [fallback.id]);
      console.log(`[TransferOptimize] ${source} — optimization fell short; fired the single fallback commit marker`);
    }
  } catch (err) {
    console.warn('[TransferOptimize] fallback marker skipped:', err?.message || err);
  }

  return { success: false, placed: placementOf(await readLocalStop(deliveryId)), result };
}

export default optimizeTransferredStopRoute;
