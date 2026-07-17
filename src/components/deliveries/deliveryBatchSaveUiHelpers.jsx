const closeBatchForm = async ({ handleClearForm, onCancel }) => {
  try {
    const { closeDeliveryFormAfterSave } = await import('../utils/deliveryFormActionHelpers');
    closeDeliveryFormAfterSave({ handleClearForm, onCancel });
  } catch {
    handleClearForm();
    onCancel();
  }
};

const resumeDeliveryManagers = async () => {
  try {
    const { resumeDeliveryFormManagers } = await import('../utils/deliveryFormActionHelpers');
    await resumeDeliveryFormManagers();
  } catch (error) {
    console.warn('⚠️ [AddToRoute] Failed to resume managers:', error);
  }
};

export const resetBatchSaveDraftState = ({
  setStagedDeliveries,
  setProjectedDeliveries,
  setHasPendingDeletes,
  setHasChanges,
  hasLoadedPendingRef,
  unblockPredictions,
  setIsLoadingPredictions
}) => {
  setStagedDeliveries([]);
  setProjectedDeliveries([]);
  setHasPendingDeletes(false);
  setHasChanges(false);
  hasLoadedPendingRef.current = false;
  unblockPredictions();
  setIsLoadingPredictions(true);
};

export const resumeManagersAndCloseBatchForm = async (args) => {
  await resumeDeliveryManagers();
  await closeBatchForm(args);
};

export const closeBatchFormThenResumeManagers = async (args) => {
  await closeBatchForm(args);
  await resumeDeliveryManagers();
};

export const restartBatchSmartRefresh = async (releaseBatchSaving) => {
  try {
    releaseBatchSaving();
    const { smartRefreshManager } = await import('../utils/smartRefreshManager');
    smartRefreshManager.restart();
  } catch (error) {
    console.warn('⚠️ [AddToRoute] Failed to resume SmartRefresh:', error);
  }
};

export const runDeleteOnlyBatchRefresh = ({ deliveryDate, driverId, allDeletedWerePending = false }) => {
  setTimeout(async () => {
    try {
      const { invalidate, invalidateDeliveriesForDate } = await import('../utils/dataManager');
      invalidate('Delivery');
      invalidateDeliveriesForDate(deliveryDate);

      if (driverId && deliveryDate) {
        const { base44 } = await import('@/api/base44Client');
        // Skip optimization when all deleted stops were pending — route order is unchanged
        if (!allDeletedWerePending) {
          import('@/components/utils/routeOptimizationCoordinator').then(({ performRouteOptimization }) =>
            performRouteOptimization({
              driverId,
              deliveryDate,
              bypassDriverStatus: true,
              source: 'batch_delete',
            }).catch(() => {})
          );
        }
        await base44.entities.Delivery.filter({
          driver_id: driverId,
          delivery_date: deliveryDate
        });
      }

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          deliveryDate,
          driverId,
          triggeredBy: 'doneButtonDeletes'
        }
      }));
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

      const { fabControlEvents } = await import('../utils/fabControlEvents');
      fabControlEvents.notifyDataReady();
    } catch (error) {
      console.error('[AddToRoute] ❌ Background refresh failed:', error);
    }
  }, 100);
};

export const runUpdateOnlyBatchRefresh = ({ deliveryDate, driverId }) => {
  setTimeout(async () => {
    try {
      const { invalidate, invalidateDeliveriesForDate } = await import('../utils/dataManager');
      invalidate('Delivery');
      invalidateDeliveriesForDate(deliveryDate);

      if (driverId && deliveryDate) {
        const { base44 } = await import('@/api/base44Client');
        await base44.entities.Delivery.filter({
          driver_id: driverId,
          delivery_date: deliveryDate
        });
      }

      const { fabControlEvents } = await import('../utils/fabControlEvents');
      fabControlEvents.notifyDataReady();
      fabControlEvents.notifyDoneButtonClicked();
    } catch (error) {
      console.error('[AddToRoute] ❌ Background refresh failed:', error);
    }
  }, 100);
};

export const runCreateBatchRefresh = async ({ refreshDriverId, refreshDeliveryDate }) => {
  try {
    const { processPendingMutations } = await import('../utils/offlineSync');
    await processPendingMutations();

    const { invalidate, invalidateDeliveriesForDate } = await import('../utils/dataManager');
    invalidate('Delivery');
    invalidateDeliveriesForDate(refreshDeliveryDate);

    // CRITICAL: Broadcast deliveriesUpdated so all devices/components receive the new deliveries
    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: {
        deliveryDate: refreshDeliveryDate,
        driverId: refreshDriverId,
        triggeredBy: 'batchSaveCreate',
        immediate: true
      }
    }));
    window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

    const { fabControlEvents } = await import('../utils/fabControlEvents');
    fabControlEvents.notifyDataReady();
    fabControlEvents.notifyDoneButtonClicked();
    return null;
  } catch (error) {
    console.warn('⚠️ [AddToRoute] Background refresh failed:', error);
    return null;
  }
};