/**
 * Centralized Stop Order Management
 * Handles sequential stop order calculation for deliveries
 *
 * Sort spec (FROZEN-NUMBER POLICY, Sep 21, 2026):
 *   1. ALL stops (finished + incomplete, interleaved) sort by their EXISTING
 *      stop_order (the route sequence). Finished stops are NEVER re-sorted by
 *      completion time — their number is frozen at the moment they were
 *      numbered/completed. (Previously every repair pass re-sorted finished
 *      stops by actual_delivery_time and renumbered them 1..K; with
 *      out-of-sequence completions or missing/retroactively-adjusted
 *      completion times, finished stops visibly shuffled on every edit.)
 *   2. Stops with NO valid stop_order (legacy/unnumbered) sort last:
 *      unnumbered finished by completion time, then unnumbered incomplete by
 *      ETA with pending last (cycling markers never count as pending).
 *   3. The merged list is compacted to a gap-free 1..N sequence, preserving
 *      relative order — numbers only shift to close gaps (e.g. a deletion).
 *
 * CRITICAL: This function does a SINGLE-PASS resequencing:
 *   1. Sort in memory
 *   2. Write ALL changed records to IDB in ONE bulkSave
 *   3. Dispatch ONE deliveriesUpdated event (single UI re-render)
 *   4. Write ALL changed records to server in parallel (batch silent mode suppresses per-record broadcasts)
 *   5. Register all affected IDs in smartRefreshManager to suppress WS echo re-renders
 *
 * This prevents the 4-5x re-render cascade that occurred when each stop_order
 * was written individually, each triggering a WS broadcast and a separate UI update.
 */

import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { enterBatchSilentMode, exitBatchSilentMode } from './entityMutations';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Parse an ETA string "HH:mm" into minutes from midnight for numeric comparison.
 * Falls back to 9999 (sorts last) if unparseable.
 */
const etaToMinutes = (etaStr) => {
  if (!etaStr || typeof etaStr !== 'string') return 9999;
  const parts = etaStr.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 9999;
  return h * 60 + m;
};

/**
 * Recalculates and updates stop orders for all deliveries for a given driver/date.
 *
 * ALL stops keep their EXISTING stop_order as the primary sort key (route
 * sequence — so polylines stay coherent AND finished stops never get
 * renumbered). Completion time only orders unnumbered finished stops; ETA
 * only orders unnumbered incomplete stops (pending last). Cycling markers
 * follow the same rules as regular stops.
 * Updates all stop orders sequentially from 1 to N.
 *
 * SINGLE-PASS: one IDB write, one UI event, one batched server write.
 *
 * @param {string} driverId
 * @param {string} deliveryDate
 * @param {boolean} skipPolylineRegeneration - legacy, unused (polylines handled by optimizationDebouncer)
 * @param {boolean} skipPolylineIfNoOrderChange - legacy, unused
 * @returns {Promise<{sortedDeliveries: Array, orderChanged: boolean}>}
 */
