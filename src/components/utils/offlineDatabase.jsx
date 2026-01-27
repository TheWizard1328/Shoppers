/**
 * Offline Database Manager using IndexedDB
 * Stores Patient and Delivery entities locally for offline access
 */

// CRITICAL: Use stable database name and version to prevent recreation
const DB_NAME = 'rxdeliver_persistent_offline_v1';
const DB_VERSION = 4; // CRITICAL: Incremented to add DriverOverviewStatsCache

// DEBUG: Track version changes
console.log(`[OfflineDB] Database initialized: ${DB_NAME} v${DB_VERSION}`);

// Store names
const STORES = {
  PATIENTS: 'patients',
  DELIVERIES: 'deliveries',
  APP_USERS: 'app_users',
  CITIES: 'cities',
  STORES: 'stores',
  SQUARE_LOCATION_CONFIGS: 'square_location_configs',
  SQUARE_TRANSACTIONS: 'square_transactions',
  DRIVER_OVERVIEW_STATS: 'driver_overview_stats',
  SYNC_STATUS: 'sync_status',
  PENDING_MUTATIONS: 'pending_mutations'
};

let dbInstance = null;

/**
 * Initialize and open the IndexedDB database
 */
const openDatabase = () => {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      console.warn(`⚠️ [OfflineDB] onupgradeneeded triggered! Old version: ${event.oldVersion}, New version: ${event.newVersion}. This will trigger if DB_VERSION changes!`);

      if (!db.objectStoreNames.contains(STORES.PATIENTS)) {
        const patientStore = db.createObjectStore(STORES.PATIENTS, { keyPath: 'id' });
        patientStore.createIndex('store_id', 'store_id', { unique: false });
        patientStore.createIndex('updated_date', 'updated_date', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.DELIVERIES)) {
        const deliveryStore = db.createObjectStore(STORES.DELIVERIES, { keyPath: 'id' });
        deliveryStore.createIndex('delivery_date', 'delivery_date', { unique: false });
        deliveryStore.createIndex('driver_id', 'driver_id', { unique: false });
        deliveryStore.createIndex('store_id', 'store_id', { unique: false });
        deliveryStore.createIndex('updated_date', 'updated_date', { unique: false });
        deliveryStore.createIndex('date_driver', ['delivery_date', 'driver_id'], { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.APP_USERS)) {
        const appUserStore = db.createObjectStore(STORES.APP_USERS, { keyPath: 'id' });
        appUserStore.createIndex('user_id', 'user_id', { unique: true });
        appUserStore.createIndex('app_roles', 'app_roles', { multiEntry: true });
        appUserStore.createIndex('updated_date', 'updated_date', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.CITIES)) {
        const cityStore = db.createObjectStore(STORES.CITIES, { keyPath: 'id' });
        cityStore.createIndex('name', 'name', { unique: false });
        cityStore.createIndex('updated_date', 'updated_date', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.STORES)) {
        const storeStore = db.createObjectStore(STORES.STORES, { keyPath: 'id' });
        storeStore.createIndex('city_id', 'city_id', { unique: false });
        storeStore.createIndex('name', 'name', { unique: false });
        storeStore.createIndex('updated_date', 'updated_date', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SQUARE_LOCATION_CONFIGS)) {
        const configStore = db.createObjectStore(STORES.SQUARE_LOCATION_CONFIGS, { keyPath: 'id' });
        configStore.createIndex('square_location_id', 'square_location_id', { unique: false });
        configStore.createIndex('updated_date', 'updated_date', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SQUARE_TRANSACTIONS)) {
        const squareTxStore = db.createObjectStore(STORES.SQUARE_TRANSACTIONS, { keyPath: 'id' });
        squareTxStore.createIndex('delivery_id', 'delivery_id', { unique: false });
        squareTxStore.createIndex('updated_date', 'updated_date', { unique: false });
        squareTxStore.createIndex('status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SYNC_STATUS)) {
        db.createObjectStore(STORES.SYNC_STATUS, { keyPath: 'entity' });
      }

      if (!db.objectStoreNames.contains(STORES.PENDING_MUTATIONS)) {
        const mutationStore = db.createObjectStore(STORES.PENDING_MUTATIONS, { keyPath: 'mutationId', autoIncrement: true });
        mutationStore.createIndex('entity', 'entity', { unique: false });
        mutationStore.createIndex('recordId', 'recordId', { unique: false });
        mutationStore.createIndex('timestamp', 'timestamp', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.DRIVER_OVERVIEW_STATS)) {
        const statsStore = db.createObjectStore(STORES.DRIVER_OVERVIEW_STATS, { keyPath: 'id' });
        statsStore.createIndex('year', 'year', { unique: false });
        statsStore.createIndex('store_ids_hash', 'store_ids_hash', { unique: false });
        statsStore.createIndex('updated_date', 'updated_date', { unique: false });
      }

    };
  });
};

