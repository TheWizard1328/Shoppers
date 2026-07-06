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
 *   5. Batch-write finalized records to the online DB
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

const flushToOnlineDB = async (records) => {
  if (!records || records.length === 0) return;

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

      // Replace temp with real in offline DB
      const db = await offlineDB.openDatabase();
      const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
      await new Promise((resolve, reject) => {
        const req = tx.objectStore(offlineDB.STORES.DELIVERIES).delete(_tempId);
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
      });
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [created]);
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
 * @param {Object}   [params.optimizerContext]   - { deliveries, patients, stores, appUsers } — current local state
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
    if (runOptimizer && driverId && deliveryDate && optimizerContext) {
      try {
        const { performRouteOptimization } = await import('./routeOptimizationCoordinator');

        // Merge the new records into the existing local deliveries so the optimizer
        // sees the full route (existing + new) without hitting the backend.
        const existingDeliveries = optimizerContext.deliveries || [];
        const newRecordIds = new Set(validRecords.map((r) => r.id));
        const mergedDeliveries = [
          ...existingDeliveries.filter((d) => d && !newRecordIds.has(d.id)),
          ...validRecords,
        ];

        const optimizeResult = await performRouteOptimization({
          driverId,
          deliveryDate,
          deliveries: mergedDeliveries,
          patients: optimizerContext.patients || [],
          stores: optimizerContext.stores || [],
          appUsers: optimizerContext.appUsers || [],
          source: actionName,
          skipPolyline: false,
        });

        if (optimizeResult?.success && optimizeResult.freshDeliveries?.length > 0) {
          // Use the optimized fresh records as the authoritative set
          optimizedRecords = optimizeResult.freshDeliveries;
          // Persist optimized order back to offline DB
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

    // ── Step 5: Batch write finalized records to online DB ────────────────────
    const finalRecords = await flushToOnlineDB(validRecords);

    // ── Step 6: Broadcast affected delivery IDs ───────────────────────────────
    const affectedIds = (finalRecords || validRecords)
      .map((r) => r?.id)
      .filter(Boolean);
    broadcastAffectedDeliveries(affectedIds, driverId, deliveryDate, actionName);

    console.log(`✅ [OfflineBatch] "${actionName}" complete — ${affectedIds.length} deliveries affected`);
    return { success: true, records: finalRecords || validRecords };
  } catch (err) {
    console.error(`❌ [OfflineBatch] "${actionName}" failed:`, err);
    return { success: false, error: err.message };
  } finally {
    // ── Step 7: Always resume syncs ───────────────────────────────────────────
    await resumeAllSyncs();
  }
}