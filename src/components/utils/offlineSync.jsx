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
      if (checkResult.skipped) {
        await offlineDB.updateSyncMetadata(entityName, checkResult.lastClientTimestamp, new Date().toISOString());
      }
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

    // Dispatch event for indicator to show last sync time updated
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('periodicSyncProgress', {
        detail: { entity: entityName, count: records.length, isComplete: true }
      }));
    }
    
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

  // Dispatch event for indicator
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('periodicSyncProgress', {
      detail: { entity: 'Patient', count: totalRecords, isComplete: true }
    }));
  }

  return { success: true, recordCount: totalRecords };
};

// ==================== PRIORITY DATA LOADING ====================

/**
 * CRITICAL: Priority sync that runs before every smart refresh cycle
 * Order: 1) ALL AppUsers (entire entity) 2) Active date deliveries (by city) 3) Associated patients
 * @param {string} selectedDateStr - The active/current date (YYYY-MM-DD)
 * @param {string} cityId - Optional city ID to filter by (for city-specific sync)
 * @param {object} smartRefreshMgr - SmartRefreshManager instance for rate limiting
 */
export const performPrioritySyncBeforeRefresh = async (selectedDateStr, cityId = null, smartRefreshMgr = null) => {
  if (syncPaused) return { skipped: true };
  
  try {
    notifySyncStatus({ status: 'priority_sync', phase: 'appusers' });
    
    // CRITICAL: Wait for rate limit before fetching
    if (smartRefreshMgr) {
      await smartRefreshMgr.waitForRateLimit();
    }

    // STEP 1: Fetch and sync ENTIRE AppUser entity (all drivers)
    console.log('👤 [PrioritySyncBeforeRefresh] STEP 1: Fetching AppUsers...');
    const allAppUsers = await AppUser.list();
    console.log(`👤 [PrioritySyncBeforeRefresh] Fetched ${allAppUsers?.length || 0} AppUsers:`, allAppUsers?.map(u => ({ id: u.id, user_id: u.user_id, user_name: u.user_name })));

    if (allAppUsers && allAppUsers.length > 0) {
      // CRITICAL: Deduplicate by user_id (keep most recent by sort_order)
      const appUsersByUserId = new Map();
      allAppUsers.forEach(au => {
        if (!au || !au.user_id) return;
        const existing = appUsersByUserId.get(au.user_id);
        if (!existing || (au.sort_order || Infinity) < (existing.sort_order || Infinity)) {
          appUsersByUserId.set(au.user_id, au);
        }
      });
      const deduplicatedAppUsers = Array.from(appUsersByUserId.values());
      const duplicatesRemoved = allAppUsers.length - deduplicatedAppUsers.length;
      if (duplicatesRemoved > 0) {
        console.warn(`⚠️ [PrioritySyncBeforeRefresh] Removed ${duplicatesRemoved} duplicate AppUsers`);
      }

      const saveResult = await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, deduplicatedAppUsers);
      console.log(`✅ [PrioritySyncBeforeRefresh] Saved ${deduplicatedAppUsers.length} AppUsers to offline DB:`, saveResult);
      await offlineDB.updateSyncMetadata('AppUser', new Date().toISOString(), new Date().toISOString());
      if (smartRefreshMgr) smartRefreshMgr.recordSuccess();
    } else {
      console.warn('⚠️ [PrioritySyncBeforeRefresh] No AppUsers returned from API');
    }
    
    await new Promise(r => setTimeout(r, 500));
    notifySyncStatus({ status: 'priority_sync', phase: 'deliveries' });
    
    // CRITICAL: Wait for rate limit before next fetch
    if (smartRefreshMgr) {
      await smartRefreshMgr.waitForRateLimit();
    }
    
    // STEP 2: Fetch and sync Deliveries for active date (filtered by city if provided)
    const deliveryFilter = { delivery_date: selectedDateStr };
    if (cityId) {
      // If city is provided, we'd need to filter by stores in that city
      // For now, fetch all - smartRefreshManager will handle city filtering
    }
    const deliveries = await Delivery.filter(deliveryFilter);
    if (deliveries && deliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
      await offlineDB.updateSyncMetadata('Delivery', new Date().toISOString(), new Date().toISOString());
      if (smartRefreshMgr) smartRefreshMgr.recordSuccess();
    }
    
    await new Promise(r => setTimeout(r, 500));
    notifySyncStatus({ status: 'priority_sync', phase: 'patients' });
    
    // STEP 3: Extract unique patient IDs from these deliveries and sync them immediately
    const patientIds = new Set(
      (deliveries || [])
        .filter(d => d && d.patient_id)
        .map(d => d.patient_id)
    );
    
    let patients = [];
    if (patientIds.size > 0) {
      const patientIdList = Array.from(patientIds);
      const PATIENT_BATCH_SIZE = 50;
      
      for (let i = 0; i < patientIdList.length; i += PATIENT_BATCH_SIZE) {
        // CRITICAL: Wait for rate limit before each patient batch
        if (smartRefreshMgr) {
          await smartRefreshMgr.waitForRateLimit();
        }
        
        const batchIds = patientIdList.slice(i, i + PATIENT_BATCH_SIZE);
        const batchPatients = await Patient.filter({ id: { $in: batchIds } });
        
        if (batchPatients && batchPatients.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
          patients = [...patients, ...batchPatients];
          if (smartRefreshMgr) smartRefreshMgr.recordSuccess();
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }
    
    // Clean patients
    patients = patients.filter(p => p && p.id && !p.id.startsWith('temp_'));
    await offlineDB.updateSyncMetadata('Patient', new Date().toISOString(), new Date().toISOString());

    // Dispatch event for indicator
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('offlineSyncProgress', {
        detail: { entity: 'Patient', count: patients.length }
      }));
    }
    
    notifySyncStatus({ status: 'priority_sync_complete', appUsers: allAppUsers?.length || 0, deliveries: deliveries?.length || 0, patients: patients.length });
    
    return { success: true, appUsers: allAppUsers?.length || 0, deliveries: deliveries?.length || 0, patients: patients.length };
  } catch (error) {
    if (smartRefreshMgr) smartRefreshMgr.recordError();
    notifySyncStatus({ status: 'priority_sync_error', error: error.message });
    return { error: error.message };
  }
};

