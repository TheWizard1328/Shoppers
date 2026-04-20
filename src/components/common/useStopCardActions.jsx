import { useCallback } from "react";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";
import { setDriverStatus } from "@/functions/setDriverStatus";
import { locationTracker } from "../utils/locationTracker";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import { deleteCODWithTimeout } from '../utils/squareCODHandler';
import { cleanupSquareCodCatalogForDate } from '../utils/squareCodCatalogCleanup';
import { createDeliveryLocal, updateDeliveryLocal } from '../utils/offlineMutations';
import { queueDeliveryUpdate, flushQueuedDeliveryUpdates } from '../utils/updateBatcher';
import { fabControlEvents } from '../utils/fabControlEvents';
import { invalidate } from '../utils/dataManager';
import { generateCompletionTimestamp, calculateRetroactiveStopTiming, parseLocalTimestamp, shouldUseRegularTiming } from '../utils/timeRoundingHelper';
import { generateUniqueSID } from '../dashboard/DashboardHelpers';
import { buildRetryDelivery, collapseExpandedStopCardsForDriver, getCurrentLocalTimeString, getDriverRouteDeliveries, getFinishedLegEncodedPolyline, getNextActiveDelivery, getNextTrackingNumberInGroup, incrementTrackingNumber, optimizeRouteAndApplyNextDelivery, reorderActiveRouteLocally, setAndCenterNextDelivery, syncDriverLocationToStop, waitForRouteTransitionSettle, withPausedDriverLocationPoller } from "./stopCardActionHelpers";
import { clearPendingBreadcrumbsForDelivery, getPendingBreadcrumbsForDelivery } from '../utils/pendingBreadcrumbsManager';
import { appendBoundaryBreadcrumbPoints } from '../utils/breadcrumbBoundaryPoints';
import { runTerminalDeliverySideEffects, triggerSquareCodUpsert } from '../utils/directDeliverySideEffects';
import { runWithDeliveryActionLock } from '../utils/deliveryActionLock';
import { pauseOfflineSync, resumeOfflineSync } from '../utils/offlineSync';
import { notifyDriverAcceptedAll, notifyDispatcherAssignedAll, notifyDriverStarted, notifyDriverCompleted, notifyDriverFailed, notifyDriverRetry, notifyDriverReturn } from "../utils/deliveryMessaging";

const START_ACTION_NAME = 'start_delivery';
const ETA_REFRESH_THRESHOLD_MINUTES = 5;

const parseTimeToMinutes = (timeString) => {
  if (!timeString || typeof timeString !== 'string') return null;
  const [hours, minutes] = timeString.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
};

const shouldRefreshRemainingEtas = (etaString, actualTimestamp) => {
  const etaMinutes = parseTimeToMinutes(etaString);
  const actualDate = parseLocalTimestamp(actualTimestamp);
  if (etaMinutes === null || !actualDate) return false;
  const actualMinutes = actualDate.getHours() * 60 + actualDate.getMinutes();
  return Math.abs(actualMinutes - etaMinutes) > ETA_REFRESH_THRESHOLD_MINUTES;
};

const hasDebitOrCreditCod = (deliveryRecord, paymentList = null) => {
  const payments = Array.isArray(paymentList) ? paymentList : deliveryRecord?.cod_payments;
  if (Array.isArray(payments) && payments.some((payment) => ['Debit', 'Credit'].includes(payment?.type) && Number(payment?.amount || 0) > 0)) return true;
  return ['Debit', 'Credit'].includes(deliveryRecord?.cod_payment_type);
};

