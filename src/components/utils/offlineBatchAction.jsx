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
 *   5. Batch-write finalized NEW records to the online DB (updates already written by optimizer)
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

// ── Batch write finalized records to the online DB ────────────────────────────
// IMPORTANT: Only call this for records that are still temp (not yet persisted by the optimizer).
// The optimizer's writeBatch already updated existing real-id records via bulkUpdateDeliveries.

const flushToOnlineDB = async (records) => {
  if (!records || records.length === 0) return [];

  // Separate creates (no real id yet / temp id) from updates (have a live id)
  const toCreate = records.filter((r) => !r.id || r.id.startsWith('temp_'));
  const toUpdate = records.filter((r) => r.id && !r.id.startsWith('temp_'));

  const { base44 } = await import('@/api/base44Client');

  // Creates — one at a time to preserve order and PUID linkage
  const createdRecords = [];
  for (const record of toCreate) {
    try {
      const { id: _tempId, _isLocal, created_date, updated_date, ...payload } = record;
      const created = await base44.entities.Delivery.create(payload);
      createdRecords.push(created);

      // CRITICAL: Mark this newly created delivery ID as a local write so the WS echo
      // is suppressed. Without this, the echo arrives as a 'create' event and adds a
      // duplicate to React state (since applyLocalUI already rendered the temp record).
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

      // Swap the temp ID for the real ID in window.__appDeliveries so the duplicate
      // guard in the WS handler matches correctly if the echo slips through.
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

  // Updates — chunked to avoid rate-limiting
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
 *                                                  `records` are the fully-built delivery objects to persist.
 * @param {boolean}  [params.runOptimizer=false] - true for Options 2/3/4 (ISP/ISD, Pickup, Cycling)
 * @param {Object}   [params.optimizerContext]   - { deliveries, patients, stores, appUsers } — current local state.
 *                                                  Pass null for deliveries to let coordinator fetch from backend.
 *                                                  NEVER pass [] — an empty array is treated as "no stops exist".
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

    // ── Step 3: (Options 2/3/4) Client-side route optimization ────────────────
    let optimizedRecords = validRecords;
    // Track whether the optimizer committed the new temp records (by including them in writeBatch)
    // so we don't create them again in Step 5.
    let optimizerHandledNewRecords = false;

    if (runOptimizer && driverId && deliveryDate && optimizerContext) {
      try {
        const { performRouteOptimization } = await import('./routeOptimizationCoordinator');

        // CRITICAL: Read the full current route from offlineDB so the optimizer sees all
        // existing stops. The caller must never pass deliveries:[] — that signals "empty route"
        // and causes the optimizer to generate a route from scratch, ignoring existing stops.
        // If the caller doesn't provide deliveries (null), the coordinator fetches from the
        // backend. Either way, merge the new temp record(s) in so they participate in ordering.
        const existingDeliveries = optimizerContext.deliveries != null
          ? optimizerContext.deliveries
          : null; // null → coordinator will fetch from backend

        let mergedDeliveries = existingDeliveries;
        if (Array.isArray(existingDeliveries)) {
          const newRecordIds = new Set(validRecords.map((r) => r.id));
          mergedDeliveries = [
            ...existingDeliveries.filter((d) => d && !newRecordIds.has(d.id)),
            ...validRecords,
          ];
        }
        // If existingDeliveries is null, pass null so coordinator fetches backend data,
        // then we inject new records via the merging that happens inside the coordinator.
        // But since the backend won't have the temp record yet, we pass the merged list
        // from the IDB snapshot instead if available.

        const optimizeResult = await performRouteOptimization({
          driverId,
          deliveryDate,
          deliveries: mergedDeliveries, // null → backend fetch; array → local data
          patients: optimizerContext.patients || null,
          stores: optimizerContext.stores || null,
          appUsers: optimizerContext.appUsers || null,
          source: actionName,
          skipPolyline: false,
        });

        if (optimizeResult?.success && optimizeResult.freshDeliveries?.length > 0) {
          optimizedRecords = optimizeResult.freshDeliveries;
          // Persist optimized order back to offline DB
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, optimizedRecords).catch(() => {});
          console.log(`[OfflineBatch] "${actionName}" — optimizer succeeded: ${optimizedRecords.length} stops`);

          // If the optimizer's writeBatch included the new temp record(s) by temp ID,
          // the coordinator already wrote them to the backend. Mark that so Step 5
          // doesn't create duplicates.
          // NOTE: The optimizer can only write records with real IDs — temp records are
          // never in the writeBatch (they have no real ID yet). So optimizerHandledNewRecords
          // remains false and Step 5 will correctly create the new records.
          optimizerHandledNewRecords = false;
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

    // ── Step 5: Batch write NEW records to online DB ───────────────────────────
    // CRITICAL: Only flush records that are still temp (id starts with 'temp_').
    // The optimizer's writeBatch already persisted all real-id updates to the backend
    // via bulkUpdateDeliveries. Flushing real-id records here would double-write them.
    const recordsToFlush = optimizerHandledNewRecords
      ? [] // optimizer already wrote everything
      : validRecords.filter((r) => !r.id || r.id.startsWith('temp_'));

    const finalRecords = recordsToFlush.length > 0
      ? await flushToOnlineDB(recordsToFlush)
      : [];

    // If we created new records, apply their real IDs to the optimized UI records
    // so callers get back the canonical backend record (not the temp).
    let allFinal = optimizedRecords;
    if (finalRecords.length > 0) {
      // For each newly created record, find its temp counterpart in optimizedRecords
      // (by matching payload fields like delivery_id or stop_id) and swap it in.
      const tempIdSet = new Set(recordsToFlush.map(r => r.id));
      const realByStopId = new Map(finalRecords.map(r => [r.stop_id, r]));
      allFinal = optimizedRecords.map(r => {
        if (tempIdSet.has(r.id) && r.stop_id && realByStopId.has(r.stop_id)) {
          return realByStopId.get(r.stop_id);
        }
        return r;
      });
      // Also apply the real record's stop_order/isNextDelivery back into the new record
      // so the UI shows the optimized state from the moment of creation.
      for (const realRecord of finalRecords) {
        const tempMatch = recordsToFlush.find(t => t.stop_id === realRecord.stop_id);
        if (tempMatch) {
          // The optimizer assigned stop_order/isNextDelivery to the temp ID in optimizedRecords.
          // Find that assignment and apply it to the real backend record.
          const optimizerVersion = (optimizedRecords || []).find(r => r.id === tempMatch.id || r.stop_id === realRecord.stop_id);
          if (optimizerVersion && (optimizerVersion.stop_order || optimizerVersion.isNextDelivery != null)) {
            // Patch the real record on the backend with the optimizer's assignments
            const { base44 } = await import('@/api/base44Client');
            const patch = {};
            if (optimizerVersion.stop_order != null) patch.stop_order = optimizerVersion.stop_order;
            if (optimizerVersion.isNextDelivery != null) patch.isNextDelivery = optimizerVersion.isNextDelivery;
            if (optimizerVersion.delivery_time_eta) patch.delivery_time_eta = optimizerVersion.delivery_time_eta;
            if (Object.keys(patch).length > 0) {
              base44.entities.Delivery.update(realRecord.id, patch).then(updated => {
                if (updated?.id) offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updated]).catch(() => {});
              }).catch(() => {});
            }
          }
        }
      }
    }

    // ── Step 6: Broadcast affected delivery IDs ───────────────────────────────
    const affectedIds = allFinal
      .map((r) => r?.id)
      .filter((id) => id && !id.startsWith('temp_'));
    broadcastAffectedDeliveries(affectedIds, driverId, deliveryDate, actionName);

    console.log(`✅ [OfflineBatch] "${actionName}" complete — ${affectedIds.length} deliveries affected`);
    return { success: true, records: allFinal };
  } catch (err) {
    console.error(`❌ [OfflineBatch] "${actionName}" failed:`, err);
    return { success: false, error: err.message };
  } finally {
    // ── Step 7: Always resume syncs ───────────────────────────────────────────
    await resumeAllSyncs();
  }
}
