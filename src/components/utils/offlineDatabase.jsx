/**
 * Offline Database Manager using IndexedDB
 * Stores Patient and Delivery entities locally for offline access
 */

// CRITICAL: Use an app-scoped database name so different preview hosts don't fight over the same IndexedDB
const DB_VERSION = 9; // Incremented to add Company offline store
const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_SCOPE = 'global';

const CANONICAL_DB_NAME = 'rxdeliver_persistent_offline_v1';
const getScopedDbName = () => CANONICAL_DB_NAME;

const getLegacyFallbackDbNames = () => {
  const names = [
    'rxdeliver_persistent_offline_v1_preview--wizard-worxx-2408a9d6_base44_app'
  ];
  return Array.from(new Set(names.filter((name) => name && name !== CANONICAL_DB_NAME)));
};

// Store names
const STORES = {
  PATIENTS: 'patients',
  DELIVERIES: 'deliveries',
  APP_USERS: 'app_users',
  CITIES: 'cities',
  STORES: 'stores',
  COMPANIES: 'companies',
  SQUARE_LOCATION_CONFIGS: 'square_location_configs',
  SQUARE_CATALOG_ITEMS: 'square_catalog_items',
  SQUARE_TRANSACTIONS: 'square_transactions',
  DRIVER_OVERVIEW_STATS: 'driver_overview_stats',
  SYNC_STATUS: 'sync_status',
  PENDING_MUTATIONS: 'pending_mutations',
  SYNC_METADATA: 'sync_metadata', // Timestamp tracking per entity
  PENDING_BREADCRUMBS: 'pending_breadcrumbs', // Temporary GPS breadcrumbs [lat, lng, timestamp_ms] being collected for current route
  DRIVER_ROUTE_POLYLINES: 'driver_route_polylines'
};

let dbInstance = null;
let dbOpenPromise = null; // CRITICAL: Prevent multiple simultaneous opens
let migrationPromise = null;

const buildMetadataKey = (entityName, scopeKey = DEFAULT_CACHE_SCOPE) => {
  if (!scopeKey || scopeKey === DEFAULT_CACHE_SCOPE) return entityName;
  return `${entityName}::${scopeKey}`;
};

const getLatestRecordTimestamp = (records = []) => {
  if (!Array.isArray(records) || records.length === 0) return null;
  let latest = 0;
  records.forEach((record) => {
    const value = record?.updated_date || record?.last_generated_at || record?.created_date || null;
    const ts = value ? new Date(value).getTime() : 0;
    if (ts > latest) latest = ts;
  });
  return latest ? new Date(latest).toISOString() : null;
};

const buildDataVersion = (records = []) => {
  if (!Array.isArray(records) || records.length === 0) {
    return '0:empty';
  }

  const latestTimestamp = getLatestRecordTimestamp(records) || 'none';
  const sortedIds = records.map((record) => record?.id).filter(Boolean).sort();
  const firstId = sortedIds[0] || 'none';
  const lastId = sortedIds[sortedIds.length - 1] || 'none';

  return `${records.length}:${latestTimestamp}:${firstId}:${lastId}`;
};

