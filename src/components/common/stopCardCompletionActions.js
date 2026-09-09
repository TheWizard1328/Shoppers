/**
 * stopCardCompletionActions — extracted from useStopCardActions.jsx (Sep 6 2026).
 * Pure code movement, zero behavior change.
 *
 * Owns the terminal + acceptance flows:
 *   - executeAcceptAllStops / handleAcceptAllStops: Accept All batch pipeline
 *     (pauses all sync layers, TR# recalc via performRouteOptimization,
 *     notification-first ordering, dedup first deliveriesUpdated event)
 *   - handleCompleteAction: completion critical path (~37ms — IDB atomic
 *     write, no awaits on non-essential ops) + deferred retro-timing tail
 *   - handleFailureConfirm: fail-with-reason flow
 *   - handleAcceptSingleStop: single-stop accept (lighter TR# recalc path)
 */
import { useCallback } from "react";
import { clearPendingBreadcrumbsForDelivery, getPendingBreadcrumbsForDelivery } from './pendingBreadcrumbsStubs';
import { toast } from "sonner";
import { base44 } from "@/api/base44Client";
import { setDriverStatus } from "@/functions/setDriverStatus";
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { syncDeliverySquareCod, syncDeliveriesSquareCod } from '../utils/squareCodSync';
import { updateDeliveryLocal, pauseOfflineMutations, resumeOfflineMutations } from '../utils/offlineMutations';
import { fabControlEvents } from '../utils/fabControlEvents';
import { invalidate } from '../utils/dataManager';
import { generateCompletionTimestamp, calculateRetroactiveStopTiming, shouldUseRegularTiming } from '../utils/timeRoundingHelper';
import { waitForRouteTransitionSettle } from "./stopCardActionHelpers";
import { appendBoundaryBreadcrumbPoints } from '../utils/breadcrumbBoundaryPoints';
import { runAcceptAllBatchPipeline } from '../utils/acceptAllBatchPipeline';
import { runWithDeliveryActionLock } from '../utils/deliveryActionLock';
import { pauseOfflineSync, resumeOfflineSync } from '../utils/offlineSync';
import { pauseRealtimeSync, resumeRealtimeSync } from '../utils/realtimeSync';
import { backgroundSyncManager } from '../utils/backgroundSyncManager';
import { performRouteOptimization } from '../utils/routeOptimizationCoordinator';
import { recalculateTrackingNumbersLocal, applyTrackingNumberUpdates } from '../utils/recalculateTrackingNumbersLocal';
import { notifyDriverAccepted, notifyDriverCompleted, notifyDriverFailed } from "../utils/deliveryMessaging";
import { updatePreferredTravelMode, normalizeTravelMode } from '../dashboard/travelModeHelpers';
import { dispatchStopCardActionCollapse } from '../utils/stopCardCollapseManager';
import { lockDeliveryFields } from '../utils/completionLockout';
import { isDriverWithinStoreRange } from './afterHoursProximityCheck';
import { promptInterStoreDropoff } from './interStoreDropoffPrompt';
import {
  queueConsolidateBreadcrumbs,
  shouldRefreshRemainingEtas,
  hasDebitOrCreditCod,
  resolveTravelDistFallback,
} from './stopCardActionStatusHelpers';

