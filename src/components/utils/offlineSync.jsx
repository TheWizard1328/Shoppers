/**
 * Offline Sync Manager
 * Handles background synchronization of Patients and Deliveries to IndexedDB
 */

import { offlineDB } from './offlineDatabase';
import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { format, subDays } from 'date-fns';

// Import for backend sync
const { Patient: PatientEntity, Delivery: DeliveryEntity } = { Patient, Delivery };

const BATCH_SIZE = 500; // Fetch records in batches to avoid memory issues
const SYNC_DELAY_BETWEEN_BATCHES = 1500; // 1500ms delay between batches to avoid rate limits
const FULL_SYNC_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // Check for full sync every 24 hours
const LOCAL_CACHE_DAYS = 90; // 3 months of historical data in local cache

let syncInProgress = false;
let syncPaused = false; // CRITICAL: Pause sync during route optimization
let syncListeners = [];

// Track full sync completion state
let fullSyncCompleted = {
  patients: false,
  deliveries: false,
  lastFullSyncDate: null
};

/**
 * Pause offline sync (during route optimization)
 */
export const pauseOfflineSync = () => {
  console.log('⏸️ [OfflineSync] Paused');
  syncPaused = true;
};

/**
 * Resume offline sync
 */
export const resumeOfflineSync = () => {
  console.log('▶️ [OfflineSync] Resumed');
  syncPaused = false;
};

/**
 * Check if offline sync is paused
 */
export const isOfflineSyncPaused = () => syncPaused;

/**
 * Subscribe to sync status changes
 */
export const subscribeSyncStatus = (callback) => {
  syncListeners.push(callback);
  return () => {
    syncListeners = syncListeners.filter(cb => cb !== callback);
  };
};

/**
 * Notify all listeners of sync status
 */
const notifySyncStatus = (status) => {
  syncListeners.forEach(callback => {
    try {
      callback(status);
    } catch (error) {}
  });
};

/**
 * Check if full sync is needed (first time or 24h+ since last full sync)
 */
const needsFullSync = async (entity) => {
  const syncStatus = await offlineDB.getSyncStatus(entity);
  if (!syncStatus || !syncStatus.lastFullSync) return true;
  const hoursSinceLastSync = (Date.now() - new Date(syncStatus.lastFullSync).getTime()) / (1000 * 60 * 60);
  return hoursSinceLastSync >= 24;
};

/**
 * Sync Patients to IndexedDB - FULL or INCREMENTAL
 */
