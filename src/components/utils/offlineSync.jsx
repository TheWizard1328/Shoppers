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
 * Get sync statistics
 */
export const getSyncStats = async () => {
  return await offlineDB.getStats();
};