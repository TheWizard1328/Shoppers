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
import { Company } from '@/entities/Company';
import { format, subDays } from 'date-fns';
import { 
  fetchAppUsersDedup, 
  fetchDeliveriesDedup, 
  fetchPatientsDedup, 
  fetchCitiesDedup, 
  fetchStoresDedup,
  invalidateEntityCache
} from './dataSyncCoordinator';
import { getOfflineStoreName } from './offlineEntityRegistry';
import { getLocalDateString } from './localTimeHelper';

import {
  getSyncInProgress,
  setSyncInProgress,
  getSyncPaused,
  getLastBackgroundSyncAt,
  setLastBackgroundSyncAt
} from './offlineSyncState';
import {
  pauseOfflineSync,
  resumeOfflineSync,
  isOfflineSyncPaused,
  subscribeSyncStatus,
  notifySyncStatus
} from './offlineSyncStatus';
import { processPendingMutationsInternal } from './offlineSyncMutationProcessor';
import { createOfflineSyncHistoricalHelpers } from './offlineSyncHistorical';
import { createOfflineSyncPriorityHelpers } from './offlineSyncPriority';

export {
  pauseOfflineSync,
  resumeOfflineSync,
  isOfflineSyncPaused,
  subscribeSyncStatus,
  notifySyncStatus
};

// Configuration
const PATIENT_BATCH_SIZE = 25; // Even smaller chunks to reduce rate limits
const PATIENT_SYNC_COOLDOWN = 30000; // 30 second cooldown between patient batches
const BATCH_COOLDOWN = 10000;
const DELIVERY_DATE_RANGE_DAYS = 90;
const PATIENT_SYNC_INTERVAL_HOURS = 168; // Only sync patients once per 7 days in background
const BACKGROUND_SYNC_MIN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes between background sync runs
const HISTORICAL_SYNC_COOLDOWN_MS = 1500;
const HISTORICAL_PATIENT_STORE_BATCH_SIZE = 100;


// ==================== TIMESTAMP-BASED SYNC HELPERS ====================

/**
 * Check if entity needs syncing by comparing server's latest timestamp with client's last sync
 * CRITICAL: Skip API call if offline DB shows recent sync (within 30 minutes) to prevent rate limits
 * @returns {Promise<{needsSync: boolean, lastClientTimestamp: string|null}>}
 */
const getSyncMetaTimestamp = () => new Date().toISOString();

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
        await offlineDB.updateSyncMetadata(entityName, checkResult.lastClientTimestamp, getSyncMetaTimestamp());
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
      const storeName = getOfflineStoreName(offlineDB, entityName);
      
      if (storeName) {
        await offlineDB.bulkSave(storeName, records);
      }
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
  await offlineDB.updateSyncMetadata('Patient', latestServerTimestamp, getSyncMetaTimestamp());

  // Dispatch event for indicator
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('periodicSyncProgress', {
      detail: { entity: 'Patient', count: totalRecords, isComplete: true }
    }));
  }

  return { success: true, recordCount: totalRecords };
};

const syncPatientsByIds = async (patientIds = [], batchSize = 50) => {
  const uniquePatientIds = Array.from(new Set((patientIds || []).filter(Boolean)));
  let totalPatients = 0;
  let freshPatients = [];

  for (let i = 0; i < uniquePatientIds.length; i += batchSize) {
    const batchIds = uniquePatientIds.slice(i, i + batchSize);
    const batchPatients = await Patient.filter({ id: { $in: batchIds } });

    if (batchPatients && batchPatients.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
      invalidateEntityCache('Patient');
      totalPatients += batchPatients.length;
      freshPatients = [...freshPatients, ...batchPatients];
    }

    await new Promise(r => setTimeout(r, 200));
  }

  await offlineDB.updateSyncMetadata('Patient', new Date().toISOString(), new Date().toISOString());
  return { totalPatients, freshPatients };
};

const getHistoricalSyncMeta = async () => {
  const metadata = await offlineDB.getSyncMetadata('Historical_Mobile_Sync');
  return metadata || {};
};

const updateHistoricalSyncMeta = async (updates = {}) => {
  const current = await getHistoricalSyncMeta();
  await offlineDB.updateSyncMetadata('Historical_Mobile_Sync', null, new Date().toISOString(), {
    ...current,
    ...updates
  });
};

const {
  shouldRunMobileHistoricalSync,
  getHistoricalDeliveryIndex,
  getHistoricalPatientStoreIndex,
  syncHistoricalPatientsByStore,
  getNextDeliveryDateToSync
} = createOfflineSyncHistoricalHelpers({
  HISTORICAL_PATIENT_STORE_BATCH_SIZE,
  HISTORICAL_SYNC_COOLDOWN_MS,
  DELIVERY_DATE_RANGE_DAYS,
  updateHistoricalSyncMeta,
  getHistoricalSyncMeta
});