const copyStoreRecords = async (sourceDb, targetDb, storeName) => {
  if (!sourceDb.objectStoreNames.contains(storeName) || !targetDb.objectStoreNames.contains(storeName)) return 0;

  const sourceTx = sourceDb.transaction([storeName], 'readonly');
  const sourceStore = sourceTx.objectStore(storeName);
  const records = await new Promise((resolve, reject) => {
    const request = sourceStore.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  }).catch(() => []);

  if (!records.length) return 0;

  const targetTx = targetDb.transaction([storeName], 'readwrite');
  const targetStore = targetTx.objectStore(storeName);
  await Promise.all(records.map((record) => new Promise((resolve, reject) => {
    const request = targetStore.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).catch(() => null)));

  await new Promise((resolve, reject) => {
    targetTx.oncomplete = () => resolve();
    targetTx.onerror = () => reject(targetTx.error);
    targetTx.onabort = () => reject(targetTx.error);
  }).catch(() => null);

  return records.length;
};

const migrateLegacyDataIfNeeded = async (targetDb) => {
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    try {
      if (!targetDb?.objectStoreNames?.contains(STORES.DELIVERIES)) return;

      const existingDeliveries = await new Promise((resolve, reject) => {
        const tx = targetDb.transaction([STORES.DELIVERIES], 'readonly');
        const store = tx.objectStore(STORES.DELIVERIES);
        const request = store.count();
        request.onsuccess = () => resolve(request.result || 0);
        request.onerror = () => reject(request.error);
      }).catch(() => 0);

      if (existingDeliveries > 0) return;

      const fallbackNames = getLegacyFallbackDbNames();
      let bestSourceDb = null;
      let bestSourceCount = 0;

      for (const fallbackName of fallbackNames) {
        const sourceDb = await new Promise((resolve) => {
          const request = indexedDB.open(fallbackName);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          request.onupgradeneeded = () => {
            request.transaction?.abort?.();
            resolve(null);
          };
        });

        if (!sourceDb) continue;

        const sourceDeliveryCount = await new Promise((resolve, reject) => {
          if (!sourceDb.objectStoreNames.contains(STORES.DELIVERIES)) {
            resolve(0);
            return;
          }
          const tx = sourceDb.transaction([STORES.DELIVERIES], 'readonly');
          const store = tx.objectStore(STORES.DELIVERIES);
          const request = store.count();
          request.onsuccess = () => resolve(request.result || 0);
          request.onerror = () => reject(request.error);
        }).catch(() => 0);

        if (sourceDeliveryCount > bestSourceCount) {
          if (bestSourceDb) bestSourceDb.close();
          bestSourceDb = sourceDb;
          bestSourceCount = sourceDeliveryCount;
        } else {
          sourceDb.close();
        }
      }

      if (bestSourceDb && bestSourceCount > 0) {
        const storesToCopy = Object.values(STORES);
        for (const storeName of storesToCopy) {
          await copyStoreRecords(bestSourceDb, targetDb, storeName);
        }
        bestSourceDb.close();
      }
    } finally {
      migrationPromise = null;
    }
  })();

  return migrationPromise;
};

/**
 * Initialize and open the IndexedDB database
 * CRITICAL: Uses promise pooling to prevent race conditions
 */
