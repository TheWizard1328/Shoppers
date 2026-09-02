import { invalidate } from '@/components/utils/dataManager';
import { updateDeliveryLocal, notifyMutation } from '@/components/utils/offlineMutations';
import { pauseOfflineSync, resumeOfflineSync } from '@/components/utils/offlineSync';
import { smartRefreshManager } from '@/components/utils/smartRefreshManager';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { performRouteOptimization } from '@/components/utils/routeOptimizationCoordinator';
import { broadcastMutation } from '@/components/utils/realtimeSync';
import { getNextTrackingNumberInGroup } from '@/components/common/stopCardActionHelpers';
import {
  buildReturnDeliveryData,
  resolveFailedPatientName,
  findExistingReturnDelivery,
  buildMergedReturnNotes,
  getEdmontonDate,
} from '@/components/utils/returnDeliveryBuilder';
import { generateUniqueSID } from '@/components/dashboard/DashboardHelpers';
import { sanitizeDeliveryPayload } from '@/components/utils/deliveryPayloadSanitizer';
import { base44 } from '@/api/base44Client';

const getEdmDate = () => getEdmontonDate();

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
// Extended self-echo suppression window — covers the full local pipeline (flag sweep +
// optimization + commit) so our own server writes' WS echoes never double-apply.
const ECHO_SUPPRESSION_MS = 90 * 1000;

/**
 * Return flow — merge-or-create with an atomic client-first commit.
 *
 * MERGE PATH: if the driver's route already has an incomplete return stop for this
 * store (same driver, today's route date, return patient, non-terminal), the failed
 * patient's name is appended to that stop's notes as "And: <name>" below the "For:"
 * line. No new stop, no re-optimization — the route shape doesn't change.
 *
 * CREATE PATH (atomic client-first): everything happens locally on the driver's phone
 * FIRST, and only after every step has committed locally is anything sent to the
 * server, at which point the affected delivery IDs are broadcast to other devices
 * in stop order. Other devices never see a partial state:
 *   1. Create the return delivery locally (IDB, temp ID, instant UI)
 *   2. Sweep every truthy isNextDelivery flag on the route to false (snapshot kept
 *      for rollback)
 *   3. Run route optimization in "contest mode" (clearNextDeliveryLock) — the return
 *      competes with ALL active stops, including the previous next stop, for
 *      position 1. The best stop gets re-flagged by the engine.
 *   4. On optimizer failure: restore the swept flags, remove the temp return, and
 *      rethrow — nothing was ever sent to the server, so nothing leaked.
 *   5. On success: commit in order — backend create (return arrives fully optimized),
 *      server writes for the re-sequenced stops, then ordered WS broadcasts
 *      (stop_order ascending).
 */
