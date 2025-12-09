/**
 * Offline Sync Manager
 * Handles background synchronization of Patients and Deliveries to IndexedDB
 */

import { offlineDB } from './offlineDatabase';
import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { format, subDays } from 'date-fns';

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

    // FIRST: Process any pending mutations from previous session
    await processPendingMutations();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Check if sync is needed
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
 * Process pending mutations (push local changes to server)
 */
export const processPendingMutations = async () => {
  const pendingMutations = await offlineDB.getPendingMutations();
  
  if (pendingMutations.length === 0) {
    console.log('✅ [OfflineSync] No pending mutations to process');
    return { success: true, processed: 0 };
  }

  console.log(`🔄 [OfflineSync] Processing ${pendingMutations.length} pending mutations...`);
  notifySyncStatus({ status: 'syncing_mutations', count: pendingMutations.length });

  let successCount = 0;
  let failCount = 0;

  for (const mutation of pendingMutations) {
    try {
      const Entity = mutation.entity === 'Patient' ? 
        (await import('@/entities/Patient')).Patient : 
        (await import('@/entities/Delivery')).Delivery;

      let serverRecord = null;

      switch (mutation.operation) {
        case 'create':
          // Create on server
          serverRecord = await Entity.create(mutation.payload);
          
          // Update local record with real server ID
          const storeName = mutation.entity === 'Patient' ? 
            offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
          
          // Remove temp record
          const allRecords = await offlineDB.getAll(storeName);
          const tempRecord = allRecords.find(r => r.id === mutation.recordId);
          
          if (tempRecord && serverRecord) {
            // Save server record with real ID
            const finalRecord = {
              ...tempRecord,
              ...serverRecord,
              _isPending: false
            };
            await offlineDB.bulkSave(storeName, [finalRecord]);
          }
          
          console.log(`✅ [OfflineSync] Created ${mutation.entity} on server: ${serverRecord.id}`);
          break;

        case 'update':
          // Skip if temp ID (should be created first)
          if (mutation.recordId.startsWith('temp_')) {
            console.log(`⏭️ [OfflineSync] Skipping update for temp ID: ${mutation.recordId}`);
            continue;
          }
          
          serverRecord = await Entity.update(mutation.recordId, mutation.payload);
          console.log(`✅ [OfflineSync] Updated ${mutation.entity} on server: ${mutation.recordId}`);
          break;

        case 'delete':
          // Skip if temp ID
          if (mutation.recordId.startsWith('temp_')) {
            console.log(`⏭️ [OfflineSync] Skipping delete for temp ID: ${mutation.recordId}`);
            continue;
          }
          
          await Entity.delete(mutation.recordId);
          
          // Remove from local DB
          const deleteStoreName = mutation.entity === 'Patient' ? 
            offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
          const allDeleteRecords = await offlineDB.getAll(deleteStoreName);
          const remainingRecords = allDeleteRecords.filter(r => r.id !== mutation.recordId);
          await offlineDB.clearStore(deleteStoreName);
          await offlineDB.bulkSave(deleteStoreName, remainingRecords);
          
          console.log(`✅ [OfflineSync] Deleted ${mutation.entity} on server: ${mutation.recordId}`);
          break;
      }

      // Remove from pending queue
      await offlineDB.removePendingMutation(mutation.mutationId);
      successCount++;

    } catch (error) {
      console.error(`❌ [OfflineSync] Failed to sync ${mutation.operation} for ${mutation.entity}:`, error);
      
      // Increment retry count
      const newRetryCount = (mutation.retryCount || 0) + 1;
      if (newRetryCount < 5) {
        await offlineDB.updateMutationRetryCount(mutation.mutationId, newRetryCount);
      } else {
        console.error(`❌ [OfflineSync] Mutation ${mutation.mutationId} failed after 5 retries`);
      }
      
      failCount++;
    }

    // Small delay between mutations to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log(`✅ [OfflineSync] Mutation sync complete: ${successCount} succeeded, ${failCount} failed`);
  notifySyncStatus({ status: 'mutations_synced', successCount, failCount });

  return { success: true, processed: successCount, failed: failCount };
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