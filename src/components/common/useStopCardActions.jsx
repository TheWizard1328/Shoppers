import { useCallback } from "react";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";
import { setDriverStatus } from "@/functions/setDriverStatus";
import { locationTracker } from "../utils/locationTracker";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import { backgroundSyncManager } from "../utils/backgroundSyncManager";
import { deleteCODWithTimeout } from '../utils/squareCODHandler';
import { cleanupSquareCodCatalogForDate } from '../utils/squareCodCatalogCleanup';
import { createDeliveryLocal, updateDeliveryLocal } from '../utils/offlineMutations';
import { flushQueuedDeliveryUpdates } from '../utils/updateBatcher';
import { fabControlEvents } from '../utils/fabControlEvents';
import { invalidate } from '../utils/dataManager';
import { generateCompletionTimestamp, calculateRetroactiveStopTiming, parseLocalTimestamp, shouldUseRegularTiming } from '../utils/timeRoundingHelper';
import { generateUniqueSID } from '../dashboard/DashboardHelpers';
import { buildRetryDelivery, collapseExpandedStopCardsForDriver, getCurrentLocalTimeString, getDriverRouteDeliveries, getNextActiveDelivery, getNextTrackingNumberInGroup, incrementTrackingNumber, optimizeRouteAndApplyNextDelivery, refreshDriverRoute, reorderActiveRouteLocally, setAndCenterNextDelivery, syncDriverLocationToStop, waitForRouteTransitionSettle, withPausedDriverLocationPoller } from "./stopCardActionHelpers";
// pendingBreadcrumbsManager removed - breadcrumbs now handled via DeliveryBreadcrumbs entity
import { appendBoundaryBreadcrumbPoints } from '../utils/breadcrumbBoundaryPoints';
import { triggerSquareCodUpsert } from '../utils/directDeliverySideEffects';
import { runAcceptAllBatchPipeline } from '../utils/acceptAllBatchPipeline';
import { runWithDeliveryActionLock } from '../utils/deliveryActionLock';
import { pauseOfflineSync, resumeOfflineSync } from '../utils/offlineSync';
import { getOrFetchHereApiKey } from '../utils/hereApiKeyStore';
import { notifyDriverAcceptedAll, notifyDispatcherAssignedAll, notifyDriverStarted, notifyDriverCompleted, notifyDriverFailed, notifyDriverRetry, notifyDriverReturn } from "../utils/deliveryMessaging";

const START_ACTION_NAME = 'start_delivery';

const queueConsolidateBreadcrumbs = ({ driverId, deliveryDate, stopOrder, status }) => {
  if (!driverId || !deliveryDate || !Number.isFinite(Number(stopOrder))) return;
  Promise.resolve().then(() =>
    base44.functions.invoke('consolidateBreadcrumbs', {
      driver_id: driverId,
      delivery_date: deliveryDate,
      stop_order: Number(stopOrder),
      delivery_status: status
    }).catch((error) => {
      console.warn('⚠️ [Breadcrumbs] Consolidation failed:', error?.message || error);
    })
  );
};
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
  return Math.abs(actualMinutes - etaMinutes) >= ETA_REFRESH_THRESHOLD_MINUTES;
};

const hasDebitOrCreditCod = (deliveryRecord, paymentList = null) => {
  const payments = Array.isArray(paymentList) ? paymentList : deliveryRecord?.cod_payments;
  if (Array.isArray(payments) && payments.some((payment) => ['Debit', 'Credit'].includes(payment?.type) && Number(payment?.amount || 0) > 0)) return true;
  return ['Debit', 'Credit'].includes(deliveryRecord?.cod_payment_type);
};

