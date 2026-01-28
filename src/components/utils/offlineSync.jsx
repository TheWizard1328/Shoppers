/**
 * Offline Sync Manager v2
 * 
 * STRATEGY:
 * 1. If offline DB is fresh (< 10 min), load from there FIRST then refresh from online
 * 2. Priority order: AppUsers → Deliveries (selected date) → Patients (for those deliveries)
 * 3. Background sync: Today + 6 future days, then past 14 days (7 days at a time)
 * 4. Patient sync: 250 at a time with 1 sec cooldown
 * 5. NEVER clear the entire DB - only merge/update records
 */

import { offlineDB } from './offlineDatabase';
import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { AppUser } from '@/entities/AppUser';
import { City } from '@/entities/City';
import { SquareTransaction } from '@/entities/SquareTransaction';
import { format, subDays } from 'date-fns';

// Configuration
const FRESHNESS_THRESHOLD = 10 * 60 * 1000; // 10 minutes
const PATIENT_BATCH_SIZE = 250; // 250 patients at a time
const BATCH_COOLDOWN = 1000; // 1 second between batches
const HISTORICAL_COOLDOWN = 5 * 60 * 1000; // 5 minutes between historical date syncs
const HISTORICAL_DAYS = 90; // Keep 90 days of historical data for offline access
const FULL_SYNC_INTERVAL = 48 * 60 * 60 * 1000; // 48 hours between full re-syncs (was 8h)

let syncInProgress = false;
let syncPaused = false;
let syncListeners = [];

// ==================== SYNC CONTROL ====================

export const pauseOfflineSync = () => {
  console.log('⏸️ [OfflineSync] Paused');
  syncPaused = true;
};

