import { useCallback, useState } from "react";
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";
import { setDriverStatus } from "@/functions/setDriverStatus";
import { locationTracker } from "../utils/locationTracker";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import { deleteCODWithTimeout } from '../utils/squareCODHandler';
import { cleanupSquareCodCatalogForDate } from '../utils/squareCodCatalogCleanup';
import { createDeliveryLocal, updateDeliveryLocal } from '../utils/offlineMutations';
import { flushQueuedDeliveryUpdates } from '../utils/updateBatcher';
import { fabControlEvents } from '../utils/fabControlEvents';
import { invalidate } from '../utils/dataManager';
import { generateCompletionTimestamp, calculateRetroactiveStopTiming, parseLocalTimestamp, shouldUseRegularTiming } from '../utils/timeRoundingHelper';
import { generateUniqueSID } from '../dashboard/DashboardHelpers';
import { buildRetryDelivery, collapseExpandedStopCardsForDriver, getCurrentLocalTimeString, getDriverRouteDeliveries, getNextActiveDelivery, getNextTrackingNumberInGroup, incrementTrackingNumber, optimizeRouteAndApplyNextDelivery, refreshDriverRoute, reorderActiveRouteLocally, setAndCenterNextDelivery, syncDriverLocationToStop, waitForRouteTransitionSettle, withPausedDriverLocationPoller } from "./stopCardActionHelpers";
// pendingBreadcrumbsManager removed — breadcrumbs managed via locationBreadcrumbService / offlineDB directly
const clearPendingBreadcrumbsForDelivery = async () => {};
const getPendingBreadcrumbsForDelivery = async () => null;
import { appendBoundaryBreadcrumbPoints } from '../utils/breadcrumbBoundaryPoints';
import { triggerSquareCodUpsert } from '../utils/directDeliverySideEffects';
import { runAcceptAllBatchPipeline } from '../utils/acceptAllBatchPipeline';
import { runWithDeliveryActionLock } from '../utils/deliveryActionLock';
import { pauseOfflineSync, resumeOfflineSync } from '../utils/offlineSync';
import { pauseRealtimeSync, resumeRealtimeSync } from '../utils/realtimeSync';
import { backgroundSyncManager } from '../utils/backgroundSyncManager';
import { performRouteOptimization } from '../utils/routeOptimizationCoordinator';
import { notifyDriverAcceptedAll, notifyDispatcherAssignedAll, notifyDriverStarted, notifyDriverCompleted, notifyDriverFailed, notifyDriverRetry, notifyDriverReturn } from "../utils/deliveryMessaging";
import { updatePreferredTravelMode } from '../dashboard/travelModeHelpers';

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

  // Cold-chain temperature log state
  const [pendingCoolerLog, setPendingCoolerLog] = useState(null);

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
    // Signal LiveTempBadge to re-arm BLE after any stop card action completes
    window.dispatchEvent(new CustomEvent('triggerBleReconnect'));
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
    pauseRealtimeSync();
    setIsAcceptingAll(true);
    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    try {
      driverLocationPoller.pause();
      smartRefreshManager.pause();
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

      // Only touch the FAB and center the map if we are NOT in Phase 1.
      // Phase 1 is the overview mode — Assign All / Accept All must not disturb it.
      const currentMapPhase = window.__currentMapViewPhase || 1;
      if (currentMapPhase !== 1) {
        fabControlEvents.notifyAcceptAllClicked();

        // Unlock FAB and center map on the store being assigned/accepted
        const storeLat = Number(store?.latitude);
        const storeLon = Number(store?.longitude);
        if (Number.isFinite(storeLat) && Number.isFinite(storeLon)) {
          fabControlEvents.notifyPhaseTwoTempUnlock();
          window.dispatchEvent(new CustomEvent('centerMapOnStore', {
            detail: { lat: storeLat, lng: storeLon, radiusKm: 3 }
          }));
        }
      }

      // Show "Processing Pending Stops" banner immediately while batch pipeline runs
      window.dispatchEvent(new CustomEvent('pendingStopsProcessingStarted', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));

      const { stagedChangedDeliveries, finalOfflineUpdates, codBatch } = await runAcceptAllBatchPipeline({
        triggerDelivery: delivery,
        allDeliveries,
        stores,
        currentLocalTime,
        deliveryTimeStart,
        updateDeliveriesLocally
      });

      // Build and append route summary note to the pickup delivery's notes
      try {
        const pickupDeliveries = pendingPickups || scopedPendingDeliveries;
        const totalCount = pickupDeliveries.length;

        const ispCount = pickupDeliveries.filter((d) => {
          const id = String(d?.delivery_id || '').toUpperCase();
          const notes = String(d?.delivery_notes || '').toLowerCase();
          return id.startsWith('ISP') || notes.includes('(ips)') || notes.includes(' ips ');
        }).length;
        const isdCount = pickupDeliveries.filter((d) => {
          const id = String(d?.delivery_id || '').toUpperCase();
          const notes = String(d?.delivery_notes || '').toLowerCase();
          return id.startsWith('ISD') || notes.includes('(isd)') || notes.includes(' isd ');
        }).length;

        const codItems = pickupDeliveries.filter((d) => Number(d?.cod_total_amount_required || 0) > 0);
        const codCount = codItems.length;
        const codTotal = codItems.reduce((sum, d) => sum + Number(d.cod_total_amount_required || 0), 0);

        const oversizedCount = pickupDeliveries.filter((d) => d?.oversized === true).length;
        const fridgeCount = pickupDeliveries.filter((d) => d?.fridge_item === true).length;

        const noteLines = [`Deliveries: ${totalCount}`];
        if (ispCount > 0 || isdCount > 0) noteLines.push(`ISP: ${ispCount} ISD: ${isdCount}`);
        if (codCount > 0) noteLines.push(`COD's: ${codCount} - $${codTotal.toFixed(2)}`);
        if (oversizedCount > 0) noteLines.push(`Oversized: ${oversizedCount}`);
        if (fridgeCount > 0) noteLines.push(`Fridge: ${fridgeCount}`);

        const summaryNote = noteLines.join('\n');
        const existingNotes = delivery.delivery_notes && delivery.delivery_notes !== 'No driver notes' ? delivery.delivery_notes : '';
        const updatedNotes = existingNotes ? `${existingNotes}\n${summaryNote}` : summaryNote;

        await updateDeliveryLocal(delivery.id, { delivery_notes: updatedNotes }, { skipSmartRefresh: true });
        updateDeliveriesLocally?.([{ ...delivery, delivery_notes: updatedNotes }], false);
      } catch (noteErr) {
        console.warn('[AcceptAll] Failed to write route summary note:', noteErr?.message || noteErr);
      }

      // Small delay so React can render "Processing Pending Stops" before switching to "Optimizing Route"
      await new Promise((resolve) => setTimeout(resolve, 400));

      // Dispatch optimizationStarted AFTER the batch pipeline has updated all delivery statuses
      // so the optimizer fires only once all transitions are complete.
      const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id;
      window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: isDriverAction ? 'accept_all' : 'assign_all', stopCount: scopedPendingDeliveries.length, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAll', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true, freshDeliveries: [...stagedChangedDeliveries, ...finalOfflineUpdates], alreadyOptimized: false } }));
      window.dispatchEvent(new CustomEvent('pendingToInTransit', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      invalidate('Delivery');

      // STEP 1: Wait for all backend status writes to commit before calling the optimizer.
      // A flat 600ms delay was insufficient when writing 10-20 deliveries in parallel —
      // the optimizer would fetch the DB and still see some as 'pending'.
      // Instead we poll until all transitioned deliveries are confirmed in_transit (max ~4s).
      try {
        const expectedIds = new Set(stagedChangedDeliveries.map(d => d.id).filter(Boolean));
        const maxAttempts = 8;
        const pollIntervalMs = 500;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          await new Promise(r => setTimeout(r, pollIntervalMs));
          try {
            const confirmedDeliveries = await base44.entities.Delivery.filter({
              driver_id: delivery.driver_id,
              delivery_date: delivery.delivery_date
            });
            const confirmedInTransit = new Set(
              (confirmedDeliveries || [])
                .filter(d => d.status === 'in_transit' && expectedIds.has(d.id))
                .map(d => d.id)
            );
            if (confirmedInTransit.size >= expectedIds.size) {
              console.log(`[AcceptAll] All ${expectedIds.size} writes confirmed in_transit after ${(attempt + 1) * pollIntervalMs}ms`);
              break;
            }
            console.log(`[AcceptAll] Write confirmation poll ${attempt + 1}/${maxAttempts}: ${confirmedInTransit.size}/${expectedIds.size} confirmed`);
          } catch (_) {
            // Poll failure is non-fatal — just move on after a brief wait
            break;
          }
        }
      } catch (_) {
        // Entire verification block is non-fatal — proceed to optimizer regardless
        await new Promise(r => setTimeout(r, 600));
      }

      // STEP 2: Run route optimization using the unified coordinator (same FAB path).
      // Uses the proven Manual FAB path: optimizeRemainingStops → regenerateType1Polyline.
      const now2 = new Date();
      const coordResult = await performRouteOptimization({
        driverId: delivery.driver_id,
        deliveryDate: delivery.delivery_date,
        source: 'accept_all',
        bypassDriverStatus: true,
      }).catch(() => null);

      const optimizeData = coordResult?.optimizeData || null;

      if (optimizeData?.success && Array.isArray(optimizeData.optimizedRoute) && optimizeData.optimizedRoute.length > 0) {
        window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { driverId: delivery.driver_id, updates: optimizeData.optimizedRoute.map((stop) => ({ deliveryId: stop.deliveryId || stop.delivery_id, newEta: stop.newETA || stop.eta })).filter((stop) => stop.deliveryId && stop.newEta) } }));
      }

      if (coordResult?.isDegraded) {
        console.warn('⚠️ [AcceptAll] Route optimization degraded — HERE routing unavailable, used straight-line approximation', {
          usedFallbackOrdering: coordResult?.usedFallbackOrdering,
          usedFallbackPolyline: coordResult?.usedFallbackPolyline,
        });
        toast.warning('Route order approximated — HERE routing was unavailable, so stop order/map lines may not be fully optimized.');
      }

      // polylineResponse stub — polylines regenerated internally by coordinator
      const polylineResponse = null;

      // STEP 3: Fetch fresh deliveries once (after both optimize + polyline calls complete).
      const refreshedDeliveries = await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
      const refreshedList = Array.isArray(refreshedDeliveries)
        ? refreshedDeliveries
        : Array.isArray(refreshedDeliveries?.deliveries)
          ? refreshedDeliveries.deliveries
          : null;

      if (Array.isArray(refreshedList) && refreshedList.length > 0) {
        // CRITICAL: Write fully-optimized + polyline-updated deliveries back to offline DB
        // so the UI reads the final ground-truth state (stop_order, encoded_polyline, ETAs)
        // rather than the intermediate optimistic snapshot written earlier in the pipeline.
        const { offlineDB } = await import('../utils/offlineDatabase');
        await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', delivery.delivery_date, refreshedList);
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
      resumeRealtimeSync();
      resumeOfflineSync('delivery_actions');
      driverLocationPoller.resume();
      smartRefreshManager.resume();
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
            await optimizeRouteAndApplyNextDelivery({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, updateDeliveryLocal, updateDeliveriesLocally, forceRefreshDriverDeliveries, shouldRegeneratePolylines: false, runOptimization: false });
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
            await optimizeRouteAndApplyNextDelivery({ driverId: delivery.driver_id, deliveryDate: retryDate, updateDeliveryLocal, updateDeliveriesLocally, forceRefreshDriverDeliveries, shouldRegeneratePolylines: false, runOptimization: false });
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
    pauseRealtimeSync();

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

        // Put the started stop first among active stops, clear isNextDelivery on all others
        const startMinutes = now.getHours() * 60 + now.getMinutes() + 5;
        const startTimeStr = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
        const reorderedActiveStops = activeStops.filter((d) => d?.id !== delivery.id);
        reorderedActiveStops.unshift({ ...delivery, status: 'in_transit', delivery_time_start: startTimeStr });
        const startedRouteDeliveries = [...completedStops, ...reorderedActiveStops, ...pendingStops]
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
            // For the started stop: persist status + delivery_time_start immediately
            if (item.id === delivery.id) {
              if (existing.status !== 'in_transit') updates.status = 'in_transit';
              if (item.delivery_time_start && existing.delivery_time_start !== item.delivery_time_start) updates.delivery_time_start = item.delivery_time_start;
            }
            if (Object.keys(updates).length === 0) return Promise.resolve(null);
            return Promise.all([
              updateDeliveryLocal(item.id, updates, { skipSmartRefresh: true, isBatchOperation: true }),
              base44.entities.Delivery.update(item.id, updates).catch(() => null)
            ]);
          })
        );

        if (!isPickup && patient?.id && patient?.status === 'inactive') {
          await base44.entities.Patient.update(patient.id, { status: 'active' });
        }

        await setAndCenterNextDelivery({ driverDeliveries: startedRouteDeliveries, targetDeliveryId: delivery.id, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, skipBackgroundSync: true, persistToBackend: true });
        window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: delivery.id } }));
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true, freshDeliveries: startedChangedDeliveries } }));
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

        // Final step: Route optimization and polyline regeneration
        if (!delivery?.id || !delivery?.driver_id || !delivery?.delivery_date) return;

        // Always run full optimization on start — the time window fix requires HERE to freely
        // sequence all remaining stops. The old bypass (isAlreadyNaturalNext) was preventing
        // optimization when this stop was already first by stop_order, but that bypassed
        // purgeAndRegeneratePolylines and time-window-based resequencing.
        const finishedSet = new Set(FINISHED_STATUSES);
        const isAlreadyNaturalNext = false; // Always run full optimization path

        // ── Kick off handleStartDelivery (marks stop as in_transit on backend) ──
        try {
          await base44.functions.invoke('handleStartDelivery', { deliveryId: delivery.id, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime });
        } catch (startErr) {
          const isNotFound = startErr?.status === 404 || String(startErr?.message || '').includes('404');
          if (!isNotFound) console.warn('⚠️ [Start] handleStartDelivery failed:', startErr?.message || startErr);
        }

        // ── Unlock UI immediately — optimization/polyline work runs in background ──
        // NOTE: managers stay paused; background tail re-pauses them before its API calls
        resumeOfflineSync('delivery_actions');
        driverLocationPoller.resume();
        smartRefreshManager.resume();
        backgroundSyncManager.resume();
        resumeRealtimeSync();
        resetActionLocks(true);

        await ensureDriverOnline().catch(() => {});
        if (userHasRole(currentUser, 'driver') && currentUser.id === delivery.driver_id) {
          notifyDriverStarted({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers }).catch(() => {});
        }
        // ── Cold-chain: prompt cooler temp on arrival ────────────────────────
        const hasPendingFridgeDeliveryForStore = isPickup && delivery?.store_id
          ? allDeliveries.some((d) =>
              d &&
              d.fridge_item === true &&
              d.store_id === delivery.store_id &&
              d.driver_id === delivery.driver_id &&
              d.delivery_date === delivery.delivery_date &&
              !['completed', 'failed', 'cancelled'].includes(d.status)
            )
          : false;
        if ((!isPickup && delivery?.fridge_item) || hasPendingFridgeDeliveryForStore) {
          triggerCoolerLogIfNeeded('Arrived');
        }
        fabControlEvents.reactivatePhaseTwoIfAvailable();

        // ── Background: optimization + polyline regen via unified coordinator ──
        window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'start_button', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
        Promise.resolve().then(async () => {
          // Re-pause for the async optimization work
          smartRefreshManager.pause();
          backgroundSyncManager.pause();
          pauseRealtimeSync();
          try {
            // Unified FAB path: optimizeRemainingStops → regenerateType1Polyline
            await performRouteOptimization({
              driverId: delivery.driver_id,
              deliveryDate: delivery.delivery_date,
              source: 'start_button',
              bypassDriverStatus: true,
            }).catch(() => null);

            // Fetch fresh deliveries after optimization
            const refreshedDeliveries = await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
            const refreshedList = Array.isArray(refreshedDeliveries)
              ? refreshedDeliveries
              : Array.isArray(refreshedDeliveries?.deliveries)
                ? refreshedDeliveries.deliveries
                : null;

            if (Array.isArray(refreshedList) && refreshedList.length > 0) {
              const withNextFlag = refreshedList.map((d) => ({
                ...d,
                isNextDelivery: d.id === delivery.id ? true : (d.isNextDelivery && d.id !== delivery.id ? false : d.isNextDelivery),
              }));
              await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', delivery.delivery_date, withNextFlag);
              updateDeliveriesLocally?.(withNextFlag, true);
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'startOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true, preserveLocalState: true, fullReplacement: true, freshDeliveries: withNextFlag } }));
              try {
                const { broadcastMutation } = await import('../utils/realtimeSync');
                await Promise.all(withNextFlag.map((item) => broadcastMutation('Delivery', 'update', item.id, item)));
              } catch (broadcastError) {
                console.warn('⚠️ [Start bg] delivery broadcast failed:', broadcastError?.message || broadcastError);
              }
            } else {
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'startOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true, preserveLocalState: false, fullReplacement: true } }));
            }

            await base44.functions.invoke('recalculateTrackingNumbers', {
              driverId: delivery.driver_id,
              deliveryDate: delivery.delivery_date,
            }).catch(() => null);

            window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers, triggeredBy: 'startOptimized' } }));
            window.dispatchEvent(new CustomEvent('polylineUpdated', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, source: 'start_button' } }));
            window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'start_button', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          } catch (bgErr) {
            console.warn('⚠️ [Start bg] background optimization failed:', bgErr?.message || bgErr);
          } finally {
            // Always resume after background work completes or fails
            smartRefreshManager.resume();
            backgroundSyncManager.resume();
            resumeRealtimeSync();
          }
        });

      } catch (error) {
        toast.error(`Failed to start: ${error.message}`);
        resumeOfflineSync('delivery_actions');
        driverLocationPoller.resume();
        smartRefreshManager.resume();
        backgroundSyncManager.resume();
        resumeRealtimeSync();
        resetActionLocks(true);
      } finally {
        // No-op: locks already released above on the happy path; error path releases above too
      }
    });

    if (lockResult?.skipped) return;
  }, [allDeliveries, appUsers, collapseDriverStopCards, currentUser, delivery, ensureDriverOnline, isCompleting, isCurrentCardStartLocked, isFailing, isGlobalStartLocked, isPickup, isProcessingBackground, isRestarting, isRetrying, isStarting, patient?.full_name, resetActionLocks, setIsEntityUpdating, setIsProcessingBackground, setIsStarting, shouldPreserveWindowTimesOnStart, store, updateDeliveriesLocally, userHasRole]);

  // ─── Shared terminal-action engine (complete / fail / cancel) ───────────────
  // Owns everything after the action-specific update object is built:
  //   collapse → IDB write → optimistic next-stop computation →
  //   setAndCenterNextDelivery → ETA cascade (fire-and-forget) →
  //   route-summary / off-duty → status-changed event → side-effects queue
  //
  // Nothing inside here touches forceRefreshDriverDeliveries — that lives in
  // the fire-and-forget tail so it never races the optimistic write.
  const executeTerminalAction = useCallback(async ({
    status,               // 'completed' | 'failed' | 'cancelled'
    criticalUpdate,       // the full field-delta to write to IDB
    pendingBreadcrumbsString,
    actedOnNextDelivery,
    shouldRecalculateEtas,
    skipCollapseCard = false,
  }) => {
    // 1. Collapse any expanded card (skip if caller already did it)
    if (!skipCollapseCard) await collapseDriverStopCards();

    // 2. Atomic IDB write — offline-first, no smart-refresh trigger
    await Promise.allSettled([updateDeliveryLocal(delivery.id, criticalUpdate, { skipSmartRefresh: true })]);

    // 3. Clear breadcrumbs now that IDB write is committed
    if (pendingBreadcrumbsString) {
      try {
        await clearPendingBreadcrumbsForDelivery({
          driverUserId: delivery.driver_id, deliveryId: delivery.id,
          stopOrder: delivery.stop_order, appUsers, force: true,
        });
      } catch {}
    }

    // 4. Build optimistic route snapshot from in-memory allDeliveries
    //    (do NOT call forceRefreshDriverDeliveries here — IDB hasn't caught up yet)
    const allDriverDeliveries = allDeliveries
      .filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date)
      .map((d) => d.id === delivery.id ? { ...d, ...criticalUpdate, isNextDelivery: false } : d);

    const incompleteDeliveries = allDriverDeliveries
      .filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending')
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    const nextStop = incompleteDeliveries[0] || null;
    const routeIsFinished = incompleteDeliveries.length === 0;

    // 5. Single authoritative isNextDelivery write — this is the ONLY place it fires
    await setAndCenterNextDelivery({
      driverDeliveries: allDriverDeliveries,
      targetDeliveryId: nextStop?.id || null,
      updateDeliveryLocal,
      updateDeliveriesLocally,
      driverId: delivery.driver_id,
      deliveryDate: delivery.delivery_date,
      skipBackgroundSync: true,
      persistToBackend: true,
    });

    // 6. ETA cascade — fire-and-forget so it never blocks the lock or races the flag
    if (actedOnNextDelivery && shouldRecalculateEtas && incompleteDeliveries.length > 0) {
      const currentLocalTime = getCurrentLocalTime?.() || localNowParts?.time || getCurrentLocalTimeString();
      const [hrs, mins] = currentLocalTime.split(':').map(Number);
      let currentEtaMinutes = hrs * 60 + mins;
      const updatedRemainingWithEtas = incompleteDeliveries.map((stop, index) => {
        if (index === 0) {
          currentEtaMinutes = currentEtaMinutes + 5 + (stop.estimated_duration_minutes || 5);
        } else {
          currentEtaMinutes = currentEtaMinutes + (incompleteDeliveries[index - 1]?.estimated_duration_minutes || 5);
        }
        const newEtaHours = Math.floor((currentEtaMinutes % 1440) / 60);
        const newEtaMins = currentEtaMinutes % 60;
        return { ...stop, delivery_time_eta: `${String(newEtaHours).padStart(2, '0')}:${String(newEtaMins).padStart(2, '0')}` };
      });

      Promise.resolve().then(async () => {
        try {
          await Promise.all(updatedRemainingWithEtas.map((stop) => Promise.all([
            updateDeliveryLocal(stop.id, { delivery_time_eta: stop.delivery_time_eta }, { skipSmartRefresh: true }),
            base44.entities.Delivery.update(stop.id, { delivery_time_eta: stop.delivery_time_eta }).catch(() => null),
          ])));
          const { broadcastMutation } = await import('../utils/realtimeSync');
          await Promise.all(updatedRemainingWithEtas.map((item) =>
            broadcastMutation('Delivery', 'update', item.id, { delivery_time_eta: item.delivery_time_eta })
          ));
        } catch (broadcastError) {
          console.warn(`⚠️ [${status} ETA] broadcast failed:`, broadcastError?.message || broadcastError);
        }
        // refreshDriverRoute fires AFTER IDB is settled — prevents stale-read bounce
        try {
          await refreshDriverRoute({
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date,
            forceRefreshDriverDeliveries,
            triggeredBy: `${status}EtaRefresh`,
          });
        } catch {}
      });
    }

    // 7. Route finished — show EOD dialog, go off-duty, disable location sharing
    if (routeIsFinished) {
      fabControlEvents.notifyDoneButtonClicked();

      // Disable location sharing on the AppUser record for the completing driver
      const driverAppUser = (appUsers || []).find((au) => au?.user_id === delivery.driver_id);
      try {
        if (driverAppUser?.id) {
          base44.entities.AppUser.update(driverAppUser.id, {
            driver_status: 'off_duty',
            location_tracking_enabled: false,
            current_latitude: null,
            current_longitude: null,
            location_updated_at: null,
          }).then(() => {
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
              detail: { appUsers: [{ ...driverAppUser, driver_status: 'off_duty', location_tracking_enabled: false }], singleUpdate: true }
            }));
          }).catch(() => {});
        }
      } catch {}

      // If the current logged-in user IS the completing driver, also update local status + stop tracker
      if (currentUser?.id === delivery.driver_id) {
        const driverStatus = driverAppUser?.driver_status ?? currentUser?.driver_status;
        if (driverStatus === 'on_duty') {
          try { await setDriverStatus({ newStatus: 'off_duty' }); locationTracker.stopTracking(); } catch {}
          if (onDriverStatusChange) onDriverStatusChange('off_duty');
        }
      }

      // Fire the EOD dialog event AFTER off-duty is handled
      window.dispatchEvent(new CustomEvent('showRouteSummary', {
        detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date },
      }));
    }

    // 8. Broadcast status-changed event for card-rail and other listeners
    window.dispatchEvent(new CustomEvent('deliveryStatusChanged', {
      detail: { triggeredBy: status, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, maxStops: 5 },
    }));

    // 9. Tail side-effects (polyline regen) — debounced, fire-and-forget
    Promise.resolve().then(() =>
      params.scheduleCompletionSideEffects({
        driverId: delivery.driver_id,
        deliveryDate: delivery.delivery_date,
        nextDeliveryId: nextStop?.id || null,
        lastCompletedDeliveryId: delivery.id,
        setOffDuty: routeIsFinished,
        appUserId: currentDriverAppUser?.id || null,
        skipRouteOptimization: true,
        skipNextLegPolylineRefresh: true,
      }).catch(() => {})
    );

    return { nextStop, routeIsFinished, incompleteDeliveries };
  }, [
    FINISHED_STATUSES, allDeliveries, appUsers,
    collapseDriverStopCards, currentDriverAppUser?.id, currentUser, delivery,
    forceRefreshDriverDeliveries, getCurrentLocalTime, localNowParts?.time,
    onDriverStatusChange, params, updateDeliveriesLocally,
  ]);
  // ────────────────────────────────────────────────────────────────────────────

  const triggerCoolerLogIfNeeded = useCallback((actionLabel) => {
    if (!delivery?.fridge_item) return;
    setPendingCoolerLog({ deliveryId: delivery.id, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, actionLabel });
  }, [delivery]);

  const clearCoolerLog = useCallback(() => setPendingCoolerLog(null), []);

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
      pauseRealtimeSync();
      smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
      try {
        const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
        if (!deliveryExists || deliveryExists.length === 0) {
          toast.error('This delivery has been deleted. Please refresh the page.');
          return;
        }
        if (currentUser?.driver_status !== 'on_duty') await ensureDriverOnline();
        await syncDriverLocationToStop({ currentUser, delivery, patient, store, targetDriverId: delivery.driver_id });

        const autoCODPayment = !isPickup && hasCODRequired && codPayments.length === 0 && onCODUpdate
          ? [{ type: 'Cash', amount: codTotalRequired }] : null;
        if (autoCODPayment) setCodPayments(autoCODPayment);

        // Breadcrumbs
        let pendingBreadcrumbsString = null;
        try {
          pendingBreadcrumbsString = await getPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers });
          await appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: 'completed', completedAt: delivery.actual_delivery_time || delivery.arrival_time || new Date().toISOString() });
          pendingBreadcrumbsString = await getPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers });
        } catch {}

        // Pickup transition
        const hasPendingPickupTransitions = isPickup && pendingPickups && pendingPickups.some((p) => p.status === 'pending');
        if (isPickup && hasPendingPickupTransitions) {
          await executeAcceptAllStops();
          await waitForRouteTransitionSettle(pendingPickups?.length || 0);
        }

        // Timing
        const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);
        const useRetroactiveTiming = !shouldUseRegularTiming({ deliveryDate: delivery?.delivery_date, todayDateString: localDeviceTodayStr, currentTimeString: localNowParts.time });
        const retroactiveTiming = useRetroactiveTiming ? await calculateRetroactiveStopTiming({ delivery, allDeliveries, patients, stores, todayDateString: localDeviceTodayStr, allowSameDay: true }) : null;
        const sameRouteDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const completionCodPayments = autoCODPayment || codPayments;
        const forcedCompletionTimestamp = useRetroactiveTiming ? (retroactiveTiming?.actual_delivery_time || localTimeString) : localTimeString;
        const forcedArrivalTimestamp = useRetroactiveTiming ? (retroactiveTiming?.arrival_time || delivery.arrival_time || localTimeString) : (delivery.arrival_time || localTimeString);
        const shouldOverwriteArrivalTime = useRetroactiveTiming ? !!forcedArrivalTimestamp : !delivery.arrival_time;
        const patientSavedSignatureUrl = patient?.signature_image_url || patient?.saved_signature_image_url || null;
        const fallbackSignatureUrl = patientSavedSignatureUrl || null;
        const fallbackTravelDist = resolveTravelDistFallback(delivery, retroactiveTiming?.travel_dist, sameRouteDeliveries);

        const completionUpdate = {
          status: 'completed',
          actual_delivery_time: forcedCompletionTimestamp || localTimeString,
          finished_leg_transport_mode: currentPreferredTravelMode,
          isNextDelivery: false,
          finished_leg_encoded_polyline: null,
          PolylineUpdated: true,
          ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}),
          ...(completionCodPayments.length > 0 ? { cod_payments: completionCodPayments } : {}),
          ...(fallbackSignatureUrl ? { signature_image_url: fallbackSignatureUrl } : {}),
          ...(shouldOverwriteArrivalTime && forcedArrivalTimestamp ? { arrival_time: forcedArrivalTimestamp } : {}),
          ...(typeof fallbackTravelDist === 'number' ? { travel_dist: fallbackTravelDist } : {}),
        };

        const shouldDeleteSquareCodBeforeComplete = !isPickup && Number(delivery?.cod_total_amount_required || 0) > 0 && hasDebitOrCreditCod(delivery, completionCodPayments);
        const shouldRecalculateCompletionEtas = delivery?.delivery_date === localDeviceTodayStr && shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, completionUpdate.actual_delivery_time);

        await appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: 'completed', completedAt: completionUpdate.actual_delivery_time });
        if (shouldDeleteSquareCodBeforeComplete) await deleteCODWithTimeout(delivery.id, 'Deleted after card COD completion');

        // Patient side-effect (independent of terminal engine)
        if (patient?.id) {
          try {
            const { updatePatientLocal } = await import('../utils/offlineMutations');
            await updatePatientLocal(patient.id, {
              ...(fallbackSignatureUrl ? { signature_image_url: fallbackSignatureUrl } : {}),
              ...(patient?.status === 'inactive' ? { status: 'active' } : {}),
            });
          } catch {}
          if (patient?.status === 'inactive') {
            await base44.entities.Patient.update(patient.id, { status: 'active' });
          }
        }

        // ── Terminal engine ──────────────────────────────────────────────────
        const actedOnNextDelivery = delivery?.isNextDelivery === true;
        await executeTerminalAction({
          status: 'completed',
          criticalUpdate: completionUpdate,
          pendingBreadcrumbsString,
          actedOnNextDelivery,
          shouldRecalculateEtas: shouldRecalculateCompletionEtas,
          skipCollapseCard: false,
        });
        // ────────────────────────────────────────────────────────────────────

        fabControlEvents.notifyPhaseTwoCompleteRecenter();
        fabControlEvents.reactivateFAB(true, { suppressIfPhase1: true, reason: 'stop_status_change' });
        // Prompt cooler temp if:
        // 1. Direct fridge delivery (fridge_item flag), OR
        // 2. Pickup whose notes contain a "Fridge: N" summary (from Accept All)
        const pickupHasFridgeItems = isPickup && (() => {
          const notes = String(delivery?.delivery_notes || '');
          const match = notes.match(/Fridge:\s*(\d+)/i);
          return match && Number(match[1]) > 0;
        })();
        if ((delivery?.fridge_item || pickupHasFridgeItems) && !delivery?.arrival_time) triggerCoolerLogIfNeeded('Completed');

        if (!isPickup && patient?.id && Number(delivery?.cod_total_amount_required || 0) > 0) {
          await base44.functions.invoke('syncPatientLastDeliveryDate', {
            data: { ...delivery, ...completionUpdate, patient_id: patient.id },
            old_data: { status: delivery.status },
            event: { type: 'update', entity_name: 'Delivery' },
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
            const hasEnRoutePickupForOriginStore = driverRouteDeliveries.some((item) => item && !item.patient_id && item.store_id === originatingStoreId && item.status === 'en_route');
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

        onClick?.(null);
        queueConsolidateBreadcrumbs({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, stopOrder: delivery.stop_order, status: 'completed' });

        // ── Cycling end marker completed: reset driver travel mode back to driving ──
        // When the driver taps Complete on the Cycling Route End marker we know the
        // cycling segment is fully finished. Reset preferred_travel_mode to 'driving'
        // so all subsequent stops default to driving mode.
        if (delivery?.is_cycling_marker && String(delivery?.delivery_notes || '').toLowerCase().includes('end')) {
          try {
            await updatePreferredTravelMode(appUsers, delivery.driver_id, 'driving');
          } catch (modeErr) {
            console.warn('[CyclingEnd] Failed to reset travel mode to driving:', modeErr?.message || modeErr);
          }
        }

        toast.success(`${isPickup ? 'Pickup' : 'Delivery'} completed!`);
      } catch (error) {
        toast.error(`Failed to complete: ${error.message}`);
        throw error;
      } finally {
        resumeOfflineSync('delivery_actions');
        driverLocationPoller?.resume?.();
        smartRefreshManager.resume();
        backgroundSyncManager.resume();
        resumeRealtimeSync();
        resetActionLocks(true);
      }
    });
    if (lockResult?.skipped) return;
  }, [FINISHED_STATUSES, allDeliveries, appUsers, blockCardToggle, codPayments, codTotalRequired,
    collapseDriverStopCards, currentDriverAppUser?.id, currentUser, delivery, displayName,
    ensureDriverOnline, executeAcceptAllStops, executeTerminalAction, forceRefreshDriverDeliveries,
    hasCODRequired, isCompleting, isExpanded, isFailing, isGlobalCompleteLocked, isGlobalRestartLocked,
    isPickup, isProcessingBackground, localDeviceTodayStr, localNowParts.time, onCODUpdate,
    onDriverStatusChange, params, patient, pendingPickups, resetActionLocks, safeDriver,
    setCodPayments, setIsCompleting, setIsProcessingBackground, store, updateDeliveriesLocally,
    userHasRole]);

  const handleFailureConfirm = useCallback(async (reason) => {
    const status = pendingFailureStatus;
    const lockResult = await runWithDeliveryActionLock('failure_delivery', async () => {
      pauseOfflineSync('delivery_actions');
      const { driverLocationPoller } = await import('../utils/driverLocationPoller');
      driverLocationPoller.pause();
      smartRefreshManager.pause();
      backgroundSyncManager.pause();
      pauseRealtimeSync();
      try {
        setShowFailureReasonDialog(false);
        setPendingFailureStatus(null);
        setIsFailing(true);
        fabControlEvents.deactivateFAB();
        fabControlEvents.notifyPhaseTwoTempUnlock();
        smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);

        const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
        if (!deliveryExists || deliveryExists.length === 0) {
          toast.error('This delivery has been deleted. Please refresh the page.');
          return;
        }
        await syncDriverLocationToStop({ currentUser, delivery, patient, store, targetDriverId: delivery.driver_id });

        // Breadcrumbs
        let pendingBreadcrumbsString = null;
        try {
          pendingBreadcrumbsString = await getPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers });
          await appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: status, completedAt: delivery.actual_delivery_time || delivery.arrival_time || new Date().toISOString() });
          pendingBreadcrumbsString = await getPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers });
        } catch {}

        // Timing
        const existingNotes = delivery.delivery_notes || '';
        const updatedNotes = existingNotes ? `${existingNotes}\n[${status.toUpperCase()}] ${reason}` : `[${status.toUpperCase()}] ${reason}`;
        const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);
        const useRetroactiveTiming = !shouldUseRegularTiming({ deliveryDate: delivery?.delivery_date, todayDateString: localDeviceTodayStr, currentTimeString: localNowParts.time });
        const retroactiveTiming = useRetroactiveTiming ? await calculateRetroactiveStopTiming({ delivery, allDeliveries, patients, stores, todayDateString: localDeviceTodayStr, allowSameDay: true }) : null;
        const forcedFailureTimestamp = useRetroactiveTiming ? (retroactiveTiming?.actual_delivery_time || localTimeString) : localTimeString;
        const forcedFailureArrivalTimestamp = useRetroactiveTiming ? (retroactiveTiming?.arrival_time || forcedFailureTimestamp) : (delivery.arrival_time || localTimeString);
        const existingArrivalDate = parseLocalTimestamp(delivery.arrival_time);
        const retroactiveArrivalDate = parseLocalTimestamp(forcedFailureArrivalTimestamp);
        const arrivalVsRetroArrivalDiffMinutes = existingArrivalDate && retroactiveArrivalDate ? Math.abs(retroactiveArrivalDate.getTime() - existingArrivalDate.getTime()) / 60000 : 0;
        const shouldAutoSetArrivalTime = (useRetroactiveTiming && !!retroactiveArrivalDate && (!existingArrivalDate || arrivalVsRetroArrivalDiffMinutes > 5)) || (!useRetroactiveTiming && !delivery.arrival_time);
        const allRouteDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const fallbackTravelDist = resolveTravelDistFallback(delivery, retroactiveTiming?.travel_dist, allRouteDeliveries);

        const criticalUpdate = {
          status,
          delivery_notes: updatedNotes,
          actual_delivery_time: forcedFailureTimestamp,
          finished_leg_transport_mode: currentPreferredTravelMode,
          isNextDelivery: false,
          PolylineUpdated: true,
          ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}),
          ...(shouldAutoSetArrivalTime ? { arrival_time: forcedFailureArrivalTimestamp } : {}),
          ...(typeof fallbackTravelDist === 'number' ? { travel_dist: fallbackTravelDist } : {}),
        };

        const shouldDeleteSquareCodBeforeFailure = Number(delivery?.cod_total_amount_required || 0) > 0;
        const shouldRecalculateFailureEtas = delivery?.delivery_date === localDeviceTodayStr && shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, criticalUpdate.actual_delivery_time);

        await appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: status, completedAt: criticalUpdate.actual_delivery_time });
        if (shouldDeleteSquareCodBeforeFailure) await deleteCODWithTimeout(delivery.id, `Deleted before marking as ${status}`);

        // ── Terminal engine ──────────────────────────────────────────────────
        const actedOnNextDelivery = delivery?.isNextDelivery === true;
        await executeTerminalAction({
          status,
          criticalUpdate,
          pendingBreadcrumbsString,
          actedOnNextDelivery,
          shouldRecalculateEtas: shouldRecalculateFailureEtas,
          skipCollapseCard: false,
        });
        // ────────────────────────────────────────────────────────────────────

        fabControlEvents.notifyPhaseTwoCompleteRecenter();
        // Only prompt if no arrival_time reading was already taken for this fridge stop
        if (delivery?.fridge_item && !delivery?.arrival_time) triggerCoolerLogIfNeeded(status === 'failed' ? 'Failed' : 'Cancelled');
        onClick?.(null);
        queueConsolidateBreadcrumbs({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, stopOrder: delivery.stop_order, status });
        if (userHasRole(currentUser, 'driver')) {
          await notifyDriverFailed({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery: { ...delivery, delivery_notes: updatedNotes }, store, appUsers, failureReason: reason });
        }
        toast.success(`${isPickup ? 'Pickup' : 'Delivery'} marked as ${status}`, { description: `Dispatch has been notified. Reason: ${reason}` });
      } catch (error) {
        toast.error(`Failed to mark as ${status}: ${error.message}`);
      } finally {
        resumeOfflineSync('delivery_actions');
        driverLocationPoller?.resume?.();
        smartRefreshManager.resume();
        backgroundSyncManager.resume();
        resumeRealtimeSync();
        resetActionLocks(true);
      }
    });
    if (lockResult?.skipped) return;
  }, [FINISHED_STATUSES, allDeliveries, appUsers, collapseDriverStopCards, currentUser, delivery,
    displayName, executeTerminalAction, forceRefreshDriverDeliveries, isPickup, localDeviceTodayStr,
    localNowParts.time, onClick, onDriverStatusChange, params, patient, pendingFailureStatus,
    resetActionLocks, safeDriver, setIsFailing, setPendingFailureStatus, setShowFailureReasonDialog,
    store, updateDeliveriesLocally, userHasRole]);

  return {
    blockCardToggle,
    pendingCoolerLog,
    clearCoolerLog,
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