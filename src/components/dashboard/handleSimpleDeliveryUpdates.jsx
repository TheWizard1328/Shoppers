import { updateDeliveryLocal } from "@/components/utils/offlineMutations";
import { invalidate } from "@/components/utils/dataManager";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";

export async function handleNotesUpdate(deliveryId, notes, { refreshData }) {
  try {
    await updateDeliveryLocal(deliveryId, { delivery_notes: notes });
    invalidate('Delivery');
    await refreshData();
  } catch (error) {
    console.error('Error updating delivery notes:', error);
    alert('Failed to update notes. Please try again.');
  }
}

export async function handleCODUpdate(deliveryId, codPayments, {
  deliveriesWithStopOrder, updateDeliveriesLocally, setIsEntityUpdating
}) {
  setIsEntityUpdating(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    const delivery = deliveriesWithStopOrder.find((d) => d?.id === deliveryId);
    if (!delivery) throw new Error('Delivery not found');
    const updateData = { cod_payments: codPayments };
    await updateDeliveryLocal(deliveryId, updateData, { skipSmartRefresh: true });
    if (updateDeliveriesLocally) {
      updateDeliveriesLocally([{ ...delivery, ...updateData }], false);
    }
    smartRefreshManager.registerPendingUpdate(deliveryId, delivery.driver_id, delivery.delivery_date);
  } catch (error) {
    console.error('❌ [COD Update] FAILED', error);
    alert(`Failed to update COD payments: ${error.message}`);
    throw error;
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    setIsEntityUpdating(false);
  }
}

/**
 * Syncs FAB refs after a status update (non-last stop, phase > 1) to prevent phase-bounce.
 */
export function syncFabRefsForPhase(phase, refs) {
  const { isMapViewLockedRef, mapViewPhaseRef, pendingPhaseRef, mapLockTimeoutRef, mapLockExpiresAtRef, setIsMapViewLocked } = refs;
  isMapViewLockedRef.current = true;
  mapViewPhaseRef.current = phase;
  pendingPhaseRef.current = phase;
  setIsMapViewLocked(true);
  if (mapLockTimeoutRef.current) {
    clearTimeout(mapLockTimeoutRef.current);
    mapLockTimeoutRef.current = null;
  }
  mapLockExpiresAtRef.current = null;
}