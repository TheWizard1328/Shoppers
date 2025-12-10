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
const SYNC_DELAY_BETWEEN_BATCHES = 500; // 500ms delay between batches

let syncInProgress = false;
let syncListeners = [];

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
    } catch (error) {
      console.error('Error in sync status listener:', error);
    }
  });
};

/**
 * Sync Patients to IndexedDB
 */
const syncPatients = async () => {
  console.log('🔄 [OfflineSync] Starting Patient sync...');
  notifySyncStatus({ entity: 'Patient', status: 'syncing', progress: 0 });

  try {
    // Fetch all patients from backend
    const patients = await Patient.list();
    console.log(`📥 [OfflineSync] Fetched ${patients.length} patients from backend`);

    // Save to IndexedDB in batches
    const batches = [];
    for (let i = 0; i < patients.length; i += BATCH_SIZE) {
      batches.push(patients.slice(i, i + BATCH_SIZE));
    }

    let totalSaved = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const result = await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batch);
      totalSaved += result.count;
      
      const progress = Math.round(((i + 1) / batches.length) * 100);
      notifySyncStatus({ entity: 'Patient', status: 'syncing', progress, count: totalSaved });
      
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, SYNC_DELAY_BETWEEN_BATCHES));
      }
    }

    // Update sync status
    await offlineDB.updateSyncStatus('Patient', {
      recordCount: totalSaved,
      status: 'synced'
    });

    console.log(`✅ [OfflineSync] Patient sync complete - ${totalSaved} records saved`);
    notifySyncStatus({ entity: 'Patient', status: 'synced', count: totalSaved });
    
    return { success: true, count: totalSaved };
  } catch (error) {
    console.error('❌ [OfflineSync] Patient sync failed:', error);
    notifySyncStatus({ entity: 'Patient', status: 'error', error: error.message });
    return { success: false, error: error.message };
  }
};

/**
 * Sync Deliveries to IndexedDB (last 60 days + next 30 days)
 */
const syncDeliveries = async () => {
  console.log('🔄 [OfflineSync] Starting Delivery sync...');
  notifySyncStatus({ entity: 'Delivery', status: 'syncing', progress: 0 });

  try {
    const today = new Date();
    const startDate = format(subDays(today, 60), 'yyyy-MM-dd'); // Last 60 days
    const endDate = format(subDays(today, -30), 'yyyy-MM-dd'); // Next 30 days

    console.log(`📥 [OfflineSync] Fetching deliveries from ${startDate} to ${endDate}`);

    // Fetch deliveries in date range
    const deliveries = await Delivery.filter({
      delivery_date: {
        $gte: startDate,
        $lte: endDate
      }
    }, '-updated_date');

    console.log(`📥 [OfflineSync] Fetched ${deliveries.length} deliveries from backend`);

    // Save to IndexedDB in batches
    const batches = [];
    for (let i = 0; i < deliveries.length; i += BATCH_SIZE) {
      batches.push(deliveries.slice(i, i + BATCH_SIZE));
    }

    let totalSaved = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const result = await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, batch);
      totalSaved += result.count;
      
      const progress = Math.round(((i + 1) / batches.length) * 100);
      notifySyncStatus({ entity: 'Delivery', status: 'syncing', progress, count: totalSaved });
      
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, SYNC_DELAY_BETWEEN_BATCHES));
      }
    }

    // Update sync status
    await offlineDB.updateSyncStatus('Delivery', {
      recordCount: totalSaved,
      status: 'synced'
    });

    console.log(`✅ [OfflineSync] Delivery sync complete - ${totalSaved} records saved`);
    notifySyncStatus({ entity: 'Delivery', status: 'synced', count: totalSaved });
    
    return { success: true, count: totalSaved };
  } catch (error) {
    console.error('❌ [OfflineSync] Delivery sync failed:', error);
    notifySyncStatus({ entity: 'Delivery', status: 'error', error: error.message });
    return { success: false, error: error.message };
  }
};

/**
 * Perform initial sync if needed
 */
