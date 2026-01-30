/**
 * Offline Database Manager using IndexedDB
 * Stores Patient and Delivery entities locally for offline access
 */

// CRITICAL: Use stable database name and version to prevent recreation
const DB_NAME = 'rxdeliver_persistent_offline_v1';
const DB_VERSION = 5; // Incremented to add SYNC_METADATA store

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
  PENDING_MUTATIONS: 'pending_mutations',
  SYNC_METADATA: 'sync_metadata' // Timestamp tracking per entity
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

      if (!db.objectStoreNames.contains(STORES.SYNC_METADATA)) {
        db.createObjectStore(STORES.SYNC_METADATA, { keyPath: 'entity_name' });
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
        lastSync: patientSync?.lastSync || patientSync?.lastSyncDate || 'Never'
      },
      deliveries: {
        count: deliveries.length,
        lastSync: deliverySync?.lastSync || deliverySync?.lastSyncDate || 'Never'
      },
      appUsers: {
        count: appUsers.length,
        lastSync: appUserSync?.lastSync || appUserSync?.lastSyncDate || 'Never'
      },
      cities: {
        count: cities.length,
        lastSync: citySync?.lastSync || citySync?.lastSyncDate || 'Never'
      },
      stores: {
        count: stores.length,
        lastSync: storeSync?.lastSync || storeSync?.lastSyncDate || 'Never'
      },
      squareTransactions: {
        count: squareTx.length,
        lastSync: squareTxSync?.lastSync || squareTxSync?.lastSyncDate || 'Never'
      },
      driverOverviewStats: {
        count: driverStats.length,
        lastSync: deliverySync?.lastSync || deliverySync?.lastSyncDate || 'Never' // Use delivery sync time since they're related
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
 * Get sync metadata for an entity (latest server timestamp)
 */
const getSyncMetadata = async (entityName) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.SYNC_METADATA], 'readonly');
    const store = transaction.objectStore(STORES.SYNC_METADATA);

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
 * Update sync metadata for an entity
 * Stores the last synced timestamp (updated_date from server's newest record)
 */
const updateSyncMetadata = async (entityName, latestServerTimestamp) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.SYNC_METADATA], 'readwrite');
    const store = transaction.objectStore(STORES.SYNC_METADATA);

    const metadata = {
      entity_name: entityName,
      last_synced_timestamp: latestServerTimestamp,
      last_sync_date: new Date().toISOString()
    };

    return new Promise((resolve, reject) => {
      const request = store.put(metadata);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('❌ [OfflineDB] updateSyncMetadata error:', error);
  }
};

/**
 * Clear all data from all stores (emergency recovery)
 */
