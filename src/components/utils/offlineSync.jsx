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
const DELIVERY_BATCH_DAYS = 7; // Fetch 7 days at a time for historical
const PATIENT_BATCH_SIZE = 250; // 250 patients at a time
const BATCH_COOLDOWN = 1000; // 1 second between batches
const HISTORICAL_DAYS = 30; // Keep 30 days of historical data for broader offline access

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
 * Get all fresh offline data if available
 */
export const getOfflineDataIfFresh = async () => {
  const [deliveryFresh, patientFresh, appUserFresh, cityFresh, squareTxFresh] = await Promise.all([
    isOfflineDataFresh('Delivery'),
    isOfflineDataFresh('Patient'),
    isOfflineDataFresh('AppUser'),
    isOfflineDataFresh('City'),
    isOfflineDataFresh('SquareTransaction')
  ]);
  
  if (!deliveryFresh && !patientFresh && !appUserFresh && !cityFresh && !squareTxFresh) {
    return null; // Not fresh, need to fetch from online
  }
  
  const [deliveries, patients, appUsers, cities, squareTransactions] = await Promise.all([
    deliveryFresh ? offlineDB.getAll(offlineDB.STORES.DELIVERIES) : [],
    patientFresh ? offlineDB.getAll(offlineDB.STORES.PATIENTS) : [],
    appUserFresh ? offlineDB.getAll(offlineDB.STORES.APP_USERS) : [],
    cityFresh ? offlineDB.getAll(offlineDB.STORES.CITIES) : [],
    squareTxFresh ? offlineDB.getAll(offlineDB.STORES.SQUARE_TRANSACTIONS) : []
  ]);
  
  return {
    deliveries: deliveryFresh ? deliveries : null,
    patients: patientFresh ? patients : null,
    appUsers: appUserFresh ? appUsers : null,
    cities: cityFresh ? cities : null,
    squareTransactions: squareTxFresh ? squareTransactions : null,
    deliveryFresh,
    patientFresh,
    appUserFresh,
    cityFresh,
    squareTxFresh
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
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    // Step 3: Deliveries for selected date
    const deliveryFilter = { delivery_date: selectedDateStr, ...filters };
    const deliveries = await Delivery.filter(deliveryFilter);
    console.log(`   ✅ Loaded ${deliveries.length} deliveries for ${selectedDateStr}`);
    
    // Save to offline DB immediately (merge, don't clear)
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
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
      }),
      offlineDB.updateSyncStatus('SquareTransaction', {
        recordCount: 0,
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
 * Background sync: Today + 6 future days, then past 14 days (7 days at a time)
 * NEVER clears DB - only merges new data
 */
export const performBackgroundSync = async (selectedDateStr) => {
  if (syncInProgress || syncPaused) {
    console.log(`⏸️ [OfflineSync] Background sync skipped - ${syncInProgress ? 'in progress' : 'paused'}`);
    return { skipped: true };
  }
  
  syncInProgress = true;
  console.log('📥 [OfflineSync] Starting background sync...');
  notifySyncStatus({ status: 'background_syncing' });
  
  const today = new Date();
  const todayStr = format(today, 'yyyy-MM-dd');
  
  try {
    // ===== STEP 1: Sync today + 6 future days =====
    console.log('   📅 Syncing today + 6 future days...');
    
    for (let i = 0; i <= 6; i++) {
      if (syncPaused) break;
      
      const fetchDate = new Date(today);
      fetchDate.setDate(today.getDate() + i);
      const fetchDateStr = format(fetchDate, 'yyyy-MM-dd');
      
      // Skip if already loaded as selected date
      if (fetchDateStr === selectedDateStr) continue;
      
      try {
        const dateDeliveries = await Delivery.filter({ delivery_date: fetchDateStr });
        if (dateDeliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, dateDeliveries);
          console.log(`      ✅ ${fetchDateStr}: ${dateDeliveries.length} deliveries`);
        }
        
        await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
      } catch (error) {
        console.warn(`      ⚠️ ${fetchDateStr} failed:`, error.message);
        if (error.response?.status === 429) {
          await new Promise(r => setTimeout(r, 5000)); // Extra cooldown on rate limit
        }
      }
    }
    
    // ===== STEP 2: Sync past 30 days (7 days at a time with 1s cooldown) =====
    console.log('   📅 Syncing past 30 days...');
    
    const chunks = [
      { start: 1, end: 7 },
      { start: 8, end: 14 },
      { start: 15, end: 21 },
      { start: 22, end: 30 }
    ];
    
    for (const chunk of chunks) {
      if (syncPaused) break;
      
      await syncDeliveryDateRange(
        format(subDays(today, chunk.end), 'yyyy-MM-dd'),
        format(subDays(today, chunk.start), 'yyyy-MM-dd'),
        selectedDateStr
      );
      
      await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    }
    
    // ===== STEP 3: Sync Cities in background =====
    if (!syncPaused) {
      console.log('   🏙️ Syncing Cities...');
      try {
        const allCities = await City.list();
        await offlineDB.bulkSave(offlineDB.STORES.CITIES, allCities);
        console.log(`   ✅ Cached ${allCities.length} Cities`);
      } catch (cityError) {
        console.warn(`   ⚠️ City sync failed:`, cityError.message);
      }
    }

    // ===== STEP 4: Sync AppUsers in background =====
    if (!syncPaused) {
      console.log('   👤 Syncing AppUsers...');
      try {
        const allAppUsers = await AppUser.list();
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, allAppUsers);
        console.log(`   ✅ Cached ${allAppUsers.length} AppUsers`);
      } catch (appUserError) {
        console.warn(`   ⚠️ AppUser sync failed:`, appUserError.message);
      }
    }

    // ===== STEP 5: Sync Square Transactions in background (gentle batches) =====
    if (!syncPaused) {
      console.log('   💳 Syncing Square Transactions (batched)...');
      await syncSquareTransactionsGently();
    }

    // ===== STEP 6: Sync remaining patients (250 at a time) =====
    if (!syncPaused) {
      console.log('   👥 Syncing patients...');
      await syncAllPatients();
    }
    
    // Update final sync status
    const stats = await offlineDB.getStats();
    await Promise.all([
      offlineDB.updateSyncStatus('City', {
        recordCount: stats?.cities?.count || 0,
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      }),
      offlineDB.updateSyncStatus('AppUser', {
        recordCount: stats?.appUsers?.count || 0,
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      }),
      offlineDB.updateSyncStatus('SquareTransaction', {
        recordCount: stats?.squareTransactions?.count || 0,
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      }),
      offlineDB.updateSyncStatus('Delivery', {
        recordCount: stats?.deliveries?.count || 0,
        status: 'synced',
        lastSync: new Date().toISOString(),
        lastFullSync: new Date().toISOString()
      })
    ]);
    
    console.log('✅ [OfflineSync] Background sync complete');
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

/**
 * Sync deliveries for a date range (used for historical batches)
 */
const syncDeliveryDateRange = async (startDate, endDate, skipDate = null) => {
  if (syncPaused) return;
  
  console.log(`      📅 Fetching ${startDate} to ${endDate}...`);
  
  try {
    const deliveries = await Delivery.filter({
      delivery_date: { $gte: startDate, $lte: endDate }
    });
    
    // Filter out the skip date if provided
    const filteredDeliveries = skipDate 
      ? deliveries.filter(d => d.delivery_date !== skipDate)
      : deliveries;
    
    if (filteredDeliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, filteredDeliveries);
      console.log(`      ✅ Saved ${filteredDeliveries.length} deliveries`);
    }
  } catch (error) {
    console.warn(`      ⚠️ Date range sync failed:`, error.message);
    if (error.response?.status === 429) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }
};

/**
 * Sync Square Transactions gently in batches of 50 with cooldowns
 * CRITICAL: Prevents rate limits by fetching smaller batches
 */
const syncSquareTransactionsGently = async () => {
  if (syncPaused) return;
  
  console.log('   💳 [OfflineSync] Starting gentle Square Transaction sync...');
  
  try {
    const BATCH_SIZE = 50;
    let allTransactions = [];
    let offset = 0;
    let hasMore = true;
    
    while (hasMore && !syncPaused) {
      const batch = await SquareTransaction.list('-updated_date', BATCH_SIZE);
      
      if (batch.length === 0) {
        hasMore = false;
        break;
      }
      
      allTransactions.push(...batch);
      console.log(`      💳 Fetched ${batch.length} transactions (total: ${allTransactions.length})`);
      
      if (batch.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        offset += BATCH_SIZE;
        await new Promise(r => setTimeout(r, 2000)); // 2s cooldown between batches
      }
      
      // Save batch to offline DB immediately
      if (batch.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.SQUARE_TRANSACTIONS, batch);
      }
    }
    
    console.log(`   ✅ [OfflineSync] Square Transaction sync complete: ${allTransactions.length} total`);
    
    await offlineDB.updateSyncStatus('SquareTransaction', {
      recordCount: allTransactions.length,
      status: 'synced',
      lastSync: new Date().toISOString(),
      lastFullSync: new Date().toISOString()
    });
  } catch (error) {
    console.error('   ❌ [OfflineSync] Square Transaction sync failed:', error.message);
  }
};