/**
 * CRITICAL: Pre-render sync - force fresh AppUsers and Cities BEFORE map renders
 * Always fetches from API (ignores offline DB age) to ensure correct driver locations
 * @param {object} smartRefreshMgr - SmartRefreshManager instance for rate limiting
 */
export const preRenderFreshSync = async (smartRefreshMgr = null) => {
  try {
    console.log('🔄 [PreRenderSync] FORCING fresh AppUsers and Cities from API before map render...');
    
    // Wait for rate limit
    if (smartRefreshMgr) {
      await smartRefreshMgr.waitForRateLimit();
    }
    
    // CRITICAL: DELETE all offline AppUser data FIRST to ensure no stale data
    console.log('🗑️ [PreRenderSync] Clearing ALL offline AppUser data...');
    await offlineDB.clearStore(offlineDB.STORES.APP_USERS);
    console.log('✅ [PreRenderSync] Offline AppUser data cleared');
    
    // CRITICAL: FORCE fresh fetch of AppUsers (ignore offline DB age)
    console.log('📍 [PreRenderSync] Fetching fresh AppUsers from API...');
    const appUsers = await AppUser.list();
    console.log(`📍 [PreRenderSync] Fetched ${appUsers?.length || 0} AppUsers from API:`, appUsers?.map(u => ({ id: u.id, user_id: u.user_id, user_name: u.user_name, location_updated_at: u.location_updated_at })));

    if (appUsers && appUsers.length > 0) {
      // CRITICAL: Deduplicate by user_id (keep most recent by sort_order)
      const appUsersByUserId = new Map();
      appUsers.forEach(au => {
        if (!au || !au.user_id) return;
        const existing = appUsersByUserId.get(au.user_id);
        if (!existing || (au.sort_order || Infinity) < (existing.sort_order || Infinity)) {
          appUsersByUserId.set(au.user_id, au);
        }
      });
      const deduplicatedAppUsers = Array.from(appUsersByUserId.values());
      const duplicatesRemoved = appUsers.length - deduplicatedAppUsers.length;
      if (duplicatesRemoved > 0) {
        console.warn(`⚠️ [PreRenderSync] Removed ${duplicatesRemoved} duplicate AppUsers`);
      }

      // CRITICAL: Save ENTIRE fresh AppUser entity to offline DB in one operation
      console.log(`💾 [PreRenderSync] Saving ${deduplicatedAppUsers.length} fresh AppUsers to offline DB...`);
      const appUserSaveResult = await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, deduplicatedAppUsers);
      console.log(`✅ [PreRenderSync] Saved result:`, appUserSaveResult);
      
      // Verify save
      const verifyAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      console.log(`✅ [PreRenderSync] Verified: offline DB now has ${verifyAppUsers?.length || 0} AppUsers`);
      
      await offlineDB.updateSyncMetadata('AppUser', new Date().toISOString(), new Date().toISOString());
      console.log(`✅ [PreRenderSync] Synced ${deduplicatedAppUsers.length} fresh AppUsers to offline DB`);
      if (smartRefreshMgr) smartRefreshMgr.recordSuccess();
    } else {
      console.warn('⚠️ [PreRenderSync] No AppUsers returned from API');
    }
    
    // Wait for rate limit
    if (smartRefreshMgr) {
      await smartRefreshMgr.waitForRateLimit();
    }
    
    // CRITICAL: FORCE fresh fetch of Cities (ignore offline DB age)
    console.log('🏙️ [PreRenderSync] Fetching fresh Cities...');
    const cities = await City.list();
    if (cities && cities.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.CITIES, cities);
      await offlineDB.updateSyncMetadata('City', new Date().toISOString(), new Date().toISOString());
      console.log(`✅ [PreRenderSync] Synced ${cities.length} fresh Cities to offline DB`);
      if (smartRefreshMgr) smartRefreshMgr.recordSuccess();
    }
    
    // Load fresh data from offline DB for initial render
    const freshAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    const freshCities = await offlineDB.getAll(offlineDB.STORES.CITIES);
    
    console.log(`✅ [PreRenderSync] Ready for render: ${freshAppUsers?.length || 0} users, ${freshCities?.length || 0} cities`);
    return { success: true, appUsers: freshAppUsers, cities: freshCities };
  } catch (error) {
    console.error('❌ [PreRenderSync] Error:', error.message);
    if (smartRefreshMgr) smartRefreshMgr.recordError();
    // Return empty but valid data so render can continue
    return { success: false, appUsers: [], cities: [], error: error.message };
  }
};

