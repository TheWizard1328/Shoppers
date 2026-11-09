/**
 * recalculateTrackingNumbersLocal
 * Client-side tracking number recalculation — replaces the backend
 * recalculateTrackingNumbers function to eliminate server round-trips,
 * stale data races, and 30s timeouts.
 *
 * Logic mirrors the backend:
 * 1. Pickups (no patient_id, has stop_id) get base TR#s in multiples of 20
 * 2. Linked deliveries (same puid as pickup's stop_id) get sequential TR#s
 * 3. Finished deliveries keep their reserved TR#s
 * 4. Pending/in_transit deliveries sorted by distance from store (closest first),
 *    falling back to stop_order (set by optimizer)
 */

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];
const STARTED_STATUSES = ['in_transit', 'en_route'];

function parseTrackingNumber(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/\d+/);
  if (!match) return null;
  const parsed = parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// Consolidated into geoUtils — identical math, single source of truth.
import { haversineKm } from './geoUtils';

function resolveDeliveryCoords(delivery, patientMap) {
  if (Number.isFinite(Number(delivery.latitude)) && Number.isFinite(Number(delivery.longitude))) {
    return { lat: Number(delivery.latitude), lon: Number(delivery.longitude) };
  }
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    if (patient) {
      const pLat = Number(patient.latitude || patient.lat);
      const pLon = Number(patient.longitude || patient.lng || patient.lon);
      if (Number.isFinite(pLat) && Number.isFinite(pLon)) {
        return { lat: pLat, lon: pLon };
      }
    }
  }
  return null;
}

/**
 * Recalculate tracking numbers locally.
 *
 * @param {Object} params
 * @param {Array}  params.deliveries — all deliveries for the driver/date
 * @param {Array}  params.stores — stores array (for distance sorting)
 * @param {Array}  params.patients — patients array (for coordinate resolution)
 * @returns {Array} updates — [{ id, tracking_number }] for deliveries whose TR# changed
 */
