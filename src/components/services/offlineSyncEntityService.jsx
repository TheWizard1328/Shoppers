export const createOfflineSyncEntityService = ({
  offlineDB,
  getOfflineStoreName,
  PATIENT_BATCH_SIZE,
  PATIENT_SYNC_COOLDOWN
}) => {
  const getSyncMetaTimestamp = () => new Date().toISOString();

  const checkIfEntityNeedsSync = async (entityName, Entity, initialCheckQuery = {}) => {
    try {
      const metadata = await offlineDB.getSyncMetadata(entityName);
      const lastClientTimestamp = metadata?.last_synced_timestamp || null;
      const lastSyncTime = metadata?.last_sync_time ? new Date(metadata.last_sync_time).getTime() : 0;
      const now = Date.now();

      if (lastClientTimestamp && lastSyncTime && (now - lastSyncTime) < 4 * 60 * 60 * 1000) {
        return { needsSync: false, lastClientTimestamp, skipped: true };
      }

      const latestRecords = await Entity.filter(initialCheckQuery, '-updated_date', 1);
      if (!latestRecords || latestRecords.length === 0) {
        return { needsSync: false, lastClientTimestamp };
      }

      const latestServerTimestamp = latestRecords[0].updated_date;
      if (!lastClientTimestamp) {
        return { needsSync: true, lastClientTimestamp: null, latestServerTimestamp };
      }

      const clientTime = new Date(lastClientTimestamp).getTime();
      const serverTime = new Date(latestServerTimestamp).getTime();

      return {
        needsSync: serverTime > clientTime,
        lastClientTimestamp,
        latestServerTimestamp
      };
    } catch (error) {
      return { needsSync: true, lastClientTimestamp: null };
    }
  };

  const syncPatientsBatched = async (Entity, filter, latestServerTimestamp) => {
    let totalRecords = 0;
    let offset = 0;

    while (true) {
      const records = await Entity.filter(filter, '-updated_date', PATIENT_BATCH_SIZE, offset);
      if (!records || records.length === 0) break;

      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, records);
      totalRecords += records.length;

      if (records.length < PATIENT_BATCH_SIZE) break;
      offset += PATIENT_BATCH_SIZE;
      await new Promise((r) => setTimeout(r, PATIENT_SYNC_COOLDOWN));
    }

    await offlineDB.updateSyncMetadata('Patient', latestServerTimestamp, getSyncMetaTimestamp());

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('periodicSyncProgress', {
        detail: { entity: 'Patient', count: totalRecords, isComplete: true }
      }));
    }

    return { success: true, recordCount: totalRecords };
  };

  const syncEntityWithTimestampCheck = async (entityName, Entity, additionalFilter = {}, initialCheckQuery = {}) => {
    try {
      const checkResult = await checkIfEntityNeedsSync(entityName, Entity, initialCheckQuery);

      if (!checkResult.needsSync || checkResult.skipped) {
        if (checkResult.skipped) {
          await offlineDB.updateSyncMetadata(entityName, checkResult.lastClientTimestamp, getSyncMetaTimestamp());
        }
        return { skipped: true, reason: checkResult.skipped ? 'recently_synced' : 'no_updates' };
      }

      const filter = checkResult.lastClientTimestamp
        ? { ...additionalFilter, updated_date: { $gte: checkResult.lastClientTimestamp } }
        : additionalFilter;

      if (entityName === 'Patient') {
        return await syncPatientsBatched(Entity, filter, checkResult.latestServerTimestamp);
      }

      const records = await Entity.filter(filter, '-updated_date', 5000);
      if (records.length > 0) {
        const storeName = getOfflineStoreName(offlineDB, entityName);
        if (storeName) {
          await offlineDB.bulkSave(storeName, records);
        }
      }

      await offlineDB.updateSyncMetadata(entityName, checkResult.latestServerTimestamp, new Date().toISOString());

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('periodicSyncProgress', {
          detail: { entity: entityName, count: records.length, isComplete: true }
        }));
      }

      return { success: true, recordCount: records.length };
    } catch (error) {
      return { error: error.message };
    }
  };

  return {
    getSyncMetaTimestamp,
    checkIfEntityNeedsSync,
    syncPatientsBatched,
    syncEntityWithTimestampCheck
  };
};