const syncPatients = async (forceFullSync = false) => {
  // CRITICAL: Check if sync is paused
  if (syncPaused) {
    console.log('⏸️ [OfflineSync] syncPatients skipped - sync is paused');
    return { success: true, skipped: true };
  }

  const isFullSync = forceFullSync || await needsFullSync('Patient');
  notifySyncStatus({ entity: 'Patient', status: 'syncing', progress: 0, syncType: isFullSync ? 'full' : 'incremental' });

  try {
    let patients;
    
    if (isFullSync) {
      patients = await Patient.list();
    } else {
      const lastSync = await offlineDB.getSyncStatus('Patient');
      const lastSyncDate = lastSync?.lastSync || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const allPatients = await Patient.list();
      patients = allPatients.filter(p => {
        const updated = new Date(p.updated_date || p.created_date);
        return updated >= new Date(lastSyncDate);
      });
      
      if (patients.length > allPatients.length * 0.5) {
        patients = allPatients;
      }
    }

    const cleanPatients = patients.filter(p => !p.id.startsWith('temp_'));
    
    if (isFullSync) {
      const localPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      const backendIds = new Set(cleanPatients.map(p => p.id));
      const recordsToDelete = localPatients.filter(p => !p.id.startsWith('temp_') && !backendIds.has(p.id));
      
      if (recordsToDelete.length > 0) {
        const db = await offlineDB.openDatabase();
        const transaction = db.transaction([offlineDB.STORES.PATIENTS], 'readwrite');
        const store = transaction.objectStore(offlineDB.STORES.PATIENTS);
        
        for (const record of recordsToDelete) {
          await new Promise((resolve, reject) => {
            const request = store.delete(record.id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        }
      }
    }
    
    // Save to IndexedDB in batches
    const batches = [];
    for (let i = 0; i < cleanPatients.length; i += BATCH_SIZE) {
      batches.push(cleanPatients.slice(i, i + BATCH_SIZE));
    }

    let totalSaved = 0;
    for (let i = 0; i < batches.length; i++) {
      // Check pause state before each batch
      if (syncPaused) {
        console.log('⏸️ [OfflineSync] syncPatients interrupted - sync paused mid-operation');
        return { success: true, partial: true, count: totalSaved };
      }

      const batch = batches[i];
      const result = await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batch);
      totalSaved += result.count;
      
      const progress = Math.round(((i + 1) / batches.length) * 100);
      notifySyncStatus({ entity: 'Patient', status: 'syncing', progress, count: totalSaved });
      
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, SYNC_DELAY_BETWEEN_BATCHES));
      }
    }

    // Update sync status with full sync marker
    const syncStatusUpdate = {
      recordCount: totalSaved,
      status: 'synced',
      lastSync: new Date().toISOString()
    };
    
    if (isFullSync) {
      syncStatusUpdate.lastFullSync = new Date().toISOString();
      fullSyncCompleted.patients = true;
    }
    
    await offlineDB.updateSyncStatus('Patient', syncStatusUpdate);
    notifySyncStatus({ entity: 'Patient', status: 'synced', count: totalSaved, syncType: isFullSync ? 'full' : 'incremental' });
    return { success: true, count: totalSaved, syncType: isFullSync ? 'full' : 'incremental' };
  } catch (error) {
    notifySyncStatus({ entity: 'Patient', status: 'error', error: error.message });
    return { success: false, error: error.message };
  }
};

/**
 * Sync Deliveries to IndexedDB - FULL or INCREMENTAL
 * FULL SYNC: All dates (7 future + 30 past)
 * INCREMENTAL SYNC: Priority dates + changed dates only
 */
