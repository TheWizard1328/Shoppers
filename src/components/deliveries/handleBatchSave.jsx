import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { createDeliveryLocal } from '../utils/entityMutations';
import { filterValidStagedDeliveries, splitStagedDeliveriesForBatch, attachTrackingNumbers, getDeliveriesReadyForDB, buildExistingDeliveryBatchUpdate } from './deliveryBatchSaveHelpers';
import { resetBatchSaveDraftState, closeBatchFormThenResumeManagers, restartBatchSmartRefresh, runCreateBatchRefresh } from './deliveryBatchSaveUiHelpers';
import { handlePendingDeleteOnlySave } from './handlePendingDeleteOnlySave';

export async function handleBatchSave({
  deliveryData,
  setShowDeliveryForm,
  setEditingDelivery,
  hasAutoSelectedRef,
  batchSaveLockRef,
  isSaving,
  blockPredictions,
  stagedDeliveries,
  hasPendingDeletes,
  setStagedDeliveries,
  setProjectedDeliveries,
  setHasPendingDeletes,
  setHasChanges,
  hasLoadedPending,
  unblockPredictions,
  setIsLoadingPredictions,
  handleClearForm,
  onCancel,
  formData,
  allDeliveries,
  stores,
  setIsSaving,
  setError,
  setBatchFormSaving,
  updateDeliveryLocal,
  updatePatientLocal,
  onSave,
  isNewRouteWithZeroStops
}) {

  const safeStagedDeliveries = Array.isArray(stagedDeliveries) ? stagedDeliveries : [];
  const safeAllDeliveries = Array.isArray(allDeliveries) ? allDeliveries : [];
  const safeStores = Array.isArray(stores) ? stores : [];
  const safeBatchSaveLockRef = batchSaveLockRef || { current: false };
  const safeHasLoadedPending = hasLoadedPending || { current: false };
  const safeBlockPredictions = blockPredictions || (() => {});
  const safeUnblockPredictions = unblockPredictions || (() => {});
  const safeSetStagedDeliveries = setStagedDeliveries || (() => {});
  const safeSetProjectedDeliveries = setProjectedDeliveries || (() => {});
  const safeSetHasPendingDeletes = setHasPendingDeletes || (() => {});
  const safeSetHasChanges = setHasChanges || (() => {});
  const safeSetIsLoadingPredictions = setIsLoadingPredictions || (() => {});
  const safeHandleClearForm = handleClearForm || (() => {});
  const safeOnCancel = onCancel || (() => {});
  const safeSetIsSaving = setIsSaving || (() => {});
  const safeSetError = setError || (() => {});
  const safeSetBatchFormSaving = setBatchFormSaving || (() => {});

  if (safeBatchSaveLockRef.current || isSaving) return;
  safeBatchSaveLockRef.current = true;
  safeBlockPredictions();

  if (safeStagedDeliveries.length === 0 && !hasPendingDeletes) {
    safeHasLoadedPending.current = false;
    safeUnblockPredictions();
    import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm: safeHandleClearForm, onCancel: safeOnCancel })).catch(()=>{safeHandleClearForm();safeOnCancel();});
    return;
  }

  if (await handlePendingDeleteOnlySave({
    stagedDeliveries: safeStagedDeliveries,
    hasPendingDeletes,
    setStagedDeliveries: safeSetStagedDeliveries,
    setProjectedDeliveries: safeSetProjectedDeliveries,
    setHasPendingDeletes: safeSetHasPendingDeletes,
    setHasChanges: safeSetHasChanges,
    hasLoadedPending: safeHasLoadedPending,
    unblockPredictions: safeUnblockPredictions,
    setIsLoadingPredictions: safeSetIsLoadingPredictions,
    handleClearForm: safeHandleClearForm,
    onCancel: safeOnCancel,
    formData
  })) return;

  const { newDeliveries, existingDeliveries } = splitStagedDeliveriesForBatch(filterValidStagedDeliveries(safeStagedDeliveries, safeAllDeliveries));
  const deliveriesToUpdate = existingDeliveries.filter(d => d.status === 'Staged');

  if (newDeliveries.length === 0 && deliveriesToUpdate.length === 0) {
    safeSetStagedDeliveries([]);
    safeSetProjectedDeliveries([]);
    safeHasLoadedPending.current = false;
    safeUnblockPredictions();
    safeSetIsLoadingPredictions(true);
    import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm: safeHandleClearForm, onCancel: safeOnCancel })).catch(()=>{safeHandleClearForm();safeOnCancel();});
    return;
  }

  const { deliveriesWithTRs, existingDeliveriesWithTRs } = attachTrackingNumbers({
    newDeliveries,
    existingDeliveries,
    stores: safeStores,
    allDeliveries: safeAllDeliveries,
    deliveryDate: formData.delivery_date
  });

  safeSetIsSaving(true);
  safeSetError(null);
  safeSetBatchFormSaving(true);

  try {
    const { smartRefreshManager } = await import('../utils/smartRefreshManager');
    smartRefreshManager.pause();
  } catch (error) {
    console.warn('⚠️ [AddToRoute] Failed to pause SmartRefresh:', error);
  }

  try {
    if (deliveriesToUpdate.length > 0) {
      const updatePromises = deliveriesToUpdate.map((updated) => {
        const updateData = buildExistingDeliveryBatchUpdate(updated);
        return updateDeliveryLocal(updated.id, updateData, { isBatchOperation: true, skipSmartRefresh: true }).catch((error) => {
          if (error.message?.includes('not found') || error.response?.status === 404) return null;
          throw new Error(error.message?.replace(updated.id, updated.patient_name || 'Unknown Patient') || error.message);
        });
      });
      await Promise.allSettled(updatePromises);
      (()=>{try{const __todayLocal=format(new Date(),'yyyy-MM-dd');const ids=Array.from(new Set(deliveriesToUpdate.filter(d=>(d.status==='completed'||d.status==='failed')&&d.patient_id).map(d=>d.patient_id)));ids.forEach(pid=>{updatePatientLocal(pid,{last_delivery_date:__todayLocal});});}catch(_){}})();
    }

    if (newDeliveries.length > 0 && isNewRouteWithZeroStops) {
      const driverGroups = {};
      newDeliveries.forEach((del) => {
        if (!del.patient_id || !del.driver_id) return;
        if (!driverGroups[del.driver_id]) {
          driverGroups[del.driver_id] = { driverId: del.driver_id, deliveryDate: del.delivery_date, deliveries: [] };
        }
        driverGroups[del.driver_id].deliveries.push(del);
      });

      const specialStores = ['WestPark', 'SouthPoint', 'Lakeland Ridge', 'Sherwood Pk Mall'];
      await Promise.allSettled(Object.keys(driverGroups).map(async (driverId) => {
        const group = driverGroups[driverId];
        const selectedDate = new Date(group.deliveryDate + 'T00:00:00');
        const dayOfWeek = selectedDate.getDay();
        const driverAssignedStores = safeStores.filter((s) => {
          if (!s) return false;
          let driverIds = [];
          if (dayOfWeek === 6) driverIds = [s.saturday_am_driver_id, s.saturday_pm_driver_id];
          else if (dayOfWeek === 0) driverIds = [s.sunday_am_driver_id, s.sunday_pm_driver_id];
          else driverIds = [s.weekday_am_driver_id, s.weekday_pm_driver_id];
          return driverIds.includes(driverId);
        });

        const ensureTasks = driverAssignedStores.flatMap((assignedStore) => {
          const isSpecialStore = specialStores.some((name) => assignedStore.name?.includes(name));
          if (isSpecialStore) return [];
          const timeSlots = [];
          if (dayOfWeek === 6) {
            if (assignedStore.saturday_am_driver_id === driverId) timeSlots.push('AM');
            if (assignedStore.saturday_pm_driver_id === driverId) timeSlots.push('PM');
          } else if (dayOfWeek === 0) {
            if (assignedStore.sunday_am_driver_id === driverId) timeSlots.push('AM');
            if (assignedStore.sunday_pm_driver_id === driverId) timeSlots.push('PM');
          } else {
            if (assignedStore.weekday_am_driver_id === driverId) timeSlots.push('AM');
            if (assignedStore.weekday_pm_driver_id === driverId) timeSlots.push('PM');
          }

          return timeSlots.map((timeSlot) =>
            base44.functions.invoke('ensurePickupForDelivery', {
              storeId: assignedStore.id,
              deliveryDate: group.deliveryDate,
              driverId,
              ampmDeliveries: timeSlot
            }).catch(() => null)
          );
        });

        await Promise.allSettled(ensureTasks);
      }));
    }

    const deliveriesReadyForDB = getDeliveriesReadyForDB(newDeliveries, deliveriesWithTRs);
    if (deliveriesReadyForDB.length > 0) {
      const ensuredPickups = await Promise.all(deliveriesReadyForDB.map((d) => d?.patient_id && d?.store_id && d?.delivery_date && d?.driver_id ? base44.functions.invoke('ensurePickupForDelivery', { storeId: d.store_id, deliveryDate: d.delivery_date, driverId: d.driver_id, ampmDeliveries: d.ampm_deliveries || 'AM', allowCreateIfMissing: true }).catch(() => null) : null));
      const ensuredPickupRecords = ensuredPickups.map((result) => result?.data?.pickup).filter((pickup) => pickup?.id);
      const missingPickupRecords = ensuredPickups
        .map((result, index) => ({ result, delivery: deliveriesReadyForDB[index] }))
        .filter(({ result }) => !result?.data?.pickup && !!result?.data?.puid)
        .map(({ result, delivery }) => ({
          stop_id: result.data.puid,
          store_id: delivery.store_id,
          delivery_date: delivery.delivery_date,
          driver_id: delivery.driver_id,
          driver_name: delivery.driver_name,
          dispatcher_id: delivery.dispatcher_id || null,
          ampm_deliveries: delivery.ampm_deliveries || 'AM',
          status: 'en_route',
          delivery_time_start: delivery.ampm_deliveries === 'PM' ? '15:00' : '10:00',
          delivery_time_end: delivery.ampm_deliveries === 'PM' ? '16:00' : '11:00',
          tracking_number: ''
        }));
      const createdMissingPickups = missingPickupRecords.length > 0 ? await Promise.all(missingPickupRecords.map((pickup) => createDeliveryLocal(pickup).catch(() => null))) : [];
      if (typeof onSave !== 'function') throw new Error('Save handler is missing');
      await onSave({ _isBatchSave: true, _stagedDeliveries: deliveriesReadyForDB.map((d, i) => ({ ...d, puid: ensuredPickups[i]?.data?.puid || d.puid || '' })), _ensuredPickups: [...ensuredPickupRecords, ...createdMissingPickups.filter(Boolean)] });
    }

    resetBatchSaveDraftState({
      setStagedDeliveries: safeSetStagedDeliveries,
      setProjectedDeliveries: safeSetProjectedDeliveries,
      setHasPendingDeletes: safeSetHasPendingDeletes,
      setHasChanges: safeSetHasChanges,
      hasLoadedPendingRef: safeHasLoadedPending,
      unblockPredictions: safeUnblockPredictions,
      setIsLoadingPredictions: safeSetIsLoadingPredictions
    });
    await closeBatchFormThenResumeManagers({ handleClearForm: safeHandleClearForm, onCancel: safeOnCancel });

    Promise.resolve().then(async () => {
      try {
        const squarePromises = deliveriesReadyForDB.filter(d => d.cod_total_amount_required > 0 && d.patient_id && d.driver_id && d.status === 'in_transit').map(delivery => {
          const store = safeStores?.find(s => s && s.id === delivery.store_id);
          return base44.functions.invoke('squareCreateCodItem', { deliveryId: delivery.id || delivery._tempId, patientName: delivery.patient_name, storeAbbreviation: store?.abbreviation || '', codAmount: delivery.cod_total_amount_required, deliveryDate: delivery.delivery_date, storeId: delivery.store_id }).then(() => null).catch(() => null);
        });
        if (squarePromises.length > 0) await Promise.allSettled(squarePromises);

        await Promise.all(Array.from(new Set([...deliveriesToUpdate.flatMap((delivery) => { const originalDelivery = safeAllDeliveries?.find((item) => item?.id === delivery?.id); return [[delivery?.driver_id, delivery?.delivery_date], [originalDelivery?.driver_id, originalDelivery?.delivery_date]]; }), ...deliveriesReadyForDB.map((delivery) => [delivery?.driver_id, delivery?.delivery_date])].filter(([driverId, deliveryDate]) => driverId && deliveryDate).map(([driverId, deliveryDate]) => `${driverId}__${deliveryDate}`))).map(async (key) => { const [driverId, deliveryDate] = key.split('__'); const { recalculateAndUpdateStopOrders } = await import('../utils/stopOrderManager'); return recalculateAndUpdateStopOrders(driverId, deliveryDate, true); }));
        await restartBatchSmartRefresh(() => safeSetBatchFormSaving(false));

        if (deliveriesToUpdate.length > 0 && newDeliveries.length === 0) {
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryDate: formData.delivery_date, driverId: formData.driver_id, triggeredBy: 'doneButtonUpdates', immediate: true } }));
        } else {
          const refreshDriverId = deliveriesReadyForDB[0]?.driver_id || existingDeliveriesWithTRs[0]?.driver_id || formData.driver_id;
          const refreshDeliveryDate = deliveriesReadyForDB[0]?.delivery_date || existingDeliveriesWithTRs[0]?.delivery_date || formData.delivery_date;
          await runCreateBatchRefresh({ refreshDriverId, refreshDeliveryDate });
        }
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      } catch (bgError) {
        console.error('⚠️ [AddToRoute] Background operations failed:', bgError);
      }
    });
  } catch (err) {
    console.error('[AddToRoute] ❌ Batch save error:', err);
    safeSetError(`Failed to save: ${err.message || 'Unknown error'}`);
    safeUnblockPredictions();
    safeSetIsLoadingPredictions(false);
    await restartBatchSmartRefresh(() => safeSetBatchFormSaving(false));
  } finally {
    safeBatchSaveLockRef.current = false;
    safeSetIsSaving(false);
  }
}