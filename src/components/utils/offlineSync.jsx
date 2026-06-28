/**
 * Offline Sync Manager v3 - Timestamp-Based Sync with Date-Range Delivery Syncing
 * 
 * STRATEGY:
 * 1. Timestamp-based: Only fetch entities if updated_date > last_synced_timestamp
 * 2. Cities/Stores sync only when server has changes (saves rate limits)
 * 3. Deliveries: Check one date at a time over past 90 days for changes before syncing
 * 4. NEVER clear the entire DB - only merge/update records
 */

import { format, subDays } from 'date-fns';
import { offlineSyncDeps } from '@/components/services/offlineSyncDeps';
import { offlineSyncConfig } from '@/components/services/offlineSyncConfig';
import { createOfflineSyncEntityService } from '@/components/services/offlineSyncEntityService';
import { createOfflineSyncPatientService } from '@/components/services/offlineSyncPatientService';
import { createOfflineSyncBackgroundService } from '@/components/services/offlineSyncBackgroundService';
import { createOfflineSyncReconcileService } from '@/components/services/offlineSyncReconcileService';
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
const {
  PATIENT_BATCH_SIZE,
  PATIENT_SYNC_COOLDOWN,
  BATCH_COOLDOWN,
  DELIVERY_DATE_RANGE_DAYS,
  PATIENT_SYNC_INTERVAL_HOURS,
  BACKGROUND_SYNC_MIN_INTERVAL_MS,
  HISTORICAL_SYNC_COOLDOWN_MS,
  HISTORICAL_PATIENT_STORE_BATCH_SIZE
} = offlineSyncConfig;

const {
  offlineDB,
  Patient,
  Delivery,
  AppUser,
  City,
  Store,
  Company,
  InterStoreLocation,
  RxTempLogs,
  fetchAppUsersDedup,
  fetchDeliveriesDedup,
  fetchPatientsDedup,
  fetchCitiesDedup,
  fetchStoresDedup,
  invalidateEntityCache
} = offlineSyncDeps;

const entityService = createOfflineSyncEntityService({
  offlineDB,
  getOfflineStoreName,
  PATIENT_BATCH_SIZE,
  PATIENT_SYNC_COOLDOWN
});

const patientService = createOfflineSyncPatientService({
  offlineDB,
  Patient,
  invalidateEntityCache
});

const {
  getSyncMetaTimestamp,
  checkIfEntityNeedsSync,
  syncPatientsBatched,
  syncEntityWithTimestampCheck
} = entityService;

const { syncPatientsByIds } = patientService;

// ==================== TIMESTAMP-BASED SYNC HELPERS ====================

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

const { performBackgroundSync } = createOfflineSyncBackgroundService({
  offlineDB,
  Delivery,
  RxTempLogs,
  syncPatientsByIds,
  invalidateEntityCache,
  shouldRunMobileHistoricalSync,
  getHistoricalSyncMeta,
  getNextDeliveryDateToSync,
  syncHistoricalPatientsByStore,
  updateHistoricalSyncMeta,
  getSyncInProgress,
  getSyncPaused,
  setSyncInProgress,
  getLastBackgroundSyncAt,
  setLastBackgroundSyncAt,
  notifySyncStatus,
  BATCH_COOLDOWN,
  DELIVERY_DATE_RANGE_DAYS,
  BACKGROUND_SYNC_MIN_INTERVAL_MS,
  format,
  subDays
});

const { quickReconcile } = createOfflineSyncReconcileService({
  offlineDB,
  Delivery,
  AppUser,
  fetchAppUsersDedup,
  invalidateEntityCache
});

