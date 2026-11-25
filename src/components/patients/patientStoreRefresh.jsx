import { base44 } from '@/api/base44Client';

/**
 * PER-STORE PATIENT REFRESH (owner spec Nov 24 2026)
 *
 * Store Overview's refresh must pull every patient for the selected city + company,
 * one store at a time, and report progress per store so the card can draw a thin bar
 * under its phone number. Patient Database's refresh pulls only the selected store.
 *
 * Why store-by-store instead of one big `$in` query: the bar needs a per-store number,
 * and a single 40-store paged read on a tablet was what produced the IDB timeout storms
 * (see device notes). Paging is 500 rows at a time, capped so a runaway store cannot
 * spin forever.
 */

const PAGE_SIZE = 500;
const MAX_PAGES = 40; // 20,000 patients per store is far past any real store

/**
 * @param {Object}   opts
 * @param {string[]} opts.storeIds        stores to refresh (in order)
 * @param {Object}   opts.expectedCounts  optional { storeId: patientCount } used only for the bar
 * @param {Function} opts.onProgress      ({ storeId, loaded, done }) => void
 * @param {Function} opts.onStoreDone     ({ storeId, loaded }) => void
 * @returns {Promise<{ byStore: Object, total: number, patients: Object[] }>}
 */
export async function refreshPatientsForStores({ storeIds = [], expectedCounts = {}, onProgress, onStoreDone } = {}) {
  const ids = [...new Set((storeIds || []).filter(Boolean))];
  const byStore = {};
  const patients = [];

  if (ids.length === 0) return { byStore, total: 0, patients };

  let offlineDB = null;
  try {
    ({ offlineDB } = await import('../utils/offlineDatabase'));
  } catch (_) { /* offline DB is best-effort; the UI update still runs from memory */ }

  for (const storeId of ids) {
    let loaded = 0;
    let storeRows = [];
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const rows = await base44.entities.Patient.filter(
          { store_id: storeId },
          '-updated_date',
          PAGE_SIZE,
          page * PAGE_SIZE
        ).catch(() => null);
        if (!Array.isArray(rows) || rows.length === 0) break;
        // Undecryptable wrappers must never be written back over good records.
        const usable = rows.filter((row) => row && row.id && row.__decryptFailed !== true);
        storeRows = storeRows.concat(usable);
        loaded = storeRows.length;
        try { onProgress?.({ storeId, loaded, expected: expectedCounts?.[storeId] || 0, done: false }); } catch (_) {}
        if (rows.length < PAGE_SIZE) break;
      }

      if (offlineDB && storeRows.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, storeRows).catch(() => {});
      }
      patients.push(...storeRows);
    } catch (error) {
      console.warn(`[patientStoreRefresh] store ${storeId} failed:`, error?.message || error);
    }
    byStore[storeId] = loaded;
    try { onProgress?.({ storeId, loaded, expected: expectedCounts?.[storeId] || 0, done: true }); } catch (_) {}
    try { onStoreDone?.({ storeId, loaded }); } catch (_) {}
  }

  const total = Object.values(byStore).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return { byStore, total, patients };
}

/**
 * Merge freshly pulled patients into the in-memory list and tell the rest of the app
 * (context, dashboards) that patients changed — same event the rest of the app already
 * listens for, so nothing new has to be wired.
 */
export function publishRefreshedPatients(patients = [], deletedIds = []) {
  const valid = (patients || []).filter((p) => p && p.id && p.__decryptFailed !== true);
  if (typeof window === 'undefined') return;
  if (valid.length === 0 && (deletedIds || []).length === 0) return;
  window.dispatchEvent(new CustomEvent('patientsUpdated', {
    detail: { patients: valid, deletedIds: deletedIds || [], fullReplacement: false, fromStoreRefresh: true },
  }));
}