export const performInitialSync = async () => {
  if (syncInProgress) {
    console.log('⏸️ [OfflineSync] Sync already in progress, skipping');
    return;
  }

  syncInProgress = true;
  notifySyncStatus({ status: 'starting' });

  try {
    console.log('🚀 [OfflineSync] Starting initial sync check...');

    // FIRST: Process pending mutations (push local changes to backend)
    console.log('📤 [OfflineSync] Processing pending mutations first...');
    await processPendingMutations();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // THEN: Check if sync is needed
    const [needsPatientSync, needsDeliverySync] = await Promise.all([
      offlineDB.needsInitialSync('Patient'),
      offlineDB.needsInitialSync('Delivery')
    ]);

    const results = { patients: null, deliveries: null };

    // Sync patients if needed
    if (needsPatientSync) {
      console.log('📋 [OfflineSync] Patient sync needed');
      results.patients = await syncPatients();
      // Wait 2 seconds between syncs to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      console.log('✅ [OfflineSync] Patient data is up to date');
    }

    // Sync deliveries if needed
    if (needsDeliverySync) {
      console.log('📋 [OfflineSync] Delivery sync needed');
      results.deliveries = await syncDeliveries();
    } else {
      console.log('✅ [OfflineSync] Delivery data is up to date');
    }

    console.log('✅ [OfflineSync] Initial sync complete', results);
    notifySyncStatus({ status: 'complete', results });

    return results;
  } catch (error) {
    console.error('❌ [OfflineSync] Initial sync failed:', error);
    notifySyncStatus({ status: 'error', error: error.message });
    throw error;
  } finally {
    syncInProgress = false;
  }
};

/**
 * Force sync (clear and re-sync all data)
 */