const getPriorityHelpers = () => createOfflineSyncPriorityHelpers({
  AppUser,
  City,
  Store,
  Company,
  Delivery,
  Patient,
  RxTempLogs,
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
  return getPriorityHelpers().performPrioritySyncBeforeRefresh(selectedDateStr, cityId, smartRefreshMgr, fetchAllDriversDeliveries);
};



/**
 * Load priority data for initial display on app load
 * Order: Cities → AppUsers → Deliveries (SELECTED DATE + CITY ONLY) → Patients for those deliveries ONLY
 * CRITICAL: Patients are synced only for the selected date's deliveries (lightweight priority load)
 * Background store-by-store patient sync happens separately after system cools down
 */
const PRIORITY_SYNC_KEY = 'rxdeliver_priority_sync_ts';
const PRIORITY_SYNC_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes

const isPrioritySyncFresh = (selectedDateStr) => {
  try {
    const raw = localStorage.getItem(PRIORITY_SYNC_KEY);
    if (!raw) return false;
    const { ts, date } = JSON.parse(raw);
    // Also invalidate if the selected date changed (e.g. day rolled over)
    if (date !== selectedDateStr) return false;
    return Date.now() - ts < PRIORITY_SYNC_FRESHNESS_MS;
  } catch (_) { return false; }
};

const markPrioritySyncComplete = (selectedDateStr) => {
  try {
    localStorage.setItem(PRIORITY_SYNC_KEY, JSON.stringify({ ts: Date.now(), date: selectedDateStr }));
  } catch (_) {}
};

export const invalidatePrioritySyncCache = () => {
  try { localStorage.removeItem(PRIORITY_SYNC_KEY); } catch (_) {}
};

export const loadPriorityData = async (selectedDateStr, cityId = null, filters = {}) => {
  if (getSyncPaused()) return { skipped: true };

  // ── FRESHNESS GUARD: skip if we synced this date within the last 5 minutes ──
  if (isPrioritySyncFresh(selectedDateStr)) {
    console.log('⏭️ [PrioritySync] Skipped — data is fresh (< 5min old). Relying on SmartRefresh.');
    return { skipped: true, fresh: true };
  }

  setSyncInProgress(true);
  notifySyncStatus({ status: 'syncing', entity: 'Starting priority load...', progress: 5 });
  
  try {
    // Step 1: Sync Cities (lightweight)
    const cities = await City.list();
    await offlineDB.replaceAllRecords(offlineDB.STORES.CITIES, cities);
    invalidateEntityCache('City');
    notifySyncStatus({ status: 'syncing', entity: 'Cities', progress: 10, count: cities.length });
    
    // Step 2: Sync ALL AppUsers (entire entity)
    const appUsersRaw = await fetchAppUsersDedup();
    const appUsersByUserId = new Map();
    appUsersRaw.forEach(au => {
      if (!au || !au.user_id) return;
      const existing = appUsersByUserId.get(au.user_id);
      if (!existing) {
        appUsersByUserId.set(au.user_id, au);
      } else {
        const newLocTime = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
        const exLocTime = existing.location_updated_at ? new Date(existing.location_updated_at).getTime() : 0;
        if (newLocTime > exLocTime) appUsersByUserId.set(au.user_id, au);
      }
    });
    const appUsers = Array.from(appUsersByUserId.values());
    await offlineDB.replaceAllRecords(offlineDB.STORES.APP_USERS, appUsers);
    invalidateEntityCache('AppUser');
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers', progress: 25, count: appUsers.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    // Step 3: Sync Deliveries for SELECTED DATE + CITY ONLY
    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 40 });
    const deliveryFilter = { delivery_date: selectedDateStr };
    if (cityId) {
      const cityStores = (await offlineDB.getAll(offlineDB.STORES.STORES) || [])
        .filter(s => s && s.city_id === cityId)
        .map(s => s.id);
      if (cityStores.length > 0) deliveryFilter.store_id = { $in: cityStores };
    }
    const deliveries = await Delivery.filter(deliveryFilter, '-updated_date', 5000);
    // CRITICAL: Use bulkSave to merge, not replaceRecordsByIndex which clears data
    if (deliveries && deliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    }
    invalidateEntityCache('Delivery');
    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 55, count: deliveries.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    
    // Step 4: Sync ONLY patients for these deliveries (priority light-weight sync)
    notifySyncStatus({ status: 'syncing', entity: 'Patients (priority)', progress: 60 });
    const patientIds = Array.from(new Set(
      (deliveries || [])
        .filter(d => d && d.patient_id)
        .map(d => d.patient_id)
    ));
    
    let syncedPatients = [];
    if (patientIds.length > 0) {
      const { freshPatients = [] } = await syncPatientsByIds(patientIds);
      if (freshPatients.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients);
        syncedPatients = freshPatients;
      }
    }
    invalidateEntityCache('Patient');
    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 85, count: patientIds.length });
    
    // Step 5: Sync RxTempLogs — prune records deleted server-side
    try {
      const serverTempLogs = await RxTempLogs.filter({ delivery_date: selectedDateStr });
      const serverIds = new Set((serverTempLogs || []).map(l => l?.id).filter(Boolean));
      const localTempLogs = (await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS))
        .filter(l => l?.delivery_date === selectedDateStr);
      const toDeleteTemp = localTempLogs.filter(l => l?.id && !serverIds.has(l.id));
      if (toDeleteTemp.length > 0) {
        await Promise.all(toDeleteTemp.map(l =>
          offlineDB.deleteRecord(offlineDB.STORES.RX_TEMP_LOGS, l.id).catch(() => {})));
        console.log(`🧹 [TempLogSync] Pruned ${toDeleteTemp.length} stale offline temp log(s) for ${selectedDateStr}`);
      }
      if (serverTempLogs && serverTempLogs.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.RX_TEMP_LOGS, serverTempLogs);
      }
    } catch (_) {}

    // Update sync status
    const now = new Date().toISOString();
    await Promise.all([
      offlineDB.updateSyncStatus('City', { recordCount: cities.length, status: 'synced', lastSync: now, lastFullSync: now }),
      offlineDB.updateSyncStatus('AppUser', { recordCount: appUsers.length, status: 'synced', lastSync: now, lastFullSync: now }),
      offlineDB.updateSyncStatus('Delivery', { recordCount: deliveries.length, status: 'synced', lastSync: now }),
      offlineDB.updateSyncStatus('Patient', { status: 'synced', lastSync: now })
    ]);
    
    markPrioritySyncComplete(selectedDateStr);
    notifySyncStatus({ status: 'complete', progress: 100 });
    return { success: true, cities, appUsers, deliveries, patients: syncedPatients };
  } catch (error) {
    notifySyncStatus({ status: 'error', error: error.message });
    return { error: error.message };
  } finally {
    setSyncInProgress(false);
  }
};