export async function handleCreateReturn({ originalDelivery, returnPatient, store }, {
  currentUser, deliveries, patients, appUsers, setIsEntityUpdating, forceRefreshDriverDeliveries, updateDeliveriesLocally, preferredTravelMode
}) {
  setIsEntityUpdating(true);
  pauseOfflineSync();
  smartRefreshManager.pause();

  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    const routeDate = getEdmDate();

    // ── Shared resolution: parent pickup for store/ampm context ──
    const puid = originalDelivery.puid;
    let finalStoreId = originalDelivery.store_id;
    let finalAmpm = originalDelivery.ampm_deliveries;
    if (puid) {
      const parentPickup = deliveries.find((d) => d && !d.patient_id && d.stop_id === puid);
      if (parentPickup) {
        finalStoreId = parentPickup.store_id || originalDelivery.store_id;
        finalAmpm = parentPickup.ampm_deliveries || originalDelivery.ampm_deliveries;
      }
    }

    const failedPatientName = resolveFailedPatientName({ originalDelivery, patients });

    // ──────────────────────────────────────────────────────────────
    // MERGE PATH: an incomplete return stop for this store already exists
    // on today's route — append the patient to its notes instead of
    // creating a second return stop.
    // ──────────────────────────────────────────────────────────────
    const existingReturn = findExistingReturnDelivery({ allDeliveries: deliveries, originalDelivery, returnPatient, routeDate });
    if (existingReturn) {
      const mergedNotes = buildMergedReturnNotes(existingReturn.delivery_notes, failedPatientName);
      const updated = await updateDeliveryLocal(existingReturn.id, { delivery_notes: mergedNotes }, { skipSmartRefresh: true });

      invalidate('Delivery');
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'return_merged', driverId: originalDelivery.driver_id, deliveryDate: existingReturn.delivery_date || routeDate } }));
      // Broadcast the single affected record ID to other devices (they already hold
      // the return stop; this forces them to sync the merged notes).
      broadcastMutation('Delivery', 'update', existingReturn.id, updated || existingReturn).catch(() => {});

      return { merged: true, delivery: updated || existingReturn };
    }

    // ──────────────────────────────────────────────────────────────
    // CREATE PATH: atomic client-first create + flag sweep + contest
    // ──────────────────────────────────────────────────────────────
    const driverId = originalDelivery.driver_id;
    const routeDateDeliveries = deliveries.filter((d) => d && d.driver_id === driverId && d.delivery_date === routeDate);
    const nextTrackingNumber = getNextTrackingNumberInGroup(originalDelivery.tracking_number, deliveries, driverId, routeDate);

    const driverAppUser = appUsers?.find((u) => u?.user_id === driverId || u?.id === driverId);
    const resolvedTravelMode = preferredTravelMode || driverAppUser?.preferred_travel_mode;

    const returnDeliveryData = buildReturnDeliveryData({
      originalDelivery, returnPatient, store, routeDate, routeDateDeliveries,
      finalStoreId, finalAmpm, currentUser, generateUniqueSID, nextTrackingNumber, patients,
      preferredTravelMode: resolvedTravelMode
    });

    // STEP 1 — Create the return locally (IDB + UI, temp ID, no server write)
    const tempId = `temp_delivery_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const sanitizedLocal = await sanitizeDeliveryPayload(returnDeliveryData);
    const localReturn = {
      ...sanitizedLocal,
      isNextDelivery: false,
      id: tempId,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
      _isLocal: true
    };
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [localReturn]);
    notifyMutation({ type: 'create', entity: 'Delivery', id: tempId, data: localReturn });

    // Rollback helpers — restore swept flags + drop the temp record; nothing has
    // reached the server yet, so other devices were never affected.
    const sweptFlags = [];
    const rollbackLocalCreate = async () => {
      try {
        if (sweptFlags.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, sweptFlags.map((d) => ({ ...d, isNextDelivery: true })));
          for (const d of sweptFlags) notifyMutation({ type: 'update', entity: 'Delivery', id: d.id, data: { ...d, isNextDelivery: true } });
        }
        const db = await offlineDB.openDatabase();
        const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
        tx.objectStore(offlineDB.STORES.DELIVERIES).delete(tempId).onsuccess = () => {};
        notifyMutation({ type: 'delete', entity: 'Delivery', id: tempId, data: null });
      } catch (rollbackErr) {
        console.warn('⚠️ [CREATE RETURN] Rollback cleanup failed:', rollbackErr?.message || rollbackErr);
      }
    };

    let commitStarted = false;
    try {
      // STEP 2 — Sweep all truthy isNextDelivery flags on the route to false.
      // Clean slate: the optimizer must compare every stop (incl. the previous
      // next stop) on merit, not inherit the old answer.
      for (const d of routeDateDeliveries) {
        if (d?.isNextDelivery === true) sweptFlags.push(d);
      }
      if (sweptFlags.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, sweptFlags.map((d) => ({ ...d, isNextDelivery: false, updated_date: new Date().toISOString() })));
        for (const d of sweptFlags) {
          notifyMutation({ type: 'update', entity: 'Delivery', id: d.id, data: { ...d, isNextDelivery: false, updated_date: new Date().toISOString() } });
          smartRefreshManager.registerPendingUpdate(d.id, driverId, routeDate);
        }
      }

      // Arm extended WS self-echo suppression for every stop the optimizer may touch
      // BEFORE the run, so our own server writes' echoes never double-apply.
      const routeIds = new Set(routeDateDeliveries.map((d) => d?.id).filter(Boolean));
      routeIds.add(tempId);
      if (!window.__localDeliveryWrites) window.__localDeliveryWrites = new Map();
      const echoExpiry = Date.now() + ECHO_SUPPRESSION_MS;
      for (const id of routeIds) {
        window.__localDeliveryWrites.set(id, echoExpiry);
      }

      // STEP 3 — Optimize locally in contest mode (no server writes — deferred).
      // The coordinator fires its own KITT bar events (routeOptimizationStarted /
      // optimizationRunning / routeOptimizationComplete).
      const scopedDeliveries = [
        ...routeDateDeliveries.map((d) => (d?.id && sweptFlags.some((f) => f.id === d.id) ? { ...d, isNextDelivery: false } : d)),
        localReturn
      ];
      const _driverLat = Number(driverAppUser?.current_latitude);
      const _driverLon = Number(driverAppUser?.current_longitude);
      const currentLocation = Number.isFinite(_driverLat) && Number.isFinite(_driverLon) ? { lat: _driverLat, lon: _driverLon } : null;

      const coordResult = await performRouteOptimization({
        driverId,
        deliveryDate: routeDate,
        deliveries: scopedDeliveries,
        patients,
        currentLocation,
        source: 'return',
        bypassDriverStatus: true,
        clearNextDeliveryLock: true,
        skipServerWrite: true
      });

      if (!coordResult?.success || !Array.isArray(coordResult?.freshDeliveries) || coordResult.freshDeliveries.length === 0) {
        throw new Error(coordResult?.error || 'Route optimization failed');
      }

      const freshDeliveries = coordResult.freshDeliveries;
      const freshReturn = freshDeliveries.find((d) => d?.id === tempId) || localReturn;

      // ── STEP 4 — COMMIT PHASE (everything is final locally; publish in order) ──
      // From here on, server writes may exist — the rollback below must NOT run.
      commitStarted = true;
      let realReturn = null;
      try {
        const createPayload = await sanitizeDeliveryPayload({ ...freshReturn, id: undefined, _isLocal: undefined });
        delete createPayload.id;
        realReturn = await base44.entities.Delivery.create(createPayload);
      } catch (createErr) {
        console.warn('⚠️ [CREATE RETURN] Backend create failed, queuing for offline sync:', createErr?.message || createErr);
        await offlineDB.addPendingMutation({ operation: 'create', entity: 'Delivery', recordId: tempId, payload: returnDeliveryData });
      }

      let finalDeliveries = freshDeliveries;
      if (realReturn?.id) {
        // Track real ID so the platform's own WS create echo is self-suppressed
        window.__localDeliveryWrites.set(realReturn.id, Date.now() + ECHO_SUPPRESSION_MS);
        // Swap temp → real in IDB + UI
        const db = await offlineDB.openDatabase();
        const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
        await new Promise((resolve, reject) => {
          const req = tx.objectStore(offlineDB.STORES.DELIVERIES).delete(tempId);
          req.onsuccess = resolve;
          req.onerror = () => reject(req.error);
        });
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [realReturn]);
        notifyMutation({ type: 'replace', entity: 'Delivery', oldId: tempId, newId: realReturn.id, data: realReturn });
        finalDeliveries = freshDeliveries.map((d) => (d?.id === tempId ? realReturn : d));
      }

      // Server writes for the re-sequenced stops (return excluded — created above
      // with its final stop_order/polyline already attached)
      const writeBatch = (coordResult?.optimizeData?.writeBatch || []).filter((w) => w && w.id !== tempId && (!realReturn?.id || w.id !== realReturn.id));
      if (writeBatch.length > 0) {
        base44.functions.invoke('bulkUpdateDeliveries', { updates: writeBatch }).catch((e) => {
          console.warn('⚠️ [CREATE RETURN] bulkUpdateDeliveries failed:', e?.message || e);
          const CHUNK = 20;
          for (let i = 0; i < writeBatch.length; i += CHUNK) {
            Promise.allSettled(writeBatch.slice(i, i + CHUNK).map(({ id, data }) => base44.entities.Delivery.update(id, data).catch(() => {})));
          }
        });
      }

      // Ordered WS broadcast — affected IDs sent lowest → highest stop_order so
      // receivers process them in route sequence. This is the single moment other
      // devices learn anything changed.
      const broadcastList = finalDeliveries
        .filter((d) => d && !TERMINAL_STATUSES.has(String(d.status || '')))
        .filter((d) => (realReturn?.id ? true : d.id !== tempId))
        .sort((a, b) => (Number(a?.stop_order) || 99999) - (Number(b?.stop_order) || 99999));
      Promise.all(broadcastList.map((item) => {
        const action = realReturn && item.id === realReturn.id ? 'create' : 'update';
        return broadcastMutation('Delivery', action, item.id, item).catch(() => {});
      })).catch(() => {});

      // ── STEP 4b — Apply the optimized route to in-memory state ──
      // The coordinator only wrote IDB + server; the UI still holds the swept
      // "no next stop" state from STEP 2, and the 5-min echo suppression on our
      // own server writes means no WS echo will ever deliver the new flags to
      // this device. Apply the coordinator's final records (correct stop_order,
      // polylines, and the new isNextDelivery winner) to in-memory state directly —
      // same pattern as handleStartDelivery / handleReoptimizeRoute.
      try {
        if (typeof updateDeliveriesLocally === 'function' && Array.isArray(finalDeliveries)) {
          updateDeliveriesLocally(finalDeliveries.filter((d) => d && d.id), false);
        } else if (typeof forceRefreshDriverDeliveries === 'function') {
          await forceRefreshDriverDeliveries(driverId, routeDate);
        }
      } catch (uiErr) {
        console.warn('⚠️ [CREATE RETURN] In-memory apply failed, falling back to IDB refresh:', uiErr?.message || uiErr);
        if (typeof forceRefreshDriverDeliveries === 'function') {
          await forceRefreshDriverDeliveries(driverId, routeDate).catch(() => {});
        }
      }

      // Single UI refresh with the coordinator's final data (no server re-fetch)
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          triggeredBy: 'return_optimized',
          driverId,
          deliveryDate: routeDate,
          alreadyOptimized: true,
          preserveLocalState: true,
          fullReplacement: false,
          freshDeliveries: finalDeliveries
        }
      }));
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'return', driverId, deliveryDate: routeDate, optimizedCount: broadcastList.length } }));
      window.dispatchEvent(new CustomEvent('polylineUpdated', { detail: { driverId, deliveryDate: routeDate, source: 'return' } }));

      invalidate('Delivery');

      return { merged: false, delivery: realReturn || freshReturn };
    } catch (pipelineError) {
      if (!commitStarted) await rollbackLocalCreate();
      else console.warn('⚠️ [CREATE RETURN] Error after commit started — local state preserved, server reconcile via smart refresh:', pipelineError?.message || pipelineError);
      throw pipelineError;
    }
  } catch (error) {
    console.error('❌ [CREATE RETURN] Error:', error);
    throw error;
  } finally {
    resumeOfflineSync();
    smartRefreshManager.restart();
    setIsEntityUpdating(false);
  }
}