export const resumeOfflineSync = () => {
  console.log('▶️ [OfflineSync] Resumed');
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

// ==================== FRESHNESS CHECK ====================

/**
 * Check if offline data is fresh (synced within last 10 minutes)
 */
const isOfflineDataFresh = async (entityName) => {
  const syncStatus = await offlineDB.getSyncStatus(entityName);
  if (!syncStatus || !syncStatus.lastSync) return false;
  
  const lastSyncTime = new Date(syncStatus.lastSync).getTime();
  const age = Date.now() - lastSyncTime;
  
  return age < FRESHNESS_THRESHOLD;
};

/**
 * Get the last sync timestamp for incremental fetching
 */
const getLastSyncTimestamp = async (entityName) => {
  const syncStatus = await offlineDB.getSyncStatus(entityName);
  if (!syncStatus || !syncStatus.lastSync) return null;
  return syncStatus.lastSync;
};

/**
 * Build incremental filter for entity fetching
 * Returns a filter that only fetches records updated since last sync
 */
const buildIncrementalFilter = (lastSyncTimestamp, existingFilter = {}) => {
  if (!lastSyncTimestamp) {
    return existingFilter; // No previous sync, fetch all
  }
  
  return {
    ...existingFilter,
    updated_date: { $gte: lastSyncTimestamp }
  };
};

/**
 * Get all fresh offline data if available
 */
export const getOfflineDataIfFresh = async () => {
  const [deliveryFresh, patientFresh, appUserFresh, cityFresh] = await Promise.all([
    isOfflineDataFresh('Delivery'),
    isOfflineDataFresh('Patient'),
    isOfflineDataFresh('AppUser'),
    isOfflineDataFresh('City')
  ]);
  
  if (!deliveryFresh && !patientFresh && !appUserFresh && !cityFresh) {
    return null; // Not fresh, need to fetch from online
  }
  
  const [deliveries, patients, appUsers, cities] = await Promise.all([
    deliveryFresh ? offlineDB.getAll(offlineDB.STORES.DELIVERIES) : [],
    patientFresh ? offlineDB.getAll(offlineDB.STORES.PATIENTS) : [],
    appUserFresh ? offlineDB.getAll(offlineDB.STORES.APP_USERS) : [],
    cityFresh ? offlineDB.getAll(offlineDB.STORES.CITIES) : []
  ]);
  
  return {
    deliveries: deliveryFresh ? deliveries : null,
    patients: patientFresh ? patients : null,
    appUsers: appUserFresh ? appUsers : null,
    cities: cityFresh ? cities : null,
    deliveryFresh,
    patientFresh,
    appUserFresh,
    cityFresh
  };
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
  console.log(`📥 [OfflineSync] Loading priority data for ${selectedDateStr}...`);
  notifySyncStatus({ status: 'loading_priority', date: selectedDateStr });
  
  try {
    // Step 1: Cities (fast, small dataset) - save to offline DB
    const cities = await City.list();
    console.log(`   ✅ Loaded ${cities.length} Cities`);
    await offlineDB.bulkSave(offlineDB.STORES.CITIES, cities);
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    // Step 2: AppUsers (fast, small dataset) - save to offline DB
    const appUsers = await AppUser.list();
    console.log(`   ✅ Loaded ${appUsers.length} AppUsers`);
    await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
    
    await new Promise(r => setTimeout(r, 3000)); // Increased from 1s to 3s
    
    // Step 3: Deliveries for selected date
    const deliveryFilter = { delivery_date: selectedDateStr, ...filters };
    const deliveries = await Delivery.filter(deliveryFilter);
    console.log(`   ✅ Loaded ${deliveries.length} deliveries for ${selectedDateStr}`);
    
    // Save to offline DB immediately (merge, don't clear)
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    
    await new Promise(r => setTimeout(r, 3000)); // Increased from 1s to 3s
    
    // Step 4: CRITICAL - Load ALL patients (not just delivery-linked ones)
    // This ensures map markers work for new users who don't have patient data yet
    console.log(`   👥 Loading ALL patients for offline access...`);
    let patients = [];
    
    try {
      // First try active patients
      const allPatients = await Patient.filter({ status: 'active' }, '-created_date', 5000);
      patients = allPatients.filter(p => p && p.id && !p.id.startsWith('temp_'));
      console.log(`   ✅ Loaded ${patients.length} active patients`);
      
      // If no active patients found, try without filter
      if (patients.length === 0) {
        const allPatientsNoFilter = await Patient.list('-created_date', 5000);
        patients = allPatientsNoFilter.filter(p => p && p.id && !p.id.startsWith('temp_'));
        console.log(`   ✅ Loaded ${patients.length} patients (no filter)`);
      }
      
      if (patients.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patients);
      }
    } catch (patientError) {
      console.warn(`   ⚠️ Patient bulk load failed, falling back to delivery-linked:`, patientError.message);
      
      // Fallback: Just load patients for current deliveries
      const patientIds = [...new Set(deliveries.map(d => d.patient_id).filter(Boolean))];
      if (patientIds.length > 0) {
        for (let i = 0; i < patientIds.length; i += PATIENT_BATCH_SIZE) {
          if (syncPaused) break;
          const batchIds = patientIds.slice(i, i + PATIENT_BATCH_SIZE);
          const batchPatients = await Patient.filter({ id: { $in: batchIds } });
          patients.push(...batchPatients);
          if (i + PATIENT_BATCH_SIZE < patientIds.length) {
            await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
          }
        }
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patients);
      }
    }
    
    // Update sync timestamps - CRITICAL: Mark ALL as full sync after priority load
    // Don't mark SquareTransaction as synced here - it gets synced in background
    await Promise.all([
      offlineDB.updateSyncStatus('City', { 
        recordCount: cities.length, 
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      }),
      offlineDB.updateSyncStatus('AppUser', { 
        recordCount: appUsers.length, 
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      }),
      offlineDB.updateSyncStatus('Delivery', { 
        recordCount: deliveries.length, 
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      }),
      offlineDB.updateSyncStatus('Patient', { 
        recordCount: patients.length, 
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      })
    ]);

    notifySyncStatus({ status: 'priority_loaded', cities: cities.length, appUsers: appUsers.length, deliveries: deliveries.length, patients: patients.length });

    syncInProgress = false;
    return { cities, appUsers, deliveries, patients };
  } catch (error) {
    console.error('❌ [OfflineSync] Priority load failed:', error);
    notifySyncStatus({ status: 'error', error: error.message });
    syncInProgress = false;
    return { error: error.message };
  }
};

// ==================== BACKGROUND SYNC ====================

/**
 * Background sync with timestamp-based incremental strategy
 * CRITICAL: Uses updated_date to fetch all changed records across 90 days in 1-2 API calls
 * Prioritizes today's deliveries first, then resumes historical checkpoint if interrupted
 */
