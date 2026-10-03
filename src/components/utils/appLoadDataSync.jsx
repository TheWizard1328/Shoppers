/**
 * App Load Data Sync Helper
 * Orchestrates: 1) Offline DB load → 2) Priority online sync (date+city) → 3) UI update
 */

import { format } from 'date-fns';
import { offlineDB } from './offlineDatabase';
import { loadPriorityData } from './offlineSync';
// Pre-warm the InterStoreLocation in-memory cache before cards render
import { getAllLocations, indexInterStoreLocation } from './interStoreDisplayName';
// NOTE: the inter-store cache is now warmed from the parallel IDB snapshot batch
// (synchronous, no network on the critical path). getAllLocations() runs in the
// background to cover the IDB-empty case and persists its result for next boot.

/**
 * Execute app load data sync flow
 * STEP 1: Load offline DB → STEP 2: Priority online sync → STEP 3: Dispatch UI update
 */
export const executeAppLoadDataSync = async (selectedDateStr, selectedCityId) => {
  try {
    // STEP 1: Load offline DB snapshot
    console.log('📸 [AppLoadSync] Step 1: Loading offline DB...');
    const [offlineDels, offlinePats, offlineAppUsers, offlineStores, offlineCities, offlineInterStores] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.DELIVERIES).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.CITIES).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.INTER_STORE_LOCATIONS).catch(() => [])
    ]);

    // Warm the inter-store in-memory cache SYNCHRONOUSLY from the IDB snapshot so
    // useInterStoreDisplayName/useInterStoreLocation resolve on the FIRST render.
    // (Previously the prewarm awaited a network fallback before dispatching the
    // snapshot — stop names sat "Unknown" while that call raced the boot storm.)
    try { (offlineInterStores || []).forEach((loc) => indexInterStoreLocation(loc)); } catch (_) {}

    const snapshotData = {
      deliveries: offlineDels || [],
      patients: offlinePats || [],
      appUsers: offlineAppUsers || [],
      stores: (offlineStores || []).sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)),
      cities: (offlineCities || []).sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity))
    };
    
    // Background warm: if the IDB inter-store store is empty (fresh device /
    // recreated DB), getAllLocations() falls back to the API, and now PERSISTS
    // the result to IDB so the next boot resolves from IDB instantly.
    // Never awaited — it must not delay the snapshot dispatch.
    try { getAllLocations().catch(() => {}); } catch (_) {}

    // Immediately dispatch snapshot to UI
    window.dispatchEvent(new CustomEvent('appLoadSnapshotReady', { detail: snapshotData }));
    console.log(`✅ [AppLoadSync] Offline snapshot ready: ${snapshotData.deliveries.length} deliveries, ${snapshotData.patients.length} patients`);
    
    // STEP 2: Priority online sync for selected date + city (all drivers)
    console.log(`🔄 [AppLoadSync] Step 2: Priority sync for ${selectedDateStr} in city ${selectedCityId}...`);
    // Partial fresh events: the priority chain syncs Cities → AppUsers →
    // Deliveries → Patients (with cooldowns between), and the single end-of-run
    // fresh event made stop names sit "Unknown" until the WHOLE chain finished.
    // Now deliveries and patients each dispatch the moment they land.
    const dispatchPartialFresh = (partial) => {
      try { window.dispatchEvent(new CustomEvent('appLoadFreshDataReady', { detail: partial })); } catch (_) {}
    };
    const syncResult = await loadPriorityData(selectedDateStr, selectedCityId, {}, (partial) => {
      if (partial && Object.keys(partial).length) dispatchPartialFresh(partial);
    });
    
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