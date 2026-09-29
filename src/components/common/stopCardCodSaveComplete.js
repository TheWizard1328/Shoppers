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
import { generateCompletionTimestamp } from '../utils/timeRoundingHelper';
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

    const completionUpdate = {
      status: 'completed',
      actual_delivery_time: localTimeString,
      isNextDelivery: false,
      cod_payments: codPayments
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