export function recalculateTrackingNumbersLocal({ deliveries, stores, patients }) {
  if (!Array.isArray(deliveries) || deliveries.length === 0) return [];

  const storeMap = new Map((stores || []).filter(Boolean).map((s) => [s.id, s]));
  const patientMap = new Map((patients || []).filter(Boolean).map((p) => [p.id, p]));

  // Identify pickups (no patient_id, has stop_id)
  const pickups = deliveries
    .filter((d) => d && !d.patient_id && d.stop_id)
    .sort((a, b) => {
      const stopDelta = (a.stop_order || 999999) - (b.stop_order || 999999);
      if (stopDelta !== 0) return stopDelta;
      const timeA = String(a.delivery_time_start || '99:99');
      const timeB = String(b.delivery_time_start || '99:99');
      if (timeA !== timeB) return timeA.localeCompare(timeB);
      return String(a.store_id || '').localeCompare(String(b.store_id || ''));
    });

  // PICKUP BASE ALLOCATION — per driver, and never rewrites a base the user set.
  // Owner rule (Nov 9 2026): every driver's pickups are numbered inside their OWN
  // route, so Robert, Sharuk, Anna and Erin each start at 00. A manually typed
  // pickup TR# is kept exactly as entered; only a pickup with no usable number is
  // given the next free base for that driver.
  const updates = [];
  const pickupBaseMap = new Map();
  const pickupsByDriver = new Map();
  for (const pickup of pickups) {
    const driverKey = String(pickup.driver_id || '');
    if (!pickupsByDriver.has(driverKey)) pickupsByDriver.set(driverKey, []);
    pickupsByDriver.get(driverKey).push(pickup);
  }

  for (const list of pickupsByDriver.values()) {
    const usedBases = new Set();
    for (const pickup of list) {
      const existingBase = parseTrackingNumber(pickup.tracking_number);
      if (existingBase !== null && existingBase >= 0) {
        pickupBaseMap.set(pickup.stop_id, existingBase);
        usedBases.add(existingBase);
      }
    }
    for (const pickup of list) {
      if (pickupBaseMap.has(pickup.stop_id)) continue;
      let base = 0;
      while (usedBases.has(base)) base += 20;
      pickupBaseMap.set(pickup.stop_id, base);
      usedBases.add(base);
      updates.push({ id: pickup.id, tracking_number: String(base).padStart(2, '0') });
    }
  }

  for (const pickup of pickups) {
    const pickupBase = pickupBaseMap.get(pickup.stop_id);
    if (pickupBase === null || pickupBase === undefined) continue;

    const store = storeMap.get(pickup.store_id);
    const storeLat = store ? Number(store.latitude) : null;
    const storeLon = store ? Number(store.longitude) : null;
    const hasStoreCoords = Number.isFinite(storeLat) && Number.isFinite(storeLon);

    const linkedDeliveries = deliveries
      .filter((d) => d && d.patient_id && d.puid === pickup.stop_id)
      .sort((a, b) => {
        // Finished deliveries always come first (their TR#s are reserved)
        const aFinished = FINISHED_STATUSES.includes(a.status);
        const bFinished = FINISHED_STATUSES.includes(b.status);
        if (aFinished && !bFinished) return -1;
        if (!aFinished && bFinished) return 1;

        // Started stops (in_transit / en_route) sit directly after the pickup and keep
        // their relative order - a transferred in-transit stop takes base+1 and the
        // pending stops follow it (owner rule Nov 9 2026).
        const aStarted = STARTED_STATUSES.includes(a.status);
        const bStarted = STARTED_STATUSES.includes(b.status);
        if (aStarted && !bStarted) return -1;
        if (!aStarted && bStarted) return 1;
        if (aStarted && bStarted) {
          const ta = parseTrackingNumber(a.tracking_number);
          const tb = parseTrackingNumber(b.tracking_number);
          if (ta !== null && tb !== null && ta !== tb) return ta - tb;
          const so = (a.stop_order || 999999) - (b.stop_order || 999999);
          if (so !== 0) return so;
        }

        // For remaining non-finished stops: sort by distance from store (closest first)
        if (!aFinished && !bFinished && hasStoreCoords) {
          const coordsA = resolveDeliveryCoords(a, patientMap);
          const coordsB = resolveDeliveryCoords(b, patientMap);
          if (coordsA && coordsB) {
            const distA = haversineKm(storeLat, storeLon, coordsA.lat, coordsA.lon);
            const distB = haversineKm(storeLat, storeLon, coordsB.lat, coordsB.lon);
            if (Math.abs(distA - distB) > 0.01) return distA - distB;
          }
        }

        // Fall back to stop_order (set by optimizer for in_transit stops)
        const stopDelta = (a.stop_order || 999999) - (b.stop_order || 999999);
        if (stopDelta !== 0) return stopDelta;
        const etaA = String(a.delivery_time_eta || a.delivery_time_start || '99:99');
        const etaB = String(b.delivery_time_eta || b.delivery_time_start || '99:99');
        if (etaA !== etaB) return etaA.localeCompare(etaB);
        return String(a.patient_name || '').localeCompare(String(b.patient_name || ''));
      });

    const reservedTrackingNumbers = new Set([
      pickupBase,
      ...linkedDeliveries
        .filter((d) => FINISHED_STATUSES.includes(d.status))
        .map((d) => parseTrackingNumber(d.tracking_number))
        .filter((v) => v !== null)
    ]);

    const activeLinkedDeliveries = linkedDeliveries.filter(
      (d) => !FINISHED_STATUSES.includes(d.status)
    );

    let nextTrackingNumber = pickupBase + 1;

    activeLinkedDeliveries.forEach((d) => {
      while (reservedTrackingNumbers.has(nextTrackingNumber)) {
        nextTrackingNumber += 1;
      }

      const expectedTrackingNumber = String(nextTrackingNumber);
      if (d.tracking_number !== expectedTrackingNumber) {
        updates.push({ id: d.id, tracking_number: expectedTrackingNumber.padStart(2, '0') });
      }

      nextTrackingNumber += 1;
    });
  }

  return updates;
}

/**
 * Apply tracking number updates locally — writes to IDB, updates React state,
 * and fires server writes as fire-and-forget (no awaiting, no blocking).
 *
 * @param {Object} params
 * @param {Array}  params.updates — from recalculateTrackingNumbersLocal()
 * @param {Array}  params.allDeliveries — current deliveries array
 * @param {Function} params.updateDeliveriesLocally — state merge function
 * @param {Function} params.updateDeliveryLocal — IDB + server write (from offlineMutations)
 * @returns {Array} updatedDeliveries — the deliveries with new TR#s applied
 */
export async function applyTrackingNumberUpdates({ updates, allDeliveries, updateDeliveriesLocally, updateDeliveryLocal }) {
  if (!updates || updates.length === 0) return [];

  // Build updated delivery objects
  const updateMap = new Map(updates.map((u) => [u.id, u.tracking_number]));
  const updatedDeliveries = (allDeliveries || [])
    .filter(Boolean)
    .map((d) => {
      if (!updateMap.has(d.id)) return null;
      return { ...d, tracking_number: updateMap.get(d.id) };
    })
    .filter(Boolean);

  if (updatedDeliveries.length === 0) return [];

  // Write to offline DB immediately
  try {
    const { offlineDB } = await import('./offlineDatabase');
    await Promise.all(updatedDeliveries.map((d) => offlineDB.save(offlineDB.STORES.DELIVERIES, d).catch(() => {})));
  } catch (_) {}

  // Update React state immediately
  updateDeliveriesLocally?.(updatedDeliveries, false);

  // Fire-and-forget server writes (no blocking, no timeout)
  for (const u of updates) {
    updateDeliveryLocal?.(u.id, { tracking_number: u.tracking_number }, { skipSmartRefresh: true }).catch(() => {});
  }

  return updatedDeliveries;
}

