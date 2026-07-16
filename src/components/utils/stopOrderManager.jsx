/**
 * Centralized Stop Order Management
 * Handles sequential stop order calculation for deliveries
 *
 * Sort spec:
 *   1. Finished stops (completed/failed/cancelled/returned) first, sorted by
 *      actual_delivery_time ASC. Cycling markers follow the same rule.
 *   2. Incomplete stops sorted by their ETA (delivery_time_eta) ASC, with
 *      pending last. If no ETA, falls back to existing stop_order.
 *   3. ALL stops (finished + incomplete) receive a fresh sequential stop_order 1..N.
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

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

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
 * Finished stops sort by actual_delivery_time; incomplete by ETA (delivery_time_eta),
 * falling back to existing stop_order when ETA is absent. Pending stops sort last.
 * Cycling markers follow the same rules as regular stops.
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

  const getExistingOrder = (d) => {
    const n = Number(d?.stop_order);
    return Number.isFinite(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
  };

  // Partition
  const finishedDeliveries   = driverDeliveries.filter(d => FINISHED_STATUSES.includes(d?.status));
  const incompleteDeliveries = driverDeliveries.filter(d => !FINISHED_STATUSES.includes(d?.status));

  // Sort finished by actual_delivery_time (cycling markers treated equally)
  const sortedFinished = [...finishedDeliveries].sort((a, b) => getCompletionTime(a) - getCompletionTime(b));

  // Sort incomplete: isNextDelivery first, then by ETA (delivery_time_eta), then by existing stop_order, pending last
  const nextDeliveryId = incompleteDeliveries.find(
    d => d?.isNextDelivery && d?.status !== 'pending'
  )?.id || null;

  const sortedIncomplete = [...incompleteDeliveries].sort((a, b) => {
    // "next delivery" always first among incomplete
    const aNext = nextDeliveryId && a?.id === nextDeliveryId;
    const bNext = nextDeliveryId && b?.id === nextDeliveryId;
    if (aNext && !bNext) return -1;
    if (!aNext && bNext) return 1;

    // Pending last (but cycling markers are never pending in practice)
    const aPending = a?.status === 'pending' && !a?.is_cycling_marker;
    const bPending = b?.status === 'pending' && !b?.is_cycling_marker;
    if (aPending && !bPending) return 1;
    if (!aPending && bPending) return -1;

    // Both pending or both non-pending: sort by ETA first, then existing stop_order
    const aEta = etaToMinutes(a?.delivery_time_eta || a?.delivery_time_start);
    const bEta = etaToMinutes(b?.delivery_time_eta || b?.delivery_time_start);
    if (aEta !== bEta) return aEta - bEta;

    return getExistingOrder(a) - getExistingOrder(b);
  });

  // Merge: finished first, then incomplete
  const ordered = [...sortedFinished, ...sortedIncomplete];

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
  try {
    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: {
        triggeredBy: 'stopOrderRecalc',
        driverId,
        deliveryDate,
        freshDeliveries: changedRecords,
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