const {
  preRenderFreshSync,
  performPrioritySyncBeforeRefresh: runPrioritySyncBeforeRefresh,
  loadPriorityData: runLoadPriorityData
} = createOfflineSyncPriorityHelpers({
  AppUser,
  City,
  Store,
  Company,
  Delivery,
  Patient,
  format,
  BATCH_COOLDOWN,
  syncEntityWithTimestampCheck,
  restartDeliveryPatientSync,
  invalidateEntityCache,
  fetchAppUsersDedup,
  fetchDeliveriesDedup,
  fetchPatientsDedup,
  fetchCitiesDedup,
  notifySyncStatus
});

// ==================== PRIORITY DATA LOADING ====================

/**
 * CRITICAL: Priority sync that runs before every smart refresh cycle
 * Order: 1) ALL AppUsers (entire entity) 2) Active date deliveries (by city) 3) Associated patients
 * @param {string} selectedDateStr - The active/current date (YYYY-MM-DD)
 * @param {string} cityId - Optional city ID to filter by (for city-specific sync)
 * @param {object} smartRefreshMgr - SmartRefreshManager instance for rate limiting
 * @param {boolean} fetchAllDriversDeliveries - If true, fetches ALL drivers' deliveries (Show All/All Drivers mode)
 */
export const performPrioritySyncBeforeRefresh = async (selectedDateStr, cityId = null, smartRefreshMgr = null, fetchAllDriversDeliveries = false) => {
  if (getSyncPaused()) return { skipped: true };
  return runPrioritySyncBeforeRefresh(selectedDateStr, cityId, smartRefreshMgr, fetchAllDriversDeliveries);
  
  try {
    const allStores = await offlineDB.getAll(offlineDB.STORES.STORES);
    const cityStoreIds = cityId ? (allStores || []).filter((store) => store?.city_id === cityId).map((store) => store.id) : [];

    notifySyncStatus({ status: 'priority_sync', phase: 'appusers' });
    
    // CRITICAL: Wait for rate limit before fetching
    if (smartRefreshMgr) {
      await smartRefreshMgr.waitForRateLimit();
    }

    // STEP 1: Fetch and sync ENTIRE AppUser entity (all drivers) - SKIP if synced recently
    const timeSinceLastAppUserSync = Date.now() - (smartRefreshMgr?._lastAppUserSyncTime || 0);
    const shouldSkipAppUserSync = timeSinceLastAppUserSync < 10000; // Skip if synced within last 10 seconds
    let allAppUsers = [];

    if (shouldSkipAppUserSync) {
      console.log('⏭️ [PrioritySyncBeforeRefresh] STEP 1: Skipping AppUser sync (synced recently)');
      allAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    } else {
      console.log('👤 [PrioritySyncBeforeRefresh] STEP 1: Fetching ALL AppUsers (deduplicated)...');
      allAppUsers = await fetchAppUsersDedup();
      console.log(`👤 [PrioritySyncBeforeRefresh] Fetched ${allAppUsers?.length || 0} AppUsers (Mode: ${fetchAllDriversDeliveries ? 'ALL DRIVERS' : 'Individual'})`);

      if (allAppUsers && allAppUsers.length > 0) {
        // CRITICAL: Deduplicate by user_id (keep most recent by location_updated_at, then updated_date)
        const appUsersByUserId = new Map();
        allAppUsers.forEach(au => {
          if (!au || !au.user_id) return;
          const existing = appUsersByUserId.get(au.user_id);

          if (!existing) {
            appUsersByUserId.set(au.user_id, au);
          } else {
            const newLocationTime = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
            const existingLocationTime = existing.location_updated_at ? new Date(existing.location_updated_at).getTime() : 0;
            const newUpdatedTime = au.updated_date ? new Date(au.updated_date).getTime() : 0;
            const existingUpdatedTime = existing.updated_date ? new Date(existing.updated_date).getTime() : 0;

            if (newLocationTime > existingLocationTime) {
              appUsersByUserId.set(au.user_id, au);
            } else if (newLocationTime === existingLocationTime && newUpdatedTime > existingUpdatedTime) {
              appUsersByUserId.set(au.user_id, au);
            }
          }
        });
        const deduplicatedAppUsers = Array.from(appUsersByUserId.values());
        const duplicatesRemoved = allAppUsers.length - deduplicatedAppUsers.length;
        if (duplicatesRemoved > 0) {
          console.warn(`⚠️ [PrioritySyncBeforeRefresh] Removed ${duplicatesRemoved} duplicate AppUsers`);
        }

        const saveResult = await offlineDB.replaceAllRecords(offlineDB.STORES.APP_USERS, deduplicatedAppUsers);
        console.log(`✅ [PrioritySyncBeforeRefresh] Saved ${deduplicatedAppUsers.length} AppUsers to offline DB:`, saveResult);
        invalidateEntityCache('AppUser');
        await offlineDB.updateSyncMetadata('AppUser', new Date().toISOString(), new Date().toISOString());
        if (smartRefreshMgr) {
          smartRefreshMgr.recordSuccess();
          smartRefreshMgr._lastAppUserSyncTime = Date.now();
        }
      } else {
        console.warn('⚠️ [PrioritySyncBeforeRefresh] No AppUsers returned from API');
      }
    }
    
    await new Promise(r => setTimeout(r, 2500));
    notifySyncStatus({ status: 'priority_sync', phase: 'deliveries' });
    
    // CRITICAL: Wait for rate limit before next fetch
    if (smartRefreshMgr) {
      await smartRefreshMgr.waitForRateLimit();
    }
    
    // STEP 2: Fetch and sync Deliveries for active date with deduplication
    // CRITICAL: If in Show All or All Drivers mode, fetch ALL drivers' deliveries for the date
    const deliveryFilter = cityStoreIds.length > 0 ? { store_id: { $in: cityStoreIds } } : {};
    console.log(`📦 [PrioritySyncBeforeRefresh] STEP 2: Fetching ALL drivers' deliveries for selected date${cityStoreIds.length > 0 ? ' and city' : ''} (deduplicated)`);
    
    const deliveries = await fetchDeliveriesDedup(selectedDateStr, deliveryFilter);
    if (deliveries && deliveries.length > 0) {
        await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr, deliveries);
        invalidateEntityCache('Delivery');
        await offlineDB.updateSyncMetadata('Delivery', new Date().toISOString(), new Date().toISOString());
        if (smartRefreshMgr) smartRefreshMgr.recordSuccess();
      }
    
    await new Promise(r => setTimeout(r, 3000));
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
        const batchPatients = await fetchPatientsDedup({ id: { $in: batchIds } });
        
        if (batchPatients && batchPatients.length > 0) {
              await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
              invalidateEntityCache('Patient');
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
 * Load priority data for initial display
 * Order: Cities → AppUsers → Deliveries (selected date) → ALL Patients (critical for map markers)
 * CRITICAL: Validates offline DB is populated; forces full sync if underpopulated
 */
export const loadPriorityData = async (selectedDateStr, filters = {}) => {
  if (getSyncPaused()) return { skipped: true };
  return runLoadPriorityData(selectedDateStr, filters, {
    getSyncInProgress,
    setSyncInProgress
  });
  
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
    invalidateEntityCache('AppUser');
    const appUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 2: Cities with timestamp check (force if underpopulated)
    const cityResult = await syncEntityWithTimestampCheck('City', City, {}, {});
    invalidateEntityCache('City');
    const cities = await offlineDB.getAll(offlineDB.STORES.CITIES);

    // CRITICAL: If cities are empty after sync attempt, force full list
    if (!cities || cities.length === 0) {
      console.warn('⚠️ [LoadPriorityData] Cities empty after sync, forcing full fetch...');
      const citiesFromAPI = await City.list();
      if (citiesFromAPI && citiesFromAPI.length > 0) {
        await offlineDB.replaceAllRecords(offlineDB.STORES.CITIES, citiesFromAPI);
        invalidateEntityCache('City');
      }
      const updatedCities = await offlineDB.getAll(offlineDB.STORES.CITIES);
    }
    
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 3: Stores with timestamp check (force if empty)
    const storeResult = await syncEntityWithTimestampCheck('Store', Store, {}, {});
    invalidateEntityCache('Store');
    let stores = await offlineDB.getAll(offlineDB.STORES.STORES);

    if (!stores || stores.length === 0) {
      console.warn('⚠️ [LoadPriorityData] Stores empty after sync, forcing full fetch...');
      const storesFromAPI = await Store.list();
      if (storesFromAPI && storesFromAPI.length > 0) {
        await offlineDB.replaceAllRecords(offlineDB.STORES.STORES, storesFromAPI);
        invalidateEntityCache('Store');
        stores = storesFromAPI;
      }
    }

    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Step 4: Companies with timestamp check
    const companyResult = await syncEntityWithTimestampCheck('Company', Company, {}, {});
    invalidateEntityCache('Company');
    let companies = await offlineDB.getAll(offlineDB.STORES.COMPANIES);

    if (!companies || companies.length === 0) {
      const companiesFromAPI = await Company.list();
      if (companiesFromAPI && companiesFromAPI.length > 0) {
        await offlineDB.replaceAllRecords(offlineDB.STORES.COMPANIES, companiesFromAPI);
        invalidateEntityCache('Company');
        companies = companiesFromAPI;
      }
    }
    
    await new Promise(r => setTimeout(r, 3000));
    
    // Step 5: Deliveries for selected date
    let patients = [];
    const cityStoreIds = filters?.city_id ? (stores || []).filter((store) => store?.city_id === filters.city_id).map((store) => store.id) : [];
    const deliveryFilter = { delivery_date: selectedDateStr, ...(cityStoreIds.length > 0 ? { store_id: { $in: cityStoreIds } } : {}), ...Object.fromEntries(Object.entries(filters || {}).filter(([key]) => key !== 'city_id')) };
    const deliveries = await Delivery.filter(deliveryFilter);
    
    if (deliveries && deliveries.length > 0) {
        await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr, deliveries);
        invalidateEntityCache('Delivery');

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
            invalidateEntityCache('Patient');
            patients = [...patients, ...batchPatients];
          }
          await new Promise(r => setTimeout(r, 200));
        }
      }

      if (cityStoreIds.length > 0) {
        const cityPatients = await Patient.filter({ store_id: { $in: cityStoreIds } }, '-updated_date', 5000);
        if (cityPatients && cityPatients.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, cityPatients);
          invalidateEntityCache('Patient');
          const patientMap = new Map([...patients, ...cityPatients].filter(Boolean).map((patient) => [patient.id, patient]));
          patients = Array.from(patientMap.values());
        }
      }

      await offlineDB.updateSyncStatus('Patient', { recordCount: patients.length, status: 'synced', lastSync: new Date().toISOString() });
    }
    
    // CRITICAL: Verify data was actually saved before marking as synced
    const [finalAppUsers, finalCities, finalStores, finalCompanies, finalPatients, finalDeliveries] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.APP_USERS),
      offlineDB.getAll(offlineDB.STORES.CITIES),
      offlineDB.getAll(offlineDB.STORES.STORES),
      offlineDB.getAll(offlineDB.STORES.COMPANIES),
      offlineDB.getAll(offlineDB.STORES.PATIENTS),
      offlineDB.getAll(offlineDB.STORES.DELIVERIES)
    ]);
    
    console.log(`✅ [LoadPriorityData] Final DB counts: Users=${finalAppUsers?.length || 0}, Cities=${finalCities?.length || 0}, Stores=${finalStores?.length || 0}, Companies=${finalCompanies?.length || 0}, Patients=${finalPatients?.length || 0}, Deliveries=${finalDeliveries?.length || 0}`);
    
    await Promise.all([
      offlineDB.updateSyncStatus('City', { recordCount: finalCities?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Store', { recordCount: finalStores?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Company', { recordCount: finalCompanies?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('AppUser', { recordCount: finalAppUsers?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Delivery', { recordCount: finalDeliveries?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Patient', { recordCount: finalPatients?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() })
    ]);

    notifySyncStatus({ status: 'priority_loaded', cities: finalCities?.length, stores: finalStores?.length, companies: finalCompanies?.length, appUsers: finalAppUsers?.length, deliveries: finalDeliveries?.length, patients: finalPatients?.length });

    setSyncInProgress(false);
    return { 
      cities: finalCities || cities, 
      stores: finalStores || stores,
      companies: finalCompanies || [], 
      appUsers: finalAppUsers || appUsers, 
      deliveries: finalDeliveries || deliveries, 
      patients: finalPatients?.filter(p => p && p.id && !p.id.startsWith('temp_')) || patients 
    };
  } catch (error) {
    notifySyncStatus({ status: 'error', error: error.message });
    setSyncInProgress(false);
    return { error: error.message };
  }
};

// ==================== BACKGROUND SYNC ====================

/**
 * Background sync with timestamp-based incremental strategy for deliveries
 * Syncs one delivery date at a time over past 90 days
 */
export const performBackgroundSync = async (selectedDateStr, storeIds = null) => {
  if (getSyncInProgress() || getSyncPaused()) {
    return { skipped: true };
  }

  const now = Date.now();
  if ((now - getLastBackgroundSyncAt()) < BACKGROUND_SYNC_MIN_INTERVAL_MS) {
    return { skipped: true, reason: 'background_cooldown' };
  }

  if (!(await shouldRunMobileHistoricalSync())) {
    return { skipped: true, reason: 'not_idle_or_not_due' };
  }

  if (!selectedDateStr) {
    return { skipped: true, reason: 'missing_selected_date' };
  }
  
  setSyncInProgress(true);
  setLastBackgroundSyncAt(now);
  notifySyncStatus({ status: 'background_syncing' });
  
  try {
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    const selectedDateFilter = { delivery_date: selectedDateStr, ...(storeIds && storeIds.length > 0 ? { store_id: { $in: storeIds } } : {}) };
    const selectedDateDeliveries = await Delivery.filter(selectedDateFilter, '-updated_date', 5000);
    if (selectedDateDeliveries && selectedDateDeliveries.length > 0) {
      await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr, selectedDateDeliveries);
      invalidateEntityCache('Delivery');

      const selectedDatePatientIds = Array.from(new Set(selectedDateDeliveries.filter((delivery) => delivery?.patient_id).map((delivery) => delivery.patient_id)));
      if (selectedDatePatientIds.length > 0) {
        await syncPatientsByIds(selectedDatePatientIds);
      }
    }

    const historicalMeta = await getHistoricalSyncMeta();
    const deliveryPhaseComplete = Number(historicalMeta?.delivery_cycle_index || 1) === 1 && historicalMeta?.delivery_last_synced_date === format(subDays(new Date(), DELIVERY_DATE_RANGE_DAYS), 'yyyy-MM-dd');

    if (!deliveryPhaseComplete) {
      const deliveryDateToSync = await getNextDeliveryDateToSync();
      if (!deliveryDateToSync || deliveryDateToSync === selectedDateStr || deliveryDateToSync === getLocalDateString()) {
        notifySyncStatus({ status: 'complete', skippedHistorical: true });
        window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
        return { success: true, skippedHistorical: true };
      }

      const deliveryFilter = { delivery_date: deliveryDateToSync };
      if (storeIds && storeIds.length > 0) {
        deliveryFilter.store_id = { $in: storeIds };
      }

      const deliveries = await Delivery.filter(deliveryFilter, '-updated_date', 500);
      if (deliveries.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
        invalidateEntityCache('Delivery');
      }

      await offlineDB.updateSyncMetadata('Delivery', null, new Date().toISOString());
      const nextMeta = await getHistoricalSyncMeta();
      const completedDeliveries = nextMeta?.delivery_cycle_index > DELIVERY_DATE_RANGE_DAYS;
      if (completedDeliveries) {
        await updateHistoricalSyncMeta({ patient_phase_complete: false, patient_store_index: 0 });
      }

      notifySyncStatus({ status: 'complete', phase: 'deliveries', date: deliveryDateToSync });
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
      return { success: true, phase: 'deliveries', date: deliveryDateToSync };
    }

    const patientSyncResult = await syncHistoricalPatientsByStore(storeIds);
    if (patientSyncResult?.completed) {
      await updateHistoricalSyncMeta({
        last_completed_at: new Date().toISOString(),
        delivery_cycle_index: 1,
        patient_phase_complete: false,
        patient_store_index: 0
      });
    }

    notifySyncStatus({ status: 'complete', phase: 'patients' });
    window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
    return { success: true, phase: 'patients', ...patientSyncResult };
  } catch (error) {
    notifySyncStatus({ status: 'error', error: error.message });
    return { error: error.message };
  } finally {
    setSyncInProgress(false);
  }
};




// ==================== ON-DEMAND DATA LOADING ====================

/**
 * Load and cache deliveries for a specific date (when user navigates to historical date)
 * This adds to the offline DB for faster access later
 */
export const loadAndCacheDeliveriesForDate = async (dateStr) => {
  if (getSyncPaused()) return [];
  
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

// ==================== QUICK RECONCILIATION ====================

/**
 * Quick check: compares server vs offline DB by timestamp for Deliveries (selected date) and AppUsers.
 * If server has newer data, syncs offline DB and fires UI update events.
 * Lightweight - only 1 API call per entity to check the latest updated_date.
 *
 * @param {string} selectedDateStr - Active date (YYYY-MM-DD)
 * @returns {Promise<{deliveriesUpdated, freshDeliveries, appUsersUpdated, freshAppUsers}>}
 */
export const quickReconcile = async (selectedDateStr) => {
  const result = { deliveriesUpdated: false, appUsersUpdated: false };

  // --- Deliveries ---
  try {
    const offlineDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
    const offlineLatest = (offlineDeliveries || []).reduce((max, d) => {
      const t = d.updated_date ? new Date(d.updated_date).getTime() : 0;
      return t > max ? t : max;
    }, 0);

    const [serverSample] = await Delivery.filter({ delivery_date: selectedDateStr }, '-updated_date', 1);
    if (serverSample) {
      const serverLatest = new Date(serverSample.updated_date || 0).getTime();
      if (serverLatest > offlineLatest) {
        console.log(`🔄 [QuickReconcile] Deliveries for ${selectedDateStr}: newer server data. Syncing...`);
        const freshDeliveries = await Delivery.filter({ delivery_date: selectedDateStr }, '-updated_date', 5000);
        if (freshDeliveries && freshDeliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
          invalidateEntityCache('Delivery');
          await offlineDB.updateSyncMetadata('Delivery', serverSample.updated_date, new Date().toISOString());
          result.deliveriesUpdated = true;
          result.freshDeliveries = freshDeliveries;
          console.log(`✅ [QuickReconcile] Synced ${freshDeliveries.length} deliveries`);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('offlineDBReconciled', {
              detail: { entity: 'Delivery', date: selectedDateStr, count: freshDeliveries.length }
            }));
          }
        }
      } else {
        console.log(`✅ [QuickReconcile] Deliveries up-to-date for ${selectedDateStr}`);
      }
    }
  } catch (e) {
    console.warn('⚠️ [QuickReconcile] Delivery check failed:', e.message);
  }

  // --- AppUsers ---
  try {
    const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
    const offlineLatest = (offlineAppUsers || []).reduce((max, u) => {
      const t = u.updated_date ? new Date(u.updated_date).getTime() : 0;
      return t > max ? t : max;
    }, 0);

    const [serverSampleUser] = await AppUser.filter({}, '-updated_date', 1);
    if (serverSampleUser) {
      const serverLatest = new Date(serverSampleUser.updated_date || 0).getTime();
      const isEmpty = !offlineAppUsers || offlineAppUsers.length === 0;
      if (serverLatest > offlineLatest || isEmpty) {
        console.log(`🔄 [QuickReconcile] AppUsers: server has newer data or offline empty. Syncing...`);
        const freshAppUsers = await fetchAppUsersDedup();
        if (freshAppUsers && freshAppUsers.length > 0) {
          const userMap = new Map();
          freshAppUsers.forEach(au => {
            if (!au?.user_id) return;
            const ex = userMap.get(au.user_id);
            if (!ex) { userMap.set(au.user_id, au); return; }
            const newLoc = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
            const exLoc = ex.location_updated_at ? new Date(ex.location_updated_at).getTime() : 0;
            if (newLoc > exLoc) userMap.set(au.user_id, au);
          });
          const deduped = Array.from(userMap.values());
          await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, deduped);
          invalidateEntityCache('AppUser');
          await offlineDB.updateSyncMetadata('AppUser', new Date().toISOString(), new Date().toISOString());
          result.appUsersUpdated = true;
          result.freshAppUsers = deduped;
          console.log(`✅ [QuickReconcile] Synced ${deduped.length} AppUsers`);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('offlineDBReconciled', {
              detail: { entity: 'AppUser', count: deduped.length }
            }));
            // CRITICAL: Only dispatch valid AppUsers (filter out junk offline records)
            const validDeduped = deduped.filter(u => u?.user_id && u.user_id !== 'undefined' && u?.user_name && u.user_name !== 'undefined');
            if (validDeduped.length > 0) {
              window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                detail: { appUsers: validDeduped }
              }));
            }
          }
        }
      } else {
        console.log(`✅ [QuickReconcile] AppUsers up-to-date (${offlineAppUsers?.length || 0})`);
      }
    }
  } catch (e) {
    console.warn('⚠️ [QuickReconcile] AppUser check failed:', e.message);
  }

  return result;
};

