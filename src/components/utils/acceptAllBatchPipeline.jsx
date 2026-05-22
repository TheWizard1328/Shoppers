/**
 * acceptAllBatchPipeline
 * Handles the "Accept All" batch operation for a pickup card:
 * transitions all pending deliveries for the same store/driver/date to in_transit,
 * persists them offline, and returns data for downstream steps (COD sync, optimization).
 */
import { updateDelivery as updateDeliveryLocal } from './entityMutations';
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

  // Build updated delivery objects
  const updatedDeliveries = scopedPendingDeliveries.map((delivery, idx) => {
    const baseMinutes = (() => {
      const [h, m] = (deliveryTimeStart || '09:00').split(':').map(Number);
      return h * 60 + m + (idx * 5);
    })();
    const etaHours = Math.floor((baseMinutes % 1440) / 60);
    const etaMins = baseMinutes % 60;
    const eta = `${String(etaHours).padStart(2, '0')}:${String(etaMins).padStart(2, '0')}`;

    return {
      ...delivery,
      status: 'in_transit',
      delivery_time_start: deliveryTimeStart || delivery.delivery_time_start || '09:00',
      delivery_time_eta: eta,
      puid: delivery.puid || puid || stopId || delivery.puid || ''
    };
  });

  // Persist to offline DB
  try {
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, updatedDeliveries);
  } catch (e) {
    console.warn('[AcceptAll] offlineDB bulkSave failed:', e?.message || e);
  }

  // Update each delivery locally (optimistic) and to backend
  const finalOfflineUpdates = [];
  for (const updated of updatedDeliveries) {
    try {
      const result = await updateDeliveryLocal(updated.id, {
        status: 'in_transit',
        delivery_time_start: updated.delivery_time_start,
        delivery_time_eta: updated.delivery_time_eta,
        puid: updated.puid
      }, { skipSmartRefresh: true, isBatchOperation: true });
      if (result) finalOfflineUpdates.push(result);
    } catch (e) {
      console.warn('[AcceptAll] updateDeliveryLocal failed for', updated.id, e?.message || e);
      finalOfflineUpdates.push(updated);
    }
  }

  // Update UI immediately
  if (updateDeliveriesLocally && updatedDeliveries.length > 0) {
    updateDeliveriesLocally(updatedDeliveries, false);
  }

  // Build COD batch for Square sync
  const codBatch = updatedDeliveries
    .filter((d) => d.patient_id && d.driver_id && Number(d.cod_total_amount_required || 0) > 0)
    .map((d) => {
      const store = stores?.find((s) => s && s.id === d.store_id);
      return {
        deliveryId: d.id,
        patientName: d.patient_name || '',
        storeAbbreviation: store?.abbreviation || '',
        codAmount: d.cod_total_amount_required,
        deliveryDate: d.delivery_date,
        storeId: d.store_id
      };
    });

  // Trigger route optimization (non-blocking, returns result for caller)
  let optimizeData = null;
  try {
    const optimizeResponse = await base44.functions.invoke('optimizeRemainingStops', {
      driverId,
      deliveryDate,
      bypassDeduplication: true,
      bypassDriverStatus: true
    });
    optimizeData = optimizeResponse?.data || optimizeResponse || null;
  } catch (e) {
    console.warn('[AcceptAll] optimizeRemainingStops failed:', e?.message || e);
  }

  return {
    stagedChangedDeliveries: updatedDeliveries,
    finalOfflineUpdates,
    codBatch,
    optimizeData
  };
}