export const recalculateAndUpdateStopOrders = async (driverId, deliveryDate, skipPolylineRegeneration = false, skipPolylineIfNoOrderChange = false) => {
  // ── STEP 1: Read all route deliveries from IDB ──────────────────────────────
  const driverDeliveries = await (async () => {
    try {
      const all = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      return (all || []).filter(d => d?.driver_id === driverId && d?.delivery_date === deliveryDate);
    } catch (err) {
      console.warn('[StopOrderManager] Offline DB read failed:', err?.message || err);
      return [];
    }
  })();

  if (!driverDeliveries.length) {
    return { sortedDeliveries: [], orderChanged: false };
  }

  // ── STEP 2: Sort in memory ──────────────────────────────────────────────────

  const getCompletionTime = (d) => {
    if (!d) return Number.MAX_SAFE_INTEGER;
    if (d.actual_delivery_time) {
      const t = new Date(d.actual_delivery_time).getTime();
      if (Number.isFinite(t)) return t;
    }
    const fallback = d.arrival_time || d.updated_date || d.created_date;
    if (fallback) {
      const t = new Date(fallback).getTime();
      if (Number.isFinite(t)) return t;
    }
    return Number.MAX_SAFE_INTEGER;
  };

  // Creation time — final tie-break for unnumbered stops (stable, insertion order).
  const getCreationTime = (d) => {
    if (!d) return Number.MAX_SAFE_INTEGER;
    const t = new Date(d.created_date).getTime();
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  };

  const getExistingOrder = (d) => {
    const n = Number(d?.stop_order);
    return Number.isFinite(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
  };

  // ── FROZEN-NUMBER POLICY (Sep 21, 2026) ─────────────────────────────────────
  // Finished and incomplete stops are sorted TOGETHER by their EXISTING
  // stop_order (the route sequence). This extends the Sep 16 gap-compaction
  // fix to FINISHED stops:
  //
  // The old code sorted finished stops by actual_delivery_time and renumbered
  // them 1..K on EVERY repair pass (after any edit/delete/create/optimization).
  // Two things made that destructive:
  //   1. Out-of-sequence completions (deviation, retry) renumbered finished
  //      stops away from their route positions — "finished stop numbers change".
  //   2. getCompletionTime falls back to arrival_time || updated_date ||
  //      created_date when actual_delivery_time is missing — and updated_date
  //      bumps on ANY touch (COD sync, note edit, admin edit, retroactive
  //      timing recalculation), so finished stops could silently reshuffle.
  //
  // Leg polylines (encoded_polyline) are generated for the route sequence, so
  // preserving everyone's existing number also keeps legs coherent — including
  // for the completed segment of the route drawn by PolylineViewer /
  // DeliveryMap, which sort finished legs by stop_order.
  //
  // isNextDelivery is NOT pinned to a position anymore: setNextDeliveryFlag is
  // the sole authority for the flag (standing instruction), and the optimizer
  // keeps flag + order in sync. The flag marks the stop the driver is heading
  // to; the number marks its route position. They no longer fight.
  //
  // Renumbering below is GAP COMPACTION ONLY: the merged order is preserved
  // exactly; numbers only shift to close gaps (e.g. after a deletion).
  const isFinished = (d) => FINISHED_STATUSES.includes(d?.status);

  const ordered = [...driverDeliveries].sort((a, b) => {
    const aOrder = getExistingOrder(a);
    const bOrder = getExistingOrder(b);

    // Primary: existing route number — finished and incomplete interleaved.
    if (aOrder !== bOrder) return aOrder - bOrder;

    // Both numbered with the SAME value (duplicate order — data corruption
    // or a race): keep it stable — finished first, then creation time.
    if (aOrder !== Number.MAX_SAFE_INTEGER) {
      const aFin = isFinished(a);
      const bFin = isFinished(b);
      if (aFin !== bFin) return aFin ? -1 : 1;
      return getCreationTime(a) - getCreationTime(b);
    }

    // Both UNNUMBERED: finished stops first (by completion time — they are
    // historical and cannot inherit a route position), then incomplete stops
    // (pending last, then ETA, then creation time — same as the Sep 16 rule).
    const aFin = isFinished(a);
    const bFin = isFinished(b);
    if (aFin !== bFin) return aFin ? -1 : 1;
    if (aFin) return getCompletionTime(a) - getCompletionTime(b);

    // Cycling markers are never treated as pending (same as display sort).
    const aPending = a?.status === 'pending' && !a?.is_cycling_marker;
    const bPending = b?.status === 'pending' && !b?.is_cycling_marker;
    if (aPending !== bPending) return aPending ? 1 : -1;

    const aEta = etaToMinutes(a?.delivery_time_eta || a?.delivery_time_start);
    const bEta = etaToMinutes(b?.delivery_time_eta || b?.delivery_time_start);
    if (aEta !== bEta) return aEta - bEta;
    return getCreationTime(a) - getCreationTime(b);
  });

  // ── STEP 3: Assign sequential stop_order 1..N, collect only changed records ──
  const changedRecords = [];
  const changedIds = [];

  for (let i = 0; i < ordered.length; i++) {
    const delivery = ordered[i];
    if (!delivery?.id) continue;
    const newStopOrder = i + 1;
    const currentStopOrder = Number(delivery.stop_order);
    if (currentStopOrder !== newStopOrder) {
      changedRecords.push({ ...delivery, stop_order: newStopOrder });
      changedIds.push(delivery.id);
    }
  }

  if (changedRecords.length === 0) {
    // Nothing changed — still dispatch routeReordered for consumers that need it
    try {
      window.dispatchEvent(new CustomEvent('routeReordered', {
        detail: { driverId, deliveryDate, suppressFabIfPhase1: true }
      }));
    } catch (_) {}
    return { sortedDeliveries: ordered, orderChanged: false };
  }

  console.log(`[StopOrderManager] Single-pass resequencing: ${changedRecords.length} stop(s) changed | driver=${driverId} | date=${deliveryDate}`);

  // ── STEP 4: Write ALL changed records to IDB in ONE bulkSave ─────────────────
  await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, changedRecords);

  // ── STEP 5: Register all affected IDs in smartRefreshManager to suppress WS echo ──
  // This prevents incoming WebSocket broadcasts (from our own server writes) from
  // triggering per-record UI re-renders. The local state is already authoritative.
  try {
    const { smartRefreshManager } = await import('./smartRefreshManager');
    for (const id of changedIds) {
      smartRefreshManager.registerPendingUpdate(id, driverId, deliveryDate);
    }
  } catch (_) {}

  // ── STEP 6: Dispatch ONE deliveriesUpdated event with all fresh data (single UI re-render) ──
  // Send ALL ordered records (not just changedRecords) so consumers can immediately re-sort
  // without waiting for React state propagation through Layout → AppDataContext → Dashboard.
  try {
    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: {
        triggeredBy: 'stopOrderRecalc',
        driverId,
        deliveryDate,
        freshDeliveries: ordered,   // full sorted list — Layout merges by id, preserving all fields
        preserveLocalState: true
      }
    }));
  } catch (_) {}

  // ── STEP 7: Dispatch ONE routeReordered event ──────────────────────────────
  try {
    window.dispatchEvent(new CustomEvent('routeReordered', {
      detail: { driverId, deliveryDate, suppressFabIfPhase1: true }
    }));
  } catch (_) {}

  // ── STEP 8: Write ALL changed records to server in parallel (batch silent mode) ──
  // enterBatchSilentMode suppresses per-record notifyMutation + broadcastMutation,
  // so each server write does NOT trigger a separate UI update or WS broadcast.
  // The server's own WS broadcasts are suppressed by smartRefreshManager registration above.
  enterBatchSilentMode();
  try {
    await Promise.allSettled(
      changedRecords.map((rec) =>
        base44.entities.Delivery.update(rec.id, { stop_order: rec.stop_order }).catch((err) => {
          console.warn(`[StopOrderManager] Server write failed for ${rec.id}:`, err?.message || err);
        })
      )
    );
  } finally {
    exitBatchSilentMode();
  }

  return { sortedDeliveries: ordered, orderChanged: true };
};

/**
 * Updates isNextDelivery flags for a driver/date.
 * Sets the first non-completed, non-pending delivery as the next delivery.
 *
 * NOTE: This is the legacy client-side path. The backend `setNextDeliveryFlag`
 * function is the authoritative source. This function is kept for backward
 * compatibility but should rarely be called directly.
 */
export const updateNextDeliveryFlags = async (driverId, deliveryDate) => {
  const allDeliveries = await base44.entities.Delivery.filter({
    driver_id: driverId,
    delivery_date: deliveryDate
  }, 'stop_order');

  // Reset all flags
  const resetPromises = allDeliveries
    .filter((d) => d.isNextDelivery)
    .map((d) => base44.entities.Delivery.update(d.id, { isNextDelivery: false }));
  if (resetPromises.length > 0) {
    await Promise.all(resetPromises);
  }

  // Find first incomplete (SKIP PENDING)
  const firstIncomplete = allDeliveries
    .filter((d) => !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending')
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];

  if (firstIncomplete) {
    await base44.entities.Delivery.update(firstIncomplete.id, { isNextDelivery: true });
  }
};