import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { filterValidStagedDeliveries, splitStagedDeliveriesForBatch, attachTrackingNumbers, getDeliveriesReadyForDB, buildExistingDeliveryBatchUpdate } from './deliveryBatchSaveHelpers';
import { resetBatchSaveDraftState, closeBatchFormThenResumeManagers, restartBatchSmartRefresh, runCreateBatchRefresh } from './deliveryBatchSaveUiHelpers';
import { handlePendingDeleteOnlySave } from './handlePendingDeleteOnlySave';

export async function handleBatchSave({
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
  if (batchSaveLockRef.current || isSaving) return;
  batchSaveLockRef.current = true;
  blockPredictions();

  if (stagedDeliveries.length === 0 && !hasPendingDeletes) {
    hasLoadedPending.current = false;
    unblockPredictions();
    import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm, onCancel })).catch(()=>{handleClearForm();onCancel();});
    return;
  }

  if (await handlePendingDeleteOnlySave({
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
    formData
  })) return;

  const routeDriverId = formData.driver_id || stagedDeliveries.find((delivery) => delivery?.driver_id)?.driver_id || '';
  const routeDeliveryDate = formData.delivery_date || stagedDeliveries.find((delivery) => delivery?.delivery_date)?.delivery_date || format(new Date(), 'yyyy-MM-dd');

  const persistedRouteStopCountBeforeProcessing = (allDeliveries || []).filter((delivery) => {
    if (!delivery || delivery.delivery_date !== routeDeliveryDate || delivery.status === 'Staged') return false;
    if (routeDriverId === 'unassigned') return !delivery.driver_id;
    return delivery.driver_id === routeDriverId;
  }).length;

  console.log('[AddToRoute] Pre-processing route stop count', {
    driverId: routeDriverId,
    deliveryDate: routeDeliveryDate,
    persistedRouteStopCountBeforeProcessing,
    matchingStops: (allDeliveries || [])
      .filter((delivery) => {
        if (!delivery || delivery.delivery_date !== routeDeliveryDate) return false;
        if (routeDriverId === 'unassigned') return !delivery.driver_id;
        return delivery.driver_id === routeDriverId;
      })
      .map((delivery) => ({
        id: delivery.id,
        patient_id: delivery.patient_id,
        status: delivery.status,
        stop_id: delivery.stop_id,
        puid: delivery.puid
      }))
  });

  const { newDeliveries, existingDeliveries } = splitStagedDeliveriesForBatch(filterValidStagedDeliveries(stagedDeliveries, allDeliveries));
  const deliveriesToUpdate = existingDeliveries.filter(d => d.status === 'Staged');

  if (newDeliveries.length === 0 && deliveriesToUpdate.length === 0) {
    setStagedDeliveries([]);
    setProjectedDeliveries([]);
    hasLoadedPending.current = false;
    unblockPredictions();
    setIsLoadingPredictions(true);
    import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm, onCancel })).catch(()=>{handleClearForm();onCancel();});
    return;
  }

  const { deliveriesWithTRs, existingDeliveriesWithTRs } = attachTrackingNumbers({
    newDeliveries,
    existingDeliveries,
    stores,
    allDeliveries,
    deliveryDate: formData.delivery_date
  });

  setIsSaving(true);
  setError(null);
  setBatchFormSaving(true);

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

    const deliveriesReadyForDB = getDeliveriesReadyForDB(newDeliveries, deliveriesWithTRs);
    if (deliveriesReadyForDB.length > 0) {
      const pickupRecordsFromStage = deliveriesReadyForDB
        .filter((delivery) => !delivery?.patient_id)
        .map((delivery) => ({ ...delivery, status: 'en_route' }));
      let creatorFlowEnsuredPickups = [];
      const patientDeliveriesReadyForDB = deliveriesReadyForDB.filter((delivery) => !!delivery?.patient_id);

      let ensuredPickupRecords = pickupRecordsFromStage;
      let stagedDeliveriesWithResolvedIds = patientDeliveriesReadyForDB;

      const specialStoreNames = ['Lakeland Ridge', 'Sherwood Pk Mall', 'WestPark', 'SouthPoint'];
      const hasSpecialStoreDeliveries = patientDeliveriesReadyForDB.some((delivery) => {
        const store = stores?.find((item) => item && item.id === delivery?.store_id);
        return specialStoreNames.includes(store?.name || '');
      });
      const shouldEnsureDefaultPickups = !!routeDriverId && persistedRouteStopCountBeforeProcessing === 0 && !hasSpecialStoreDeliveries;

      console.log('[AddToRoute] Default pickup gate', {
        shouldEnsureDefaultPickups,
        hasSpecialStoreDeliveries,
        persistedRouteStopCountBeforeProcessing,
        deliveriesReadyForDBCount: deliveriesReadyForDB.length,
        patientDeliveriesReadyForDBCount: patientDeliveriesReadyForDB.length,
        pickupRecordsFromStageCount: pickupRecordsFromStage.length
      });

      if (shouldEnsureDefaultPickups) {
        console.log('[AddToRoute] Invoking ensureDefaultPickupsForDriver', {
          driverId: routeDriverId,
          deliveryDate: routeDeliveryDate,
          storeIds: []
        });
        const defaultPickupResponse = await base44.functions.invoke('ensureDefaultPickupsForDriver', {
          driverId: routeDriverId,
          deliveryDate: routeDeliveryDate
        }).catch((error) => {
          console.error('[AddToRoute] ensureDefaultPickupsForDriver failed', error);
          return null;
        });
        console.log('[AddToRoute] ensureDefaultPickupsForDriver result', defaultPickupResponse?.data || defaultPickupResponse || null);
        const normalizedEnsuredPickups = [...(defaultPickupResponse?.data?.pickups || []), ...(defaultPickupResponse?.pickups || [])]
          .filter((pickup) => pickup?.id || pickup?.stop_id)
          .map((pickup) => {
            const normalizedPickup = {
              ...pickup,
              patient_id: null,
              store_id: pickup?.store_id || pickup?.pickup_store_id || '',
              driver_id: pickup?.driver_id || routeDriverId,
              delivery_date: pickup?.delivery_date || routeDeliveryDate,
              ampm_deliveries: pickup?.ampm_deliveries || 'AM',
              stop_id: pickup?.stop_id || pickup?.puid || pickup?.id || '',
              puid: pickup?.stop_id || pickup?.puid || pickup?.id || null
            };
            return normalizedPickup;
          });
        ensuredPickupRecords = Array.from(new Map(
          [...normalizedEnsuredPickups, ...pickupRecordsFromStage]
            .filter((pickup) => pickup?.id || pickup?.stop_id)
            .map((pickup) => [pickup.id || pickup.stop_id, pickup])
        ).values());
        creatorFlowEnsuredPickups = normalizedEnsuredPickups;
        const ensuredPickupByKey = new Map(
          ensuredPickupRecords
            .filter((pickup) => pickup && !pickup.patient_id)
            .map((pickup) => [`${pickup.store_id}__${pickup.delivery_date}__${pickup.driver_id || ''}__${pickup.ampm_deliveries || 'AM'}`, pickup])
        );
        stagedDeliveriesWithResolvedIds = patientDeliveriesReadyForDB.map((delivery) => {
          const key = `${delivery.store_id}__${delivery.delivery_date}__${delivery.driver_id || ''}__${delivery.ampm_deliveries || 'AM'}`;
          const ensuredPickup = ensuredPickupByKey.get(key);
          return {
            ...delivery,
            puid: ensuredPickup?.stop_id || delivery.puid || ''
          };
        });
      } else {
        const groupedEnsureKeys = new Map();
        patientDeliveriesReadyForDB.forEach((delivery) => {
          if (!delivery?.store_id || !delivery?.delivery_date || !delivery?.driver_id) return;
          const key = `${delivery.store_id}__${delivery.delivery_date}__${delivery.driver_id}__${delivery.ampm_deliveries || 'AM'}`;
          if (!groupedEnsureKeys.has(key)) groupedEnsureKeys.set(key, { delivery });
        });
        const ensureResultsByKey = new Map(await Promise.all(Array.from(groupedEnsureKeys.entries()).map(async ([key, { delivery }]) => {
          const result = await base44.functions.invoke('ensurePickupForDelivery', { storeId: delivery.store_id, deliveryDate: delivery.delivery_date, driverId: delivery.driver_id, ampmDeliveries: delivery.ampm_deliveries || 'AM', allowCreateIfMissing: true }).catch(() => null);
          return [key, result];
        })));
        const ensuredPickups = patientDeliveriesReadyForDB.map((delivery) => {
          if (!delivery?.store_id || !delivery?.delivery_date || !delivery?.driver_id) return null;
          const key = `${delivery.store_id}__${delivery.delivery_date}__${delivery.driver_id}__${delivery.ampm_deliveries || 'AM'}`;
          return ensureResultsByKey.get(key) || null;
        });
        ensuredPickupRecords = Array.from(new Map(
          [...ensuredPickups.map((result) => result?.data?.pickup), ...pickupRecordsFromStage]
            .filter((pickup) => pickup?.id || pickup?.stop_id)
            .map((pickup) => [pickup.id || pickup.stop_id, pickup])
        ).values());
        stagedDeliveriesWithResolvedIds = patientDeliveriesReadyForDB.map((d, i) => ({
          ...d,
          puid: ensuredPickups[i]?.data?.puid || d.puid || ''
        }));
      }

      await onSave({ _isBatchSave: true, _stagedDeliveries: stagedDeliveriesWithResolvedIds, _ensuredPickups: ensuredPickupRecords });
      if (creatorFlowEnsuredPickups.length > 0) {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            immediate: true,
            freshDeliveries: creatorFlowEnsuredPickups,
            deliveryDate: routeDeliveryDate,
            driverId: routeDriverId,
            triggeredBy: 'ensureDefaultPickupsForDriver'
          }
        }));
      }
    }

    resetBatchSaveDraftState({
      setStagedDeliveries,
      setProjectedDeliveries,
      setHasPendingDeletes,
      setHasChanges,
      hasLoadedPendingRef: hasLoadedPending,
      unblockPredictions,
      setIsLoadingPredictions
    });
    await closeBatchFormThenResumeManagers({ handleClearForm, onCancel });

    Promise.resolve().then(async () => {
      try {
        const squarePromises = deliveriesReadyForDB.filter(d => d.cod_total_amount_required > 0 && d.patient_id && d.driver_id && d.status === 'in_transit').map(delivery => {
          const store = stores?.find(s => s && s.id === delivery.store_id);
          return base44.functions.invoke('squareCreateCodItem', { deliveryId: delivery.id || delivery._tempId, patientName: delivery.patient_name, storeAbbreviation: store?.abbreviation || '', codAmount: delivery.cod_total_amount_required, deliveryDate: delivery.delivery_date, storeId: delivery.store_id }).then(() => null).catch(() => null);
        });
        if (squarePromises.length > 0) await Promise.allSettled(squarePromises);

        await restartBatchSmartRefresh(() => setBatchFormSaving(false));

        if (deliveriesToUpdate.length > 0 && newDeliveries.length === 0) {
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryDate: formData.delivery_date, driverId: formData.driver_id, triggeredBy: 'doneButtonUpdates', immediate: true } }));
        } else {
          const refreshDriverId = deliveriesReadyForDB.find((delivery) => delivery?.patient_id)?.driver_id || existingDeliveriesWithTRs[0]?.driver_id || formData.driver_id;
          const refreshDeliveryDate = deliveriesReadyForDB.find((delivery) => delivery?.patient_id)?.delivery_date || existingDeliveriesWithTRs[0]?.delivery_date || formData.delivery_date;
          await runCreateBatchRefresh({ refreshDriverId, refreshDeliveryDate });
        }
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      } catch (bgError) {
        console.error('⚠️ [AddToRoute] Background operations failed:', bgError);
      }
    });
  } catch (err) {
    console.error('[AddToRoute] ❌ Batch save error:', err);
    setError(`Failed to save: ${err.message || 'Unknown error'}`);
    unblockPredictions();
    setIsLoadingPredictions(false);
    await restartBatchSmartRefresh(() => setBatchFormSaving(false));
  } finally {
    batchSaveLockRef.current = false;
    setIsSaving(false);
  }
}