const openDatabase = () => {
  // If already open, return immediately
  if (dbInstance && !dbInstance.isClosing) {
    return Promise.resolve(dbInstance);
  }

  // If currently opening, wait for that operation to complete
  if (dbOpenPromise) {
    return dbOpenPromise;
  }

  // Start new open operation
  dbOpenPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(getScopedDbName(), DB_VERSION);

    request.onerror = () => {
      dbOpenPromise = null;
      reject(request.error);
    };
    
    request.onsuccess = () => {
      dbInstance = request.result;
      
      // CRITICAL: Handle unexpected close events
      dbInstance.onclose = () => {
        console.warn('⚠️ [OfflineDB] Database connection closed unexpectedly');
        dbInstance = null;
        dbOpenPromise = null;
      };
      
      dbInstance.onversionchange = () => {
        console.warn('⚠️ [OfflineDB] Database version change detected - closing gracefully');
        dbInstance.close();
        dbInstance = null;
        dbOpenPromise = null;
      };
      
      dbOpenPromise = null;
      migrateLegacyDataIfNeeded(dbInstance)
        .then(() => resolve(dbInstance))
        .catch(() => resolve(dbInstance));
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

      if (!db.objectStoreNames.contains(STORES.COMPANIES)) {
        const companyStore = db.createObjectStore(STORES.COMPANIES, { keyPath: 'id' });
        companyStore.createIndex('name', 'name', { unique: false });
        companyStore.createIndex('status', 'status', { unique: false });
        companyStore.createIndex('updated_date', 'updated_date', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SQUARE_LOCATION_CONFIGS)) {
        const configStore = db.createObjectStore(STORES.SQUARE_LOCATION_CONFIGS, { keyPath: 'id' });
        configStore.createIndex('square_location_id', 'square_location_id', { unique: false });
        configStore.createIndex('updated_date', 'updated_date', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.SQUARE_CATALOG_ITEMS)) {
        const squareCatalogStore = db.createObjectStore(STORES.SQUARE_CATALOG_ITEMS, { keyPath: 'id' });
        squareCatalogStore.createIndex('delivery_id', 'delivery_id', { unique: false });
        squareCatalogStore.createIndex('location_id', 'location_id', { unique: false });
        squareCatalogStore.createIndex('status', 'status', { unique: false });
        squareCatalogStore.createIndex('updated_date', 'updated_date', { unique: false });
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

      if (!db.objectStoreNames.contains(STORES.PENDING_BREADCRUMBS)) {
        const breadcrumbStore = db.createObjectStore(STORES.PENDING_BREADCRUMBS, { keyPath: 'driver_id' });
        breadcrumbStore.createIndex('timestamp', 'timestamp', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORES.DRIVER_ROUTE_POLYLINES)) {
        const polyStore = db.createObjectStore(STORES.DRIVER_ROUTE_POLYLINES, { keyPath: 'id' });
        polyStore.createIndex('driver_id', 'driver_id', { unique: false });
        polyStore.createIndex('delivery_date', 'delivery_date', { unique: false });
        polyStore.createIndex('updated_date', 'updated_date', { unique: false });
        polyStore.createIndex('segment_origin_lat', 'segment_origin_lat', { unique: false });
        polyStore.createIndex('segment_origin_lon', 'segment_origin_lon', { unique: false });
        polyStore.createIndex('segment_dest_lat', 'segment_dest_lat', { unique: false });
        polyStore.createIndex('segment_dest_lon', 'segment_dest_lon', { unique: false });
      }

      };
  });
};

/**
 * Save a single record to a store
 */
