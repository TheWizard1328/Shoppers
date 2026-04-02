import { resetBatchSaveDraftState, resumeManagersAndCloseBatchForm, runDeleteOnlyBatchRefresh } from './deliveryBatchSaveUiHelpers';

export async function handlePendingDeleteOnlySave({
  stagedDeliveries,
  hasPendingDeletes,
  setStagedDeliveries,
  setProjectedDeliveries,
  setHasPendingDeletes,
  setHasChanges,
  hasLoadedPending,
  unblockPredictions,
  setIsLoadingPredictions,
  handleClearForm,
  onCancel,
  formData,
  deletedDeliveryIds = []
}) {
  if (stagedDeliveries.length !== 0 || !hasPendingDeletes) return false;
  if (!deletedDeliveryIds.length) return false;

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
  runDeleteOnlyBatchRefresh({ deliveryDate: formData.delivery_date, driverId: formData.driver_id });
  return true;
}