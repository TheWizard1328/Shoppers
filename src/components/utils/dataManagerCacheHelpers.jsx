import { offlineDB } from './offlineDatabase';

export const invalidate = async (entityName) => {
  if (entityName === 'Patient') {
    try {
      await offlineDB.updateSyncMetadata('Patient', null, null, {
        scope_key: 'global',
        cache_schema_version: 0
      });
    } catch {}
  }
};

export const getCached = () => null;

export const setCached = () => {
  // No-op - no cache to set
};

export const invalidateDeliveryRangeCache = () => {
  // No-op
};

export const updateCache = () => {
  // No-op
};

export const removeDeletedFromCache = async (entityName, deletedIds) => {
  if (!Array.isArray(deletedIds) || deletedIds.length === 0) return;

  if (entityName === 'Patient') {
    await Promise.all(
      deletedIds.map((id) => offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, id).catch(() => null))
    );
    try {
      const remainingPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      await offlineDB.updateCacheSnapshot('Patient', remainingPatients || [], {
        scopeKey: 'global',
        syncType: 'deletion'
      });
    } catch {}
  }
};

export const invalidateDeliveriesForDate = () => {
  // No-op
};