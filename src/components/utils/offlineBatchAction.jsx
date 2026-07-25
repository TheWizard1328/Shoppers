/**
 * offlineBatchAction.jsx
 *
 * Unified offline-first batch action wrapper for all "Add to Route" operations:
 *   1. Staged → Pending (Done button)
 *   2. InterStore stops (ISP / ISD)
 *   3. Manual pickups (+ Add Pickup)
 *   4. Cycling markers (+ Add Marker)
 *
 * Execution order guaranteed for every action:
 *   1. Pause ALL background syncs (SmartRefresh, BackgroundSync, Realtime, Mutations)
 *   2. Run the caller's `work` function — processes data locally, saves to offlineDB only
 *   3. (Options 2/3/4) Run client-side route optimizer against fresh local data
 *   4. Apply resulting records to local UI state immediately
 *   5. Create NEW (temp) records on the backend with ALL optimizer data (polylines, stop_order, etc.)
 *   6. Broadcast affected delivery IDs to all subscribers
 *   7. Resume ALL background syncs
 */

import { offlineDB } from './offlineDatabase';
import { enterBatchSilentMode, exitBatchSilentMode } from './entityMutations';

// ── Sync pause/resume helpers ─────────────────────────────────────────────────

const pauseAllSyncs = async () => {
  try {
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.pause();
  } catch { /* non-fatal */ }

  try {
    const { backgroundSyncManager } = await import('./backgroundSyncManager');
    backgroundSyncManager.pause();
  } catch { /* non-fatal */ }

  try {
    const { pauseRealtimeSync } = await import('./realtimeSync');
    pauseRealtimeSync();
  } catch { /* non-fatal */ }

  enterBatchSilentMode();

  console.log('⏸️ [OfflineBatch] All syncs paused');
};

const resumeAllSyncs = async () => {
  try {
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.restart();
  } catch { /* non-fatal */ }

  try {
    const { backgroundSyncManager } = await import('./backgroundSyncManager');
    backgroundSyncManager.resume();
  } catch { /* non-fatal */ }

  try {
    const { resumeRealtimeSync } = await import('./realtimeSync');
    resumeRealtimeSync();
  } catch { /* non-fatal */ }

  exitBatchSilentMode();

  console.log('▶️ [OfflineBatch] All syncs resumed');
};

// ── Create temp records on the backend with optimizer data ───────────────────
// Only called for records with temp IDs (not yet on the backend).
// The optimizer's writeBatch already wrote all REAL-id updates via bulkUpdateDeliveries.

const flushToOnlineDB = async (records) => {
  if (!records || records.length === 0) return [];

  const toCreate = records.filter((r) => !r.id || r.id.startsWith('temp_'));
  const toUpdate = records.filter((r) => r.id && !r.id.startsWith('temp_'));

  const { base44 } = await import('@/api/base44Client');

  // Creates — one at a time to preserve order and PUID linkage.
  // CRITICAL: `records` here are the OPTIMIZED versions (from freshDeliveries) which
  // include stop_order, isNextDelivery, encoded_polyline, transport_mode, delivery_time_eta,
  // estimated_distance_km, estimated_duration_minutes — all assigned by the optimizer.
  // By passing the full payload to Delivery.create(), the real backend record is born
  // complete with polylines and ordering. No separate patch needed.
  const createdRecords = [];
  for (const record of toCreate) {
    try {
      const { id: _tempId, _isLocal, created_date, updated_date, ...payload } = record;
      const created = await base44.entities.Delivery.create(payload);
      createdRecords.push(created);

      if (created?.id) {
        if (!window.__localDeliveryWrites) window.__localDeliveryWrites = new Map();
        window.__localDeliveryWrites.set(created.id, Date.now());
      }

      // Replace temp with real in offline DB
      const db = await offlineDB.openDatabase();
      const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
      await new Promise((resolve, reject) => {
        const req = tx.objectStore(offlineDB.STORES.DELIVERIES).delete(_tempId);
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
      });
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [created]);

      if (typeof window !== 'undefined' && Array.isArray(window.__appDeliveries)) {
        window.__appDeliveries = window.__appDeliveries.map(d =>
          d?.id === _tempId ? { ...created } : d
        );
      }
    } catch (err) {
      console.warn('[OfflineBatch] Create failed, will retry via pending mutations:', err.message);
      await offlineDB.addPendingMutation({
        operation: 'create',
        entity: 'Delivery',
        recordId: record.id,
        payload: record,
      }).catch(() => {});
    }
  }

  // Updates — chunked (for edge cases where non-temp records need updating)
  const CHUNK = 10;
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const chunk = toUpdate.slice(i, i + CHUNK);
    await Promise.allSettled(
      chunk.map(async (record) => {
        const { id, _isLocal, created_date, ...payload } = record;
        try {
          const updated = await base44.entities.Delivery.update(id, payload);
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updated]);
        } catch (err) {
          console.warn(`[OfflineBatch] Update failed for ${id}:`, err.message);
          await offlineDB.addPendingMutation({
            operation: 'update',
            entity: 'Delivery',
            recordId: id,
            payload,
          }).catch(() => {});
        }
      })
    );
  }

  return [...createdRecords, ...toUpdate];
};