export const performBackgroundSync = async (selectedDateStr, storeIds = null) => {
  if (syncInProgress || syncPaused) {
    console.log(`⏸️ [OfflineSync] Background sync skipped - ${syncInProgress ? 'in progress' : 'paused'}`);
    return { skipped: true };
  }
  
  syncInProgress = true;
  console.log('📥 [OfflineSync] Starting background sync (timestamp-based)...');
  notifySyncStatus({ status: 'background_syncing' });
  
  const today = new Date();
  const todayStr = format(today, 'yyyy-MM-dd');
  
  try {
    // ===== STEP 1: Priority - TODAY's deliveries first =====
    console.log(`   📅 Syncing today's deliveries (${todayStr})...`);
    const todayDeliveries = await Delivery.filter({ delivery_date: todayStr, ...(storeIds && storeIds.length > 0 ? { store_id: { $in: storeIds } } : {}) });
    if (todayDeliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, todayDeliveries);
      console.log(`   ✅ Today's deliveries: ${todayDeliveries.length} records synced`);
    }
    
    // ===== STEP 2: Timestamp-based incremental sync (catches all changes across 90 days) =====
    console.log('   📅 Checking for delivery updates via timestamp...');
    
    const deliverySyncStatus = await offlineDB.getSyncStatus('Delivery');
    const lastSyncTime = deliverySyncStatus?.lastSync;
    const lastHistoricalCheckpoint = deliverySyncStatus?.lastHistoricalCheckpoint;
    
    // Build incremental filter - fetches ALL modified records since last sync
    const incrementalFilter = lastSyncTime 
      ? { updated_date: { $gte: lastSyncTime } }
      : {};
    
    if (storeIds && storeIds.length > 0) {
      incrementalFilter.store_id = { $in: storeIds };
    }
    
    try {
      console.log(`   ♻️ Fetching deliveries updated since ${lastSyncTime ? new Date(lastSyncTime).toISOString() : 'beginning'}...`);
      const changedDeliveries = await Delivery.filter(incrementalFilter, '-updated_date', 5000);
      
      if (changedDeliveries.length > 0) {
        // Separate today from historical
        const todayChanges = changedDeliveries.filter(d => d.delivery_date === todayStr);
        const historicalChanges = changedDeliveries.filter(d => d.delivery_date !== todayStr);
        
        // Save all at once (merge, don't replace)
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, changedDeliveries);
        console.log(`   ✅ Merged ${changedDeliveries.length} delivery updates (today: ${todayChanges.length}, historical: ${historicalChanges.length})`);
      } else {
        console.log(`   ℹ️ No delivery updates since last sync`);
      }
    } catch (error) {
      console.warn(`   ⚠️ Delivery timestamp sync failed:`, error.message);
    }
    
    // Update sync timestamp - marks when we last checked for changes
    await offlineDB.updateSyncStatus('Delivery', {
      lastSync: new Date().toISOString()
    });
    console.log(`   ✅ Delivery sync checkpoint updated`);
    
    // ===== STEP 3: Timestamp-based Patient sync =====
    if (!syncPaused) {
      console.log('   👥 Syncing patients via timestamp...');
      const patientSyncStatus = await offlineDB.getSyncStatus('Patient');
      const patientLastSync = patientSyncStatus?.lastSync;
      
      const patientFilter = patientLastSync
        ? { updated_date: { $gte: patientLastSync }, status: 'active' }
        : { status: 'active' };
      
      try {
        console.log(`   ♻️ Fetching patients updated since ${patientLastSync ? new Date(patientLastSync).toISOString() : 'beginning'}...`);
        const patients = await Patient.filter(patientFilter, '-updated_date', 5000);
        
        if (patients.length > 0) {
          const cleanPatients = patients.filter(p => p && p.id && !p.id.startsWith('temp_'));
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, cleanPatients);
          console.log(`   ✅ Patient timestamp sync: ${cleanPatients.length} records updated`);
        } else if (!patientLastSync) {
          console.log(`   ℹ️ No active patients found on initial sync`);
        } else {
          console.log(`   ℹ️ No patient updates since last sync`);
        }
      } catch (patientError) {
        console.warn(`   ⚠️ Patient timestamp sync failed:`, patientError.message);
      }
      
      await offlineDB.updateSyncStatus('Patient', {
        lastSync: new Date().toISOString()
      });
    }

    // CRITICAL: Add 3-second delays between entity syncs to prevent rate limits
    await new Promise(r => setTimeout(r, 3000));
    
    // ===== STEP 4: Sync Cities (incremental via timestamp) =====
    if (!syncPaused) {
      console.log('   🏙️ Syncing Cities...');
      try {
        const cityLastSync = await getLastSyncTimestamp('City');
        const cityFilter = cityLastSync ? { updated_date: { $gte: cityLastSync } } : {};
        const cities = await City.filter(cityFilter, '-updated_date', 1000);
        
        if (cities.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.CITIES, cities);
          console.log(`   ✅ City sync: ${cities.length} records`);
        }
        
        await offlineDB.updateSyncStatus('City', {
          recordCount: cities.length,
          lastSync: new Date().toISOString()
        });
      } catch (cityError) {
        console.warn(`   ⚠️ City sync failed:`, cityError.message);
      }
    }

    await new Promise(r => setTimeout(r, 3000));

    // ===== STEP 5: Sync AppUsers (incremental via timestamp) =====
    if (!syncPaused) {
      console.log('   👤 Syncing AppUsers...');
      try {
        const appUserLastSync = await getLastSyncTimestamp('AppUser');
        const appUserFilter = appUserLastSync ? { updated_date: { $gte: appUserLastSync } } : {};
        const appUsers = await AppUser.filter(appUserFilter, '-updated_date', 1000);
        
        if (appUsers.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
          console.log(`   ✅ AppUser sync: ${appUsers.length} records`);
        }
        
        await offlineDB.updateSyncStatus('AppUser', {
          recordCount: appUsers.length,
          lastSync: new Date().toISOString()
        });
      } catch (appUserError) {
        console.warn(`   ⚠️ AppUser sync failed:`, appUserError.message);
      }
    }

    // DISABLED: Square Transactions now sync via real-time events only
    // They update when COD items are created/edited/deleted, not on background sync
    
    // Update final sync status with actual counts from DB
    const stats = await offlineDB.getStats();
    
    console.log(`✅ [OfflineSync] Final counts - Deliveries: ${stats?.deliveries?.count || 0}, Patients: ${stats?.patients?.count || 0}, Cities: ${stats?.cities?.count || 0}, AppUsers: ${stats?.appUsers?.count || 0}`);
    
    await Promise.all([
       offlineDB.updateSyncStatus('City', {
         recordCount: stats?.cities?.count || 0,
         status: 'synced',
         lastSync: new Date().toISOString()
       }),
       offlineDB.updateSyncStatus('AppUser', {
         recordCount: stats?.appUsers?.count || 0,
         status: 'synced',
         lastSync: new Date().toISOString()
       }),

       offlineDB.updateSyncStatus('Delivery', {
         recordCount: stats?.deliveries?.count || 0,
         status: 'synced',
         lastSync: new Date().toISOString()
       }),
       offlineDB.updateSyncStatus('Patient', {
         recordCount: stats?.patients?.count || 0,
         status: 'synced',
         lastSync: new Date().toISOString()
       })
     ]);
    
    console.log('✅ [OfflineSync] Background sync complete - 90-day history loaded');
    notifySyncStatus({ status: 'complete' });
    window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
    
    return { success: true };
  } catch (error) {
    console.error('❌ [OfflineSync] Background sync failed:', error);
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
  
  console.log(`📥 [OfflineSync] Loading deliveries for ${dateStr} (on-demand)...`);
  
  try {
    const deliveries = await Delivery.filter({ delivery_date: dateStr });
    
    if (deliveries.length > 0) {
      // Add to offline DB (merge, don't replace)
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
      console.log(`   ✅ Cached ${deliveries.length} deliveries for ${dateStr}`);
    }
    
    return deliveries;
  } catch (error) {
    console.warn(`   ⚠️ Failed to load ${dateStr}:`, error.message);
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
    console.log(`⏸️ [OfflineSync] performInitialSync skipped`);
    return { skipped: true };
  }
  
  const selectedDateStr = selectedDate 
    ? format(selectedDate, 'yyyy-MM-dd') 
    : format(new Date(), 'yyyy-MM-dd');
  
  // Check if patient data exists in offline DB (for new user detection)
  const existingPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
  const hasPatientData = existingPatients && existingPatients.length > 50; // Threshold for "has data"

  // Check if offline data is fresh
  const freshData = await getOfflineDataIfFresh();

  // CRITICAL: Even if delivery data is fresh, if patient data is missing/sparse, reload it
  if (freshData && freshData.deliveryFresh && freshData.patientFresh && freshData.appUserFresh && freshData.cityFresh && hasPatientData) {
    console.log('⏭️ [OfflineSync] Offline data is fresh (< 10 min), using cached data');
    
    // Schedule background refresh after 30 seconds
    setTimeout(() => {
      performBackgroundSync(selectedDateStr).catch(() => {});
    }, 30000);
    
    return { 
      fromCache: true, 
      deliveries: freshData.deliveries?.length || 0,
      patients: freshData.patients?.length || 0,
      appUsers: freshData.appUsers?.length || 0,
      cities: freshData.cities?.length || 0
    };
  }
  
  // CRITICAL: If patient data is sparse (new user scenario), force full patient sync
  if (!hasPatientData) {
    console.log('🆕 [OfflineSync] New user detected - patient data sparse, forcing full sync');
  }
  
  // Data not fresh OR patient data missing - load priority data first (includes ALL patients)
  const priorityResult = await loadPriorityData(selectedDateStr);
  
  if (priorityResult.error) {
    return priorityResult;
  }
  
  // Schedule background sync after 10 seconds
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
  
  // CRITICAL: Process deletes in parallel (batch delete)
  if (deletes.length > 0) {
    console.log(`🗑️ [OfflineSync] Batch deleting ${deletes.length} records...`);
    
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
        console.warn(`⚠️ [OfflineSync] Rate limited - waiting 30 seconds...`);
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }
  
  console.log(`✅ [OfflineSync] Batch complete: ${successCount} succeeded, ${failCount} failed, ${mutations.length - batch.length} remaining`);
  
  return { success: failCount === 0, processed: successCount, failed: failCount, remaining: mutations.length - batch.length };
};

