import { offlineDB } from './offlineDatabase';
import { entities } from './dataManagerEntities';
import { resolveEntityName } from './dataManagerDemoMode';
import { waitForRateLimit, triggerGlobalRateLimitPause } from './dataManagerRateLimit';
import { connectionMonitor } from './connectionMonitor';
import { getOfflineStoreName, isOfflineManagedEntity } from './offlineEntityRegistry';

export const getData = async (entityName, sortKey = null, queryOrLimit = null, forceRefresh = false) => {
  entityName = await resolveEntityName(entityName);
  const isQueryObject = queryOrLimit && typeof queryOrLimit === 'object' && !Array.isArray(queryOrLimit);
  const query = isQueryObject ? queryOrLimit : null;
  const limit = !isQueryObject && typeof queryOrLimit === 'number' ? queryOrLimit : null;

  if (isOfflineManagedEntity(entityName) || entityName === 'SquareLocationConfig' || entityName === 'SquareTransaction') {
    try {
      const storeName = getOfflineStoreName(offlineDB, entityName) || (entityName === 'SquareLocationConfig' ? offlineDB.STORES.SQUARE_LOCATION_CONFIGS : offlineDB.STORES.SQUARE_TRANSACTIONS);
      const offlineData = await offlineDB.getAll(storeName);

      if (offlineData && offlineData.length > 0 && !forceRefresh) {
        return offlineData;
      }
    } catch {}
  }

  let retries = 3;
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await waitForRateLimit();

      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const Entity = entities[entityName];
      if (!Entity) {
        return [];
      }

      const startTime = Date.now();
      let data;

      if (query) {
        if (sortKey && limit) {
          data = await Entity.filter(query, sortKey, limit);
        } else if (sortKey) {
          data = await Entity.filter(query, sortKey);
        } else {
          data = await Entity.filter(query);
        }
      } else {
        const defaultLimit = entityName === 'SquareTransaction' ? 100 : limit;

        if (sortKey && defaultLimit) {
          data = await Entity.list(sortKey, defaultLimit);
        } else if (sortKey) {
          data = await Entity.list(sortKey);
        } else if (defaultLimit) {
          data = await Entity.list('-updated_date', defaultLimit);
        } else {
          data = await Entity.list();
        }
      }

      const responseTime = Date.now() - startTime;
      connectionMonitor.recordResponseTime(responseTime);

      if ((isOfflineManagedEntity(entityName) || entityName === 'SquareLocationConfig' || entityName === 'SquareTransaction') && Array.isArray(data) && data.length > 0) {
        const storeName = getOfflineStoreName(offlineDB, entityName) || (entityName === 'SquareLocationConfig' ? offlineDB.STORES.SQUARE_LOCATION_CONFIGS : offlineDB.STORES.SQUARE_TRANSACTIONS);
        await offlineDB.bulkSave(storeName, data);
        await offlineDB.updateSyncMetadata(entityName, new Date().toISOString());
      }

      return data;
    } catch (error) {
      lastError = error;

      if (isOfflineManagedEntity(entityName) || entityName === 'SquareLocationConfig' || entityName === 'SquareTransaction') {
        try {
          const storeName = getOfflineStoreName(offlineDB, entityName) || (entityName === 'SquareLocationConfig' ? offlineDB.STORES.SQUARE_LOCATION_CONFIGS : offlineDB.STORES.SQUARE_TRANSACTIONS);
          const fallbackData = await offlineDB.getAll(storeName);
          if (fallbackData && fallbackData.length > 0) {
            return fallbackData;
          }
        } catch {}
      }

      if (error.response?.status === 403 || error.message?.includes('403')) {
        return [];
      }

      if (attempt < retries - 1 && (error.message?.includes('Network Error') || error.code === 'NETWORK_ERROR')) {
        continue;
      }

      if (error.response?.status === 429 || error.message?.includes('429')) {
        connectionMonitor.recordError('rate_limit');
        triggerGlobalRateLimitPause();
        const backoffDelay = Math.min(2000 * Math.pow(2, attempt), 10000);
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        if (attempt < retries - 1) continue;
      } else {
        connectionMonitor.recordError('network');
      }

      break;
    }
  }

  return [];
};