// ==================== INITIAL SYNC (ENTRY POINT) ====================

/**
 * Main entry point for initial sync
 * CRITICAL: For new users, always sync ALL patients to populate offline DB
 */
export const performInitialSync = async (selectedDate = null, cityId = null) => {
  if (getSyncInProgress() || getSyncPaused()) {
    return { skipped: true };
  }
  
  const selectedDateStr = selectedDate 
    ? format(selectedDate, 'yyyy-MM-dd') 
    : format(new Date(), 'yyyy-MM-dd');
  
  const priorityResult = await loadPriorityData(selectedDateStr, { city_id: cityId, status: { $in: ['pending', 'in_transit', 'en_route', 'completed', 'failed', 'cancelled'] } });
  
  if (priorityResult.error) {
    return priorityResult;
  }
  
  setTimeout(() => {
    performBackgroundSync(selectedDateStr).catch(() => {});
  }, 10000);
  
  return priorityResult;
};

// ==================== LEGACY EXPORTS (COMPATIBILITY) ====================

export const processPendingMutations = async () => processPendingMutationsInternal();

export const forceSyncAll = async () => {
  if (getSyncPaused()) return { skipped: true };
  
  setSyncInProgress(true);
  notifySyncStatus({ status: 'force_syncing', entity: 'Starting...', progress: 0 });
  
  try {
    const selectedDateStr = getLocalDateString();

    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 5 });
    const appUsersRaw = await fetchAppUsersDedup();
    const appUsersByUserId = new Map();
    appUsersRaw.forEach(au => {
      if (!au || !au.user_id) return;
      const existing = appUsersByUserId.get(au.user_id);

      if (!existing) {
        appUsersByUserId.set(au.user_id, au);
      } else {
        const newLocationTime = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
        const existingLocationTime = existing.location_updated_at ? new Date(existing.location_updated_at).getTime() : 0;
        const newUpdatedTime = au.updated_date ? new Date(au.updated_date).getTime() : 0;
        const existingUpdatedTime = existing.updated_date ? new Date(existing.updated_date).getTime() : 0;

        if (newLocationTime > existingLocationTime) {
          appUsersByUserId.set(au.user_id, au);
        } else if (newLocationTime === existingLocationTime && newUpdatedTime > existingUpdatedTime) {
          appUsersByUserId.set(au.user_id, au);
        }
      }
    });
    const appUsers = Array.from(appUsersByUserId.values());
    await offlineDB.replaceAllRecords(offlineDB.STORES.APP_USERS, appUsers);
    invalidateEntityCache('AppUser');
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 10, count: appUsers.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 15 });
    const cities = await City.list();
    await offlineDB.replaceAllRecords(offlineDB.STORES.CITIES, cities);
    invalidateEntityCache('City');
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 20, count: cities.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    notifySyncStatus({ status: 'syncing', entity: 'Stores', progress: 22 });
    const stores = await Store.list();
    await offlineDB.replaceAllRecords(offlineDB.STORES.STORES, stores);
    invalidateEntityCache('Store');
    notifySyncStatus({ status: 'syncing', entity: 'Stores', progress: 24, count: stores.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    notifySyncStatus({ status: 'syncing', entity: 'Companies', progress: 25 });
    const companies = await Company.list();
    await offlineDB.replaceAllRecords(offlineDB.STORES.COMPANIES, companies);
    invalidateEntityCache('Company');
    notifySyncStatus({ status: 'syncing', entity: 'Companies', progress: 27, count: companies.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Sync only patients needed for today's deliveries to avoid rate limits on driver/manual sync
    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 25 });
    console.log('🔄 [ForceSyncAll] Syncing patients referenced by today\'s deliveries...');

    const todaysDeliveries = await Delivery.filter({ delivery_date: selectedDateStr }, '-updated_date', 5000);
    const patientIds = Array.from(new Set((todaysDeliveries || []).filter(d => d && d.patient_id).map(d => d.patient_id)));
    const { totalPatients, freshPatients } = await syncPatientsByIds(patientIds);

    const cleanPatients = (freshPatients || []).filter(p => p && p.id && !p.id.startsWith('temp_'));
    console.log(`✅ [ForceSyncAll] Synced ${cleanPatients.length} referenced patients`);
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
      offlineDB.updateSyncStatus('Company', { recordCount: companies.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
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
    setSyncInProgress(false);
  }
};

export const manualSyncSelected = async (selectedDateStr, selectedCityId = null) => {
  if (getSyncInProgress() || getSyncPaused()) return { skipped: true };
  setSyncInProgress(true);
  notifySyncStatus({ status: 'force_syncing', entity: 'Starting...', progress: 0 });
  try {
    // 1) AppUsers (entire entity)
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 10 });
    const appUsersRaw = await fetchAppUsersDedup();
    const appUsersByUserId = new Map();
    appUsersRaw.forEach(au => {
      if (!au || !au.user_id) return;
      const existing = appUsersByUserId.get(au.user_id);
      if (!existing) {
        appUsersByUserId.set(au.user_id, au);
      } else {
        const newLoc = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
        const exLoc = existing.location_updated_at ? new Date(existing.location_updated_at).getTime() : 0;
        const newUpd = au.updated_date ? new Date(au.updated_date).getTime() : 0;
        const exUpd = existing.updated_date ? new Date(existing.updated_date).getTime() : 0;
        if (newLoc > exLoc || (newLoc === exLoc && newUpd > exUpd)) {
          appUsersByUserId.set(au.user_id, au);
        }
      }
    });
    const appUsers = Array.from(appUsersByUserId.values());
    await offlineDB.replaceAllRecords(offlineDB.STORES.APP_USERS, appUsers);
    invalidateEntityCache('AppUser');
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 20, count: appUsers.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // 2) Cities (entire entity)
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 30 });
    const cities = await City.list();
    await offlineDB.replaceAllRecords(offlineDB.STORES.CITIES, cities);
    invalidateEntityCache('City');
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 35, count: cities.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Prepare store filter for selected city
    let storeIds = null;
    if (selectedCityId) {
      const storesInCity = await Store.filter({ city_id: selectedCityId });
      if (storesInCity && storesInCity.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.STORES, storesInCity);
        invalidateEntityCache('Store');
        storeIds = storesInCity.map(s => s.id);
      }
    }

    // 3) Deliveries (selected date, all drivers, filtered by selected city stores)
    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 45 });
    const deliveryFilter = { delivery_date: selectedDateStr };
    if (storeIds && storeIds.length > 0) {
      deliveryFilter.store_id = { $in: storeIds };
    }
    const deliveries = await Delivery.filter(deliveryFilter, '-updated_date', 5000);
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    invalidateEntityCache('Delivery');
    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 60, count: deliveries.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // 4) Patients for the synced deliveries
    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 70 });
    const patientIds = Array.from(new Set((deliveries || []).filter(d => d && d.patient_id).map(d => d.patient_id)));
    const { totalPatients } = await syncPatientsByIds(patientIds);
    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 85, count: totalPatients });

    // Finalize
    notifySyncStatus({ status: 'complete', progress: 100 });
    return { success: true, appUsers: appUsers.length, cities: cities.length, deliveries: deliveries.length, patients: totalPatients };
  } catch (error) {
    notifySyncStatus({ status: 'error', error: error.message });
    return { error: error.message };
  } finally {
    setSyncInProgress(false);
  }
};