const save = async (storeName, record) => {
  if (!record) {
    return { success: false, error: 'No record provided' };
  }

  try {
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const keyPath = store.keyPath;
    const normalizedRecord = keyPath && typeof keyPath === 'string' && (record[keyPath] === undefined || record[keyPath] === null || record[keyPath] === '')
      ? { ...record, [keyPath]: record.id || `${storeName}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` }
      : record;

    return new Promise((resolve, reject) => {
      const request = store.put(normalizedRecord);
      request.onsuccess = () => resolve({ success: true });
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Save multiple records to a store (bulk insert/update)
 * CRITICAL: Deduplicates by ID before saving to prevent duplicates
 */
const bulkSave = async (storeName, records) => {
  if (!records || records.length === 0) {
    return { success: true, count: 0 };
  }

  // CRITICAL: Deduplicate by ID BEFORE saving
  const uniqueRecords = new Map();
  records.forEach(record => {
    if (record?.id) {
      uniqueRecords.set(record.id, record);
    }
  });
  
  const deduplicatedRecords = Array.from(uniqueRecords.values());
  const duplicatesRemoved = records.length - deduplicatedRecords.length;
  
  if (duplicatesRemoved > 0) {
    console.warn(`⚠️ [OfflineDB] bulkSave removed ${duplicatesRemoved} duplicate IDs before saving to ${storeName}`);
  }

  try {
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);

    let successCount = 0;
    const promises = deduplicatedRecords.map(record => {
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

const replaceAllRecords = async (storeName, records = [], options = {}) => {
  const { allowEmptyReplace = false } = options;
  try {
    const existingRecords = await getAll(storeName);
    if ((!records || records.length === 0) && existingRecords.length > 0 && !allowEmptyReplace) {
      console.warn(`⚠️ [OfflineDB] Skipping replaceAllRecords for ${storeName} because incoming data is empty while existing store has ${existingRecords.length} records`);
      return { success: true, skipped: true, count: existingRecords.length };
    }
    await clearStore(storeName);
    if (!records || records.length === 0) {
      return { success: true, count: 0 };
    }
    return await bulkSave(storeName, records);
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const replaceRecordsByIndex = async (storeName, indexName, indexValue, records = [], options = {}) => {
  const { allowEmptyReplace = false } = options;
  try {
    const existingRecords = await getByIndex(storeName, indexName, indexValue);
    if ((!records || records.length === 0) && existingRecords.length > 0 && !allowEmptyReplace) {
      console.warn(`⚠️ [OfflineDB] Skipping replaceRecordsByIndex for ${storeName}/${indexName}=${indexValue} because incoming data is empty while existing set has ${existingRecords.length} records`);
      return { success: true, skipped: true, count: existingRecords.length };
    }
    const db = await openDatabase();
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    const index = store.index(indexName);

    await new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.only(indexValue));
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = () => reject(request.error);
    });

    const uniqueRecords = new Map();
    (records || []).forEach((record) => {
      if (record?.id) uniqueRecords.set(record.id, record);
    });

    const deduplicatedRecords = Array.from(uniqueRecords.values());
    for (const record of deduplicatedRecords) {
      await new Promise((resolve, reject) => {
        const putRequest = store.put(record);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      });
    }

    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    return { success: true, count: deduplicatedRecords.length };
  } catch (error) {
    return { success: false, error: error.message };
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
 * CRITICAL: Always return valid stats object, never null
 */
const getStats = async () => {
  try {
    const [patients, deliveries, appUsers, cities, stores, companies, squareTx, driverStats, patientSync, deliverySync, appUserSync, citySync, storeSync, companySync, squareTxSync] = await Promise.all([
      getAll(STORES.PATIENTS),
      getAll(STORES.DELIVERIES),
      getAll(STORES.APP_USERS),
      getAll(STORES.CITIES),
      getAll(STORES.STORES),
      getAll(STORES.COMPANIES),
      getAll(STORES.SQUARE_TRANSACTIONS),
      getAll(STORES.DRIVER_OVERVIEW_STATS),
      getSyncStatus('Patient'),
      getSyncStatus('Delivery'),
      getSyncStatus('AppUser'),
      getSyncStatus('City'),
      getSyncStatus('Store'),
      getSyncStatus('Company'),
      getSyncStatus('SquareTransaction')
    ]);

    return {
      patients: {
        count: patients?.length || 0,
        lastSync: patientSync?.lastSync || patientSync?.lastSyncDate || 'Never'
      },
      deliveries: {
        count: deliveries?.length || 0,
        lastSync: deliverySync?.lastSync || deliverySync?.lastSyncDate || 'Never'
      },
      appUsers: {
        count: appUsers?.length || 0,
        lastSync: appUserSync?.lastSync || appUserSync?.lastSyncDate || 'Never'
      },
      cities: {
        count: cities?.length || 0,
        lastSync: citySync?.lastSync || citySync?.lastSyncDate || 'Never'
      },
      stores: {
        count: stores?.length || 0,
        lastSync: storeSync?.lastSync || storeSync?.lastSyncDate || 'Never'
      },
      companies: {
        count: companies?.length || 0,
        lastSync: companySync?.lastSync || companySync?.lastSyncDate || 'Never'
      },
      squareTransactions: {
        count: squareTx?.length || 0,
        lastSync: squareTxSync?.lastSync || squareTxSync?.lastSyncDate || 'Never'
      },
      driverOverviewStats: {
        count: driverStats?.length || 0,
        lastSync: deliverySync?.lastSync || deliverySync?.lastSyncDate || 'Never'
      }
    };
  } catch (error) {
    console.error('❌ [getStats] Error retrieving stats:', error);
    // CRITICAL: Return default stats structure instead of null
    return {
      patients: { count: 0, lastSync: 'Never' },
      deliveries: { count: 0, lastSync: 'Never' },
      appUsers: { count: 0, lastSync: 'Never' },
      cities: { count: 0, lastSync: 'Never' },
      stores: { count: 0, lastSync: 'Never' },
      companies: { count: 0, lastSync: 'Never' },
      squareTransactions: { count: 0, lastSync: 'Never' },
      driverOverviewStats: { count: 0, lastSync: 'Never' }
    };
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
const getSyncMetadata = async (entityName, scopeKey = DEFAULT_CACHE_SCOPE) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.SYNC_METADATA], 'readonly');
    const store = transaction.objectStore(STORES.SYNC_METADATA);
    const metadataKey = buildMetadataKey(entityName, scopeKey);

    return new Promise((resolve, reject) => {
      const request = store.get(metadataKey);
      request.onsuccess = () => {
        const result = request.result || null;
        if (result && result.last_sync_date && !result.last_sync_time) {
          result.last_sync_time = result.last_sync_date;
        }
        resolve(result);
      };
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
const updateSyncMetadata = async (entityName, latestServerTimestamp, lastSyncTime = null, additionalMetadata = {}) => {
  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORES.SYNC_METADATA], 'readwrite');
    const store = transaction.objectStore(STORES.SYNC_METADATA);
    const scopeKey = additionalMetadata.scope_key || DEFAULT_CACHE_SCOPE;
    const metadataKey = buildMetadataKey(entityName, scopeKey);

    const metadata = {
      entity_name: metadataKey,
      source_entity_name: entityName,
      scope_key: scopeKey,
      last_synced_timestamp: latestServerTimestamp,
      last_sync_time: lastSyncTime || new Date().toISOString(),
      last_sync_date: new Date().toISOString(),
      ...additionalMetadata
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

const getCacheValidation = async (entityName, options = {}) => {
  const {
    scopeKey = DEFAULT_CACHE_SCOPE,
    maxAgeMs = 5 * 60 * 1000,
    minRecordCount = 1,
    allowEmpty = false,
    requiredCacheSchemaVersion = CACHE_SCHEMA_VERSION
  } = options;

  const meta = await getSyncMetadata(entityName, scopeKey);
  if (!meta) {
    return { isValid: false, reason: 'missing', meta: null, ageMs: Infinity, recordCount: 0 };
  }

  const lastSyncMs = new Date(meta.last_sync_time || meta.last_sync_date || 0).getTime();
  const ageMs = lastSyncMs ? Date.now() - lastSyncMs : Infinity;
  const recordCount = typeof meta.record_count === 'number' ? meta.record_count : 0;
  const cacheSchemaVersion = meta.cache_schema_version || 0;

  if (cacheSchemaVersion !== requiredCacheSchemaVersion) {
    return { isValid: false, reason: 'schema_mismatch', meta, ageMs, recordCount };
  }

  if (ageMs > maxAgeMs) {
    return { isValid: false, reason: 'stale', meta, ageMs, recordCount };
  }

  if (!allowEmpty && recordCount < minRecordCount) {
    return { isValid: false, reason: 'insufficient_records', meta, ageMs, recordCount };
  }

  return { isValid: true, reason: 'fresh', meta, ageMs, recordCount };
};

const updateCacheSnapshot = async (entityName, records = [], options = {}) => {
  const {
    scopeKey = DEFAULT_CACHE_SCOPE,
    lastSyncTime = null,
    syncType = 'full',
    extra = {}
  } = options;

  const safeRecords = Array.isArray(records) ? records.filter(Boolean) : [];
  const latestTimestamp = getLatestRecordTimestamp(safeRecords);
  const dataVersion = buildDataVersion(safeRecords);

  await updateSyncMetadata(entityName, latestTimestamp, lastSyncTime, {
    scope_key: scopeKey,
    cache_schema_version: CACHE_SCHEMA_VERSION,
    data_version: dataVersion,
    record_count: safeRecords.length,
    sync_type: syncType,
    ...extra
  });

  return {
    scopeKey,
    dataVersion,
    recordCount: safeRecords.length,
    latestTimestamp
  };
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

/**
 * Prune historical deliveries - keeps max 60 days per user
 * CRITICAL: Reduces mobile database size by removing old routes
 * CRITICAL: Only runs on mobile devices
 */
const pruneDeliveriesOlderThan60Days = async () => {
  try {
    // CRITICAL: Mobile devices only
    const { isMobileDevice } = await import('./deviceUtils');
    if (!isMobileDevice()) {
      return { success: true, removed: 0, skipped: true };
    }

    const allDeliveries = await getAll(STORES.DELIVERIES);

    if (!allDeliveries || allDeliveries.length === 0) {
      return { success: true, removed: 0 };
    }

    const now = new Date();
    const cutoffDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0]; // YYYY-MM-DD format

    // Group deliveries by driver_id
    const deliveriesByDriver = new Map();
    allDeliveries.forEach(delivery => {
      if (!delivery?.driver_id) return;
      if (!deliveriesByDriver.has(delivery.driver_id)) {
        deliveriesByDriver.set(delivery.driver_id, []);
      }
      deliveriesByDriver.get(delivery.driver_id).push(delivery);
    });

    let removedCount = 0;
    const deliveriesToKeep = [];

    // For each driver, remove deliveries older than 60 days
    deliveriesByDriver.forEach((driverDeliveries, driverId) => {
      driverDeliveries.forEach(delivery => {
        if (delivery.delivery_date && delivery.delivery_date >= cutoffDateStr) {
          deliveriesToKeep.push(delivery);
        } else {
          removedCount++;
        }
      });
    });

    // Also keep deliveries without driver_id (shouldn't happen, but safety)
    allDeliveries.forEach(delivery => {
      if (!delivery?.driver_id) {
        deliveriesToKeep.push(delivery);
      }
    });

    if (removedCount > 0) {
      await clearStore(STORES.DELIVERIES);
      await bulkSave(STORES.DELIVERIES, deliveriesToKeep);
      console.log(`✅ [OfflineDB] Pruned ${removedCount} deliveries older than 60 days`);
      return { success: true, removed: removedCount };
    }

    return { success: true, removed: 0 };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Deduplicate DriverRoutePolyline records in offline DB (IndexedDB)
 * Keeps the most recent by last_generated_at/updated_date per leg signature
 */
const deduplicateDriverRoutePolylines = async (dateStr = null) => {
  try {
    const records = dateStr
      ? await getByIndex(STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', dateStr)
      : await getAll(STORES.DRIVER_ROUTE_POLYLINES);
    if (!records?.length) return { success: true, removed: 0 };

    const groups = new Map();
    records.forEach((r) => {
      if (!r) return;
      const key = [
        String(r.driver_id || ''),
        String(r.delivery_date || ''),
        Number(r.segment_origin_lat)?.toFixed?.(5),
        Number(r.segment_origin_lon)?.toFixed?.(5),
        Number(r.segment_dest_lat)?.toFixed?.(5),
        Number(r.segment_dest_lon)?.toFixed?.(5)
      ].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });

    let removed = 0;
    for (const [, arr] of groups) {
      if (!arr || arr.length <= 1) continue;
      arr.sort((a, b) => {
        const ta = new Date(a.last_generated_at || a.updated_date || a.created_date || 0).getTime();
        const tb = new Date(b.last_generated_at || b.updated_date || b.created_date || 0).getTime();
        return tb - ta;
      });
      const toDelete = arr.slice(1);
      await Promise.all(
        toDelete.map((rec) =>
          deleteRecord(STORES.DRIVER_ROUTE_POLYLINES, rec.id)
            .then(() => { removed++; })
            .catch(() => null)
        )
      );
    }

    return { success: true, removed };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

export const offlineDB = {
  STORES,
  getDbName: getScopedDbName,
  getLegacyFallbackDbNames,
  openDatabase,
  save,
  bulkSave,
  getAll,
  getById,
  getByIndex,
  getByDate,
  getByCompoundIndex,
  getDeliveriesSortedByDate,
  clearStore,
  replaceAllRecords,
  replaceRecordsByIndex,
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
  pruneDeliveriesOlderThan60Days,
  getSyncMetadata,
  updateSyncMetadata,
  getCacheValidation,
  updateCacheSnapshot,
  deduplicateDriverRoutePolylines,
  CACHE_SCHEMA_VERSION
};