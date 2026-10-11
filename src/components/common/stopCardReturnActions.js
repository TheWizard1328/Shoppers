/**
 * stopCardReturnActions — extracted from useStopCardActions.jsx (Sep 6 2026).
 * Pure code movement, zero behavior change. Return-stop lifecycle:
 * click (resolve return patient + existing-return merge target), confirm
 * (create/merge via onCreateReturn + COD cleanup + driver notification), cancel.
 */
import { useCallback } from "react";
import { base44 } from '@/api/base44Client';
import { syncDeliverySquareCod } from '../utils/squareCodSync';
import { updateDeliveryLocal } from '../utils/offlineMutations';
import { findExistingReturnDelivery, getEdmontonDate } from '@/components/utils/returnDeliveryBuilder';
import { notifyDriverReturn } from "../utils/deliveryMessaging";
import { dispatchStopCardActionCollapse } from '../utils/stopCardCollapseManager';

export function useStopCardReturnActions({
  allDeliveries,
  blockCardToggle,
  delivery,
  displayName,
  currentUser,
  appUsers,
  patients,
  store,
  stores,
  onClick,
  onCreateReturn,
  userHasRole,
  isPreparingReturn,
  setIsPreparingReturn,
  isCreatingReturn,
  setIsCreatingReturn,
  returnPatient,
  setReturnPatient,
  showReturnConfirm,
  setShowReturnConfirm,
  existingReturn,
  setExistingReturn,
}) {
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
      // If the driver's route already has an incomplete return stop for this store,
      // the dialog switches to "add to existing return" mode (merge instead of create).
      const foundExistingReturn = findExistingReturnDelivery({
        allDeliveries,
        originalDelivery: delivery,
        returnPatient: foundReturnPatient,
        routeDate: getEdmontonDate()
      });
      setExistingReturn(foundExistingReturn || null);
      setReturnPatient(foundReturnPatient);
      setShowReturnConfirm(true);
    } finally {
      setIsPreparingReturn(false);
    }
  }, [allDeliveries, blockCardToggle, delivery, isPreparingReturn, patients, setExistingReturn, setIsPreparingReturn, setReturnPatient, setShowReturnConfirm, showReturnConfirm, store, stores]);

  const handleConfirmReturn = useCallback(async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (!onCreateReturn || !returnPatient || isCreatingReturn) return;
    setIsCreatingReturn(true);
    const selectedReturnPatient = returnPatient;
    const resolvedStore = store || stores.find((s) => s && s.id === delivery?.store_id);
    let createdReturnResult = null;
    try {
      createdReturnResult = await onCreateReturn({ originalDelivery: delivery, returnPatient: selectedReturnPatient, store: resolvedStore, _skipPickupCreation: true });
      // handleCreateReturn returns { merged: boolean, delivery } — unwrap for the
      // background tasks below (COD cleanup + driver notification run in both paths).
      const createdReturnDelivery = createdReturnResult?.delivery || createdReturnResult;
      setShowReturnConfirm(false);
      setReturnPatient(null);
      setExistingReturn(null);
      dispatchStopCardActionCollapse();
      onClick?.(null);
      // Use the RETURN delivery's actual date (today), NOT the original delivery's date.
      // handleCreateReturn already ran performRouteOptimization with the correct date,
      // so we only need COD cleanup + notification here — no redundant optimization.
      const _returnDeliveryDate = createdReturnResult?.delivery?.delivery_date || createdReturnDelivery?.delivery_date || createdReturnDelivery?.data?.delivery_date;
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'return', driverId: delivery.driver_id, deliveryDate: _returnDeliveryDate } }));
      Promise.resolve().then(async () => {
        try {
          const backgroundTasks = [];
          // Fresh GPS fix on return too (owner directive Sep 24 2026).
          if (userHasRole(currentUser, 'driver') && currentUser.id === delivery.driver_id) {
            backgroundTasks.push(import('../utils/stopCompletionGpsFix').then(({ recordStopCompletionGpsFix }) => recordStopCompletionGpsFix({ currentUser, deliveryDate: _returnDeliveryDate || delivery.delivery_date })));
          }
          if ((delivery.cod_total_amount_required || 0) > 0) {
            // Catalog cleanup: returned → the Square register item is removed.
            backgroundTasks.push(Promise.resolve(syncDeliverySquareCod(delivery.id, { status: 'returned' })));
            // AUDIT STAMP (owner rule REVISED Oct 8 2026): cod_returned_at
            // does NOT release the amount — the failed COD KEEPS showing on
            // Square Balances and keeps its deduction until an actual Square
            // refund is detected or manually marked on the red Failed badge.
            const _returnedStamp = { cod_returned_at: new Date().toISOString() };
            backgroundTasks.push(updateDeliveryLocal(delivery.id, _returnedStamp, { skipSmartRefresh: true }).catch(() => null));
            backgroundTasks.push(base44.entities.Delivery.update(delivery.id, _returnedStamp).catch(() => null));
          }
          if (userHasRole(currentUser, 'driver')) backgroundTasks.push(notifyDriverReturn({ driver: currentUser, patientName: displayName, delivery: createdReturnDelivery || delivery, store, appUsers }));
          await Promise.allSettled(backgroundTasks);
        } catch {}
      });
    } finally {
      setIsCreatingReturn(false);
    }
  }, [appUsers, currentUser, delivery, displayName, isCreatingReturn, onClick, onCreateReturn, returnPatient, setExistingReturn, setIsCreatingReturn, setReturnPatient, setShowReturnConfirm, store, stores, userHasRole]);

  const handleCancelReturn = useCallback((e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setShowReturnConfirm(false);
    setReturnPatient(null);
    setExistingReturn(null);
  }, [setExistingReturn, setReturnPatient, setShowReturnConfirm]);

  return {
    handleReturnClick,
    handleConfirmReturn,
    handleCancelReturn,
  };
}
