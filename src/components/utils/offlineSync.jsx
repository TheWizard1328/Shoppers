/**
 * Offline Sync Manager v3 - Timestamp-Based Sync
 * 
 * STRATEGY:
 * 1. Timestamp-based: Only fetch entities if updated_date > last_synced_timestamp
 * 2. Cities/Stores sync only when server has changes (saves rate limits)
 * 3. Deliveries/Patients/AppUsers: incremental sync with updated_date filter
 * 4. NEVER clear the entire DB - only merge/update records
 */

import { offlineDB } from './offlineDatabase';
import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { AppUser } from '@/entities/AppUser';
import { City } from '@/entities/City';
import { Store } from '@/entities/Store';
import { SquareTransaction } from '@/entities/SquareTransaction';
import { format, subDays } from 'date-fns';

// Configuration
const PATIENT_BATCH_SIZE = 250;
const BATCH_COOLDOWN = 1000;

let syncInProgress = false;
let syncPaused = false;
let syncListeners = [];

// ==================== SYNC CONTROL ====================

export const pauseOfflineSync = () => {
  syncPaused = true;
};

export const resumeOfflineSync = () => {
  syncPaused = false;
};

export const isOfflineSyncPaused = () => syncPaused;

export const subscribeSyncStatus = (callback) => {
  syncListeners.push(callback);
  return () => {
    syncListeners = syncListeners.filter(cb => cb !== callback);
  };
};

const notifySyncStatus = (status) => {
  syncListeners.forEach(callback => {
    try { callback(status); } catch (e) {}
  });
};

// ==================== TIMESTAMP-BASED SYNC HELPERS ====================

/**
 * Check if entity needs syncing by comparing server's latest timestamp with client's last sync
 * CRITICAL: Skip API call if offline DB shows recent sync (within 30 minutes) to prevent rate limits
 * @returns {Promise<{needsSync: boolean, lastClientTimestamp: string|null}>}
 */
