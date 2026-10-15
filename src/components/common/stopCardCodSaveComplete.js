// ── Shared "Save" / "Save & Complete" COD handler ───────────────────────────
// Owner directive (Sep 29 2026): when the driver opens COD collection (via the
// "Collect" link or the Square POS button), the footer's "Complete" button is
// hidden and replaced by this Save & Complete action in the SAME footer slot —
// previously this logic only lived inside the collapsible COD panel
// (StopCardCODCollection.jsx). Extracted here so both the in-panel button
// (still used for the "editing an already-completed delivery's COD" case,
// where no Complete button exists to swap with) and the new footer button
// (StopCardActionButtons.jsx) call the exact same code path — no duplicated
// business logic, no drift between the two render sites.
import { base44 } from "@/api/base44Client";
import { generateCompletionTimestamp, calculateRetroactiveStopTiming, shouldUseRegularTiming } from '../utils/timeRoundingHelper';
import { setDriverStatus } from '@/functions/setDriverStatus';
import { parseAnyTimestamp } from '../utils/albertaTime';
import { getCurrentLocalTimeString } from './stopCardActionHelpers';
import { updateDeliveryLocal } from '../utils/offlineMutations';
import { fabControlEvents } from '../utils/fabControlEvents';
import { runTerminalDeliverySideEffects } from '../utils/directDeliverySideEffects';
import { collapseExpandedStopCardsForDriver } from './stopCardActionHelpers';
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { syncDeliverySquareCod } from '../utils/squareCodSync';

/**
 * Runs the Save (already-completed delivery) or Save & Complete (active delivery)
 * COD flow. Mirrors the exact sequence previously inlined in
 * StopCardCODCollection.jsx's button onClick.
 */
