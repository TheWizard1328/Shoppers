/**
 * patientDbPrioritySync
 *
 * On app load, checks if the offline patient DB is under-populated (<3000 records).
 * If so, runs a store-prioritised patient sync:
 *   - Dispatcher → their store(s) first, then the rest
 *   - Admin       → selected driver's stores first, then the rest
 *   - Driver      → their own stores first, then the rest
 *
 * Runs non-blocking (fire-and-forget) after the UI is visible.
 */

import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';
import { userHasRole } from './userRoles';
import { globalFilters } from './globalFilters';

const PATIENT_THRESHOLD = 3000;
const STORE_COOLDOWN_MS = 1500; // between stores
const BATCH_SIZE = 200;         // patients per request

/**
 * Get an ordered list of store IDs: priority stores first, then the rest.
 * @param {object} currentUser  - resolved user object
 * @param {object[]} allStores  - all Store records from offline DB
 * @param {object[]} allAppUsers - all AppUser records from offline DB
 */
function getOrderedStoreIds(currentUser, allStores, allAppUsers) {
  const allStoreIds = (allStores || []).filter(s => s?.id).map(s => s.id);

  let priorityStoreIds = [];

  if (userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) {
    // Driver: their own assigned stores first
    priorityStoreIds = currentUser.store_ids?.length
      ? currentUser.store_ids
      : currentUser.store_id
        ? [currentUser.store_id]
        : [];

  } else if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
    // Dispatcher: their stores first
    priorityStoreIds = currentUser.store_ids || [];

  } else if (userHasRole(currentUser, 'admin')) {
    // Admin: selected driver's stores first
    const selectedDriverId = globalFilters.getSelectedDriverId?.() || 'all';
    if (selectedDriverId && selectedDriverId !== 'all') {
      const driverAppUser = (allAppUsers || []).find(au => au?.user_id === selectedDriverId);
      priorityStoreIds = driverAppUser?.store_ids?.length
        ? driverAppUser.store_ids
        : driverAppUser?.store_id
          ? [driverAppUser.store_id]
          : [];
    }
  }

  // Build ordered list: priority first (filtered to valid stores), then the rest
  const prioritySet = new Set(priorityStoreIds);
  const orderedIds = [
    ...priorityStoreIds.filter(id => allStoreIds.includes(id)),
    ...allStoreIds.filter(id => !prioritySet.has(id)),
  ];

  return orderedIds;
}

/**
 * Run a non-blocking priority patient sync if offline DB is below threshold.
 * Safe to call multiple times — guards against concurrent runs.
 */
let _syncRunning = false;

export async function runPatientDbPrioritySync(currentUser) {
  if (_syncRunning) return;
  if (!currentUser) return;

  try {
    const allPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []);
    const count = (allPatients || []).filter(p => p?.id && !p.id.startsWith('temp_')).length;

    if (count >= PATIENT_THRESHOLD) {
      console.log(`✅ [PatientPrioritySync] Offline patient DB has ${count} records — no sync needed`);
      return;
    }

    console.log(`⚠️ [PatientPrioritySync] Only ${count} patients offline (threshold: ${PATIENT_THRESHOLD}). Starting priority sync...`);
    _syncRunning = true;

    const [allStores, allAppUsers] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
      offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
    ]);

    const orderedStoreIds = getOrderedStoreIds(currentUser, allStores, allAppUsers);

    if (orderedStoreIds.length === 0) {
      console.warn('[PatientPrioritySync] No stores found to sync');
      return;
    }

    let totalSynced = 0;

    for (let i = 0; i < orderedStoreIds.length; i++) {
      const storeId = orderedStoreIds[i];
      if (!storeId) continue;

      try {
        let offset = 0;
        while (true) {
          const batch = await base44.entities.Patient.filter(
            { store_id: storeId },
            '-updated_date',
            BATCH_SIZE,
            offset
          );
          if (!batch || batch.length === 0) break;
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batch);
          totalSynced += batch.length;
          if (batch.length < BATCH_SIZE) break;
          offset += BATCH_SIZE;
          await new Promise(r => setTimeout(r, 300));
        }

        const storeName = allStores.find(s => s?.id === storeId)?.name || storeId;
        console.log(`[PatientPrioritySync] ✅ Store "${storeName}" synced (total so far: ${totalSynced})`);

        // Wait between stores to avoid rate limits
        if (i < orderedStoreIds.length - 1) {
          await new Promise(r => setTimeout(r, STORE_COOLDOWN_MS));
        }
      } catch (storeErr) {
        if (storeErr?.response?.status === 429 || storeErr?.message?.includes('429')) {
          console.warn('[PatientPrioritySync] Rate limited — stopping early');
          break;
        }
        console.warn(`[PatientPrioritySync] Store ${storeId} failed:`, storeErr?.message);
      }
    }

    console.log(`✅ [PatientPrioritySync] Complete — ${totalSynced} patients synced to offline DB`);

    // Notify the app that fresh patient data is available
    window.dispatchEvent(new CustomEvent('offlinePatientsRefreshed', { detail: { count: totalSynced } }));

  } catch (err) {
    console.warn('[PatientPrioritySync] Error:', err?.message);
  } finally {
    _syncRunning = false;
  }
}