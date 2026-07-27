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

    // Apply patient time windows if the delivery is missing them
    const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;
    const resolvedStart = delivery.delivery_time_start || (patient?.time_window_start) || deliveryTimeStart || '09:00';
    const resolvedEnd = delivery.delivery_time_end || (patient?.time_window_end) || '';

    return {
      ...delivery,
      status: 'in_transit',
      delivery_time_start: resolvedStart,
      delivery_time_end: resolvedEnd,
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

  // Update UI IMMEDIATELY (optimistic) — don't wait for any backend writes.
  if (updateDeliveriesLocally && updatedDeliveries.length > 0) {
    updateDeliveriesLocally(updatedDeliveries, false);
  }

  // Fire backend writes SEQUENTIALLY — ensures each delivery is fully committed to
  // in_transit on the server before the next one is written. This prevents the race
  // condition where syncSquareCods fires before the status change is visible to the
  // event trigger, causing the catalog item creation to be silently skipped.
  const finalOfflineUpdates = [...updatedDeliveries]; // IDB already written above
  for (const updated of updatedDeliveries) {
    try {
      await base44.entities.Delivery.update(updated.id, {
        status: 'in_transit',
        delivery_time_start: updated.delivery_time_start,
        delivery_time_end: updated.delivery_time_end,
        delivery_time_eta: updated.delivery_time_eta,
        puid: updated.puid
      });
    } catch (err) {
      console.warn(`[AcceptAll] Server write failed for ${updated.id}:`, err?.message || err);
    }
  }

  // Build COD batch for Square sync
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

  // Square COD sync runs HERE — after all in_transit writes are confirmed on the server.
  // Uses a 20s timeout so a slow Square API call never blocks the pipeline indefinitely
  // and leaves sync managers paused / the app unresponsive.
  if (codBatch.length > 0) {
    try {
      const codResult = await Promise.race([
        base44.functions.invoke('syncSquareCods', { items: codBatch }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Square COD sync timed out after 20s')), 20000))
      ]);
      const errors = (codResult?.results || []).filter(x => x?.status === 'error');
      if (errors.length > 0) {
        console.error('[AcceptAll] Square COD sync errors:', errors);
      } else {
        console.log(`[AcceptAll] Square COD sync: ${codResult?.processed || 0} items OK`);
      }
    } catch (codErr) {
      console.error('[AcceptAll] Square COD sync FAILED (non-fatal):', codErr?.message || codErr);
      // Non-fatal — delivery transitions are already committed; COD item can be created on next sync
    }
  }

  // NOTE: optimizeRemainingStops is intentionally NOT called here.
  // It must run AFTER all backend writes are confirmed — the caller
  // (executeAcceptAllStops) handles optimization + polyline regeneration
  // once all delivery status updates have been persisted.
  return {
    stagedChangedDeliveries: updatedDeliveries,
    finalOfflineUpdates,
    codBatch,
    driverId,
    deliveryDate
  };
}