import { offlineDB } from './offlineDatabase';
import { getOfflineStoreName, OFFLINE_SYNC_ENTITY_CLIENTS } from './offlineEntityRegistry';
import { getSyncPaused } from './offlineSyncState';
import { isDeleted, isDeletedByContent } from './deletedDeliveryRegistry';

// Terminal (finished) delivery statuses — see TERMINAL_STATUSES unification.
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const getMutationEntityClient = (entityName) => OFFLINE_SYNC_ENTITY_CLIENTS[entityName] || null;

export const processPendingMutationsInternal = async () => {
  if (getSyncPaused()) return { success: true, skipped: true };

  const mutations = await offlineDB.getPendingMutations();
  if (mutations.length === 0) return { success: true, processed: 0 };

  const BATCH_SIZE = 50;
  const batch = mutations.slice(0, BATCH_SIZE);

  console.log(`🔄 [OfflineSync] Processing ${batch.length} of ${mutations.length} pending mutations...`);

  const creates = batch.filter(m => m.operation === 'create');
  const updates = batch.filter(m => m.operation === 'update');
  const deletes = batch.filter(m => m.operation === 'delete');

  let successCount = 0;
  let failCount = 0;
  const failedMutationIds = [];

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
      }
    }

    if (offlineDeletePromises.length > 0) {
      await Promise.all(offlineDeletePromises);
    }

    for (const failedMutationId of failedMutationIds) {
      const mutation = deletes.find(m => m.mutationId === failedMutationId);
      if (mutation) {
        await offlineDB.updateMutationRetry(mutation.mutationId, (mutation.retryCount || 0) + 1);
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

      if (mutation.entity === 'Delivery' && !deliveryPayload?.delivery_date) {
        console.warn(`⚠️ [OfflineSync] Removing invalid queued Delivery mutation ${mutation.mutationId} - missing delivery_date`);
        await offlineDB.removePendingMutation(mutation.mutationId);
        successCount++;
        continue;
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

        let finalPayload = mutation.entity === 'Delivery' ? deliveryPayload : mutation.payload;

        // ── TERMINAL-REVERT GUARD (Robert, Sep 4 2026) ─────────────────────────
        // Rule: the online database is only pushed from DIRECT user actions.
        // A queued replay can arrive MINUTES after capture — by then another
        // device may have completed/failed/cancelled the stop. Only a mutation
        // explicitly marked _userInitiated (Complete/Fail/Cancel/Restart/batch
        // staging) may flip a terminal status. Unmarked replays are treated as
        // indirect writes: their status/actual_delivery_time changes are
        // stripped so a stale snapshot can never resurrect a finished stop.
        const _mutationUserInitiated = !!(mutation._userInitiated || mutation.payload?._userInitiated);
        if (
          mutation.entity === 'Delivery' &&
          typeof finalPayload?.status === 'string' &&
          !TERMINAL_STATUSES.has(finalPayload.status) &&
          !_mutationUserInitiated
        ) {
          try {
            const serverRec = await Entity.get(mutation.recordId);
            if (serverRec && TERMINAL_STATUSES.has(String(serverRec.status || ''))) {
              console.log(`🛡️ [OfflineSync] Stripping status revert from queued update for ${mutation.recordId} — server is '${serverRec.status}', stale replay wanted '${finalPayload.status}'`);
              const { status: _s, actual_delivery_time: _t, ...restPayload } = finalPayload;
              finalPayload = restPayload;
            }
          } catch (_) { /* server fetch failed — proceed with the write as-is */ }
        }

        await Entity.update(mutation.recordId, finalPayload);
      }

      await offlineDB.removePendingMutation(mutation.mutationId);
      successCount++;
      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      if (error.response?.status === 404 || error.message?.includes('404') || error.message?.includes('not found')) {
        console.log(`⏭️ [OfflineSync] Removing mutation for deleted record: ${mutation.recordId} (${mutation.entity})`);
        await offlineDB.removePendingMutation(mutation.mutationId);
        successCount++;
        continue;
      }

      await offlineDB.updateMutationRetry(mutation.mutationId, (mutation.retryCount || 0) + 1);
      failCount++;

      if (error.response?.status === 429) {
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }

  return { success: failCount === 0, processed: successCount, failed: failCount, remaining: mutations.length - batch.length };
};