import { format } from 'date-fns';

export { format };
import { offlineDB } from './offlineDatabase';
import { entities } from './dataManagerEntities';
import { resolveEntityName } from './dataManagerDemoMode';
import { waitForRateLimit, triggerGlobalRateLimitPause } from './dataManagerRateLimit';
export {
  getDeliveriesForDateRange,
  loadDeliveriesForDate,
  loadFullMonthDeliveries,
  loadPriorityDeliveriesForSelection,
  loadDeliveries
} from './dataManagerDeliveryLoader';
import { 
  createPatientLocal, 
  updatePatientLocal, 
  deletePatientLocal,
  createDeliveryLocal,
  updateDeliveryLocal,
  deleteDeliveryLocal,
  batchCreateDeliveriesLocal,
  createCityLocal,
  updateCityLocal,
  deleteCityLocal,
  createStoreLocal,
  updateStoreLocal,
  deleteStoreLocal,
  createCompanyLocal,
  updateCompanyLocal,
  deleteCompanyLocal,
  subscribeMutations
} from './offlineMutations';
import { connectionMonitor } from './connectionMonitor';
import { getOfflineStoreName, isOfflineManagedEntity } from './offlineEntityRegistry';
import { getLocalDateString } from './localTimeHelper';

// CRITICAL: NO IN-MEMORY CACHE - Use offline DB exclusively
// Deleted all cache layers to prevent stale data and reappearing deleted items

// Track offline DB load completion
let offlineDBLoadComplete = false;

export const markOfflineDBLoadComplete = () => {
  offlineDBLoadComplete = true;
};

export const isOfflineDBLoadComplete = () => {
  return offlineDBLoadComplete;
};

// NO FREQUENT CACHE - removed

export const getData = async (entityName, sortKey = null, queryOrLimit = null, forceRefresh = false) => {
  entityName = await resolveEntityName(entityName);
  const isQueryObject = queryOrLimit && typeof queryOrLimit === 'object' && !Array.isArray(queryOrLimit);
  const query = isQueryObject ? queryOrLimit : null;
  const limit = !isQueryObject && typeof queryOrLimit === 'number' ? queryOrLimit : null;
  
  // OFFLINE-FIRST: Try IndexedDB for ALL critical entities ALWAYS
  // NO IN-MEMORY CACHE - only offline DB
  if (isOfflineManagedEntity(entityName) || entityName === 'SquareLocationConfig' || entityName === 'SquareTransaction') {
    try {
      const storeName = getOfflineStoreName(offlineDB, entityName) || (entityName === 'SquareLocationConfig' ? offlineDB.STORES.SQUARE_LOCATION_CONFIGS : offlineDB.STORES.SQUARE_TRANSACTIONS);
      let offlineData = await offlineDB.getAll(storeName);
      
      if (offlineData && offlineData.length > 0 && !forceRefresh) {
        return offlineData;
      }
    } catch (offlineError) {}
  }

  // Fallback: Fetch from API if offline DB empty
  let retries = 3;
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await waitForRateLimit();

      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
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
        const defaultLimit = (entityName === 'SquareTransaction') ? 100 : limit;

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

      // Save to offline DB
      if ((isOfflineManagedEntity(entityName) || entityName === 'SquareLocationConfig' || entityName === 'SquareTransaction') && Array.isArray(data) && data.length > 0) {
        const storeName = getOfflineStoreName(offlineDB, entityName) || (entityName === 'SquareLocationConfig' ? offlineDB.STORES.SQUARE_LOCATION_CONFIGS : offlineDB.STORES.SQUARE_TRANSACTIONS);
        await offlineDB.bulkSave(storeName, data);
        await offlineDB.updateSyncMetadata(entityName, new Date().toISOString());
      }

      return data;
      
    } catch (error) {
        lastError = error;

        // Try offline DB on any error
        if (isOfflineManagedEntity(entityName) || entityName === 'SquareLocationConfig' || entityName === 'SquareTransaction') {
          try {
            const storeName = getOfflineStoreName(offlineDB, entityName) || (entityName === 'SquareLocationConfig' ? offlineDB.STORES.SQUARE_LOCATION_CONFIGS : offlineDB.STORES.SQUARE_TRANSACTIONS);
            const fallbackData = await offlineDB.getAll(storeName);
            if (fallbackData && fallbackData.length > 0) {
              return fallbackData;
            }
          } catch (offlineError) {}
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
           await new Promise(resolve => setTimeout(resolve, backoffDelay));
           if (attempt < retries - 1) continue;
         } else {
           connectionMonitor.recordError('network');
         }

        break;
      }
  }
  
  return [];
};

// NO CACHE OPERATIONS - all removed
export const invalidate = async (entityName) => {
  if (entityName === 'Patient') {
    try {
      await offlineDB.updateSyncMetadata('Patient', null, null, {
        scope_key: 'global',
        cache_schema_version: 0
      });
    } catch (error) {}
  }
};

export const getCached = (entityName) => {
  return null;
};

export const setCached = (entityName, data) => {
  // No-op - no cache to set
};

const loadBackgroundDeliveries = async (selectedDateStr, filters, onComplete, initialDeliveries = []) => {
  const today = new Date();
  const deliveryMap = new Map();
  
  initialDeliveries.forEach(d => deliveryMap.set(d.id, d));
  
  for (let i = 0; i <= 6; i++) {
    const fetchDate = new Date(today);
    fetchDate.setDate(today.getDate() + i);
    const fetchDateStr = format(fetchDate, 'yyyy-MM-dd');
    
    if (fetchDateStr === selectedDateStr) continue;
    
    try {
      const dateDeliveries = await loadDeliveriesForDate(fetchDateStr, filters, false);
      dateDeliveries.forEach(d => deliveryMap.set(d.id, d));
      
      if (i < 6) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (error) {}
  }
  
  onComplete(Array.from(deliveryMap.values()));
};

// NO CACHE OPERATIONS - all removed
export const invalidateDeliveryRangeCache = (specificDate = null) => {
  // No-op
};

export const updateCache = (entityName, id, newData) => {
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
    } catch (error) {}
  }
};

export const invalidateDeliveriesForDate = (dateString) => {
  // No-op
};

/**
 * Local-first write operations - exported for use in forms
 */
export const localWrites = {
  // Patient operations
  createPatient: createPatientLocal,
  updatePatient: updatePatientLocal,
  deletePatient: deletePatientLocal,
  
  // Delivery operations
  createDelivery: createDeliveryLocal,
  updateDelivery: updateDeliveryLocal,
  deleteDelivery: deleteDeliveryLocal,
  batchCreateDeliveries: batchCreateDeliveriesLocal,

  // City operations
  createCity: createCityLocal,
  updateCity: updateCityLocal,
  deleteCity: deleteCityLocal,

  // Store operations
  createStore: createStoreLocal,
  updateStore: updateStoreLocal,
  deleteStore: deleteStoreLocal,

  // Company operations
  createCompany: createCompanyLocal,
  updateCompany: updateCompanyLocal,
  deleteCompany: deleteCompanyLocal,
  
  // Subscribe to mutation events for UI updates
  subscribeMutations
};