export const forceSyncAll = async () => {
  if (syncPaused) return { skipped: true };
  
  // CRITICAL: Allow manual sync to override background sync
  const wasInProgress = syncInProgress;
  syncInProgress = true;
  console.log(`🔄 [forceSyncAll] Starting (was in progress: ${wasInProgress})...`);
  
  notifySyncStatus({ status: 'force_syncing', entity: 'Starting...', progress: 0 });
  
  try {
    const selectedDateStr = format(new Date(), 'yyyy-MM-dd');

    // Step 1: Sync cities
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 5 });
    const cities = await City.list();
    await offlineDB.bulkSave(offlineDB.STORES.CITIES, cities);
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 10, count: cities.length });

    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 2: Sync deliveries
    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 15 });
    const deliveries = await Delivery.filter({ delivery_date: selectedDateStr });
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 30, count: deliveries.length });

    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 3: Sync AppUsers
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 25 });
    const appUsers = await AppUser.list();
    await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 35, count: appUsers.length });

    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 4: Sync all patients
    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 40 });
    const patients = await Patient.filter({ status: 'active' }, '-created_date', 5000);
    const cleanPatients = patients.filter(p => p && p.id && !p.id.startsWith('temp_'));

    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 60, count: cleanPatients.length });
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, cleanPatients);

    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // DISABLED: Square Transactions now sync via real-time events only

    // Update sync timestamps - MARK ALL as full sync
    await Promise.all([
      offlineDB.updateSyncStatus('City', { 
        recordCount: cities.length, 
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      }),
      offlineDB.updateSyncStatus('AppUser', { 
        recordCount: appUsers.length, 
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      }),
      offlineDB.updateSyncStatus('Delivery', { 
        recordCount: deliveries.length, 
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      }),
      offlineDB.updateSyncStatus('Patient', { 
        recordCount: cleanPatients.length, 
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      }),

    ]);

    notifySyncStatus({ status: 'syncing', entity: 'Finalizing', progress: 90 });
    
    // Sync historical deliveries in background
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
    console.log(`🗑️ [OfflineSync] Deleted ${entityName} ${recordId} from offline DB`);
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