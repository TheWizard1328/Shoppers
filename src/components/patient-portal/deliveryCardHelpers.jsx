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

  // ── PICKUP RESOLUTION (owner report Nov 3 2026) ──────────────────────────
  // Historical cards lost "Picked up at" and the stops count because the ONLY
  // lookup was puid + delivery_date + actual_delivery_time. That breaks for:
  //   • old deliveries with no puid at all,
  //   • transfers — the stop gets a NEW puid on the new route/day, so the pair
  //     no longer matches the pickup that actually collected the parcel.
  // Stages: exact puid+date (with a collected time), then puid+date, then the
  // ONLY pickup of that day at the same store.
  const pickups = Array.isArray(pickupStops) ? pickupStops : [];
  let pickupStop = null;
  if (delivery.puid) {
    pickupStop = pickups.find((d) =>
      d.puid === delivery.puid &&
      d.delivery_date === delivery.delivery_date &&
      d.actual_delivery_time
    ) || pickups.find((d) => d.puid === delivery.puid && d.delivery_date === delivery.delivery_date) || null;
  }
  if (!pickupStop && delivery.delivery_date) {
    const sameDay = pickups.filter((d) =>
      d.delivery_date === delivery.delivery_date &&
      (!delivery.store_id || d.store_id === delivery.store_id)
    );
    if (sameDay.length === 1) pickupStop = sameDay[0];
  }

  // Stops between the pickup and this patient's stop (exclusive of both ends).
  let stopsBetween = null;
  if (pickupStop?.stop_order != null && delivery.stop_order != null) {
    const pickupOrder = Number(pickupStop.stop_order);
    const patientOrder = Number(delivery.stop_order);
    stopsBetween = Math.max(0, patientOrder - pickupOrder - 1);
  }
  // Fallback: the tracking number encodes the position inside its pickup group
  // (bases are multiples of 20 — see recalculateTrackingNumbersLocal), so a
  // historical card still gets its count when the pickup row is long gone.
  if (stopsBetween == null) {
    const tr = Number(delivery.tracking_number);
    if (Number.isFinite(tr) && tr > 0) {
      const base = Math.floor((tr - 1) / 20) * 20;
      const position = tr - base; // 1-based slot inside the pickup group
      if (position > 0) stopsBetween = Math.max(0, position - 1);
    }
  }

  // ── TRANSFER HISTORY (owner request Nov 3 2026) ──────────────────────────
  // A moved stop carries a driver note: "Delivery Transferred from <driver> on
  // <date>" (or "...from <date>" when the driver did not change). Surfacing it
  // tells the patient the parcel changed hands, without a schema field.
  const noteLines = String(delivery.delivery_notes || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('Delivery Transferred'));
  const lastTransfer = noteLines.length > 0 ? noteLines[noteLines.length - 1] : null;
  const transferMatch = lastTransfer ? lastTransfer.match(/^Delivery Transferred from (.+?)(?: on (.+))?$/) : null;
  const transferredFrom = transferMatch && transferMatch[2] ? transferMatch[1] : null;
  const transferredOn = transferMatch ? (transferMatch[2] || transferMatch[1]) : null;

  return {
    delivery,
    storeName,
    pickupTime: pickupStop?.actual_delivery_time || null,
    stopsBetween,
    transferred: !!lastTransfer,
    transferredFrom,
    transferredOn,
  };
}
