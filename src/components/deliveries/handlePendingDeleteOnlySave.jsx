import { resetBatchSaveDraftState, resumeManagersAndCloseBatchForm, runDeleteOnlyBatchRefresh } from './deliveryBatchSaveUiHelpers';

export async function handlePendingDeleteOnlySave({
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
  formData
}) {
  if (stagedDeliveries.length !== 0 || !hasPendingDeletes) return false;

  resetBatchSaveDraftState({
    setStagedDeliveries,
    setProjectedDeliveries,
    setHasPendingDeletes,
    setHasChanges,
    hasLoadedPendingRef: hasLoadedPending,
    unblockPredictions,
    setIsLoadingPredictions
  });

  await resumeManagersAndCloseBatchForm({ handleClearForm, onCancel });
  runDeleteOnlyBatchRefresh({ deliveryDate: formData.delivery_date, driverId: formData.driver_id, allDeletedWerePending });
  return true;
}