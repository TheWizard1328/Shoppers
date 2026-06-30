import { useCallback } from 'react';
import {
  deleteDelivery as deleteDeliveryLocal,
  updateDelivery as updateDeliveryLocal,
} from '../utils/entityMutations';

export function useConfirmDelete({
  deleteConfirmation,
  setDeleteConfirmation,
  sortedStagedDeliveries,
  stagedDeliveries,
  editingStagedId,
  handleClearForm,
  setStagedDeliveries,
  setProjectedDeliveries,
  fullPredictionListRef,
  allDeliveries,
  formData,
  setHasChanges,
  setHasPendingDeletes,
  setEditingStagedId,
  setError,
  setIsDeletingPending,
  setAllDeletedWerePending,
  patientSearchInputRef,
  shouldAutoFocusFields,
}) {
  return useCallback(async () => {
    const staged = deleteConfirmation.staged;
    if (!staged) return;
    setIsDeletingPending(true);

    // ── Pause all background sync operations ────────────────────────────────
    try {
      const { smartRefreshManager } = await import('../utils/smartRefreshManager');
      smartRefreshManager.pause();
    } catch (_) {}
    try {
      const { backgroundSyncManager } = await import('../utils/backgroundSyncManager');
      backgroundSyncManager.pause();
    } catch (_) {}

    try {
      // ── Case 1: Staged-only (no real ID) — just remove from local list ───
      if (!staged.id) {
        setStagedDeliveries((prev) => prev.filter((item) => item._tempId !== staged._tempId));
        const remainingStagedIds = new Set(
          stagedDeliveries
            .filter((item) => item._tempId !== staged._tempId)
            .map((d) => d.patient_id)
            .filter(Boolean)
        );
        setProjectedDeliveries(
          fullPredictionListRef.current.filter(
            (pred) =>
              !remainingStagedIds.has(pred.patient_id) &&
              !(allDeliveries || []).some(
                (d) => d && d.delivery_date === formData.delivery_date && d.patient_id === pred.patient_id
              )
          )
        );
        setHasChanges(true);
        if (editingStagedId === staged._tempId) {
          setEditingStagedId(null);
          handleClearForm();
        }
        setDeleteConfirmation({ show: false, staged: null, transferPickupId: null });
        if (shouldAutoFocusFields) setTimeout(() => patientSearchInputRef?.current?.focus(), 150);
        return;
      }

      // ── Case 2: Pickup transfer — reassign linked stops before deleting ──
      if (!staged.patient_id && deleteConfirmation.transferPickupId) {
        const linkedStops = sortedStagedDeliveries.filter((s) => s.id && s.patient_id && s.puid === staged.stop_id);
        if (linkedStops.length) {
          const targetPickup = sortedStagedDeliveries.find((s) => s.id === deleteConfirmation.transferPickupId);
          if (!targetPickup) throw new Error('Target pickup not found');
          const targetPickupTR = parseInt(targetPickup.tracking_number, 10) || 0;
          const existingTargetStops = sortedStagedDeliveries.filter((s) => s.id && s.patient_id && s.puid === targetPickup.stop_id).length;
          for (let i = 0; i < linkedStops.length; i += 1) {
            await updateDeliveryLocal(linkedStops[i].id, {
              puid: targetPickup.stop_id,
              tracking_number: String(targetPickupTR + existingTargetStops + i + 1),
              store_id: targetPickup.store_id,
              ampm_deliveries: targetPickup.ampm_deliveries,
            });
          }
        }
      }

      // SAFETY: staged.id must be a real string/id. If undefined, bail out to
      // prevent deleting unrelated pending deliveries from the staged list.
      if (!staged.id) {
        setStagedDeliveries((prev) => prev.filter((item) => item._tempId !== staged._tempId));
        setDeleteConfirmation({ show: false, staged: null, transferPickupId: null });
        if (shouldAutoFocusFields) setTimeout(() => patientSearchInputRef?.current?.focus(), 150);
        return;
      }

      // ── Delete: offline DB + online DB (entityMutations handles both) ────
      await deleteDeliveryLocal(staged.id);

      // ── Update local UI state ─────────────────────────────────────────────
      const nextStagedDeliveries = stagedDeliveries.filter(
        (item) => item.id !== staged.id && item._tempId !== staged._tempId
      );
      setStagedDeliveries(nextStagedDeliveries);

      const remainingStagedIds = new Set(nextStagedDeliveries.map((d) => d.patient_id).filter(Boolean));
      setProjectedDeliveries(
        fullPredictionListRef.current.filter(
          (pred) =>
            !remainingStagedIds.has(pred.patient_id) &&
            !(allDeliveries || []).some(
              (d) => d && d.delivery_date === formData.delivery_date && d.patient_id === pred.patient_id
            )
        )
      );

      setHasChanges(true);
      setHasPendingDeletes(true);
      if (typeof setAllDeletedWerePending === 'function') {
        setAllDeletedWerePending((prev) => prev && staged.status === 'pending');
      }
      if (editingStagedId === staged._tempId) {
        setEditingStagedId(null);
        handleClearForm();
      }
      setDeleteConfirmation({ show: false, staged: null, transferPickupId: null });
      if (shouldAutoFocusFields) setTimeout(() => patientSearchInputRef?.current?.focus(), 150);

    } catch (err) {
      setError(`Failed: ${err.message}`);
    } finally {
      setIsDeletingPending(false);
      // ── Resume all background sync operations ──────────────────────────
      try {
        const { smartRefreshManager } = await import('../utils/smartRefreshManager');
        smartRefreshManager.resume();
      } catch (_) {}
      try {
        const { backgroundSyncManager } = await import('../utils/backgroundSyncManager');
        backgroundSyncManager.resume();
      } catch (_) {}
    }
  }, [deleteConfirmation, sortedStagedDeliveries, stagedDeliveries, editingStagedId, handleClearForm]);
}