const syncDeliveries = async (selectedDate = null, forceFullSync = false) => {
  // CRITICAL: Check if sync is paused
  if (syncPaused) {
    console.log('⏸️ [OfflineSync] syncDeliveries skipped - sync is paused');
    return { success: true, skipped: true };
  }

  const isFullSync = forceFullSync || await needsFullSync('Delivery');
  notifySyncStatus({ entity: 'Delivery', status: 'syncing', progress: 0, syncType: isFullSync ? 'full' : 'incremental' });

  try {
    const today = new Date();
    const todayStr = format(today, 'yyyy-MM-dd');
    const selectedDateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : todayStr;

    let totalSaved = 0;
    const allDeliveries = [];
    let consecutiveDaysWithoutChanges = 0;

    const selectedDateDeliveries = await Delivery.filter({ delivery_date: selectedDateStr });
    
    if (selectedDateDeliveries.length > 0) {
      allDeliveries.push(...selectedDateDeliveries);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (selectedDateStr !== todayStr) {
      const todayDeliveries = await Delivery.filter({ delivery_date: todayStr });
      
      if (todayDeliveries.length > 0) {
        allDeliveries.push(...todayDeliveries);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Build date list: 7 days forward, then 30 days back
    const datesToSync = [];
    
    // Future dates (1 to 7 days ahead, skipping today and selected date)
    for (let i = 1; i <= 7; i++) {
      const futureDate = new Date(today);
      futureDate.setDate(today.getDate() + i);
      const futureDateStr = format(futureDate, 'yyyy-MM-dd');
      if (futureDateStr !== selectedDateStr) {
        datesToSync.push(futureDateStr);
      }
    }
    
    // Past dates (1 to 90 days ago, skipping today and selected date) - 3 months of history
    for (let i = 1; i <= LOCAL_CACHE_DAYS; i++) {
      const pastDate = new Date(today);
      pastDate.setDate(today.getDate() - i);
      const pastDateStr = format(pastDate, 'yyyy-MM-dd');
      if (pastDateStr !== selectedDateStr) {
        datesToSync.push(pastDateStr);
      }
    }

    const earlyExitThreshold = isFullSync ? Infinity : 10;

    for (let i = 0; i < datesToSync.length; i++) {
      // Check pause state before each date
      if (syncPaused) {
        console.log('⏸️ [OfflineSync] syncDeliveries interrupted - sync paused mid-operation');
        break;
      }

      const dateStr = datesToSync[i];
      const localDeliveriesForDate = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
      const backendDeliveriesForDate = await Delivery.filter({ delivery_date: dateStr });
      
      if (isFullSync) {
        allDeliveries.push(...backendDeliveriesForDate);
      } else {
        const hasChanges = checkForChanges(localDeliveriesForDate, backendDeliveriesForDate);
        
        if (hasChanges) {
          allDeliveries.push(...backendDeliveriesForDate);
          consecutiveDaysWithoutChanges = 0;
        } else {
          consecutiveDaysWithoutChanges++;
          allDeliveries.push(...localDeliveriesForDate);
        }
        
        if (consecutiveDaysWithoutChanges >= earlyExitThreshold) {
          break;
        }
      }
      
      // Progress notification
      const progress = Math.round(((i + 1) / datesToSync.length) * 100);
      notifySyncStatus({ entity: 'Delivery', status: 'syncing', progress, count: allDeliveries.length, syncType: isFullSync ? 'full' : 'incremental' });
      
      // Rate limit protection (longer delay for full sync to be safe)
      await new Promise(resolve => setTimeout(resolve, isFullSync ? 2000 : 1500));
    }

    // CRITICAL: Remove temp IDs before saving backend data to prevent duplicates
    console.log(`🧹 [OfflineSync] Filtering out temp IDs from backend data...`);
    const cleanDeliveries = allDeliveries.filter(d => !d.id.startsWith('temp_'));
    console.log(`   Removed ${allDeliveries.length - cleanDeliveries.length} temp records`);
    
    // CRITICAL: Remove deleted records from IndexedDB (exist locally but not on backend)
    if (isFullSync && !syncPaused) {
      const localDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      const backendIds = new Set(cleanDeliveries.map(d => d.id));
      const recordsToDelete = localDeliveries.filter(d => !d.id.startsWith('temp_') && !backendIds.has(d.id));
      
      if (recordsToDelete.length > 0) {
        console.log(`🗑️ [OfflineSync] Removing ${recordsToDelete.length} deleted deliveries from IndexedDB...`);
        const db = await offlineDB.openDatabase();
        const transaction = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
        const store = transaction.objectStore(offlineDB.STORES.DELIVERIES);
        
        for (const record of recordsToDelete) {
          await new Promise((resolve, reject) => {
            const request = store.delete(record.id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
        }
        
        console.log(`✅ [OfflineSync] Removed ${recordsToDelete.length} deleted deliveries from IndexedDB`);
      }
    }
    
    // Save to IndexedDB in batches
    console.log(`💾 [OfflineSync] Saving ${cleanDeliveries.length} total deliveries to IndexedDB...`);
    const batches = [];
    for (let i = 0; i < cleanDeliveries.length; i += BATCH_SIZE) {
      batches.push(cleanDeliveries.slice(i, i + BATCH_SIZE));
    }

    for (let i = 0; i < batches.length; i++) {
      // Check pause state before each batch
      if (syncPaused) {
        console.log('⏸️ [OfflineSync] syncDeliveries batch interrupted - sync paused');
        return { success: true, partial: true, count: totalSaved };
      }

      const batch = batches[i];
      const result = await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, batch);
      totalSaved += result.count;
      
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, SYNC_DELAY_BETWEEN_BATCHES));
      }
    }

    // Update sync status with full sync marker
    const syncStatusUpdate = {
      recordCount: totalSaved,
      status: 'synced',
      lastSync: new Date().toISOString()
    };
    
    if (isFullSync) {
      syncStatusUpdate.lastFullSync = new Date().toISOString();
      fullSyncCompleted.deliveries = true;
      fullSyncCompleted.lastFullSyncDate = new Date().toISOString();
    }
    
    await offlineDB.updateSyncStatus('Delivery', syncStatusUpdate);
    notifySyncStatus({ entity: 'Delivery', status: 'synced', count: totalSaved, syncType: isFullSync ? 'full' : 'incremental' });
    return { success: true, count: totalSaved, syncType: isFullSync ? 'full' : 'incremental' };
  } catch (error) {
    notifySyncStatus({ entity: 'Delivery', status: 'error', error: error.message });
    return { success: false, error: error.message };
  }
};

/**
 * Check if there are changes between local and backend data
 */
const checkForChanges = (localRecords, backendRecords) => {
  if (localRecords.length !== backendRecords.length) {
    return true; // Different count = changes
  }
  
  const localIds = new Set(localRecords.map(r => r.id));
  const backendIds = new Set(backendRecords.map(r => r.id));
  
  // Check for additions or deletions
  if (localIds.size !== backendIds.size) {
    return true;
  }
  
  for (const id of backendIds) {
    if (!localIds.has(id)) {
      return true; // New record
    }
  }
  
  // Check for updates (compare updated_date)
  for (const backendRecord of backendRecords) {
    const localRecord = localRecords.find(r => r.id === backendRecord.id);
    if (!localRecord) {
      return true;
    }
    
    const backendTime = new Date(backendRecord.updated_date || backendRecord.created_date).getTime();
    const localTime = new Date(localRecord.updated_date || localRecord.created_date).getTime();
    
    if (backendTime !== localTime) {
      return true; // Record was updated
    }
  }
  
  return false; // No changes
};

/**
 * Perform initial sync if needed - FULL or INCREMENTAL based on last sync time
 */
export const performInitialSync = async (selectedDate = null) => {
  if (syncInProgress || syncPaused) {
    console.log(`⏸️ [OfflineSync] performInitialSync skipped - ${syncInProgress ? 'in progress' : 'paused'}`);
    return;
  }

  syncInProgress = true;
  notifySyncStatus({ status: 'starting' });

  try {
    await processPendingMutations();
    await new Promise(resolve => setTimeout(resolve, 2000));

    const needsPatientFullSync = await needsFullSync('Patient');
    const needsDeliveryFullSync = await needsFullSync('Delivery');
    
    const results = { patients: null, deliveries: null };

    results.patients = await syncPatients(needsPatientFullSync);
    await new Promise(resolve => setTimeout(resolve, 3000));
    results.deliveries = await syncDeliveries(selectedDate, needsDeliveryFullSync);

    const syncSummary = {
      patients: `${results.patients.syncType?.toUpperCase() || 'SKIPPED'} - ${results.patients.count || 0} records`,
      deliveries: `${results.deliveries.syncType?.toUpperCase() || 'SKIPPED'} - ${results.deliveries.count || 0} records`
    };

    notifySyncStatus({ status: 'complete', results: syncSummary });
    return results;
  } catch (error) {
    notifySyncStatus({ status: 'error', error: error.message });
    throw error;
  } finally {
    syncInProgress = false;
  }
};

/**
 * Force FULL sync (clear and re-sync all data)
 */
export const forceSyncAll = async () => {
  if (syncInProgress || syncPaused) {
    console.log(`⏸️ [OfflineSync] forceSyncAll skipped - ${syncInProgress ? 'in progress' : 'paused'}`);
    return;
  }

  syncInProgress = true;
  notifySyncStatus({ status: 'force_syncing' });

  try {
    const results = await performBidirectionalSync();
    notifySyncStatus({ status: 'complete', results });
    return results;
  } catch (error) {
    notifySyncStatus({ status: 'error', error: error.message });
    throw error;
  } finally {
    syncInProgress = false;
  }
};

/**
 * Process pending mutations (sync local changes to backend)
 */
export const processPendingMutations = async () => {
  // CRITICAL: Check if sync is paused
  if (syncPaused) {
    console.log('⏸️ [OfflineSync] processPendingMutations skipped - sync is paused');
    return { success: true, skipped: true };
  }

  const mutations = await offlineDB.getPendingMutations();
  if (mutations.length === 0) return { success: true, processed: 0 };

  notifySyncStatus({ status: 'processing_mutations', count: mutations.length });

  let successCount = 0;
  let failCount = 0;

  for (const mutation of mutations) {
    // Check pause state before each mutation
    if (syncPaused) {
      console.log('⏸️ [OfflineSync] processPendingMutations interrupted - sync paused');
      break;
    }

    try {
      if ((mutation.operation === 'update' || mutation.operation === 'delete') && mutation.recordId.startsWith('temp_')) {
        await offlineDB.removePendingMutation(mutation.mutationId);
        continue;
      }
      
      // Execute the mutation on the backend
      const Entity = mutation.entity === 'Patient' ? Patient : Delivery;
      
      try {
        if (mutation.operation === 'create') {
          await Entity.create(mutation.payload);
        } else if (mutation.operation === 'update') {
          await Entity.update(mutation.recordId, mutation.payload);
        } else if (mutation.operation === 'delete') {
          await Entity.delete(mutation.recordId);
        }
      } catch (syncError) {
        if (syncError.response?.status === 404 || syncError.message?.includes('not found')) {
          await offlineDB.removePendingMutation(mutation.mutationId);
          successCount++;
          continue;
        }
        throw syncError;
      }

      await offlineDB.removePendingMutation(mutation.mutationId);
      successCount++;
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      await offlineDB.updateMutationRetry(mutation.mutationId, (mutation.retryCount || 0) + 1);
      failCount++;
      
      if (error.response?.status === 429 || error.message?.includes('429')) {
        break;
      }
    }
  }

  notifySyncStatus({ status: 'mutations_processed', successCount, failCount });
  return { success: failCount === 0, processed: successCount, failed: failCount };
};

/**
 * Bidirectional sync - compare local vs online and update both sides
 */
export const performBidirectionalSync = async () => {
  if (syncInProgress || syncPaused) {
    console.log(`⏸️ [OfflineSync] performBidirectionalSync skipped - ${syncInProgress ? 'in progress' : 'paused'}`);
    return;
  }

  syncInProgress = true;
  notifySyncStatus({ status: 'bidirectional_syncing' });

  try {
    await processPendingMutations();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Fetch patients from backend
    const backendPatients = await Patient.list();
    
    // Fetch deliveries using optimized incremental approach
    const backendDeliveries = [];
    const today = new Date();
    const todayStr = format(today, 'yyyy-MM-dd');
    
    // Priority dates first
    const priorityDates = [todayStr];
    for (const dateStr of priorityDates) {
      const dateDeliveries = await Delivery.filter({ delivery_date: dateStr });
      backendDeliveries.push(...dateDeliveries);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Then scan backwards/forwards with early exit
    let consecutiveDaysWithoutChanges = 0;
    const datesToCheck = [];
    
    for (let i = 1; i <= 7; i++) {
      const futureDate = new Date(today);
      futureDate.setDate(today.getDate() + i);
      datesToCheck.push(format(futureDate, 'yyyy-MM-dd'));
    }
    
    for (let i = 1; i <= LOCAL_CACHE_DAYS; i++) {
      const pastDate = new Date(today);
      pastDate.setDate(today.getDate() - i);
      datesToCheck.push(format(pastDate, 'yyyy-MM-dd'));
    }
    
    for (const dateStr of datesToCheck) {
      // Check pause state
      if (syncPaused) {
        console.log('⏸️ [OfflineSync] performBidirectionalSync interrupted - sync paused');
        break;
      }

      const localForDate = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
      const backendForDate = await Delivery.filter({ delivery_date: dateStr });
      
      const hasChanges = checkForChanges(localForDate, backendForDate);
      
      if (hasChanges) {
        backendDeliveries.push(...backendForDate);
        consecutiveDaysWithoutChanges = 0;
      } else {
        backendDeliveries.push(...localForDate);
        consecutiveDaysWithoutChanges++;
      }
      
      if (consecutiveDaysWithoutChanges >= 10) {
        console.log(`🛑 [OfflineSync] Early exit after 10 days without changes`);
        break;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const [localPatients, localDeliveries] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.PATIENTS),
      offlineDB.getAll(offlineDB.STORES.DELIVERIES)
    ]);

    const cleanBackendPatients = backendPatients.filter(p => !p.id.startsWith('temp_'));
    const cleanBackendDeliveries = backendDeliveries.filter(d => !d.id.startsWith('temp_'));
    
    // Compare and merge (with deletion detection)
    const updatedPatients = await mergeData(localPatients, cleanBackendPatients, 'Patient');
    const updatedDeliveries = await mergeData(localDeliveries, cleanBackendDeliveries, 'Delivery');

    if (updatedPatients.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, updatedPatients);
    }
    
    if (updatedDeliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, updatedDeliveries);
    }

    // Update sync status
    await Promise.all([
      offlineDB.updateSyncStatus('Patient', { recordCount: backendPatients.length, status: 'synced' }),
      offlineDB.updateSyncStatus('Delivery', { recordCount: backendDeliveries.length, status: 'synced' })
    ]);

    const results = {
      patients: { total: backendPatients.length, updated: updatedPatients.length },
      deliveries: { total: backendDeliveries.length, updated: updatedDeliveries.length }
    };

    notifySyncStatus({ status: 'complete', results });
    window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
    return results;
  } catch (error) {
    notifySyncStatus({ status: 'error', error: error.message });
    throw error;
  } finally {
    syncInProgress = false;
  }
};