// ── Broadcast affected IDs ────────────────────────────────────────────────────

const broadcastAffectedDeliveries = (affectedIds, driverId, deliveryDate, actionName) => {
  if (!affectedIds || affectedIds.length === 0) return;

  window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
    detail: {
      deliveryDate,
      driverId,
      triggeredBy: actionName,
      affectedIds,
      immediate: true,
    },
  }));

  window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

  import('./fabControlEvents')
    .then(({ fabControlEvents }) => {
      fabControlEvents.notifyDataReady();
      fabControlEvents.notifyDoneButtonClicked();
    })
    .catch(() => {});
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * executeOfflineBatchAction
 *
 * @param {Object}   params
 * @param {string}   params.actionName          - Label for logging (e.g. 'AddPickup')
 * @param {Function} params.work                - async fn() → { records: Delivery[], driverId, deliveryDate }
 * @param {boolean}  [params.runOptimizer=false] - true for ISP/ISD, Pickup, Cycling
 * @param {Object}   [params.optimizerContext]   - { deliveries, patients, stores, appUsers }
 *                                                  Pass null for deliveries to let coordinator fetch from backend.
 *                                                  NEVER pass [] — empty array = "no stops exist".
 * @param {Function} [params.applyLocalUI]       - fn(records) — update React state immediately
 * @returns {Promise<{success: boolean, records?: Delivery[], error?: string}>}
 */
