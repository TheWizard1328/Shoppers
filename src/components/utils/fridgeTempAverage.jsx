/**
 * Computes the average fridge temperature for a specific delivery
 * based on the precise time window the fridge item was in transit.
 *
 * Thermal window rules:
 *
 * SCENARIO 1 — ISP → ISD (Inter-Store Pickup to Drop-off, same destination store):
 *   start = actual_delivery_time of this ISP stop (item leaves source store custody)
 *   end   = actual_delivery_time of the matching ISD stop (same puid or dest store identity)
 *
 * SCENARIO 2 — ISP → Store Return (ISP returned back to a store pickup stop):
 *   start = actual_delivery_time of this ISP stop
 *   end   = actual_delivery_time of the next store-pickup stop for the same store identity
 *            (same driver, same date, occurs AFTER the ISP stop by stop_order or timestamp)
 *
 * SCENARIO 3 — Patient Fridge Delivery (completed):
 *   start = actual_delivery_time of the originating store pickup (same puid, no patient_id)
 *   end   = actual_delivery_time of this delivery (when completed)
 *
 * SCENARIO 4 — Patient Fridge Delivery (failed → retry or store return):
 *   start = actual_delivery_time of the originating store pickup (same puid, no patient_id)
 *   end   = actual_delivery_time of the subsequent completed delivery OR matched store return stop
 *           (window stays open / uses Date.now() until resolution is found)
 *
 * @param {Object} delivery     - the fridge delivery we want the average for
 * @param {Array}  allDeliveries - all deliveries for the same date/driver
 * @param {Array}  tempReadings  - flat array of {timestamp, temperature_celsius} for the driver that day
 * @returns {number|null} average °C within the window, or null if not computable
 */
export function computeFridgeAvgTemp(delivery, allDeliveries, tempReadings) {
  if (!delivery?.fridge_item || !Array.isArray(tempReadings) || tempReadings.length === 0) return null;

  const toMs = (ts) => {
    if (!ts) return null;
    const clean = String(ts).replace('Z', '').replace(/[+-]\d{2}:?\d{2}$/, '');
    const d = new Date(clean);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  };

  const sameRoute = (d) =>
    d && d.id !== delivery.id &&
    d.driver_id === delivery.driver_id &&
    d.delivery_date === delivery.delivery_date;

  const deliveryId = String(delivery.delivery_id || '').toUpperCase();
  const isISP = deliveryId.startsWith('ISP-');

  let windowStartMs = null;
  let windowEndMs = null;

  if (isISP) {
    // ── SCENARIO 1 & 2: ISP thermal clock starts at ISP stop completion only ──
    // The item is still in source-store custody until this moment.
    windowStartMs = toMs(delivery.actual_delivery_time);
    if (!windowStartMs) return null; // ISP not yet completed — no window yet

    const ispStopOrder = delivery.stop_order ?? Infinity;
    const ispCompletionMs = windowStartMs;
    const destId = delivery._interstore_dest_id;
    const destName = delivery._interstore_dest_name;

    // SCENARIO 1: Find the matching ISD drop-off stop (occurs after this ISP)
    const isdStop = (allDeliveries || []).find((d) => {
      if (!sameRoute(d)) return false;
      const dId = String(d.delivery_id || '').toUpperCase();
      if (!dId.startsWith('ISD-')) return false;
      // Must occur after the ISP stop
      const dOrder = d.stop_order ?? Infinity;
      if (dOrder <= ispStopOrder) return false;
      // Match by dest store identity
      if (destId && d._interstore_source_id === destId) return true;
      if (destName && d._interstore_source_name === destName) return true;
      if (delivery.puid && d.puid === delivery.puid) return true;
      return false;
    });

    if (isdStop?.actual_delivery_time) {
      windowEndMs = toMs(isdStop.actual_delivery_time);
    }

    if (!windowEndMs) {
      // SCENARIO 2: Find a store pickup stop for the same store, occurring AFTER this ISP
      // A store pickup has no patient_id and its store_id matches the ISP destination
      const returnPickup = (allDeliveries || [])
        .filter((d) => {
          if (!sameRoute(d)) return false;
          if (d.patient_id) return false; // must be a store pickup (no patient)
          const dOrder = d.stop_order ?? Infinity;
          if (dOrder <= ispStopOrder) return false;
          // The return pickup's store_id should match the ISP's destination store
          if (destId && d.store_id === destId) return true;
          if (destName && d._interstore_dest_name === destName) return true;
          if (delivery.puid && d.puid === delivery.puid) return true;
          return false;
        })
        .filter((d) => d.actual_delivery_time)
        .sort((a, b) => (a.stop_order ?? 999) - (b.stop_order ?? 999))[0];

      if (returnPickup?.actual_delivery_time) {
        windowEndMs = toMs(returnPickup.actual_delivery_time);
      }
    }

    // Still in transit — keep window open to now
    if (!windowEndMs) windowEndMs = Date.now();

  } else {
    // ── SCENARIO 3 & 4: Patient fridge delivery ──
    // Window start: originating store pickup completion (same puid, same driver, no patient_id)
    if (delivery.puid) {
      const pickupStop = (allDeliveries || [])
        .filter((d) =>
          sameRoute(d) &&
          d.puid === delivery.puid &&
          !d.patient_id &&
          d.actual_delivery_time
        )
        .sort((a, b) => (a.stop_order ?? 999) - (b.stop_order ?? 999))[0];

      if (pickupStop) windowStartMs = toMs(pickupStop.actual_delivery_time);
    }

    // Fallback start: this delivery's own arrival_time
    if (!windowStartMs) windowStartMs = toMs(delivery.arrival_time);
    if (!windowStartMs) return null;

    if (delivery.status === 'completed' && delivery.actual_delivery_time) {
      // SCENARIO 3: Successful delivery — window ends at completion
      windowEndMs = toMs(delivery.actual_delivery_time);
    } else if (delivery.status === 'failed') {
      // SCENARIO 4: Failed — look for a subsequent resolution for this patient:
      // either a retry delivery (completed) or a store return stop
      const patientId = delivery.patient_id;
      const failedMs = toMs(delivery.actual_delivery_time) || toMs(delivery.arrival_time) || 0;

      const resolution = (allDeliveries || [])
        .filter((d) => {
          if (!sameRoute(d)) return false;
          // A retry for the same patient that was completed
          if (d.patient_id === patientId && d.status === 'completed' && d.actual_delivery_time) {
            return toMs(d.actual_delivery_time) > failedMs;
          }
          // A store return stop matching puid (no patient_id, status returned/completed)
          if (!d.patient_id && delivery.puid && d.puid === delivery.puid &&
              (d.status === 'completed' || d.status === 'returned') && d.actual_delivery_time) {
            return toMs(d.actual_delivery_time) > failedMs;
          }
          return false;
        })
        .sort((a, b) => toMs(a.actual_delivery_time) - toMs(b.actual_delivery_time))[0];

      if (resolution?.actual_delivery_time) {
        windowEndMs = toMs(resolution.actual_delivery_time);
      }
    }

    // Window still open (in progress or failed with no resolution yet) — use now
    if (!windowEndMs) windowEndMs = Date.now();
  }

  if (!windowStartMs) return null;

  // Filter readings strictly within [windowStartMs, windowEndMs]
  const inRange = tempReadings.filter((r) => {
    const ms = toMs(r.timestamp);
    return ms != null && ms >= windowStartMs && ms <= windowEndMs;
  });

  if (inRange.length === 0) return null;

  const sum = inRange.reduce((acc, r) => acc + r.temperature_celsius, 0);
  return sum / inRange.length;
}