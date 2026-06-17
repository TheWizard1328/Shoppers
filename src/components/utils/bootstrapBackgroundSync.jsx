/**
 * bootstrapBackgroundSync
 *
 * Runs AFTER the app has rendered using IndexedDB data.
 * Silently fetches City, Store, AppUser, AppSettings, UserDevice from the
 * backend and updates the offline DB + UI state — only when data is stale.
 *
 * Staleness threshold: 4 hours for quasi-static entities (users, stores, cities).
 * This means a fresh device or a first-ever session will sync once on startup,
 * but repeat sessions within the same day will skip the backend call entirely.
 */

import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';
import { indexInterStoreLocation } from './interStoreDisplayName';

const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
const SYNC_KEY = 'rxdeliver_bootstrap_sync_ts';

const isStale = () => {
  const lastSync = parseInt(localStorage.getItem(SYNC_KEY) || '0', 10);
  return Date.now() - lastSync > STALE_THRESHOLD_MS;
};

const markSynced = () => {
  localStorage.setItem(SYNC_KEY, String(Date.now()));
};

/**
 * Run background sync for bootstrap entities.
 * @param {object} callbacks - Optional UI state updaters
 * @param {function} callbacks.setCities
 * @param {function} callbacks.setStores
 * @param {function} callbacks.setAppUsers
 * @param {function} callbacks.setAdminImportEnabled
 * @param {function} callbacks.setAppVersion
 * @param {function} callbacks.setSquareLocationConfigs
 */
export const runBootstrapBackgroundSync = async (callbacks = {}) => {
  if (!isStale()) {
    console.log('⏭️ [BootstrapSync] Skipped — data is fresh (< 4h old)');
    return;
  }

  console.log('🔄 [BootstrapSync] Starting background sync for bootstrap entities...');

  try {
    // Fetch all bootstrap entities in parallel — this is the ONE consolidated backend call
    const [cities, stores, appUsers, appSettings, squareLocationConfigs, interStoreLocations] = await Promise.all([
      base44.entities.City.list().catch(() => null),
      base44.entities.Store.list().catch(() => null),
      base44.entities.AppUser.list().catch(() => null),
      base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }).catch(() => null),
      base44.entities.SquareLocationConfig.filter({ status: 'active' }).catch(() => null),
      base44.entities.InterStoreLocation.list().catch(() => null),
    ]);

    // --- Cities ---
    if (cities?.length) {
      await offlineDB.bulkSave(offlineDB.STORES.CITIES, cities);
      await offlineDB.updateSyncStatus('City', { status: 'synced', recordCount: cities.length });
      if (callbacks.setCities) {
        callbacks.setCities(
          [...cities].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity))
        );
      }
      console.log(`✅ [BootstrapSync] Cities synced: ${cities.length}`);
    }

    // --- Stores ---
    if (stores?.length) {
      await offlineDB.bulkSave(offlineDB.STORES.STORES, stores);
      await offlineDB.updateSyncStatus('Store', { status: 'synced', recordCount: stores.length });
      if (callbacks.setStores) {
        callbacks.setStores(
          [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity))
        );
      }
      console.log(`✅ [BootstrapSync] Stores synced: ${stores.length}`);
    }

    // --- AppUsers ---
    if (appUsers?.length) {
      await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
      await offlineDB.updateSyncStatus('AppUser', { status: 'synced', recordCount: appUsers.length });
      if (callbacks.setAppUsers) {
        callbacks.setAppUsers(appUsers);
      }
      console.log(`✅ [BootstrapSync] AppUsers synced: ${appUsers.length}`);
    }

    // --- AppSettings flags ---
    if (appSettings?.length) {
      const refreshConfig = appSettings[0]?.setting_value || {};
      if (callbacks.setAdminImportEnabled) {
        callbacks.setAdminImportEnabled(refreshConfig.adminImportEnabled === true);
      }
      if (callbacks.setAppVersion && refreshConfig.appVersion) {
        const v = refreshConfig.appVersion;
        callbacks.setAppVersion(`v${v.major}.${v.minor}.${v.build}`);
      }
    }

    // --- SquareLocationConfigs ---
    if (squareLocationConfigs?.length) {
      await offlineDB.bulkSave(offlineDB.STORES.SQUARE_LOCATION_CONFIGS, squareLocationConfigs);
      if (callbacks.setSquareLocationConfigs) {
        callbacks.setSquareLocationConfigs(squareLocationConfigs);
      }
      // Always keep window cache in sync for synchronous access in StopCardActionButtons
      if (typeof window !== 'undefined') {
        window.__squareLocationConfigCache = squareLocationConfigs;
      }
      console.log(`✅ [BootstrapSync] SquareLocationConfigs synced: ${squareLocationConfigs.length}`);
    }

    // --- InterStoreLocations ---
    if (interStoreLocations?.length) {
      await offlineDB.bulkSave(offlineDB.STORES.INTER_STORE_LOCATIONS, interStoreLocations);
      interStoreLocations.forEach(indexInterStoreLocation);
      console.log(`✅ [BootstrapSync] InterStoreLocations synced: ${interStoreLocations.length}`);
    }

    markSynced();
    console.log('✅ [BootstrapSync] Background sync complete');
  } catch (error) {
    // Non-fatal — the app already has offline data, this is best-effort
    console.warn('⚠️ [BootstrapSync] Background sync failed (non-fatal):', error?.message);
  }
};