const resolveTravelDistFallback = (deliveryRecord, retroactiveTravelDist, allRouteDeliveries = []) => {
  const currentStopOrder = Number(deliveryRecord?.stop_order);
  const isFirstStop = Number.isFinite(currentStopOrder) && !allRouteDeliveries.some((item) => Number(item?.stop_order) < currentStopOrder);
  if (isFirstStop) return 0;
  if (typeof retroactiveTravelDist === 'number') return retroactiveTravelDist;
  const estimatedDistanceKm = Number(deliveryRecord?.estimated_distance_km);
  const currentTravelDist = Number(deliveryRecord?.travel_dist);
  if (!Number.isFinite(estimatedDistanceKm)) return undefined;
  if (!Number.isFinite(currentTravelDist) || estimatedDistanceKm - currentTravelDist > 0.75) return estimatedDistanceKm;
  return undefined;
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
    setShowInterStoreDialog,
    setInterStoreMatch,
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

  const currentPreferredTravelMode = String(currentDriverAppUser?.preferred_travel_mode || safeDriver?.preferred_travel_mode || 'driving').toLowerCase();

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
      backgroundSyncManager.pause();
      setIsEntityUpdating(true);

      const scopedPendingDeliveries = allDeliveries.filter((item) => item && item.driver_id === delivery.driver_id && item.delivery_date === delivery.delivery_date && item.status === 'pending' && item?.store_id === delivery.store_id);
      if (scopedPendingDeliveries.length === 0) {
        toast.error('No pending stops for this store.');
        return;
      }

      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const startMinutes = currentMinutes + 5;
      const deliveryTimeStart = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
      const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      fabControlEvents.notifyAcceptAllClicked();
      window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));

      const { stagedChangedDeliveries, finalOfflineUpdates, codBatch, optimizeData } = await runAcceptAllBatchPipeline({
        triggerDelivery: delivery,
        allDeliveries,
        stores,
        currentLocalTime,
        deliveryTimeStart,
        updateDeliveriesLocally
      });

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAll', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true, freshDeliveries: [...stagedChangedDeliveries, ...finalOfflineUpdates], alreadyOptimized: true } }));
      window.dispatchEvent(new CustomEvent('pendingToInTransit', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      invalidate('Delivery');

      if (optimizeData?.success && Array.isArray(optimizeData.optimizedRoute) && optimizeData.optimizedRoute.length > 0) {
        window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { driverId: delivery.driver_id, updates: optimizeData.optimizedRoute.map((stop) => ({ deliveryId: stop.deliveryId || stop.delivery_id, newEta: stop.newETA || stop.eta })).filter((stop) => stop.deliveryId && stop.newEta) } }));
      }

      // CRITICAL: optimizeRemainingStops already writes correct polylines directly to each
      // delivery via HERE API. Calling purgeAndRegeneratePolylines overwrites them with
      // independently-generated segments using wrong origins (e.g. home→pending stop).
      // Skip it entirely when optimization provided valid polylines.
      const acceptAllHasPolylines = Array.isArray(optimizeData?.optimizedRoute) && optimizeData.optimizedRoute.some((stop) => stop.encoded_polyline);
      const polylineResponse = acceptAllHasPolylines ? { skipped: true, reason: 'polylines_from_optimize' } : await base44.functions.invoke('purgeAndRegeneratePolylines', {
        driverId: delivery.driver_id,
        deliveryDate: delivery.delivery_date,
        scope: 'active_only',
        reason: optimizeData?.routeChanged ? 'route_reordered' : 'manual',
        sourcePage: 'Dashboard',
        bypassDriverStatus: true,
        routeStopOrder: Array.isArray(optimizeData?.optimizedRoute)
          ? optimizeData.optimizedRoute.map((stop) => stop.deliveryId || stop.delivery_id).filter(Boolean)
          : [],
        orderedStopsWithTransportMode: Array.isArray(optimizeData?.optimizedRoute)
          ? optimizeData.optimizedRoute.map((stop) => ({
              deliveryId: stop.deliveryId || stop.delivery_id,
              transport_mode: stop.transport_mode || stop.finished_leg_transport_mode || currentPreferredTravelMode,
              finished_leg_transport_mode: stop.finished_leg_transport_mode || stop.transport_mode || currentPreferredTravelMode,
              encoded_polyline: stop.encoded_polyline || null,
              estimated_distance_km: stop.estimated_distance_km ?? null,
              estimated_duration_minutes: stop.estimated_duration_minutes ?? null
            })).filter((stop) => stop.deliveryId)
          : [],
        explicitOrderedStopsOnly: true,
        explicitRouteOrigin: 'last_finished_stop',
        explicitRouteDestination: 'home',
        bypassPolylineUpdated: true,
        bypassPolylineDelete: true,
        reuseProvidedPolylines: true
      }).catch(() => null);

      const refreshedDeliveries = await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
      const refreshedList = Array.isArray(refreshedDeliveries)
        ? refreshedDeliveries
        : Array.isArray(refreshedDeliveries?.deliveries)
          ? refreshedDeliveries.deliveries
          : null;

      if (Array.isArray(refreshedList) && refreshedList.length > 0) {
        updateDeliveriesLocally?.(refreshedList, true);
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAllOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true, preserveLocalState: true, fullReplacement: true, freshDeliveries: refreshedList } }));
      } else {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAllOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true, preserveLocalState: false, fullReplacement: true } }));
      }

      if (polylineResponse) {
        window.dispatchEvent(new CustomEvent('polylineUpdated', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, source: 'accept_all_button' } }));
      }

      if (codBatch.length > 0) {
        base44.functions.invoke('syncSquareCods', { items: codBatch }).catch((e) => console.warn('⚠️ [Square] Batch COD sync failed to start:', e));
      }

      const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id;
      if (isDriverAction) {
        notifyDriverAcceptedAll({ driver: currentUser, store, appUsers }).catch(() => {});
      } else {
        const assignedDriver = drivers.find((d) => d?.id === delivery.driver_id);
        if (assignedDriver) notifyDispatcherAssignedAll({ dispatcher: currentUser, driver: assignedDriver, store, deliveries: scopedPendingDeliveries, patients }).catch(() => {});
      }
    } catch (error) {
      console.error('❌ [Accept All] Error:', error);
      toast.error(`Failed to accept all: ${error.message}`);
      throw error;
    } finally {
      window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAllOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true } }));
      resumeOfflineSync('delivery_actions');
      driverLocationPoller.resume();
      smartRefreshManager.resume();
      backgroundSyncManager.resume();
      setIsEntityUpdating(false);
      setIsAcceptingAll(false);
      onClick?.(null);
    }
  }, [allDeliveries, appUsers, currentUser, delivery, drivers, onClick, patients, setIsAcceptingAll, setIsEntityUpdating, store, stores, updateDeliveriesLocally, userHasRole]);

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
    let createdReturnDelivery = null;
    try {
      createdReturnDelivery = await onCreateReturn({ originalDelivery: delivery, returnPatient: selectedReturnPatient, store: resolvedStore, _skipPickupCreation: true });
      setShowReturnConfirm(false);
      setReturnPatient(null);
      onClick?.(null);
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'return', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      Promise.resolve().then(async () => {
        try {
          const createdReturnDeliveryId = createdReturnDelivery?.id || createdReturnDelivery?.data?.id || null;
          const backgroundTasks = [];
          if ((delivery.cod_total_amount_required || 0) > 0) backgroundTasks.push(deleteCODWithTimeout(delivery.id, 'Removed after creating return delivery'));
          backgroundTasks.push((async () => {
            const routeDeliveries = await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
            const refreshedRouteDeliveries = Array.isArray(routeDeliveries)
              ? routeDeliveries
              : Array.isArray(routeDeliveries?.deliveries)
                ? routeDeliveries.deliveries
                : [];
            const routeWithoutNewReturn = refreshedRouteDeliveries.filter((item) => item?.id !== createdReturnDeliveryId);
            const highestStopOrder = routeWithoutNewReturn.reduce((max, item) => Math.max(max, Number(item?.stop_order || 0)), 0);
            if (createdReturnDeliveryId) {
              await updateDeliveryLocal(createdReturnDeliveryId, { stop_order: highestStopOrder + 1, isNextDelivery: false }, { skipSmartRefresh: true });
              await base44.entities.Delivery.update(createdReturnDeliveryId, { stop_order: highestStopOrder + 1, isNextDelivery: false }).catch(() => null);
            }
            // Return adds a new stop to the route — run full optimization including HERE API
            await optimizeRouteAndApplyNextDelivery({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, updateDeliveryLocal, updateDeliveriesLocally, forceRefreshDriverDeliveries, shouldRegeneratePolylines: true, runOptimization: true });
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
      backgroundSyncManager.pause();
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
          const retryDeliveryId = newRetryDelivery?.id || newRetryDelivery?.data?.id || null;
          const highestStopOrder = retryDateDeliveries.reduce((max, item) => Math.max(max, Number(item?.stop_order || 0)), 0);
          if (retryDeliveryId) {
            await updateDeliveryLocal(retryDeliveryId, { stop_order: highestStopOrder + 1, isNextDelivery: false }, { skipSmartRefresh: true });
            await base44.entities.Delivery.update(retryDeliveryId, { stop_order: highestStopOrder + 1, isNextDelivery: false }).catch(() => null);
          }
          if ((delivery.cod_total_amount_required || 0) > 0) {
            await deleteCODWithTimeout(delivery.id, 'Removed after creating retry delivery');
            if (retryDeliveryId && !isPickup) triggerSquareCodUpsert({ deliveryId: retryDeliveryId, patientName: patient?.full_name || 'Patient', storeAbbreviation: store?.abbreviation || '', codAmount: delivery.cod_total_amount_required, deliveryDate: retryDate, storeId: delivery.store_id });
          }
          await ensureDriverOnline();
          try {
            // Retry adds a new stop to the route — run full optimization including HERE API
            await optimizeRouteAndApplyNextDelivery({ driverId: delivery.driver_id, deliveryDate: retryDate, updateDeliveryLocal, updateDeliveriesLocally, forceRefreshDriverDeliveries, shouldRegeneratePolylines: true, runOptimization: true });
          } catch {}
          if (userHasRole(currentUser, 'driver')) await notifyDriverRetry({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery, store, appUsers });
        });
      } finally {
        resumeOfflineSync('delivery_actions');
        backgroundSyncManager.resume();
        resetActionLocks(true);
      }
    });
    if (lockResult?.skipped) return;
  }, [allDeliveries, appUsers, blockCardToggle, delivery, displayName, ensureDriverOnline, forceRefreshDriverDeliveries, isPickup, patient?.full_name, resetActionLocks, setIsProcessingBackground, setIsRetrying, store, updateDeliveriesLocally, userHasRole, currentUser]);

  const restartCurrentDelivery = useCallback(async () => {
    const lockResult = await runWithDeliveryActionLock('restart_delivery', async () => {
      pauseOfflineSync('delivery_actions');
      backgroundSyncManager.pause();
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

          if (!isPickup && patient?.id && patient?.status === 'inactive') {
            try {
              const { updatePatientLocal } = await import('../utils/offlineMutations');
              await updatePatientLocal(patient.id, { status: 'active' });
            } catch {}
            await base44.entities.Patient.update(patient.id, { status: 'active' }).catch(() => null);
          }

          if ((delivery.cod_total_amount_required || 0) > 0 && !isPickup) triggerSquareCodUpsert({ deliveryId: delivery.id, patientName: patient?.full_name || delivery.patient_name || 'Patient', storeAbbreviation: store?.abbreviation || '', codAmount: delivery.cod_total_amount_required, deliveryDate: delivery.delivery_date, storeId: delivery.store_id });

          let restartOptimizeData = null;
          try {
            const optimizationResult = await optimizeRouteAndApplyNextDelivery({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, updateDeliveryLocal, updateDeliveriesLocally, forceRefreshDriverDeliveries, shouldRegeneratePolylines: false, fallbackNextDeliveryId: delivery.id, runOptimization: true });
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
        backgroundSyncManager.resume();
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
    backgroundSyncManager.pause();

    // CRITICAL: Auto-set driver on_duty before starting delivery (if off_duty or on_break)
    if (currentUser?.id === delivery?.driver_id &&
        currentUser?.driver_status !== 'on_duty' &&
        delivery?.delivery_date === localDeviceTodayStr) {
      await ensureDriverOnline().catch(() => {});
    }

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

        const finishedStatuses = new Set(FINISHED_STATUSES);
        const completedStops = routeDeliveries
          .filter((d) => d && finishedStatuses.has(d.status))
          .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));
        const activeStops = routeDeliveries
          .filter((d) => d && !finishedStatuses.has(d.status) && d.status !== 'pending')
          .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));
        const pendingStops = routeDeliveries
          .filter((d) => d && d.status === 'pending')
          .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0));

        // CRITICAL: Started stop should be placed immediately after finished stops, not with other active stops
        const otherActiveStops = activeStops.filter((d) => d?.id !== delivery.id);
        const startedRouteDeliveries = [...completedStops, delivery, ...otherActiveStops, ...pendingStops]
          .filter(Boolean)
          .map((d, index) => ({
            ...d,
            stop_order: index + 1,
            display_stop_order: index + 1,
            isNextDelivery: d.id === delivery.id
          }));

        const { offlineDB } = await import('../utils/offlineDatabase');
        const startedChangedDeliveries = startedRouteDeliveries.filter((item) => {
          const existing = routeDeliveries.find((routeItem) => routeItem?.id === item?.id);
          return existing && JSON.stringify(existing) !== JSON.stringify(item);
        });

        if (startedChangedDeliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, startedChangedDeliveries.filter(Boolean));
          updateDeliveriesLocally?.(startedChangedDeliveries.filter(Boolean), false);
        }

        await Promise.all(
          startedChangedDeliveries.map((item) => {
            const existing = routeDeliveries.find((routeItem) => routeItem?.id === item?.id);
            if (!existing) return Promise.resolve(null);
            const updates = {};
            if ((existing.isNextDelivery || false) !== (item.isNextDelivery || false)) updates.isNextDelivery = item.isNextDelivery || false;
            if (Number(existing.stop_order || 0) !== Number(item.stop_order || 0)) updates.stop_order = item.stop_order;
            if (Number(existing.display_stop_order || 0) !== Number(item.display_stop_order || 0)) updates.display_stop_order = item.display_stop_order;
            if (Object.keys(updates).length === 0) return Promise.resolve(null);
            return Promise.all([
              updateDeliveryLocal(item.id, updates, { skipSmartRefresh: true, isBatchOperation: true }),
              base44.entities.Delivery.update(item.id, updates).catch(() => null)
            ]);
          })
        );

        if (!isPickup && patient?.id && patient?.status === 'inactive') {
          try {
            const { updatePatientLocal } = await import('../utils/offlineMutations');
            await updatePatientLocal(patient.id, { status: 'active' });
          } catch {}
          await base44.entities.Patient.update(patient.id, { status: 'active' }).catch(() => null);
        }

        await setAndCenterNextDelivery({ driverDeliveries: startedRouteDeliveries, targetDeliveryId: delivery.id, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, skipBackgroundSync: true, persistToBackend: true });
        window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: delivery.id } }));
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true, freshDeliveries: startedChangedDeliveries } }));
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

        // CRITICAL: All stop_order + isNextDelivery changes are already persisted to backend
        // above (lines with base44.entities.Delivery.update). Now call handleStartDelivery to
        // confirm the backend has the authoritative order, then fetch fresh data and finally
        // trigger the manual FAB optimization so polylines update only on that explicit action.
        if (!delivery?.id || !delivery?.driver_id || !delivery?.delivery_date) return;
        try {
          // Step 1: Confirm backend persistence of start state
          const optimizeResponse = await base44.functions.invoke('handleStartDelivery', { deliveryId: delivery.id, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime });

          // Step 2: Fetch fresh deliveries from backend to capture any server-side corrections
           const refreshedImmediately = await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
           const refreshedListImmediate = Array.isArray(refreshedImmediately)
             ? refreshedImmediately
             : Array.isArray(refreshedImmediately?.deliveries)
               ? refreshedImmediately.deliveries
               : null;

          if (Array.isArray(refreshedListImmediate) && refreshedListImmediate.length > 0) {
            // CRITICAL: Save to offline DB only (don't update UI yet)
            // The optimizer will run next and update the backend + broadcast its own optimized result
            // If we update the UI here with pre-optimization order, the reversion issue occurs
            await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', delivery.delivery_date, refreshedListImmediate);
          }

          // CRITICAL: After optimization, save optimized deliveries to offline DB for cross-device sync
          let optimizedDeliveriesToPersist = [];
          if (Array.isArray(optimizedWithCorrectedEtas) && optimizedWithCorrectedEtas.length > 0) {
            optimizedDeliveriesToPersist = optimizedWithCorrectedEtas
              .filter((stop) => stop?.deliveryId || stop?.delivery_id)
              .map((stop) => ({
                id: stop.deliveryId || stop.delivery_id,
                stop_order: Number.isFinite(Number(stop.stop_order)) ? Number(stop.stop_order) : undefined,
                delivery_time_eta: stop.correctedEta,
                encoded_polyline: stop.encoded_polyline || null,
                estimated_distance_km: stop.estimated_distance_km,
                estimated_duration_minutes: stop.estimated_duration_minutes,
                travel_dist: stop.travel_dist
              }))
              .filter((update) => update.id);

            if (optimizedDeliveriesToPersist.length > 0) {
              await Promise.all(
                optimizedDeliveriesToPersist.map((update) =>
                  base44.entities.Delivery.update(update.id, {
                    stop_order: update.stop_order,
                    delivery_time_eta: update.delivery_time_eta,
                    encoded_polyline: update.encoded_polyline,
                    estimated_distance_km: update.estimated_distance_km,
                    estimated_duration_minutes: update.estimated_duration_minutes,
                    travel_dist: update.travel_dist
                  }).catch(() => null)
                )
              );
            }
          }

          await base44.functions.invoke('recalculateTrackingNumbers', {
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date
          }).catch(() => null);

          // Step 3: Broadcast updated delivery state to other devices
          if (Array.isArray(refreshedListImmediate) && refreshedListImmediate.length > 0) {
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'startOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true, preserveLocalState: true, fullReplacement: true, freshDeliveries: refreshedListImmediate } }));
            Promise.resolve().then(async () => {
              try {
                const { broadcastMutation } = await import('../utils/realtimeSync');
                await Promise.all(refreshedListImmediate.map((item) => broadcastMutation('Delivery', 'update', item.id, item)));
              } catch (broadcastError) {
                console.warn('⚠️ [Start] delivery broadcast failed:', broadcastError?.message || broadcastError);
              }
            });
          } else {
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'startOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true, preserveLocalState: false, fullReplacement: true } }));
          }

          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers, triggeredBy: 'startOptimized' } }));

          // Step 4: NOW trigger the manual FAB optimization — all backend data is confirmed persisted
          // Polyline updates happen only here, never from passive location changes
          // CRITICAL: Pass firstStopId so optimizeRemainingStops locks the started stop
          // The optimizer will use this explicit firstStopId as the authoritative route origin

          // CRITICAL: If handleStartDelivery already returned optimizedRoute, use it directly
          // Otherwise trigger route optimization manually
          let optimizedWithCorrectedEtas = null;
          if (Array.isArray(optimizeResponse?.optimizedRoute) && optimizeResponse.optimizedRoute.length > 0) {
            // CRITICAL: Recalculate ETAs from last completed stop's actual delivery time
            const lastCompletedStop = completedStops.length > 0 ? completedStops[completedStops.length - 1] : null;
            const lastCompletedActualTime = lastCompletedStop?.actual_delivery_time || null;

            let baseTimeMinutes = 0;
            if (lastCompletedActualTime) {
              const [hours, minutes] = lastCompletedActualTime.split(':').map(Number);
              baseTimeMinutes = hours * 60 + minutes;
            } else {
              const now = new Date();
              baseTimeMinutes = now.getHours() * 60 + now.getMinutes();
            }

            optimizedWithCorrectedEtas = optimizeResponse.optimizedRoute.map((stop, index) => {
              let etaMinutes = baseTimeMinutes;
              // Add estimated duration for each stop up to and including current one
              for (let i = 0; i <= index; i++) {
                const currentStop = optimizeResponse.optimizedRoute[i];
                etaMinutes += (currentStop.estimated_duration_minutes || 5);
              }
              const etaHours = Math.floor((etaMinutes % 1440) / 60);
              const etaMins = etaMinutes % 60;
              const newEta = `${String(etaHours).padStart(2, '0')}:${String(etaMins).padStart(2, '0')}`;
              return { ...stop, correctedEta: newEta };
            });

            // handleStartDelivery already optimized — just regenerate polylines
            const polylineResponse = await base44.functions.invoke('purgeAndRegeneratePolylines', {
              driverId: delivery.driver_id,
              deliveryDate: delivery.delivery_date,
              scope: 'active_only',
              reason: 'start_action',
              sourcePage: 'Dashboard',
              bypassDriverStatus: true,
              routeStopOrder: optimizedWithCorrectedEtas.map((stop) => stop.deliveryId || stop.delivery_id).filter(Boolean),
              orderedStopsWithTransportMode: optimizedWithCorrectedEtas.map((stop) => ({
                deliveryId: stop.deliveryId || stop.delivery_id,
                transport_mode: stop.transport_mode || stop.finished_leg_transport_mode || currentPreferredTravelMode,
                finished_leg_transport_mode: stop.finished_leg_transport_mode || stop.transport_mode || currentPreferredTravelMode,
                encoded_polyline: stop.encoded_polyline || null,
                estimated_distance_km: stop.estimated_distance_km ?? null,
                estimated_duration_minutes: stop.estimated_duration_minutes ?? null
              })).filter((stop) => stop.deliveryId),
              explicitOrderedStopsOnly: true,
              explicitRouteOrigin: 'last_finished_stop',
              explicitRouteDestination: 'home',
              bypassPolylineUpdated: true,
              bypassPolylineDelete: true,
              reuseProvidedPolylines: true
            }).catch(() => null);

            if (polylineResponse) {
              window.dispatchEvent(new CustomEvent('polylineUpdated', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, source: 'start_action' } }));

              // CRITICAL: Broadcast optimized deliveries with corrected ETAs to other devices in real-time
              Promise.resolve().then(async () => {
                try {
                  const { broadcastMutation } = await import('../utils/realtimeSync');
                  await Promise.all(optimizedWithCorrectedEtas.map((stop) => 
                    broadcastMutation('Delivery', 'update', stop.deliveryId || stop.delivery_id, {
                      stop_order: stop.stop_order,
                      delivery_time_eta: stop.correctedEta,
                      encoded_polyline: stop.encoded_polyline || null,
                      estimated_distance_km: stop.estimated_distance_km,
                      estimated_duration_minutes: stop.estimated_duration_minutes,
                      travel_dist: stop.travel_dist
                    })
                  ));
                } catch (broadcastError) {
                  console.warn('⚠️ [Start] optimization broadcast failed:', broadcastError?.message || broadcastError);
                }
              });
            }
            } else {
            // Fallback: trigger route optimization manually
            window.dispatchEvent(new CustomEvent('triggerRouteOptimization', {
              detail: { 
                firstStopId: delivery.id, 
                driverId: delivery.driver_id, 
                deliveryDate: delivery.delivery_date,
                source: 'start_action'
              }
            }));
            }

          fabControlEvents.reactivatePhaseTwoIfAvailable();

          // Notify driver after optimization is complete
          await ensureDriverOnline().catch(() => {});
          if (userHasRole(currentUser, 'driver') && currentUser.id === delivery.driver_id) {
            await notifyDriverStarted({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers }).catch(() => {});
          }
        } catch (optErr) {
          const isNotFound = optErr?.status === 404 || optErr?.response?.status === 404 || String(optErr?.message || '').includes('404');
          if (!isNotFound) console.warn('⚠️ [Start] background start update failed:', optErr?.message || optErr);
        }
      } catch (error) {
        toast.error(`Failed to start: ${error.message}`);
      } finally {
        resumeOfflineSync('delivery_actions');
        driverLocationPoller.resume();
        smartRefreshManager.resume();
        backgroundSyncManager.resume();
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
      backgroundSyncManager.pause();
      smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
      try {
        const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
        if (!deliveryExists || deliveryExists.length === 0) {
          toast.error('This delivery has been deleted. Please refresh the page.');
          return;
        }
        // Only ensure driver is online if not already on duty
        if (currentUser?.driver_status !== 'on_duty') {
          await ensureDriverOnline();
        }
        await syncDriverLocationToStop({ currentUser, delivery, patient, store, targetDriverId: delivery.driver_id });
        const autoCODPayment = !isPickup && hasCODRequired && codPayments.length === 0 && onCODUpdate ? [{ type: 'Cash', amount: codTotalRequired }] : null;
        if (autoCODPayment) setCodPayments(autoCODPayment);
        let pendingBreadcrumbsString = null;
        try {
          await appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: 'completed', completedAt: delivery.actual_delivery_time || delivery.arrival_time || new Date().toISOString() });
        } catch {}
        // Only execute accept all stops if this is a pickup and has pending deliveries to process
        const hasPendingPickupTransitions = isPickup && pendingPickups && pendingPickups.some((p) => p.status === 'pending');
        if (isPickup && hasPendingPickupTransitions) {
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
        const fallbackTravelDist = resolveTravelDistFallback(delivery, retroactiveTiming?.travel_dist, sameRouteDeliveries);
        const completionUpdate = { status: 'completed', actual_delivery_time: forcedCompletionTimestamp || localTimeString, finished_leg_transport_mode: currentPreferredTravelMode, isNextDelivery: false, finished_leg_encoded_polyline: null, PolylineUpdated: true, ...(completionCodPayments.length > 0 ? { cod_payments: completionCodPayments } : {}), ...(fallbackSignatureUrl ? { signature_image_url: fallbackSignatureUrl } : {}), ...(shouldOverwriteArrivalTime && forcedArrivalTimestamp ? { arrival_time: forcedArrivalTimestamp } : {}), ...(typeof fallbackTravelDist === 'number' ? { travel_dist: fallbackTravelDist } : {}) };
        const shouldDeleteSquareCodBeforeComplete = !isPickup && Number(delivery?.cod_total_amount_required || 0) > 0 && hasDebitOrCreditCod(delivery, completionCodPayments);
        const shouldRecalculateCompletionEtas = delivery?.delivery_date === localDeviceTodayStr && shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, completionUpdate.actual_delivery_time);
        const remainingEtaDeliveries = sameRouteDeliveries
          .filter((d) => d && d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending')
          .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
        await appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: 'completed', completedAt: completionUpdate.actual_delivery_time });
        // Only handle COD deletion if delivery has COD amount
        if (shouldDeleteSquareCodBeforeComplete) {
          await deleteCODWithTimeout(delivery.id, 'Deleted after card COD completion');
        }
        if (isExpanded) await collapseDriverStopCards();
        await Promise.all([updateDeliveryLocal(delivery.id, completionUpdate, { skipSmartRefresh: true })]);
        if (patient?.id) {
          try {
            const { updatePatientLocal } = await import('../utils/offlineMutations');
            await updatePatientLocal(patient.id, {
              ...(fallbackSignatureUrl ? { signature_image_url: fallbackSignatureUrl } : {}),
              ...(patient?.status === 'inactive' ? { status: 'active' } : {})
            });
          } catch {}

          if (patient?.status === 'inactive') {
            await base44.entities.Patient.update(patient.id, { status: 'active' });
          }
        }
        // Breadcrumbs cleared automatically by processBreadcrumbLeg backend automation on delivery completion

        const optimisticDeliveries = allDeliveries.map((d) => {
          if (!d || d.driver_id !== delivery.driver_id || d.delivery_date !== delivery.delivery_date) return d;
          if (d.id === delivery.id) return { ...d, ...completionUpdate, isNextDelivery: false };
          return d;
        });
        const routeDeliveries = optimisticDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const incompleteDeliveries = routeDeliveries.filter((d) => d && d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending').sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
        const nextStop = incompleteDeliveries[0] || null;
        const actedOnNextDelivery = delivery?.isNextDelivery === true;
        await setAndCenterNextDelivery({ driverDeliveries: routeDeliveries, targetDeliveryId: nextStop?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, skipBackgroundSync: true, persistToBackend: true });
        if (actedOnNextDelivery && shouldRecalculateCompletionEtas && remainingEtaDeliveries.length > 0) {
           // Calculate updated ETAs for remaining stops based on ACTUAL completion time of just-completed stop
           // Start from the completed stop's actual_delivery_time (not current device time)
           const completedStopTime = completionUpdate.actual_delivery_time || forcedCompletionTimestamp;
           const [completedHours, completedMinutes] = completedStopTime.split(':').map(Number);
           let currentEtaMinutes = completedHours * 60 + completedMinutes;
           const updatedRemainingWithEtas = remainingEtaDeliveries.map((stop, index) => {
             if (index === 0) {
               // First remaining stop (isNextDelivery): add travel time from completed stop's actual time
               currentEtaMinutes = currentEtaMinutes + (stop.estimated_duration_minutes || 5);
             } else {
               // Subsequent stops cascade from previous stop's ETA + that stop's estimated duration
               currentEtaMinutes = currentEtaMinutes + (remainingEtaDeliveries[index - 1]?.estimated_duration_minutes || 5);
             }
             const newEtaHours = Math.floor((currentEtaMinutes % 1440) / 60);
             const newEtaMins = currentEtaMinutes % 60;
             const newEta = `${String(newEtaHours).padStart(2, '0')}:${String(newEtaMins).padStart(2, '0')}`;
             return { ...stop, delivery_time_eta: newEta };
           });

          // Persist updated ETAs to database and broadcast to other devices
          await Promise.all(updatedRemainingWithEtas.map((stop) => {
            return Promise.all([
              updateDeliveryLocal(stop.id, { delivery_time_eta: stop.delivery_time_eta }, { skipSmartRefresh: true }),
              base44.entities.Delivery.update(stop.id, { delivery_time_eta: stop.delivery_time_eta }).catch(() => null)
            ]);
          }));

          // Broadcast mutations for real-time updates on other devices
          Promise.resolve().then(async () => {
            try {
              const { broadcastMutation } = await import('../utils/realtimeSync');
              await Promise.all(updatedRemainingWithEtas.map((item) => broadcastMutation('Delivery', 'update', item.id, { delivery_time_eta: item.delivery_time_eta })));
            } catch (broadcastError) {
              console.warn('⚠️ [Complete ETA] broadcast failed:', broadcastError?.message || broadcastError);
            }
          });

          // NOTE: No HERE API / optimizeRemainingStops call here.
          // ETAs are already updated locally above using estimated_duration_minutes.
          // Complete/fail/cancel never changes stop order — only a data refresh is needed.
          await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date).catch(() => null);
        }
        if (!nextStop) {
          fabControlEvents.notifyDoneButtonClicked();
          window.dispatchEvent(new CustomEvent('showRouteSummary', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          // Only update driver status if they're not on duty (off_duty or on_break)
          if (currentUser?.driver_status !== 'on_duty') {
            try { await setDriverStatus({ newStatus: 'off_duty' }); locationTracker.stopTracking(); } catch {}
            if (onDriverStatusChange) onDriverStatusChange('off_duty');
          }
        }
        fabControlEvents.notifyPhaseTwoCompleteRecenter();
        fabControlEvents.reactivateFAB(true, { suppressIfPhase1: true, reason: 'stop_status_change' });
        // Only sync patient last delivery date if this is a delivery (not a pickup) and has COD
        if (!isPickup && patient?.id && Number(delivery?.cod_total_amount_required || 0) > 0) {
          await base44.functions.invoke('syncPatientLastDeliveryDate', {
            data: { ...delivery, ...completionUpdate, patient_id: patient.id },
            old_data: { status: delivery.status },
            event: { type: 'update', entity_name: 'Delivery' }
          }).catch(() => null);
        }
        if (userHasRole(currentUser, 'driver')) {
          await notifyDriverCompleted({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery, store, appUsers }).catch(() => {});
        }

        try {
          const interStoreResponse = await base44.functions.invoke('findInterStoreDropoff', { deliveryId: delivery.id });
          const interStoreData = interStoreResponse?.data || interStoreResponse;
          if (interStoreData?.isInterStorePickup) {
            const originatingStoreId = interStoreData?.match?.store_id || null;
            const driverRouteDeliveries = allDeliveries.filter((item) => item && item.driver_id === delivery.driver_id && item.delivery_date === delivery.delivery_date);
            const hasEnRoutePickupForOriginStore = driverRouteDeliveries.some((item) =>
              item &&
              !item.patient_id &&
              item.store_id === originatingStoreId &&
              item.status === 'en_route'
            );
            const hasMatchingInTransitDropoff = driverRouteDeliveries.some((item) => {
              if (!item || item.id === delivery.id || item.status !== 'in_transit') return false;
              const notes = String(item.delivery_notes || '').toLowerCase();
              return item.patient_id === interStoreData?.match?.id && (notes.includes('interstore drop-off') || notes.includes('interstore dropoff') || notes.includes('isd'));
            });

            if (!hasEnRoutePickupForOriginStore && !hasMatchingInTransitDropoff) {
              setInterStoreMatch?.(interStoreData.match || null);
              setShowInterStoreDialog?.(true);
            }
          }
        } catch (_) {}
      } catch (error) {
        toast.error(`Failed to complete: ${error.message}`);
        throw error;
      } finally {
        resumeOfflineSync('delivery_actions');
        driverLocationPoller?.resume?.();
        smartRefreshManager.resume();
        backgroundSyncManager.resume();
        resetActionLocks(true);
      }
    });
    if (lockResult?.skipped) return;
  }, [FINISHED_STATUSES, allDeliveries, appUsers, blockCardToggle, codPayments, codTotalRequired, collapseDriverStopCards, currentDriverAppUser?.id, currentUser, delivery, displayName, ensureDriverOnline, executeAcceptAllStops, forceRefreshDriverDeliveries, hasCODRequired, isCompleting, isExpanded, isFailing, isGlobalCompleteLocked, isGlobalRestartLocked, isPickup, isProcessingBackground, localDeviceTodayStr, localNowParts.time, onCODUpdate, onDriverStatusChange, params, patient, pendingPickups, resetActionLocks, safeDriver, setCodPayments, setIsCompleting, setIsProcessingBackground, store, updateDeliveriesLocally, userHasRole]);

  const handleFailureConfirm = useCallback(async (reason) => {
    const status = pendingFailureStatus;
    const lockResult = await runWithDeliveryActionLock('failure_delivery', async () => {
      pauseOfflineSync('delivery_actions');
      backgroundSyncManager.pause();
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
        let pendingBreadcrumbsString = null;
        try {
          await appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: status, completedAt: delivery.actual_delivery_time || delivery.arrival_time || new Date().toISOString() });
        } catch {}
        const forcedFailureTimestamp = useRetroactiveTiming ? (retroactiveTiming?.actual_delivery_time || localTimeString) : localTimeString;
        const forcedFailureArrivalTimestamp = useRetroactiveTiming ? (retroactiveTiming?.arrival_time || forcedFailureTimestamp) : (delivery.arrival_time || localTimeString);
        const existingArrivalDate = parseLocalTimestamp(delivery.arrival_time);
        const retroactiveArrivalDate = parseLocalTimestamp(forcedFailureArrivalTimestamp);
        const arrivalVsRetroArrivalDiffMinutes = existingArrivalDate && retroactiveArrivalDate ? Math.abs(retroactiveArrivalDate.getTime() - existingArrivalDate.getTime()) / 60000 : 0;
        const shouldAutoSetArrivalTime = (useRetroactiveTiming && !!retroactiveArrivalDate && (!existingArrivalDate || arrivalVsRetroArrivalDiffMinutes > 5)) || (!useRetroactiveTiming && !delivery.arrival_time);
        const allRouteDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const fallbackTravelDist = resolveTravelDistFallback(delivery, retroactiveTiming?.travel_dist, allRouteDeliveries);
        const criticalUpdate = { status, delivery_notes: updatedNotes, actual_delivery_time: forcedFailureTimestamp, finished_leg_transport_mode: currentPreferredTravelMode, isNextDelivery: false, PolylineUpdated: true, ...(shouldAutoSetArrivalTime ? { arrival_time: forcedFailureArrivalTimestamp } : {}), ...(typeof fallbackTravelDist === 'number' ? { travel_dist: fallbackTravelDist } : {}) };
        const shouldDeleteSquareCodBeforeFailure = Number(delivery?.cod_total_amount_required || 0) > 0;
        await appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: status, completedAt: criticalUpdate.actual_delivery_time });
        if (shouldDeleteSquareCodBeforeFailure) await deleteCODWithTimeout(delivery.id, `Deleted before marking as ${status}`);
        await Promise.allSettled([updateDeliveryLocal(delivery.id, criticalUpdate, { skipSmartRefresh: true })]);
        if (onStatusUpdate) await onStatusUpdate(delivery.id, status, criticalUpdate, false);
        // Breadcrumbs cleared automatically by processBreadcrumbLeg backend automation on delivery completion
        const actedOnNextDelivery = delivery?.isNextDelivery === true;
        const allDriverDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const incompleteAfterThis = allDriverDeliveries.filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending');
        const shouldRecalculateFailureEtas = delivery?.delivery_date === localDeviceTodayStr && shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, criticalUpdate.actual_delivery_time);
        const remainingEtaDeliveries = incompleteAfterThis.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
        if (incompleteAfterThis.length === 0) {
          fabControlEvents.notifyDoneButtonClicked();
          window.dispatchEvent(new CustomEvent('showRouteSummary', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          // Only update driver status if they're not on duty (off_duty or on_break)
          if (currentUser?.id && currentUser?.driver_status !== 'on_duty') {
            await setDriverStatus({ newStatus: 'off_duty' });
            locationTracker.stopTracking();
            if (onDriverStatusChange) onDriverStatusChange('off_duty');
          }
        }
        window.dispatchEvent(new CustomEvent('deliveryStatusChanged', { detail: { triggeredBy: status, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, maxStops: 5 } }));
        const driverDeliveries = allDriverDeliveries.map((item) => item.id === delivery.id ? { ...item, ...criticalUpdate, isNextDelivery: false } : item);
        const incompleteDeliveries = driverDeliveries.filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending').sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
        await setAndCenterNextDelivery({ driverDeliveries, targetDeliveryId: incompleteDeliveries[0]?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, skipBackgroundSync: true, persistToBackend: true });
        if (actedOnNextDelivery && shouldRecalculateFailureEtas && remainingEtaDeliveries.length > 0) {
           // Calculate updated ETAs for remaining stops based on ACTUAL completion time of just-failed stop
           // Start from the failed stop's actual_delivery_time (not current device time)
           const failedStopTime = criticalUpdate.actual_delivery_time || forcedFailureTimestamp;
           const [failedHours, failedMinutes] = failedStopTime.split(':').map(Number);
           let currentEtaMinutes = failedHours * 60 + failedMinutes;
           const updatedRemainingWithEtas = remainingEtaDeliveries.map((stop, index) => {
             if (index === 0) {
               // First remaining stop (isNextDelivery): add travel time from failed stop's actual time
               currentEtaMinutes = currentEtaMinutes + (stop.estimated_duration_minutes || 5);
             } else {
               // Subsequent stops cascade from previous stop's ETA + that stop's estimated duration
               currentEtaMinutes = currentEtaMinutes + (remainingEtaDeliveries[index - 1]?.estimated_duration_minutes || 5);
             }
             const newEtaHours = Math.floor((currentEtaMinutes % 1440) / 60);
             const newEtaMins = currentEtaMinutes % 60;
             const newEta = `${String(newEtaHours).padStart(2, '0')}:${String(newEtaMins).padStart(2, '0')}`;
             return { ...stop, delivery_time_eta: newEta };
           });

          // Persist updated ETAs to database and broadcast to other devices
          await Promise.all(updatedRemainingWithEtas.map((stop) => {
            return Promise.all([
              updateDeliveryLocal(stop.id, { delivery_time_eta: stop.delivery_time_eta }, { skipSmartRefresh: true }),
              base44.entities.Delivery.update(stop.id, { delivery_time_eta: stop.delivery_time_eta }).catch(() => null)
            ]);
          }));

          // Broadcast mutations for real-time updates on other devices
          Promise.resolve().then(async () => {
            try {
              const { broadcastMutation } = await import('../utils/realtimeSync');
              await Promise.all(updatedRemainingWithEtas.map((item) => broadcastMutation('Delivery', 'update', item.id, { delivery_time_eta: item.delivery_time_eta })));
            } catch (broadcastError) {
              console.warn('⚠️ [Failure ETA] broadcast failed:', broadcastError?.message || broadcastError);
            }
          });

          // NOTE: No HERE API / optimizeRemainingStops call here.
          // ETAs are already updated locally above using estimated_duration_minutes.
          // Complete/fail/cancel never changes stop order — only a data refresh is needed.
          await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date).catch(() => null);
        }
        Promise.resolve().then(() => params.scheduleCompletionSideEffects({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, nextDeliveryId: incompleteDeliveries[0]?.id || null, lastCompletedDeliveryId: delivery.id, setOffDuty: incompleteDeliveries.length === 0, appUserId: currentDriverAppUser?.id || null, skipRouteOptimization: true, skipNextLegPolylineRefresh: true }).catch(() => {}));
        onClick?.(null);
        queueConsolidateBreadcrumbs({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, stopOrder: delivery.stop_order, status });
        fabControlEvents.notifyPhaseTwoCompleteRecenter();
        if (userHasRole(currentUser, 'driver')) await notifyDriverFailed({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery: { ...delivery, delivery_notes: updatedNotes }, store, appUsers, failureReason: reason });
        toast.success(`${isPickup ? 'Pickup' : 'Delivery'} marked as ${status}`, { description: `Dispatch has been notified. Reason: ${reason}` });
      } catch (error) {
        toast.error(`Failed to mark as ${status}: ${error.message}`);
      } finally {
        resumeOfflineSync('delivery_actions');
        backgroundSyncManager.resume();
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