/**
 * filterChangeSync.js
 * 
 * Handles the 4-step UI-safe sync sequence when date or city changes:
 * 1. Snapshot current offline DB → send to UI immediately (no "Unknown" flash)
 * 2. Lock UI updates (block deliveriesUpdated / pullToSync events)
 * 3. Background: sync patients then deliveries for the new date/city
 * 4. Unlock UI + push fresh data in one atomic update
 */

import { offlineSyncDeps } from '@/components/services/offlineSyncDeps';
import { offlineSyncConfig } from '@/components/services/offlineSyncConfig';
import { createOfflineSyncPatientService } from '@/components/services/offlineSyncPatientService';

const { offlineDB, Patient, Delivery, Store, City, AppUser, fetchAppUsersDedup, invalidateEntityCache } = offlineSyncDeps;
const { BATCH_COOLDOWN } = offlineSyncConfig;

const patientService = createOfflineSyncPatientService({ offlineDB, Patient, invalidateEntityCache });
const { syncPatientsByIds } = patientService;

// UI lock flag — while true, Layout ignores intermediate sync events
let _uiLocked = false;

export const isUiLocked = () => _uiLocked;

/**
 * Main entry point — call this whenever date or city changes.
 *
 * @param {string} selectedDateStr  - New date (YYYY-MM-DD)
 * @param {string} selectedCityId   - New city ID (or null for all)
 * @param {function} applySnapshot  - (data: {deliveries, patients, appUsers, stores, cities}) => void  — updates UI
 * @param {function} applyFresh     - same signature — called after sync completes
 */
export const syncOnFilterChange = async (selectedDateStr, selectedCityId, applySnapshot, applyFresh) => {
  // ── STEP 1: Read current offline DB and push to UI immediately ─────────────
  console.log(`🔄 [FilterSync] Step 1 — snapshot offline DB for ${selectedDateStr}`);
  try {
    const [offlineDeliveries, offlinePatients, offlineAppUsers, offlineStores, offlineCities] = await Promise.all([
      offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.CITIES).catch(() => []),
    ]);
    applySnapshot({ deliveries: offlineDeliveries, patients: offlinePatients, appUsers: offlineAppUsers, stores: offlineStores, cities: offlineCities });
  } catch (err) {
    console.warn('⚠️ [FilterSync] Snapshot read failed — continuing with sync anyway', err.message);
  }

  // ── STEP 2: Lock UI ────────────────────────────────────────────────────────
  _uiLocked = true;
  console.log('🔒 [FilterSync] Step 2 — UI updates locked');

  // Give the offline snapshot time to render before going online
  await new Promise(resolve => setTimeout(resolve, 800));

  try {
    // ── STEP 3a: Determine city store IDs ────────────────────────────────────
    const allStores = await offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []);
    const cityStoreIds = (allStores || [])
      .filter(s => !selectedCityId || s?.city_id === selectedCityId)
      .map(s => s?.id)
      .filter(Boolean);

    // ── STEP 3b: Fetch deliveries for selected date + city ────────────────────
    console.log(`🔄 [FilterSync] Step 3b — fetch deliveries for ${selectedDateStr}`);
    let freshDeliveries = [];
    if (cityStoreIds.length > 0) {
      // Fetch city-scoped deliveries AND cycling markers (no store_id) in parallel
      const [cityDeliveries, cyclingMarkers] = await Promise.all([
        Delivery.filter({ delivery_date: selectedDateStr, store_id: { $in: cityStoreIds } }, '-updated_date', 5000).catch(() => []),
        Delivery.filter({ delivery_date: selectedDateStr, is_cycling_marker: true }, '-updated_date', 500).catch(() => []),
      ]);
      const merged = new Map();
      [...(cityDeliveries || []), ...(cyclingMarkers || [])].forEach(d => { if (d?.id) merged.set(d.id, d); });
      freshDeliveries = Array.from(merged.values());
    } else {
      freshDeliveries = await Delivery.filter({ delivery_date: selectedDateStr }, '-updated_date', 5000).catch(() => []);
    }

    // ── STEP 3c: Sync ONLY patients referenced by this date's deliveries ──────
    // Fast path — only what's needed for the current view
    const patientIds = Array.from(new Set((freshDeliveries || []).filter(d => d?.patient_id).map(d => d.patient_id)));
    if (patientIds.length > 0) {
      console.log(`🔄 [FilterSync] Step 3c — syncing ${patientIds.length} patients for selected date`);
      const { freshPatients = [] } = await syncPatientsByIds(patientIds).catch(() => ({ freshPatients: [] }));
      if (freshPatients.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients).catch(() => {});
        invalidateEntityCache('Patient');
      }
    }

    // ── STEP 3d: Merge fresh deliveries into offline DB for this date ─────────
    // CRITICAL: Do NOT purge existing records first — only delete IDs that are confirmed
    // gone from the server (present locally but absent from fresh fetch for same city).
    // Purging-then-replacing causes deliveries from other drivers / stores to vanish
    // if the fresh fetch is incomplete or RLS-scoped.
    console.log('🔄 [FilterSync] Step 3d — merge deliveries (no purge)');
    const offlineForDate = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr).catch(() => []);
    // Only purge records that belong to city stores AND are absent from the fresh server response
    const freshIds = new Set((freshDeliveries || []).map(d => d?.id).filter(Boolean));
    const staleIds = (offlineForDate || [])
      .filter(d => {
        if (!d?.id) return false;
        if (freshIds.has(d.id)) return false; // still present on server — keep
        if (selectedCityId && cityStoreIds.length > 0 && !cityStoreIds.includes(d?.store_id) && !d?.is_cycling_marker) return false; // different city — keep
        return true; // city-scoped AND gone from server — safe to purge
      })
      .map(d => d?.id).filter(Boolean);
    if (staleIds.length > 0) {
      await Promise.all(staleIds.map(id => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => {})));
    }
    if (freshDeliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries).catch(() => {});
    }
    invalidateEntityCache('Delivery');

    // ── STEP 4: Unlock UI and push fresh data immediately ─────────────────────
    // CRITICAL: Read ALL deliveries for the selected date from offline DB — not just
    // freshDeliveries (which is city-scoped). Other drivers/stores are already in
    // offline DB from prior syncs and must not disappear from Layout state.
    const [allDeliveriesForDate, allPatients, allAppUsers, allStoresFinal, allCitiesFinal] = await Promise.all([
      offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.CITIES).catch(() => []),
    ]);

    _uiLocked = false;
    console.log('🔓 [FilterSync] Step 4 — UI unlocked, applying fresh data');

    applyFresh({
      deliveries: allDeliveriesForDate,
      patients: allPatients,
      appUsers: allAppUsers,
      stores: allStoresFinal,
      cities: allCitiesFinal,
    });

    // Notify any purged IDs (already correctly computed as city-scoped stale IDs above)
    if (staleIds.length > 0) {
      window.dispatchEvent(new CustomEvent('offlineDeliveriesDeleted', { detail: { deletedIds: staleIds } }));
    }

    // DISABLED: Background full patient sync removed to prevent 429 rate limits
    // Priority sync (step 3c) already loads patients needed for the current date/city view

  } catch (err) {
    console.warn('⚠️ [FilterSync] Sync failed — unlocking UI with offline data', err.message);
    _uiLocked = false;
    const [offlineDeliveries, offlinePatients, offlineAppUsers, offlineStores, offlineCities] = await Promise.all([
      offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.CITIES).catch(() => []),
    ]);
    applyFresh({ deliveries: offlineDeliveries, patients: offlinePatients, appUsers: offlineAppUsers, stores: offlineStores, cities: offlineCities });
  }
};