import { offlineDB } from './offlineDatabase';
import { getOfflineStoreName, OFFLINE_SYNC_ENTITY_CLIENTS } from './offlineEntityRegistry';
import { getSyncPaused } from './offlineSyncState';
import { isDeleted, isDeletedByContent } from './deletedDeliveryRegistry';
import { base44 } from '@/api/base44Client';
import { sanitizeAppUserMutationPayload, hasPendingDriverStatusMutation } from './pendingAppUserMutations';
import { invalidateEntityCache } from './dataSyncCoordinator';
import { recordTempPatientId, resolveTempPatientId } from './tempPatientIdMap';

// Terminal (finished) delivery statuses — see TERMINAL_STATUSES unification.
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const getMutationEntityClient = (entityName) => OFFLINE_SYNC_ENTITY_CLIENTS[entityName] || null;

let deferredReplayTimer = null;

// ── RETRY CAP (owner directive Oct 21 2026: 'retries need max attempts, not
// just time frames — retry loops are bogging down phones; most catch up via
// user interactions anyway'). A failed mutation now gets AT MOST 3 attempts
// with growing delays (30s -> 120s; 60s for rate-limits), then it is
// ABANDONED (removed from the pending queue with a warn). Previously a
// poisoned mutation retried on EVERY sync cycle forever, and the deferred
// replay timer re-processed due mutations 100ms after each failure — a
// tight retry loop hammering the shared API pool and the main thread.
const MAX_MUTATION_RETRIES = 3;
const _recordMutationFailure = async (mutation, isRateLimit = false) => {
  const attempt = (mutation?.retryCount || 0) + 1;
  if (attempt >= MAX_MUTATION_RETRIES) {
    console.warn(`⚠️ [OfflineSync] abandoning mutation ${mutation?.entity}:${mutation?.recordId} after ${attempt} attempts — user actions will re-apply any still-needed change`);
    await offlineDB.removePendingMutation(mutation.mutationId).catch(() => {});
    return 'abandoned';
  }
  const delayMs = isRateLimit ? 60 * 1000 : (attempt === 1 ? 30 * 1000 : 120 * 1000);
  await offlineDB.updateMutationRetry(mutation.mutationId, attempt, Date.now() + delayMs).catch(() => {});
  return 'retry';
};

const scheduleDeferredReplay = (mutations = []) => {
  if (!mutations.length || typeof window === 'undefined') return;
  const now = Date.now();
  const hasDueMutation = mutations.some((mutation) => !mutation?.notBefore || Number(mutation.notBefore) <= now);
  const futureTimes = mutations
    .map((mutation) => Number(mutation?.notBefore || 0))
    .filter((time) => time > now);
  const delay = hasDueMutation
    ? 100
    : Math.max(100, Math.min(...futureTimes) - now + 100);
  if (deferredReplayTimer) clearTimeout(deferredReplayTimer);
  deferredReplayTimer = setTimeout(() => {
    deferredReplayTimer = null;
    processPendingMutationsInternal().catch(() => {});
  }, delay);
};

