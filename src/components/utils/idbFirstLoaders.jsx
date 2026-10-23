import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';
import { getDeliveriesForDateRange } from './dataManagerDeliveryLoader';

/**
 * IDB-FIRST LOADERS (owner directive, Oct 22 2026)
 *
 * "Do it ensuring that all data is IDB read and write first, no preload of
 * 1000's of records any more. With a fall back that if the IDB does not have
 * what we request then pull just what we need from the online DB's to the IDB
 * then update the UI."
 *
 * Boot must never decrypt the whole offline store again (~20k deliveries /
 * 4k patients were being read + decrypted on every boot, which is what blew
 * the 10s bootstrap timeout and left the map on a 10-minute catch-up).
 * These loaders read ONLY the slice the UI needs, straight from IDB; on an
 * IDB miss they pull JUST the missing slice from the server, persist it to
 * IDB, and hand it to the UI.
 */

const toValidRecordIds = (ids = []) =>
  Array.from(new Set((ids || []).filter((id) => typeof id === 'string' && id && !id.startsWith('temp_'))));

/**
 * Boot delivery slice: every delivery for ONE date (all drivers, all cities —
 * the UI filters by driver/city at render time). IDB first; server fallback
 * pulls only that date, saves it to IDB, returns the fresh rows.
 */
export const loadBootDeliverySlice = async (dateStr) => {
  if (!dateStr) return [];
  try {
    const idbRows = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
    if (Array.isArray(idbRows) && idbRows.length > 0) return idbRows;
  } catch (_) { /* fall through to server */ }
  // IDB miss — pull JUST this date from the server, persist to IDB, return fresh.
  const fresh = await getDeliveriesForDateRange(dateStr, dateStr, {}, true).catch(() => []);
  return Array.isArray(fresh) ? fresh : [];
};

/**
 * Boot patient slice: only the patients referenced by the given deliveries.
 * IDB first (getByIds); for referenced ids IDB doesn't have, pull just those
 * patients from the server, persist to IDB, return everything found.
 */
export const loadBootPatientSlice = async (deliveries = [], alreadyLoadedPatients = null) => {
  const loadedById = new Map((alreadyLoadedPatients || []).filter(Boolean).map((p) => [p.id, p]));
  const neededIds = toValidRecordIds((deliveries || []).map((d) => d?.patient_id));
  const missing = neededIds.filter((id) => !loadedById.has(id));
  const result = new Map(loadedById);
  if (missing.length === 0) return Array.from(result.values());

  let idbPatients = [];
  try {
    idbPatients = await offlineDB.getByIds(offlineDB.STORES.PATIENTS, missing);
  } catch (_) { idbPatients = []; }
  (idbPatients || []).filter(Boolean).forEach((p) => { if (!result.has(p.id)) result.set(p.id, p); });

  const stillMissing = missing.filter((id) => !result.has(id));
  if (stillMissing.length > 0) {
    // Server fallback — only the missing referenced patients, in chunks.
    const CHUNK = 200;
    for (let i = 0; i < stillMissing.length; i += CHUNK) {
      const chunk = stillMissing.slice(i, i + CHUNK);
      try {
        const fresh = await base44.entities.Patient.filter({ id: { $in: chunk } }, 'id', 500);
        if (Array.isArray(fresh) && fresh.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, fresh).catch(() => {});
          fresh.forEach((p) => { if (p?.id) result.set(p.id, p); });
        }
      } catch (_) { /* offline — referenced patients unavailable this boot */ }
    }
  }
  return Array.from(result.values());
};

// ── On-demand patient hydration (patient search) ──────────────────────────
// The delivery form's patient search filters the in-memory patient list. Boot
// now seeds only the referenced patients, so the first time a user OPENS the
// form we hydrate the full patient set from IDB (server not involved — the
// patient DB mirror is kept fresh by patientDbPrioritySync + realtime sync).
// One read per app session; never on the boot critical path.
let _patientsHydratedThisSession = false;

export const hydratePatientsFromIdbIfNeeded = async ({ patients, applyPatientChanges }) => {
  if (_patientsHydratedThisSession) return false;
  const currentCount = Array.isArray(patients) ? patients.length : 0;
  if (currentCount >= 500) { _patientsHydratedThisSession = true; return false; } // already full
  try {
    const all = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
    const valid = (all || []).filter((p) => p && p.id && !p.id.startsWith('temp_'));
    if (valid.length > currentCount && typeof applyPatientChanges === 'function') {
      applyPatientChanges({ upserts: valid, deleteIds: [] });
      console.log(`✅ [IdbFirst] Hydrated ${valid.length} patients from IDB on demand (patient search)`);
    }
    _patientsHydratedThisSession = true;
    return true;
  } catch (e) {
    console.warn('[IdbFirst] Patient hydration failed:', e?.message || e);
    return false;
  }
};
