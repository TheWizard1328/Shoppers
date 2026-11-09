/**
 * acceptAllBatchPipeline
 * Handles the "Accept All" batch operation for a pickup card:
 * transitions all pending deliveries for the same store/driver/date to in_transit,
 * persists them offline, and returns data for downstream steps (COD sync, optimization).
 */
import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';

const _parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const [h, m] = timeStr.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
};

export async function runAcceptAllBatchPipeline({
  triggerDelivery,
  allDeliveries,
  stores,
  patients,
  currentLocalTime,
  deliveryTimeStart,
  updateDeliveriesLocally,
  localDeviceTodayStr
}) {
  const { driver_id: driverId, delivery_date: deliveryDate, store_id: storeId, puid, stop_id: stopId } = triggerDelivery;

  // Find all pending deliveries for this driver/date/store
  const scopedPendingDeliveries = allDeliveries.filter(
    (item) =>
      item &&
      item.driver_id === driverId &&
      item.delivery_date === deliveryDate &&
      item.status === 'pending' &&
      item.store_id === storeId
  );

  if (scopedPendingDeliveries.length === 0) {
    return { stagedChangedDeliveries: [], finalOfflineUpdates: [], codBatch: [], optimizeData: null };
  }

  // Build patient lookup map for time window resolution
  const patientMap = new Map((patients || []).filter(Boolean).map(p => [p.id, p]));

  // Pre-compute now and now+5 in minutes for time comparisons
  const nowMinutes = _parseTimeToMinutes(currentLocalTime);

  // Build updated delivery objects
  const updatedDeliveries = scopedPendingDeliveries.map((delivery, idx) => {
    // ETA: staggered 5 min apart starting from now+5
    const baseMinutes = (() => {
      const [h, m] = (deliveryTimeStart || '09:00').split(':').map(Number);
      return h * 60 + m + (idx * 5);
    })();
    const etaHours = Math.floor((baseMinutes % 1440) / 60);
    const etaMins = baseMinutes % 60;
    const eta = `${String(etaHours).padStart(2, '0')}:${String(etaMins).padStart(2, '0')}`;

    const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;

    // ── delivery_time_start resolution (owner rule, restated 6th time Sep 30 2026) ──
    // Patient time windows are ONLY creation-time defaults. Once the delivery
    // exists, THE DELIVERY'S OWN WINDOWS TAKE PRECEDENCE. The patient window is
    // consulted ONLY when the delivery's own delivery_time_start is blank.
    //   1) Delivery has its own delivery_time_start — keep it, ALWAYS. Never
    //      let the patient's standing default overwrite a per-delivery value a
    //      dispatcher explicitly set (this exact inversion kept re-sequencing a
    //      18:00 delivery to its patient's stale 15:00 default).
    //   2) Blank delivery start + valid (not passed) patient window — use it.
    //   3) Otherwise — now+5 stamp (existing behavior).
    const ownStartMin = delivery.delivery_time_start ? _parseTimeToMinutes(delivery.delivery_time_start) : null;
    const patientWindowStartMin = patient?.time_window_start ? _parseTimeToMinutes(patient.time_window_start) : null;

    let resolvedStart;

    // ── BATCH ANCHOR (owner directive Nov 9 2026) ─────────────────────────
    // "At the moment Assign All is clicked and it is cycling through every
    // pending stop for that pickup, it should stamp them with the current time
    // plus 5 minutes." That is the rule: the whole accepted batch shares ONE
    // start anchored to the accept moment, so the engine orders them by road
    // geometry instead of by a ladder of minutes nobody asked for.
    //
    // The four Londonderry stops proved it: created one by one in the morning
    // with 16:05 inherited from the 4:00 PM pickup slot, they came back from
    // accept as 16:48 / 17:02 / 17:02 / 17:02 and the far stop jumped the
    // queue. An arrival default is NOT a customer promise.
    //
    // Two things still win over the anchor, because they are real constraints:
    //   - a patient window that is genuinely ahead (fridge / appointment), and
    //   - a start the dispatcher pushed well into the future (>= 20 min ahead),
    //     which cannot be an inherited arrival time.
    const ACCEPT_REANCHOR_GAP_MIN = 20;
    const anchor = deliveryTimeStart || '09:00';
    const anchorMin = _parseTimeToMinutes(anchor);
    const ownIsRealPromise = ownStartMin != null && anchorMin != null && ownStartMin >= anchorMin + ACCEPT_REANCHOR_GAP_MIN;
    const patientIsRealPromise = patientWindowStartMin != null && anchorMin != null && patientWindowStartMin >= anchorMin + ACCEPT_REANCHOR_GAP_MIN;

    if (ownIsRealPromise) {
      // A dispatcher-set / promised start well ahead of the accept time is kept.
      resolvedStart = (patientIsRealPromise && ownStartMin < patientWindowStartMin)
        ? patient.time_window_start
        : delivery.delivery_time_start;
    } else if (patientIsRealPromise) {
      resolvedStart = patient.time_window_start;
    } else {
      // Arrival default (inherited from the pickup slot, or already passed) —
      // the whole batch stamps now + 5.
      resolvedStart = anchor;
    }

    // delivery_time_end: same precedence — delivery's own end first, patient
    // default only as fallback when the delivery's end is blank
    let resolvedEnd = delivery.delivery_time_end || patient?.time_window_end || '';

    // END GUARD (companion to the start reset above): if the start was just
    // raised past the delivery's own end, the window is now invalid
    // (start > end). Prefer the patient's end when it still covers the new
    // start; otherwise pin end to the new start so the optimizer never sees
    // an inverted window.
    const resolvedStartMin = _parseTimeToMinutes(resolvedStart);
    const resolvedEndMin = resolvedEnd ? _parseTimeToMinutes(resolvedEnd) : null;
    if (resolvedStartMin != null && resolvedEndMin != null && resolvedEndMin < resolvedStartMin) {
      const patientEndMin = patient?.time_window_end ? _parseTimeToMinutes(patient.time_window_end) : null;
      resolvedEnd = (patientEndMin != null && patientEndMin >= resolvedStartMin)
        ? patient.time_window_end
        : resolvedStart;
    }

    return {
      ...delivery,
      status: 'in_transit',
      delivery_time_start: resolvedStart,
      time_window_inferred: false,
      delivery_time_end: resolvedEnd,
      delivery_time_eta: eta,
      puid: delivery.puid || puid || stopId || delivery.puid || ''
    };
  });

  // Persist to offline DB only — NO server writes here.
  // The caller (executeAcceptAllStops) will do a single atomic bulkUpdateDeliveries
  // commit after optimization and TR# recalc are complete.
  try {
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, updatedDeliveries);
  } catch (e) {
    console.warn('[AcceptAll] offlineDB bulkSave failed:', e?.message || e);
  }

  // Freeze the card order BEFORE the optimistic transition — the coordinator's
  // freshDeliveries (with the real new order) release the lock when they land.
  window.dispatchEvent(new CustomEvent('routeDisplayOrderLock', { detail: { driverId, deliveryDate } }));

  // Update UI IMMEDIATELY (optimistic) — don't wait for any backend writes.
  if (updateDeliveriesLocally && updatedDeliveries.length > 0) {
    updateDeliveriesLocally(updatedDeliveries, false);
  }

  // Build COD batch for the caller to fire AFTER the atomic server commit.
  const codBatch = updatedDeliveries
    .filter((d) => d.driver_id && Number(d.cod_total_amount_required || 0) > 0)
    .map((d) => {
      const store = stores?.find((s) => s && s.id === d.store_id);
      const patient = d.patient_id ? patientMap.get(d.patient_id) : null;
      return {
        deliveryId: d.id,
        driverId: d.driver_id,
        patientName: patient?.full_name || d.patient_name || '',
        storeAbbreviation: store?.abbreviation || store?.store_abbreviation || '',
        codAmount: d.cod_total_amount_required,
        deliveryDate: d.delivery_date,
        storeId: d.store_id
      };
    });

  return {
    stagedChangedDeliveries: updatedDeliveries,
    finalOfflineUpdates: updatedDeliveries,
    codBatch,
    driverId,
    deliveryDate
  };
}
