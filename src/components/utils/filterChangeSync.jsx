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

  try {
    // ── STEP 3a: Determine city store IDs ────────────────────────────────────
    const allStores = await offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []);
    const cityStoreIds = (allStores || [])
      .filter(s => !selectedCityId || s?.city_id === selectedCityId)
      .map(s => s?.id)
      .filter(Boolean);

    // ── STEP 3b: Fetch deliveries for selected date + city ────────────────────
    console.log(`🔄 [FilterSync] Step 3b — fetch deliveries for ${selectedDateStr}`);
    const deliveryFilter = { delivery_date: selectedDateStr };
    if (cityStoreIds.length > 0) deliveryFilter.store_id = { $in: cityStoreIds };
    const freshDeliveries = await Delivery.filter(deliveryFilter, '-updated_date', 5000).catch(() => []);

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

    // ── STEP 3d: Purge stale deliveries for this date, save fresh ones ────────
    console.log('🔄 [FilterSync] Step 3d — purge + save deliveries');
    const offlineForDate = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr).catch(() => []);
    const staleIds = (offlineForDate || [])
      .filter(d => !selectedCityId || cityStoreIds.includes(d?.store_id))
      .map(d => d?.id).filter(Boolean);
    await Promise.all(staleIds.map(id => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => {})));
    if (freshDeliveries.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries).catch(() => {});
    }
    invalidateEntityCache('Delivery');

    // ── STEP 4: Unlock UI and push fresh data immediately ─────────────────────
    const [allPatients, allAppUsers, allStoresFinal, allCitiesFinal] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.CITIES).catch(() => []),
    ]);

    _uiLocked = false;
    console.log('🔓 [FilterSync] Step 4 — UI unlocked, applying fresh data');

    applyFresh({
      deliveries: freshDeliveries,
      patients: allPatients,
      appUsers: allAppUsers,
      stores: allStoresFinal,
      cities: allCitiesFinal,
    });

    // Notify any purged IDs
    if (staleIds.length > 0) {
      const serverIds = new Set((freshDeliveries || []).map(d => d?.id).filter(Boolean));
      const purgedIds = staleIds.filter(id => !serverIds.has(id));
      if (purgedIds.length > 0) {
        window.dispatchEvent(new CustomEvent('offlineDeliveriesDeleted', { detail: { deletedIds: purgedIds } }));
      }
    }

    // ── BACKGROUND: Incremental full patient sync (no DB clear, adds/updates only) ──
    // Runs after UI is already updated — fixes missing patients for search without blocking the view
    setTimeout(async () => {
      try {
        console.log('🔄 [FilterSync] Background — incremental full patient sync (no DB clear)');
        let offset = 0;
        const BATCH_SIZE = 100;
        let totalSynced = 0;
        while (true) {
          const batch = await Patient.filter({ status: 'active' }, '-updated_date', BATCH_SIZE, offset).catch(() => []);
          if (!batch || batch.length === 0) break;
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batch).catch(() => {});
          totalSynced += batch.length;
          offset += BATCH_SIZE;
          if (batch.length < BATCH_SIZE) break;
          await new Promise(r => setTimeout(r, 300));
        }
        invalidateEntityCache('Patient');
        console.log(`✅ [FilterSync] Background patient sync complete — ${totalSynced} active patients merged`);
      } catch (err) {
        console.warn('⚠️ [FilterSync] Background patient sync failed:', err.message);
      }
    }, 2000); // Start 2s after UI is updated

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