const checkIfEntityNeedsSync = async (entityName, Entity) => {
  try {
    const metadata = await offlineDB.getSyncMetadata(entityName);
    const lastClientTimestamp = metadata?.last_synced_timestamp || null;
    const lastSyncTime = metadata?.last_sync_time ? new Date(metadata.last_sync_time).getTime() : 0;
    const now = Date.now();
    
    // CRITICAL: If synced recently (within 4 hours), skip API call to prevent rate limits
    // This avoids hammering the API with timestamp checks during idle periods
    if (lastClientTimestamp && lastSyncTime && (now - lastSyncTime) < 4 * 60 * 60 * 1000) {
      return { needsSync: false, lastClientTimestamp, skipped: true };
    }
    
    // Only fetch ONE record to check timestamp (cheaper than full list)
    // But only if we haven't synced recently
    const latestRecords = await Entity.filter({}, '-updated_date', 1);
    if (!latestRecords || latestRecords.length === 0) {
      return { needsSync: false, lastClientTimestamp };
    }
    
    const latestServerTimestamp = latestRecords[0].updated_date;
    
    // Compare timestamps
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

/**
 * Sync a single entity with timestamp checking
 * Only fetches if server has newer data than client
 */
const syncEntityWithTimestampCheck = async (entityName, Entity, additionalFilter = {}) => {
  try {
    const checkResult = await checkIfEntityNeedsSync(entityName, Entity);
    
    if (!checkResult.needsSync || checkResult.skipped) {
      // CRITICAL: Update sync time even when skipping to prevent repeated checks
      await offlineDB.updateSyncMetadata(entityName, null, new Date().toISOString());
      return { skipped: true, reason: checkResult.skipped ? 'recently_synced' : 'no_updates' };
    }
    
    const filter = checkResult.lastClientTimestamp 
      ? { ...additionalFilter, updated_date: { $gte: checkResult.lastClientTimestamp } }
      : additionalFilter;
    
    const records = await Entity.filter(filter, '-updated_date', 5000);
    
    if (records.length > 0) {
      const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS :
                        entityName === 'Delivery' ? offlineDB.STORES.DELIVERIES :
                        entityName === 'AppUser' ? offlineDB.STORES.APP_USERS :
                        entityName === 'City' ? offlineDB.STORES.CITIES :
                        offlineDB.STORES.STORES;
      
      await offlineDB.bulkSave(storeName, records);
    }
    
    // CRITICAL: Always update sync metadata even if no records, to mark check timestamp
    await offlineDB.updateSyncMetadata(entityName, checkResult.latestServerTimestamp, new Date().toISOString());
    
    return { success: true, recordCount: records.length };
  } catch (error) {
    return { error: error.message };
  }
};

// ==================== PRIORITY DATA LOADING ====================

/**
 * Load priority data for initial display
 * Order: Cities → AppUsers → Deliveries (selected date) → ALL Patients (critical for map markers)
 */
export const loadPriorityData = async (selectedDateStr, filters = {}) => {
  if (syncPaused) return { skipped: true };
  if (syncInProgress) return { skipped: true, reason: 'sync_in_progress' };
  
  syncInProgress = true;
  notifySyncStatus({ status: 'loading_priority', date: selectedDateStr });
  
  try {
    // Step 1: AppUsers with timestamp check
    const appUserResult = await syncEntityWithTimestampCheck('AppUser', AppUser);
    const appUsers = appUserResult.skipped ? await offlineDB.getAll(offlineDB.STORES.APP_USERS) : await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 2: Cities with timestamp check
    const cityResult = await syncEntityWithTimestampCheck('City', City);
    const cities = await offlineDB.getAll(offlineDB.STORES.CITIES);
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 3: Stores with timestamp check
    const storeResult = await syncEntityWithTimestampCheck('Store', Store);
    const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
    
    await new Promise(r => setTimeout(r, 3000));
    
    // Step 4: Patients with timestamp check
    let patients = [];
    try {
      const patientResult = await syncEntityWithTimestampCheck('Patient', Patient, { status: 'active' });
      patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      patients = patients.filter(p => p && p.id && !p.id.startsWith('temp_'));
    } catch (patientError) {}
    
    await new Promise(r => setTimeout(r, 3000));
    
    // Step 5: Deliveries for selected date
    const deliveryFilter = { delivery_date: selectedDateStr, ...filters };
    const deliveries = await Delivery.filter(deliveryFilter);
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    
    await Promise.all([
      offlineDB.updateSyncStatus('City', { recordCount: cities.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Store', { recordCount: stores.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('AppUser', { recordCount: appUsers.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Delivery', { recordCount: deliveries.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Patient', { recordCount: patients.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() })
    ]);

    notifySyncStatus({ status: 'priority_loaded', cities: cities.length, stores: stores.length, appUsers: appUsers.length, deliveries: deliveries.length, patients: patients.length });

    syncInProgress = false;
    return { cities, stores, appUsers, deliveries, patients };
  } catch (error) {
    notifySyncStatus({ status: 'error', error: error.message });
    syncInProgress = false;
    return { error: error.message };
  }
};

// ==================== BACKGROUND SYNC ====================

/**
 * Background sync with timestamp-based incremental strategy
 * Only syncs entities when server has newer data (compares updated_date timestamps)
 */
export const performBackgroundSync = async (selectedDateStr, storeIds = null) => {
  if (syncInProgress || syncPaused) {
    return { skipped: true };
  }
  
  syncInProgress = true;
  notifySyncStatus({ status: 'background_syncing' });
  
  try {
    await new Promise(r => setTimeout(r, 2000));
    
    await syncEntityWithTimestampCheck('City', City);
    await new Promise(r => setTimeout(r, 2000));
    
    await syncEntityWithTimestampCheck('Store', Store);
    await new Promise(r => setTimeout(r, 2000));
    
    await syncEntityWithTimestampCheck('AppUser', AppUser);
    await new Promise(r => setTimeout(r, 2000));
    
    await syncEntityWithTimestampCheck('Patient', Patient, { status: 'active' });
    await new Promise(r => setTimeout(r, 2000));
    
    const deliveryFilter = storeIds && storeIds.length > 0 ? { store_id: { $in: storeIds } } : {};
    await syncEntityWithTimestampCheck('Delivery', Delivery, deliveryFilter);

    notifySyncStatus({ status: 'complete' });
    window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
    
    return { success: true };
  } catch (error) {
    notifySyncStatus({ status: 'error', error: error.message });
    return { error: error.message };
  } finally {
    syncInProgress = false;
  }
};





// ==================== ON-DEMAND DATA LOADING ====================

/**
 * Load and cache deliveries for a specific date (when user navigates to historical date)
 * This adds to the offline DB for faster access later
 */
export const loadAndCacheDeliveriesForDate = async (dateStr) => {
  if (syncPaused) return [];
  
  try {
    const deliveries = await Delivery.filter({ delivery_date: dateStr });
    
    if (deliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    }
    
    return deliveries;
  } catch (error) {
    return [];
  }
};

// ==================== INITIAL SYNC (ENTRY POINT) ====================

/**
 * Main entry point for initial sync
 * CRITICAL: For new users, always sync ALL patients to populate offline DB
 */
export const performInitialSync = async (selectedDate = null) => {
  if (syncInProgress || syncPaused) {
    return { skipped: true };
  }
  
  const selectedDateStr = selectedDate 
    ? format(selectedDate, 'yyyy-MM-dd') 
    : format(new Date(), 'yyyy-MM-dd');
  
  const existingPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
  const hasPatientData = existingPatients && existingPatients.length > 50;
  
  const priorityResult = await loadPriorityData(selectedDateStr);
  
  if (priorityResult.error) {
    return priorityResult;
  }
  
  setTimeout(() => {
    performBackgroundSync(selectedDateStr).catch(() => {});
  }, 10000);
  
  return priorityResult;
};

// ==================== LEGACY EXPORTS (COMPATIBILITY) ====================

export const processPendingMutations = async () => {
  if (syncPaused) return { success: true, skipped: true };
  
  const mutations = await offlineDB.getPendingMutations();
  if (mutations.length === 0) return { success: true, processed: 0 };
  
  // CRITICAL: Process max 50 mutations per batch to avoid rate limits
  const BATCH_SIZE = 50;
  const batch = mutations.slice(0, BATCH_SIZE);
  
  console.log(`🔄 [OfflineSync] Processing ${batch.length} of ${mutations.length} pending mutations...`);
  
  // Separate mutations by operation type for batch processing
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
      
      const Entity = mutation.entity === 'Patient' ? Patient : Delivery;
      return Entity.delete(mutation.recordId)
        .then(() => ({ success: true, mutationId: mutation.mutationId }))
        .catch(deleteError => {
          // Ignore 404 errors - record already deleted on backend (silent)
          if (deleteError.response?.status === 404 || deleteError.message?.includes('404') || deleteError.message?.includes('not found')) {
            return { success: true, mutationId: mutation.mutationId };
          }
          // Ignore 429 rate limit errors - will retry (silent)
          if (deleteError.response?.status === 429) {
            return { success: false, mutationId: mutation.mutationId, error: deleteError, retryCount: mutation.retryCount || 0, isRateLimit: true };
          }
          return { success: false, mutationId: mutation.mutationId, error: deleteError, retryCount: mutation.retryCount || 0 };
        });
    });
    
    const deleteResults = await Promise.all(deletePromises);
    
    // Remove successful deletes from offline DB and pending queue in parallel
    const offlineDeletePromises = [];
    for (const result of deleteResults) {
      if (result.success && result.mutationId) {
        const mutation = deletes.find(m => m.mutationId === result.mutationId);
        if (mutation) {
          // Always remove from pending queue on success
          offlineDeletePromises.push(
            offlineDB.removePendingMutation(result.mutationId)
          );
          // Only delete from offline DB if not a temp record
          if (!mutation.recordId?.startsWith('temp_')) {
            offlineDeletePromises.push(
              offlineDB.deleteRecord(mutation.entity === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES, mutation.recordId)
            );
          }
        }
        successCount++;
      } else if (result.success && result.skip) {
        const mutation = deletes.find(m => m.mutationId === result.mutationId || !m.recordId?.startsWith('temp_'));
        if (mutation?.mutationId) {
          // Always remove from pending queue even if skipped
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
    
    // Handle failed deletes (retry)
    for (const failedMutationId of failedMutationIds) {
      const mutation = deletes.find(m => m.mutationId === failedMutationId);
      if (mutation) {
        await offlineDB.updateMutationRetry(mutation.mutationId, (mutation.retryCount || 0) + 1);
      }
    }
  }
  
  // Process creates and updates sequentially with cooldown (smaller batches typically)
  for (const mutation of [...creates, ...updates]) {
    if (syncPaused) break;
    
    try {
      const Entity = mutation.entity === 'Patient' ? Patient : Delivery;
      
      if (mutation.operation === 'create') {
        await Entity.create(mutation.payload);
      } else if (mutation.operation === 'update') {
        await Entity.update(mutation.recordId, mutation.payload);
      }
      
      await offlineDB.removePendingMutation(mutation.mutationId);
      successCount++;
      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      await offlineDB.updateMutationRetry(mutation.mutationId, (mutation.retryCount || 0) + 1);
      failCount++;
      
      if (error.response?.status === 429) {
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }
  
  return { success: failCount === 0, processed: successCount, failed: failCount, remaining: mutations.length - batch.length };
};

export const forceSyncAll = async () => {
  if (syncPaused) return { skipped: true };
  
  syncInProgress = true;
  notifySyncStatus({ status: 'force_syncing', entity: 'Starting...', progress: 0 });
  
  try {
    const selectedDateStr = format(new Date(), 'yyyy-MM-dd');

    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 5 });
    const appUsersRaw = await AppUser.list();
    const appUsersByUserId = new Map();
    appUsersRaw.forEach(au => {
      if (!au || !au.user_id) return;
      const existing = appUsersByUserId.get(au.user_id);
      if (!existing || (au.sort_order || Infinity) < (existing.sort_order || Infinity)) {
        appUsersByUserId.set(au.user_id, au);
      }
    });
    const appUsers = Array.from(appUsersByUserId.values());
    await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 10, count: appUsers.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 15 });
    const cities = await City.list();
    await offlineDB.bulkSave(offlineDB.STORES.CITIES, cities);
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 20, count: cities.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    notifySyncStatus({ status: 'syncing', entity: 'Stores', progress: 22 });
    const stores = await Store.list();
    await offlineDB.bulkSave(offlineDB.STORES.STORES, stores);
    notifySyncStatus({ status: 'syncing', entity: 'Stores', progress: 24, count: stores.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 25 });
    const allPatients = await Patient.filter({ status: 'active' }, '-created_date', 5000);
    const cleanPatients = allPatients.filter(p => p && p.id && !p.id.startsWith('temp_'));
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, cleanPatients);
    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 35, count: cleanPatients.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 40 });
    const deliveries = await Delivery.filter({ delivery_date: selectedDateStr });
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 50, count: deliveries.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    await Promise.all([
      offlineDB.updateSyncStatus('City', { recordCount: cities.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Store', { recordCount: stores.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('AppUser', { recordCount: appUsers.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Delivery', { recordCount: deliveries.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Patient', { recordCount: cleanPatients.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() })
    ]);

    notifySyncStatus({ status: 'syncing', entity: 'Finalizing', progress: 90 });
    await performBackgroundSync(selectedDateStr);
    notifySyncStatus({ status: 'complete', progress: 100 });
    return { success: true };
  } catch (error) {
    notifySyncStatus({ status: 'error', error: error.message });
    return { error: error.message };
  } finally {
    syncInProgress = false;
  }
};

export const performBidirectionalSync = forceSyncAll;

export const handleDeleteBroadcast = async (entityName, recordId) => {
  if (!entityName || !recordId) return;
  
  try {
    const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
    await offlineDB.deleteRecord(storeName, recordId);
    return true;
  } catch (error) {
    return false;
  }
};

export const getSyncStats = async () => {
  const stats = await offlineDB.getStats();
  const pendingMutations = await offlineDB.getPendingMutations();
  const patientStatus = await offlineDB.getSyncStatus('Patient');
  const deliveryStatus = await offlineDB.getSyncStatus('Delivery');
  const cityStatus = await offlineDB.getSyncStatus('City');
  const storeStatus = await offlineDB.getSyncStatus('Store');
  const appUserStatus = await offlineDB.getSyncStatus('AppUser');
  const squareTxStatus = await offlineDB.getSyncStatus('SquareTransaction');

  return {
    ...stats,
    pendingMutations: pendingMutations.length,
    fullSyncStatus: {
      patients: {
        completed: !!patientStatus?.lastFullSync,
        lastFullSync: patientStatus?.lastFullSync,
        lastSync: patientStatus?.lastSync
      },
      deliveries: {
        completed: !!deliveryStatus?.lastFullSync,
        lastFullSync: deliveryStatus?.lastFullSync,
        lastSync: deliveryStatus?.lastSync
      },
      cities: {
        completed: !!cityStatus?.lastFullSync,
        lastFullSync: cityStatus?.lastFullSync,
        lastSync: cityStatus?.lastSync
      },
      stores: {
        completed: !!storeStatus?.lastFullSync,
        lastFullSync: storeStatus?.lastFullSync,
        lastSync: storeStatus?.lastSync
      },
      appUsers: {
        completed: !!appUserStatus?.lastFullSync,
        lastFullSync: appUserStatus?.lastFullSync,
        lastSync: appUserStatus?.lastSync
      },
      squareTransactions: {
        completed: !!squareTxStatus?.lastFullSync,
        lastFullSync: squareTxStatus?.lastFullSync,
        lastSync: squareTxStatus?.lastSync
      }
    }
  };
};