/**
 * Load priority data for initial display
 * Order: Cities → AppUsers → Deliveries (selected date) → ALL Patients (critical for map markers)
 * CRITICAL: Validates offline DB is populated; forces full sync if underpopulated
 */
export const loadPriorityData = async (selectedDateStr, filters = {}) => {
  if (syncPaused) return { skipped: true };
  if (syncInProgress) return { skipped: true, reason: 'sync_in_progress' };
  
  syncInProgress = true;
  notifySyncStatus({ status: 'loading_priority', date: selectedDateStr });
  
  try {
    // CRITICAL: Validate offline DB is actually populated
    // If any core entity is missing/empty, force a full fresh sync
    const [existingAppUsers, existingPatients, existingDeliveries, existingCities] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.APP_USERS),
      offlineDB.getAll(offlineDB.STORES.PATIENTS),
      offlineDB.getAll(offlineDB.STORES.DELIVERIES),
      offlineDB.getAll(offlineDB.STORES.CITIES)
    ]);

    const isUnderPopulated = 
      !existingAppUsers || existingAppUsers.length === 0 ||
      !existingCities || existingCities.length === 0;

    console.log(`📊 [LoadPriorityData] DB Status: Users=${existingAppUsers?.length || 0}, Cities=${existingCities?.length || 0}, Patients=${existingPatients?.length || 0}, Deliveries=${existingDeliveries?.length || 0}, ForceSync=${isUnderPopulated}`);

    // CRITICAL: If DB is underpopulated, restart the sync cycle instead of clearing metadata
    // This ensures data is restored without losing what's already there
    if (isUnderPopulated) {
      console.warn('⚠️ [LoadPriorityData] Offline DB underpopulated, initiating comprehensive restore...');
      // Use restartDeliveryPatientSync to restore data properly
      const restoreResult = await restartDeliveryPatientSync();
      if (restoreResult.error) {
        console.error('Failed to restore data:', restoreResult.error);
      } else {
        console.log('✅ Data restoration initiated');
        return restoreResult;
      }
    }
    
    // Step 1: AppUsers with timestamp check (or fresh if underpopulated)
    const appUserResult = await syncEntityWithTimestampCheck('AppUser', AppUser, {}, {});
    const appUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 2: Cities with timestamp check (force if underpopulated)
    const cityResult = await syncEntityWithTimestampCheck('City', City, {}, {});
    const cities = await offlineDB.getAll(offlineDB.STORES.CITIES);
    
    // CRITICAL: If cities are empty after sync attempt, force full list
    if (!cities || cities.length === 0) {
      console.warn('⚠️ [LoadPriorityData] Cities empty after sync, forcing full fetch...');
      const citiesFromAPI = await City.list();
      if (citiesFromAPI && citiesFromAPI.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.CITIES, citiesFromAPI);
      }
      const updatedCities = await offlineDB.getAll(offlineDB.STORES.CITIES);
    }
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 3: Stores with timestamp check (force if empty)
    const storeResult = await syncEntityWithTimestampCheck('Store', Store, {}, {});
    let stores = await offlineDB.getAll(offlineDB.STORES.STORES);
    
    if (!stores || stores.length === 0) {
      console.warn('⚠️ [LoadPriorityData] Stores empty after sync, forcing full fetch...');
      const storesFromAPI = await Store.list();
      if (storesFromAPI && storesFromAPI.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.STORES, storesFromAPI);
        stores = storesFromAPI;
      }
    }
    
    await new Promise(r => setTimeout(r, 3000));
    
    // Step 4: Patients with timestamp check (or sync related to selected date deliveries)
    let patients = [];
    try {
      const patientResult = await syncEntityWithTimestampCheck('Patient', Patient, { status: 'active' }, { status: 'active' });
      patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      patients = patients.filter(p => p && p.id && !p.id.startsWith('temp_'));
    } catch (patientError) {
      console.warn('⚠️ [LoadPriorityData] Patient sync failed:', patientError.message);
    }
    
    await new Promise(r => setTimeout(r, 3000));
    
    // Step 5: Deliveries for selected date
    const deliveryFilter = { delivery_date: selectedDateStr, ...filters };
    const deliveries = await Delivery.filter(deliveryFilter);
    
    if (deliveries && deliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
      
      // CRITICAL: Sync patients referenced in these deliveries
      const patientIds = new Set(
        deliveries
          .filter(d => d && d.patient_id)
          .map(d => d.patient_id)
      );
      
      if (patientIds.size > 0) {
        const patientIdList = Array.from(patientIds);
        const BATCH_SIZE = 50;
        
        for (let i = 0; i < patientIdList.length; i += BATCH_SIZE) {
          const batchIds = patientIdList.slice(i, i + BATCH_SIZE);
          const batchPatients = await Patient.filter({ id: { $in: batchIds } });
          if (batchPatients && batchPatients.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
            patients = [...patients, ...batchPatients];
          }
          await new Promise(r => setTimeout(r, 200));
        }
      }
    }
    
    // CRITICAL: Verify data was actually saved before marking as synced
    const [finalAppUsers, finalCities, finalStores, finalPatients, finalDeliveries] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.APP_USERS),
      offlineDB.getAll(offlineDB.STORES.CITIES),
      offlineDB.getAll(offlineDB.STORES.STORES),
      offlineDB.getAll(offlineDB.STORES.PATIENTS),
      offlineDB.getAll(offlineDB.STORES.DELIVERIES)
    ]);
    
    console.log(`✅ [LoadPriorityData] Final DB counts: Users=${finalAppUsers?.length || 0}, Cities=${finalCities?.length || 0}, Stores=${finalStores?.length || 0}, Patients=${finalPatients?.length || 0}, Deliveries=${finalDeliveries?.length || 0}`);
    
    await Promise.all([
      offlineDB.updateSyncStatus('City', { recordCount: finalCities?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Store', { recordCount: finalStores?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('AppUser', { recordCount: finalAppUsers?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Delivery', { recordCount: finalDeliveries?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Patient', { recordCount: finalPatients?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() })
    ]);

    notifySyncStatus({ status: 'priority_loaded', cities: finalCities?.length, stores: finalStores?.length, appUsers: finalAppUsers?.length, deliveries: finalDeliveries?.length, patients: finalPatients?.length });

    syncInProgress = false;
    return { 
      cities: finalCities || cities, 
      stores: finalStores || stores, 
      appUsers: finalAppUsers || appUsers, 
      deliveries: finalDeliveries || deliveries, 
      patients: finalPatients?.filter(p => p && p.id && !p.id.startsWith('temp_')) || patients 
    };
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

    // Fetch deliveries first
    const deliveries = await Delivery.filter(deliveryFilter, '-updated_date', 5000);
    if (deliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);

      // CRITICAL: Extract unique patient IDs from these deliveries and sync them immediately
      // This ensures all patients referenced in current deliveries are up-to-date across all devices
      const patientIds = new Set(
        deliveries
          .filter(d => d && d.patient_id)
          .map(d => d.patient_id)
      );

      if (patientIds.size > 0) {
        const patientIdList = Array.from(patientIds);
        const PATIENT_BATCH_SIZE = 50;

        for (let i = 0; i < patientIdList.length; i += PATIENT_BATCH_SIZE) {
          const batchIds = patientIdList.slice(i, i + PATIENT_BATCH_SIZE);
          const batchPatients = await Patient.filter({ id: { $in: batchIds } });

          if (batchPatients && batchPatients.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
          }

          await new Promise(r => setTimeout(r, 500));
        }
      }
    }

    // Update delivery metadata
    await offlineDB.updateSyncMetadata('Delivery', null, new Date().toISOString());

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
      // CRITICAL: If record was deleted (404), remove mutation from queue (silent)
      if (error.response?.status === 404 || error.message?.includes('404') || error.message?.includes('not found')) {
        console.log(`⏭️ [OfflineSync] Removing mutation for deleted record: ${mutation.recordId} (${mutation.entity})`);
        await offlineDB.removePendingMutation(mutation.mutationId);
        successCount++;
        continue;
      }
      
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

    // CRITICAL: Sync ALL active patients for complete historical data (not just recent)
    // Payroll page needs patient data for any date in the year
    notifySyncStatus({ status: 'syncing', entity: 'Patients (all active)', progress: 25 });
    console.log('🔄 [ForceSyncAll] Syncing ALL active patients...');

    let allPatients = [];
    let patientOffset = 0;
    const PATIENT_FETCH_SIZE = 100;

    while (true) {
      try {
        const patientBatch = await Patient.filter(
          { status: 'active' },
          '-updated_date',
          PATIENT_FETCH_SIZE,
          patientOffset
        );

        if (!patientBatch || patientBatch.length === 0) break;

        allPatients = allPatients.concat(patientBatch);
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patientBatch);

        const batchNumber = Math.floor(patientOffset / PATIENT_FETCH_SIZE) + 1;
        const batchProgress = 25 + Math.min(10, Math.floor((allPatients.length / 4000) * 10));
        notifySyncStatus({ 
          status: 'syncing', 
          entity: `Patients (${allPatients.length}+)`, 
          progress: batchProgress, 
          loaded: allPatients.length 
        });
        console.log(`   ✅ Batch ${batchNumber} synced (${allPatients.length} total patients)`);

        if (patientBatch.length < PATIENT_FETCH_SIZE) break;

        patientOffset += PATIENT_FETCH_SIZE;
        await new Promise(r => setTimeout(r, 200));
      } catch (error) {
        console.warn(`   ⚠️ Patient batch failed:`, error.message);
        break;
      }
    }

    const cleanPatients = allPatients.filter(p => p && p.id && !p.id.startsWith('temp_'));
    console.log(`✅ [ForceSyncAll] Synced ${cleanPatients.length} total active patients`);
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
    // Background sync will handle remaining patients incrementally
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
 * Patients: Only sync patients from last week's deliveries (deduplicated)
 * Other entities: Complete full sync
 * Background sync handles remaining patients incrementally
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
    
    // Step 1: Get deliveries from last 7 days and extract unique patient IDs
    notifySyncStatus({ status: 'syncing', entity: 'Patients (gathering IDs)', progress: 50 });
    console.log('🔄 [OfflineSync] Step 1: Gathering unique patient IDs from last 7 days...');
    
    const weekAgoDateStr = format(subDays(new Date(), 7), 'yyyy-MM-dd');
    
    // Fetch deliveries in batches to avoid timeout
    let allDeliveriesLastWeek = [];
    let deliveryOffset = 0;
    const DELIVERY_BATCH_SIZE = 500;
    
    try {
      while (true) {
        const batchDeliveries = await Delivery.filter({ 
          delivery_date: { $gte: weekAgoDateStr } 
        }, '-delivery_date', DELIVERY_BATCH_SIZE, deliveryOffset);
        
        if (!batchDeliveries || batchDeliveries.length === 0) break;
        
        allDeliveriesLastWeek = allDeliveriesLastWeek.concat(batchDeliveries);
        deliveryOffset += DELIVERY_BATCH_SIZE;
        
        console.log(`   Fetched ${batchDeliveries.length} deliveries (total: ${allDeliveriesLastWeek.length})`);
        
        // Stop if we got fewer records than batch size
        if (batchDeliveries.length < DELIVERY_BATCH_SIZE) break;
        
        await new Promise(r => setTimeout(r, 300));
      }
    } catch (deliveryError) {
      console.warn('⚠️ [OfflineSync] Error fetching last week deliveries:', deliveryError.message);
    }
    
    // Extract ONLY unique patient IDs from last 7 days
    const uniquePatientIdsFromLastWeek = new Set(
      allDeliveriesLastWeek
        .filter(d => d && d.patient_id)
        .map(d => d.patient_id)
    );
    
    const uniquePatientIdsList = Array.from(uniquePatientIdsFromLastWeek);
    console.log(`📍 [OfflineSync] Found ${uniquePatientIdsList.length} unique patients in ${allDeliveriesLastWeek.length} deliveries from last 7 days`);
    
    // Step 2: Sync ONLY those unique patient IDs in batches
    // CRITICAL: Sync ALL active patients, not just recent ones
    // This ensures payroll page has complete patient data for any historical date
    notifySyncStatus({ status: 'syncing', entity: 'Patients (all active)', progress: 55 });
    console.log(`🔄 [OfflineSync] Step 2: Syncing ALL active patients for complete historical data...`);

    let allPatients = [];
    const PATIENT_PAGE_SIZE = 100;
    let patientOffset = 0;

    while (true) {
      try {
        const patientBatch = await Patient.filter(
          { status: 'active' },
          '-updated_date',
          PATIENT_PAGE_SIZE,
          patientOffset
        );

        if (!patientBatch || patientBatch.length === 0) break;

        allPatients = allPatients.concat(patientBatch);
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patientBatch);

        const batchNumber = Math.floor(patientOffset / PATIENT_PAGE_SIZE) + 1;
        const batchProgress = 55 + Math.min(20, Math.floor((allPatients.length / 4000) * 20));
        notifySyncStatus({ 
          status: 'syncing', 
          entity: `Patients (${allPatients.length}+)`, 
          progress: batchProgress, 
          loaded: allPatients.length 
        });
        console.log(`   ✅ Batch ${batchNumber} synced (${allPatients.length} total patients)`);

        // Stop if we got fewer than page size (end of data)
        if (patientBatch.length < PATIENT_PAGE_SIZE) break;

        patientOffset += PATIENT_PAGE_SIZE;
        await new Promise(r => setTimeout(r, 200));
      } catch (error) {
        console.warn(`   ⚠️ Patient sync batch failed:`, error.message);
        if (patientOffset === 0) {
          // If first batch fails, use referenced patients as fallback
          console.warn('   Using patients referenced in deliveries as fallback...');
          break;
        }
      }
    }

    const cleanPatients = allPatients.filter(p => p && p.id && !p.id.startsWith('temp_'));
    console.log(`✅ [OfflineSync] Synced ${cleanPatients.length} total active patients`);
    
    await new Promise(r => setTimeout(r, 1000));
    
    // Full sync for OTHER entities (Cities, Stores, AppUsers)
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 80 });
    const cities = await City.list();
    await offlineDB.bulkSave(offlineDB.STORES.CITIES, cities);
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    notifySyncStatus({ status: 'syncing', entity: 'Stores', progress: 85 });
    const stores = await Store.list();
    await offlineDB.bulkSave(offlineDB.STORES.STORES, stores);
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 90 });
    console.log('👤 [ForceSyncAll] Fetching AppUsers...');
    const appUsers = await AppUser.list();
    console.log(`👤 [ForceSyncAll] Fetched ${appUsers?.length || 0} AppUsers, saving to offline DB...`);
    const appUserSaveResult = await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
    console.log(`✅ [ForceSyncAll] AppUsers save result:`, appUserSaveResult);

    // Verify the save
    const verifyAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    console.log(`✅ [ForceSyncAll] Verified offline DB now has ${verifyAppUsers?.length || 0} AppUsers`);
    
    // Update sync status for all entities
    const deliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    
    await Promise.all([
      offlineDB.updateSyncStatus('City', { recordCount: cities.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Store', { recordCount: stores.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('AppUser', { recordCount: appUsers.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Delivery', { recordCount: deliveries.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Patient', { recordCount: cleanPatients.length, status: 'synced', lastSync: new Date().toISOString() })
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

/**
 * Initialize offline DB with fresh data before Dashboard renders
 * Call this in Dashboard useEffect BEFORE any render of map/markers
 */
export const initializeOfflineDBBeforeRender = async (smartRefreshMgr = null) => {
  try {
    // Pre-render sync: force fresh AppUsers and Cities
    const preRenderResult = await preRenderFreshSync(smartRefreshMgr);
    
    if (!preRenderResult.success) {
      console.warn('⚠️ [InitOfflineDB] Pre-render sync had issues, continuing...');
    }
    
    // Return fresh data for initial render
    return preRenderResult;
  } catch (error) {
    console.error('❌ [InitOfflineDB] Error:', error);
    return { success: false, appUsers: [], cities: [], error: error.message };
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