export async function performSaveAndCompleteCOD({
  delivery,
  codPayments,
  allDeliveries,
  FINISHED_STATUSES,
  onCODUpdate,
  setShowCODCollection,
  setIsCompleting,
  onSelectionChange,
  onClick,
  codRefreshPauseRef, // optional — object with .current boolean, used to resume smartRefreshManager if it was paused for this panel
  // OWNER DIRECTIVE (Oct 14 2026): retro/off-duty finishing parity params.
  // All optional — the footer caller passes all four; the COD panel passes what
  // AppDataContext provides. Retro backdating degrades gracefully without
  // patients/stores (prev-stop-time base, no travel leg); the off-duty gate
  // falls back to currentUser.driver_status.
  patients, stores, appUsers, currentUser,
}) {
  if (!onCODUpdate) return;
  try {
    setIsCompleting(true);
    const isAlreadyCompleted = delivery.status === 'completed';

    const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
    if (deliveryExists && deliveryExists.length === 0) {
      throw new Error('This delivery no longer exists. Please refresh the page.');
    }

    const totalAmount = codPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

    if (isAlreadyCompleted) {
      // Collapse the expanded card as part of the Save action, matching the
      // same collapse-on-action pattern used by the regular Complete/Fail/Cancel
      // flows in useStopCardActions.jsx's executeTerminalAction.
      await collapseExpandedStopCardsForDriver(delivery?.driver_id);
      // Persist the edited COD payments FIRST, then reconcile Square from the
      // persisted state — the reconciler decides create/remove server-side
      // (cash stays, debit/credit/cheque removes). No client-side Square
      // decisions here.
      await onCODUpdate(delivery.id, codPayments, true);
      if (totalAmount > 0) syncDeliverySquareCod(delivery.id, { status: 'completed', cod_payments: codPayments });
      setShowCODCollection(false);
      return;
    }

    fabControlEvents.deactivateFAB();
    // Collapse the expanded card as part of the Save & Complete action —
    // same collapse-on-action pattern used by the regular Complete/Fail/Cancel
    // flows in useStopCardActions.jsx's executeTerminalAction.
    await collapseExpandedStopCardsForDriver(delivery?.driver_id);
    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    driverLocationPoller.pause();

    setShowCODCollection(false);

    const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);

    // OWNER DIRECTIVE (Oct 14 2026): retro timing + finishing parity with the
    // main Complete path (stopCardCompletionActions). Previously this COD path
    // ALWAYS stamped the real wall clock — a retro (after 21:00 / past-due)
    // Save & Complete recorded 23:xx instead of a backdated route-plausible
    // time, and skipped the auto off-duty entirely. Now: same live retro flag,
    // same calculateRetroactiveStopTiming backdating (which also applies the
    // 5-min first/last rounding to the actual completion time), and the same
    // route-finish off-duty rules below.
    const _liveNow = new Date();
    const _liveTodayStr = `${_liveNow.getFullYear()}-${String(_liveNow.getMonth() + 1).padStart(2, '0')}-${String(_liveNow.getDate()).padStart(2, '0')}`;
    const _liveTimeStr = getCurrentLocalTimeString(_liveNow);
    const useRetroactiveTiming = !shouldUseRegularTiming({ deliveryDate: delivery?.delivery_date, todayDateString: _liveTodayStr, currentTimeString: _liveTimeStr });
    let completionActualTime = localTimeString;
    let completionArrivalTime = !delivery.arrival_time ? localTimeString : null;
    let retroTravelDist = null;
    if (useRetroactiveTiming) {
      try {
        const retroactiveTiming = await calculateRetroactiveStopTiming({
          delivery, allDeliveries,
          patients: patients || [],
          stores: stores || [],
          todayDateString: _liveTodayStr,
          allowSameDay: true
        });
        if (retroactiveTiming) {
          completionActualTime = retroactiveTiming.actual_delivery_time;
          if (retroactiveTiming.arrival_time) completionArrivalTime = retroactiveTiming.arrival_time;
          if (typeof retroactiveTiming.travel_dist === 'number') retroTravelDist = retroactiveTiming.travel_dist;
        }
      } catch (_) { /* fall back to localTimeString */ }
    }

    const completionUpdate = {
      status: 'completed',
      actual_delivery_time: completionActualTime,
      isNextDelivery: false,
      cod_payments: codPayments,
      ...(completionArrivalTime ? { arrival_time: completionArrivalTime } : {}),
      ...(typeof retroTravelDist === 'number' ? { travel_dist: retroTravelDist } : {})
    };

    await updateDeliveryLocal(delivery.id, completionUpdate, { skipSmartRefresh: true });
    // Square reconcile happens inside runTerminalDeliverySideEffects —
    // the reconciler decides cash-stays / card-removes server-side.
    runTerminalDeliverySideEffects({
      delivery,
      previousStatus: delivery.status,
      nextStatus: 'completed',
      overrides: completionUpdate
    });

    const driverDeliveries = allDeliveries.filter((d) =>
      d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
    );
    const incompleteDeliveries = driverDeliveries.filter((d) =>
      d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending'
    ).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    if (incompleteDeliveries.length > 0) {
      await updateDeliveryLocal(incompleteDeliveries[0].id, { isNextDelivery: true }, { skipSmartRefresh: true });
      window._suppressAutoCenterUntil = Date.now() + 1500;
      setTimeout(() => {
        const nextCardElement = document.getElementById(`stop-card-${incompleteDeliveries[0].id}`);
        if (nextCardElement) nextCardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }, 100);
    } else {
      // OWNER DIRECTIVE (Oct 14 2026): same route-finish off-duty rules as the
      // main Complete path — mirrors stopCardCompletionActions exactly: fire
      // setDriverStatus('off_duty') with anchorTime = this delivery's actual
      // (retro-backdated, rounded) completion time converted to a real UTC
      // instant on the client, and broadcast the optimistic status flip so the
      // driver dot updates immediately.
      const _routeFinishedAppUser = (appUsers || []).find((au) => au?.user_id === delivery.driver_id) || null;
      const _routeFinishedStatus = _routeFinishedAppUser?.driver_status ?? currentUser?.driver_status;
      if (_routeFinishedStatus === 'on_duty' && completionActualTime) {
        try {
          const anchorTimeUTC = parseAnyTimestamp(completionActualTime).toISOString();
          setDriverStatus({
            newStatus: 'off_duty',
            selectedDate: delivery?.delivery_date,
            targetUserId: delivery?.driver_id,
            anchorTime: anchorTimeUTC,
          }).catch((e) => console.warn('⚠️ COD route-complete off_duty failed:', e?.message));
          if (_routeFinishedAppUser?.id) {
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
              detail: { appUsers: [{ ..._routeFinishedAppUser, driver_status: 'off_duty', location_tracking_enabled: false }], singleUpdate: true }
            }));
          }
        } catch (_) { /* non-fatal */ }
      }
      fabControlEvents.notifyDoneButtonClicked();
      window.dispatchEvent(new CustomEvent('showRouteSummary', {
        detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
      }));
    }

    if (onSelectionChange) {
      onSelectionChange(delivery.id, false);
    } else if (onClick) {
      onClick(null);
    }

    driverLocationPoller.resume();
    fabControlEvents.reactivateFAB(true);
  } catch (error) {
    console.error('❌ Failed to save COD:', error);
    fabControlEvents.reactivateFAB(true);
  } finally {
    if (codRefreshPauseRef?.current) {
      smartRefreshManager.resume();
      codRefreshPauseRef.current = false;
    }
    setIsCompleting(false);
  }
}
