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
  const nowPlus5Minutes = _parseTimeToMinutes(deliveryTimeStart); // caller already computed now+5

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

    // ── delivery_time_start resolution (3 rules) ──────────────────────────
    // 1) patient.time_window_start if it's later than now
    // 2) now+5 if now+5 is beyond the current delivery_time_start
    // 3) now+5 if delivery_time_start is blank/null
    // Otherwise keep the existing delivery_time_start (it's already >= now+5)
    const patientWindowStartMin = patient?.time_window_start ? _parseTimeToMinutes(patient.time_window_start) : null;
    const existingStartMin = delivery.delivery_time_start ? _parseTimeToMinutes(delivery.delivery_time_start) : null;

    let resolvedStart;
    if (patientWindowStartMin != null && nowMinutes != null && patientWindowStartMin > nowMinutes) {
      // Rule 1: patient window is later than now — use it
      resolvedStart = patient.time_window_start;
    } else if (existingStartMin == null) {
      // Rule 3: blank/null — use now+5
      resolvedStart = deliveryTimeStart || '09:00';
    } else if (nowPlus5Minutes != null && nowPlus5Minutes > existingStartMin) {
      // Rule 2: now+5 is beyond existing start — use now+5
      resolvedStart = deliveryTimeStart || '09:00';
    } else {
      // Existing start is already >= now+5 — keep it
      resolvedStart = delivery.delivery_time_start;
    }

    // delivery_time_end: patient window takes priority, otherwise keep existing
    const resolvedEnd = patient?.time_window_end || delivery.delivery_time_end || '';

    return {
      ...delivery,
      status: 'in_transit',
      delivery_time_start: resolvedStart,
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
