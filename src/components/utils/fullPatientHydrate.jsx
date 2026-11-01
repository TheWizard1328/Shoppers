/**
 * fullPatientHydrate — keeps EVERY store's patients resident on the device.
 *
 * OWNER DIRECTIVE (Oct 31 2026): drivers were losing patient access for the
 * stores they only cover occasionally. Sharuk runs Kingsway, Bonnie Doon,
 * Sherwood Park Mall and Lakeland Ridge Monday-Friday but does Kingsway and
 * Beverly on weekends, and the Beverly patients kept disappearing because the
 * device only ever held the "regular" stores' patients. Patient data is small
 * (a few thousand rows), so the device now keeps the WHOLE patient mirror for
 * the stores in the user's city and refreshes it once a day.
 *
 * Rules:
 *  - never prunes (additive upserts only) — a patient never disappears because
 *    its store was not "regular" today;
 *  - one hydrate per device per 12 hours (stamp in localStorage), so boot is
 *    not punished with dozens of calls;
 *  - fire-and-forget: callers do not await it on any critical path.
 */
import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';

const STAMP_KEY = 'rxdeliver_patients_full_hydrate_at';
const STAMP_TTL_MS = 12 * 60 * 60 * 1000;
const PAGE_SIZE = 500;

const getStamp = () => {
  try { return Number(localStorage.getItem(STAMP_KEY) || 0) || 0; } catch { return 0; }
};
const setStamp = (ms) => {
  try { localStorage.setItem(STAMP_KEY, String(ms)); } catch { /* storage unavailable */ }
};

export function patientsHydrateIsStale() {
  return Date.now() - getStamp() > STAMP_TTL_MS;
}

/**
 * @param {object} opts
 * @param {string|null} opts.cityId        restrict to one city's stores (null = every store)
 * @param {boolean} opts.force             ignore the 12h stamp
 * @param {(msg:string)=>void} opts.onProgress
 */
export async function hydrateAllPatients({ cityId = null, force = false, onProgress } = {}) {
  if (!force && !patientsHydrateIsStale()) return { skipped: true, saved: 0 };

  let stores = [];
  try {
    stores = (await offlineDB.getAll(offlineDB.STORES.STORES)) || [];
  } catch { stores = []; }
  if (!stores.length) {
    try { stores = await base44.entities.Store.list(); } catch { stores = []; }
  }
  const scoped = stores.filter((s) => s?.id && (!cityId || s?.city_id === cityId));
  if (!scoped.length) return { skipped: true, saved: 0 };

  const saved = [];
  for (const store of scoped) {
    try {
      for (let skip = 0; skip < 4000; skip += PAGE_SIZE) {
        const page = await base44.entities.Patient.filter({ store_id: store.id }, '-updated_date', PAGE_SIZE, skip);
        if (!Array.isArray(page) || page.length === 0) break;
        saved.push(...page);
        if (page.length < PAGE_SIZE) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      // Rate limit or transient failure — keep whatever landed and retry on a
      // later boot (the stamp is only written on a clean pass below).
      console.warn(`[PatientHydrate] store ${store?.name || store?.id} failed:`, err?.message || err);
      if (String(err?.message || '').includes('429')) return { skipped: false, saved: saved.length, partial: true };
    }
  }

  if (saved.length) {
    try {
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, saved);
    } catch (err) {
      console.warn('[PatientHydrate] bulkSave failed:', err?.message || err);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('patientsUpdated', {
        detail: { patients: saved, preserveLocalState: true, triggeredBy: 'fullPatientHydrate' },
      }));
    }
  }
  setStamp(Date.now());
  onProgress?.(`[PatientHydrate] ${saved.length} patients kept resident across ${scoped.length} stores`);
  return { skipped: false, saved: saved.length, stores: scoped.length };
}
