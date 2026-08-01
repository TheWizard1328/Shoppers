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
import { pauseOfflineMutations, resumeOfflineMutations } from '../utils/offlineMutations';
import { pauseRealtimeSync, resumeRealtimeSync } from '../utils/realtimeSync';
import { backgroundSyncManager } from '../utils/backgroundSyncManager';
import { performRouteOptimization } from '../utils/routeOptimizationCoordinator';
import { recalculateTrackingNumbersLocal, applyTrackingNumberUpdates } from '../utils/recalculateTrackingNumbersLocal';
import { notifyDriverAccepted, notifyDispatcherAssignedAll, notifyDriverStarted, notifyDriverCompleted, notifyDriverFailed, notifyDriverRetry, notifyDriverReturn } from "../utils/deliveryMessaging";
import { updatePreferredTravelMode, normalizeTravelMode } from '../dashboard/travelModeHelpers';
import { dispatchStopCardActionCollapse } from '../utils/stopCardCollapseManager';
import { lockDeliveryFields } from '../utils/completionLockout';
import { consolidateBreadcrumbSegment } from "@/functions/consolidateBreadcrumbSegment";
import { recalculateAndUpdateStopOrders } from '../utils/stopOrderManager';

const START_ACTION_NAME = 'start_delivery';

const queueConsolidateBreadcrumbs = async ({ driverId, deliveryDate, deliveryId }) => {
  if (!driverId || !deliveryDate) return;

  // ── C: FLUSH the offline master trail to the server BEFORE slicing ────────
  // The master trail on the server is only updated every 3rd offline save (15s).
  // If the completion happens within that window, the server's master trail is
  // missing the last 1-2 points. Force-flushing ensures the slicing function
  // has the absolute latest GPS data.
  try {
    const { offlineDB } = await import('../utils/offlineDatabase');
    const offlineKey = `${driverId}__TODAY__${deliveryDate}`;
    const masterRecord = await offlineDB.getById(offlineDB.STORES.DELIVERY_BREADCRUMBS, offlineKey);
    if (masterRecord?.encoded_polyline && masterRecord?.timestamps) {
      const { base44 } = await import('@/api/base44Client');
      await base44.functions.invoke('syncPendingBreadcrumbs', {
        driver_id: driverId,
        delivery_date: deliveryDate,
        encoded_polyline: masterRecord.encoded_polyline,
        timestamps: masterRecord.timestamps,
        point_count: masterRecord.point_count,
      });
      console.log(`☁️ [Breadcrumbs] Pre-slice flush: ${masterRecord.point_count} points synced to server`);
    }
  } catch (flushErr) {
    console.warn('⚠️ [Breadcrumbs] Pre-slice flush failed:', flushErr?.message || flushErr);
    // Don't abort — the slicer will use whatever the server already has
  }

  try {
    const result = await consolidateBreadcrumbSegment({
      driver_id: driverId,
      delivery_date: deliveryDate,
      delivery_id: deliveryId,
    });
    if (result?.success) {
      console.log(`✅ [Breadcrumbs] Proximity slicing complete: ${result.total_segments} segments, ${result.master_point_count} master points`);
    } else {
      console.warn(`⚠️ [Breadcrumbs] Consolidation returned non-success:`, result?.error || result);
    }
  } catch (error) {
    console.warn('⚠️ [Breadcrumbs] Consolidation failed:', error?.message || error);
  }
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

    // Only act if the driver is currently off_duty or on_break
    const currentDriverAppUserForCheck = appUsers?.find((u) => u?.user_id === currentUser.id);
    const currentDriverStatus = currentDriverAppUserForCheck?.driver_status ?? currentUser?.driver_status;
    if (currentDriverStatus === 'on_duty') return; // already on duty — nothing to do

    try {
      const { data } = await setDriverStatus({ newStatus: 'on_duty' });
      const appUserId = data?.appUserId;
      const deliveryDate = delivery?.delivery_date;

      // CRITICAL: Update the local IDB AppUser record so a page refresh doesn't
      // show a stale 'off_duty' status.  The backend setDriverStatus already
      // broadcast the change via WebSocket (which updates the toggle UI), but
      // IDB is the boot-time source of truth and must be kept in sync.
      if (appUserId) {
        try {
          const { offlineDB } = await import('../utils/offlineDatabase');
          const existingRecord = await offlineDB.getById(offlineDB.STORES.APP_USERS, appUserId).catch(() => ({})) || {};
          const updatedRecord = {
            ...existingRecord,
            ...currentUser,
            driver_status: 'on_duty',
            location_tracking_enabled: true,
            location_updated_at: new Date().toISOString(),
            id: appUserId,
          };
          await offlineDB.save(offlineDB.STORES.APP_USERS, updatedRecord);

          // Broadcast to the DriverStatusToggle and all other UI listeners so the
          // toggle visually snaps to "On" without requiring a WebSocket round-trip.
          window.dispatchEvent(new CustomEvent('appUserUpdated', { detail: { appUser: updatedRecord } }));
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: [updatedRecord], mergeMode: 'merge' } }));
          window.dispatchEvent(new CustomEvent('driverStatusChanged', { detail: { userId: currentUser.id, newStatus: 'on_duty' } }));

          // Fetch the current route deliveries (backend has set isNextDelivery) and
          // push them to IDB + UI immediately so the stop cards reflect the new flag
          // without waiting for the next smart refresh cycle.
          if (deliveryDate) {
            try {
              const { base44 } = await import('@/api/base44Client');
              const freshDeliveries = await base44.entities.Delivery.filter({
                driver_id: currentUser.id,
                delivery_date: deliveryDate,
              });
              if (freshDeliveries?.length > 0) {
                await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
                updateDeliveriesLocally?.(freshDeliveries, false);
                window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                  detail: {
                    triggeredBy: 'ensureDriverOnline',
                    driverId: currentUser.id,
                    deliveryDate,
                    freshDeliveries,
                    fullReplacement: false,
                    preserveLocalState: true,
                    trustIsNextDelivery: true,
                  }
                }));
                // Scroll to the next delivery card
                const nextStop = freshDeliveries.find(d => d?.isNextDelivery === true);
                if (nextStop) {
                  setTimeout(() => window.dispatchEvent(new CustomEvent('centerNextDeliveryCard')), 300);
                }
              }
            } catch (fetchErr) {
              console.warn('[ensureDriverOnline] Could not sync deliveries after status toggle:', fetchErr?.message);
            }
          }
        } catch (idbErr) {
          console.warn('[ensureDriverOnline] IDB update failed (non-critical):', idbErr?.message);
        }
      }
      try { await locationTracker.startTracking({ ...currentUser, appUserId }); } catch {}
      // Sync liveDistanceTracker internal state (NOT segment writes — those are
      // handled by the backend setDriverStatus function which was just called).
      try {
        const { liveDistanceTracker } = await import('../utils/liveDistanceTracker');
        if (liveDistanceTracker.isTracking) {
          await liveDistanceTracker.updateDriverStatus('on_duty');
        }
      } catch {}
      if (onDriverStatusChange) onDriverStatusChange('on_duty');
    } catch (error) {
      console.error('Failed to auto-toggle driver online:', error);
    }
  }, [currentUser, appUsers, delivery?.driver_id, delivery?.delivery_date, localDeviceTodayStr, onDriverStatusChange, updateDeliveriesLocally]);

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
    setIsAcceptingAll(true);
    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    driverLocationPoller.pause();
    smartRefreshManager.pause();
    backgroundSyncManager.pause();
    pauseRealtimeSync();
    let pickupNoteData = null;
    try {
      setIsEntityUpdating(true);

      // ── Pre-flight: scope to pending stops for this store/driver/date ────────
      const scopedPendingDeliveries = (allDeliveries || []).filter(
        (item) => item &&
          item.driver_id === delivery.driver_id &&
          item.delivery_date === delivery.delivery_date &&
          item.status === 'pending' &&
          item.store_id === delivery.store_id
      );
      if (scopedPendingDeliveries.length === 0) {
        toast.error('No pending stops for this store.');
        return;
      }

      const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id;

      // Map/FAB setup (non-blocking)
      const currentMapPhase = window.__currentMapViewPhase || 1;
      if (currentMapPhase !== 1) {
        fabControlEvents.notifyAcceptAllClicked();
        const storeLat = Number(store?.latitude);
        const storeLon = Number(store?.longitude);
        if (Number.isFinite(storeLat) && Number.isFinite(storeLon)) {
          fabControlEvents.notifyPhaseTwoTempUnlock();
          window.dispatchEvent(new CustomEvent('centerMapOnStore', { detail: { lat: storeLat, lng: storeLon, radiusKm: 3 } }));
        }
      }

      // NOTE: routeOptimizationStarted is fired by the coordinator itself — do NOT fire it here
      // or the KITT bar gets two "start" events and never clears on the single "complete".
      window.dispatchEvent(new CustomEvent('pendingStopsProcessingStarted', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));

      // ── STEP 0: Cycling mode dialog (driver-only, blocks until user confirms/cancels) ──
      // Opens FIRST so the driver can select cycling stops before any pending → in_transit
      // transition. The dialog sets transport_mode='cycling' on selected stops and
      // transport_mode='driving' on the rest, then suppresses its own optimization.
      // Accept All's Step 4 optimizer handles the full route after the transition.
      const driverAppUser = appUsers.find(u => u?.user_id === delivery.driver_id);
      const isCyclingMode = String(driverAppUser?.preferred_travel_mode || '').toLowerCase() === 'cycling';
      if (isDriverAction && isCyclingMode) {
        await new Promise(resolve => {
          const onDone = () => { window.removeEventListener('cyclingModeDialogDone', onDone); resolve(); };
          window.addEventListener('cyclingModeDialogDone', onDone);
          window.dispatchEvent(new CustomEvent('openCyclingModeDialog', {
            detail: { deliveryDate: delivery.delivery_date, fromAcceptAll: true }
          }));
        });
      }

      // ── STEP 1: Transition pending → in_transit ───────────────────────────────
      const now = new Date();
      const startMins = now.getHours() * 60 + now.getMinutes() + 5;
      const deliveryTimeStart = `${String(Math.floor(startMins / 60) % 24).padStart(2, '0')}:${String(startMins % 60).padStart(2, '0')}`;
      const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      const { stagedChangedDeliveries, finalOfflineUpdates, codBatch } = await runAcceptAllBatchPipeline({
        triggerDelivery: delivery,
        allDeliveries,
        stores,
        patients,
        currentLocalTime,
        deliveryTimeStart,
        updateDeliveriesLocally,
        localDeviceTodayStr,
      });

      // ── STEP 2: Confirm transition complete — update UI optimistically ─────────
      const transitionedIds = new Set([
        ...(stagedChangedDeliveries || []).map(d => d?.id),
        ...(finalOfflineUpdates || []).map(d => d?.id),
      ].filter(Boolean));

      // Suppress WebSocket echoes for all transitioned deliveries
      const ECHO_EXPIRY = Date.now() + 120 * 1000;  // 120s — covers full 90s coordinator timeout + WS round-trip
      if (!window.__localDeliveryWrites) window.__localDeliveryWrites = new Map();
      for (const id of transitionedIds) window.__localDeliveryWrites.set(id, ECHO_EXPIRY);

      // CRITICAL: Lock transitioned fields against WS reversion. During Accept All,
      // the pending→in_transit transition + stop_order + tracking_number are all
      // written locally before the server confirms them. Stale WS echoes carrying
      // status='pending' or old stop_order would revert the optimistic UI state,
      // causing pending stops to reappear in the pickup card or duplicate
      // isNextDelivery flags. The 90s TTL covers the full coordinator timeout.
      for (const id of transitionedIds) {
        lockDeliveryFields(id, ['status', 'isNextDelivery', 'stop_order', 'tracking_number', 'delivery_time_start'], 90000, {
        status: 'in_transit', isNextDelivery: false,
      });
      }

      // Merge transitioned deliveries into allDeliveries for optimizer
      const transitionedMap = new Map();
      for (const d of [...(stagedChangedDeliveries || []), ...(finalOfflineUpdates || [])]) {
        if (d?.id) transitionedMap.set(d.id, d);
      }

      // CRITICAL: Scope to this driver+date ONLY. Passing all-drivers allDeliveries
      // to the engine causes O(n²) array ops (Maps/finds over 200+ records) that
      // block the main thread long enough to trigger "Page Unresponsive".
      // The coordinator already has global collision-detection for TR# via recalcTrackingNumbers.
      const scopedAllDeliveries = (allDeliveries || []).filter(
        d => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
      );
      const scopedIds = new Set(scopedAllDeliveries.map(d => d?.id).filter(Boolean));
      const fullDeliveriesForOptimizer = [
        ...scopedAllDeliveries.map(d => transitionedMap.get(d?.id) || d),
        ...[...(stagedChangedDeliveries || []), ...(finalOfflineUpdates || [])].filter(
          d => d?.id && !scopedIds.has(d.id)
        ),
      ];

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: {
          triggeredBy: 'acceptAll',
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          preserveLocalState: true,
          freshDeliveries: [...transitionedMap.values()],
          alreadyOptimized: false,
          trustIsNextDelivery: false,
        }
      }));
      window.dispatchEvent(new CustomEvent('pendingToInTransit', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      invalidate('Delivery');

      // ── STEP 2b: Fire notifications immediately — before optimizer runs ──────
      // CRITICAL: Must fire here (not after optimizer) so notifications always send
      // even if optimization times out or fails.
      try {
        const notifyDeliveries = stagedChangedDeliveries.filter(d => transitionedIds.has(d?.id));
        if (notifyDeliveries.length > 0) {
          const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id;
          if (isDriverAction) {
            // Driver accepted their own deliveries — notify dispatchers/admins
            notifyDriverAccepted({
              driver: currentUser,
              store,
              appUsers,
              pendingCount: notifyDeliveries.length,
            }).catch(() => {});
          } else {
            // Dispatcher assigned deliveries to a driver — notify the driver
            const assignedDriverAppUser = appUsers.find(u => u?.user_id === delivery.driver_id);
            if (assignedDriverAppUser) {
              notifyDispatcherAssignedAll({
                dispatcher: currentUser,
                driver: assignedDriverAppUser,
                store,
                deliveries: notifyDeliveries,
                patients,
              }).catch(() => {});
            }
          }
        }
      } catch (_) {}

      // ── STEP 3b: Square COD sync (fire-and-forget, does not block optimizer) ──
      if (codBatch.length > 0) {
        base44.functions.invoke('syncSquareCods', { items: codBatch })
          .then(r => {
            const errors = (r?.results || []).filter(x => x?.status === 'error');
            if (errors.length > 0) console.error('❌ [Square] COD sync errors:', errors);
            else console.log(`✅ [Square] COD sync: ${r?.processed || 0} items OK`);
          })
          .catch(e => console.error('❌ [Square] COD sync FAILED:', e?.message || e));
      }

      // Write pickup route summary note — DEFERRED to after optimization (Step 7).
      // CRITICAL: This was previously fired BEFORE the coordinator (Step 3b), which meant
      // the server write triggered a WS echo carrying a server record with NO stop_order/TR#
      // (optimization hadn't run yet). If the coordinator took >30s, the echo suppression
      // expired and the stale echo overwrote the optimized IDB data. Moving it here ensures
      // the server record already has stop_order/TR# when the notes write fires, so even
      // an unsuppressed echo carries the correct optimized data.
      pickupNoteData = (() => {
        try {
          const totalCount = scopedPendingDeliveries.length;
          const ispCount = scopedPendingDeliveries.filter(d => String(d?.delivery_id || '').toUpperCase().startsWith('ISP') || String(d?.delivery_notes || '').toLowerCase().includes('(ips)')).length;
          const isdCount = scopedPendingDeliveries.filter(d => String(d?.delivery_id || '').toUpperCase().startsWith('ISD') || String(d?.delivery_notes || '').toLowerCase().includes('(isd)')).length;
          const codItems = scopedPendingDeliveries.filter(d => Number(d?.cod_total_amount_required || 0) > 0);
          const codTotal = codItems.reduce((s, d) => s + Number(d.cod_total_amount_required || 0), 0);
          const oversizedCount = scopedPendingDeliveries.filter(d => d?.oversized === true).length;
          const fridgeCount = scopedPendingDeliveries.filter(d => d?.fridge_item === true).length;
          const noteLines = [`Deliveries: ${totalCount}`];
          if (ispCount > 0 || isdCount > 0) noteLines.push(`ISP: ${ispCount} ISD: ${isdCount}`);
          if (codItems.length > 0) noteLines.push(`COD's: ${codItems.length} - $${codTotal.toFixed(2)}`);
          if (oversizedCount > 0) noteLines.push(`Oversized: ${oversizedCount}`);
          if (fridgeCount > 0) noteLines.push(`Fridge: ${fridgeCount}`);
          const summaryNote = noteLines.join('\n');
          const existingNotes = delivery.delivery_notes && delivery.delivery_notes !== 'No driver notes' ? delivery.delivery_notes : '';
          const updatedNotes = existingNotes ? `${existingNotes}\n${summaryNote}` : summaryNote;
          return updatedNotes;
        } catch (_) { return null; }
      })();

      // ── STEP 4: Route optimization + polyline generation ─────────────────────
      // Uses same client-side engine as the manual FAB — should be ~same speed.
      const driverLat = Number(driverAppUser?.current_latitude);
      const driverLon = Number(driverAppUser?.current_longitude);
      const currentLocation = Number.isFinite(driverLat) && Number.isFinite(driverLon) ? { lat: driverLat, lon: driverLon } : null;

      const coordResult = await Promise.race([
        performRouteOptimization({
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          currentLocation,
          deliveries: fullDeliveriesForOptimizer,
          patients,
          stores,
          appUsers,
          source: 'accept_all',
          bypassDriverStatus: true,
          recalcTrackingNumbers: true,   // TR# computed inside coordinator, merged atomically with stop_order
          recalcTrackingStoreId: delivery.store_id,  // Only WRITE TR#s for this store — see all for collision detection
        }).catch(err => { console.error('❌ [AcceptAll] optimizer threw:', err?.message || err); return null; }),
        new Promise(resolve => setTimeout(() => {
          console.error('⏱️ [AcceptAll] optimizer timed out after 90s');
          resolve(null);
        }, 90000)),
      ]);

      if (coordResult && coordResult.success === false) {
        toast.error(`Route optimization failed: ${coordResult.error || 'unknown'}. Stop order may not be optimized.`);
      } else if (!coordResult) {
        toast.error('Route optimization encountered an error. Stop order may not be optimized.');
      }

      // ── STEP 5: TR#s already handled by coordinator (recalcTrackingNumbers: true) ──
      // The coordinator merged TR#s into the same bulkUpdateDeliveries write as stop_order —
      // atomic, no race, no separate server round-trip. freshDeliveries already has correct TR#s.
      const optimizedDeliveries = Array.isArray(coordResult?.freshDeliveries) ? coordResult.freshDeliveries : [];
      const finalDeliveries = optimizedDeliveries.length > 0
        ? (() => {
            const optMap = new Map(optimizedDeliveries.map(d => [d.id, d]));
            return (fullDeliveriesForOptimizer || []).map(d => optMap.get(d?.id) || d);
          })()
        : fullDeliveriesForOptimizer;

      // ── STEP 6: In-app message + push notification with updated TR#s ─────────
      // NOTE: Notifications were already sent in STEP 2b (before optimizer) using
      // stagedChangedDeliveries, so they always fire regardless of optimizer outcome.

      // ── STEP 7: IDB write (authoritative) ────────────────────────────────────
      // NOTE: The coordinator's bulkUpdateDeliveries (Step 4) already wrote status='in_transit'
      // to the server for all transitioning deliveries — the engine now includes status in
      // every writeBatch entry. This Step just commits the fully-merged finalDeliveries to
      // IDB and dispatches the UI update.
      // SAFETY NET: If any delivery was NOT in the coordinator writeBatch (e.g. optimizer
      // returned 0 stops or failed entirely), write its status to the server here.
      if (finalDeliveries.length > 0) {
        const { offlineDB } = await import('../utils/offlineDatabase');
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, finalDeliveries).catch(() => {});
        updateDeliveriesLocally?.(finalDeliveries, false);

        // Safety net: find any transitioned deliveries whose status was NOT written
        // by the coordinator (deliveries not in coordResult.freshDeliveries, or
        // optimizer failed). Fire-and-forget — does not block UI.
        const writtenByCoord = new Set((coordResult?.freshDeliveries || []).map(d => d?.id));
        const missedUpdates = (stagedChangedDeliveries || [])
          .filter(d => d?.id && !writtenByCoord.has(d.id))
          .map(d => ({
            id: d.id,
            data: { status: 'in_transit', delivery_time_start: d.delivery_time_start, delivery_time_eta: d.delivery_time_eta }
          }));

        if (missedUpdates.length > 0) {
          console.log(`[AcceptAll] Safety-net status write for ${missedUpdates.length} deliveries missed by coordinator`);
          base44.functions.invoke('bulkUpdateDeliveries', { updates: missedUpdates }).catch(e =>
            console.warn('[AcceptAll] Safety-net status write failed:', e?.message)
          );
        }

        // Clear echo suppression — server + IDB are now in sync
        for (const id of transitionedIds) window.__localDeliveryWrites?.delete(id);
      }

      // ── STEP 7b: Write pickup summary notes (deferred from Step 3b) ──────────
      // Write notes to IDB + state immediately so UI shows them now.
      // Server write is fire-and-forget — the final server sync (finally block, +2s)
      // will pull back the server record which by then has the notes. We store
      // pickupNoteData in a ref so the finally-block sync can include it in the merge.
      if (pickupNoteData) {
        // IDB + state immediately (so UI shows now)
        updateDeliveriesLocally?.([{ ...delivery, delivery_notes: pickupNoteData }], false);
        // Server write fire-and-forget (coordinator has already committed stop_order/TR#)
        updateDeliveryLocal(delivery.id, { delivery_notes: pickupNoteData }, { skipSmartRefresh: true }).catch(() => {});
      }

      // ── STEP 8: Final UI update ────────────────────────────────────────────────
      if (finalDeliveries.length > 0) {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            triggeredBy: 'acceptAllOptimized',
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date,
            alreadyOptimized: true,
            preserveLocalState: true,
            fullReplacement: false,
            freshDeliveries: finalDeliveries,
            trustIsNextDelivery: true,
          }
        }));
      } else {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            triggeredBy: 'acceptAllOptimized',
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date,
            alreadyOptimized: true,
            preserveLocalState: false,
            fullReplacement: true,
          }
        }));
      }

      window.dispatchEvent(new CustomEvent('polylineUpdated', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, source: 'accept_all_button' } }));

    } catch (error) {
      console.error('❌ [Accept All] Error:', error);
      toast.error(`Failed to accept all: ${error.message}`);
    } finally {
      setIsEntityUpdating(false);
      setIsAcceptingAll(false);
      try { driverLocationPoller.resume(); } catch (e) { console.warn('[AcceptAll] driverLocationPoller.resume failed:', e?.message); }
      try { smartRefreshManager.restart(); } catch (e) { console.warn('[AcceptAll] smartRefreshManager.restart failed:', e?.message); }
      try { backgroundSyncManager.resume(); } catch (e) { console.warn('[AcceptAll] backgroundSyncManager.resume failed:', e?.message); }
      try { resumeRealtimeSync(); } catch (e) { console.warn('[AcceptAll] resumeRealtimeSync failed:', e?.message); }

      // CRITICAL: Pull authoritative server state for this driver/date so the local
      // device UI reflects what all other devices already see. Runs fire-and-forget
      // so it doesn't block spinner removal or card collapse. Uses a short delay to
      // let the server's bulkUpdateDeliveries commit propagate before fetching.
      // forceRefreshDriverDeliveries fetches from server, writes to IDB, and dispatches
      // deliveriesUpdated — syncing sync managers and UI in one shot.
      // Capture closure values for the final sync (closures are evaluated lazily)
      const _finalPickupId = delivery.id;
      const _finalPickupNotes = pickupNoteData;
      const _finalDriverId = delivery.driver_id;
      const _finalDate = delivery.delivery_date;

      setTimeout(() => {
        forceRefreshDriverDeliveries?.(_finalDriverId, _finalDate)
          .then(fresh => {
            if (Array.isArray(fresh) && fresh.length > 0) {
              // CRITICAL: If the pickup's delivery_notes server write hasn't propagated yet,
              // the fresh array will have stale (empty) notes for the pickup card.
              // Preserve the just-written notes by merging pickupNoteData into the result.
              const mergedFresh = _finalPickupNotes
                ? fresh.map(d => d?.id === _finalPickupId && !d?.delivery_notes
                    ? { ...d, delivery_notes: _finalPickupNotes }
                    : d)
                : fresh;
              updateDeliveriesLocally?.(mergedFresh, false);
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                detail: {
                  triggeredBy: 'acceptAllFinalSync',
                  driverId: _finalDriverId,
                  deliveryDate: _finalDate,
                  preserveLocalState: false,
                  fullReplacement: false,
                  freshDeliveries: mergedFresh,
                  alreadyOptimized: true,
                  trustIsNextDelivery: true,
                }
              }));
              console.log(`✅ [AcceptAll] Final server sync: ${fresh.length} deliveries pulled`);
            }
          })
          .catch(e => console.warn('[AcceptAll] Final server sync failed:', e?.message));
      }, 2500); // 2.5s — gives bulkUpdateDeliveries + notes write time to propagate

      window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      try { dispatchStopCardActionCollapse(); } catch (e) { console.warn('[AcceptAll] dispatchStopCardActionCollapse failed:', e?.message); }
      try { onClick?.(null); } catch (e) { console.warn('[AcceptAll] onClick failed:', e?.message); }
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
      dispatchStopCardActionCollapse();
      onClick?.(null);
      // Use the RETURN delivery's actual date (today), NOT the original delivery's date.
      // handleCreateReturn already ran performRouteOptimization with the correct date,
      // so we only need COD cleanup + notification here — no redundant optimization.
      const _returnDeliveryDate = createdReturnDelivery?.delivery_date || createdReturnDelivery?.data?.delivery_date;
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'return', driverId: delivery.driver_id, deliveryDate: _returnDeliveryDate } }));
      Promise.resolve().then(async () => {
        try {
          const backgroundTasks = [];
          if ((delivery.cod_total_amount_required || 0) > 0) backgroundTasks.push(deleteCODWithTimeout(delivery.id, 'Removed after creating return delivery'));
          if (userHasRole(currentUser, 'driver')) backgroundTasks.push(notifyDriverReturn({ driver: currentUser, patientName: displayName, delivery, store, appUsers }));
          await Promise.allSettled(backgroundTasks);
        } catch {}
      });
    } finally {
      setIsCreatingReturn(false);
    }
  }, [appUsers, currentUser, delivery, displayName, isCreatingReturn, onClick, onCreateReturn, returnPatient, setIsCreatingReturn, setReturnPatient, setShowReturnConfirm, store, stores, userHasRole]);

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
          // Run the route optimizer + polyline generator on the RETRY delivery's date (retryDate),
          // NOT the original delivery's date or the driver's selected date. buildRetryDelivery
          // may set retryDate to today (if before 9pm) or keep the original date — we must optimize
          // whichever date the retry delivery was actually assigned to.
          window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'retry', driverId: delivery.driver_id, deliveryDate: retryDate } }));
          try {
            const retryCoordResult = await performRouteOptimization({
              driverId: delivery.driver_id,
              deliveryDate: retryDate,
              source: 'retry',
            });
            if (retryCoordResult?.success && Array.isArray(retryCoordResult.freshDeliveries) && retryCoordResult.freshDeliveries.length > 0) {
              updateDeliveriesLocally(retryCoordResult.freshDeliveries, false);
            }
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'retryOptimized', driverId: delivery.driver_id, deliveryDate: retryDate, alreadyOptimized: true, preserveLocalState: true, freshDeliveries: retryCoordResult?.freshDeliveries } }));
          } catch (retryOptErr) {
            console.warn('⚠️ [Retry] Route optimization failed:', retryOptErr?.message || retryOptErr);
          } finally {
            window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'retry', driverId: delivery.driver_id, deliveryDate: retryDate } }));
          }
          if (userHasRole(currentUser, 'driver')) await notifyDriverRetry({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery, store, appUsers });
          dispatchStopCardActionCollapse();
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
          const isInterStoreStop = !!(delivery._interstore_source_id || delivery._interstore_dest_id);
          const newStatus = (isPickup && !isInterStoreStop) ? 'en_route' : 'in_transit';
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
          dispatchStopCardActionCollapse();
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

      // ── Cycling marker fast path ─────────────────────────────────────────────
      // Cycling markers (Start/End waypoints) only need:
      //   1. isNextDelivery set on this stop, cleared on all others
      //   2. Background route optimization
      // Nothing else — no status change, no delivery_time_start, no patient activation,
      // no notifications, no handleStartDelivery backend call.
      // Writing status='en_route' to a cycling marker crashes the app because cycling
      // markers only support in_transit/completed/pending transitions.
      if (delivery.is_cycling_marker) {
        pauseOfflineSync('delivery_actions');
        try {
          const { offlineDB } = await import('../utils/offlineDatabase');
          const routeDeliveries = getDriverRouteDeliveries(allDeliveries, delivery);

          // 1. Update isNextDelivery locally
          const updatedDeliveries = routeDeliveries.map((d) => ({
            ...d,
            isNextDelivery: d.id === delivery.id,
          }));
          const changed = updatedDeliveries.filter((item) => {
            const existing = routeDeliveries.find((r) => r?.id === item.id);
            return existing && existing.isNextDelivery !== item.isNextDelivery;
          });
          if (changed.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, changed);
            updateDeliveriesLocally?.(changed, false);
            // Lock isNextDelivery on cycling marker to prevent WS reversion
            for (const item of changed) {
              lockDeliveryFields(item.id, ['isNextDelivery', 'stop_order'], 60000, {
                isNextDelivery: item.isNextDelivery,
              });
            }
            await Promise.all(changed.map((item) =>
              base44.entities.Delivery.update(item.id, { isNextDelivery: item.isNextDelivery }).catch(() => null)
            ));
          }

          await setAndCenterNextDelivery({ driverDeliveries: updatedDeliveries, targetDeliveryId: delivery.id, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, skipBackgroundSync: true, persistToBackend: true });
          window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: delivery.id } }));
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true, freshDeliveries: changed } }));

          resumeOfflineSync('delivery_actions');
          driverLocationPoller.resume();
          smartRefreshManager.resume();
          backgroundSyncManager.resume();
          resumeRealtimeSync();
          resetActionLocks(true);
          fabControlEvents.reactivatePhaseTwoIfAvailable();
          // Same completionFabRelock dispatch for cycling marker start path
          const _cyclingPhase = window.__currentMapViewPhase || 1;
          if (_cyclingPhase === 2 || _cyclingPhase === 3) {
            setTimeout(() => {
              window.dispatchEvent(new CustomEvent('completionFabRelock', {
                detail: { phase: _cyclingPhase, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
              }));
            }, 300);
          }

          // 2. Background route optimization only
          window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'start_button', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          Promise.resolve().then(async () => {
            smartRefreshManager.pause();
            backgroundSyncManager.pause();
            pauseRealtimeSync();
            pauseOfflineSync('delivery_actions');
            pauseOfflineMutations();
            try {
              await performRouteOptimization({
                driverId: delivery.driver_id,
                deliveryDate: delivery.delivery_date,
                deliveries: allDeliveries,
                patients,
                stores,
                appUsers,
                source: 'start_button',
                bypassDriverStatus: true,
              }).catch(() => null);
            } finally {
              resumeOfflineSync('delivery_actions');
              resumeOfflineMutations();
              smartRefreshManager.resume();
              backgroundSyncManager.resume();
              resumeRealtimeSync();
            }
            window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'start_button', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          });
        } catch (error) {
          toast.error(`Failed to start: ${error.message}`);
          resumeOfflineSync('delivery_actions');
          driverLocationPoller.resume();
          smartRefreshManager.resume();
          backgroundSyncManager.resume();
          resumeRealtimeSync();
          resetActionLocks(true);
        }
        return; // exit lock
      }
      // ── End cycling marker fast path ─────────────────────────────────────────

      pauseOfflineSync('delivery_actions');
      try {
        const now = new Date();
        const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const isValidObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
        if (!isValidObjectId(delivery.id) || !isValidObjectId(delivery.driver_id)) throw new Error('This stop is still syncing. Please try again in a moment.');

        const routeDeliveries = getDriverRouteDeliveries(allDeliveries, delivery);
        await collapseDriverStopCards();

        const finishedStatuses = new Set(FINISHED_STATUSES);
        const isInterStoreStart = !!(delivery._interstore_source_id || delivery._interstore_dest_id);
        const expectedStartStatus = (isPickup && !isInterStoreStart) ? 'en_route' : 'in_transit';

        // Optimistic UI: only update isNextDelivery + status on the started stop.
        // stop_order is NOT reassigned here — setNextDeliveryFlag (backend) is the single authority.
        const startedRouteDeliveries = routeDeliveries.map((d) => {
          if (d?.id === delivery.id) {
            return { ...d, status: expectedStartStatus, isNextDelivery: true };
          }
          if (d?.isNextDelivery) {
            return { ...d, isNextDelivery: false };
          }
          return d;
        }).filter(Boolean);

        const { offlineDB } = await import('../utils/offlineDatabase');
        const startedChangedDeliveries = startedRouteDeliveries.filter((item) => {
          const existing = routeDeliveries.find((routeItem) => routeItem?.id === item?.id);
          return existing && JSON.stringify(existing) !== JSON.stringify(item);
        });

        // CRITICAL: Extended WebSocket echo suppression for all affected delivery IDs.
        // Start triggers sequential server writes: direct Delivery.update for status +
        // isNextDelivery, then setAndCenterNextDelivery, then handleStartDelivery +
        // setNextDeliveryFlag backend calls, then the route optimizer's bulkUpdate.
        // Each generates WS echoes that can arrive 5-15s later — past broadcastMutation's
        // 15s legacy TTL. Using 90s extended suppression covers the full window.
        const _startEchoExpiry = Date.now() + 90 * 1000;
        if (!window.__localDeliveryWrites) window.__localDeliveryWrites = new Map();
        for (const _d of startedRouteDeliveries) {
          if (_d?.id) {
            const _existing = window.__localDeliveryWrites.get(_d.id);
            if (!_existing || _existing < Date.now() + 1000) {
              window.__localDeliveryWrites.set(_d.id, _startEchoExpiry);
            }
          }
        }

        if (startedChangedDeliveries.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, startedChangedDeliveries.filter(Boolean));
          updateDeliveriesLocally?.(startedChangedDeliveries.filter(Boolean), false);
          // Lock fields against WS reversion — the Start action sets isNextDelivery + status
          // locally before the server confirms. Stale echoes with the old isNextDelivery
          // flag on the previous stop would cause duplicate next badges until refresh.
          for (const item of startedChangedDeliveries) {
            if (item?.isNextDelivery === true) {
              lockDeliveryFields(item.id, ['status', 'isNextDelivery', 'stop_order'], 60000, {
                status: expectedStartStatus, isNextDelivery: true,
              });
            } else if (item?.isNextDelivery === false) {
              lockDeliveryFields(item.id, ['isNextDelivery'], 60000, {
                isNextDelivery: false,
              });
            }
          }
        }

        await Promise.all(
          startedChangedDeliveries.map((item) => {
            const existing = routeDeliveries.find((routeItem) => routeItem?.id === item?.id);
            if (!existing) return Promise.resolve(null);
            const updates = {};
            if ((existing.isNextDelivery || false) !== (item.isNextDelivery || false)) updates.isNextDelivery = item.isNextDelivery || false;
            // For the started stop: persist status immediately (no delivery_time_start on Start)
            if (item.id === delivery.id && existing.status !== expectedStartStatus) {
              updates.status = expectedStartStatus;
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

        // ── Ensure driver is on_duty (fire-and-forget — don't block optimization) ──
        // The optimistic update already set isNextDelivery + status. Driver status
        // toggle doesn't affect route optimization and can complete in the background.
        ensureDriverOnline().catch(() => {});

        // ── handleStartDelivery (fire-and-forget) ──
        // The optimistic update above already wrote isNextDelivery + status to both
        // IDB and the server via base44.entities.Delivery.update. This backend call
        // duplicates that work (fetches all route deliveries, sets isNextDelivery,
        // clears previous, stamps departure origin). Running it without await saves
        // 2-5s on the Start critical path. If it fails, the optimistic state is
        // already correct and the optimizer's bulkUpdateDeliveries will confirm it.
        base44.functions.invoke('handleStartDelivery', { deliveryId: delivery.id, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime }).catch((startErr) => {
          const isNotFound = startErr?.status === 404 || String(startErr?.message || '').includes('404');
          if (!isNotFound) console.warn('⚠️ [Start] handleStartDelivery failed:', startErr?.message || startErr);
        });

        // ── setNextDeliveryFlag (fire-and-forget) ──
        // The optimistic update already set isNextDelivery on the correct stop and
        // cleared it on the previous one via direct Delivery.update calls. This
        // backend function also repairs stop_order — but the optimizer assigns its
        // own stop_order via the HERE engine and writes it atomically through
        // bulkUpdateDeliveries, making the repair redundant. Running it without await
        // saves 2-5s on the Start critical path while still confirming isNextDelivery
        // and repairing any edge-case stop_order issues in the background.
        base44.functions.invoke('setNextDeliveryFlag', { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }).catch((repairErr) => {
          console.warn('⚠️ [Start] setNextDeliveryFlag failed:', repairErr?.message || repairErr);
        });

        // ── Unlock UI immediately — optimization/polyline work runs in background ──
        // NOTE: managers stay paused; background tail re-pauses them before its API calls
        resumeOfflineSync('delivery_actions');
        driverLocationPoller.resume();
        smartRefreshManager.resume();
        backgroundSyncManager.resume();
        resumeRealtimeSync();
        resetActionLocks(true);
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
        // CRITICAL: Also dispatch completionFabRelock for phase 3 —
        // reactivatePhaseTwoIfAvailable only handles phase 2. If the driver
        // is in phase 3, the FAB stays deactivated after Start.
        const _phaseAfterStart = window.__currentMapViewPhase || 1;
        if (_phaseAfterStart === 2 || _phaseAfterStart === 3) {
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('completionFabRelock', {
              detail: { phase: _phaseAfterStart, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
            }));
          }, 300);
        }

        // ── Background: optimization + polyline regen via unified coordinator ──
        // KITT bar activates IMMEDIATELY on Start button click
        window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'start_button', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
        Promise.resolve().then(async () => {
          // Re-pause for the async optimization work
          smartRefreshManager.pause();
          backgroundSyncManager.pause();
          pauseRealtimeSync();
          pauseOfflineSync('delivery_actions');
          pauseOfflineMutations();
          try {
            // Unified FAB path: optimizeRemainingStops → regenerateType1Polyline
            // Merge startedRouteDeliveries (just-updated local state) into allDeliveries
            const _startChangedMap = new Map();
            for (const d of (startedRouteDeliveries || [])) {
              if (d?.id) _startChangedMap.set(d.id, d);
            }
            // CRITICAL: Filter to ONLY the current driver + date. Passing ALL deliveries
            // causes the optimizer to return ALL deliveries as freshDeliveries, which then
            // get broadcast via broadcastMutation for every single one — including
            // out-of-date deliveries from other drivers/months (the 32k broadcast cascade).
            const _startScopedDeliveries = (allDeliveries || []).filter(
              d => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
            );
            const _startFullDeliveries = [
              ..._startScopedDeliveries.map(d => _startChangedMap.get(d?.id) || d),
              ...(startedRouteDeliveries || []).filter(d => d?.id && !_startScopedDeliveries.find(a => a?.id === d.id))
            ];


            const coordResult = await performRouteOptimization({
              driverId: delivery.driver_id,
              deliveryDate: delivery.delivery_date,
              deliveries: _startFullDeliveries,
              patients,
              stores,
              appUsers,
              source: 'start_button',
              bypassDriverStatus: true,
            }).catch((err) => { console.warn('⚠️ [Start bg] optimization failed:', err?.message || err); return null; });

            // Use freshDeliveries from the optimizer — it already wrote to IDB and
            // the backend via bulkUpdateDeliveries. No need to re-fetch from server
            // (the old forceRefreshDriverDeliveries call added up to 15s of latency).
            const refreshedList = coordResult?.freshDeliveries || null;
            const _refreshPolyCount = Array.isArray(refreshedList) ? refreshedList.filter(d => d?.encoded_polyline).length : 0;
            console.log(`[Start bg] optimizer returned ${refreshedList?.length || 0} deliveries, ${_refreshPolyCount} with polylines`);

            if (Array.isArray(refreshedList) && refreshedList.length > 0) {
              const withNextFlag = refreshedList.map((d) => ({
                ...d,
                isNextDelivery: d.id === delivery.id ? true : (d.isNextDelivery && d.id !== delivery.id ? false : d.isNextDelivery),
              }));
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, withNextFlag).catch(() => {});
              updateDeliveriesLocally?.(withNextFlag, false);
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'startOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true, preserveLocalState: true, fullReplacement: false, freshDeliveries: withNextFlag } }));
              // Broadcast mutations fire-and-forget (don't block UI completion)
              import('../utils/realtimeSync').then(({ broadcastMutation }) => {
                Promise.all(withNextFlag.map((item) => broadcastMutation('Delivery', 'update', item.id, item))).catch(() => {});
              }).catch(() => {});
            } else {
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'startOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true, preserveLocalState: false, fullReplacement: true } }));
            }

            try {
              const _startDeliveries = (refreshedList || allDeliveries).filter(d => d?.driver_id === delivery.driver_id && d?.delivery_date === delivery.delivery_date);
              const _startTRUpdates = recalculateTrackingNumbersLocal({ deliveries: _startDeliveries, stores, patients });
              if (_startTRUpdates.length > 0) {
                await applyTrackingNumberUpdates({ updates: _startTRUpdates, allDeliveries: _startDeliveries, updateDeliveriesLocally, updateDeliveryLocal });
              }
            } catch (_) {}

            window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers, triggeredBy: 'startOptimized' } }));
            window.dispatchEvent(new CustomEvent('polylineUpdated', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, source: 'start_button' } }));
            window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'start_button', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          } catch (bgErr) {
            console.warn('⚠️ [Start bg] background optimization failed:', bgErr?.message || bgErr);
          } finally {
            // Always resume after background work completes or fails
            resumeOfflineSync('delivery_actions');
            resumeOfflineMutations();
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
  }, [allDeliveries, appUsers, collapseDriverStopCards, currentUser, delivery, ensureDriverOnline, isCompleting, isCurrentCardStartLocked, isFailing, isGlobalStartLocked, isPickup, isProcessingBackground, isRestarting, isRetrying, isStarting, patient?.full_name, patients, resetActionLocks, setIsEntityUpdating, setIsProcessingBackground, setIsStarting, shouldPreserveWindowTimesOnStart, store, stores, updateDeliveriesLocally, userHasRole]);

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
    // 1. Atomic IDB write — offline-first, no smart-refresh trigger.
    //    This is ESSENTIAL WRITE #1: status + actual_delivery_time.
    await Promise.allSettled([updateDeliveryLocal(delivery.id, criticalUpdate, { skipSmartRefresh: true })]);

    // 2. Clear breadcrumbs (no-op stub — kept for future use, non-blocking)
    if (pendingBreadcrumbsString) {
      clearPendingBreadcrumbsForDelivery({
        driverUserId: delivery.driver_id, deliveryId: delivery.id,
        stopOrder: delivery.stop_order, appUsers, force: true,
      }).catch(() => {});
    }

    // 3. Collapse card (cosmetic — DOM + double-RAF, doesn't block critical path)
    if (!skipCollapseCard) collapseDriverStopCards().catch(() => {});

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

    // CRITICAL: Lock completion fields BEFORE setAndCenterNextDelivery fires.
    // Without this, the fire-and-forget refreshDriverRoute (step 6) and WebSocket
    // events from the backend update can read stale IDB data and revert the
    // optimistic isNextDelivery flag, causing the visible "bounce" back to the
    // old stop. This mirrors the lock pattern in handleStatusUpdate.jsx.
    lockDeliveryFields(delivery.id, ['status', 'isNextDelivery', 'stop_order', 'actual_delivery_time'], 90000, {
      status: 'completed', isNextDelivery: false,
    });
    if (nextStop?.id) lockDeliveryFields(nextStop.id, ['isNextDelivery', 'stop_order'], 90000, {
      isNextDelivery: true,
    });

    // CRITICAL: Suppress proximity snap for 30s after any terminal action.
    // The driver is physically close to the just-finished stop, and without
    // suppression, useDriverLocationSync's proximity snap (phase 1 only) can
    // re-snap to the completed stop before isNextDelivery propagates fully.
    // This mirrors the suppression in handleStatusUpdate.jsx.
    window.__suppressProximitySnapUntil = Date.now() + 30000;

    // CRITICAL: Register ALL affected delivery IDs in smartRefreshManager BEFORE
    // any server writes. setAndCenterNextDelivery with persistToBackend:true fires
    // user-scoped server writes that trigger WS broadcasts. If smartRefreshManager
    // hasn't registered these IDs yet, the WS echoes arrive as "remote" updates and
    // can overwrite the optimistic UI state, causing the completion bounce.
    try {
      const _affectedIds = [delivery.id];
      if (nextStop?.id) _affectedIds.push(nextStop.id);
      incompleteDeliveries.forEach((d) => { if (d?.id && d.id !== nextStop?.id) _affectedIds.push(d.id); });
      for (const _id of _affectedIds) {
        smartRefreshManager.registerPendingUpdate(_id, delivery.driver_id, delivery.delivery_date);
      }
    } catch (_) {}

    // CRITICAL: Extended WebSocket echo suppression for ALL affected delivery IDs.
    // Complete/Fail/Cancel triggers multiple sequential server writes:
    //   1. updateDeliveryLocal (status + actual_delivery_time)
    //   2. setAndCenterNextDelivery (isNextDelivery for next stop + travel_dist)
    //   3. ETA cascade (delivery_time_eta for each remaining stop)
    //   4. scheduleCompletionSideEffects → setNextDeliveryFlag (service-role WS echoes)
    //   5. recalculateAndUpdateStopOrders (stop_order resequencing)
    // broadcastMutation only sets 15s TTL per write, but echoes from later writes
    // (especially setNextDeliveryFlag's service-role writes) arrive 5-15s after the
    // initial write — past the 15s window. This causes the visible "bounce" where
    // the UI reverts to stale data until a manual/automatic refresh fixes it.
    // Using 90s extended suppression (same pattern as Accept All) covers the full
    // multi-write window.
    const _terminalEchoExpiry = Date.now() + 90 * 1000;
    if (!window.__localDeliveryWrites) window.__localDeliveryWrites = new Map();
    const _terminalAffectedIds = new Set([delivery.id]);
    if (nextStop?.id) _terminalAffectedIds.add(nextStop.id);
    incompleteDeliveries.forEach((d) => { if (d?.id) _terminalAffectedIds.add(d.id); });
    for (const _id of _terminalAffectedIds) {
      // Don't downgrade an existing extended suppression (e.g., from Accept All's 120s)
      const _existing = window.__localDeliveryWrites.get(_id);
      if (!_existing || _existing < Date.now() + 1000) {
        window.__localDeliveryWrites.set(_id, _terminalEchoExpiry);
      }
    }

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
    // IMPORTANT: The actual setDriverStatus(off_duty) call is deferred to AFTER
    // completionActualTime is resolved (below), so we can pass it as anchorTime.
    // This prevents the backend from re-querying deliveries and picking up a stale
    // or not-yet-written actual_delivery_time for the segment boundary.
    const driverAppUserForEOD = routeIsFinished ? (appUsers || []).find((au) => au?.user_id === delivery.driver_id) : null;
    const driverStatusForEOD = driverAppUserForEOD?.driver_status ?? currentUser?.driver_status;
    if (routeIsFinished) {
      fabControlEvents.notifyDoneButtonClicked();

      // If the current logged-in user IS the completing driver, switch to web-only
      // tracking so they still see their own live location marker. Full tracking
      // (breadcrumbs, native GPS, frequent uploads) stops, but the lightweight
      // heartbeat keeps the self-marker position fresh.
      if (currentUser?.id === delivery.driver_id) {
        try { 
          locationTracker.stopTracking();
          locationTracker.startWebOnlyTracking(currentUser).catch(() => {});
        } catch {}
        if (onDriverStatusChange) onDriverStatusChange('off_duty');
      }

      // Fire the EOD dialog event immediately — don't wait for off-duty server sync
      window.dispatchEvent(new CustomEvent('showRouteSummary', {
        detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date },
      }));
    }

    // 8. Broadcast status-changed event for card-rail and other listeners
    window.dispatchEvent(new CustomEvent('deliveryStatusChanged', {
      detail: { triggeredBy: status, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, maxStops: 5 },
    }));

    // 9. Tail side-effects (polyline regen) — debounced, fire-and-forget
    // CRITICAL: Pass affectedFullRecords so scheduleCompletionSideEffects can:
    //   (a) pre-seed IDB with the correct optimistic state
    //   (b) register all affected IDs in smartRefreshManager to suppress WS echoes
    //       from setNextDeliveryFlag's asServiceRole writes
    // Without this, setNextDeliveryFlag's WS broadcasts arrive as "remote" updates
    // and overwrite the optimistic UI state, causing the completion bounce.
    const affectedFullRecords = [
      { ...delivery, ...criticalUpdate, isNextDelivery: false },
      ...(nextStop ? [{ ...nextStop, isNextDelivery: true }] : []),
      ...(incompleteDeliveries.filter((d) => d.id !== nextStop?.id).map((d) => ({ ...d }))),
    ];
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
        affectedFullRecords,
      }).catch(() => {})
    );

    // 10. Re-sort stop orders — finished by actual_delivery_time, incomplete by ETA.
    //     Fire-and-forget: IDB already has actual_delivery_time from step 1.
    //     This is the ONLY place that re-sorts after a dashboard Complete/Fail/Cancel.
    if (delivery?.driver_id && delivery?.delivery_date) {
      recalculateAndUpdateStopOrders(delivery.driver_id, delivery.delivery_date).catch((err) => {
        console.warn('[executeTerminalAction] stop order recalc failed:', err?.message || err);
      });
    }

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
        // Use IDB instead of API call — the record is already in local storage
        const { offlineDB } = await import('../utils/offlineDatabase');
        const localDelivery = await offlineDB.getById(offlineDB.STORES.DELIVERIES, delivery.id).catch(() => null);
        if (!localDelivery) {
          toast.error('This delivery has been deleted. Please refresh the page.');
          return;
        }
        // Always call ensureDriverOnline — it has its own internal guard that checks
        // the LIVE appUsers array (not stale currentUser React state). The outer
        // guard used currentUser?.driver_status which can be stale, causing a
        // redundant setDriverStatus('on_duty') call that closes and reopens the
        // DriverDailyActivity segment even when the driver was never off duty.
        ensureDriverOnline().catch(() => {});

        const autoCODPayment = !isPickup && hasCODRequired && codPayments.length === 0 && onCODUpdate
          ? [{ type: 'Cash', amount: codTotalRequired }] : null;
        if (autoCODPayment) setCodPayments(autoCODPayment);

        // Breadcrumbs — get pending string for the completion payload (IDB read is fast)
        let pendingBreadcrumbsString = null;
        try {
          pendingBreadcrumbsString = await getPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers });
          // Fire-and-forget: boundary points are seed data for the next stop, not blocking
          if (pendingBreadcrumbsString) {
            appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: 'completed', completedAt: delivery.actual_delivery_time || delivery.arrival_time || new Date().toISOString() }).catch(() => {});
          }
        } catch {}

        // Pickup transition
        const hasPendingPickupTransitions = isPickup && pendingPickups && pendingPickups.some((p) => p.status === 'pending');
        if (isPickup && hasPendingPickupTransitions) {
          await executeAcceptAllStops();
          // CRITICAL: executeAcceptAllStops's finally block resumes ALL managers.
          // When called from the Complete handler, we must RE-PAUSE them so the
          // completion logic (executeTerminalAction, server writes) doesn't get
          // interrupted by WebSocket echoes or background sync cycles.
          pauseOfflineSync('delivery_actions');
          pauseRealtimeSync();
          backgroundSyncManager.pause();
          try { (await import('../utils/driverLocationPoller')).driverLocationPoller?.pause?.(); } catch (_) {}
          smartRefreshManager.pause();
          await waitForRouteTransitionSettle(pendingPickups?.length || 0);
        }

        // Timing
        const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);
        const useRetroactiveTiming = !shouldUseRegularTiming({ deliveryDate: delivery?.delivery_date, todayDateString: localDeviceTodayStr, currentTimeString: localNowParts.time });
        const sameRouteDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const completionCodPayments = autoCODPayment || codPayments;
        const patientSavedSignatureUrl = patient?.signature_image_url || patient?.saved_signature_image_url || null;
        const fallbackSignatureUrl = patientSavedSignatureUrl || null;

        // CRITICAL: Await retro timing BEFORE building criticalUpdate so a single
        // write goes to IDB + backend with the correct times. Fire-and-forget caused
        // a race where smartRefreshManager.restart() re-fetched stale backend data
        // (with localTimeString) before the retro backend write committed.
        let completionActualTime = localTimeString;
        let completionArrivalTime = !delivery.arrival_time ? localTimeString : null;
        let retroTravelDist = null;
        if (useRetroactiveTiming) {
          try {
            const retroactiveTiming = await calculateRetroactiveStopTiming({ delivery, allDeliveries, patients, stores, todayDateString: localDeviceTodayStr, allowSameDay: true });
            if (retroactiveTiming) {
              completionActualTime = retroactiveTiming.actual_delivery_time;
              if (retroactiveTiming.arrival_time) completionArrivalTime = retroactiveTiming.arrival_time;
              if (typeof retroactiveTiming.travel_dist === 'number') retroTravelDist = retroactiveTiming.travel_dist;
            }
          } catch (_) { /* fall back to localTimeString */ }
        }

        const fallbackTravelDist = retroTravelDist ?? resolveTravelDistFallback(delivery, null, sameRouteDeliveries);

        // DEFERRED from step 7: now that completionActualTime is resolved, fire setDriverStatus
        // with anchorTime so the segment end_time = this delivery's actual completion time
        // (rounded to next 5-min mark by the backend). Without anchorTime, the backend
        // re-queries deliveries — but the DB write hasn't committed yet, so it picks up
        // a stale time (often from an earlier segment) instead of the current completion time.
        if (routeIsFinished && driverStatusForEOD === 'on_duty') {
          setDriverStatus({
            newStatus: 'off_duty',
            selectedDate: delivery?.delivery_date,
            targetUserId: delivery?.driver_id,
            anchorTime: completionActualTime,
          }).catch((e) => console.warn('⚠️ Route-complete off_duty failed:', e?.message));
          // Optimistic local UI update
          if (driverAppUserForEOD?.id) {
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
              detail: { appUsers: [{ ...driverAppUserForEOD, driver_status: 'off_duty', location_tracking_enabled: false }], singleUpdate: true }
            }));
          }
        }

        const completionUpdate = {
          status: 'completed',
          actual_delivery_time: completionActualTime,
          finished_leg_transport_mode: normalizeTravelMode(delivery.transport_mode || currentPreferredTravelMode),
          isNextDelivery: false,
          finished_leg_encoded_polyline: null,
          PolylineUpdated: true,
          ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}),
          ...(completionCodPayments.length > 0 ? { cod_payments: completionCodPayments } : {}),
          ...(fallbackSignatureUrl ? { signature_image_url: fallbackSignatureUrl } : {}),
          ...(completionArrivalTime ? { arrival_time: completionArrivalTime } : {}),
          ...(typeof fallbackTravelDist === 'number' ? { travel_dist: fallbackTravelDist } : {}),
        };

        const shouldDeleteSquareCodBeforeComplete = !isPickup && Number(delivery?.cod_total_amount_required || 0) > 0 && hasDebitOrCreditCod(delivery, completionCodPayments);
        const shouldRecalculateCompletionEtas = delivery?.delivery_date === localDeviceTodayStr && shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, completionActualTime);

        // Fire-and-forget: only needed if the completion timestamp differs from the initial boundary call
        if (completionUpdate.actual_delivery_time && completionUpdate.actual_delivery_time !== (delivery.actual_delivery_time || delivery.arrival_time)) {
          appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: 'completed', completedAt: completionUpdate.actual_delivery_time }).catch(() => {});
        }
        if (shouldDeleteSquareCodBeforeComplete) deleteCODWithTimeout(delivery.id, 'Deleted after card COD completion').catch(() => {});

        // Fire-and-forget: patient side-effects are background work
        if (patient?.id) {
          import('../utils/offlineMutations').then(({ updatePatientLocal }) => {
            updatePatientLocal(patient.id, {
              ...(fallbackSignatureUrl ? { signature_image_url: fallbackSignatureUrl } : {}),
              ...(patient?.status === 'inactive' ? { status: 'active' } : {}),
            }).catch(() => {});
          }).catch(() => {});
          if (patient?.status === 'inactive') {
            base44.entities.Patient.update(patient.id, { status: 'active' }).catch(() => {});
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
        // CRITICAL: Dispatch completionFabRelock to re-engage the FAB in phase 2/3.
        // reactivateFAB alone can be blocked by the user interaction guard
        // (isUserControllingMap / isUserSwipingStopCards) since the driver just
        // tapped a button. It also doesn't clear mapUserUnlockedRef, so if the
        // driver had previously panned the map, the FAB wouldn't actually follow
        // the new next stop. completionFabRelock bypasses both issues — it always
        // re-locks and clears the free-pan flag. 300ms delay lets the optimistic
        // UI settle before the map repositions.
        const _phaseAfterComplete = window.__currentMapViewPhase || 1;
        if (_phaseAfterComplete === 2 || _phaseAfterComplete === 3) {
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('completionFabRelock', {
              detail: { phase: _phaseAfterComplete, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
            }));
          }, 300);
        }
        // Prompt cooler temp if:
        // 1. Direct fridge delivery (fridge_item flag), OR
        // 2. Pickup whose notes contain a "Fridge: N" summary (from Accept All)
        const pickupHasFridgeItems = isPickup && (() => {
          const notes = String(delivery?.delivery_notes || '');
          const match = notes.match(/Fridge:\s*(\d+)/i);
          return match && Number(match[1]) > 0;
        })();
        if ((delivery?.fridge_item || pickupHasFridgeItems) && !delivery?.arrival_time) triggerCoolerLogIfNeeded('Completed');

        // Fire-and-forget: patient last-delivery-date sync and driver notification are background
        if (!isPickup && patient?.id && Number(delivery?.cod_total_amount_required || 0) > 0) {
          base44.functions.invoke('syncPatientLastDeliveryDate', {
            data: { ...delivery, ...completionUpdate, patient_id: patient.id },
            old_data: { status: delivery.status },
            event: { type: 'update', entity_name: 'Delivery' },
          }).catch(() => null);
        }
        if (userHasRole(currentUser, 'driver')) {
          notifyDriverCompleted({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery, store, appUsers }).catch(() => {});
        }

        // Fire-and-forget: InterStore dropoff lookup is background work
        if (isPickup) {
          base44.functions.invoke('findInterStoreDropoff', { deliveryId: delivery.id })
            .then(interStoreResponse => {
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
            }).catch(() => {});
        }

        dispatchStopCardActionCollapse();
        onClick?.(null);
        // Fire-and-forget: breadcrumb consolidation is background work, not blocking
        queueConsolidateBreadcrumbs({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, deliveryId: delivery.id }).catch(() => {});

        // ── Cycling end marker completed: reset driver travel mode back to driving ──
        // When the driver taps Complete on the Cycling Route End marker we know the
        // cycling segment is fully finished. Reset preferred_travel_mode to 'driving'
        // so all subsequent stops default to driving mode.
        if (delivery?.is_cycling_marker && String(delivery?.delivery_notes || '').toLowerCase().includes('end')) {
          updatePreferredTravelMode(appUsers, delivery.driver_id, 'driving').catch((modeErr) => {
            console.warn('[CyclingEnd] Failed to reset travel mode to driving:', modeErr?.message || modeErr);
          });
        }

        toast.success(`${isPickup ? 'Pickup' : 'Delivery'} completed!`);
      } catch (error) {
        toast.error(`Failed to complete: ${error.message}`);
        throw error;
      } finally {
        // CRITICAL: Wrap each resume in individual try/catch — same pattern as
        // executeAcceptAllStops. Without this, if any single resume throws, the
        // remaining managers stay permanently paused and buttons stay disabled.
        try { resumeOfflineSync('delivery_actions'); } catch (e) { console.warn('[Complete] resumeOfflineSync failed:', e?.message); }
        try { driverLocationPoller?.resume?.(); } catch (e) { console.warn('[Complete] driverLocationPoller.resume failed:', e?.message); }
        try { smartRefreshManager.restart(); } catch (e) { console.warn('[Complete] smartRefreshManager.restart failed:', e?.message); }
        try { backgroundSyncManager.resume(); } catch (e) { console.warn('[Complete] backgroundSyncManager.resume failed:', e?.message); }
        try { resumeRealtimeSync(); } catch (e) { console.warn('[Complete] resumeRealtimeSync failed:', e?.message); }
        try { resetActionLocks(true); } catch (e) { console.warn('[Complete] resetActionLocks failed:', e?.message); }
        // ── F: Signal breadcrumb resume after completion ──────────────────────
        window.dispatchEvent(new CustomEvent('breadcrumbResumeAfterAction'));
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

        // Use IDB instead of API call — the record is already in local storage
        const { offlineDB } = await import('../utils/offlineDatabase');
        const localDeliveryExists = await offlineDB.getById(offlineDB.STORES.DELIVERIES, delivery.id).catch(() => null);
        if (!localDeliveryExists) {
          toast.error('This delivery has been deleted. Please refresh the page.');
          return;
        }
        // Breadcrumbs — get pending string for the completion payload (IDB read is fast)
        let pendingBreadcrumbsString = null;
        try {
          pendingBreadcrumbsString = await getPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers });
          // Fire-and-forget: boundary points are seed data for the next stop, not blocking
          if (pendingBreadcrumbsString) {
            appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: status, completedAt: delivery.actual_delivery_time || delivery.arrival_time || new Date().toISOString() }).catch(() => {});
          }
        } catch {}

        // Timing
        const existingNotes = delivery.delivery_notes || '';
        const updatedNotes = existingNotes ? `${existingNotes}\n[${status.toUpperCase()}] ${reason}` : `[${status.toUpperCase()}] ${reason}`;
        const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);
        const useRetroactiveTiming = !shouldUseRegularTiming({ deliveryDate: delivery?.delivery_date, todayDateString: localDeviceTodayStr, currentTimeString: localNowParts.time });
        const allRouteDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);

        // Await retro timing before building criticalUpdate — same race-condition fix as Complete.
        let failActualTime = localTimeString;
        let failArrivalTime = !delivery.arrival_time ? localTimeString : null;
        let failTravelDist = null;
        if (useRetroactiveTiming) {
          try {
            const retroactiveTiming = await calculateRetroactiveStopTiming({ delivery, allDeliveries, patients, stores, todayDateString: localDeviceTodayStr, allowSameDay: true });
            if (retroactiveTiming) {
              failActualTime = retroactiveTiming.actual_delivery_time;
              if (retroactiveTiming.arrival_time) failArrivalTime = retroactiveTiming.arrival_time;
              if (typeof retroactiveTiming.travel_dist === 'number') failTravelDist = retroactiveTiming.travel_dist;
            }
          } catch (_) { /* fall back to localTimeString */ }
        }

        const fallbackTravelDist = failTravelDist ?? resolveTravelDistFallback(delivery, null, allRouteDeliveries);

        const criticalUpdate = {
          status,
          delivery_notes: updatedNotes,
          actual_delivery_time: failActualTime,
          finished_leg_transport_mode: normalizeTravelMode(delivery.transport_mode || currentPreferredTravelMode),
          isNextDelivery: false,
          PolylineUpdated: true,
          ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}),
          ...(failArrivalTime ? { arrival_time: failArrivalTime } : {}),
          ...(typeof fallbackTravelDist === 'number' ? { travel_dist: fallbackTravelDist } : {}),
        };

        const shouldDeleteSquareCodBeforeFailure = Number(delivery?.cod_total_amount_required || 0) > 0;
        const shouldRecalculateFailureEtas = delivery?.delivery_date === localDeviceTodayStr && shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, localTimeString);

        // Fire-and-forget: only needed if the completion timestamp differs from the initial boundary call
        if (criticalUpdate.actual_delivery_time && criticalUpdate.actual_delivery_time !== (delivery.actual_delivery_time || delivery.arrival_time)) {
          appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: status, completedAt: criticalUpdate.actual_delivery_time }).catch(() => {});
        }
        if (shouldDeleteSquareCodBeforeFailure) deleteCODWithTimeout(delivery.id, `Deleted before marking as ${status}`).catch(() => {});

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
        fabControlEvents.reactivateFAB(true, { suppressIfPhase1: true, reason: 'stop_status_change' });
        // CRITICAL: Same completionFabRelock dispatch as the Complete handler.
        // Fail/Cancel also needs the FAB to re-engage in phase 2/3 after the
        // terminal action completes. Without this, the FAB stays deactivated
        // (from the deactivateFAB call at the start of the handler) and the
        // map doesn't follow the new next stop.
        const _phaseAfterFail = window.__currentMapViewPhase || 1;
        if (_phaseAfterFail === 2 || _phaseAfterFail === 3) {
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('completionFabRelock', {
              detail: { phase: _phaseAfterFail, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
            }));
          }, 300);
        }
        // Only prompt if no arrival_time reading was already taken for this fridge stop
        if (delivery?.fridge_item && !delivery?.arrival_time) triggerCoolerLogIfNeeded(status === 'failed' ? 'Failed' : 'Cancelled');
        dispatchStopCardActionCollapse();
        onClick?.(null);
        // Fire-and-forget: breadcrumb consolidation and notifications are background work
        queueConsolidateBreadcrumbs({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, deliveryId: delivery.id }).catch(() => {});
        if (userHasRole(currentUser, 'driver')) {
          notifyDriverFailed({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : displayName, delivery: { ...delivery, delivery_notes: updatedNotes }, store, appUsers, failureReason: reason }).catch(() => {});
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
        // ── F: Signal breadcrumb resume after fail/cancel ────────────────────
        window.dispatchEvent(new CustomEvent('breadcrumbResumeAfterAction'));
      }
    });
    if (lockResult?.skipped) return;
  }, [FINISHED_STATUSES, allDeliveries, appUsers, collapseDriverStopCards, currentUser, delivery,
    displayName, executeTerminalAction, forceRefreshDriverDeliveries, isPickup, localDeviceTodayStr,
    localNowParts.time, onClick, onDriverStatusChange, params, patient, pendingFailureStatus,
    resetActionLocks, safeDriver, setIsFailing, setPendingFailureStatus, setShowFailureReasonDialog,
    store, updateDeliveriesLocally, userHasRole]);

  // ── Accept a SINGLE pending delivery from the pickup card "+" button ──────────
  // Creates a new pickup with a fresh PUID, transitions the selected delivery to
  // in_transit, sets the new pickup as isNextDelivery=true, then runs the optimizer.
  const handleAcceptSingleStop = useCallback(async (projectedDelivery) => {
    if (!projectedDelivery?.id) {
      toast.error('Cannot accept this delivery — missing delivery ID.');
      return;
    }

    const lockResult = await runWithDeliveryActionLock('accept_single_delivery', async () => {
      pauseOfflineSync('delivery_actions');
      pauseOfflineMutations();
      pauseRealtimeSync();
      backgroundSyncManager.pause();
      setIsAcceptingAll(true);

      const { driverLocationPoller } = await import('../utils/driverLocationPoller');
      try {
        driverLocationPoller.pause();
        smartRefreshManager.pause();
        setIsEntityUpdating(true);

        const targetDeliveryId = projectedDelivery.id;
        const driverId = projectedDelivery.driver_id || delivery.driver_id;
        const deliveryDate = projectedDelivery.delivery_date || delivery.delivery_date;
        const storeId = projectedDelivery.store_id || delivery.store_id;
        const ampmDeliveries = projectedDelivery.ampm_deliveries || delivery.ampm_deliveries || 'AM';

        // Get all driver deliveries for this date from local state (client-side)
        const driverDeliveries = (allDeliveries || []).filter(
          (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate
        );

        const resolvedStore = store || stores?.find((s) => s?.id === storeId);
        const driverAppUser = appUsers.find((u) => u?.user_id === driverId || u?.id === driverId);
        const driverName = driverAppUser?.user_name || driverAppUser?.full_name || '';

        // ── Helper: generate a short unique PUID (3-char alphanumeric) ──
        function generateShortStopId() {
          const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
          let result = '';
          const existingPuids = new Set(driverDeliveries.map((d) => d.stop_id).filter(Boolean));
          for (let i = 0; i < 50; i++) {
            result = '';
            for (let j = 0; j < 3; j++) {
              result += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            if (!existingPuids.has(result)) return result;
          }
          return `P${Date.now().toString(36).slice(-4)}`;
        }

        // ── Helper: get next pickup TR# (multiples of 20) ──
        function getNextPickupTrackingNumber(pickups) {
          const used = [...new Set(
            pickups
              .map((p) => {
                const m = String(p?.tracking_number || '').match(/\d+/);
                const n = m ? parseInt(m[0], 10) : null;
                return (n !== null && n >= 0 && n % 20 === 0) ? n : null;
              })
              .filter((v) => v !== null)
          )].sort((a, b) => a - b);
          let expected = 0;
          for (const t of used) {
            if (t > expected) break;
            if (t === expected) expected += 20;
          }
          return String(expected).padStart(2, '0');
        }

        // ── Helper: get next stop_order ──
        const maxStopOrder = driverDeliveries.reduce((max, d) => {
          const s = Number(d?.stop_order);
          return Number.isFinite(s) && s > max ? s : max;
        }, 0);

        // ── Helper: local time string ──
        const now = new Date();
        const pad2 = (n) => String(n).padStart(2, '0');
        const nowLocal = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
        const nowPlus5 = new Date(now.getTime() + 5 * 60000);
        const nowPlus5Str = `${pad2(nowPlus5.getHours())}:${pad2(nowPlus5.getMinutes())}`;

        // ════════════════════════════════════════════════════════════════════
        // STEP 1: Create the new pickup (client-side)
        // ════════════════════════════════════════════════════════════════════
        const existingPickups = driverDeliveries.filter(
          (d) => d && !d.patient_id && !d._interstore_source_id && !d._interstore_dest_id
        );
        const newPuid = generateShortStopId();
        const newPickupTR = getNextPickupTrackingNumber(existingPickups);
        const newPickupStopOrder = maxStopOrder + 1;

        // Get store time windows for the pickup
        const dow = new Date(deliveryDate.replace(/-/g, '/')).getDay();
        const isWeekday = dow >= 1 && dow <= 5;
        const slotStartField = isWeekday
          ? (ampmDeliveries === 'PM' ? 'weekday_pm_start' : 'weekday_am_start')
          : dow === 6
            ? (ampmDeliveries === 'PM' ? 'saturday_pm_start' : 'saturday_am_start')
            : (ampmDeliveries === 'PM' ? 'sunday_pm_start' : 'sunday_am_start');
        const slotEndField = isWeekday
          ? (ampmDeliveries === 'PM' ? 'weekday_pm_end' : 'weekday_am_end')
          : dow === 6
            ? (ampmDeliveries === 'PM' ? 'saturday_pm_end' : 'saturday_am_end')
            : (ampmDeliveries === 'PM' ? 'sunday_pm_end' : 'sunday_am_end');

        const newPickup = {
          stop_id: newPuid,
          puid: newPuid,
          store_id: storeId,
          delivery_id: `DID-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
          delivery_date: deliveryDate,
          driver_id: driverId,
          driver_name: driverName,
          dispatcher_id: currentUser?.id || null,
          created_by_app_user_id: currentUser?.id || null,
          ampm_deliveries: ampmDeliveries,
          status: 'en_route',
          // Pickup gets NOW as its time window start
          delivery_time_start: nowLocal,
          delivery_time_end: resolvedStore?.[slotEndField] || '',
          delivery_time_eta: nowLocal,
          tracking_number: newPickupTR,
          stop_order: newPickupStopOrder,
          after_hours_pickup: true,
          isNextDelivery: true,
        };

        console.log(`[AcceptSingle] STEP 1 — New pickup created: id=pending, puid=${newPuid}, TR=${newPickupTR}, stop_order=${newPickupStopOrder}`);

        // Register pending updates so WebSocket echoes from our backend writes
        // don't trigger a full refresh that overwrites local state
        smartRefreshManager.registerPendingUpdate(targetDeliveryId, driverId, deliveryDate);

        // Write pickup to offline DB immediately
        try {
          const { offlineDB } = await import('../utils/offlineDatabase');
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [newPickup]);
        } catch (e) {
          console.warn('[AcceptSingle] offlineDB save for pickup failed:', e?.message || e);
        }

        // Create pickup on the backend (fire-and-forget — we already have local data)
        let createdPickup = null;
        try {
          createdPickup = await base44.entities.Delivery.create({
            stop_id: newPuid,
            puid: newPuid,
            store_id: storeId,
            delivery_id: newPickup.delivery_id,
            delivery_date: deliveryDate,
            driver_id: driverId,
            driver_name: driverName,
            dispatcher_id: currentUser?.id || null,
            created_by_app_user_id: currentUser?.id || null,
            ampm_deliveries: ampmDeliveries,
            status: 'en_route',
            delivery_time_start: nowLocal,
            delivery_time_end: newPickup.delivery_time_end,
            delivery_time_eta: nowLocal,
            tracking_number: newPickupTR,
            stop_order: newPickupStopOrder,
            after_hours_pickup: true,
            isNextDelivery: true,
          });
          // Update local pickup with the real ID from the server
          if (createdPickup?.id) {
            newPickup.id = createdPickup.id;
            try {
              const { offlineDB } = await import('../utils/offlineDatabase');
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [newPickup]);
            } catch (_) {}
          }
          console.log(`[AcceptSingle] Pickup created on server: id=${createdPickup?.id}`);
          if (createdPickup?.id) {
            smartRefreshManager.registerPendingUpdate(createdPickup.id, driverId, deliveryDate);
          }
        } catch (e) {
          console.warn('[AcceptSingle] Backend pickup create failed (proceeding with local):', e?.message || e);
        }

        // ════════════════════════════════════════════════════════════════════
        // STEP 2: Set isNextDelivery=true on new pickup, clear all others
        // ════════════════════════════════════════════════════════════════════
        const allDriverDeliveries = [...driverDeliveries];
        const updatedDeliveries = [];

        for (const d of allDriverDeliveries) {
          if (d?.isNextDelivery === true) {
            updatedDeliveries.push({ ...d, isNextDelivery: false });
          }
        }

        // Write isNextDelivery=false to all previous holders (local + backend)
        for (const d of updatedDeliveries) {
          updateDeliveryLocal(d.id, { isNextDelivery: false }, { skipSmartRefresh: true }).catch(() => {});
          base44.entities.Delivery.update(d.id, { isNextDelivery: false }).catch(() => {});
        }

        console.log(`[AcceptSingle] STEP 2 — isNextDelivery set on new pickup, cleared ${updatedDeliveries.length} others`);

        // ════════════════════════════════════════════════════════════════════
        // STEP 3: Reassign selected delivery to new PUID, resequence its TR#
        // ════════════════════════════════════════════════════════════════════
        const pickupBaseTR = parseInt(newPickupTR, 10);
        const newDeliveryTR = String(pickupBaseTR + 1).padStart(2, '0');

        const updatedDelivery = {
          ...projectedDelivery,
          puid: newPuid,
          tracking_number: newDeliveryTR,
          // STEP 3b: Delivery gets Now+5min as its time window start
          delivery_time_start: projectedDelivery.delivery_time_start || nowPlus5Str,
          delivery_time_eta: nowPlus5Str,
          // STEP 4: Status → in_transit
          status: 'in_transit',
          isNextDelivery: false,
        };

        console.log(`[AcceptSingle] STEP 3-4 — Delivery reassigned: puid=${newPuid}, TR=${newDeliveryTR}, status=in_transit, time_start=${nowPlus5Str}`);

        // Write to offline DB
        try {
          const { offlineDB } = await import('../utils/offlineDatabase');
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updatedDelivery]);
        } catch (e) {
          console.warn('[AcceptSingle] offlineDB save for delivery failed:', e?.message || e);
        }

        // Backend write — use BOTH updateDeliveryLocal (local sync) AND direct entity update (persist)
        // The direct entity update ensures the change persists even if updateDeliveryLocal's queue is delayed
        updateDeliveryLocal(targetDeliveryId, {
          status: 'in_transit',
          puid: newPuid,
          tracking_number: newDeliveryTR,
          delivery_time_start: updatedDelivery.delivery_time_start,
          delivery_time_eta: updatedDelivery.delivery_time_eta,
          isNextDelivery: false,
        }, { skipSmartRefresh: true }).catch((e) => {
          console.warn('[AcceptSingle] updateDeliveryLocal failed:', e?.message || e);
        });
        // Direct backend persist (fire-and-forget but more reliable path)
        base44.entities.Delivery.update(targetDeliveryId, {
          status: 'in_transit',
          puid: newPuid,
          tracking_number: newDeliveryTR,
          delivery_time_start: updatedDelivery.delivery_time_start,
          delivery_time_eta: updatedDelivery.delivery_time_eta,
          isNextDelivery: false,
        }).catch((e) => {
          console.warn('[AcceptSingle] Backend delivery update failed:', e?.message || e);
        });

        // Broadcast the isNextDelivery=false updates + new pickup + updated delivery to UI
        const allLocalUpdates = [...updatedDeliveries, newPickup, updatedDelivery];
        updateDeliveriesLocally?.(allLocalUpdates, false);

        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            triggeredBy: 'acceptSingle',
            driverId,
            deliveryDate,
            preserveLocalState: true,
            freshDeliveries: allLocalUpdates,
            alreadyOptimized: false
          }
        }));
        window.dispatchEvent(new CustomEvent('pendingToInTransit', { detail: { driverId, deliveryDate } }));
        invalidate('Delivery');

        // ════════════════════════════════════════════════════════════════════
        // STEP 5: Check message rules and send Accept notification
        // ════════════════════════════════════════════════════════════════════
        const isDriverAction = userHasRole(currentUser, 'driver') && driverId === currentUser.id;
        if (isDriverAction) {
          notifyDriverAccepted({
            driver: currentUser,
            store: resolvedStore,
            appUsers,
            pendingCount: 1,
            patientName: projectedDelivery.patient_name || '',
          }).catch((e) => console.warn('[AcceptSingle] notifyDriverAccepted failed:', e?.message || e));
        } else {
          // Dispatcher action — notify the driver
          const assignedDriver = appUsers.find((u) => u?.user_id === driverId || u?.id === driverId);
          if (assignedDriver) {
            notifyDispatcherAssignedAll({
              dispatcher: currentUser,
              driver: assignedDriver,
              store: resolvedStore,
              deliveries: [projectedDelivery],
              patients,
            }).catch((e) => console.warn('[AcceptSingle] notifyDispatcherAssignedAll failed:', e?.message || e));
          }
        }

        console.log(`[AcceptSingle] STEP 5 — Notifications sent`);

        // ════════════════════════════════════════════════════════════════════
        // STEP 6: Route optimization and polylines (client-side)
        // ════════════════════════════════════════════════════════════════════
        window.dispatchEvent(new CustomEvent('routeOptimizationStarted', {
          detail: { source: 'accept_single', driverId, deliveryDate }
        }));

        // Merge all updates into allDeliveries for the optimizer
        const _changedMap = new Map();
        for (const d of allLocalUpdates) {
          if (d?.id) _changedMap.set(d.id, d);
        }
        const _fullDeliveries = [
          ...(allDeliveries || []).map((d) => _changedMap.get(d?.id) || d),
          ...allLocalUpdates.filter((d) => d?.id && !(allDeliveries || []).find((a) => a?.id === d.id)),
        ];

        // Resolve driver location for optimizer
        const driverLat = Number(driverAppUser?.current_latitude);
        const driverLon = Number(driverAppUser?.current_longitude);
        const currentLocation = Number.isFinite(driverLat) && Number.isFinite(driverLon)
          ? { lat: driverLat, lon: driverLon }
          : null;

        try {
          const coordResult = await performRouteOptimization({
            driverId,
            deliveryDate,
            currentLocation,
            deliveries: _fullDeliveries,
            patients,
            stores,
            appUsers,
            source: 'accept_single',
            bypassDriverStatus: true,
          }).catch((err) => {
            console.error('[AcceptSingle] Optimization error:', err?.message || err);
            return null;
          });

          // CRITICAL: Use the optimizer's freshDeliveries (local data merged with writeBatch).
          // DO NOT call forceRefreshDriverDeliveries — that fetches from the DB where
          // the fire-and-forget writes haven't committed yet, causing stale data to
          // overwrite our local changes.
          let freshDeliveries = coordResult?.freshDeliveries || [];

          // If optimizer didn't return fresh data, use our local merged deliveries
          if (!Array.isArray(freshDeliveries) || freshDeliveries.length === 0) {
            freshDeliveries = _fullDeliveries;
            console.warn('[AcceptSingle] No freshDeliveries from optimizer, using local data');
          }

          // Patch isNextDelivery on the local data (optimizer doesn't touch this field)
          for (const d of freshDeliveries) {
            if (d?.id === newPickup.id || d?.stop_id === newPuid) {
              d.isNextDelivery = true;
            } else if (d?.isNextDelivery === true) {
              d.isNextDelivery = false;
            }
          }

          // Ensure the new pickup is present in freshDeliveries (in case the optimizer
          // didn't include it because it wasn't in the resolvedDeliveries)
          const hasNewPickup = freshDeliveries.some(
            (d) => d?.id === newPickup.id || d?.stop_id === newPuid
          );
          if (!hasNewPickup && newPickup.id) {
            freshDeliveries = [...freshDeliveries, newPickup];
          }

          // Ensure the updated delivery has the correct status/puid in freshDeliveries
          for (const d of freshDeliveries) {
            if (d?.id === targetDeliveryId) {
              d.status = 'in_transit';
              d.puid = newPuid;
              d.tracking_number = newDeliveryTR;
              d.delivery_time_start = updatedDelivery.delivery_time_start;
              d.delivery_time_eta = updatedDelivery.delivery_time_eta;
              d.isNextDelivery = false;
            }
          }

          // Write to offline DB and update UI — all from local data, no DB fetch
          const { offlineDB } = await import('../utils/offlineDatabase');
          await Promise.all(freshDeliveries.map((d) => offlineDB.save(offlineDB.STORES.DELIVERIES, d).catch(() => {})));
          updateDeliveriesLocally?.(freshDeliveries, false);

          // Re-assert isNextDelivery on the pickup in the DB (fire-and-forget)
          if (newPickup.id) {
            base44.entities.Delivery.update(newPickup.id, { isNextDelivery: true }).catch(() => {});
          }
          // Clear isNextDelivery on all other stops in the DB (fire-and-forget)
          for (const d of freshDeliveries) {
            if (d?.id !== newPickup.id && d?.isNextDelivery === false) {
              base44.entities.Delivery.update(d.id, { isNextDelivery: false }).catch(() => {});
            }
          }

          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: {
              triggeredBy: 'acceptSingleOptimized',
              driverId,
              deliveryDate,
              alreadyOptimized: true,
              preserveLocalState: true,
              freshDeliveries: freshDeliveries,
            }
          }));
          window.dispatchEvent(new CustomEvent('polylineUpdated', { detail: { driverId, deliveryDate, source: 'accept_single_button' } }));

          console.log(`[AcceptSingle] STEP 6 — Optimization complete: ${freshDeliveries.length} deliveries, optimizer=${coordResult?.success ? 'OK' : 'FALLBACK'}`);

          // TR# recalculation (LOCAL — no server round-trip, no stale data, no timeout)
          try {
            const _singleTRUpdates = recalculateTrackingNumbersLocal({ deliveries: freshDeliveries, stores, patients });
            if (_singleTRUpdates.length > 0) {
              console.log(`[AcceptSingle] Recalculated ${_singleTRUpdates.length} tracking numbers locally`);
              await applyTrackingNumberUpdates({ updates: _singleTRUpdates, allDeliveries: freshDeliveries, updateDeliveriesLocally, updateDeliveryLocal });
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                detail: { triggeredBy: 'acceptSingleTRRecalc', driverId, deliveryDate, alreadyOptimized: true, preserveLocalState: true, freshDeliveries }
              }));
            }
          } catch (e) { console.warn('[AcceptSingle] Local TR recalc failed:', e?.message || e); }

        } catch (optErr) {
          console.error('[AcceptSingle] Optimization failed:', optErr);
          // Non-fatal — the delivery is already in_transit locally
        }

        // COD sync if needed
        if (projectedDelivery.cod_total_amount_required && Number(projectedDelivery.cod_total_amount_required) > 0) {
          const storeAbbr = resolvedStore?.abbreviation || '';
          base44.functions.invoke('syncSquareCods', {
            items: [{
              deliveryId: targetDeliveryId,
              patientName: projectedDelivery.patient_name || '',
              storeAbbreviation: storeAbbr,
              codAmount: projectedDelivery.cod_total_amount_required,
              deliveryDate,
              storeId,
            }]
          }).catch((e) => console.warn('[AcceptSingle] Square COD sync failed:', e?.message || e));
        }

        toast.success(`Accepted delivery for ${projectedDelivery.patient_name || 'patient'}`);

      } catch (error) {
        console.error('[AcceptSingle] Error:', error);
        toast.error(`Failed to accept delivery: ${error.message}`);
        throw error;
      } finally {
        window.dispatchEvent(new CustomEvent('routeOptimizationComplete', {
          detail: { source: 'accept_single', driverId: projectedDelivery.driver_id || delivery.driver_id, deliveryDate: projectedDelivery.delivery_date || delivery.delivery_date }
        }));
        // Resume all managers — each wrapped in try/catch so one failure
        // doesn't prevent the others from resuming
        try { resumeRealtimeSync(); } catch (e) { console.warn('[AcceptSingle] resumeRealtimeSync failed:', e?.message); }
        try { resumeOfflineSync('delivery_actions'); } catch (e) { console.warn('[AcceptSingle] resumeOfflineSync failed:', e?.message); }
        try { resumeOfflineMutations(); } catch (e) { console.warn('[AcceptSingle] resumeOfflineMutations failed:', e?.message); }
        try { backgroundSyncManager.resume(); } catch (e) { console.warn('[AcceptSingle] backgroundSyncManager.resume failed:', e?.message); }
        try { driverLocationPoller.resume(); } catch (e) { console.warn('[AcceptSingle] driverLocationPoller.resume failed:', e?.message); }
        try { smartRefreshManager.restart(); } catch (e) { console.warn('[AcceptSingle] smartRefreshManager.restart failed:', e?.message); }
        setIsEntityUpdating(false);
        setIsAcceptingAll(false);
        dispatchStopCardActionCollapse();
        onClick?.(null);
      }
    });
    if (lockResult?.skipped) return;
  }, [allDeliveries, appUsers, currentUser, delivery, onClick, patients, setIsAcceptingAll, setIsEntityUpdating, store, stores, updateDeliveriesLocally, userHasRole]);

  return {
    blockCardToggle,
    pendingCoolerLog,
    clearCoolerLog,
    handleAddCODPayment,
    handleAcceptAllStops,
    handleAcceptSingleStop,
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