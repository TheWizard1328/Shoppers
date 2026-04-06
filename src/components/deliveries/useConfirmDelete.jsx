import { useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  deleteDelivery as deleteDeliveryLocal,
  updateDelivery as updateDeliveryLocal,
} from '../utils/entityMutations';

export function useConfirmDelete({
  deleteConfirmation,
  setDeleteConfirmation,
  sortedStagedDeliveries,
  stagedDeliveries,
  editingStagedId,
  handleClearForm,
  setStagedDeliveries,
  setProjectedDeliveries,
  fullPredictionListRef,
  allDeliveries,
  formData,
  setHasChanges,
  setHasPendingDeletes,
  setEditingStagedId,
  setError,
  setIsDeletingPending,
}) {
  return useCallback(async () => {
    const staged = deleteConfirmation.staged;
    if (!staged) return;
    setIsDeletingPending(true);
    try {
      if (!staged.id) {
        setStagedDeliveries((prev) => prev.filter((item) => item.id !== staged.id && item._tempId !== staged._tempId));
        const remainingStagedIds = new Set(
          stagedDeliveries
            .filter((item) => item.id !== staged.id && item._tempId !== staged._tempId)
            .map((d) => d.patient_id)
            .filter(Boolean)
        );
        setProjectedDeliveries(
          fullPredictionListRef.current.filter(
            (pred) =>
              !remainingStagedIds.has(pred.patient_id) &&
              !(allDeliveries || []).some(
                (d) => d && d.delivery_date === formData.delivery_date && d.patient_id === pred.patient_id
              )
          )
        );
        setHasChanges(true);
        if (editingStagedId === staged._tempId) {
          setEditingStagedId(null);
          handleClearForm();
        }
        setDeleteConfirmation({ show: false, staged: null, transferPickupId: null });
        return;
      }
      if (!staged.patient_id && deleteConfirmation.transferPickupId) {
        const linkedStops = sortedStagedDeliveries.filter((s) => s.id && s.patient_id && s.puid === staged.stop_id);
        if (linkedStops.length) {
          const targetPickup = sortedStagedDeliveries.find((s) => s.id === deleteConfirmation.transferPickupId);
          if (!targetPickup) throw new Error('Target pickup not found');
          const targetPickupTR = parseInt(targetPickup.tracking_number, 10) || 0;
          const existingTargetStops = sortedStagedDeliveries.filter((s) => s.id && s.patient_id && s.puid === targetPickup.stop_id).length;
          for (let i = 0; i < linkedStops.length; i += 1) {
            await updateDeliveryLocal(linkedStops[i].id, {
              puid: targetPickup.stop_id,
              tracking_number: String(targetPickupTR + existingTargetStops + i + 1),
              store_id: targetPickup.store_id,
              ampm_deliveries: targetPickup.ampm_deliveries,
            });
          }
        }
      }

      await deleteDeliveryLocal(staged.id);

      const nextStagedDeliveries = stagedDeliveries.filter(
        (item) => item.id !== staged.id && item._tempId !== staged._tempId
      );

      setStagedDeliveries(nextStagedDeliveries);

      const remainingStagedIds = new Set(
        nextStagedDeliveries.map((d) => d.patient_id).filter(Boolean)
      );
      setProjectedDeliveries(
        fullPredictionListRef.current.filter(
          (pred) =>
            !remainingStagedIds.has(pred.patient_id) &&
            !(allDeliveries || []).some(
              (d) => d && d.delivery_date === formData.delivery_date && d.patient_id === pred.patient_id
            )
        )
      );

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          deliveryId: staged.id,
          driverId: staged.driver_id,
          deliveryDate: staged.delivery_date,
          triggeredBy: 'pendingDeliveryDelete',
          preserveLocalState: true
        }
      }));

      // CRITICAL: Background only — never block UI waiting on stop-order or polyline calls
      if (staged.driver_id && staged.delivery_date) {
        Promise.resolve().then(async () => {
          try {
            const { recalculateAndUpdateStopOrders } = await import('../utils/stopOrderManager');
            await recalculateAndUpdateStopOrders(staged.driver_id, staged.delivery_date);
            if (!['completed', 'failed', 'cancelled', 'returned'].includes(staged.status)) {
              base44.functions.invoke('purgeAndRegeneratePolylines', {
                driverId: staged.driver_id,
                deliveryDate: staged.delivery_date,
                scope: 'active_only',
              }).catch(() => {});
            }
          } catch (_) {}
        });
      }

      const { invalidate } = await import('../utils/dataManager');
      invalidate('Delivery');

      setHasChanges(true);
      setHasPendingDeletes(true);
      if (editingStagedId === staged._tempId) {
        setEditingStagedId(null);
        handleClearForm();
      }
      setDeleteConfirmation({ show: false, staged: null, transferPickupId: null });
    } catch (err) {
      setError(`Failed: ${err.message}`);
    } finally {
      setIsDeletingPending(false);
    }
  }, [deleteConfirmation, sortedStagedDeliveries, stagedDeliveries, editingStagedId, handleClearForm]);
}