export const performBidirectionalSync = forceSyncAll;

export const handleDeleteBroadcast = async (entityName, recordId) => {
  if (!entityName || !recordId) return;
  
  try {
    const storeName = getOfflineStoreName(offlineDB, entityName) || (entityName === 'SquareTransaction' ? offlineDB.STORES.SQUARE_TRANSACTIONS : null);
    if (!storeName) return false;
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
  if (getSyncInProgress()) return { skipped: true };
  
  setSyncInProgress(true);
  notifySyncStatus({ status: 'restart_syncing' });
  
  try {
    const selectedDateStr = getLocalDateString();
    
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
        invalidateEntityCache('Patient');

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
    await offlineDB.replaceAllRecords(offlineDB.STORES.CITIES, cities);
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    notifySyncStatus({ status: 'syncing', entity: 'Stores', progress: 85 });
    const stores = await Store.list();
    await offlineDB.replaceAllRecords(offlineDB.STORES.STORES, stores);
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 90 });
    console.log('👤 [ForceSyncAll] Fetching AppUsers...');
    const appUsersRaw2 = await fetchAppUsersDedup();
    const appUsersByUserId2 = new Map();
    appUsersRaw2.forEach(au => {
      if (!au || !au.user_id) return;
      const existing = appUsersByUserId2.get(au.user_id);

      if (!existing) {
        appUsersByUserId2.set(au.user_id, au);
      } else {
        const newLocationTime = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
        const existingLocationTime = existing.location_updated_at ? new Date(existing.location_updated_at).getTime() : 0;
        const newUpdatedTime = au.updated_date ? new Date(au.updated_date).getTime() : 0;
        const existingUpdatedTime = existing.updated_date ? new Date(existing.updated_date).getTime() : 0;

        if (newLocationTime > existingLocationTime) {
          appUsersByUserId2.set(au.user_id, au);
        } else if (newLocationTime === existingLocationTime && newUpdatedTime > existingUpdatedTime) {
          appUsersByUserId2.set(au.user_id, au);
        }
      }
    });
    const appUsers = Array.from(appUsersByUserId2.values());
    console.log(`👤 [ForceSyncAll] Fetched ${appUsers?.length || 0} AppUsers, saving to offline DB...`);
    const appUserSaveResult = await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
    invalidateEntityCache('AppUser');
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
    setSyncInProgress(false);
  }
};

