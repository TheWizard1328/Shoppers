import { useCallback, useState } from "react";
import { setDriverStatus } from "@/functions/setDriverStatus";
import { locationTracker } from "../utils/locationTracker";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import { fabControlEvents } from '../utils/fabControlEvents';
import { collapseExpandedStopCardsForDriver } from "./stopCardActionHelpers";
import { backgroundSyncManager } from '../utils/backgroundSyncManager';
import { isAppOwner } from '../utils/userRoles';
import { useStopCardDutyToggle } from './stopCardDutyToggle';
import { useStopCardCODActions } from './stopCardCODActions';
import { useStopCardReturnActions } from './stopCardReturnActions';
import { useStopCardStartActions } from './stopCardStartActions';
import { useStopCardCompletionActions } from './stopCardCompletionActions';

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
    existingReturn,
    setExistingReturn,
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

  const { ensureDriverOnline } = useStopCardDutyToggle({
    currentUser,
    appUsers,
    delivery,
    localDeviceTodayStr,
    onDriverStatusChange,
    updateDeliveriesLocally,
    userHasRole,
  });

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

  const { handleAddCODPayment } = useStopCardCODActions({
    codTotalRequired,
    codTotalCollected,
    setCodPayments,
  });

  const triggerCoolerLogIfNeeded = useCallback((actionLabel) => {
    if (!delivery?.fridge_item) return;
    if (!isAppOwner(currentUser)) return;
    setPendingCoolerLog({ deliveryId: delivery.id, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, actionLabel });
  }, [delivery, currentUser]);

  const clearCoolerLog = useCallback(() => setPendingCoolerLog(null), []);

  const {
    handleRetryDelivery,
    restartCurrentDelivery,
    handleStartAction,
    executeTerminalAction,
  } = useStopCardStartActions({
    allDeliveries,
    appUsers,
    currentUser,
    currentDriverAppUser,
    delivery,
    displayName,
    drivers,
    patient,
    patients,
    store,
    stores,
    isPickup,
    userHasRole,
    params,
    FINISHED_STATUSES,
    getCurrentLocalTime,
    localNowParts,
    shouldPreserveWindowTimesOnStart,
    updateDeliveriesLocally,
    forceRefreshDriverDeliveries,
    onDriverStatusChange,
    blockCardToggle,
    collapseDriverStopCards,
    ensureDriverOnline,
    resetActionLocks,
    triggerCoolerLogIfNeeded,
    startTapLockRef,
    isCompleting,
    isCurrentCardStartLocked,
    isFailing,
    isGlobalStartLocked,
    isProcessingBackground,
    isRestarting,
    isRetrying,
    isStarting,
    setIsEntityUpdating,
    setIsProcessingBackground,
    setIsRestarting,
    setIsRetrying,
    setIsStarting,
  });

  const {
    executeAcceptAllStops,
    handleAcceptAllStops,
    handleCompleteAction,
    handleFailureConfirm,
    handleAcceptSingleStop,
  } = useStopCardCompletionActions({
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
  });


  const {
    handleReturnClick,
    handleConfirmReturn,
    handleCancelReturn,
  } = useStopCardReturnActions({
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
  });

  // ── Accept a SINGLE pending delivery from the pickup card "+" button ──────────
  // Creates a new pickup with a fresh PUID, transitions the selected delivery to
  // in_transit, sets the new pickup as isNextDelivery=true, then runs the optimizer.


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