/**
 * Authoritative resequence after a manual save.
 *
 * Owner report (Nov 9 2026): clicking Done on Add To Route or Update on the Edit
 * Delivery form must resequence TR#s for every pending stop on the same
 * Store + Date + Driver by distance from store. The old batch writer numbered
 * stops from its own local counter, so duplicate TR#s survived on the record.
 * This reads the whole date/driver scope back out of IndexedDB and rewrites the
 * numbers from that complete set, which is what the panel and the pickup card see.
 */
export async function resequenceTrackingNumbersForScope({
  deliveryDate,
  driverId,
  stores,
  patients,
  updateDeliveriesLocally,
  updateDeliveryLocal,
  fallbackDeliveries,
}) {
  if (!deliveryDate) return [];
  try {
    const { offlineDB } = await import('./offlineDatabase');
    let all = [];
    try { all = await offlineDB.getAll(offlineDB.STORES.DELIVERIES); } catch (_) { all = []; }
    // IDB can be empty (fresh device) or stall; fall back to the caller's pool.
    if (!all || !all.length) all = Array.isArray(fallbackDeliveries) ? fallbackDeliveries : [];
    const scope = (all || []).filter((d) => d
      && String(d.delivery_date || '') === String(deliveryDate)
      && String(d.driver_id || '') === String(driverId || ''));
    if (!scope.length) return [];
    const updates = recalculateTrackingNumbersLocal({ deliveries: scope, stores, patients });
    if (!updates.length) return [];
    await applyTrackingNumberUpdates({ updates, allDeliveries: scope, updateDeliveriesLocally, updateDeliveryLocal });
    return updates;
  } catch (_) {
    return [];
  }
}

/**
 * Admin resequence (owner rule Nov 9 2026): when an ADMIN updates a pending stop or
 * presses Done, every pending stop is renumbered - all drivers, not just the form's
 * driver - because an admin can move work between routes. Pickups keep their numbers.
 */
export async function resequenceAllScopesForDate({
  deliveryDate, stores, patients, updateDeliveryLocal, companyId = null, fallbackDeliveries = []
}) {
  const dateKey = normalizeDateKey(deliveryDate);
  if (!dateKey) return [];
  const { offlineDB } = await import('./offlineDatabase');
  let all = [];
  try { all = await offlineDB.getAll(offlineDB.STORES.DELIVERIES); } catch (_) { all = []; }
  all = mergeDeliveryPool(all, fallbackDeliveries);
  let scope = (all || []).filter((d) => d && normalizeDateKey(d.delivery_date) === dateKey);
  if (companyId) {
    const sameCompany = scope.filter((d) => !d.company_id || String(d.company_id) === String(companyId));
    if (sameCompany.length) scope = sameCompany;
  }
  if (scope.length === 0) return [];
  const updates = recalculateTrackingNumbersLocal({ deliveries: scope, stores, patients });
  if (updates.length === 0) return [];
  await applyTrackingNumberUpdates({ updates, allDeliveries: scope, updateDeliveryLocal });
  return updates;
}

/**
 * Single decision point for every manual save.
 * - Transfer to ANOTHER driver: TR numbers are left alone (owner rule Nov 9 2026).
 * - Same driver, new date: both the new and the old date scopes are resequenced.
 * - Admin: the whole date is resequenced for every driver.
 */
export async function resequenceAfterSave({
  isAdmin = false, deliveryDate, driverId, prevDeliveryDate = '', prevDriverId = '',
  stores, patients, updateDeliveryLocal, companyId = null, fallbackDeliveries = []
}) {
  try {
    const driverChanged = Boolean(prevDriverId && driverId && String(prevDriverId) !== String(driverId));
    if (driverChanged) return [];
    if (isAdmin) {
      return await resequenceAllScopesForDate({ deliveryDate, stores, patients, updateDeliveryLocal, companyId, fallbackDeliveries });
    }
    const updates = await resequenceTrackingNumbersForScope({ deliveryDate, driverId, stores, patients, updateDeliveryLocal, fallbackDeliveries });
    if (prevDeliveryDate && prevDeliveryDate !== deliveryDate) {
      await resequenceTrackingNumbersForScope({ deliveryDate: prevDeliveryDate, driverId, stores, patients, updateDeliveryLocal, fallbackDeliveries });
    }
    return updates;
  } catch (_) {
    return [];
  }
}
