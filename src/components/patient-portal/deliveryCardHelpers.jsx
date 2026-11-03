/**
 * Shared props builder for PatientDeliveryCard.
 *
 * The portal sidebar and the floating "today" card (owner request Nov 2 2026)
 * must show the SAME information, including the pickup ("left the pharmacy")
 * time and how many stops are between the pickup and this patient. Keeping the
 * derivation in one place stops the two surfaces drifting apart.
 */
export function buildDeliveryCardProps(delivery, { pickupStops, storeMap } = {}) {
  if (!delivery) return null;

  const storeName = (storeMap || {})[delivery.store_id] || null;

  const pickupStop = delivery.puid
    ? (pickupStops || []).find((d) =>
        d.puid === delivery.puid &&
        d.delivery_date === delivery.delivery_date &&
        d.actual_delivery_time
      )
    : null;

  // Stops between the pickup and this patient's stop (exclusive of both ends).
  let stopsBetween = null;
  if (pickupStop?.stop_order != null && delivery.stop_order != null) {
    const pickupOrder = Number(pickupStop.stop_order);
    const patientOrder = Number(delivery.stop_order);
    stopsBetween = Math.max(0, patientOrder - pickupOrder - 1);
  }

  return {
    delivery,
    storeName,
    pickupTime: pickupStop?.actual_delivery_time || null,
    stopsBetween,
  };
}