export const forceSyncAll = async () => {
  if (syncInProgress) {
    console.log('⏸️ [OfflineSync] Sync already in progress, skipping force sync');
    return;
  }

  syncInProgress = true;
  notifySyncStatus({ status: 'force_syncing' });

  try {
    console.log('🔄 [OfflineSync] Force sync - clearing existing data...');

    // Clear existing data
    await Promise.all([
      offlineDB.clearStore(offlineDB.STORES.PATIENTS),
      offlineDB.clearStore(offlineDB.STORES.DELIVERIES)
    ]);

    // Re-sync everything
    const results = {
      patients: await syncPatients(),
      deliveries: await syncDeliveries()
    };

    console.log('✅ [OfflineSync] Force sync complete', results);
    notifySyncStatus({ status: 'complete', results });

    return results;
  } catch (error) {
    console.error('❌ [OfflineSync] Force sync failed:', error);
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
  const mutations = await offlineDB.getPendingMutations();
  
  if (mutations.length === 0) {
    console.log('✅ [OfflineSync] No pending mutations to process');
    return { success: true, processed: 0 };
  }

  console.log(`🔄 [OfflineSync] Processing ${mutations.length} pending mutations...`);
  notifySyncStatus({ status: 'processing_mutations', count: mutations.length });

  let successCount = 0;
  let failCount = 0;

  for (const mutation of mutations) {
    try {
      // CRITICAL: Remove invalid update/delete operations on temporary IDs
      if ((mutation.operation === 'update' || mutation.operation === 'delete') && mutation.recordId.startsWith('temp_')) {
        console.warn(`🗑️ [OfflineSync] Removing invalid ${mutation.operation} for temp ID ${mutation.recordId}`);
        await offlineDB.removePendingMutation(mutation.mutationId);
        continue;
      }

      console.log(`📤 [OfflineSync] Syncing ${mutation.operation} ${mutation.entity}:${mutation.recordId}`);
      
      // Execute the mutation on the backend
      const Entity = mutation.entity === 'Patient' ? Patient : Delivery;
      if (mutation.operation === 'create') {
        await Entity.create(mutation.payload);
      } else if (mutation.operation === 'update') {
        await Entity.update(mutation.recordId, mutation.payload);
      } else if (mutation.operation === 'delete') {
        await Entity.delete(mutation.recordId);
      }

      // Remove from pending queue on success
      await offlineDB.removePendingMutation(mutation.mutationId);
      successCount++;
      
      console.log(`✅ [OfflineSync] Successfully synced ${mutation.operation} ${mutation.entity}:${mutation.recordId}`);
      
      // Small delay between mutations to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 200));
      
    } catch (error) {
      console.error(`❌ [OfflineSync] Failed to sync ${mutation.operation} ${mutation.entity}:${mutation.recordId}:`, error);
      
      // Update retry count
      await offlineDB.updateMutationRetry(mutation.mutationId, (mutation.retryCount || 0) + 1);
      failCount++;
      
      // If rate limited, stop processing and retry later
      if (error.response?.status === 429 || error.message?.includes('429')) {
        console.warn('⏰ [OfflineSync] Rate limited - stopping mutation processing');
        break;
      }
    }
  }

  console.log(`✅ [OfflineSync] Mutation processing complete: ${successCount} succeeded, ${failCount} failed`);
  notifySyncStatus({ status: 'mutations_processed', successCount, failCount });

  return { success: failCount === 0, processed: successCount, failed: failCount };
};

/**
 * Bidirectional sync - compare local vs online and update both sides
 */
export const performBidirectionalSync = async () => {
  if (syncInProgress) {
    console.log('⏸️ [OfflineSync] Sync already in progress, skipping bidirectional sync');
    return;
  }

  syncInProgress = true;
  notifySyncStatus({ status: 'bidirectional_syncing' });

  try {
    console.log('🔄 [OfflineSync] Starting bidirectional sync...');

    // STEP 1: Push local changes to backend
    console.log('📤 [OfflineSync] Step 1/2: Pushing local changes to backend...');
    await processPendingMutations();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // STEP 2: Pull backend changes and compare with local database
    console.log('📥 [OfflineSync] Step 2/2: Pulling backend changes and comparing...');
    
    // Fetch from backend
    const [backendPatients, backendDeliveries] = await Promise.all([
      Patient.list(),
      (async () => {
        const today = new Date();
        const startDate = format(subDays(today, 60), 'yyyy-MM-dd');
        const endDate = format(subDays(today, -30), 'yyyy-MM-dd');
        return Delivery.filter({
          delivery_date: { $gte: startDate, $lte: endDate }
        }, '-updated_date');
      })()
    ]);

    console.log(`📥 Fetched ${backendPatients.length} patients and ${backendDeliveries.length} deliveries from backend`);

    // Get local data
    const [localPatients, localDeliveries] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.PATIENTS),
      offlineDB.getAll(offlineDB.STORES.DELIVERIES)
    ]);

    console.log(`💾 Found ${localPatients.length} patients and ${localDeliveries.length} deliveries in local database`);

    // Compare and merge
    const updatedPatients = mergeData(localPatients, backendPatients);
    const updatedDeliveries = mergeData(localDeliveries, backendDeliveries);

    // Save merged data to local database
    if (updatedPatients.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, updatedPatients);
      console.log(`✅ Updated ${updatedPatients.length} patients in local database`);
    }
    
    if (updatedDeliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, updatedDeliveries);
      console.log(`✅ Updated ${updatedDeliveries.length} deliveries in local database`);
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

    console.log('✅ [OfflineSync] Bidirectional sync complete', results);
    notifySyncStatus({ status: 'complete', results });

    // Dispatch event to trigger UI refresh
    window.dispatchEvent(new CustomEvent('offlineSyncComplete'));

    return results;
  } catch (error) {
    console.error('❌ [OfflineSync] Bidirectional sync failed:', error);
    notifySyncStatus({ status: 'error', error: error.message });
    throw error;
  } finally {
    syncInProgress = false;
  }
};

/**
 * Merge local and backend data - backend wins for conflicts (newer updated_date)
 */
const mergeData = (localRecords, backendRecords) => {
  const localMap = new Map(localRecords.map(r => [r.id, r]));
  const merged = [];

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

  return merged;
};

/**
 * Get sync statistics
 */
export const getSyncStats = async () => {
  const stats = await offlineDB.getStats();
  const pendingMutations = await offlineDB.getPendingMutations();
  
  return {
    ...stats,
    pendingMutations: pendingMutations.length
  };
};