// ==================== BACKGROUND SYNC ====================

/**
 * Background sync with timestamp-based incremental strategy for deliveries
 * Syncs one delivery date at a time over past 90 days
 */
export { performBackgroundSync };

/**
 * Slow store-by-store patient sync for offline DB enrichment
 * Runs AFTER priority sync, with long delays between batches to respect rate limits
 * Does NOT clear existing patients — only merges new/updated ones
 */
export const performSlowStorePatientSync = async () => {
  if (getSyncPaused() || getSyncInProgress()) return { skipped: true };
  // CRITICAL: Never run while PullToSync or any other active sync is running
  if (window.__dashboardSyncing || window.__activePullToSyncRunId) return { skipped: true, reason: 'pull_to_sync_active' };
  
  setSyncInProgress(true);
  notifySyncStatus({ status: 'syncing', entity: 'Background patient sync...', progress: 5 });
  
  try {
    // Get all stores (already synced during priority load)
    const stores = await offlineDB.getAll(offlineDB.STORES.STORES) || [];
    if (stores.length === 0) {
      notifySyncStatus({ status: 'complete' });
      return { skipped: true };
    }
    
    console.log(`🐢 [SlowPatientSync] Starting store-by-store sync (${stores.length} stores)...`);
    
    let totalSyncedPatients = 0;
    const STORE_BATCH_COOLDOWN = 8000; // 8 sec between stores — conservative to avoid rate limits
    
    for (let i = 0; i < stores.length; i++) {
      const store = stores[i];
      if (!store || !store.id) continue;
      // Abort if PullToSync or another sync starts mid-run
      if (window.__dashboardSyncing || window.__activePullToSyncRunId || getSyncPaused()) break;
      
      try {
        // Fetch ALL patients for this store (active + inactive) in batches
        let slowOffset = 0;
        const SLOW_BATCH = 200;
        while (true) {
          const storePatients = await Patient.filter({ store_id: store.id }, '-updated_date', SLOW_BATCH, slowOffset);
          if (!storePatients || storePatients.length === 0) break;
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, storePatients);
          totalSyncedPatients += storePatients.length;
          if (storePatients.length < SLOW_BATCH) break;
          slowOffset += SLOW_BATCH;
          await new Promise(r => setTimeout(r, 300));
        }
        
        const progress = 5 + Math.floor((i / stores.length) * 90);
        notifySyncStatus({ 
          status: 'syncing', 
          entity: `Patients (${store.name || 'Store'})`, 
          progress,
          count: totalSyncedPatients
        });
        
        // Wait before next store to avoid rate limits
        await new Promise(r => setTimeout(r, STORE_BATCH_COOLDOWN));
      } catch (storeError) {
        console.warn(`⚠️ [SlowPatientSync] Failed to sync store ${store.name}:`, storeError.message);
        // Continue to next store on error
      }
    }
    
    invalidateEntityCache('Patient');
    notifySyncStatus({ status: 'complete', progress: 100 });
    console.log(`✅ [SlowPatientSync] Complete — synced ${totalSyncedPatients} patients from all stores`);
    
    return { success: true, totalSyncedPatients };
  } catch (error) {
    console.error('❌ [SlowPatientSync] Error:', error.message);
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
    // Upsert fresh records, then prune any offline records that no longer exist on the server
    const incomingIds = new Set((deliveries || []).map(d => d?.id).filter(Boolean));
    const existingForDate = (await offlineDB.getAll(offlineDB.STORES.DELIVERIES)).filter(d => d?.delivery_date === dateStr);
    const toDelete = existingForDate.filter(d => d?.id && !d.id.startsWith('temp_') && !incomingIds.has(d.id));
    if (deliveries && deliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    }
    if (toDelete.length > 0) {
      await Promise.all(toDelete.map(d => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id).catch(() => {})));
    }
    invalidateEntityCache('Delivery');
    return deliveries || [];
  } catch (error) {
    // On error (e.g. rate limit), return whatever is in the offline DB for this date
    const cached = (await offlineDB.getAll(offlineDB.STORES.DELIVERIES)).filter(d => d?.delivery_date === dateStr);
    return cached;
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
export { quickReconcile };

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
    // replaceAllRecords already handles orphan pruning for AppUsers (full replace)
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

    notifySyncStatus({ status: 'syncing', entity: 'InterStore Locations', progress: 29 });
    const interStoreLocsFull = await InterStoreLocation.list();
    if (interStoreLocsFull && interStoreLocsFull.length > 0) {
      await offlineDB.replaceAllRecords(offlineDB.STORES.INTER_STORE_LOCATIONS, interStoreLocsFull);
    }
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    // Sync ALL patients store-by-store (both active AND inactive) for a complete offline DB
    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 25 });
    console.log('🔄 [ForceSyncAll] Syncing ALL patients from all stores (active + inactive)...');

    const allStores = await Store.list();
    const STORE_COOLDOWN = 1500; // 1.5s between stores
    const PATIENT_BATCH_SIZE_FORCE = 200;
    let allOnlinePatientIds = new Set(); // track all IDs for orphan pruning
    let totalSyncedPatients = 0;

    for (let i = 0; i < allStores.length; i++) {
      const store = allStores[i];
      if (!store?.id) continue;
      try {
        // Fetch ALL patients for this store (no status filter) in batches
        let offset = 0;
        while (true) {
          const storePatients = await Patient.filter({ store_id: store.id }, '-updated_date', PATIENT_BATCH_SIZE_FORCE, offset);
          if (!storePatients || storePatients.length === 0) break;
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, storePatients);
          storePatients.forEach(p => { if (p?.id) allOnlinePatientIds.add(p.id); });
          totalSyncedPatients += storePatients.length;
          if (storePatients.length < PATIENT_BATCH_SIZE_FORCE) break;
          offset += PATIENT_BATCH_SIZE_FORCE;
          await new Promise(r => setTimeout(r, 300));
        }
        const progress = 25 + Math.floor((i / allStores.length) * 20);
        notifySyncStatus({ status: 'syncing', entity: `Patients (${store.name || 'Store'} ${i+1}/${allStores.length})`, progress, count: totalSyncedPatients });
        await new Promise(r => setTimeout(r, STORE_COOLDOWN));
      } catch (storeError) {
        if (storeError?.response?.status === 429 || storeError?.message?.includes('429')) {
          console.warn('⏰ [ForceSyncAll] Rate limited during patient sync, stopping');
          break;
        }
        console.warn(`⚠️ [ForceSyncAll] Failed to sync patients for store ${store.name}:`, storeError.message);
      }
    }

    // Prune patients that exist offline but no longer exist online
    if (allOnlinePatientIds.size > 0) {
      const allOfflinePatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      const orphanPatients = (allOfflinePatients || []).filter(p => p?.id && !p.id.startsWith('temp_') && !allOnlinePatientIds.has(p.id));
      if (orphanPatients.length > 0) {
        await Promise.all(orphanPatients.map(p => offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, p.id).catch(() => {})));
        console.log(`🗑️ [ForceSyncAll] Pruned ${orphanPatients.length} deleted patients from offline DB`);
      }
    }
    invalidateEntityCache('Patient');

    const cleanPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
    console.log(`✅ [ForceSyncAll] Synced ${totalSyncedPatients} patients; offline DB now has ${cleanPatients.length} total`);
    
    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 45, count: cleanPatients.length });
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));

    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 40 });
    const deliveries = await Delivery.filter({ delivery_date: selectedDateStr });
    // Upsert + prune deleted — never clear the date's data before writing
    {
      const fsIncomingIds = new Set((deliveries || []).map(d => d?.id).filter(Boolean));
      const fsExisting = (await offlineDB.getAll(offlineDB.STORES.DELIVERIES)).filter(d => d?.delivery_date === selectedDateStr);
      const fsToDelete = fsExisting.filter(d => d?.id && !d.id.startsWith('temp_') && !fsIncomingIds.has(d.id));
      if (deliveries && deliveries.length > 0) await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
      if (fsToDelete.length > 0) await Promise.all(fsToDelete.map(d => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id).catch(() => {})));
    }
    invalidateEntityCache('Delivery');
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

  // We need stores to filter deliveries by city — fetch stores first (lightweight)
  let stores = [], cities = [], appUsers = [], companies = [];

  try {
    // ── PHASE 1 (PRIORITY): Deliveries + Patients for selected date/city ─────
    // Fetch stores quickly so we can filter deliveries by city
    notifySyncStatus({ status: 'syncing', entity: 'Stores', progress: 5 });
    stores = await Store.list();
    await offlineDB.replaceAllRecords(offlineDB.STORES.STORES, stores);
    invalidateEntityCache('Store');

    const cityStoreIds = (stores || []).filter((store) => !selectedCityId || store?.city_id === selectedCityId).map((store) => store.id);

    // Fetch deliveries for selected date + city
    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 15 });
    const deliveryFilter = { delivery_date: selectedDateStr };
    if (cityStoreIds.length > 0) {
      deliveryFilter.store_id = { $in: cityStoreIds };
    }
    const deliveries = await Delivery.filter(deliveryFilter, '-updated_date', 5000);

    // CRITICAL: Merge deliveries, never delete — user edits must be preserved
    if (deliveries && deliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries);
    }
    invalidateEntityCache('Delivery');
    notifySyncStatus({ status: 'syncing', entity: 'Deliveries', progress: 35, count: deliveries.length });

    // Sync patients for these deliveries immediately
    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 40 });
    const patientIds = Array.from(new Set((deliveries || []).filter(d => d && d.patient_id).map(d => d.patient_id)));
    const { totalPatients, freshPatients = [] } = await syncPatientsByIds(patientIds);
    if (freshPatients.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients);
    }
    invalidateEntityCache('Patient');
    notifySyncStatus({ status: 'syncing', entity: 'Patients', progress: 60, count: freshPatients.length });

    // ── PRIORITY UI UPDATE: Push deliveries + patients to UI immediately ─────
    // This is the key change — callers get fresh data right away before secondary sync
    const priorityResult = {
      success: true,
      priority: true,
      deliveries,
      patients: freshPatients,
      appUsers: [],
      cities: [],
      stores,
      companies: [],
    };
    window.dispatchEvent(new CustomEvent('manualSyncPriorityDataReady', { detail: priorityResult }));

    // ── PHASE 2 (SECONDARY): AppUsers, Cities, Companies in background ───────
    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers & Cities', progress: 65 });

    const [citiesResult, appUsersRaw] = await Promise.all([
      City.list(),
      fetchAppUsersDedup()
    ]);
    cities = citiesResult;
    await offlineDB.replaceAllRecords(offlineDB.STORES.CITIES, cities);
    invalidateEntityCache('City');

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
    appUsers = Array.from(appUsersByUserId.values());
    await offlineDB.replaceAllRecords(offlineDB.STORES.APP_USERS, appUsers);
    invalidateEntityCache('AppUser');
    notifySyncStatus({ status: 'syncing', entity: 'AppUsers & Cities', progress: 82, count: appUsers.length });

    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    notifySyncStatus({ status: 'syncing', entity: 'Companies', progress: 87 });
    companies = await Company.list();
    await offlineDB.replaceAllRecords(offlineDB.STORES.COMPANIES, companies);
    invalidateEntityCache('Company');

    await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
    notifySyncStatus({ status: 'syncing', entity: 'InterStore Locations', progress: 93 });
    const interStoreLocations = await InterStoreLocation.list();
    if (interStoreLocations && interStoreLocations.length > 0) {
      await offlineDB.replaceAllRecords(offlineDB.STORES.INTER_STORE_LOCATIONS, interStoreLocations);
    }

    // Update sync status records
    const syncTime = new Date().toISOString();
    const [offlinePatientsForStatus, offlineDeliveriesForStatus] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.PATIENTS),
      offlineDB.getAll(offlineDB.STORES.DELIVERIES)
    ]);
    await Promise.all([
      offlineDB.updateSyncStatus('Store', { recordCount: stores.length, status: 'synced', lastSync: syncTime, lastFullSync: syncTime }),
      offlineDB.updateSyncStatus('Delivery', { recordCount: offlineDeliveriesForStatus.length, status: 'synced', lastSync: syncTime }),
      offlineDB.updateSyncStatus('Patient', { recordCount: offlinePatientsForStatus.length, status: 'synced', lastSync: syncTime }),
      offlineDB.updateSyncStatus('AppUser', { recordCount: appUsers.length, status: 'synced', lastSync: syncTime, lastFullSync: syncTime }),
      offlineDB.updateSyncStatus('City', { recordCount: cities.length, status: 'synced', lastSync: syncTime, lastFullSync: syncTime }),
      offlineDB.updateSyncStatus('Company', { recordCount: companies.length, status: 'synced', lastSync: syncTime, lastFullSync: syncTime })
    ]);

    notifySyncStatus({ status: 'complete', progress: 100 });
    return {
      success: true,
      deliveries,
      patients: freshPatients,
      appUsers,
      cities,
      stores,
      companies,
      counts: {
        deliveries: deliveries.length,
        patients: totalPatients,
        appUsers: appUsers.length,
        cities: cities.length,
        stores: stores.length,
        companies: companies.length
      }
    };
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

    // Step 2: Sync ALL patients store-by-store (active + inactive, batched)
    notifySyncStatus({ status: 'syncing', entity: 'Patients (all stores)', progress: 55 });
    console.log('🔄 [OfflineSync] Step 2: Syncing ALL patients store-by-store (active + inactive)...');

    const allStoresForPatients = await Store.list();
    let totalRestartPatients = 0;
    const allRestartOnlinePatientIds = new Set();
    const RESTART_STORE_COOLDOWN = 1500;
    const RESTART_PATIENT_BATCH = 200;

    for (let si = 0; si < allStoresForPatients.length; si++) {
      const store = allStoresForPatients[si];
      if (!store?.id) continue;
      try {
        let offset = 0;
        while (true) {
          const storePatients = await Patient.filter({ store_id: store.id }, '-updated_date', RESTART_PATIENT_BATCH, offset);
          if (!storePatients || storePatients.length === 0) break;
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, storePatients);
          storePatients.forEach(p => { if (p?.id) allRestartOnlinePatientIds.add(p.id); });
          totalRestartPatients += storePatients.length;
          if (storePatients.length < RESTART_PATIENT_BATCH) break;
          offset += RESTART_PATIENT_BATCH;
          await new Promise(r => setTimeout(r, 300));
        }
        const batchProgress = 55 + Math.floor((si / allStoresForPatients.length) * 20);
        notifySyncStatus({ status: 'syncing', entity: `Patients (${store.name || 'Store'} ${si+1}/${allStoresForPatients.length})`, progress: batchProgress, count: totalRestartPatients });
        await new Promise(r => setTimeout(r, RESTART_STORE_COOLDOWN));
      } catch (err) {
        if (err?.response?.status === 429 || err?.message?.includes('429')) {
          console.warn('⏰ [OfflineSync] Rate limited during patient sync, stopping');
          break;
        }
        console.warn(`⚠️ [OfflineSync] Failed store ${store.name}:`, err.message);
      }
    }

    // Prune patients no longer in the online DB
    if (allRestartOnlinePatientIds.size > 0) {
      const allOfflineForRestart = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      const orphans = (allOfflineForRestart || []).filter(p => p?.id && !p.id.startsWith('temp_') && !allRestartOnlinePatientIds.has(p.id));
      if (orphans.length > 0) {
        await Promise.all(orphans.map(p => offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, p.id).catch(() => {})));
        console.log(`🗑️ [RestartSync] Pruned ${orphans.length} deleted patients`);
      }
    }
    invalidateEntityCache('Patient');

    const cleanPatients = (await offlineDB.getAll(offlineDB.STORES.PATIENTS)).filter(p => p && p.id && !p.id.startsWith('temp_'));
    console.log(`✅ [OfflineSync] Synced ${totalRestartPatients} patients; offline DB has ${cleanPatients.length} total`);
    
    notifySyncStatus({ status: 'syncing', entity: `Patients (total: ${cleanPatients.length})`, progress: 75 });
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
    
    // CRITICAL: Get actual offline DB counts (merged data, not just synced)
    const offlinePatientsForStatus = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
    const offlineDeliveriesForStatus = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    
    await Promise.all([
      offlineDB.updateSyncStatus('City', { recordCount: cities.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Store', { recordCount: stores.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('AppUser', { recordCount: appUsers.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Delivery', { recordCount: offlineDeliveriesForStatus.length, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
      offlineDB.updateSyncStatus('Patient', { recordCount: offlinePatientsForStatus.length, status: 'synced', lastSync: new Date().toISOString() })
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
    const preRenderResult = await getPriorityHelpers().preRenderFreshSync(smartRefreshMgr, currentUser);
    
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