/**
 * Merge local and backend data - backend wins for conflicts (newer updated_date)
 * CRITICAL: Also handles deletions by removing records that exist locally but not on backend
 */
const mergeData = async (localRecords, backendRecords, entityName) => {
  const localMap = new Map(localRecords.map(r => [r.id, r]));
  const backendIds = new Set(backendRecords.map(r => r.id));
  const merged = [];

  // STEP 1: Process backend records (new + updated)
  for (const backendRecord of backendRecords) {
    const localRecord = localMap.get(backendRecord.id);
    
    if (!localRecord) {
      // New record from backend
      merged.push(backendRecord);
    } else {
      // Compare updated_date - backend wins if newer or equal
      const backendTime = new Date(backendRecord.updated_date || backendRecord.created_date).getTime();
      const localTime = new Date(localRecord.updated_date || localRecord.created_date).getTime();
      
      if (backendTime >= localTime) {
        merged.push(backendRecord);
      } else {
        // Keep local version if newer
        merged.push(localRecord);
      }
    }
  }

  // STEP 2: CRITICAL - Delete records that exist locally but NOT on backend
  // These were deleted by other users/devices and need to be removed locally
  const recordsToDelete = [];
  for (const localRecord of localRecords) {
    // Skip temp records (they're local-only and will be synced later)
    if (localRecord.id.startsWith('temp_')) {
      merged.push(localRecord);
      continue;
    }
    
    if (!backendIds.has(localRecord.id)) {
      recordsToDelete.push(localRecord.id);
    }
  }

  if (recordsToDelete.length > 0) {
    const db = await offlineDB.openDatabase();
    const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
    const transaction = db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);
    
    for (const id of recordsToDelete) {
      await new Promise((resolve, reject) => {
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    }
  }

  return merged;
};

/**
 * Get sync statistics including full sync status
 */
export const getSyncStats = async () => {
  const stats = await offlineDB.getStats();
  const pendingMutations = await offlineDB.getPendingMutations();
  
  // Get sync status for each entity
  const patientStatus = await offlineDB.getSyncStatus('Patient');
  const deliveryStatus = await offlineDB.getSyncStatus('Delivery');
  
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
      }
    }
  };
};