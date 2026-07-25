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
 *   4. Apply resulting records to local UI state immediately (temp IDs shown instantly)
 *   5. Create NEW (temp) records on the backend with ALL optimizer data (polylines, stop_order, etc.)
 *   5b. SWAP temp IDs out of React state with real backend IDs — prevents duplicate cards
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
      createdRecords.push({ created, tempId: _tempId });

      // Mark the real ID as a local write so the WS echo is suppressed.
      // Without this, the echo arrives and adds a SECOND card on top of the temp one.
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

      // Swap temp → real in window.__appDeliveries so duplicate guard works correctly.
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

  // Return flat list of created records + their temp IDs for the caller to swap in React state
  return { created: createdRecords, updated: toUpdate };
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
 * @param {Function} [params.applyLocalUI]       - fn({ upserts, deleteIds }) — update React state.
 *                                                  Must support deleteIds to swap temp → real IDs.
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
    const tempOriginalIds = new Set(
      validRecords.filter(r => !r.id || r.id.startsWith('temp_')).map(r => r.id)
    );

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

    // ── Step 4: Apply temp records to UI immediately ───────────────────────────
    // At this point, records still have temp IDs — we show them immediately so the
    // UI is responsive. Step 5b will swap them out for real IDs once created.
    if (applyLocalUI) {
      try {
        applyLocalUI({ upserts: optimizedRecords, deleteIds: [] });
      } catch (uiErr) {
        console.warn(`[OfflineBatch] "${actionName}" — applyLocalUI (Step 4) error:`, uiErr.message);
      }
    }

    // ── Step 5: Create NEW records on the backend ─────────────────────────────
    // CRITICAL: Flush the OPTIMIZED version of temp records, not the originals.
    //
    // The optimizer assigns stop_order, isNextDelivery, encoded_polyline, transport_mode,
    // delivery_time_eta, estimated_distance_km, estimated_duration_minutes to each stop.
    // These are in `optimizedRecords` (from freshDeliveries). Flushing the original
    // `validRecords` would create bare backend records without any optimizer data.
    // When the temp gets replaced on refresh, all polylines and ordering vanish.
    //
    // The optimizer's writeBatch already wrote all REAL-id updates via bulkUpdateDeliveries.
    // We only need to CREATE the temp records that don't exist yet.
    const optimizedTempRecords = optimizedRecords.filter(r => tempOriginalIds.has(r.id));
    const recordsToFlush = optimizedTempRecords.length > 0
      ? optimizedTempRecords
      : validRecords.filter(r => !r.id || r.id.startsWith('temp_'));

    const flushResult = recordsToFlush.length > 0
      ? await flushToOnlineDB(recordsToFlush)
      : { created: [], updated: [] };

    const { created: createdPairs, updated: updatedRecords } = flushResult;

    // ── Step 5b: Swap temp IDs → real IDs in React state ─────────────────────
    // This is the CRITICAL step that prevents duplicate cards.
    //
    // After Step 4, React state contains temp records (id: 'temp_delivery_...'). 
    // After Step 5, the backend has real records with real IDs.
    //
    // Without this step:
    //   - React state: { id: 'temp_delivery_xyz', ... }  ← shown as card #1
    //   - WS echo arrives with real ID → applyDeliveryChangesLocally adds it as NEW → card #2
    //   - User sees TWO identical ISP/ISD cards
    //
    // With this step:
    //   - We atomically call applyLocalUI({ upserts: [realRecord], deleteIds: ['temp_delivery_xyz'] })
    //   - React state map deletes temp key, inserts real key → ONE card
    //   - WS echo arrives → real ID already in state → map.set merges (no duplicate)
    //
    // Match by stop_id first (unique per delivery), then delivery_id as fallback.
    const tempIdSet = new Set(recordsToFlush.map(r => r.id));
    const realByStopId = new Map(createdPairs.map(({ created: c }) => [c?.stop_id, c]).filter(([k]) => k));
    const realByDeliveryId = new Map(createdPairs.map(({ created: c }) => [c?.delivery_id, c]).filter(([k]) => k));
    const tempIdToReal = new Map(createdPairs.map(({ created: c, tempId }) => [tempId, c]).filter(([, c]) => c?.id));

    // Build the merged allFinal array: temp records → real+optimized records
    let allFinal = optimizedRecords.map(r => {
      if (tempIdSet.has(r.id)) {
        const real = tempIdToReal.get(r.id)
          || (r.stop_id && realByStopId.get(r.stop_id))
          || (r.delivery_id && realByDeliveryId.get(r.delivery_id))
          || null;
        if (real) {
          // Merge optimizer fields onto real record (polylines, stop_order, isNextDelivery, etc.)
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

    // Persist the merged real+optimized records to IDB
    const mergedForDB = allFinal.filter(r => r.id && !r.id.startsWith('temp_'));
    if (mergedForDB.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, mergedForDB).catch(() => {});
    }

    // NOW swap temp → real in React state:
    // Delete temp IDs, upsert real (merged) records — one atomic state update.
    if (applyLocalUI && createdPairs.length > 0) {
      // Find real records that were swapped from temp
      const realUpserts = Array.from(tempIdToReal.values()).map(real => {
        return allFinal.find(r => r.id === real?.id) || real;
      }).filter(Boolean);
      const tempDeleteIds = Array.from(tempIdToReal.keys());

      if (realUpserts.length > 0 || tempDeleteIds.length > 0) {
        try {
          applyLocalUI({ upserts: realUpserts, deleteIds: tempDeleteIds });
          console.log(`[OfflineBatch] "${actionName}" — swapped ${tempDeleteIds.length} temp IDs → real IDs in React state`);
        } catch (swapErr) {
          console.warn(`[OfflineBatch] "${actionName}" — applyLocalUI (Step 5b swap) error:`, swapErr.message);
        }
      }
    }

    // ── Step 6: Broadcast affected delivery IDs ───────────────────────────────
    const affectedIds = allFinal
      .map((r) => r?.id)
      .filter((id) => id && !id.startsWith('temp_'));
    broadcastAffectedDeliveries(affectedIds, driverId, deliveryDate, actionName);

    console.log(`✅ [OfflineBatch] "${actionName}" complete — ${affectedIds.length} deliveries, ${createdPairs.length} new records created`);
    return { success: true, records: allFinal };
  } catch (err) {
    console.error(`❌ [OfflineBatch] "${actionName}" failed:`, err);
    return { success: false, error: err.message };
  } finally {
    // ── Step 7: Always resume syncs ───────────────────────────────────────────
    await resumeAllSyncs();
  }
}