export const processPendingMutationsInternal = async () => {
  if (getSyncPaused()) return { success: true, skipped: true };

  let allMutations = await offlineDB.getPendingMutations();
  const now = Date.now();

  // STALE PURGE (audit item 5): piggybacks on the getAll we already paid for —
  // zero extra reads. Drops mutations older than 48h in one bulk transaction
  // so a storm-built backlog (1,000+ records) can't keep inflating every pass.
  const purged = await offlineDB.purgeStalePendingMutations(allMutations).catch(() => 0);
  if (purged > 0) {
    allMutations = allMutations.filter((m) => {
      const ts = Number(m?.timestamp) || Date.parse(m?.createdAt) || 0;
      return !(ts > 0 && ts < now - 48 * 60 * 60 * 1000);
    });
  }

  const mutations = allMutations.filter((mutation) => !mutation?.notBefore || Number(mutation.notBefore) <= now);
  if (mutations.length === 0) {
    scheduleDeferredReplay(allMutations);
    return { success: true, processed: 0, deferred: allMutations.length };
  }

  const BATCH_SIZE = 50;
  const batch = mutations.slice(0, BATCH_SIZE);

  console.log(`🔄 [OfflineSync] Processing ${batch.length} of ${mutations.length} pending mutations...`);

  const creates = batch.filter(m => m.operation === 'create');
  const updates = batch.filter(m => m.operation === 'update');
  const deletes = batch.filter(m => m.operation === 'delete');

  let successCount = 0;
  let failCount = 0;
  const failedMutationIds = []
  const _rateLimitedDeleteIds = new Set();;

  if (deletes.length > 0) {
    const deletePromises = deletes.map(mutation => {
      if (mutation.recordId?.startsWith('temp_')) {
        return Promise.resolve({ success: true, skip: true });
      }

      const Entity = getMutationEntityClient(mutation.entity);
      if (!Entity) {
        return Promise.resolve({ success: true, skip: true, mutationId: mutation.mutationId });
      }
      return Entity.delete(mutation.recordId)
        .then(() => ({ success: true, mutationId: mutation.mutationId }))
        .catch(deleteError => {
          if (deleteError.response?.status === 404 || deleteError.message?.includes('404') || deleteError.message?.includes('not found')) {
            return { success: true, mutationId: mutation.mutationId };
          }
          if (deleteError.response?.status === 429) {
            return { success: false, mutationId: mutation.mutationId, error: deleteError, retryCount: mutation.retryCount || 0, isRateLimit: true };
          }
          return { success: false, mutationId: mutation.mutationId, error: deleteError, retryCount: mutation.retryCount || 0 };
        });
    });

    const deleteResults = await Promise.all(deletePromises);
    const offlineDeletePromises = [];
    for (const result of deleteResults) {
      if (result.success && result.mutationId) {
        const mutation = deletes.find(m => m.mutationId === result.mutationId);
        if (mutation) {
          offlineDeletePromises.push(offlineDB.removePendingMutation(result.mutationId));
          const storeName = getOfflineStoreName(offlineDB, mutation.entity);
          if (storeName && !mutation.recordId?.startsWith('temp_')) {
            offlineDeletePromises.push(offlineDB.deleteRecord(storeName, mutation.recordId));
          }
        }
        successCount++;
      } else if (result.success && result.skip) {
        const mutation = deletes.find(m => m.mutationId === result.mutationId || !m.recordId?.startsWith('temp_'));
        if (mutation?.mutationId) {
          offlineDeletePromises.push(offlineDB.removePendingMutation(mutation.mutationId));
        }
        successCount++;
      } else {
        failCount++;
        failedMutationIds.push(result.mutationId);
        if (result.isRateLimit) _rateLimitedDeleteIds.add(result.mutationId);
      }
    }

    if (offlineDeletePromises.length > 0) {
      await Promise.all(offlineDeletePromises);
    }

    for (const failedMutationId of failedMutationIds) {
      const mutation = deletes.find(m => m.mutationId === failedMutationId);
      if (mutation) {
        await _recordMutationFailure(mutation, _rateLimitedDeleteIds.has(failedMutationId));
      }
    }
  }

  for (const mutation of [...creates, ...updates]) {
    if (getSyncPaused()) break;

    try {
      const Entity = getMutationEntityClient(mutation.entity);
      if (!Entity) {
        await offlineDB.removePendingMutation(mutation.mutationId);
        successCount++;
        continue;
      }
      const deliveryPayload = mutation.entity === 'Delivery' ? (() => {
        const source = mutation.payload?._isBatchSave && Array.isArray(mutation.payload?._stagedDeliveries)
          ? mutation.payload._stagedDeliveries[0]
          : mutation.payload;
        if (!source) return source;
        // A queued delivery may reference a temp patient id created offline.
        // Resolve it to the real id before the payload reaches the server.
        if (source.patient_id && String(source.patient_id).startsWith('temp_patient_')) {
          const resolvedPid = resolveTempPatientId(source.patient_id);
          if (resolvedPid !== source.patient_id) {
            source.patient_id = resolvedPid;
            console.log(`🔗 [OfflineSync] Delivery payload: resolved temp patient id → ${resolvedPid}`);
          }
        }
        const {
          _isBatchSave,
          _stagedDeliveries,
          _originalDriverId,
          _driverWasChanged,
          _tempId,
          _userInitiated,
          isNew,
          latitude,
          longitude,
          store_name,
          store_abbreviation,
          distanceFromStore,
          delivery_address,
          patient_name,
          patient_phone,
          store_phone,
          cod_amount,
          cod_payment_type,
          ...cleaned
        } = source;
        return cleaned;
      })() : mutation.payload;

      // delivery_date guard applies to CREATES only (a create without a date is
      // genuinely invalid). UPDATE mutations are partial diffs by design — e.g.
      // a bulk-edit status change queues only { status } — and were being
      // silently discarded here, permanently losing the change server-side.
      if (mutation.entity === 'Delivery' && mutation.operation === 'create' && !deliveryPayload?.delivery_date) {
        console.warn(`⚠️ [OfflineSync] Removing invalid queued Delivery mutation ${mutation.mutationId} - missing delivery_date`);
        await offlineDB.removePendingMutation(mutation.mutationId);
        successCount++;
        continue;
      }
      if (mutation.entity === 'Delivery' && mutation.operation === 'update' && !deliveryPayload?.delivery_date) {
        console.warn(`⚠️ [OfflineSync] Flushing partial Delivery update mutation ${mutation.mutationId} (no delivery_date — valid partial diff) fields: ${Object.keys(deliveryPayload || {}).join(',')}`);
      }

      if (mutation.operation === 'create') {
        // CRITICAL: Guard against resurrecting a deleted delivery via a stale
        // create mutation. If the mutation's record ID or content signature
        // matches a recently deleted delivery, discard the mutation instead
        // of replaying it. This prevents the "reappearing pickup" bug where a
        // device's offline create queue replays after the delivery was deleted
        // by another device.
        if (mutation.entity === 'Delivery') {
          if (mutation.recordId && isDeleted(mutation.recordId)) {
            console.log(`🛡️ [OfflineSync] Discarding create mutation for deleted delivery ${mutation.recordId}`);
            await offlineDB.removePendingMutation(mutation.mutationId);
            successCount++;
            continue;
          }
          if (isDeletedByContent(deliveryPayload)) {
            console.log(`🛡️ [OfflineSync] Discarding create mutation — content matches recently deleted delivery`);
            await offlineDB.removePendingMutation(mutation.mutationId);
            successCount++;
            continue;
          }
        }
        const createdRecord = await Entity.create(mutation.entity === 'Delivery' ? deliveryPayload : mutation.payload);
        const storeName = getOfflineStoreName(offlineDB, mutation.entity);
        if (storeName) {
          if (mutation.recordId?.startsWith('temp_')) {
            await offlineDB.deleteRecord(storeName, mutation.recordId);
          }
          await offlineDB.bulkSave(storeName, [createdRecord]);
        }
        // CRITICAL (Oct 6 2026): when a queued PATIENT create syncs, deliveries
        // created while offline may still reference the temp patient id
        // (delivery.patient_id = temp_patient_...). Without a remap those stops
        // render "Unknown" with no map marker forever — the patient exists in
        // the DB under its real id. Remap IDB + server now.
        if (mutation.entity === 'Patient' && mutation.recordId?.startsWith('temp_') && createdRecord?.id) {
          // Persist the temp→real mapping so queued Delivery payloads created
          // while offline (which still carry the temp patient id) resolve on drain.
          recordTempPatientId(mutation.recordId, createdRecord.id);
          try {
            const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
            const orphans = (allDeliveries || []).filter((d) => d && d.patient_id === mutation.recordId);
            for (const orphan of orphans) {
              const patched = { ...orphan, patient_id: createdRecord.id };
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [patched]);
              try {
                const entityClient = getMutationEntityClient('Delivery');
                if (entityClient?.update) await entityClient.update(orphan.id, { patient_id: createdRecord.id });
                else await base44.entities.Delivery.update(orphan.id, { patient_id: createdRecord.id });
              } catch (dbErr) {
                console.warn('⚠️ [OfflineSync] Patient remap: server delivery update failed for', orphan.id, dbErr?.message || dbErr);
              }
            }
            if (orphans.length > 0) {
              console.log(`🔗 [OfflineSync] Remapped ${orphans.length} delivery/deliveries from temp patient ${mutation.recordId} → ${createdRecord.id}`);
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                detail: { triggeredBy: 'patient_temp_id_remap', fullReplacement: false }
              }));
            }
          } catch (remapErr) {
            console.warn('⚠️ [OfflineSync] Patient temp-id delivery remap failed:', remapErr?.message || remapErr);
          }
        }
        if (typeof window !== 'undefined' && mutation.recordId?.startsWith('temp_')) {
          window.dispatchEvent(new CustomEvent('offlineMutationRecordReplaced', {
            detail: {
              entity: mutation.entity,
              oldId: mutation.recordId,
              record: createdRecord
            }
          }));
        }
      } else if (mutation.operation === 'update') {
        // CRITICAL: Skip update mutations for deleted deliveries.
        if (mutation.entity === 'Delivery' && mutation.recordId && isDeleted(mutation.recordId)) {
          console.log(`🛡️ [OfflineSync] Discarding update mutation for deleted delivery ${mutation.recordId}`);
          await offlineDB.removePendingMutation(mutation.mutationId);
          successCount++;
          continue;
        }

        let finalPayload = mutation.entity === 'Delivery'
          ? deliveryPayload
          : mutation.entity === 'AppUser'
            ? sanitizeAppUserMutationPayload(mutation.payload)
            : mutation.payload;

        // ── TERMINAL-REVERT GUARD v2 (owner directive Oct 15 2026) ─────────────
        // Rule: a queued replay can arrive MINUTES after capture — by then the
        // stop may have been completed/failed/cancelled (on this device or
        // another). NO replay may flip a terminal stop back to an active
        // status — including _userInitiated replays. The Sep 4 guard exempted
        // user-initiated mutations, but Start/accept notes are ALSO
        // user-initiated: a Start note queued during a rate-limit failure
        // ({status:'in_transit', arrival_time} with NO actual_delivery_time
        // field) replayed after the completion and reverted the stop — owner
        // report Oct 15 (Robert stop 26 reverted 2 min after completion,
        // Sharuk stop 12 reverted 18s after). The ONLY replay that may
        // downgrade a terminal record is a deliberate restart, which ALWAYS
        // carries actual_delivery_time in the payload (cleared to null by the
        // restart writer) — that explicit field is the discriminator.
        if (
          mutation.entity === 'Delivery' &&
          typeof finalPayload?.status === 'string' &&
          !TERMINAL_STATUSES.has(finalPayload.status) &&
          !('actual_delivery_time' in finalPayload)
        ) {
          let shouldStrip = false;
          try {
            const serverRec = await Entity.get(mutation.recordId);
            if (serverRec && TERMINAL_STATUSES.has(String(serverRec.status || ''))) shouldStrip = true;
          } catch (_) { /* server fetch failed — fall through to local IDB check */ }
          if (!shouldStrip) {
            try {
              const localRec = await offlineDB.getById(offlineDB.STORES.DELIVERIES, mutation.recordId);
              if (localRec && TERMINAL_STATUSES.has(String(localRec.status || '')) && localRec.actual_delivery_time) shouldStrip = true;
            } catch (_) { /* local read failed — fail open on this leg */ }
          }
          if (shouldStrip) {
            console.log(`🛡️ [OfflineSync] Stripping stale active-status replay for ${mutation.recordId} — stop is already finished (wanted '${finalPayload.status}')`);
            const { status: _s, actual_delivery_time: _t, arrival_time: _a, ...restPayload } = finalPayload;
            finalPayload = restPayload;
            if (Object.keys(finalPayload).length === 0) {
              // Nothing left to write — drop the mutation instead of sending a no-op.
              await offlineDB.removePendingMutation(mutation.mutationId);
              successCount++;
              continue;
            }
          }
        }

        await Entity.update(mutation.recordId, finalPayload);

        // Driver status changes have backend side effects beyond AppUser.update:
        // duty-segment recording, device ownership, tracking state and next-stop
        // handling. Replay those only after the queued entity update succeeds.
        if (mutation.entity === 'AppUser' && mutation.driverStatusTransition) {
          await base44.functions.invoke('setDriverStatus', mutation.driverStatusTransition);
          invalidateEntityCache('AppUser');
        }
      }

      await offlineDB.removePendingMutation(mutation.mutationId);
      invalidateEntityCache(mutation.entity);
      if (mutation.entity === 'AppUser' && mutation.driverStatusTransition && typeof window !== 'undefined') {
        const hasPendingStatus = await hasPendingDriverStatusMutation(mutation.recordId);
        window.dispatchEvent(new CustomEvent('offlineDriverStatusSynced', {
          detail: {
            appUserId: mutation.recordId,
            userId: mutation.driverStatusTransition.targetUserId,
            status: mutation.driverStatusTransition.newStatus,
            hasPendingStatus,
          }
        }));
      }
      successCount++;
      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      if (error.response?.status === 404 || error.message?.includes('404') || error.message?.includes('not found')) {
        console.log(`⏭️ [OfflineSync] Removing mutation for deleted record: ${mutation.recordId} (${mutation.entity})`);
        await offlineDB.removePendingMutation(mutation.mutationId);
        successCount++;
        continue;
      }

      // Capped retry with delay (Oct 21): a rate-limit no longer BLOCKS the
      // whole processor 30s per mutation — the mutation gets a 60s notBefore
      // stamp and the loop moves on to the next one.
      const _outcome = await _recordMutationFailure(mutation, error.response?.status === 429);
      failCount++;
    }
  }

  const remainingMutations = await offlineDB.getPendingMutations();
  scheduleDeferredReplay(remainingMutations);
  return { success: failCount === 0, processed: successCount, failed: failCount, remaining: remainingMutations.length };
};