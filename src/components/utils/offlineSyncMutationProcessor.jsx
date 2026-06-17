import { offlineDB } from './offlineDatabase';
import { getOfflineStoreName, OFFLINE_SYNC_ENTITY_CLIENTS } from './offlineEntityRegistry';
import { getSyncPaused } from './offlineSyncState';

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
        await Entity.update(mutation.recordId, mutation.entity === 'Delivery' ? deliveryPayload : mutation.payload);
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