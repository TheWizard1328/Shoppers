import { offlineDB } from '@/components/utils/offlineDatabase';
import { globalFilters } from '@/components/utils/globalFilters';
import { staffStoreIds, staffSeesAllStores } from './patientThreads';

/**
 * PATIENT SEARCH FROM THE LOCAL DATABASE (owner request Nov 3 2026).
 *
 * The staff Patients tab used to resolve its patient list by querying the
 * online Patient table (and, in driver mode, one Patient.get per delivery —
 * up to 120 calls per open). That is what was burning the rate limit.
 *
 * Every device already holds the patients and deliveries it is allowed to see
 * in IndexedDB, so scoped search runs there: no network, no 429s.
 *
 *   admin / owner        → every patient in the local copy
 *   dispatcher           → patients whose store_id is one of their stores
 *   driver               → patients on their route for the selected date,
 *                          only while that route is active
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);
const ACTIVE_DRIVER_STATUSES = new Set(['on_duty', 'on_break', 'online', 'in_transit']);
const MAX_RESULTS = 40;

const digits = (value) => String(value || '').replace(/\D/g, '');

const nameOf = (patient) =>
  patient?.full_name
  || patient?.name
  || [patient?.first_name, patient?.last_name].filter(Boolean).join(' ')
  || '';

const matchesQuery = (patient, rawQuery) => {
  const query = String(rawQuery || '').trim().toLowerCase();
  if (!query) return false;
  const name = nameOf(patient).toLowerCase();
  if (name.includes(query)) return true;
  const queryDigits = digits(query);
  if (queryDigits.length >= 3) {
    return digits(patient?.phone).includes(queryDigits)
      || digits(patient?.phone_number).includes(queryDigits)
      || digits(patient?.cell_phone).includes(queryDigits);
  }
  return false;
};

/** Is this driver currently on a route that has not finished? */
export async function driverRouteIsActive(driverId, dateStr) {
  if (!driverId) return false;
  try {
    const deliveries = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', dateStr);
    const mine = (deliveries || []).filter((d) => String(d?.driver_id || '') === String(driverId));
    if (mine.length === 0) return false;
    return mine.some((d) => !TERMINAL_STATUSES.has(String(d?.status || '').toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * Scoped patient search.
 * @returns {Promise<{patients: Array, scope: string, routeActive: boolean, reason?: string}>}
 */
export async function searchPatientsIdb({ user, query, dateStr, mode, driverId, limit = MAX_RESULTS }) {
  const searchDate = dateStr || globalFilters.getSelectedDate?.() || new Date().toISOString().slice(0, 10);
  const rows = [];
  const push = (patient, extra) => {
    const id = String(patient?.id || extra?.patient_id || '');
    if (!id || rows.some((row) => row.id === id)) return;
    rows.push({ id, full_name: nameOf(patient) || extra?.label || 'Patient', phone: patient?.phone || '', store_id: patient?.store_id || extra?.store_id || '' });
  };

  try {
    // ── DRIVER: only the patients on the route they are running right now ──
    if (mode === 'driver') {
      // Delivery.driver_id carries the AUTH user id (AppUser.user_id), never the
      // AppUser record id — looking a driver up by AppUser.id finds nothing.
      const scopeDriverId = driverId || user?.user_id || user?.id;
      const routeActive = await driverRouteIsActive(scopeDriverId, searchDate);
      if (!routeActive) {
        return { patients: [], scope: 'driver', routeActive: false, reason: 'No active route on this date — patient search opens when you start the route.' };
      }
      const deliveries = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', searchDate);
      const mine = (deliveries || []).filter((d) => String(d?.driver_id || '') === String(scopeDriverId) && d?.patient_id);
      const patientIds = Array.from(new Set(mine.map((d) => String(d.patient_id))));
      const patients = patientIds.length
        ? await offlineDB.getByIds(offlineDB.STORES.PATIENTS, patientIds).catch(() => [])
        : [];
      const byId = new Map((patients || []).map((p) => [String(p.id), p]));
      mine.forEach((delivery) => {
        const patient = byId.get(String(delivery.patient_id));
        if (patient && matchesQuery(patient, query)) {
          push(patient, { patient_id: delivery.patient_id, store_id: delivery.store_id });
        }
      });
      return { patients: rows.slice(0, limit), scope: 'driver', routeActive: true };
    }

    // ── DISPATCHER / ADMIN ──
    const allPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []);
    const storeIds = staffStoreIds(user);
    const scoped = staffSeesAllStores(user) || storeIds.length === 0
      ? allPatients
      : allPatients.filter((p) => storeIds.includes(p?.store_id));
    scoped.filter((p) => matchesQuery(p, query)).slice(0, limit).forEach((p) => push(p));
    return { patients: rows.slice(0, limit), scope: staffSeesAllStores(user) ? 'admin' : 'store', routeActive: true };
  } catch {
    return { patients: [], scope: 'unknown', routeActive: false, reason: 'Patient search is unavailable offline.' };
  }
}