const clearAllData = async () => {
  try {
    const db = await openDatabase();
    const allStores = Object.values(STORES);
    
    for (const storeName of allStores) {
      await clearStore(storeName);
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Deduplicate AppUser records - keep only the most recent per user_id
 * CRITICAL: Removes duplicate driver entries from offline database
 */
const deduplicateAppUsers = async () => {
  try {
    const allAppUsers = await getAll(STORES.APP_USERS);
    
    if (!allAppUsers || allAppUsers.length === 0) {
      console.log('✅ [OfflineDB] No AppUsers to deduplicate');
      return { success: true, removed: 0 };
    }

    // Group by user_id
    const userIdMap = new Map();
    allAppUsers.forEach(appUser => {
      if (!appUser?.user_id) return;
      
      const existing = userIdMap.get(appUser.user_id);
      
      if (!existing) {
        userIdMap.set(appUser.user_id, appUser);
      } else {
        // Keep the one with the most recent updated_date
        const existingTime = new Date(existing.updated_date || 0).getTime();
        const newTime = new Date(appUser.updated_date || 0).getTime();
        
        if (newTime > existingTime) {
          userIdMap.set(appUser.user_id, appUser);
        }
      }
    });

    const deduplicated = Array.from(userIdMap.values());
    const removedCount = allAppUsers.length - deduplicated.length;

    if (removedCount > 0) {
      await clearStore(STORES.APP_USERS);
      await bulkSave(STORES.APP_USERS, deduplicated);
      return { success: true, removed: removedCount };
    }

    return { success: true, removed: 0 };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Deduplicate Delivery records - keeps most recent based on status priority
 * CRITICAL: Groups by delivery_date, driver_id, and stop_id
 * Rules:
 * - If all have same status → keep most recent
 * - If mixed statuses → keep the completed one (prioritized)
 * - If no completed but mixed in_transit/en_route → keep most recent
 */
/**
 * Delete all deliveries for a specific date using the delivery_date index
 * CRITICAL: Used by route importer to purge stale data before resync
 */
const deleteDeliveriesByDate = async (dateStr) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.DELIVERIES], 'readwrite');
    const store = transaction.objectStore(STORES.DELIVERIES);
    const index = store.index('delivery_date');

    return new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.only(dateStr));
      let deleteCount = 0;
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          deleteCount++;
          cursor.continue();
        } else {
          transaction.oncomplete = () => {
            resolve({ success: true, deleted: deleteCount });
          };
          transaction.onerror = () => {
            reject(new Error(`Transaction failed: ${transaction.error}`));
          };
        }
      };
      
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    throw error;
  }
};

const deduplicateDeliveries = async () => {
   try {
     const allDeliveries = await getAll(STORES.DELIVERIES);

     if (!allDeliveries || allDeliveries.length === 0) {
       return { success: true, removed: 0 };
     }

     // CRITICAL: Include driver_id in grouping to prevent cross-driver duplicates
     const groupKey = (d) => `${d.delivery_date}|${d.stop_id}|${d.driver_id || 'no-driver'}`;
     const deliveryGroups = new Map();

     allDeliveries.forEach(delivery => {
       if (!delivery?.delivery_date || !delivery?.stop_id) {
         return;
       }

       const key = groupKey(delivery);
       if (!deliveryGroups.has(key)) {
         deliveryGroups.set(key, []);
       }
       deliveryGroups.get(key).push(delivery);
     });

     const deduplicated = [];
     let removedCount = 0;

     for (const [key, group] of deliveryGroups) {
       if (group.length === 1) {
         deduplicated.push(group[0]);
         continue;
       }

       const statusCounts = {};
       group.forEach(d => {
         statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
       });

       const uniqueStatuses = Object.keys(statusCounts);
       let selectedDelivery;

       if (uniqueStatuses.length === 1) {
         selectedDelivery = group.reduce((latest, current) => {
           const latestTime = new Date(latest.updated_date || 0).getTime();
           const currentTime = new Date(current.updated_date || 0).getTime();
           return currentTime > latestTime ? current : latest;
         });
       } else {
         const completed = group.find(d => d.status === 'completed');
         if (completed) {
           selectedDelivery = completed;
         } else {
           selectedDelivery = group.reduce((latest, current) => {
             const latestTime = new Date(latest.updated_date || 0).getTime();
             const currentTime = new Date(current.updated_date || 0).getTime();
             return currentTime > latestTime ? current : latest;
           });
         }
       }

       deduplicated.push(selectedDelivery);
       removedCount += group.length - 1;
     }

     const pickupDeliveries = allDeliveries.filter(d => !d?.stop_id);
     deduplicated.push(...pickupDeliveries);

     if (removedCount > 0) {
       await clearStore(STORES.DELIVERIES);
       await bulkSave(STORES.DELIVERIES, deduplicated);
       return { success: true, removed: removedCount };
     }

     return { success: true, removed: 0 };
   } catch (error) {
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
  deleteRecord,
  deduplicateAppUsers,
  deduplicateDeliveries,
  deleteDeliveriesByDate,
  getSyncMetadata,
  updateSyncMetadata
};