/**
 * Save multiple records to a store (bulk insert/update)
 */
const bulkSave = async (storeName, records) => {
  if (!records || records.length === 0) {
    return { success: true, count: 0 };
  }

  try {
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);

    let successCount = 0;
    const promises = records.map(record => {
      return new Promise((resolve, reject) => {
        const request = store.put(record);
        request.onsuccess = () => {
          successCount++;
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    });

    await Promise.all(promises);
    return { success: true, count: successCount };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Get all records from a store
 */
const getAll = async (storeName) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return [];
  }
};

/**
 * Get records by index query
 */
const getByIndex = async (storeName, indexName, value) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const index = store.index(indexName);

    return new Promise((resolve, reject) => {
      const request = index.getAll(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return [];
  }
};

/**
 * Get records by compound index (e.g., date + driver)
 */
const getByCompoundIndex = async (storeName, indexName, values) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const index = store.index(indexName);

    return new Promise((resolve, reject) => {
      const request = index.getAll(values);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return [];
  }
};

/**
 * Get records by date (shorthand for getByIndex with delivery_date)
 */
const getByDate = async (storeName, dateStr) => {
  return getByIndex(storeName, 'delivery_date', dateStr);
};

/**
 * Get all deliveries sorted by delivery_date in descending order (most recent first)
 */
const getDeliveriesSortedByDate = async (limit = null) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.DELIVERIES], 'readonly');
    const store = transaction.objectStore(STORES.DELIVERIES);
    const index = store.index('delivery_date');

    return new Promise((resolve, reject) => {
      const results = [];
      const request = index.openCursor(null, 'prev'); // 'prev' for descending order

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          results.push(cursor.value);
          if (limit && results.length >= limit) {
            resolve(results);
            return;
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return [];
  }
};

/**
 * Clear all data from a store
 */
const clearStore = async (storeName) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);

    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {}
};

/**
 * Get sync status for an entity
 */
const getSyncStatus = async (entityName) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.SYNC_STATUS], 'readonly');
    const store = transaction.objectStore(STORES.SYNC_STATUS);

    return new Promise((resolve, reject) => {
      const request = store.get(entityName);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return null;
  }
};

/**
 * Update sync status for an entity
 * CRITICAL: Preserves existing fields and merges with new status
 */
const updateSyncStatus = async (entityName, status) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.SYNC_STATUS], 'readwrite');
    const store = transaction.objectStore(STORES.SYNC_STATUS);

    // CRITICAL: Get existing record first to preserve lastFullSync
    const existingRecord = await new Promise((resolve) => {
      const getRequest = store.get(entityName);
      getRequest.onsuccess = () => resolve(getRequest.result || {});
      getRequest.onerror = () => resolve({});
    });

    const syncRecord = {
      ...existingRecord, // Preserve existing fields like lastFullSync
      entity: entityName,
      lastSyncTime: Date.now(),
      lastSyncDate: new Date().toISOString(),
      recordCount: status.recordCount || existingRecord.recordCount || 0,
      status: status.status || 'synced',
      // CRITICAL: Include lastSync and lastFullSync if provided
      lastSync: status.lastSync || new Date().toISOString(),
      ...(status.lastFullSync && { lastFullSync: status.lastFullSync })
    };

    return new Promise((resolve, reject) => {
      const request = store.put(syncRecord);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('❌ [OfflineDB] updateSyncStatus error:', error);
  }
};

/**
 * Check if initial sync is needed
 */
const needsInitialSync = async (entityName) => {
  const syncStatus = await getSyncStatus(entityName);
  if (!syncStatus) return true;
  const daysSinceSync = (Date.now() - syncStatus.lastSyncTime) / (1000 * 60 * 60 * 24);
  if (daysSinceSync > 7) return true;
  return false;
};

/**
 * Get database statistics
 */