export async function executeOfflineBatchAction({
  actionName,
  work,
  runOptimizer = false,
  optimizerContext = null,
  applyLocalUI = null,
}) {
  console.log(`🚀 [OfflineBatch] Starting "${actionName}"`);

  await pauseAllSyncs();

  try {
    // ── Step 1: Execute caller's work (local DB saves, record construction) ──
    const workResult = await work();
    const { records = [], driverId, deliveryDate } = workResult || {};

    if (!records || records.length === 0) {
      console.log(`[OfflineBatch] "${actionName}" — no records to process`);
      return { success: true, records: [] };
    }

    // ── Step 2: Save all records to offlineDB immediately ─────────────────────
    const validRecords = records.filter(Boolean);
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, validRecords).catch(() => {});

    // Track which temp IDs we started with (for matching after backend creation)
    const tempOriginalIds = new Set(validRecords.filter(r => !r.id || r.id.startsWith('temp_')).map(r => r.id));

    // ── Step 3: Client-side route optimization ────────────────────────────────
    let optimizedRecords = validRecords;

    if (runOptimizer && driverId && deliveryDate && optimizerContext) {
      try {
        const { performRouteOptimization } = await import('./routeOptimizationCoordinator');

        const existingDeliveries = optimizerContext.deliveries != null
          ? optimizerContext.deliveries
          : null;

        let mergedDeliveries = existingDeliveries;
        if (Array.isArray(existingDeliveries)) {
          const newRecordIds = new Set(validRecords.map((r) => r.id));
          mergedDeliveries = [
            ...existingDeliveries.filter((d) => d && !newRecordIds.has(d.id)),
            ...validRecords,
          ];
        }

        const optimizeResult = await performRouteOptimization({
          driverId,
          deliveryDate,
          deliveries: mergedDeliveries,
          patients: optimizerContext.patients || null,
          stores: optimizerContext.stores || null,
          appUsers: optimizerContext.appUsers || null,
          source: actionName,
          skipPolyline: false,
        });

        if (optimizeResult?.success && optimizeResult.freshDeliveries?.length > 0) {
          optimizedRecords = optimizeResult.freshDeliveries;
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, optimizedRecords).catch(() => {});
          console.log(`[OfflineBatch] "${actionName}" — optimizer succeeded: ${optimizedRecords.length} stops`);
        } else {
          console.warn(`[OfflineBatch] "${actionName}" — optimizer did not succeed, using pre-optimize records`);
        }
      } catch (optErr) {
        console.warn(`[OfflineBatch] "${actionName}" — optimizer error (non-fatal):`, optErr.message);
      }
    }

    // ── Step 4: Update local UI immediately (before online write) ─────────────
    if (applyLocalUI) {
      try {
        applyLocalUI(optimizedRecords);
      } catch (uiErr) {
        console.warn(`[OfflineBatch] "${actionName}" — applyLocalUI error:`, uiErr.message);
      }
    }

    // ── Step 5: Create NEW records on the backend ─────────────────────────────
    // CRITICAL: Flush the OPTIMIZED version of temp records, not the originals.
    //
    // The optimizer assigns stop_order, isNextDelivery, encoded_polyline, transport_mode,
    // delivery_time_eta, estimated_distance_km, estimated_duration_minutes to each stop.
    // These are applied to `optimizedRecords` (from freshDeliveries). If we flush the
    // original `validRecords` (pre-optimizer), the real backend record is created WITHOUT
    // any of this data — and when the temp record is replaced on refresh, the polylines
    // and stop_order vanish because they only existed on the temp ID in IDB.
    //
    // By flushing the optimized version, Delivery.create() receives the full payload
    // including polylines and ordering — so the real record is born complete. No
    // separate patch/update needed afterwards.
    //
    // The optimizer's writeBatch already wrote all REAL-id updates to the backend via
    // bulkUpdateDeliveries. We only need to CREATE the temp records that don't exist yet.
    const optimizedTempRecords = optimizedRecords.filter(r => tempOriginalIds.has(r.id));
    const recordsToFlush = optimizedTempRecords.length > 0
      ? optimizedTempRecords
      : validRecords.filter(r => !r.id || r.id.startsWith('temp_'));

    const finalRecords = recordsToFlush.length > 0
      ? await flushToOnlineDB(recordsToFlush)
      : [];

    // ── Step 5b: Merge real IDs back into the result set ──────────────────────
    // After flushToOnlineDB creates the real records, replace temp IDs in our result
    // with the real backend records. Match by stop_id (unique per delivery).
    let allFinal = optimizedRecords;
    if (finalRecords.length > 0) {
      const tempIdSet = new Set(recordsToFlush.map(r => r.id));
      const realByStopId = new Map(finalRecords.map(r => [r.stop_id, r]));
      const realByDeliveryId = new Map(finalRecords.map(r => [r.delivery_id, r]));
      allFinal = optimizedRecords.map(r => {
        if (tempIdSet.has(r.id)) {
          const real = (r.stop_id && realByStopId.get(r.stop_id))
            || (r.delivery_id && realByDeliveryId.get(r.delivery_id))
            || null;
          if (real) {
            // Merge optimizer data onto the real record so UI sees complete state with real ID.
            // This preserves polylines, stop_order, isNextDelivery, etc. from the optimizer
            // while using the real backend ID.
            return {
              ...real,
              stop_order: r.stop_order ?? real.stop_order,
              isNextDelivery: r.isNextDelivery ?? real.isNextDelivery,
              encoded_polyline: r.encoded_polyline ?? real.encoded_polyline,
              transport_mode: r.transport_mode ?? real.transport_mode,
              delivery_time_eta: r.delivery_time_eta ?? real.delivery_time_eta,
              estimated_distance_km: r.estimated_distance_km ?? real.estimated_distance_km,
              estimated_duration_minutes: r.estimated_duration_minutes ?? real.estimated_duration_minutes,
              travel_dist: r.travel_dist ?? real.travel_dist,
            };
          }
        }
        return r;
      });

      // Persist the merged real+optimized records to IDB so next read returns complete data
      const mergedForDB = allFinal.filter(r => r.id && !r.id.startsWith('temp_'));
      if (mergedForDB.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, mergedForDB).catch(() => {});
      }
    }

    // ── Step 6: Broadcast affected delivery IDs ───────────────────────────────
    const affectedIds = allFinal
      .map((r) => r?.id)
      .filter((id) => id && !id.startsWith('temp_'));
    broadcastAffectedDeliveries(affectedIds, driverId, deliveryDate, actionName);

    console.log(`✅ [OfflineBatch] "${actionName}" complete — ${affectedIds.length} deliveries, ${finalRecords.length} new records created`);
    return { success: true, records: allFinal };
  } catch (err) {
    console.error(`❌ [OfflineBatch] "${actionName}" failed:`, err);
    return { success: false, error: err.message };
  } finally {
    // ── Step 7: Always resume syncs ───────────────────────────────────────────
    await resumeAllSyncs();
  }
}
