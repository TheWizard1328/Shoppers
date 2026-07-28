/**
 * acceptAllBatchPipeline
 * Handles the "Accept All" batch operation for a pickup card:
 * transitions all pending deliveries for the same store/driver/date to in_transit,
 * persists them offline, and returns data for downstream steps (COD sync, optimization).
 */
import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';

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

  const isRetroDate = deliveryDate < localDeviceTodayStr;

  // Build patient lookup map for time window resolution
  const patientMap = new Map((patients || []).filter(Boolean).map(p => [p.id, p]));

  // Build updated delivery objects
  const updatedDeliveries = scopedPendingDeliveries.map((delivery, idx) => {
    const baseMinutes = (() => {
      const [h, m] = (deliveryTimeStart || '09:00').split(':').map(Number);
      return h * 60 + m + (idx * 5);
    })();
    const etaHours = Math.floor((baseMinutes % 1440) / 60);
    const etaMins = baseMinutes % 60;
    const eta = `${String(etaHours).padStart(2, '0')}:${String(etaMins).padStart(2, '0')}`;

    // Patient time windows take priority over delivery_time_start (which is set
    // from the store/pickup time window rules at creation time). If a patient
    // has their own time_window_start/end, those are the authoritative windows
    // for the delivery — the store's window is just a fallback for patients
    // without specific time constraints.
    const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;
    const hasPatientWindow = !!(patient?.time_window_start || patient?.time_window_end);
    const resolvedStart = hasPatientWindow
      ? (patient.time_window_start || delivery.delivery_time_start || deliveryTimeStart || '09:00')
      : (delivery.delivery_time_start || deliveryTimeStart || '09:00');
    const resolvedEnd = hasPatientWindow
      ? (patient.time_window_end || delivery.delivery_time_end || '')
      : (delivery.delivery_time_end || '');

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