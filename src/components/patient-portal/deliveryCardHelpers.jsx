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
export function buildDeliveryCardProps(delivery, { pickupStops, puidGroups, storeMap, allDeliveries, routeDeliveries } = {}) {
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
  // 0. NOT YET COLLECTED (owner report Nov 26 2026, Marianne Samchuck): every
  //    rule below demanded actual_delivery_time, so a parcel whose pickup was
  //    still en route resolved NO pickup at all — the card then fell back to the
  //    whole active route (7) and the marker to the tracking number (6). A
  //    same-puid, same-day, same-store pickup that is still active IS her pickup.
  pickupStop = candidatePickups.find((rec) =>
    rec.puid === delivery.puid &&
    dayKey(rec) === deliveryDay &&
    (!delivery.store_id || rec.store_id === delivery.store_id) &&
    !['completed', 'failed', 'cancelled'].includes(String(rec.status || '').toLowerCase())
  ) || null;
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
  // PENDING PICKUP ETA (owner request Nov 4 2026): until the parcel is actually
  // collected there is no delivery ETA to show, so the card reports when the
  // PICKUP is due — the pickup stop's own ETA, falling back to the store's
  // pickup window.
  const pickupEta = pickupStop?.delivery_time_eta || null;
  const pickupWindowStart = pickupStop?.delivery_time_start || null;
  const pickupWindowEnd = pickupStop?.delivery_time_end || null;
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
    // OWNER REPORT (Nov 25 2026): a delivery transferred back to today was
    // re-pointed at a pickup collected at 10:20 AM (stop 1), so the gap to her
    // stop 40 read "38 stops away" although every stop in between was already
    // finished and she was effectively next. Standing rule: never count finished
    // stops. While IN TRANSIT the number is the stops between pickup and her
    // stop that are still UNFINISHED; the order gap is only the fallback when
    // the route is not available to inspect.
    const liveStatus = String(delivery.status || '').toLowerCase();
    if (liveStatus === 'in_transit' || liveStatus === 'en_route') {
      // The driver's whole route (when the portal has it) beats the puid group,
      // which only holds the stops that share her pickup.
      const routeSource = Array.isArray(routeDeliveries) && routeDeliveries.length > 0
        ? routeDeliveries
        : (group.length > 0 ? group : (Array.isArray(allDeliveries) ? allDeliveries : []));
      const routePool = routeSource
        .filter((rec) => rec && rec.id !== delivery.id && rec.driver_id === delivery.driver_id && dayKey(rec) === deliveryDay);
      if (routePool.length > 0) {
        const lo = Number(pickupStop.stop_order);
        const hi = Number(delivery.stop_order);
        stopsBetween = routePool.filter((rec) => {
          const order = Number(rec.stop_order);
          if (!Number.isFinite(order) || order <= lo || order >= hi) return false;
          return !['completed', 'failed', 'cancelled'].includes(String(rec.status || '').toLowerCase());
        }).length;
      }
    }
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

  // ── STOPS TILL PICKUP (owner rule Nov 25 2026) ───────────────────────────
  // While the delivery is PENDING the card must count the stops ahead of the
  // PICKUP ("6 stops till pickup"), not the stops after it. Once it is in
  // transit the same pill switches to "6 stops away".
  let stopsTillPickup = null;
  if (pickupStop) {
    const pickupOrder = Number(pickupStop.stop_order);
    const pool = (group.length > 0 ? group : (Array.isArray(allDeliveries) ? allDeliveries : []))
      .filter((rec) => rec && rec.id !== pickupStop.id
        && (!pickupStop.driver_id || rec.driver_id === pickupStop.driver_id));
    if (Number.isFinite(pickupOrder) && pool.length > 0) {
      stopsTillPickup = pool.filter((rec) => {
        const order = Number(rec.stop_order);
        if (!Number.isFinite(order) || order >= pickupOrder) return false;
        // A cycling/route marker (no patient, no store, no puid) is not a stop
        // the patient is waiting behind.
        if (!rec.patient_id && !rec.store_id && !rec.puid) return false;
        return !['completed', 'failed', 'cancelled'].includes(String(rec.status || '').toLowerCase());
      }).length;
    }
    // NO blind fallback: pickupOrder - 1 counts FINISHED stops too, which is how
    // the card read 6 while the marker (real count) read 3. When there is no
    // route pool the pill falls back to remainingStops instead of guessing.
  }

  // OWNER REPORT (Nov 26 2026, Marianne Samchuck): her PICKUP was the driver's
  // next stop, yet the today card read "5 stops till pickup" and the home-marker
  // badge read 6. The count is stop_order based, so a reordered pickup still
  // reported its old gap. The pickup being next wins outright, the same rule the
  // delivery already has: zero stops till pickup, so the card reads "Pickup is
  // next" and the marker draws no count badge.
  if (pickupStop) {
    const routeAll = (Array.isArray(routeDeliveries) && routeDeliveries.length > 0
      ? routeDeliveries
      : (Array.isArray(allDeliveries) ? allDeliveries : []))
      .filter((rec) => rec && rec.driver_id === pickupStop.driver_id
        && dayKey(rec) === dayKey(pickupStop)
        && !['completed', 'failed', 'cancelled'].includes(String(rec.status || '').toLowerCase()));
    const nextOnRoute = routeAll.find((rec) => rec && rec.isNextDelivery === true) || null;
    const pickupIsNext = pickupStop.isNextDelivery === true
      || (nextOnRoute ? nextOnRoute.id === pickupStop.id : false);
    if (pickupIsNext) stopsTillPickup = 0;
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

  // OWNER REPORT (Nov 26 2026): "Lothar's home marker and the today drop-down
  // show 5 stops before his delivery yet everywhere else shows he's next." The
  // count was derived from stop_order alone, so a stop that had been reordered
  // (order 5) but is the route's NEXT stop still reported the old gap. Being
  // next wins outright: zero stops before her, on the card and on the marker.
  if (delivery?.isNextDelivery === true) {
    stopsBetween = 0;
    stopsTillPickup = 0;
  } else if (['in_transit', 'en_route'].includes(String(delivery?.status || '').toLowerCase())
    && Number.isFinite(stopsBetween) && Number(stopsBetween) > 0) {
    // An in-transit stop with nothing unfinished ahead of it is next in effect.
    const aheadPool = (Array.isArray(routeDeliveries) && routeDeliveries.length > 0
      ? routeDeliveries
      : (Array.isArray(allDeliveries) ? allDeliveries : []))
      .filter((rec) => rec && rec.id !== delivery.id
        && rec.driver_id === delivery.driver_id && dayKey(rec) === deliveryDay
        && !['completed', 'failed', 'cancelled'].includes(String(rec.status || '').toLowerCase()));
    if (aheadPool.length === 0) stopsBetween = 0;
  }

  return {
    delivery,
    storeName,
    pickupTime,
    pickupEta,
    pickupWindowStart,
    pickupWindowEnd,
    stopsBetween,
    stopsTillPickup,
    pickupDriverName,
    deliveredBy,
    pickupByOtherDriver,
    transferred: !!lastTransfer || pickupByOtherDriver,
    transferredFrom,
    transferredOn,
  };
}
