/**
 * acceptAllBatchPipeline
 * Handles the "Accept All" batch operation for a pickup card:
 * transitions all pending deliveries for the same store/driver/date to in_transit,
 * persists them offline, and returns data for downstream steps (COD sync, optimization).
 */
import { updateDelivery as updateDeliveryLocal } from './entityMutations';
import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';
import { pauseRealtimeSync } from './realtimeSync';
import { smartRefreshManager } from './smartRefreshManager';
import { backgroundSyncManager } from './backgroundSyncManager';

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

  // CRITICAL: Pause realtime + smart refresh for the entire batch so WebSocket
  // echoes don't thrash the UI while we're writing.
  // NOTE: We do NOT resume these in our finally — the caller (executeAcceptAllStops)
  // owns the full pause/resume lifecycle and resumes everything in ITS finally block
  // after the optimizer + polyline regeneration completes. Resuming here prematurely
  // unpauses the managers while optimization is still running, which allows other
  // code paths to re-pause them (the pause mechanism is a simple boolean, not
  // reference-counted), leaving them permanently stuck paused.
  pauseRealtimeSync();
  smartRefreshManager.pause();
  backgroundSyncManager.pause();

  // Update UI IMMEDIATELY (optimistic) — don't wait for any backend writes.
  if (updateDeliveriesLocally && updatedDeliveries.length > 0) {
    updateDeliveriesLocally(updatedDeliveries, false);
  }

  // Fire ALL backend writes in parallel — use direct API calls (not isBatchOperation queue)
  // so the server is updated immediately. isBatchOperation queues to pending mutations which
  // only sync after background sync resumes, causing the 3-5 min ghost-stop / revert issue.
  const finalOfflineUpdates = [...updatedDeliveries]; // IDB already written above
  try {
    await Promise.all(
      updatedDeliveries.map((updated) =>
        base44.entities.Delivery.update(updated.id, {
          status: 'in_transit',
          delivery_time_start: updated.delivery_time_start,
          delivery_time_end: updated.delivery_time_end,
          delivery_time_eta: updated.delivery_time_eta,
          puid: updated.puid
        }).catch((err) => {
          console.warn(`[AcceptAll] Server write failed for ${updated.id}:`, err?.message || err);
        })
      )
    );
  } catch (batchErr) {
    // Even on error, do NOT resume managers — the caller's finally handles that.
    console.warn('[AcceptAll] Batch server write error (managers stay paused for caller to resume):', batchErr?.message || batchErr);
    throw batchErr;
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