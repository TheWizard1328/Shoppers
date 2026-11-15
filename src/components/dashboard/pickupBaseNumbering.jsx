/**
 * Pickup base numbering for "Add to Route".
 *
 * OWNER FIX (Nov 15 2026): the numbering pass in handleBatchSaveDelivery could
 * only see pickups that were ALREADY saved on the route. handleBatchSave ensures
 * the pickup container (ensurePickupForDelivery / ensureDefaultPickupsForDriver)
 * just before saving, but those fresh rows were invisible here — so
 * storePickupTRMap had no base for their store+slot and every newly added stop
 * fell through to TR#99 ("No pickup found for delivery ... using TR#99").
 *
 * This module merges the ensured pickups with the persisted ones so a new stop
 * inherits its pickup's slot and its pickup base (00, 20, 40 ...).
 */

const normalizeDateKey = (value) => String(value || '').slice(0, 10);

export const parsePickupTrackingNumber = (value) => {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/\d+/);
  if (!match) return null;
  const parsed = parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
};

export const getNextPickupTrackingNumber = (pickups = []) => {
  const usedTrackingNumbers = [...new Set(
    pickups
      .map((pickup) => parsePickupTrackingNumber(pickup?.tracking_number))
      .filter((value) => value !== null && value >= 0 && value % 20 === 0)
  )].sort((a, b) => a - b);

  let expectedTrackingNumber = 0;
  for (const trackingNumber of usedTrackingNumbers) {
    if (trackingNumber > expectedTrackingNumber) break;
    if (trackingNumber === expectedTrackingNumber) expectedTrackingNumber += 20;
  }

  return String(expectedTrackingNumber).padStart(2, '0');
};

/**
 * @param {Object} params
 * @param {Array}  params.routePickups     — pickups already on this driver/date
 * @param {Array}  params.ensuredPickups   — pickups created/ensured in this save
 * @param {string} params.driverId
 * @param {string} params.deliveryDate     — yyyy-mm-dd of the group being saved
 * @returns {{ storePickupTRMap: Object, pickupTrackingPool: Array, numberingPickups: Array, ensuredPickupTRUpdates: Array }}
 */
export function resolvePickupBaseNumbering({ routePickups = [], ensuredPickups = [], driverId = '', deliveryDate = '' } = {}) {
  const dateKey = normalizeDateKey(deliveryDate);

  const ensuredPickupsForGroup = (ensuredPickups || [])
    .filter((pickup) => pickup && !pickup.patient_id && (pickup.stop_id || pickup.puid || pickup.id))
    .filter((pickup) => {
      const pickupDriver = pickup.driver_id || driverId;
      const sameDriver = driverId === 'unassigned'
        ? !pickup.driver_id
        : String(pickupDriver) === String(driverId);
      const pickupDate = normalizeDateKey(pickup.delivery_date) || dateKey;
      return sameDriver && pickupDate === dateKey;
    })
    .map((pickup) => ({
      ...pickup,
      // Keep a handle on the caller's record: a base allocated below must land on
      // the actual pickup object that gets persisted, not only on this copy.
      sourceRecord: pickup,
      store_id: pickup.store_id || pickup.pickup_store_id || '',
      stop_id: pickup.stop_id || pickup.puid || pickup.id,
      driver_id: pickup.driver_id || driverId,
      delivery_date: pickup.delivery_date || deliveryDate,
      ampm_deliveries: pickup.ampm_deliveries || 'AM'
    }));

  // Persisted rows win (they hold the saved TR#), then this batch's pickups.
  const seenPickupKeys = new Set();
  const numberingPickups = [];
  for (const pickup of [
    ...(routePickups || []).filter((stop) => stop && !stop.patient_id),
    ...ensuredPickupsForGroup
  ]) {
    const key = String(pickup.stop_id || pickup.puid || pickup.id || '');
    if (!key || seenPickupKeys.has(key)) continue;
    seenPickupKeys.add(key);
    numberingPickups.push(pickup);
  }

  const storePickupTRMap = {};
  for (const pickup of numberingPickups) {
    const mapKey = `${pickup.store_id}-${pickup.ampm_deliveries || 'AM'}`;
    const existingTR = parseInt(pickup.tracking_number, 10);
    if (!isNaN(existingTR) && existingTR >= 0 && storePickupTRMap[mapKey] === undefined) {
      storePickupTRMap[mapKey] = existingTR;
    }
  }

  const pickupTrackingPool = [...numberingPickups];
  const ensuredPickupTRUpdates = [];

  for (const pickup of ensuredPickupsForGroup) {
    const mapKey = `${pickup.store_id}-${pickup.ampm_deliveries || 'AM'}`;
    if (storePickupTRMap[mapKey] !== undefined) continue;
    const base = parsePickupTrackingNumber(getNextPickupTrackingNumber(pickupTrackingPool));
    if (base === null) continue;
    const nextTrackingNumber = String(base).padStart(2, '0');
    storePickupTRMap[mapKey] = base;
    pickup.tracking_number = nextTrackingNumber;
    if (pickup.sourceRecord) pickup.sourceRecord.tracking_number = nextTrackingNumber;
    pickupTrackingPool.push({
      store_id: pickup.store_id,
      ampm_deliveries: pickup.ampm_deliveries,
      stop_id: pickup.stop_id,
      tracking_number: nextTrackingNumber
    });
    if (pickup.id) ensuredPickupTRUpdates.push({ id: pickup.id, updates: { tracking_number: nextTrackingNumber } });
  }

  return { storePickupTRMap, pickupTrackingPool, numberingPickups, ensuredPickupTRUpdates };
}
