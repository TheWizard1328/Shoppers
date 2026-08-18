// Shared driver-legend stop counting logic.
//
// A stop counts in the Driver Legend when ALL of the following are true:
//   1. It is in a "finished" status (completed / failed / cancelled) — primary gate.
//   2. It is a real delivered stop, i.e. one of:
//        - an actual patient delivery: delivery_id starts with "DID" AND a patient_id is present
//        - an inter-store transfer: delivery_id starts with "ISD" or "ISP"
//
// This whitelist implicitly excludes pickups, cycling markers, and any
// in-progress / pending stops without needing a long exclusion list.

export const FINISHED_LEGEND_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Returns true if a single delivery/marker-stop counts as one legend stop.
 *
 * @param {object} item  - A Delivery record, or a DeliveryMap "stop" object
 *                        (which spreads the Delivery fields + adds `markerType`).
 * @param {object} [opts]
 * @param {boolean} [opts.requireMarkerTypeDelivery=false] - When true (DeliveryMap),
 *        require item.markerType === 'delivery' so pickups/cycling markers are excluded.
 * @returns {boolean}
 */
export function isCountableLegendStop(item, { requireMarkerTypeDelivery = false } = {}) {
  if (!item) return false;
  if (requireMarkerTypeDelivery && item.markerType !== 'delivery') return false;
  // Primary gate: must be in a finished status to count.
  if (!FINISHED_LEGEND_STATUSES.includes(item.status)) return false;
  const did = item.delivery_id || '';
  const isActualDelivery = did.startsWith('DID') && !!item.patient_id;
  const isInterStore = did.startsWith('ISD') || did.startsWith('ISP');
  return isActualDelivery || isInterStore;
}

/**
 * Counts how many of the given items count as legend stops.
 * @param {Array} items
 * @param {object} [opts] - forwarded to {@link isCountableLegendStop}
 * @returns {number}
 */
export function countLegendStops(items, opts = {}) {
  return (items || []).filter((item) => isCountableLegendStop(item, opts)).length;
}

/**
 * Returns true if a delivery is an inter-store transfer (ISD or ISP) by id prefix.
 * @param {object} item
 * @returns {boolean}
 */
const isInterStoreItem = (item) => {
  const did = item?.delivery_id || '';
  return did.startsWith('ISD') || did.startsWith('ISP');
};

/**
 * Returns true for a countable After-Hours pickup.
 * Mirrors the payroll convention (calculateDriverPayroll):
 *   - no patient_id          (it is a store pickup, not a patient delivery)
 *   - NOT an inter-store     (ISD/ISP are paid as inter-store, not after-hours)
 *   - after_hours_pickup === true
 *   - status completed or cancelled
 *
 * @param {object} item
 * @returns {boolean}
 */
export function isAfterHoursPickup(item) {
  if (!item) return false;
  if (item.patient_id) return false;
  if (isInterStoreItem(item)) return false;
  if (item.after_hours_pickup !== true) return false;
  return item.status === 'completed' || item.status === 'cancelled';
}

/**
 * Counts how many of the given items are countable After-Hours pickups.
 * @param {Array} items
 * @returns {number}
 */
export function countAfterHoursPickups(items) {
  return (items || []).filter((item) => isAfterHoursPickup(item)).length;
}