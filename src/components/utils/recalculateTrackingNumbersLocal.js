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

function parseTrackingNumber(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/\d+/);
  if (!match) return null;
  const parsed = parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

  const getNextPickupBase = (usedBases = new Set()) => {
    let expected = 0;
    while (usedBases.has(expected)) {
      expected += 20;
    }
    return expected;
  };

  const updates = [];
  const pickupBaseMap = new Map();
  const usedPickupBases = new Set();

  for (const pickup of pickups) {
    let pickupBase = parseTrackingNumber(pickup.tracking_number);
    if (pickupBase === null || pickupBase < 0 || pickupBase % 20 !== 0 || usedPickupBases.has(pickupBase)) {
      pickupBase = getNextPickupBase(usedPickupBases);
      updates.push({ id: pickup.id, tracking_number: String(pickupBase).padStart(2, '0') });
    }
    pickupBaseMap.set(pickup.stop_id, pickupBase);
    usedPickupBases.add(pickupBase);
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

        // For non-finished stops: sort by distance from store (closest first)
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