const getStats = async () => {
  try {
    const [patients, deliveries, appUsers, cities, stores, squareTx, driverStats, patientSync, deliverySync, appUserSync, citySync, storeSync, squareTxSync] = await Promise.all([
      getAll(STORES.PATIENTS),
      getAll(STORES.DELIVERIES),
      getAll(STORES.APP_USERS),
      getAll(STORES.CITIES),
      getAll(STORES.STORES),
      getAll(STORES.SQUARE_TRANSACTIONS),
      getAll(STORES.DRIVER_OVERVIEW_STATS),
      getSyncStatus('Patient'),
      getSyncStatus('Delivery'),
      getSyncStatus('AppUser'),
      getSyncStatus('City'),
      getSyncStatus('Store'),
      getSyncStatus('SquareTransaction')
    ]);

    return {
      patients: {
        count: patients.length,
        lastSync: patientSync?.lastSyncDate || 'Never'
      },
      deliveries: {
        count: deliveries.length,
        lastSync: deliverySync?.lastSyncDate || 'Never'
      },
      appUsers: {
        count: appUsers.length,
        lastSync: appUserSync?.lastSyncDate || 'Never'
      },
      cities: {
        count: cities.length,
        lastSync: citySync?.lastSyncDate || 'Never'
      },
      stores: {
        count: stores.length,
        lastSync: storeSync?.lastSyncDate || 'Never'
      },
      squareTransactions: {
        count: squareTx.length,
        lastSync: squareTxSync?.lastSyncDate || 'Never'
      },
      driverOverviewStats: {
        count: driverStats.length,
        lastSync: deliverySync?.lastSyncDate || 'Never' // Use delivery sync time since they're related
      }
    };
  } catch (error) {
    return null;
  }
};

/**
 * Add a pending mutation to the queue
 */
const addPendingMutation = async (mutation) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.PENDING_MUTATIONS], 'readwrite');
    const store = transaction.objectStore(STORES.PENDING_MUTATIONS);

    const mutationRecord = {
      ...mutation,
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
      retryCount: 0,
      status: 'pending'
    };

    return new Promise((resolve, reject) => {
      const request = store.add(mutationRecord);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    throw error;
  }
};

/**
 * Get all pending mutations
 */
const getPendingMutations = async () => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.PENDING_MUTATIONS], 'readonly');
    const store = transaction.objectStore(STORES.PENDING_MUTATIONS);

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return [];
  }
};

/**
 * Remove a pending mutation after successful sync
 */
const removePendingMutation = async (mutationId) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.PENDING_MUTATIONS], 'readwrite');
    const store = transaction.objectStore(STORES.PENDING_MUTATIONS);

    return new Promise((resolve, reject) => {
      const request = store.delete(mutationId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {}
};

/**
 * Update retry count for a pending mutation
 */
const updateMutationRetry = async (mutationId, retryCount) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.PENDING_MUTATIONS], 'readwrite');
    const store = transaction.objectStore(STORES.PENDING_MUTATIONS);

    return new Promise((resolve, reject) => {
      const getRequest = store.get(mutationId);
      getRequest.onsuccess = () => {
        const mutation = getRequest.result;
        if (mutation) {
          mutation.retryCount = retryCount;
          mutation.lastRetryAt = new Date().toISOString();
          const updateRequest = store.put(mutation);
          updateRequest.onsuccess = () => resolve();
          updateRequest.onerror = () => reject(updateRequest.error);
        } else {
          resolve();
        }
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  } catch (error) {}
};

/**
 * Get a single record by ID
 */
const getById = async (storeName, recordId) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);

    return new Promise((resolve, reject) => {
      const request = store.get(recordId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return null;
  }
};

/**
 * Delete a single record from a store by ID
 */
const deleteRecord = async (storeName, recordId) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);

    return new Promise((resolve, reject) => {
      const request = store.delete(recordId);
      request.onsuccess = () => resolve({ success: true });
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Clear all data from all stores (emergency recovery)
 * CRITICAL: Log caller to track down who's calling this
 */
const clearAllData = async () => {
  console.error('🚨 [OfflineDB] clearAllData called! Stack trace:', new Error().stack);
  try {
    const db = await openDatabase();
    const allStores = Object.values(STORES);
    
    for (const storeName of allStores) {
      await clearStore(storeName);
    }
    
    console.log('✅ [OfflineDB] All data cleared');
    return { success: true };
  } catch (error) {
    console.error('❌ [OfflineDB] clearAllData error:', error);
    return { success: false, error: error.message };
  }
};

export const offlineDB = {
  STORES,
  openDatabase,
  bulkSave,
  getAll,
  getById,
  getByIndex,
  getByDate,
  getByCompoundIndex,
  getDeliveriesSortedByDate,
  clearStore,
  clearAllData,
  getSyncStatus,
  updateSyncStatus,
  needsInitialSync,
  getStats,
  addPendingMutation,
  getPendingMutations,
  removePendingMutation,
  updateMutationRetry,
  deleteRecord
};