export default function useStopCardActions(params) {
  const {
    delivery,
    store,
    patient,
    patients,
    stores,
    drivers,
    appUsers,
    allDeliveries,
    pendingPickups,
    currentUser,
    displayName,
    isPickup,
    isExpanded,
    isSelected,
    localDeviceTodayStr,
    localNowParts,
    shouldPreserveWindowTimesOnStart,
    currentDriverAppUser,
    safeDriver,
    codPayments,
    setCodPayments,
    hasCODRequired,
    codTotalRequired,
    codTotalCollected,
    onClick,
    onCODUpdate,
    onCreateReturn,
    onStatusUpdate,
    onDriverStatusChange,
    userHasRole,
    forceRefreshDriverDeliveries,
    updateDeliveriesLocally,
    setIsEntityUpdating,
    isCurrentCardStartLocked,
    isGlobalStartLocked,
    isGlobalCompleteLocked,
    isGlobalRestartLocked,
    isStarting,
    setIsStarting,
    isCompleting,
    setIsCompleting,
    isRetrying,
    setIsRetrying,
    isRestarting,
    setIsRestarting,
    isFailing,
    setIsFailing,
    isProcessingBackground,
    setIsProcessingBackground,
    isAcceptingAll,
    setIsAcceptingAll,
    isPreparingReturn,
    setIsPreparingReturn,
    isCreatingReturn,
    setIsCreatingReturn,
    returnPatient,
    setReturnPatient,
    showReturnConfirm,
    setShowReturnConfirm,
    pendingFailureStatus,
    setPendingFailureStatus,
    setShowFailureReasonDialog,
    startTapLockRef,
    completeTapLockRef,
    actionTapLockRef,
    FINISHED_STATUSES,
    getCurrentLocalTime,
    currentUserCanTrack = true,
    setViewingImageUrl,
    setShowSignatureCapture,
    setShowPhotoCapture,
    showSignatureCapture,
    showPhotoCapture
  } = params;

  const ensureDriverOnline = useCallback(async () => {
    if (!currentUser?.id || currentUser.id !== delivery?.driver_id) return;
    if (delivery?.delivery_date !== localDeviceTodayStr) return;
    try {
      const { data } = await setDriverStatus({ newStatus: 'on_duty' });
      try { await locationTracker.startTracking({ ...currentUser, appUserId: data?.appUserId }); } catch {}
      if (onDriverStatusChange) onDriverStatusChange('on_duty');
    } catch (error) {
      console.error('Failed to auto-toggle driver online:', error);
    }
  }, [currentUser, delivery?.driver_id, delivery?.delivery_date, localDeviceTodayStr, onDriverStatusChange]);

  const resetActionLocks = useCallback((skipCardScroll = true) => {
    startTapLockRef.current = false;
    completeTapLockRef.current = false;
    actionTapLockRef.current = false;
    setIsStarting(false);
    setIsCompleting(false);
    setIsFailing(false);
    setIsRetrying(false);
    setIsRestarting(false);
    setIsProcessingBackground(false);
    setIsEntityUpdating(false);
    fabControlEvents.reactivateFAB(skipCardScroll);
  }, [setIsCompleting, setIsEntityUpdating, setIsFailing, setIsProcessingBackground, setIsRestarting, setIsRetrying, setIsStarting, actionTapLockRef, completeTapLockRef, startTapLockRef]);

  const shouldCondenseCardOnAction = useCallback(() => {
    if (!isSelected) return false;
    const cardElement = document.getElementById(`stop-card-${delivery?.id}`);
    const cardSurface = cardElement?.querySelector('.rounded-xl');
    if (!cardSurface) return false;
    return cardSurface.offsetHeight > 72;
  }, [delivery?.id, isSelected]);

  const collapseDriverStopCards = useCallback(async () => {
    if (!shouldCondenseCardOnAction()) return;
    await collapseExpandedStopCardsForDriver(delivery?.driver_id);
  }, [delivery?.driver_id, shouldCondenseCardOnAction]);

  const blockCardToggle = useCallback((e, options = {}) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (isExpanded && !options.keepExpanded) onClick?.(null);
    actionTapLockRef.current = true;
    window.setTimeout(() => { actionTapLockRef.current = false; }, 350);
  }, [actionTapLockRef, isExpanded, onClick]);

  const handleAddCODPayment = useCallback(() => {
    const remainingAmount = codTotalRequired - codTotalCollected;
    const newPayment = { type: 'Cash', amount: Math.max(0, remainingAmount) };
    setCodPayments((prev) => [...prev, newPayment]);
  }, [codTotalCollected, codTotalRequired, setCodPayments]);

  const executeAcceptAllStops = useCallback(async () => {
    pauseOfflineSync('delivery_actions');
    setIsAcceptingAll(true);
    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    try {
      driverLocationPoller.pause();
      smartRefreshManager.pause();
      setIsEntityUpdating(true);
      const allPendingDeliveries = pendingPickups.filter((p) => p.status === 'pending');
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const startMinutes = currentMinutes + 5;
      const deliveryTimeStart = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
      const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const sortedPending = [...allPendingDeliveries].sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));

      const localUpdates = sortedPending.map((pendingDelivery, i) => ({
        id: pendingDelivery.id,
        status: 'in_transit',
        delivery_time_start: deliveryTimeStart,
        tracking_number: incrementTrackingNumber(delivery.tracking_number, i + 1),
        isNextDelivery: false,
        ...(pendingDelivery.active === false ? { active: true } : {})
      }));

      await Promise.all(localUpdates.map((update) => updateDeliveryLocal(update.id, update, { skipSmartRefresh: true })));
      fabControlEvents.notifyAcceptAllClicked();
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAll', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true } }));
      window.dispatchEvent(new CustomEvent('pendingToInTransit', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));

      const codBatch = allPendingDeliveries.filter((pd) => pd.cod_total_amount_required > 0 && pd.patient_id).map((pendingDelivery) => {
        const storeForCod = stores.find((s) => s && s.id === pendingDelivery.store_id);
        return {
          deliveryId: pendingDelivery.id,
          patientName: pendingDelivery.patient_name,
          storeAbbreviation: storeForCod?.abbreviation || '',
          codAmount: pendingDelivery.cod_total_amount_required,
          deliveryDate: pendingDelivery.delivery_date,
          storeId: pendingDelivery.store_id
        };
      });

      sortedPending.forEach((pendingDelivery, i) => {
        queueDeliveryUpdate(pendingDelivery.id, {
          status: 'in_transit',
          delivery_time_start: deliveryTimeStart,
          tracking_number: incrementTrackingNumber(delivery.tracking_number, i + 1),
          ...(pendingDelivery.active === false ? { active: true } : {})
        });
      });

      await flushQueuedDeliveryUpdates();
      invalidate('Delivery');
      await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

      Promise.resolve().then(async () => {
        window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
        try {
          const optimizeResponse = await base44.functions.invoke('optimizeRouteRealTime', { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime, generatePolyline: false });
          const optimizeData = optimizeResponse?.data || optimizeResponse;
          if (optimizeData?.success && Array.isArray(optimizeData.optimizedRoute) && optimizeData.optimizedRoute.length > 0) {
            window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { driverId: delivery.driver_id, updates: optimizeData.optimizedRoute.map((stop) => ({ deliveryId: stop.deliveryId || stop.delivery_id, newEta: stop.newETA || stop.eta })).filter((stop) => stop.deliveryId && stop.newEta) } }));
            window.dispatchEvent(new CustomEvent('routeReordered', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, source: 'acceptAllAutoOptimize' } }));
          }
          invalidate('Delivery');
          await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
          const refreshedRouteDeliveries = await base44.entities.Delivery.filter({ driver_id: delivery.driver_id, delivery_date: delivery.delivery_date });
          const nextOptimizedStop = getNextActiveDelivery(refreshedRouteDeliveries, null, FINISHED_STATUSES);
          await setAndCenterNextDelivery({ driverDeliveries: refreshedRouteDeliveries, targetDeliveryId: nextOptimizedStop?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
        } catch (optErr) {
          console.warn('⚠️ [Accept All] background optimization failed:', optErr?.message || optErr);
        } finally {
          window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAllOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true } }));
        }
      });

      if (codBatch.length > 0) {
        base44.functions.invoke('syncSquareCods', { items: codBatch }).catch((e) => console.warn('⚠️ [Square] Batch COD sync failed to start:', e));
      }

      const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id;
      if (isDriverAction) {
        notifyDriverAcceptedAll({ driver: currentUser, store, appUsers }).catch(() => {});
      } else {
        const assignedDriver = drivers.find((d) => d?.id === delivery.driver_id);
        if (assignedDriver) notifyDispatcherAssignedAll({ dispatcher: currentUser, driver: assignedDriver, store, deliveries: allPendingDeliveries, patients }).catch(() => {});
      }
    } catch (error) {
      console.error('❌ [Accept All] Error:', error);
      toast.error(`Failed to accept all: ${error.message}`);
      throw error;
    } finally {
      resumeOfflineSync('delivery_actions');
      driverLocationPoller.resume();
      smartRefreshManager.resume();
      setIsEntityUpdating(false);
      setIsAcceptingAll(false);
      onClick?.(null);
    }
  }, [FINISHED_STATUSES, appUsers, currentUser, delivery, drivers, forceRefreshDriverDeliveries, onClick, patients, pendingPickups, setIsAcceptingAll, setIsEntityUpdating, store, stores, updateDeliveriesLocally, userHasRole]);

  const handleAcceptAllStops = useCallback(async () => {
    const lockResult = await runWithDeliveryActionLock('accept_all_delivery', async () => {
      await executeAcceptAllStops();
    });
    if (lockResult?.skipped) return;
  }, [executeAcceptAllStops]);

  const handleReturnClick = useCallback(async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (isPreparingReturn || showReturnConfirm) return;
    blockCardToggle(e, { keepExpanded: true });
    setIsPreparingReturn(true);
    try {
      const resolvedStore = store || stores.find((s) => s && s.id === delivery?.store_id);
      if (!delivery || !resolvedStore) return;
      const returnPatientName = `${resolvedStore.name.replace(/-/g, ' ')} Return`;
      const foundReturnPatient = patients.find((p) => p && p.full_name === returnPatientName && p.store_id === delivery.store_id);
      if (!foundReturnPatient) return;
      setReturnPatient(foundReturnPatient);
      setShowReturnConfirm(true);
    } finally {
      setIsPreparingReturn(false);
    }
  }, [blockCardToggle, delivery, isPreparingReturn, patients, setIsPreparingReturn, setReturnPatient, setShowReturnConfirm, showReturnConfirm, store, stores]);

  const handleConfirmReturn = useCallback(async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (!onCreateReturn || !returnPatient || isCreatingReturn) return;
    setIsCreatingReturn(true);
    const selectedReturnPatient = returnPatient;
    const resolvedStore = store || stores.find((s) => s && s.id === delivery?.store_id);
    try {
      await onCreateReturn({ originalDelivery: delivery, returnPatient: selectedReturnPatient, store: resolvedStore, _skipPickupCreation: true });
      setShowReturnConfirm(false);
      setReturnPatient(null);
      onClick?.(null);
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'return', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      Promise.resolve().then(async () => {
        try {
          const backgroundTasks = [];
          if ((delivery.cod_total_amount_required || 0) > 0) backgroundTasks.push(deleteCODWithTimeout(delivery.id, 'Removed after creating return delivery'));
          backgroundTasks.push((async () => {
            await optimizeRouteAndApplyNextDelivery({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime: getCurrentLocalTimeString(), updateDeliveryLocal, updateDeliveriesLocally, forceRefreshDriverDeliveries, generatePolyline: false });
          })());
          if (userHasRole(currentUser, 'driver')) backgroundTasks.push(notifyDriverReturn({ driver: currentUser, patientName: displayName, delivery, store, appUsers }));
          await Promise.allSettled(backgroundTasks);
        } catch {}
      });
    } finally {
      setIsCreatingReturn(false);
    }
  }, [appUsers, currentUser, delivery, displayName, forceRefreshDriverDeliveries, isCreatingReturn, onClick, onCreateReturn, returnPatient, setIsCreatingReturn, setReturnPatient, setShowReturnConfirm, store, stores, updateDeliveriesLocally, userHasRole]);

  const handleCancelReturn = useCallback((e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setShowReturnConfirm(false);
    setReturnPatient(null);
  }, [setReturnPatient, setShowReturnConfirm]);

  const handleRetryDelivery = useCallback(async (e) => {
    blockCardToggle(e, { keepExpanded: true });
    const lockResult = await runWithDeliveryActionLock('retry_delivery', async () => {
      pauseOfflineSync('delivery_actions');
      fabControlEvents.deactivateFAB();
      setIsRetrying(true);
      setIsProcessingBackground(true);
      try {
        await withPausedDriverLocationPoller(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const retryTrackingNumber = getNextTrackingNumberInGroup(delivery.tracking_number, allDeliveries, delivery.driver_id, delivery.delivery_date);
          const retryDraft = buildRetryDelivery(delivery, retryTrackingNumber);
          const retryDate = retryDraft.delivery_date;
          const retryDateDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === retryDate);
          const newRetryDelivery = await createDeliveryLocal({ ...retryDraft, stop_id: generateUniqueSID(retryDateDeliveries), puid: delivery.puid || delivery.stop_id || null, ampm_deliveries: delivery.ampm_deliveries, tracking_number: String(retryTrackingNumber), _skipPickupCreation: true });
          if ((delivery.cod_total_amount_required || 0) > 0) {
            await deleteCODWithTimeout(delivery.id, 'Removed after creating retry delivery');
            const retryDeliveryId = newRetryDelivery?.id || newRetryDelivery?.data?.id;
            if (retryDeliveryId && !isPickup) triggerSquareCodUpsert({ deliveryId: retryDeliveryId, patientName: patient?.full_name || 'Patient', storeAbbreviation: store?.abbreviation || '', codAmount: delivery.cod_total_amount_required, deliveryDate: retryDate, storeId: delivery.store_id });
          }
          await ensureDriverOnline();
          try {
            await optimizeRouteAndApplyNextDelivery({ driverId: delivery.driver_id, deliveryDate: retryDate, currentLocalTime: getCurrentLocalTimeString(), updateDeliveryLocal, updateDeliveriesLocally, forceRefreshDriverDeliveries, generatePolyline: false });
          } catch {}
          if (userHasRole(currentUser, 'driver')) await notifyDriverRetry({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery, store, appUsers });
        });
      } finally {
        resumeOfflineSync('delivery_actions');
        resetActionLocks(true);
      }
    });
    if (lockResult?.skipped) return;
  }, [allDeliveries, appUsers, blockCardToggle, delivery, displayName, ensureDriverOnline, forceRefreshDriverDeliveries, isPickup, patient?.full_name, resetActionLocks, setIsProcessingBackground, setIsRetrying, store, updateDeliveriesLocally, userHasRole, currentUser]);

  const restartCurrentDelivery = useCallback(async () => {
    const lockResult = await runWithDeliveryActionLock('restart_delivery', async () => {
      pauseOfflineSync('delivery_actions');
      fabControlEvents.deactivateFAB();
      setIsRestarting(true);
      setIsEntityUpdating(true);
      setIsProcessingBackground(true);
      try {
        await withPausedDriverLocationPoller(async () => {
          await collapseDriverStopCards();
          await new Promise((resolve) => setTimeout(resolve, 100));
          const driverDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
          const newStatus = isPickup ? 'en_route' : 'in_transit';
          const restartedRouteDeliveries = reorderActiveRouteLocally(driverDeliveries.map((item) => item?.id === delivery.id ? { ...item, status: newStatus, isNextDelivery: true, actual_delivery_time: null, delivery_notes: '', finished_leg_encoded_polyline: null, travel_dist: 0, PolylineUpdated: false } : { ...item, isNextDelivery: false }), delivery.id);
          await Promise.all(restartedRouteDeliveries.filter((item) => item && (item.id === delivery.id || item.isNextDelivery === false)).map((item) => {
            const existingRouteItem = driverDeliveries.find((routeItem) => routeItem?.id === item.id);
            if (!existingRouteItem) return Promise.resolve(null);
            const updates = {};
            if (existingRouteItem.status !== item.status) updates.status = item.status;
            if ((existingRouteItem.isNextDelivery || false) !== (item.isNextDelivery || false)) updates.isNextDelivery = item.isNextDelivery || false;
            if ((existingRouteItem.actual_delivery_time || null) !== (item.actual_delivery_time || null)) updates.actual_delivery_time = item.actual_delivery_time ?? null;
            if ((existingRouteItem.delivery_notes || '') !== (item.delivery_notes || '')) updates.delivery_notes = item.delivery_notes || '';
            if ((existingRouteItem.finished_leg_encoded_polyline || null) !== (item.finished_leg_encoded_polyline || null)) updates.finished_leg_encoded_polyline = item.finished_leg_encoded_polyline || null;
            if ((existingRouteItem.PolylineUpdated || false) !== (item.PolylineUpdated || false)) updates.PolylineUpdated = item.PolylineUpdated || false;
            if (Object.keys(updates).length === 0) return Promise.resolve(null);
            return updateDeliveryLocal(item.id, updates, { skipSmartRefresh: true });
          }));

          if (updateDeliveriesLocally) {
            const restartedMap = new Map(restartedRouteDeliveries.filter(Boolean).map((d) => [d.id, d]));
            const updatedDeliveries = allDeliveries.map((d) => {
              if (!d || d.driver_id !== delivery.driver_id || d.delivery_date !== delivery.delivery_date) return d;
              if (restartedMap.has(d.id)) return restartedMap.get(d.id);
              if (d.id !== delivery.id && d.isNextDelivery) return { ...d, isNextDelivery: false };
              return d;
            });
            updateDeliveriesLocally(updatedDeliveries, true);
          }

          if ((delivery.cod_total_amount_required || 0) > 0 && !isPickup) triggerSquareCodUpsert({ deliveryId: delivery.id, patientName: patient?.full_name || delivery.patient_name || 'Patient', storeAbbreviation: store?.abbreviation || '', codAmount: delivery.cod_total_amount_required, deliveryDate: delivery.delivery_date, storeId: delivery.store_id });

          let restartOptimizeData = null;
          try {
            const optimizationResult = await optimizeRouteAndApplyNextDelivery({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime: getCurrentLocalTimeString(), updateDeliveryLocal, updateDeliveriesLocally, forceRefreshDriverDeliveries, generatePolyline: false });
            restartOptimizeData = optimizationResult?.optimizeData || null;
          } catch {}

          if (restartOptimizeData?.success && Array.isArray(restartOptimizeData.optimizedRoute) && restartOptimizeData.optimizedRoute.length > 0) {
            window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { driverId: delivery.driver_id, updates: restartOptimizeData.optimizedRoute.map((stop) => ({ deliveryId: stop.deliveryId || stop.delivery_id, newEta: stop.newETA || stop.eta })).filter((stop) => stop.deliveryId && stop.newEta) } }));
          }

          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'restart', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true, suppressFabIfPhase1: true } }));
          window.dispatchEvent(new CustomEvent('deliveryStatusChanged', { detail: { triggeredBy: 'restart', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, maxStops: 5 } }));
          if (userHasRole(currentUser, 'driver')) await notifyDriverRetry({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery, store, appUsers });
        });
      } finally {
        resumeOfflineSync('delivery_actions');
        resetActionLocks(true);
      }
    });
    if (lockResult?.skipped) return;
  }, [allDeliveries, appUsers, collapseDriverStopCards, currentUser, delivery, displayName, forceRefreshDriverDeliveries, isPickup, patient?.full_name, resetActionLocks, setIsEntityUpdating, setIsProcessingBackground, setIsRestarting, store, updateDeliveriesLocally, userHasRole]);

  const handleStartAction = useCallback(async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (isCurrentCardStartLocked || isProcessingBackground || isCompleting || isFailing || isRetrying || isRestarting) return;
    if (isGlobalStartLocked && !isStarting) return;

    startTapLockRef.current = true;
    setIsStarting(true);
    setIsEntityUpdating(true);
    setIsProcessingBackground(true);
    fabControlEvents.deactivateFAB();

    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    driverLocationPoller.pause();
    smartRefreshManager.pause();

    const lockResult = await runWithDeliveryActionLock(START_ACTION_NAME, async () => {
      if (!delivery?.id || !delivery?.driver_id || !delivery?.delivery_date) {
        resetActionLocks(true);
        return;
      }
      pauseOfflineSync('delivery_actions');
      try {
        const now = new Date();
        const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const isValidObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
        if (!isValidObjectId(delivery.id) || !isValidObjectId(delivery.driver_id)) throw new Error('This stop is still syncing. Please try again in a moment.');

        const routeDeliveries = getDriverRouteDeliveries(allDeliveries, delivery);
        await collapseDriverStopCards();

        const startedRouteDeliveries = routeDeliveries.map((d) => {
          if (!d) return d;
          const isCurrent = d.id === delivery.id;
          return {
            ...d,
            ...(isCurrent ? {
              status: isPickup ? 'en_route' : 'in_transit',
              ...(shouldPreserveWindowTimesOnStart ? {} : { delivery_time_start: currentLocalTime, delivery_time_end: currentLocalTime }),
              delivery_time_eta: currentLocalTime,
              isNextDelivery: true
            } : {})
          };
        });

        const { offlineDB } = await import('../utils/offlineDatabase');
        const startedChangedDeliveries = startedRouteDeliveries.filter((item) => {
          const existing = routeDeliveries.find((routeItem) => routeItem?.id === item?.id);
          return existing && JSON.stringify(existing) !== JSON.stringify(item);
        });

        if (startedChangedDeliveries.length > 0) await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, startedChangedDeliveries.filter(Boolean));

        if (updateDeliveriesLocally) {
          const optimisticMap = new Map(startedRouteDeliveries.filter(Boolean).map((d) => [d.id, d]));
          const updatedDeliveries = allDeliveries.map((d) => d && optimisticMap.has(d.id) ? optimisticMap.get(d.id) : d);
          updateDeliveriesLocally(updatedDeliveries, true);
        }

        await setAndCenterNextDelivery({ driverDeliveries: startedRouteDeliveries, targetDeliveryId: delivery.id, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
        window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { updates: [{ deliveryId: delivery.id, newEta: currentLocalTime }] } }));
        window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: delivery.id } }));
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true } }));
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

        Promise.resolve().then(async () => {
          window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          try {
            if (!delivery?.id || !delivery?.driver_id || !delivery?.delivery_date) return;
            const startResponse = await base44.functions.invoke('handleStartDelivery', { deliveryId: delivery.id, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
            const startData = startResponse?.data || startResponse || {};
            const backendOptimizedRoute = Array.isArray(startData?.optimization?.optimizedRoute) ? startData.optimization.optimizedRoute : [];
            if (backendOptimizedRoute.length > 0) {
              window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { updates: backendOptimizedRoute.map((u) => ({ deliveryId: u.deliveryId || u.delivery_id, newEta: u.eta || u.newETA })) } }));
            }
            fabControlEvents.reactivatePhaseTwoIfAvailable();
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'startOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true, preserveLocalState: true } }));
          } catch (optErr) {
            const isNotFound = optErr?.status === 404 || optErr?.response?.status === 404 || String(optErr?.message || '').includes('404');
            if (!isNotFound) console.warn('⚠️ [Start] background optimization failed:', optErr?.message || optErr);
          } finally {
            window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          }
        });

        Promise.all([
          ensureDriverOnline(),
          userHasRole(currentUser, 'driver') && currentUser.id === delivery.driver_id ? notifyDriverStarted({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers }) : Promise.resolve()
        ]).catch(() => {});
      } catch (error) {
        toast.error(`Failed to start: ${error.message}`);
      } finally {
        resumeOfflineSync('delivery_actions');
        driverLocationPoller.resume();
        smartRefreshManager.resume();
        resetActionLocks(true);
      }
    });

    if (lockResult?.skipped) return;
  }, [allDeliveries, appUsers, collapseDriverStopCards, currentUser, delivery, ensureDriverOnline, isCompleting, isCurrentCardStartLocked, isFailing, isGlobalStartLocked, isPickup, isProcessingBackground, isRestarting, isRetrying, isStarting, patient?.full_name, resetActionLocks, setIsEntityUpdating, setIsProcessingBackground, setIsStarting, shouldPreserveWindowTimesOnStart, store, updateDeliveriesLocally, userHasRole]);

  const handleCompleteAction = useCallback(async (e) => {
    blockCardToggle(e);
    if (completeTapLockRef.current || isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked) return;
    completeTapLockRef.current = true;
    const lockResult = await runWithDeliveryActionLock('complete_delivery', async () => {
      pauseOfflineSync('delivery_actions');
      fabControlEvents.deactivateFAB();
      fabControlEvents.notifyPhaseTwoTempUnlock();
      setIsCompleting(true);
      setIsProcessingBackground(true);
      const { driverLocationPoller } = await import('../utils/driverLocationPoller');
      driverLocationPoller.pause();
      smartRefreshManager.pause();
      smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
      try {
        const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
        if (!deliveryExists || deliveryExists.length === 0) {
          toast.error('This delivery has been deleted. Please refresh the page.');
          return;
        }
        await ensureDriverOnline();
        await syncDriverLocationToStop({ currentUser, delivery, patient, store, targetDriverId: delivery.driver_id });
        const autoCODPayment = hasCODRequired && codPayments.length === 0 && onCODUpdate ? [{ type: 'Cash', amount: codTotalRequired }] : null;
        if (autoCODPayment) setCodPayments(autoCODPayment);
        let pendingBreadcrumbsString = null;
        try { pendingBreadcrumbsString = await getPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers }); } catch {}
        const hasPendingPickupTransitions = isPickup && pendingPickups && pendingPickups.some((p) => p.status === 'pending');
        if (hasPendingPickupTransitions) {
          await executeAcceptAllStops();
          await waitForRouteTransitionSettle(pendingPickups?.length || 0);
        }
        const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);
        const useRetroactiveTiming = !shouldUseRegularTiming({ deliveryDate: delivery?.delivery_date, todayDateString: localDeviceTodayStr, currentTimeString: localNowParts.time });
        const retroactiveTiming = useRetroactiveTiming ? await calculateRetroactiveStopTiming({ delivery, allDeliveries, patients, stores, todayDateString: localDeviceTodayStr, allowSameDay: true }) : null;
        const completionCodPayments = autoCODPayment || codPayments;
        const sameRouteDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const forcedCompletionTimestamp = useRetroactiveTiming ? (retroactiveTiming?.actual_delivery_time || localTimeString) : localTimeString;
        const forcedArrivalTimestamp = useRetroactiveTiming ? (retroactiveTiming?.arrival_time || delivery.arrival_time || localTimeString) : (delivery.arrival_time || localTimeString);
        const shouldOverwriteArrivalTime = useRetroactiveTiming ? !!forcedArrivalTimestamp : !delivery.arrival_time;
        const patientSavedSignatureUrl = patient?.signature_image_url || patient?.saved_signature_image_url || null;
        const fallbackSignatureUrl = patientSavedSignatureUrl || null;
        const completionUpdate = { status: 'completed', actual_delivery_time: forcedCompletionTimestamp || localTimeString, finished_leg_transport_mode: 'driving', isNextDelivery: false, finished_leg_encoded_polyline: null, PolylineUpdated: true, ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}), ...(completionCodPayments.length > 0 ? { cod_payments: completionCodPayments } : {}), ...(fallbackSignatureUrl ? { signature_image_url: fallbackSignatureUrl } : {}), ...(shouldOverwriteArrivalTime && forcedArrivalTimestamp ? { arrival_time: forcedArrivalTimestamp } : {}), ...(typeof retroactiveTiming?.travel_dist === 'number' ? { travel_dist: retroactiveTiming.travel_dist } : {}) };
        const shouldDeleteSquareCodBeforeComplete = Number(delivery?.cod_total_amount_required || 0) > 0 && hasDebitOrCreditCod(delivery, completionCodPayments);
        const shouldRecalculateCompletionEtas = shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, completionUpdate.actual_delivery_time);
        await appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: 'completed', completedAt: completionUpdate.actual_delivery_time });
        if (shouldDeleteSquareCodBeforeComplete) await deleteCODWithTimeout(delivery.id, 'Deleted after card COD completion');
        const { offlineDB: _offlineDB } = await import('../utils/offlineDatabase');
        const clearNextFlags = sameRouteDeliveries.filter((d) => d && d.id !== delivery.id && d.isNextDelivery === true).map((d) => _offlineDB.bulkSave(_offlineDB.STORES.DELIVERIES, [{ ...d, isNextDelivery: false }]));
        if (isExpanded) await collapseDriverStopCards();
        await Promise.all([updateDeliveryLocal(delivery.id, completionUpdate, { skipSmartRefresh: true }), ...clearNextFlags]);
        if (fallbackSignatureUrl && patient?.id) {
          try {
            const { updatePatientLocal } = await import('../utils/offlineMutations');
            await updatePatientLocal(patient.id, { signature_image_url: fallbackSignatureUrl });
          } catch {}
        }
        if (pendingBreadcrumbsString) {
          try { await clearPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers, force: true }); } catch {}
        }
        runTerminalDeliverySideEffects({ delivery, previousStatus: delivery.status, nextStatus: 'completed', overrides: completionUpdate });
        const optimisticDeliveries = allDeliveries.map((d) => {
          if (!d || d.driver_id !== delivery.driver_id || d.delivery_date !== delivery.delivery_date) return d;
          if (d.id === delivery.id) return { ...d, ...completionUpdate, isNextDelivery: false };
          return d;
        });
        const routeDeliveries = optimisticDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const incompleteDeliveries = routeDeliveries.filter((d) => d && d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending').sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
        const nextStop = incompleteDeliveries[0] || null;
        await setAndCenterNextDelivery({ driverDeliveries: routeDeliveries, targetDeliveryId: nextStop?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
        if (!nextStop) {
          fabControlEvents.notifyDoneButtonClicked();
          window.dispatchEvent(new CustomEvent('showRouteSummary', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          try { await setDriverStatus({ newStatus: 'off_duty' }); locationTracker.stopTracking(); } catch {}
          if (onDriverStatusChange) onDriverStatusChange('off_duty');
        }
        fabControlEvents.notifyPhaseTwoCompleteRecenter();
        fabControlEvents.reactivateFAB(true, { suppressIfPhase1: true, reason: 'stop_status_change' });
        const backgroundTasks = [];
        if (autoCODPayment && onCODUpdate) backgroundTasks.push(onCODUpdate(delivery.id, autoCODPayment, true));
        backgroundTasks.push(Promise.resolve().then(async () => {
          try {
            const finishedLegEncodedPolyline = await getFinishedLegEncodedPolyline({ delivery, allDeliveries, driver: safeDriver, patient, store, patients, stores, finishedStatuses: FINISHED_STATUSES, breadcrumbPayload: pendingBreadcrumbsString, transportMode: 'driving' });
            if (finishedLegEncodedPolyline) await updateDeliveryLocal(delivery.id, { finished_leg_encoded_polyline: finishedLegEncodedPolyline, finished_leg_transport_mode: 'driving', PolylineUpdated: true }, { skipSmartRefresh: true });
          } catch {}
        }));
        if (shouldRecalculateCompletionEtas && nextStop) backgroundTasks.push(base44.functions.invoke('optimizeRouteRealTime', { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime: getCurrentLocalTimeString(), generatePolyline: false }).catch(() => {}));
        backgroundTasks.push(cleanupSquareCodCatalogForDate(delivery.delivery_date));
        const currentDriverAppUserId = currentDriverAppUser?.id || null;
        backgroundTasks.push(params.scheduleCompletionSideEffects({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, nextDeliveryId: nextStop?.id || null, lastCompletedDeliveryId: delivery.id, setOffDuty: !nextStop, appUserId: currentDriverAppUserId }));
        backgroundTasks.push(userHasRole(currentUser, 'driver') ? notifyDriverCompleted({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery, store, appUsers }) : Promise.resolve());
        await Promise.allSettled(backgroundTasks);
      } catch (error) {
        toast.error(`Failed to complete: ${error.message}`);
        throw error;
      } finally {
        resumeOfflineSync('delivery_actions');
        driverLocationPoller?.resume?.();
        smartRefreshManager.resume();
        resetActionLocks(true);
      }
    });
    if (lockResult?.skipped) return;
  }, [FINISHED_STATUSES, allDeliveries, appUsers, blockCardToggle, codPayments, codTotalRequired, collapseDriverStopCards, currentDriverAppUser?.id, currentUser, delivery, displayName, ensureDriverOnline, executeAcceptAllStops, forceRefreshDriverDeliveries, hasCODRequired, isCompleting, isExpanded, isFailing, isGlobalCompleteLocked, isGlobalRestartLocked, isPickup, isProcessingBackground, localDeviceTodayStr, localNowParts.time, onCODUpdate, onDriverStatusChange, params, patient, pendingPickups, resetActionLocks, safeDriver, setCodPayments, setIsCompleting, setIsProcessingBackground, store, updateDeliveriesLocally, userHasRole]);

  const handleFailureConfirm = useCallback(async (reason) => {
    const status = pendingFailureStatus;
    const lockResult = await runWithDeliveryActionLock('failure_delivery', async () => {
      pauseOfflineSync('delivery_actions');
      try {
        setShowFailureReasonDialog(false);
        setPendingFailureStatus(null);
        setIsFailing(true);
        fabControlEvents.deactivateFAB();
        fabControlEvents.notifyPhaseTwoTempUnlock();
        smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
        await collapseDriverStopCards();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
        if (!deliveryExists || deliveryExists.length === 0) {
          toast.error('This delivery has been deleted. Please refresh the page.');
          return;
        }
        await syncDriverLocationToStop({ currentUser, delivery, patient, store, targetDriverId: delivery.driver_id });
        await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
        const existingNotes = delivery.delivery_notes || '';
        const updatedNotes = existingNotes ? `${existingNotes}\n[${status.toUpperCase()}] ${reason}` : `[${status.toUpperCase()}] ${reason}`;
        const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);
        const useRetroactiveTiming = !shouldUseRegularTiming({ deliveryDate: delivery?.delivery_date, todayDateString: localDeviceTodayStr, currentTimeString: localNowParts.time });
        const retroactiveTiming = useRetroactiveTiming ? await calculateRetroactiveStopTiming({ delivery, allDeliveries, patients, stores, todayDateString: localDeviceTodayStr, allowSameDay: true }) : null;
        const pendingBreadcrumbsString = await getPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers });
        const forcedFailureTimestamp = useRetroactiveTiming ? (retroactiveTiming?.actual_delivery_time || localTimeString) : localTimeString;
        const forcedFailureArrivalTimestamp = useRetroactiveTiming ? (retroactiveTiming?.arrival_time || forcedFailureTimestamp) : (delivery.arrival_time || localTimeString);
        const existingArrivalDate = parseLocalTimestamp(delivery.arrival_time);
        const retroactiveArrivalDate = parseLocalTimestamp(forcedFailureArrivalTimestamp);
        const arrivalVsRetroArrivalDiffMinutes = existingArrivalDate && retroactiveArrivalDate ? Math.abs(retroactiveArrivalDate.getTime() - existingArrivalDate.getTime()) / 60000 : 0;
        const shouldAutoSetArrivalTime = (useRetroactiveTiming && !!retroactiveArrivalDate && (!existingArrivalDate || arrivalVsRetroArrivalDiffMinutes > 5)) || (!useRetroactiveTiming && !delivery.arrival_time);
        const criticalUpdate = { status, delivery_notes: updatedNotes, actual_delivery_time: forcedFailureTimestamp, finished_leg_transport_mode: 'driving', isNextDelivery: false, PolylineUpdated: true, ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}), ...(shouldAutoSetArrivalTime ? { arrival_time: forcedFailureArrivalTimestamp } : {}), ...(typeof retroactiveTiming?.travel_dist === 'number' ? { travel_dist: retroactiveTiming.travel_dist } : {}) };
        const shouldDeleteSquareCodBeforeFailure = Number(delivery?.cod_total_amount_required || 0) > 0;
        await appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: status, completedAt: criticalUpdate.actual_delivery_time });
        if (shouldDeleteSquareCodBeforeFailure) await deleteCODWithTimeout(delivery.id, `Deleted before marking as ${status}`);
        const { offlineDB: _failOfflineDB } = await import('../utils/offlineDatabase');
        const failRouteDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const clearFailNextFlags = failRouteDeliveries.filter((d) => d && d.id !== delivery.id && d.isNextDelivery === true).map((d) => _failOfflineDB.bulkSave(_failOfflineDB.STORES.DELIVERIES, [{ ...d, isNextDelivery: false }]));
        await Promise.allSettled([updateDeliveryLocal(delivery.id, criticalUpdate, { skipSmartRefresh: true }), ...clearFailNextFlags]);
        if (onStatusUpdate) await onStatusUpdate(delivery.id, status, criticalUpdate, false);
        if (pendingBreadcrumbsString) await clearPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers, force: true });
        runTerminalDeliverySideEffects({ delivery, previousStatus: delivery.status, nextStatus: status, overrides: criticalUpdate });
        Promise.resolve().then(async () => {
          try {
            const finishedLegEncodedPolyline = await getFinishedLegEncodedPolyline({ delivery, allDeliveries, driver: safeDriver, patient, store, patients, stores, finishedStatuses: FINISHED_STATUSES, breadcrumbPayload: pendingBreadcrumbsString, transportMode: 'driving' });
            if (finishedLegEncodedPolyline) await updateDeliveryLocal(delivery.id, { finished_leg_encoded_polyline: finishedLegEncodedPolyline, finished_leg_transport_mode: 'driving', PolylineUpdated: true }, { skipSmartRefresh: true });
          } catch {}
        });
        const allDriverDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const incompleteAfterThis = allDriverDeliveries.filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending');
        const shouldRecalculateFailureEtas = shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, criticalUpdate.actual_delivery_time);
        if (incompleteAfterThis.length === 0) {
          fabControlEvents.notifyDoneButtonClicked();
          window.dispatchEvent(new CustomEvent('showRouteSummary', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          if (currentUser?.id) {
            await setDriverStatus({ newStatus: 'off_duty' });
            locationTracker.stopTracking();
            if (onDriverStatusChange) onDriverStatusChange('off_duty');
          }
        }
        window.dispatchEvent(new CustomEvent('deliveryStatusChanged', { detail: { triggeredBy: status, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, maxStops: 5 } }));
        const driverDeliveries = allDriverDeliveries.map((item) => item.id === delivery.id ? { ...item, ...criticalUpdate, isNextDelivery: false } : item);
        const incompleteDeliveries = driverDeliveries.filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending').sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
        await setAndCenterNextDelivery({ driverDeliveries, targetDeliveryId: incompleteDeliveries[0]?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
        if (shouldRecalculateFailureEtas && incompleteDeliveries.length > 0) Promise.resolve().then(() => base44.functions.invoke('optimizeRouteRealTime', { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime: getCurrentLocalTimeString(), generatePolyline: false }).catch(() => {}));
        onClick?.(null);
        fabControlEvents.notifyPhaseTwoCompleteRecenter();
        if (userHasRole(currentUser, 'driver')) await notifyDriverFailed({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery: { ...delivery, delivery_notes: updatedNotes }, store, appUsers, failureReason: reason });
        toast.success(`${isPickup ? 'Pickup' : 'Delivery'} marked as ${status}`, { description: `Dispatch has been notified. Reason: ${reason}` });
      } catch (error) {
        toast.error(`Failed to mark as ${status}: ${error.message}`);
      } finally {
        resumeOfflineSync('delivery_actions');
        resetActionLocks(true);
      }
    });
    if (lockResult?.skipped) return;
  }, [FINISHED_STATUSES, allDeliveries, appUsers, collapseDriverStopCards, currentUser, delivery, displayName, forceRefreshDriverDeliveries, isPickup, localDeviceTodayStr, localNowParts.time, onClick, onDriverStatusChange, onStatusUpdate, params, patient, pendingFailureStatus, resetActionLocks, safeDriver, setIsFailing, setPendingFailureStatus, setShowFailureReasonDialog, store, updateDeliveriesLocally, userHasRole]);

  return {
    blockCardToggle,
    handleAddCODPayment,
    handleAcceptAllStops,
    handleReturnClick,
    handleConfirmReturn,
    handleCancelReturn,
    handleRetryDelivery,
    restartCurrentDelivery,
    handleStartAction,
    handleCompleteAction,
    handleFailureConfirm,
    resetActionLocks,
    ensureDriverOnline,
    collapseDriverStopCards
  };
}