/**
 * Sync all patients in batches of 250
 * CRITICAL: Uses filter() instead of list() to ensure proper pagination
 */
const syncAllPatients = async () => {
  if (syncPaused) return;
  
  console.log('   👥 [OfflineSync] Starting patient sync...');
  
  try {
    // First, get total count to track progress
    const allPatients = await Patient.filter({ status: 'active' }, '-created_date', 5000);
    console.log(`   👥 [OfflineSync] Found ${allPatients.length} active patients to sync`);
    
    if (allPatients.length === 0) {
      // Try without status filter as fallback
      console.log('   👥 [OfflineSync] No active patients found, trying without status filter...');
      const allPatientsNoFilter = await Patient.list('-created_date', 5000);
      console.log(`   👥 [OfflineSync] Found ${allPatientsNoFilter.length} patients (no filter)`);
      
      if (allPatientsNoFilter.length > 0) {
        const cleanBatch = allPatientsNoFilter.filter(p => p && p.id && !p.id.startsWith('temp_'));
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, cleanBatch);
        
        await offlineDB.updateSyncStatus('Patient', {
          recordCount: cleanBatch.length,
          status: 'synced',
          lastSync: new Date().toISOString(),
          lastFullSync: new Date().toISOString()
        });
        
        console.log(`   ✅ [OfflineSync] Patient sync complete: ${cleanBatch.length} total`);
      }
      return;
    }
    
    // Filter out temp IDs and save
    const cleanBatch = allPatients.filter(p => p && p.id && !p.id.startsWith('temp_'));
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, cleanBatch);
    
    await offlineDB.updateSyncStatus('Patient', {
      recordCount: cleanBatch.length,
      status: 'synced',
      lastSync: new Date().toISOString(),
      lastFullSync: new Date().toISOString()
    });
    
    console.log(`   ✅ [OfflineSync] Patient sync complete: ${cleanBatch.length} total`);
  } catch (error) {
    console.error('   ❌ [OfflineSync] Patient sync failed:', error.message, error);
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
  if (freshData && freshData.deliveryFresh && freshData.patientFresh && freshData.appUserFresh && freshData.cityFresh && freshData.squareTxFresh && hasPatientData) {
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
      cities: freshData.cities?.length || 0,
      squareTransactions: freshData.squareTransactions?.length || 0
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
  
  let successCount = 0;
  let failCount = 0;
  
  for (const mutation of mutations) {
    if (syncPaused) break;
    
    try {
      if (mutation.recordId?.startsWith('temp_')) {
        await offlineDB.removePendingMutation(mutation.mutationId);
        continue;
      }
      
      const Entity = mutation.entity === 'Patient' ? Patient : Delivery;
      
      if (mutation.operation === 'create') {
        await Entity.create(mutation.payload);
      } else if (mutation.operation === 'update') {
        await Entity.update(mutation.recordId, mutation.payload);
      } else if (mutation.operation === 'delete') {
        await Entity.delete(mutation.recordId);
      }
      
      await offlineDB.removePendingMutation(mutation.mutationId);
      successCount++;
      await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    } catch (error) {
      await offlineDB.updateMutationRetry(mutation.mutationId, (mutation.retryCount || 0) + 1);
      failCount++;
      
      if (error.response?.status === 429) {
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }
  
  return { success: failCount === 0, processed: successCount, failed: failCount };
};

export const forceSyncAll = async () => {
  if (syncInProgress || syncPaused) return { skipped: true };
  
  syncInProgress = true;
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

    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 70, count: cleanPatients.length });
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, cleanPatients);

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
      })
    ]);

    notifySyncStatus({ status: 'syncing', entity: 'Finalizing', progress: 90 });
    
    // Sync historical deliveries and Square Transactions in background
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