/**
 * Initialize offline DB with fresh data before Dashboard renders
 * Call this in Dashboard useEffect BEFORE any render of map/markers
 * @param {object} smartRefreshMgr - SmartRefreshManager instance for rate limiting
 * @param {object} currentUser - Current authenticated user (for location upload)
 */
export const initializeOfflineDBBeforeRender = async (smartRefreshMgr = null, currentUser = null) => {
  try {
    // Pre-render sync: force fresh AppUsers and Cities
    const preRenderResult = await preRenderFreshSync(smartRefreshMgr, currentUser);
    
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

if (typeof window !== 'undefined' && !window.__rxdeliverReconnectSyncRegistered) {
  window.__rxdeliverReconnectSyncRegistered = true;

  const triggerOfflineBackgroundSync = () => {
    setTimeout(() => {
      processPendingMutations().catch(() => {});
      performBackgroundSync(getLocalDateString()).catch(() => {});
    }, 1500);
  };

  window.addEventListener('online', triggerOfflineBackgroundSync);
  window.addEventListener('offlineSyncResumed', triggerOfflineBackgroundSync);
}

export const getSyncStats = async () => {
  const stats = await offlineDB.getStats();
  const pendingMutations = await offlineDB.getPendingMutations();
  const patientStatus = await offlineDB.getSyncStatus('Patient');
  const deliveryStatus = await offlineDB.getSyncStatus('Delivery');
  const cityStatus = await offlineDB.getSyncStatus('City');
  const storeStatus = await offlineDB.getSyncStatus('Store');
  const companyStatus = await offlineDB.getSyncStatus('Company');
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
      companies: {
        completed: !!companyStatus?.lastFullSync,
        lastFullSync: companyStatus?.lastFullSync,
        lastSync: companyStatus?.lastSync
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