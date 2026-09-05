/**
 * App Load Data Manager - Handles offline-first data loading on app init
 * Orchestrates: offline DB → UI snapshot → priority sync → fresh UI update
 */

import { executeAppLoadDataSync } from '../utils/appLoadDataSync';
import { smartRefreshManager } from '../utils/smartRefreshManager';

/**
 * Initialize app load data listeners and syncing
 * Returns listeners to be attached to window
 */
export const initializeAppLoadDataFlow = (uiStateSetters) => {
  const {
    setDeliveries,
    setPatients,
    setAppUsers,
    setStores,
    setCities,
    setDataLoaded
  } = uiStateSetters;

  // Wipe guard (Sep 4 2026): an empty array is a valid no-op signal (fetch failed /
  // degraded IDB read), NOT a "clear the UI" instruction. Never replace non-empty
  // state with an empty array — that produced phantom patient/store wipes.
  const applyIfNonEmpty = (setter, value, label) => {
    if (Array.isArray(value) && value.length === 0) {
      console.warn('[AppLoad] Skipping empty ' + label + ' update — would wipe UI state');
      return;
    }
    if (value) setter(value);
  };

  const handleSnapshot = (event) => {
    const { deliveries, patients, appUsers, stores, cities } = event.detail || {};
    applyIfNonEmpty(setDeliveries, deliveries, 'deliveries');
    applyIfNonEmpty(setPatients, patients, 'patients');
    applyIfNonEmpty(setAppUsers, appUsers, 'appUsers');
    applyIfNonEmpty(setStores, stores, 'stores');
    applyIfNonEmpty(setCities, cities, 'cities');
    console.log('📸 [AppLoad] Offline snapshot applied to UI');
  };

  const handleFreshData = (event) => {
    const { deliveries, patients, appUsers, stores, cities } = event.detail || {};
    applyIfNonEmpty(setDeliveries, deliveries, 'deliveries');
    applyIfNonEmpty(setPatients, patients, 'patients');
    if (Array.isArray(appUsers) && appUsers.length > 0) {
      setAppUsers(appUsers);
      // Stamp all AppUsers as "just refreshed" so the SmartRefresh poll skips them for 60s
      smartRefreshManager.stampAppUsersAsRefreshed(appUsers);
    }
    applyIfNonEmpty(setStores, stores, 'stores');
    applyIfNonEmpty(setCities, cities, 'cities');
    setDataLoaded(true);
    console.log('✅ [AppLoad] Fresh synced data applied to UI');
  };

  // Attach listeners
  window.addEventListener('appLoadSnapshotReady', handleSnapshot);
  window.addEventListener('appLoadFreshDataReady', handleFreshData);

  // Return cleanup function
  return () => {
    window.removeEventListener('appLoadSnapshotReady', handleSnapshot);
    window.removeEventListener('appLoadFreshDataReady', handleFreshData);
  };
};

/**
 * Execute app load sync for given date and city
 */
export { executeAppLoadDataSync };