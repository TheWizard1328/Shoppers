/**
 * Shared props builder for PatientDeliveryCard.
 *
 * The portal sidebar and the floating "today" card (owner request Nov 2 2026)
 * must show the SAME information, including the pickup ("left the pharmacy")
 * time and how many stops are between the pickup and this patient. Keeping the
 * derivation in one place stops the two surfaces drifting apart.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

const timeOf = (record) => {
  const raw = record?.actual_delivery_time;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
};

const dayKey = (record) => String(record?.delivery_date || '').slice(0, 10);

/**
 * Shared props builder for PatientDeliveryCard.
 *
 * The portal sidebar and the floating "today" card (owner request Nov 2 2026)
 * must show the SAME information, including the pickup ("left the pharmacy")
 * time and how many stops are between the pickup and this patient. Keeping the
 * derivation in one place stops the two surfaces drifting apart.
 *
 * TRANSFERRED DELIVERIES (owner request Nov 3 2026): a move re-points the
 * delivery at the target route's pickup, so the pickup that PHYSICALLY collected
 * the parcel can belong to a different driver on an earlier date while still
 * carrying the same puid. The pickup is therefore matched across dates (up to
 * three days back, plus a wider fallback) and both drivers are reported: who
 * collected it and who delivered it.
 */
export function buildDeliveryCardProps(delivery, { pickupStops, puidGroups, storeMap, allDeliveries } = {}) {
  if (!delivery) return null;

  const storeName = (storeMap || {})[delivery.store_id] || null;

  const group = (puidGroups && delivery.puid && puidGroups[delivery.puid]) || [];
  // Records sharing this puid: the pickup stop(s) have no patient.
  const groupPickups = group.filter((r) => r && !r.patient_id && !r._interstore_source_id);
  const candidatePickups = [...(Array.isArray(pickupStops) ? pickupStops : []), ...groupPickups]
    .filter((rec) => rec && !rec.patient_id && !rec._interstore_source_id);

  const deliveryDay = dayKey(delivery);
  const deliveryTime = timeOf(delivery);

  // ── PICKUP RESOLUTION, best match first ──────────────────────────────────
  let pickupStop = null;
  // 1. Same day, same store, actually collected — the parcel left the pharmacy
  //    on the day it was delivered.
  pickupStop = candidatePickups.find((rec) =>
    rec.puid === delivery.puid &&
    dayKey(rec) === deliveryDay &&
    (!delivery.store_id || rec.store_id === delivery.store_id) &&
    timeOf(rec) != null
  ) || null;
  // 2. Same puid, earlier date (TRANSFER): the original pickup that collected it.
  //    Owner limit: look 3 days back first, then widen to any earlier pickup.
  if (!pickupStop && delivery.puid) {
    const samePuid = candidatePickups.filter((rec) => rec.puid === delivery.puid && timeOf(rec) != null);
    const cutoff = deliveryTime != null ? deliveryTime - 3 * DAY_MS : null;
    const withinThreeDays = cutoff != null
      ? samePuid.filter((rec) => { const t = timeOf(rec); return t != null && t >= cutoff && t <= deliveryTime + DAY_MS; })
      : samePuid;
    const pool = (withinThreeDays.length > 0 ? withinThreeDays : samePuid)
      .filter((rec) => dayKey(rec) <= deliveryDay)
      .sort((a, b) => timeOf(b) - timeOf(a)); // closest before the delivery
    pickupStop = pool[0] || null;
  }
  // 3. Same day, same store, only one pickup that day.
  if (!pickupStop && deliveryDay) {
    const sameDay = candidatePickups.filter((rec) =>
      dayKey(rec) === deliveryDay && (!delivery.store_id || rec.store_id === delivery.store_id)
    );
    if (sameDay.length === 1) pickupStop = sameDay[0];
  }

  const pickupTime = pickupStop?.actual_delivery_time || null;
  const pickupDriverName = pickupStop?.driver_name || null;
  const deliveredBy = delivery.driver_name || null;
  const pickupByOtherDriver = !!(pickupDriverName && deliveredBy && pickupDriverName !== deliveredBy);

  // ── STOPS BETWEEN PICKUP AND PATIENT ─────────────────────────────────────
  let stopsBetween = null;
  const sameRoute = pickupStop && pickupStop.driver_id && delivery.driver_id
    && pickupStop.driver_id === delivery.driver_id
    && dayKey(pickupStop) === deliveryDay;
  if (sameRoute && pickupStop.stop_order != null && delivery.stop_order != null) {
    // Same route: exact, from the route order.
    stopsBetween = Math.max(0, Number(delivery.stop_order) - Number(pickupStop.stop_order) - 1);
  } else if (pickupTime && deliveryTime) {
    // Transferred: count the DELIVERING driver's stops finished between the real
    // pickup and this delivery (owner rule Nov 3 2026 — use actual times).
    const pool = (group.length > 0 ? group : (Array.isArray(allDeliveries) ? allDeliveries : []))
      .filter((rec) => rec && rec.patient_id
        && rec.id !== delivery.id
        && (!delivery.driver_id || rec.driver_id === delivery.driver_id));
    if (pool.length > 0) {
      const pickupT = pickupTime ? new Date(pickupTime).getTime() : null;
      if (Number.isFinite(pickupT)) {
        const counted = pool.filter((rec) => {
          const t = timeOf(rec);
          if (t == null) return false;
          return t >= pickupT && t <= deliveryTime;
        });
        stopsBetween = counted.length;
      }
    }
  }
  // Last resort: the tracking number encodes the slot inside its pickup group
  // (bases are multiples of 20 — see recalculateTrackingNumbersLocal).
  if (stopsBetween == null) {
    const tr = Number(delivery.tracking_number);
    if (Number.isFinite(tr) && tr > 0) {
      const base = Math.floor((tr - 1) / 20) * 20;
      const position = tr - base;
      if (position > 0) stopsBetween = Math.max(0, position - 1);
    }
  }

  // ── TRANSFER HISTORY ─────────────────────────────────────────────────────
  // A moved stop carries a driver note: "Delivery Transferred from <driver> on
  // <date>" (or "...from <date>" when the driver did not change).
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
    pickupTime,
    stopsBetween,
    pickupDriverName,
    deliveredBy,
    pickupByOtherDriver,
    transferred: !!lastTransfer || pickupByOtherDriver,
    transferredFrom,
    transferredOn,
  };
}