export function useStopCardCompletionActions({
  // ── Route / context ──
  allDeliveries,
  pendingPickups,
  appUsers,
  currentUser,
  currentDriverAppUser,
  safeDriver,
  currentPreferredTravelMode,
  delivery,
  displayName,
  drivers,
  patient,
  patients,
  store,
  stores,
  isPickup,
  isExpanded,
  userHasRole,
  params,
  // ── COD state ──
  codPayments,
  setCodPayments,
  hasCODRequired,
  codTotalRequired,
  onCODUpdate,
  // ── Config / helpers ──
  FINISHED_STATUSES,
  localDeviceTodayStr,
  localNowParts,
  updateDeliveriesLocally,
  forceRefreshDriverDeliveries,
  onDriverStatusChange,
  onClick,
  // ── Shared hook handlers ──
  blockCardToggle,
  collapseDriverStopCards,
  ensureDriverOnline,
  executeTerminalAction,
  resetActionLocks,
  triggerCoolerLogIfNeeded,
  // ── Locks / flags ──
  completeTapLockRef,
  isCompleting,
  setIsCompleting,
  isFailing,
  setIsFailing,
  isGlobalCompleteLocked,
  isGlobalRestartLocked,
  isProcessingBackground,
  setIsProcessingBackground,
  setIsAcceptingAll,
  setIsEntityUpdating,
  // ── Failure dialog state ──
  pendingFailureStatus,
  setPendingFailureStatus,
  setShowFailureReasonDialog,
  setShowInterStoreDialog,
  setInterStoreMatch,
}) {
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
          // Credit the ASSIGNED driver in the notification — when an admin accepts
          // on behalf of a driver, the message must say the DRIVER accepted the
          // stops, not the admin who clicked the button.
          const assignedDriverUser = appUsers.find(u => u?.user_id === delivery.driver_id) || driverAppUser || currentUser;
          notifyDriverAccepted({
            driver: assignedDriverUser,
            store,
            appUsers,
            pendingCount: notifyDeliveries.length,
          }).catch(() => {});
        }
      } catch (_) {}

      // ── STEP 3b: Square COD reconcile (fire-and-forget, does not block optimizer) ──
      // One backend call: the reconciler reads the authoritative DB records (already
      // committed server-side above) and creates/updates all missing items in a SINGLE
      // Square batch-upsert — no per-item catalog scans, no client-supplied amounts.
      if (codBatch.length > 0) {
        syncDeliveriesSquareCod(codBatch.map((c) => c.deliveryId));
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

      return finalDeliveries;
    } catch (error) {
      console.error('❌ [Accept All] Error:', error);
      toast.error(`Failed to accept all: ${error.message}`);
      return null;
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

      // ── Auto-trigger priority pull-to-sync 1s after Accept All fully completes ──
      // All managers are resumed above and the final server sync is queued (2.5s).
      // 1s later, fire a priority-only refresh (deliveries + patients for the
      // selected date/city) so the Dashboard re-syncs without waiting for the next
      // smart-refresh cycle. priorityOnly skips the secondary AppUsers/Cities/Companies
      // sync so it stays scoped and fast.
      setTimeout(() => {
        try {
          window.dispatchEvent(new CustomEvent('triggerPullToSync', {
            detail: { silent: true, requestedAt: Date.now(), priorityOnly: true }
          }));
        } catch (e) { console.warn('[AcceptAll] auto pull-to-sync trigger failed:', e?.message); }
      }, 1000);
    }
  }, [allDeliveries, appUsers, currentUser, delivery, drivers, onClick, patients, setIsAcceptingAll, setIsEntityUpdating, store, stores, updateDeliveriesLocally, userHasRole]);

  const handleAcceptAllStops = useCallback(async () => {
    const lockResult = await runWithDeliveryActionLock('accept_all_delivery', async () => {
      await executeAcceptAllStops();
    });
    if (lockResult?.skipped) return;
  }, [executeAcceptAllStops]);

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
        // NOTE: Accept is route prep, NOT driving — no admin→driver toggle here.
        // Only the driver accepting their own stop toggles themselves (as before).
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
        let acceptAllFreshDeliveries = null;
        if (isPickup && hasPendingPickupTransitions) {
          // executeAcceptAllStops transitions pending → in_transit, runs the optimizer,
          // and returns the fully-optimized deliveries. We MUST pass these to
          // executeTerminalAction below — without them, executeTerminalAction uses the
          // stale allDeliveries closure (where the deliveries are still 'pending'),
          // filters them out of incompleteDeliveries, and either sets isNextDelivery on
          // the wrong stop or triggers a false routeIsFinished → EOD dialog.
          acceptAllFreshDeliveries = await executeAcceptAllStops();
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

          // If executeAcceptAllStops didn't return deliveries (error/timeout), fall back
          // to reading the latest state from IDB so executeTerminalAction has fresh data.
          if (!acceptAllFreshDeliveries || acceptAllFreshDeliveries.length === 0) {
            try {
              const { offlineDB } = await import('../utils/offlineDatabase');
              const allIdbDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
              acceptAllFreshDeliveries = allIdbDeliveries.filter(
                d => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
              );
            } catch (_) { /* fall through with null — executeTerminalAction uses allDeliveries */ }
          }
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
        // Always recalculate ETAs when using retro timing — the stored ETAs were based on
        // current time at the time they were set, which is wrong for past-day completions.
        const _remainingCount = sameRouteDeliveries.filter(d => !['completed','failed','cancelled'].includes(d.status) && d.id !== delivery.id).length;
        const shouldRecalculateCompletionEtas = useRetroactiveTiming
          ? _remainingCount > 0
          : (delivery?.delivery_date === localDeviceTodayStr && shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, completionActualTime));

        // Fire-and-forget: only needed if the completion timestamp differs from the initial boundary call
        if (completionUpdate.actual_delivery_time && completionUpdate.actual_delivery_time !== (delivery.actual_delivery_time || delivery.arrival_time)) {
          appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: 'completed', completedAt: completionUpdate.actual_delivery_time }).catch(() => {});
        }
        // Fire-and-forget: reconciler deletes the item for card/cheque collections.
        // Patch carries the just-written cod_payments so the reconciler sees the card
        // payment even before the DB write propagates. Cash is left untouched server-side.
        if (shouldDeleteSquareCodBeforeComplete) syncDeliverySquareCod(delivery.id, { status: 'completed', cod_payments: completionCodPayments });

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

        // ── ISP pre-prompt (BEFORE isNextDelivery is reassigned) ──────────────
        // When the completed pickup's delivery_id carries the ISP prefix, prompt
        // the driver BEFORE running the terminal action. Keeping the ISP pickup as
        // isNextDelivery=true through the optimizer run below lets the route engine
        // use it as the origin / pickup for the new interstore drop-off leg.
        let ispFreshDeliveriesOverride = acceptAllFreshDeliveries;
        const pickupDeliveryIsISP = isPickup && String(delivery?.delivery_id || '').toUpperCase().startsWith('ISP');
        if (pickupDeliveryIsISP) {
          const ispPromptOutcome = await promptInterStoreDropoff({
            delivery,
            setInterStoreMatch,
            setShowInterStoreDialog,
            base44,
          });
          if (ispPromptOutcome?.confirmed) {
            // The dialog's onConfirm has just created the new in_transit drop-off.
            // Run the optimizer now while the ISP pickup still has isNextDelivery=true
            // — it becomes the optimizer's route origin. freshDeliveries from the
            // optimizer include the drop-off, so the terminal action below sees it.
            try {
              const ispOpt = await performRouteOptimization({
                driverId: delivery.driver_id,
                deliveryDate: delivery.delivery_date,
                source: 'isp_dropoff_confirm',
                bypassDriverStatus: true,
              }).catch((optErr) => {
                console.warn('[ISP] optimizer failed:', optErr?.message || optErr);
                return null;
              });
              if (Array.isArray(ispOpt?.freshDeliveries) && ispOpt.freshDeliveries.length > 0) {
                ispFreshDeliveriesOverride = ispOpt.freshDeliveries;
              }
            } catch (optErr) {
              console.warn('[ISP] optimizer error:', optErr?.message || optErr);
            }
          }
        }

        // ── Terminal engine ──────────────────────────────────────────────────
        const actedOnNextDelivery = delivery?.isNextDelivery === true;
        const terminalResult = await executeTerminalAction({
          status: 'completed',
          criticalUpdate: completionUpdate,
          pendingBreadcrumbsString,
          actedOnNextDelivery,
          shouldRecalculateEtas: shouldRecalculateCompletionEtas,
          skipCollapseCard: false,
          etaBaseTime: useRetroactiveTiming ? completionActualTime : null,
          freshDeliveriesOverride: ispFreshDeliveriesOverride,
        });
        // ────────────────────────────────────────────────────────────────────

        // DEFERRED from executeTerminalAction step 7: now that completionActualTime is resolved,
        // fire setDriverStatus with anchorTime so the segment end_time = this delivery's actual
        // completion time. executeTerminalAction fires showRouteSummary/notifyDone immediately,
        // but setDriverStatus needs anchorTime which is only known here.
        const _routeIsFinished = terminalResult?.routeIsFinished ?? false;
        const _driverAppUserForEOD = _routeIsFinished ? (appUsers || []).find((au) => au?.user_id === delivery.driver_id) : null;
        const _driverStatusForEOD = _driverAppUserForEOD?.driver_status ?? currentUser?.driver_status;
        if (_routeIsFinished && _driverStatusForEOD === 'on_duty') {
          // CRITICAL: completionActualTime is a NAIVE local timestamp string
          // (e.g. "2026-08-06T13:40:00", no timezone suffix) built from local
          // Date components on this device. The backend setDriverStatus function
          // runs on a UTC server — new Date() there treats a naive/no-offset
          // string as UTC, not Edmonton local time, silently shifting the segment
          // end_time by the Edmonton UTC offset (6h MDT / 7h MST) into the past.
          // Convert to a real UTC instant HERE (on the client, where naive
          // date-time strings ARE correctly interpreted as this device's local
          // time) before sending — the backend then parses an unambiguous
          // 'Z'-suffixed ISO string.
          const anchorTimeUTC = new Date(completionActualTime).toISOString();
          setDriverStatus({
            newStatus: 'off_duty',
            selectedDate: delivery?.delivery_date,
            targetUserId: delivery?.driver_id,
            anchorTime: anchorTimeUTC,
          }).catch((e) => console.warn('⚠️ Route-complete off_duty failed:', e?.message));
          if (_driverAppUserForEOD?.id) {
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
              detail: { appUsers: [{ ..._driverAppUserForEOD, driver_status: 'off_duty', location_tracking_enabled: false }], singleUpdate: true }
            }));
          }
        }

        fabControlEvents.notifyPhaseTwoCompleteRecenter();
        fabControlEvents.reactivateFAB(true, { suppressIfPhase1: true, reason: 'stop_status_change' });
        if (_routeIsFinished) {
          // Route is finished — all stops are terminal. Switch the FAB to Phase 1
          // (overview) so the driver sees the full route overview instead of being
          // zoomed into a completed stop. Phase 1 is unlocked auto-follow mode.
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('routeFinishedResetToPhase1', {
              detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
            }));
          }, 300);
        } else {
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

        // ── After-Hours flag: when a DRIVER cancels a PICKUP while physically at ──
        // the store (within geofence range), mark the pickup as after_hours so the
        // store's "no deliveries" cancellation is reported on After Hours reports.
        // Dispatchers use a separate delete+notify flow and are intentionally skipped.
        const isDriverCancellingPickup = isPickup && status === 'cancelled' &&
          userHasRole(currentUser, 'driver') && currentUser?.id === delivery.driver_id;
        // Diagnostic: every cancel of a pickup logs the full gate breakdown so
        // missed After-Hours flags can be root-caused from device logs.
        console.warn('[AfterHoursGate]', isDriverCancellingPickup ? 'GATE PASS' : 'GATE FAIL', {
          deliveryId: delivery.id,
          isPickup,
          status,
          isDriverRole: userHasRole(currentUser, 'driver'),
          currentUserAppRoles: currentUser?.app_roles || null,
          currentUserId: currentUser?.id,
          pickupDriverId: delivery.driver_id,
          idMatch: currentUser?.id === delivery.driver_id,
        });
        // Only run (and log) the proximity check when the identity/role gate passed —
        // avoids noisy distance logs on regular delivery fails/cancels.
        const withinStoreRange = isDriverCancellingPickup
          ? isDriverWithinStoreRange({ currentUser, appUsers, store, stores, delivery })
          : false;
        if (isDriverCancellingPickup && withinStoreRange) {
          criticalUpdate.after_hours_pickup = true;
          console.warn('[AfterHoursGate] after_hours_pickup=true SET on cancel', { deliveryId: delivery.id });
        }

        const shouldDeleteSquareCodBeforeFailure = Number(delivery?.cod_total_amount_required || 0) > 0;
        const _failRemainingCount = allRouteDeliveries.filter(d => !['completed','failed','cancelled'].includes(d.status) && d.id !== delivery.id).length;
        const shouldRecalculateFailureEtas = useRetroactiveTiming
          ? _failRemainingCount > 0
          : (delivery?.delivery_date === localDeviceTodayStr && shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, failActualTime));

        // Fire-and-forget: only needed if the completion timestamp differs from the initial boundary call
        if (criticalUpdate.actual_delivery_time && criticalUpdate.actual_delivery_time !== (delivery.actual_delivery_time || delivery.arrival_time)) {
          appendBoundaryBreadcrumbPoints({ driverId: delivery.driver_id, delivery, allDeliveries, patients, stores, appUsers, terminalStatus: status, completedAt: criticalUpdate.actual_delivery_time }).catch(() => {});
        }
        if (shouldDeleteSquareCodBeforeFailure) syncDeliverySquareCod(delivery.id, { status });

        // ── Terminal engine ──────────────────────────────────────────────────
        const actedOnNextDelivery = delivery?.isNextDelivery === true;
        const _failTerminalResult = await executeTerminalAction({
          status,
          criticalUpdate,
          pendingBreadcrumbsString,
          actedOnNextDelivery,
          shouldRecalculateEtas: shouldRecalculateFailureEtas,
          skipCollapseCard: false,
          etaBaseTime: useRetroactiveTiming ? failActualTime : null,
        });
        // ────────────────────────────────────────────────────────────────────

        const _failRouteIsFinished = _failTerminalResult?.routeIsFinished ?? false;
        fabControlEvents.notifyPhaseTwoCompleteRecenter();
        fabControlEvents.reactivateFAB(true, { suppressIfPhase1: true, reason: 'stop_status_change' });
        if (_failRouteIsFinished) {
          // Route is finished — switch to Phase 1 (overview) so the driver sees
          // the full route instead of being zoomed into the last failed stop.
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('routeFinishedResetToPhase1', {
              detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
            }));
          }, 300);
        } else {
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
        // Accept Single is driver-only now — the dispatcher/admin "Assign on
        // behalf of driver" path has been removed (button hidden, code path retired).
        notifyDriverAccepted({
          driver: currentUser,
          store: resolvedStore,
          appUsers,
          pendingCount: 1,
          patientName: projectedDelivery.patient_name || '',
        }).catch((e) => console.warn('[AcceptSingle] notifyDriverAccepted failed:', e?.message || e));

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

        // COD reconcile if needed — patch carries the just-written local projection
        if (projectedDelivery.cod_total_amount_required && Number(projectedDelivery.cod_total_amount_required) > 0) {
          syncDeliverySquareCod(targetDeliveryId, {
            status: 'in_transit',
            cod_total_amount_required: projectedDelivery.cod_total_amount_required,
            patient_name: projectedDelivery.patient_name || '',
            delivery_date: projectedDelivery.delivery_date || delivery.delivery_date,
            store_id: storeId,
          });
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
    executeAcceptAllStops,
    handleAcceptAllStops,
    handleCompleteAction,
    handleFailureConfirm,
    handleAcceptSingleStop,
  };
}
