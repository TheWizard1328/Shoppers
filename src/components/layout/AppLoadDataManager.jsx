/**
 * App Load Data Manager - Handles offline-first data loading on app init
 * Orchestrates: offline DB → UI snapshot → priority sync → fresh UI update
 */

import { executeAppLoadDataSync } from '../utils/appLoadDataSync';

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

  const handleSnapshot = (event) => {
    const { deliveries, patients, appUsers, stores, cities } = event.detail || {};
    if (deliveries) setDeliveries(deliveries);
    if (patients) setPatients(patients);
    if (appUsers) setAppUsers(appUsers);
    if (stores) setStores(stores);
    if (cities) setCities(cities);
    console.log('📸 [AppLoad] Offline snapshot applied to UI');
  };

  const handleFreshData = (event) => {
    const { deliveries, patients, appUsers, stores, cities } = event.detail || {};
    if (deliveries) setDeliveries(deliveries);
    if (patients) setPatients(patients);
    if (appUsers) setAppUsers(appUsers);
    if (stores) setStores(stores);
    if (cities) setCities(cities);
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