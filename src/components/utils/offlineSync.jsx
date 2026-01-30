/**
 * Offline Sync Manager v3 - Timestamp-Based Sync with Date-Range Delivery Syncing
 * 
 * STRATEGY:
 * 1. Timestamp-based: Only fetch entities if updated_date > last_synced_timestamp
 * 2. Cities/Stores sync only when server has changes (saves rate limits)
 * 3. Deliveries: Check one date at a time over past 90 days for changes before syncing
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
const PATIENT_BATCH_SIZE = 25; // Even smaller chunks to reduce rate limits
const PATIENT_SYNC_COOLDOWN = 10000; // 10 second cooldown between patient batches
const BATCH_COOLDOWN = 1000;
const DELIVERY_DATE_RANGE_DAYS = 90;
const PATIENT_SYNC_INTERVAL_HOURS = 48; // Only sync patients once per 48 hours in background

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
const checkIfEntityNeedsSync = async (entityName, Entity, initialCheckQuery = {}) => {
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
    const latestRecords = await Entity.filter(initialCheckQuery, '-updated_date', 1);
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
 * For Patients, syncs in smaller batches with longer cooldown
 */
const syncEntityWithTimestampCheck = async (entityName, Entity, additionalFilter = {}, initialCheckQuery = {}) => {
  try {
    const checkResult = await checkIfEntityNeedsSync(entityName, Entity, initialCheckQuery);
    
    if (!checkResult.needsSync || checkResult.skipped) {
      // CRITICAL: Update sync time even when skipping to prevent repeated checks
      await offlineDB.updateSyncMetadata(entityName, null, new Date().toISOString());
      return { skipped: true, reason: checkResult.skipped ? 'recently_synced' : 'no_updates' };
    }
    
    const filter = checkResult.lastClientTimestamp 
      ? { ...additionalFilter, updated_date: { $gte: checkResult.lastClientTimestamp } }
      : additionalFilter;
    
    // For Patients: sync in smaller batches with cooldown to reduce rate limits
    if (entityName === 'Patient') {
      return await syncPatientsBatched(Entity, filter, checkResult.latestServerTimestamp);
    }
    
    const records = await Entity.filter(filter, '-updated_date', 5000);
    
    if (records.length > 0) {
      const storeName = entityName === 'Delivery' ? offlineDB.STORES.DELIVERIES :
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

/**
 * Sync patients in smaller chunks with cooldown to avoid rate limits
 */
const syncPatientsBatched = async (Entity, filter, latestServerTimestamp) => {
  let totalRecords = 0;
  let offset = 0;
  
  while (true) {
    const records = await Entity.filter(filter, '-updated_date', PATIENT_BATCH_SIZE, offset);
    
    if (!records || records.length === 0) break;
    
    // Save batch to offline DB
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, records);
    totalRecords += records.length;
    
    // Stop if we got fewer records than batch size (end of data)
    if (records.length < PATIENT_BATCH_SIZE) break;
    
    offset += PATIENT_BATCH_SIZE;
    
    // Wait before fetching next batch
    await new Promise(r => setTimeout(r, PATIENT_SYNC_COOLDOWN));
  }
  
  // Update metadata after all batches
  await offlineDB.updateSyncMetadata('Patient', latestServerTimestamp, new Date().toISOString());
  
  return { success: true, recordCount: totalRecords };
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
    const appUserResult = await syncEntityWithTimestampCheck('AppUser', AppUser, {}, {});
    const appUsers = appUserResult.skipped ? await offlineDB.getAll(offlineDB.STORES.APP_USERS) : await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 2: Cities with timestamp check
    const cityResult = await syncEntityWithTimestampCheck('City', City, {}, {});
    const cities = await offlineDB.getAll(offlineDB.STORES.CITIES);
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 3: Stores with timestamp check
    const storeResult = await syncEntityWithTimestampCheck('Store', Store, {}, {});
    const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
    
    await new Promise(r => setTimeout(r, 3000));
    
    // Step 4: Patients with timestamp check
    let patients = [];
    try {
      const patientResult = await syncEntityWithTimestampCheck('Patient', Patient, { status: 'active' }, { status: 'active' });
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
 * Get the next delivery date to sync (cycling through past 90 days)
 * Returns null if all dates have been recently synced
 */
const getNextDeliveryDateToSync = async () => {
  try {
    const metadata = await offlineDB.getSyncMetadata('Delivery_DateCycle');
    const lastCycleDate = metadata?.lastCycleDate ? new Date(metadata.lastCycleDate) : null;
    const cycleIndex = metadata?.cycleIndex || 0;
    
    // Start from today and go back 90 days
    const today = new Date();
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() - ((cycleIndex % DELIVERY_DATE_RANGE_DAYS)));
    
    const dateStr = format(targetDate, 'yyyy-MM-dd');
    const nextIndex = (cycleIndex + 1) % DELIVERY_DATE_RANGE_DAYS;
    
    // Store for next cycle
    await offlineDB.updateSyncMetadata('Delivery_DateCycle', null, new Date().toISOString(), { cycleIndex: nextIndex, lastCycleDate: new Date().toISOString() });
    
    return dateStr;
  } catch (error) {
    // Default: start from today
    return format(new Date(), 'yyyy-MM-dd');
  }
};

/**
 * Background sync with timestamp-based incremental strategy for deliveries
 * Syncs one delivery date at a time over past 90 days
 */
export const performBackgroundSync = async (selectedDateStr, storeIds = null) => {
  if (syncInProgress || syncPaused) {
    return { skipped: true };
  }
  
  syncInProgress = true;
  notifySyncStatus({ status: 'background_syncing' });
  
  try {
    await new Promise(r => setTimeout(r, 2000));
    
    await syncEntityWithTimestampCheck('City', City, {}, {});
    await new Promise(r => setTimeout(r, 2000));
    
    await syncEntityWithTimestampCheck('Store', Store, {}, {});
    await new Promise(r => setTimeout(r, 2000));
    
    await syncEntityWithTimestampCheck('AppUser', AppUser, {}, {});
    await new Promise(r => setTimeout(r, 2000));
    
    // CRITICAL: Skip patient sync in background unless it's been 24+ hours since last full sync
    // This prevents rate limit errors from frequent patient syncs
    const patientStatus = await offlineDB.getSyncStatus('Patient');
    const lastFullSync = patientStatus?.lastFullSync ? new Date(patientStatus.lastFullSync).getTime() : 0;
    const timeSinceLastSync = Date.now() - lastFullSync;
    const shouldSyncPatients = timeSinceLastSync > (PATIENT_SYNC_INTERVAL_HOURS * 60 * 60 * 1000);
    
    if (shouldSyncPatients) {
      await syncEntityWithTimestampCheck('Patient', Patient, { status: 'active' }, { status: 'active' });
      await new Promise(r => setTimeout(r, 2000));
    }
    
    // CRITICAL: Sync deliveries one date at a time over past 90 days
    // Check for changes before syncing to minimize rate limits
    const deliveryDateToSync = await getNextDeliveryDateToSync();
    const deliveryCheckFilter = { delivery_date: deliveryDateToSync };
    if (storeIds && storeIds.length > 0) {
      deliveryCheckFilter.store_id = { $in: storeIds };
    }
    
    const deliveryFilter = { delivery_date: deliveryDateToSync };
    if (storeIds && storeIds.length > 0) {
      deliveryFilter.store_id = { $in: storeIds };
    }
    
    await syncEntityWithTimestampCheck('Delivery', Delivery, deliveryFilter, deliveryCheckFilter);

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
    // Sync patients in smaller batches to avoid rate limits
    let allPatients = [];
    let offset = 0;
    while (true) {
      const batch = await Patient.filter({ status: 'active' }, '-created_date', PATIENT_BATCH_SIZE, offset);
      if (!batch || batch.length === 0) break;
      allPatients = allPatients.concat(batch);
      offset += PATIENT_BATCH_SIZE;
      await new Promise(r => setTimeout(r, PATIENT_SYNC_COOLDOWN));
    }
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

/**
 * Restart sync cycle for deliveries and patients only
 * Deliveries: Restart from today, go back 90 days
 * Patients: Only sync patients from last week's deliveries (deduplicated), then full sync the rest
 * Other entities: Complete full sync
 */
export const restartDeliveryPatientSync = async () => {
  if (syncInProgress) return { skipped: true };
  
  syncInProgress = true;
  notifySyncStatus({ status: 'restart_syncing' });
  
  try {
    const selectedDateStr = format(new Date(), 'yyyy-MM-dd');
    
    // CRITICAL: Reset delivery sync cycle to restart from today
    console.log('🔄 [OfflineSync] Restarting delivery sync cycle from today...');
    await offlineDB.updateSyncMetadata('Delivery_DateCycle', null, new Date().toISOString(), { cycleIndex: 0, lastCycleDate: new Date().toISOString() });
    
    // Clear delivery sync metadata to restart fresh
    const db = await offlineDB.openDatabase();
    const transaction = db.transaction([offlineDB.STORES.SYNC_METADATA], 'readwrite');
    const store = transaction.objectStore(offlineDB.STORES.SYNC_METADATA);
    
    // Reset delivery timestamp to force refetch
    const deliveryMetadata = await new Promise((resolve) => {
      const request = store.get('Delivery');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    
    if (deliveryMetadata) {
      deliveryMetadata.last_synced_timestamp = null;
      await new Promise((resolve) => {
        const putRequest = store.put(deliveryMetadata);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => resolve();
      });
    }
    
    notifySyncStatus({ status: 'syncing', entity: 'Deliveries (restarting)', progress: 10 });
    
    // Sync deliveries from today back 90 days
    for (let i = 0; i < DELIVERY_DATE_RANGE_DAYS; i++) {
      const dateToSync = format(subDays(new Date(), i), 'yyyy-MM-dd');
      const deliveryFilter = { delivery_date: dateToSync };
      
      await syncEntityWithTimestampCheck('Delivery', Delivery, deliveryFilter, deliveryFilter);
      
      const deliveryMetadataUpdate = {
        entity_name: 'Delivery_DateCycle',
        cycleIndex: (i + 1) % DELIVERY_DATE_RANGE_DAYS,
        lastCycleDate: new Date().toISOString()
      };
      await offlineDB.updateSyncMetadata('Delivery_DateCycle', null, new Date().toISOString(), deliveryMetadataUpdate);
      
      // Update progress
      const progress = Math.floor((i / DELIVERY_DATE_RANGE_DAYS) * 40) + 10;
      notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress, date: dateToSync });
      
      await new Promise(r => setTimeout(r, 500));
    }
    
    // CRITICAL: Sync ONLY patients from last week's deliveries (deduplicated by patient_id)
    notifySyncStatus({ status: 'syncing', entity: 'Patients (optimized)', progress: 50 });
    console.log('🔄 [OfflineSync] Syncing only patients from last week deliveries...');
    
    const weekAgoDateStr = format(subDays(new Date(), 7), 'yyyy-MM-dd');
    const deliveriesLastWeek = await Delivery.filter({ 
      delivery_date: { $gte: weekAgoDateStr } 
    });
    
    // Get unique patient IDs from last week's deliveries
    const uniquePatientIds = new Set(
      deliveriesLastWeek
        .filter(d => d && d.patient_id)
        .map(d => d.patient_id)
    );
    
    console.log(`📍 [OfflineSync] Found ${uniquePatientIds.size} unique patients in last week's deliveries`);
    
    // Fetch patients in batches by ID to avoid timeout
    let patientsFromLastWeek = [];
    if (uniquePatientIds.size > 0) {
      try {
        const patientIds = Array.from(uniquePatientIds);
        const ID_BATCH_SIZE = 50; // Batch IDs to avoid query timeout
        
        for (let i = 0; i < patientIds.length; i += ID_BATCH_SIZE) {
          const batchIds = patientIds.slice(i, i + ID_BATCH_SIZE);
          const batchPatients = await Patient.filter({
            id: { $in: batchIds }
          });
          
          if (batchPatients && batchPatients.length > 0) {
            patientsFromLastWeek = patientsFromLastWeek.concat(batchPatients);
            await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
          }
          
          // Progress update
          const batchProgress = Math.floor((i / patientIds.length) * 5) + 50;
          notifySyncStatus({ status: 'syncing', entity: 'Patients (week)', progress: batchProgress, loaded: patientsFromLastWeek.length });
          
          await new Promise(r => setTimeout(r, 500));
        }
        
        console.log(`✅ [OfflineSync] Synced ${patientsFromLastWeek.length} unique patients from last week`);
      } catch (error) {
        console.warn('⚠️ [OfflineSync] Failed to sync patients from last week:', error.message);
      }
    }
    
    await new Promise(r => setTimeout(r, 1000));
    
    // Then sync ALL remaining patients (those not in last week)
    notifySyncStatus({ status: 'syncing', entity: 'Patients (full)', progress: 60 });
    console.log('🔄 [OfflineSync] Syncing remaining patients...');
    
    let allPatients = patientsFromLastWeek;
    let offset = 0;
    while (true) {
      const batch = await Patient.filter({ status: 'active' }, '-created_date', PATIENT_BATCH_SIZE, offset);
      if (!batch || batch.length === 0) break;
      
      // Only keep patients NOT already synced from last week
      const newPatients = batch.filter(p => !uniquePatientIds.has(p.id));
      if (newPatients.length > 0) {
        allPatients = allPatients.concat(newPatients);
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, newPatients);
      }
      
      offset += PATIENT_BATCH_SIZE;
      await new Promise(r => setTimeout(r, PATIENT_SYNC_COOLDOWN));
    }
    
    const cleanPatients = allPatients.filter(p => p && p.id && !p.id.startsWith('temp_'));
    console.log(`✅ [OfflineSync] Total patients synced: ${cleanPatients.length}`);
    
    await new Promise(r => setTimeout(r, 1000));
    
    // Full sync for OTHER entities (Cities, Stores, AppUsers)
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 70 });
    const cities = await City.list();
    await offlineDB.bulkSave(offlineDB.STORES.CITIES, cities);
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    notifySyncStatus({ status: 'syncing', entity: 'Stores', progress: 80 });
    const stores = await Store.list();
    await offlineDB.bulkSave(offlineDB.STORES.STORES, stores);
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 90 });
    const appUsers = await AppUser.list();
    await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
    
    // Update sync status for all entities
    const deliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    
    await Promise.all([
      offlineDB.updateSyncStatus('City', { recordCount: cities.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Store', { recordCount: stores.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('AppUser', { recordCount: appUsers.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Delivery', { recordCount: deliveries.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Patient', { recordCount: cleanPatients.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() })
    ]);
    
    notifySyncStatus({ status: 'complete', progress: 100 });
    window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
    
    console.log('✅ [OfflineSync] Restart sync complete');
    return { success: true, deliveries: deliveries.length, patients: cleanPatients.length };
  } catch (error) {
    console.error('❌ [OfflineSync] Restart sync error:', error);
    notifySyncStatus({ status: 'error', error: error.message });
    return { error: error.message };
  } finally {
    syncInProgress = false;
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