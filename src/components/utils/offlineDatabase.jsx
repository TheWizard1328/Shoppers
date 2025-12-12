/**
 * Offline Database Manager using IndexedDB
 * Stores Patient and Delivery entities locally for offline access
 */

// CRITICAL: Use stable database name and version to prevent recreation
const DB_NAME = 'rxdeliver_persistent_offline_v1';
const DB_VERSION = 1;

// Store names
const STORES = {
  PATIENTS: 'patients',
  DELIVERIES: 'deliveries',
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

    request.onerror = () => {
      console.error('❌ [OfflineDB] Failed to open database:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      console.log('✅ [OfflineDB] Database opened successfully');
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      console.log('🔧 [OfflineDB] Upgrading database schema...');

      // Create Patients store
      if (!db.objectStoreNames.contains(STORES.PATIENTS)) {
        const patientStore = db.createObjectStore(STORES.PATIENTS, { keyPath: 'id' });
        patientStore.createIndex('store_id', 'store_id', { unique: false });
        patientStore.createIndex('updated_date', 'updated_date', { unique: false });
        console.log('✅ [OfflineDB] Created Patients store');
      }

      // Create Deliveries store
      if (!db.objectStoreNames.contains(STORES.DELIVERIES)) {
        const deliveryStore = db.createObjectStore(STORES.DELIVERIES, { keyPath: 'id' });
        deliveryStore.createIndex('delivery_date', 'delivery_date', { unique: false });
        deliveryStore.createIndex('driver_id', 'driver_id', { unique: false });
        deliveryStore.createIndex('store_id', 'store_id', { unique: false });
        deliveryStore.createIndex('updated_date', 'updated_date', { unique: false });
        deliveryStore.createIndex('date_driver', ['delivery_date', 'driver_id'], { unique: false });
        console.log('✅ [OfflineDB] Created Deliveries store');
      }

      // Create Sync Status store (tracks last sync times)
      if (!db.objectStoreNames.contains(STORES.SYNC_STATUS)) {
        db.createObjectStore(STORES.SYNC_STATUS, { keyPath: 'entity' });
        console.log('✅ [OfflineDB] Created Sync Status store');
      }

      // Create Pending Mutations store (queues local changes for backend sync)
      if (!db.objectStoreNames.contains(STORES.PENDING_MUTATIONS)) {
        const mutationStore = db.createObjectStore(STORES.PENDING_MUTATIONS, { keyPath: 'mutationId', autoIncrement: true });
        mutationStore.createIndex('entity', 'entity', { unique: false });
        mutationStore.createIndex('recordId', 'recordId', { unique: false });
        mutationStore.createIndex('timestamp', 'timestamp', { unique: false });
        console.log('✅ [OfflineDB] Created Pending Mutations store');
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
    
    console.log(`✅ [OfflineDB] Bulk saved ${successCount}/${records.length} records to ${storeName}`);
    return { success: true, count: successCount };
  } catch (error) {
    console.error(`❌ [OfflineDB] Bulk save failed for ${storeName}:`, error);
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
      request.onsuccess = () => {
        console.log(`📦 [OfflineDB] Retrieved ${request.result.length} records from ${storeName}`);
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error(`❌ [OfflineDB] Failed to get all from ${storeName}:`, error);
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
      request.onsuccess = () => {
        console.log(`📦 [OfflineDB] Retrieved ${request.result.length} records from ${storeName} by ${indexName}=${value}`);
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error(`❌ [OfflineDB] Failed to get by index ${indexName} from ${storeName}:`, error);
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
      request.onsuccess = () => {
        console.log(`📦 [OfflineDB] Retrieved ${request.result.length} records from ${storeName} by compound index`);
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error(`❌ [OfflineDB] Failed to get by compound index from ${storeName}:`, error);
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
 * Clear all data from a store
 */
const clearStore = async (storeName) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);

    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = () => {
        console.log(`🗑️ [OfflineDB] Cleared ${storeName}`);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error(`❌ [OfflineDB] Failed to clear ${storeName}:`, error);
  }
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
    console.error(`❌ [OfflineDB] Failed to get sync status for ${entityName}:`, error);
    return null;
  }
};

/**
 * Update sync status for an entity
 */
const updateSyncStatus = async (entityName, status) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.SYNC_STATUS], 'readwrite');
    const store = transaction.objectStore(STORES.SYNC_STATUS);

    const syncRecord = {
      entity: entityName,
      lastSyncTime: Date.now(),
      lastSyncDate: new Date().toISOString(),
      recordCount: status.recordCount || 0,
      status: status.status || 'synced'
    };

    return new Promise((resolve, reject) => {
      const request = store.put(syncRecord);
      request.onsuccess = () => {
        console.log(`✅ [OfflineDB] Updated sync status for ${entityName}`);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error(`❌ [OfflineDB] Failed to update sync status for ${entityName}:`, error);
  }
};

/**
 * Check if initial sync is needed
 */
const needsInitialSync = async (entityName) => {
  const syncStatus = await getSyncStatus(entityName);
  
  if (!syncStatus) {
    console.log(`🔄 [OfflineDB] ${entityName} needs initial sync (no status found)`);
    return true;
  }

  const daysSinceSync = (Date.now() - syncStatus.lastSyncTime) / (1000 * 60 * 60 * 24);
  
  if (daysSinceSync > 7) {
    console.log(`🔄 [OfflineDB] ${entityName} needs resync (last sync: ${daysSinceSync.toFixed(1)} days ago)`);
    return true;
  }

  console.log(`✅ [OfflineDB] ${entityName} is up to date (synced ${daysSinceSync.toFixed(1)} days ago, ${syncStatus.recordCount} records)`);
  return false;
};

/**
 * Get database statistics
 */
const getStats = async () => {
  try {
    const [patients, deliveries, patientSync, deliverySync] = await Promise.all([
      getAll(STORES.PATIENTS),
      getAll(STORES.DELIVERIES),
      getSyncStatus('Patient'),
      getSyncStatus('Delivery')
    ]);

    return {
      patients: {
        count: patients.length,
        lastSync: patientSync?.lastSyncDate || 'Never'
      },
      deliveries: {
        count: deliveries.length,
        lastSync: deliverySync?.lastSyncDate || 'Never'
      }
    };
  } catch (error) {
    console.error('❌ [OfflineDB] Failed to get stats:', error);
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
      request.onsuccess = () => {
        console.log(`✅ [OfflineDB] Added pending ${mutation.operation} for ${mutation.entity}:${mutation.recordId}`);
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('❌ [OfflineDB] Failed to add pending mutation:', error);
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
    console.error('❌ [OfflineDB] Failed to get pending mutations:', error);
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
      request.onsuccess = () => {
        console.log(`✅ [OfflineDB] Removed pending mutation ${mutationId}`);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('❌ [OfflineDB] Failed to remove pending mutation:', error);
  }
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
  } catch (error) {
    console.error('❌ [OfflineDB] Failed to update mutation retry:', error);
  }
};

export const offlineDB = {
  STORES,
  openDatabase,
  bulkSave,
  getAll,
  getByIndex,
  getByDate,
  getByCompoundIndex,
  clearStore,
  getSyncStatus,
  updateSyncStatus,
  needsInitialSync,
  getStats,
  addPendingMutation,
  getPendingMutations,
  removePendingMutation,
  updateMutationRetry
};