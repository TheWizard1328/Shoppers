/**
 * App Load Data Sync Helper
 * Orchestrates: 1) Offline DB load → 2) Priority online sync (date+city) → 3) UI update
 */

import { format } from 'date-fns';
import { offlineDB } from './offlineDatabase';
import { loadPriorityData } from './offlineSync';

/**
 * Execute app load data sync flow
 * STEP 1: Load offline DB → STEP 2: Priority online sync → STEP 3: Dispatch UI update
 */
export const executeAppLoadDataSync = async (selectedDateStr, selectedCityId) => {
  try {
    // STEP 1: Load offline DB snapshot
    console.log('📸 [AppLoadSync] Step 1: Loading offline DB...');
    const [offlineDels, offlinePats, offlineAppUsers, offlineStores, offlineCities] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.DELIVERIES).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.CITIES).catch(() => [])
    ]);

    const snapshotData = {
      deliveries: offlineDels || [],
      patients: offlinePats || [],
      appUsers: offlineAppUsers || [],
      stores: (offlineStores || []).sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)),
      cities: (offlineCities || []).sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity))
    };
    
    // Immediately dispatch snapshot to UI
    window.dispatchEvent(new CustomEvent('appLoadSnapshotReady', { detail: snapshotData }));
    console.log(`✅ [AppLoadSync] Offline snapshot ready: ${snapshotData.deliveries.length} deliveries, ${snapshotData.patients.length} patients`);
    
    // STEP 2: Priority online sync for selected date + city (all drivers)
    console.log(`🔄 [AppLoadSync] Step 2: Priority sync for ${selectedDateStr} in city ${selectedCityId}...`);
    const syncResult = await loadPriorityData(selectedDateStr, selectedCityId);
    
    if (syncResult.error) {
      console.warn('⚠️ [AppLoadSync] Priority sync failed:', syncResult.error);
      return { success: false, snapshot: snapshotData, error: syncResult.error };
    }
    
    // STEP 3: Dispatch fresh synced data to UI
    const freshData = {
      deliveries: syncResult.deliveries || snapshotData.deliveries,
      patients: syncResult.patients || snapshotData.patients,
      appUsers: syncResult.appUsers || snapshotData.appUsers,
      stores: syncResult.stores || snapshotData.stores,
      cities: syncResult.cities || snapshotData.cities
    };
    
    window.dispatchEvent(new CustomEvent('appLoadFreshDataReady', { detail: freshData }));
    console.log(`✅ [AppLoadSync] Fresh data synced: ${freshData.deliveries.length} deliveries, ${freshData.patients.length} patients`);
    
    return { success: true, snapshot: snapshotData, fresh: freshData };
  } catch (error) {
    console.error('❌ [AppLoadSync] Error:', error.message);
    return { success: false, error: error.message };
  }
};