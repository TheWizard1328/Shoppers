import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { filterValidStagedDeliveries, splitStagedDeliveriesForBatch, attachTrackingNumbers, getDeliveriesReadyForDB, buildExistingDeliveryBatchUpdate } from './deliveryBatchSaveHelpers';
import { resetBatchSaveDraftState, closeBatchFormThenResumeManagers, restartBatchSmartRefresh, runCreateBatchRefresh } from './deliveryBatchSaveUiHelpers';
import { handlePendingDeleteOnlySave } from './handlePendingDeleteOnlySave';
import { recalculateAndUpdateStopOrders } from '../utils/stopOrderManager';
import { requestDeferredOptimization } from '../utils/optimizationDebouncer';
import { executeOfflineBatchAction } from '../utils/offlineBatchAction';

export async function handleBatchSave({
  batchSaveLockRef,
  isSaving,
  blockPredictions,
  stagedDeliveries,
  hasPendingDeletes,
  allDeletedWerePending = false,
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
    allDeletedWerePending,
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
   let routeStructureChanged = false;
   let hasInTransitTransition = false;
   let newPickupsCreated = false;

  console.log('[AddToRoute] handleBatchSave:start', {
    openMode: formData?.openMode,
    routeDriverId,
    routeDeliveryDate,
    stagedCount: stagedDeliveries.length,
    stagedSnapshot: stagedDeliveries.map((delivery) => ({
      id: delivery?.id || null,
      tempId: delivery?._tempId || null,
      patient_id: delivery?.patient_id || null,
      store_id: delivery?.store_id || null,
      driver_id: delivery?.driver_id || null,
      status: delivery?.status || null,
      puid: delivery?.puid || null
    }))
  });

  const { newDeliveries, existingDeliveries } = splitStagedDeliveriesForBatch(filterValidStagedDeliveries(stagedDeliveries, allDeliveries));
  // Include Staged-status deliveries (activating to route) AND any existing delivery that was
  // directly edited by the user (status/time fields changed while viewing in the staged list).
  const deliveriesToUpdate = existingDeliveries.filter(d => d.status === 'Staged' || d._wasEdited);

  console.log('[AddToRoute] handleBatchSave:split', {
    newCount: newDeliveries.length,
    existingCount: existingDeliveries.length,
    updateCount: deliveriesToUpdate.length,
    newStatuses: newDeliveries.map((delivery) => delivery?.status || null),
    existingStatuses: existingDeliveries.map((delivery) => delivery?.status || null)
  });

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

  // Pause ALL syncs via the unified helper before any writes
  try {
    const { pauseAllSyncs: _pause } = await import('../utils/offlineBatchAction').then(m => ({
      pauseAllSyncs: async () => {
        try { const { smartRefreshManager } = await import('../utils/smartRefreshManager'); smartRefreshManager.pause(); } catch { /* non-fatal */ }
        try { const { backgroundSyncManager } = await import('../utils/backgroundSyncManager'); backgroundSyncManager.pause(); } catch { /* non-fatal */ }
        try { const { pauseRealtimeSync } = await import('../utils/realtimeSync'); pauseRealtimeSync(); } catch { /* non-fatal */ }
        const { enterBatchSilentMode } = await import('../utils/entityMutations'); enterBatchSilentMode();
      }
    }));
    await _pause();
  } catch (error) {
    console.warn('⚠️ [AddToRoute] Failed to pause syncs:', error);
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
    console.log('[AddToRoute] handleBatchSave:deliveriesReadyForDB', deliveriesReadyForDB.map((delivery) => ({
      patient_id: delivery?.patient_id || null,
      store_id: delivery?.store_id || null,
      driver_id: delivery?.driver_id || null,
      status: delivery?.status || null,
      puid: delivery?.puid || null,
      tracking_number: delivery?.tracking_number || null
    })));
    if (deliveriesReadyForDB.length > 0) {
      const pickupRecordsFromStage = deliveriesReadyForDB
        .filter((delivery) => !delivery?.patient_id)
        .map((delivery) => ({ ...delivery, status: 'en_route' }));
      let creatorFlowEnsuredPickups = [];
      const patientDeliveriesReadyForDB = deliveriesReadyForDB.filter((delivery) => !!delivery?.patient_id);

      let ensuredPickupRecords = pickupRecordsFromStage;
      let stagedDeliveriesWithResolvedIds = patientDeliveriesReadyForDB;
      // Determine when to trigger route optimization on Done:
      // - Options 2/3/4 (interstore, pickup, cycling): ALWAYS optimize — new stops added to active route
      // - Option 1 (standard adds): only optimize if at least one new stop is in_transit
      //   (pending-only adds must NOT trigger optimization or polyline regeneration)
      hasInTransitTransition = newDeliveries.some((d) => d?.status === 'in_transit');
      const isActiveRouteMode = ['interstore', 'pickup', 'cycling'].includes(formData?.openMode);
      const hasNewActiveSops = newDeliveries.some((d) => d?.status && !['pending', 'Staged'].includes(d.status));
      routeStructureChanged = isActiveRouteMode ? true : hasInTransitTransition;

      // Fire KITT bar immediately — we know optimization will run after save completes
      if (routeStructureChanged && routeDriverId && routeDeliveryDate) {
        window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'edit_form_deferred', driverId: routeDriverId, deliveryDate: routeDeliveryDate } }));
        window.dispatchEvent(new CustomEvent('optimizationRunning', { detail: { driverId: routeDriverId, deliveryDate: routeDeliveryDate, active: true } }));
      }

      const patientDeliveriesNeedingPickupEnsure = patientDeliveriesReadyForDB;

      const groupedEnsureKeys = new Map();
      const defaultPickupDriverDateKeys = new Set();
      const existingStopCountByDriverDate = new Map();

      patientDeliveriesNeedingPickupEnsure.forEach((delivery) => {
        if (!delivery?.store_id || !delivery?.delivery_date || !delivery?.driver_id) return;

        const key = `${delivery.store_id}__${delivery.delivery_date}__${delivery.driver_id}__${delivery.ampm_deliveries || 'AM'}`;
        if (!groupedEnsureKeys.has(key)) groupedEnsureKeys.set(key, { delivery });

        const driverDateKey = `${delivery.driver_id}__${delivery.delivery_date}`;
        if (!existingStopCountByDriverDate.has(driverDateKey)) {
          const count = (allDeliveries || []).filter((item) => {
            if (!item || item.delivery_date !== delivery.delivery_date || item.status === 'Staged') return false;
            return item.driver_id === delivery.driver_id;
          }).length;
          existingStopCountByDriverDate.set(driverDateKey, count);
        }

        const existingStopCount = existingStopCountByDriverDate.get(driverDateKey) || 0;
        if (existingStopCount === 0) {
          defaultPickupDriverDateKeys.add(driverDateKey);
        }
      });

      console.log('[AddToRoute] Default pickup gating by assigned driver', {
        defaultPickupDriverDateKeys: Array.from(defaultPickupDriverDateKeys),
        existingStopCountByDriverDate: Object.fromEntries(existingStopCountByDriverDate),
        patientDeliveriesReadyForDBCount: patientDeliveriesReadyForDB.length,
        pickupRecordsFromStageCount: pickupRecordsFromStage.length
      });

      // GUARD: Never create default pickups for driver/dates that have any ISP/ISD stop
      // (either already on the route OR in the current batch of staged deliveries).
      for (const driverDateKey of Array.from(defaultPickupDriverDateKeys)) {
        const [driverId, deliveryDate] = driverDateKey.split('__');
        const hasInterStoreDelivery =
          (allDeliveries || []).some((d) =>
            d && d.driver_id === driverId && d.delivery_date === deliveryDate && !d.patient_id &&
            (String(d.delivery_id || '').toUpperCase().startsWith('ISP-') || String(d.delivery_id || '').toUpperCase().startsWith('ISD-') || d._interstore_source_id)
          ) ||
          (newDeliveries || []).some((d) =>
            d && d.driver_id === driverId && d.delivery_date === deliveryDate &&
            (String(d.delivery_id || '').toUpperCase().startsWith('ISP-') || String(d.delivery_id || '').toUpperCase().startsWith('ISD-') || d._interstore_source_id)
          );
        if (hasInterStoreDelivery) {
          defaultPickupDriverDateKeys.delete(driverDateKey);
        }
      }

      const defaultPickupResults = new Map();
      for (const driverDateKey of Array.from(defaultPickupDriverDateKeys)) {
        const [driverId, deliveryDate] = driverDateKey.split('__');
        const result = await base44.functions.invoke('ensureDefaultPickupsForDriver', {
          driverId,
          deliveryDate
        }).catch((error) => {
          console.error('[AddToRoute] ensureDefaultPickupsForDriver failed', { driverId, deliveryDate, error });
          return null;
        });
        defaultPickupResults.set(driverDateKey, result);
      }

      const normalizedDefaultPickups = Array.from(defaultPickupResults.entries()).flatMap(([driverDateKey, response]) => {
        const [driverId, deliveryDate] = driverDateKey.split('__');
        return [...(response?.data?.pickups || []), ...(response?.pickups || [])]
          .filter((pickup) => pickup?.id || pickup?.stop_id)
          .map((pickup) => {
            const pickupStopId = pickup?.stop_id || pickup?.puid || pickup?.id || '';
            return {
              ...pickup,
              patient_id: null,
              store_id: pickup?.store_id || pickup?.pickup_store_id || '',
              driver_id: pickup?.driver_id || driverId,
              delivery_date: pickup?.delivery_date || deliveryDate,
              ampm_deliveries: pickup?.ampm_deliveries || 'AM',
              stop_id: pickupStopId,
              puid: pickupStopId || null
            };
          });
      });

      creatorFlowEnsuredPickups = normalizedDefaultPickups;
      // NOTE: creating pickup containers does NOT by itself force routeStructureChanged —
      // see the final assignment below (routeStructureChanged = hasNewActiveSops), which is
      // the one that actually matters for the optimization decision.
      let newPickupsCreated = normalizedDefaultPickups.length > 0;

      // Build a set of driver/date pairs that already have ISP/ISD stops (no pickup needed)
      const ispIsdDriverDateKeys = new Set([
        ...(allDeliveries || [])
          .filter((d) => d && !d.patient_id && (
            String(d.delivery_id || '').toUpperCase().startsWith('ISP-') ||
            String(d.delivery_id || '').toUpperCase().startsWith('ISD-') ||
            d._interstore_source_id
          ))
          .map((d) => `${d.driver_id}__${d.delivery_date}`),
        ...(newDeliveries || [])
          .filter((d) => d && (
            String(d.delivery_id || '').toUpperCase().startsWith('ISP-') ||
            String(d.delivery_id || '').toUpperCase().startsWith('ISD-') ||
            d._interstore_source_id
          ))
          .map((d) => `${d.driver_id}__${d.delivery_date}`)
      ]);

      // Helper: resolve PUID for ISP/ISD patient deliveries from the route.
      // ISP → look for a future (not completed/cancelled) pickup stop on the To Store on the same date.
      // ISD → look back for any (including completed/en_route) pickup stop on the store on the same date.
      const resolveInterStorePuid = (delivery) => {
        const allRouteStops = [...(allDeliveries || []), ...(pickupRecordsFromStage || []), ...(normalizedDefaultPickups || [])];
        const upperDeliveryId = String(delivery.delivery_id || '').toUpperCase();
        const isISD = upperDeliveryId.startsWith('ISD-');
        const targetStoreId = delivery.store_id || '';
        if (!targetStoreId) return null;

        if (isISD) {
          // ISD: look back — prefer en_route/completed pickup on same store/driver/date
          const match = allRouteStops.find((d) =>
            d && !d.patient_id && d.store_id === targetStoreId &&
            d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date &&
            d.stop_id
          );
          return match?.stop_id || match?.puid || null;
        } else {
          // ISP: look forward — prefer a non-completed pickup on same store/driver/date
          const match = allRouteStops.find((d) =>
            d && !d.patient_id && d.store_id === targetStoreId &&
            d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date &&
            d.stop_id && !['completed', 'cancelled', 'returned'].includes(d.status)
          ) || allRouteStops.find((d) =>
            d && !d.patient_id && d.store_id === targetStoreId &&
            d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date &&
            d.stop_id
          );
          return match?.stop_id || match?.puid || null;
        }
      };

      const ensureResultsByKey = new Map();
        for (const [key, { delivery }] of Array.from(groupedEnsureKeys.entries())) {
          const driverDateKey = `${delivery.driver_id}__${delivery.delivery_date}`;

          // ISP/ISD patient deliveries: derive PUID from route, never call ensurePickupForDelivery
          const isInterStoreDelivery = String(delivery.delivery_id || '').toUpperCase().startsWith('ISP-') ||
            String(delivery.delivery_id || '').toUpperCase().startsWith('ISD-') ||
            !!delivery._interstore_source_id;
          if (isInterStoreDelivery || ispIsdDriverDateKeys.has(driverDateKey)) {
            if (isInterStoreDelivery) {
              const interStorePuid = resolveInterStorePuid(delivery);
              if (interStorePuid) {
                ensureResultsByKey.set(key, { data: { puid: interStorePuid, pickup: null } });
              }
            }
            continue;
          }

          const shouldTryDefaultOnlyFirst = defaultPickupDriverDateKeys.has(driverDateKey);

        if (shouldTryDefaultOnlyFirst) {
          const defaultPickupKey = `${delivery.store_id}__${delivery.delivery_date}__${delivery.driver_id || ''}__${delivery.ampm_deliveries || 'AM'}`;
          const existingDefaultPickup = normalizedDefaultPickups.find((pickup) =>
            `${pickup.store_id}__${pickup.delivery_date}__${pickup.driver_id || ''}__${pickup.ampm_deliveries || 'AM'}` === defaultPickupKey
          );
          if (existingDefaultPickup) {
            ensureResultsByKey.set(key, { data: { pickup: existingDefaultPickup, puid: existingDefaultPickup.stop_id || existingDefaultPickup.puid || '' } });
            continue;
          }
        }

        const result = await base44.functions.invoke('ensurePickupForDelivery', {
          storeId: delivery.store_id,
          deliveryDate: delivery.delivery_date,
          driverId: delivery.driver_id,
          ampmDeliveries: delivery.ampm_deliveries || 'AM',
          allowCreateIfMissing: true
        }).catch((error) => {
          console.error('[AddToRoute] ensurePickupForDelivery failed', { key, error });
          return null;
        });
        ensureResultsByKey.set(key, result);
      }

      const ensuredPickups = patientDeliveriesNeedingPickupEnsure.map((delivery) => {
        if (!delivery?.store_id || !delivery?.delivery_date || !delivery?.driver_id) return null;
        const key = `${delivery.store_id}__${delivery.delivery_date}__${delivery.driver_id}__${delivery.ampm_deliveries || 'AM'}`;
        return ensureResultsByKey.get(key) || null;
      });

      const ensuredPickupsCreated = ensuredPickups.some((result) => result?.data?.pickup);
      newPickupsCreated = newPickupsCreated || ensuredPickupsCreated;
      
      ensuredPickupRecords = Array.from(new Map(
        [
          ...normalizedDefaultPickups,
          ...ensuredPickups.map((result) => result?.data?.pickup),
          ...pickupRecordsFromStage
        ]
          .filter((pickup) => pickup?.id || pickup?.stop_id)
          .map((pickup) => [pickup.id || pickup.stop_id, pickup])
      ).values());
      
      // CRITICAL FIX: Newly-created/ensured pickup CONTAINERS are always persisted with
      // status 'en_route' by design (that's just their resting/default status — it does NOT
      // mean the driver started moving). Treating that as an "active pickup created" signal
      // previously forced routeStructureChanged=true (and triggered the HERE optimizer +
      // orange "Optimizing Route" banner) on essentially EVERY normal "stage some patient
      // stops, click Done" workflow, since staging a store's first stop of the day always
      // needs a fresh pickup container. That's exactly the "staged→pending shouldn't hit the
      // HERE API" case the user reported. Route structure only actually needs re-optimization
      // when one of the newly staged DELIVERIES itself is genuinely active (e.g. in_transit —
      // the driver is being told to go there right now), which hasNewActiveSops already
      // captures from the user-set status. Pickup-container creation alone must never force it.
      // routeStructureChanged is already set correctly above (isActiveRouteMode or hasInTransitTransition).

      const ensuredPickupByKey = new Map(
        ensuredPickupRecords
          .filter((pickup) => pickup && !pickup.patient_id)
          .map((pickup) => [`${pickup.store_id}__${pickup.delivery_date}__${pickup.driver_id || ''}__${pickup.ampm_deliveries || 'AM'}`, pickup])
      );

      stagedDeliveriesWithResolvedIds = patientDeliveriesReadyForDB.map((delivery) => {
        if (delivery?.status === 'in_transit') {
          return delivery;
        }
        const key = `${delivery.store_id}__${delivery.delivery_date}__${delivery.driver_id || ''}__${delivery.ampm_deliveries || 'AM'}`;
        const ensuredPickup = ensuredPickupByKey.get(key);
        return {
          ...delivery,
          // Never overwrite an existing puid
          puid: delivery.puid || ensuredPickup?.stop_id || ''
          // puid: ensuredPickup?.stop_id || delivery.puid || ''
        };
      });

      await onSave({ _isBatchSave: true, _stagedDeliveries: stagedDeliveriesWithResolvedIds, _ensuredPickups: ensuredPickupRecords });
      if (creatorFlowEnsuredPickups.length > 0) {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            immediate: true,
            freshDeliveries: creatorFlowEnsuredPickups,
            deliveryDate: routeDeliveryDate,
            driverId: stagedDeliveriesWithResolvedIds[0]?.driver_id || routeDriverId,
            triggeredBy: 'ensureDefaultPickupsForDriver'
          }
        }));
      }
    }

    // CLOSE THE FORM IMMEDIATELY after data is saved, before background operations
    resetBatchSaveDraftState({
      setStagedDeliveries,
      setProjectedDeliveries,
      setHasPendingDeletes,
      setHasChanges,
      hasLoadedPendingRef: hasLoadedPending,
      unblockPredictions,
      setIsLoadingPredictions
    });
    closeBatchFormThenResumeManagers({ handleClearForm, onCancel });

    Promise.resolve().then(async () => {
      try {
        const squarePromises = deliveriesReadyForDB.filter(d => d.cod_total_amount_required > 0 && d.patient_id && d.driver_id && d.status === 'in_transit').map(delivery => {
          const store = stores?.find(s => s && s.id === delivery.store_id);
          return base44.functions.invoke('squareCreateCodItem', { deliveryId: delivery.id || delivery._tempId, patientName: delivery.patient_name, storeAbbreviation: store?.abbreviation || '', codAmount: delivery.cod_total_amount_required, deliveryDate: delivery.delivery_date, storeId: delivery.store_id }).then(() => null).catch(() => null);
        });
        if (squarePromises.length > 0) await Promise.allSettled(squarePromises);

        // Handle COD payment type changes: delete for Debit/Credit, recreate for Cash/Check
        const squarePaymentChangePromises = deliveriesToUpdate.map(updated => {
          const original = allDeliveries?.find(d => d?.id === updated?.id);
          if (!original || !updated) return null;

          const originalAmount = original.cod_total_amount_required || 0;
          const updatedAmount = updated.cod_total_amount_required || 0;
          const originalPayments = original.cod_payments || [];
          const updatedPayments = updated.cod_payments || [];

          const originalHasDebitCredit = originalPayments.some(p => p.type === 'Debit' || p.type === 'Credit');
          const updatedHasDebitCredit = updatedPayments.some(p => p.type === 'Debit' || p.type === 'Credit');
          const updatedHasCashCheck = updatedPayments.some(p => p.type === 'Cash' || p.type === 'Check');

          // Delete catalog item if payment changed to Debit/Credit
          if (!originalHasDebitCredit && updatedHasDebitCredit && updatedAmount > 0) {
            return base44.functions.invoke('squareDeleteCodItem', { deliveryId: updated.id }).then(() => null).catch(() => null);
          }

          // Recreate catalog item if payment changed to Cash/Check and amount > 0
          if (!updatedHasDebitCredit && updatedHasCashCheck && updatedAmount > 0) {
            const store = stores?.find(s => s && s.id === updated.store_id);
            return base44.functions.invoke('squareCreateCodItem', { 
              deliveryId: updated.id, 
              patientName: updated.patient_name, 
              storeAbbreviation: store?.abbreviation || '', 
              codAmount: updatedAmount, 
              deliveryDate: updated.delivery_date, 
              storeId: updated.store_id 
            }).then(() => null).catch(() => null);
          }

          return null;
        }).filter(Boolean);

        if (squarePaymentChangePromises.length > 0) await Promise.allSettled(squarePaymentChangePromises);

        // Resume ALL syncs via the unified helper
        try {
          const { smartRefreshManager } = await import('../utils/smartRefreshManager'); smartRefreshManager.restart();
        } catch { /* non-fatal */ }
        try { const { backgroundSyncManager } = await import('../utils/backgroundSyncManager'); backgroundSyncManager.resume(); } catch { /* non-fatal */ }
        try { const { resumeRealtimeSync } = await import('../utils/realtimeSync'); resumeRealtimeSync(); } catch { /* non-fatal */ }
        try { const { exitBatchSilentMode } = await import('../utils/entityMutations'); exitBatchSilentMode(); } catch { /* non-fatal */ }
        setBatchFormSaving(false);

        // Broadcast finalized delivery IDs so all subscribers get a targeted update
        const finalizedIds = [
          ...(deliveriesReadyForDB || []).map(d => d?.id),
          ...(deliveriesToUpdate || []).map(d => d?.id),
        ].filter(Boolean);
        if (finalizedIds.length > 0) {
          window.dispatchEvent(new CustomEvent('deliveriesAffected', {
            detail: { ids: finalizedIds, action: 'batchSaveDone', driverId: routeDriverId, deliveryDate: routeDeliveryDate }
          }));
        }

        const hasOnlyPendingOrStagedChanges = [...deliveriesReadyForDB, ...existingDeliveriesWithTRs]
          .filter(Boolean)
          .every((delivery) => ['pending', 'Staged'].includes(String(delivery?.status || '')));

        const refreshDriverId = routeDriverId || deliveriesReadyForDB.find((delivery) => delivery?.patient_id)?.driver_id || existingDeliveriesWithTRs[0]?.driver_id || formData.driver_id;
        const refreshDeliveryDate = routeDeliveryDate || deliveriesReadyForDB.find((delivery) => delivery?.patient_id)?.delivery_date || existingDeliveriesWithTRs[0]?.delivery_date || formData.delivery_date;

        if (!hasOnlyPendingOrStagedChanges && !(deliveriesToUpdate.length > 0 && newDeliveries.length === 0)) {
          // Only run the full refresh for non-pending structural changes.
          // Pending-only / Staged→Pending transitions are already dispatched by handleBatchSaveDelivery.
          await runCreateBatchRefresh({ refreshDriverId, refreshDeliveryDate });
        }

        if (refreshDriverId && refreshDeliveryDate) {
          await base44.functions.invoke('recalculateTrackingNumbers', {
            driverId: refreshDriverId,
            deliveryDate: refreshDeliveryDate
          }).catch(() => null);

          // CRITICAL: Only queue optimization for structural route changes.
          // Pure staged→pending transitions (deliveriesToUpdate > 0, newDeliveries === 0)
          // must NEVER trigger optimization or polyline regeneration — they don't change
          // the active route and should never show the orange overlay or hit the HERE API.
          const isPureStagedToPendingTransition = newDeliveries.length === 0 && deliveriesToUpdate.length > 0;
          if (routeStructureChanged && !isPureStagedToPendingTransition) {
            requestDeferredOptimization(refreshDriverId, refreshDeliveryDate, true);
          }
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
    // Resume ALL syncs on error
    try { const { smartRefreshManager } = await import('../utils/smartRefreshManager'); smartRefreshManager.restart(); } catch { /* non-fatal */ }
    try { const { backgroundSyncManager } = await import('../utils/backgroundSyncManager'); backgroundSyncManager.resume(); } catch { /* non-fatal */ }
    try { const { resumeRealtimeSync } = await import('../utils/realtimeSync'); resumeRealtimeSync(); } catch { /* non-fatal */ }
    try { const { exitBatchSilentMode } = await import('../utils/entityMutations'); exitBatchSilentMode(); } catch { /* non-fatal */ }
    setBatchFormSaving(false);
  } finally {
    batchSaveLockRef.current = false;
    setIsSaving(false);
  }
}