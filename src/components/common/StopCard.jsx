import React, { useState, useRef, useMemo, useCallback, useEffect } from "react";
import { motion } from 'framer-motion';
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { GripVertical, Loader2, Phone, Navigation, LocateFixed } from "lucide-react";
import { getStoreColor, getContrastColor } from "../utils/colorGenerator";
import { format } from "date-fns";
import { userHasRole, shouldShowStoreBadges, isAppOwner } from '../utils/userRoles';
import { isMobileDevice } from '../utils/deviceUtils';
import { getCurrentDevice } from '../utils/deviceManager';
import { formatAddressWithUnit } from '../utils/addressCleaner';
import { base44 } from "@/api/base44Client";
import { setDriverStatus } from "@/functions/setDriverStatus";
import { locationTracker } from "../utils/locationTracker";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import { backgroundSyncManager } from "../utils/backgroundSyncManager";
import { deleteCODWithTimeout } from '../utils/squareCODHandler';
import { cleanupSquareCodCatalogForDate } from '../utils/squareCodCatalogCleanup';
import { createDeliveryLocal, updateDeliveryLocal } from '../utils/offlineMutations';
import { flushQueuedDeliveryUpdates } from '../utils/updateBatcher';
import { fabControlEvents } from '../utils/fabControlEvents';
import { invalidate } from '../utils/dataManager';
import { generateCompletionTimestamp, calculateRetroactiveStopTiming, parseLocalTimestamp, shouldUseRegularTiming } from '../utils/timeRoundingHelper';
import { generateUniqueSID } from '../dashboard/DashboardHelpers';
import { buildRetryDelivery, collapseExpandedStopCardsForDriver, getCurrentLocalTimeString, getDriverRouteDeliveries, getNextActiveDelivery, getNextTrackingNumberInGroup, incrementTrackingNumber, optimizeRouteAndApplyNextDelivery, refreshDriverRoute, reorderActiveRouteLocally, setAndCenterNextDelivery, syncDriverLocationToStop, waitForRouteTransitionSettle, withPausedDriverLocationPoller } from "./stopCardActionHelpers";
import { appendBoundaryBreadcrumbPoints } from '../utils/breadcrumbBoundaryPoints';
import { triggerSquareCodUpsert } from '../utils/directDeliverySideEffects';
import { runAcceptAllBatchPipeline } from '../utils/acceptAllBatchPipeline';
import { runWithDeliveryActionLock } from '../utils/deliveryActionLock';
import { pauseOfflineSync, resumeOfflineSync } from '../utils/offlineSync';
import { getOrFetchHereApiKey } from '../utils/hereApiKeyStore';
import { notifyDriverAcceptedAll, notifyDispatcherAssignedAll, notifyDriverStarted, notifyDriverCompleted, notifyDriverFailed, notifyDriverRetry, notifyDriverReturn } from "../utils/deliveryMessaging";
import StopCardHeader from "./StopCardHeader";
import StopCardBody from "./StopCardBody";
import FailureReasonDialog from "../deliveries/FailureReasonDialog";
import StopCardConfirmDialogs from './StopCardConfirmDialogs';
import StopCardReturnDialog from './StopCardReturnDialog';
import InterStoreDropoffDialog from './InterStoreDropoffDialog';
import StopCardPOD from './StopCardPOD';
import StopCardFooter from './StopCardFooter';
import { useDeliveryDisplayInfo } from './StopCardRedaction';
import { updatePatientGPS } from "../utils/patientGPSUpdater";
import useStopCardActions from "./useStopCardActions";
import { isRouteCompleted } from '@/components/utils/routeCompletionChecker';
import { toast } from "sonner";

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

export default function StopCard({
  delivery,
  store,
  driver,
  patients = [],
  currentUser,
  showDriverName = false,
  onStatusUpdate,
  onNotesUpdate,
  onEdit,
  onDelete,
  onRestart,
  allDeliveries = [],
  selectedDate,
  onEditPatient,
  drivers = [],
  onDriverChange,
  appUsers = [],
  onSelectionChange,
  onClick,
  isSelected,
  compact,
  isRailCentered = true,
  selectedDeliveryIds,
  bulkSelectionEnabled = false,
  showDragHandle = false,
  dragHandleProps,
  forceRefreshDriverDeliveries,
  onStartDelivery,
  onCODUpdate,
  onCreateReturn,
  stores = [],
  pendingPickups = [],
  scheduleCompletionSideEffects,
  canEdit = false,
  getDriverColor,
}) {
  if (!delivery) return null;

  const isNextDelivery = delivery?.isNextDelivery || false;
  const [notesInput, setNotesInput] = useState(delivery?.delivery_notes || "No driver notes");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [codPayments, setCodPayments] = useState(delivery?.cod_payments || []);
  const [showCODCollection, setShowCODCollection] = useState(false);
  const [showReturnConfirm, setShowReturnConfirm] = useState(false);
  const [isCreatingReturn, setIsCreatingReturn] = useState(false);
  const [returnPatient, setReturnPatient] = useState(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPreparingReturn, setIsPreparingReturn] = useState(false);
  const [isProcessingBackground, setIsProcessingBackground] = useState(false);
  const [isAcceptingAll, setIsAcceptingAll] = useState(false);
  const [showSignatureCapture, setShowSignatureCapture] = useState(false);
  const [showPhotoCapture, setShowPhotoCapture] = useState(false);
  const [viewingImageUrl, setViewingImageUrl] = useState(null);
  const [selectedTransferPickupId, setSelectedTransferPickupId] = useState('');
  const [isHovered, setIsHovered] = useState(false);
  const [showFailureReasonDialog, setShowFailureReasonDialog] = useState(false);
  const [pendingFailureStatus, setPendingFailureStatus] = useState(null);
  const [isFailing, setIsFailing] = useState(false);
  const [showInterStoreDialog, setShowInterStoreDialog] = useState(false);
  const [interStoreMatch, setInterStoreMatch] = useState(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(true);
  const startTapLockRef = useRef(false);
  const completeTapLockRef = useRef(false);
  const actionTapLockRef = useRef(false);

  const now = new Date();
  const localNowParts = useMemo(() => ({
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  }), []);

  const localDeviceTodayStr = localNowParts.date;
  const selectedRouteDateStr = selectedDate ? format(new Date(selectedDate), 'yyyy-MM-dd') : localNowParts.date;
  const selectedDateSourceStr = selectedDate ? typeof selectedDate === 'string' ? selectedDate.slice(0, 10) : format(new Date(selectedDate), 'yyyy-MM-dd') : null;
  const comparisonRouteDateStr = delivery?.delivery_date || selectedDateSourceStr || selectedRouteDateStr;
  const isPastDeliveryDate = !!comparisonRouteDateStr && comparisonRouteDateStr < localDeviceTodayStr;

  useEffect(() => {
    setNotesInput(delivery?.delivery_notes || "No driver notes");
  }, [delivery?.delivery_notes]);

  useEffect(() => {
    if (!showCODCollection) setCodPayments(delivery?.cod_payments || []);
  }, [delivery?.cod_payments, showCODCollection]);

  useEffect(() => {
    if (!currentUser?.id) return;
    let isMounted = true;
    getCurrentDevice(currentUser.id).then((device) => {
      if (!isMounted) return;
      setIsPrimaryDevice(device === null || device?.status !== 'inactive' && device?.is_primary_tracker !== false);
    }).catch(() => {
      if (isMounted) setIsPrimaryDevice(true);
    });
    return () => { isMounted = false; };
  }, [currentUser?.id]);

  const patient = useMemo(() => {
    if (!delivery?.patient_id || !patients || patients.length === 0) return null;
    return patients.find((p) => p && (p.id === delivery.patient_id || p.patient_id === delivery.patient_id));
  }, [delivery?.patient_id, patients]);

  const isPickup = useMemo(() => !delivery?.patient_id && !!delivery?.store_id, [delivery?.patient_id, delivery?.store_id]);

  const availableTransferPickups = useMemo(() => {
    if (!delivery || !isPickup) return [];
    return allDeliveries?.filter((d) => d && !d.patient_id && d.store_id === delivery.store_id && d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id && d.id !== delivery.id && d.status !== 'completed' && d.status !== 'cancelled') || [];
  }, [delivery, allDeliveries, isPickup]);

  useEffect(() => {
    if (showDeleteConfirm && isPickup && pendingPickups?.length > 0) {
      if (availableTransferPickups.length === 0) setSelectedTransferPickupId('delete_all');
      else if (availableTransferPickups.length >= 1) setSelectedTransferPickupId(availableTransferPickups[0].id);
    }
  }, [showDeleteConfirm, isPickup, pendingPickups, availableTransferPickups]);

  const safeDriver = useMemo(() => {
    const assignedDriver = (drivers || []).find((item) => item?.id === delivery?.driver_id || item?.user_id === delivery?.driver_id);
    if (assignedDriver && typeof assignedDriver === 'object') return assignedDriver;
    return driver && typeof driver === 'object' ? driver : null;
  }, [drivers, delivery?.driver_id, driver]);

  const driverBadgeColor = useMemo(() => getDriverColor && safeDriver ? getDriverColor(safeDriver) : '#64748b', [getDriverColor, safeDriver]);
  const driverBadgeTextColor = useMemo(() => getContrastColor(driverBadgeColor), [driverBadgeColor]);
  const codTotalCollected = useMemo(() => codPayments.reduce((sum, payment) => sum + (parseFloat(payment.amount) || 0), 0), [codPayments]);
  const codTotalRequired = useMemo(() => delivery?.cod_total_amount_required || 0, [delivery?.cod_total_amount_required]);
  const hasCODRequired = useMemo(() => codTotalRequired > 0, [codTotalRequired]);
  const isCODComplete = useMemo(() => codTotalCollected >= codTotalRequired, [codTotalCollected, codTotalRequired]);
  const isCompleted = useMemo(() => delivery ? FINISHED_STATUSES.includes(delivery.status) : false, [delivery?.status]);
  const storeColor = useMemo(() => store ? getStoreColor(store) : "#71717A", [store]);
  const routeCompleted = useMemo(() => isRouteCompleted(delivery, allDeliveries), [delivery, allDeliveries]);

  const routeCompletedForLayout = useMemo(() => {
    if (!delivery || !Array.isArray(allDeliveries)) return false;
    if (!FINISHED_STATUSES.includes(delivery.status)) return false;
    const driverDeliveriesForDate = allDeliveries.filter((d) => d && d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id);
    if (driverDeliveriesForDate.length === 0) return false;
    return driverDeliveriesForDate.every((d) => FINISHED_STATUSES.includes(d.status));
  }, [delivery, allDeliveries]);

  const currentDriverAppUser = useMemo(() => {
    if (!currentUser?.id || !Array.isArray(appUsers)) return null;
    return appUsers.find((appUser) => appUser?.user_id === currentUser.id) || null;
  }, [appUsers, currentUser?.id]);

  const { displayName, displayAddress, finalDisplayName, finalDisplayAddress, finalDisplayPhone, shouldRedact } = useDeliveryDisplayInfo({
    delivery,
    patient,
    store,
    currentUser,
    isPickup,
    isInterStore: false,
    isInterStorePickup: false,
    isStrippedDelivery: false,
    isStrippedForDispatcher: false
  });

  const shouldUseRegularStopTiming = useMemo(() => shouldUseRegularTiming({ deliveryDate: comparisonRouteDateStr, todayDateString: localDeviceTodayStr, currentTimeString: localNowParts.time }), [comparisonRouteDateStr, localDeviceTodayStr, localNowParts.time]);

  const isStrippedForDispatcher = useMemo(() => {
    if (!currentUser || !delivery) return false;
    if (!userHasRole(currentUser, 'dispatcher')) return false;
    if (userHasRole(currentUser, 'admin')) return false;
    const dispatcherStoreIds = currentUser.store_ids || [];
    return !dispatcherStoreIds.includes(delivery.store_id);
  }, [delivery?.store_id, currentUser]);

  const isStrippedForDriver = useMemo(() => {
    if (!currentUser || !delivery) return false;
    if (userHasRole(currentUser, 'admin')) return false;
    if (userHasRole(currentUser, 'driver')) return delivery._isStripped === true;
    return false;
  }, [delivery?._isStripped, currentUser]);

  const isStrippedDelivery = isStrippedForDriver || isStrippedForDispatcher;
  const isExpanded = isStrippedForDispatcher ? false : compact ? false : isSelected;
  const shouldShowNavigationButton = isNextDelivery && !!delivery?.latitude && !!delivery?.longitude;

  const isAssignedDriverOrAppOwner = useMemo(() => {
    if (!currentUser || !delivery) return false;
    if (isAppOwner(currentUser)) return true;
    if (!userHasRole(currentUser, 'driver')) return false;
    return delivery.driver_id === currentUser.id;
  }, [currentUser, delivery]);

  const isAssignedDispatcher = useMemo(() => {
    if (!currentUser || !delivery) return false;
    if (!userHasRole(currentUser, 'dispatcher')) return false;
    const dispatcherStoreIds = currentUser.store_ids || [];
    return dispatcherStoreIds.includes(delivery.store_id);
  }, [currentUser, delivery]);

  const canAccessAcceptButtons = useMemo(() => {
    if (!currentUser || !delivery) return false;
    if (isAppOwner(currentUser) || userHasRole(currentUser, 'admin')) return true;
    if (isAssignedDispatcher) return true;
    if (userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id) return true;
    return false;
  }, [currentUser, delivery, isAssignedDispatcher]);

  const acceptButtonText = useMemo(() => {
    if (!currentUser || !delivery) return 'Assign All';
    const isAssignedDriver = delivery.driver_id === currentUser.id && userHasRole(currentUser, 'driver');
    return isAssignedDriver ? 'Accept All' : 'Assign All';
  }, [currentUser, delivery?.driver_id]);

  const handleUpdateGPS = async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (!patient?.id) return;
    await updatePatientGPS({
      patientId: patient.id,
      storeId: delivery.store_id,
      stores,
      mapCrosshairCoords: window.__mapCrosshairCoords || null,
      preferCrosshair: delivery?.status === 'completed' || !isMobileDevice() && !isPrimaryDevice,
      currentPatientCoords: { latitude: patient?.latitude, longitude: patient?.longitude }
    });
  };

  const {
    blockCardToggle,
    handleAddCODPayment,
    handleAcceptAllStops,
    handleReturnClick,
    handleConfirmReturn,
    handleCancelReturn,
    handleRetryDelivery,
    restartCurrentDelivery,
    handleStartAction,
    handleCompleteAction,
    handleFailureConfirm
  } = useStopCardActions({
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
    shouldPreserveWindowTimesOnStart: !shouldUseRegularStopTiming,
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
    onDriverStatusChange: null,
    userHasRole,
    forceRefreshDriverDeliveries,
    updateDeliveriesLocally: null,
    setIsEntityUpdating: null,
    isCurrentCardStartLocked: false,
    isGlobalStartLocked: false,
    isGlobalCompleteLocked: false,
    isGlobalRestartLocked: false,
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
    getCurrentLocalTime: () => localNowParts.time,
    currentUserCanTrack: true,
    setViewingImageUrl,
    setShowSignatureCapture,
    setShowPhotoCapture,
    showSignatureCapture,
    showPhotoCapture,
    scheduleCompletionSideEffects,
  });

  const { hasFutureRetry, hasFutureReturn, hasCompletedDelivery } = useMemo(() => {
    if (delivery.status !== 'failed' || isPickup || !patient) return { hasFutureRetry: false, hasFutureReturn: false, hasCompletedDelivery: false };
    const failedDate = String(delivery.delivery_date || '');
    const failedDateValue = Number(failedDate.replace(/-/g, ''));
    const toDateValue = failedDateValue + 7;
    const returnPatientName = `${String(store?.name || '').replace(/-/g, ' ')} Return`;
    const returnPatientRecord = patients.find((p) => p && p.full_name === returnPatientName && p.store_id === delivery.store_id);
    let futureRetryExists = false, futureReturnExists = false, completedDeliveryExists = false;
    for (const d of allDeliveries) {
      if (!d || d.id === delivery.id || !d.delivery_date) continue;
      const dDateValue = Number(String(d.delivery_date).replace(/-/g, ''));
      if (dDateValue >= failedDateValue && dDateValue < toDateValue) {
        if (d.patient_id === delivery.patient_id && d.stop_id === delivery.stop_id && d.status !== 'failed') futureRetryExists = true;
        if (returnPatientRecord && d.store_id === delivery.store_id && d.patient_id === returnPatientRecord.id && !FINISHED_STATUSES.includes(d.status)) futureReturnExists = true;
        if (d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id && d.patient_id === delivery.patient_id && d.status === 'completed') completedDeliveryExists = true;
      }
      if (futureRetryExists && futureReturnExists && completedDeliveryExists) break;
    }
    return { hasFutureRetry: futureRetryExists, hasFutureReturn: futureReturnExists, hasCompletedDelivery: completedDeliveryExists };
  }, [delivery, allDeliveries, patient, isPickup, patients, store]);

  const canRetry = useMemo(() => {
    if (!delivery || delivery.status !== 'failed' || isPickup || !patient) return true;
    if (hasFutureReturn || hasFutureRetry || hasCompletedDelivery) return false;
    return true;
  }, [delivery, patient, isPickup, hasFutureReturn, hasFutureRetry, hasCompletedDelivery]);

  const routeHasIncompleteStops = useMemo(() => {
    if (!delivery) return false;
    return (allDeliveries || []).some((item) => item && item.driver_id === delivery.driver_id && item.delivery_date === delivery.delivery_date && !FINISHED_STATUSES.includes(item.status) && item.status !== 'pending');
  }, [allDeliveries, delivery]);

  const isFinishedDelivery = FINISHED_STATUSES.includes(delivery?.status);
  const shouldFade = isFinishedDelivery && routeHasIncompleteStops && !isSelected && !isHovered;
  const isMobileCard = isMobileDevice();
  const isBulkSelected = !!selectedDeliveryIds?.[delivery?.id];
  const cardZIndex = isMobileCard
    ? isExpanded ? 320 : isHovered && !isRailCentered ? 260 : isRailCentered ? 250 : isBulkSelected ? 230 : 220
    : isExpanded ? 70 : isHovered && !isRailCentered ? 52 : isRailCentered ? 51 : 50;

  const showCompletedRouteCenteredCondensed = userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') && isFinishedDelivery && routeCompletedForLayout && !isExpanded;
  const showIncompleteRouteSideCondensed = !routeCompletedForLayout && !isExpanded && !isRailCentered;
  const showCenteredIncompleteCollapsed = !routeCompletedForLayout && !isExpanded && isRailCentered;
  const isDispatcherCenteredCard = userHasRole(currentUser, 'dispatcher') && isRailCentered;
  const hideBodyForDispatcherCenteredCard = isDispatcherCenteredCard && !isStrippedForDispatcher && !isExpanded;
  const forceCompactCollapsed = compact && !isExpanded;
  const showMiddleSection = !forceCompactCollapsed && !isStrippedForDriver && !isStrippedForDispatcher && !showIncompleteRouteSideCondensed && (!isFinishedDelivery || isExpanded || isRailCentered) && !showCompletedRouteCenteredCondensed;
  const showBodySection = !forceCompactCollapsed && !showCompletedRouteCenteredCondensed && !showIncompleteRouteSideCondensed && !hideBodyForDispatcherCenteredCard;

  const rawStopLatitude = isPickup ? store?.latitude : patient?.latitude;
  const rawStopLongitude = isPickup ? store?.longitude : patient?.longitude;
  const navigationHref = (rawStopLatitude && rawStopLongitude)
    ? `https://www.google.com/maps/search/?api=1&query=${rawStopLatitude},${rawStopLongitude}`
    : null;
  const isWithinActiveStopRange = false; // computed externally if needed

  return (
    <motion.div
      id={`stop-card-${delivery.id}`}
      data-is-condensed={shouldFade && !isExpanded && !isHovered}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className={`w-full cursor-pointer transition-all ${showCenteredIncompleteCollapsed ? 'self-start' : ''} ${isSelected && !isStrippedDelivery ? 'ring-2 ring-blue-500' : ''}`}
      style={{ scrollSnapAlign: 'center', position: 'relative', zIndex: cardZIndex, isolation: isExpanded ? 'isolate' : 'auto' }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {bulkSelectionEnabled && (
        <div
          className="absolute inset-0 z-[400] cursor-pointer rounded-xl"
          style={{ WebkitTapHighlightColor: 'transparent' }}
          onClick={(e) => { e.stopPropagation(); onSelectionChange?.(delivery.id, !isBulkSelected); }}
        />
      )}

      <Card
        data-route-completed-condensed={showCompletedRouteCenteredCondensed ? "true" : "false"}
        className="bg-card text-card-foreground rounded-xl border shadow-md cursor-pointer hover:shadow-lg transition-all duration-200 overflow-hidden"
        onClick={(e) => {
          const actionButton = e.target?.closest?.('[data-stopcard-action="start"], [data-stopcard-action="complete"], [data-stopcard-action="restart"], [data-stopcard-action="retry"], [data-stopcard-action="return"]');
          const checkboxArea = e.target?.closest?.('[data-stopcard-checkbox="true"]');
          if (checkboxArea || actionButton) { e.stopPropagation(); return; }
          if (startTapLockRef.current || completeTapLockRef.current || actionTapLockRef.current || isStarting || isCompleting || isRestarting || isProcessingBackground || isFailing) return;
          onClick && onClick(delivery);
        }}
        style={{ background: 'var(--bg-white)', borderColor: isNextDelivery ? '#10B981' : '#3B82F6', opacity: shouldFade ? 0.4 : 1, transition: 'opacity 0.2s ease-in-out' }}
      >
        <CardContent className="p-6 px-1 flex flex-col py-0">
          <div className="flex items-start">
            {showDragHandle && dragHandleProps && !FINISHED_STATUSES.includes(delivery.status) && (
              <div {...dragHandleProps} className="flex items-center justify-center cursor-grab active:cursor-grabbing pt-1 mr-1">
                <GripVertical className="w-5 h-5 text-slate-400 hover:text-slate-600" />
              </div>
            )}
            <StopCardHeader
              delivery={delivery}
              store={store}
              patient={patient}
              isPickup={isPickup}
              pendingPickups={pendingPickups}
              storeColor={storeColor}
              finalDisplayName={finalDisplayName}
              FINISHED_STATUSES={FINISHED_STATUSES}
              showDriverName={showDriverName}
              safeDriver={safeDriver}
              driverBadgeColor={driverBadgeColor}
              driverBadgeTextColor={driverBadgeTextColor}
              currentUser={currentUser}
              appUsers={appUsers}
              isReturnDelivery={false}
              bulkSelectionEnabled={bulkSelectionEnabled}
              onSelectionChange={onSelectionChange}
              isSelected={isSelected}
              selectedDeliveryIds={selectedDeliveryIds}
            />
          </div>

          {showMiddleSection && <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}></div>}

          {showMiddleSection && (
            <div className="flex flex-col">
              <div className="flex items-start justify-between">
                <div className="flex flex-col justify-center gap-0.5 flex-1 min-w-0 min-h-[55px]">
                  {finalDisplayAddress ? (
                    <>
                      <div className="flex items-start gap-2 text-lg" style={{ color: 'var(--text-slate-700)' }}>
                        <span className="text-xl font-medium truncate">{isPickup ? store?.address || '' : patient?.address || ''}</span>
                      </div>
                      {!isStrippedDelivery && (
                        <div className="flex items-center gap-3 min-h-[26px]" style={{ color: 'var(--text-slate-600)' }}>
                          {(() => {
                            const unitNum = !isPickup ? delivery?.unit_number || patient?.unit_number : null;
                            const fullAddress = isPickup ? store?.address || '' : patient?.address || '';
                            const buzzerMatch = fullAddress.match(/buzz(?:er)?\s*(\d+)/i);
                            const buzzerNum = buzzerMatch ? buzzerMatch[1] : null;
                            return (
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                {unitNum && <span className="text-md">#{unitNum}</span>}
                                {buzzerNum && <span className="text-lg font-medium">Buzz {buzzerNum}</span>}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="w-full h-[26px]" />
                  )}
                </div>
                {!routeCompletedForLayout && !isPastDeliveryDate && !isAssignedDispatcher && (
                  <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                    {isPickup && isWithinActiveStopRange && !isFinishedDelivery && delivery.status === 'en_route' && pendingPickups && pendingPickups.length > 0 && canAccessAcceptButtons ? (
                      <button
                        onClick={async (e) => { e.stopPropagation(); blockCardToggle(e); await handleAcceptAllStops(); }}
                        className="inline-flex items-center gap-1 h-9 px-2.5 text-xs !text-white bg-emerald-600 hover:bg-emerald-700 rounded-md font-medium whitespace-nowrap"
                        disabled={isAcceptingAll}
                      >
                        {isAcceptingAll && <Loader2 className="w-3 h-3 animate-spin" />}
                        {acceptButtonText}
                      </button>
                    ) : (
                      <>
                        {finalDisplayPhone && (
                          <a
                            href={`tel:${String(finalDisplayPhone).replace(/\D/g, '')}`}
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 transition-colors hover:bg-emerald-200"
                          >
                            <Phone className="w-6 h-6" />
                          </a>
                        )}
                        {isNextDelivery && navigationHref && (
                          <a
                            href={navigationHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex h-14 w-14 items-center justify-center rounded-full transition-colors bg-blue-100 text-blue-600 hover:bg-blue-200"
                          >
                            <Navigation className="w-6 h-6" />
                          </a>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <StopCardConfirmDialogs
            showDeleteConfirm={showDeleteConfirm}
            setShowDeleteConfirm={setShowDeleteConfirm}
            isPickup={isPickup}
            delivery={delivery}
            displayName={displayName}
            displayAddress={displayAddress}
            store={store}
            pendingPickups={pendingPickups}
            availableTransferPickups={availableTransferPickups}
            selectedTransferPickupId={selectedTransferPickupId}
            setSelectedTransferPickupId={setSelectedTransferPickupId}
            allDeliveries={allDeliveries}
            onDeleteDelivery={onDelete}
          />

          <StopCardReturnDialog
            showReturnConfirm={showReturnConfirm}
            returnPatient={returnPatient}
            handleCancelReturn={handleCancelReturn}
            handleConfirmReturn={handleConfirmReturn}
            isCreatingReturn={isCreatingReturn}
            store={store || stores.find((s) => s && s.id === delivery?.store_id)}
            delivery={delivery}
            driver={driver}
            patient={patient}
          />

          <StopCardPOD
            delivery={delivery}
            patient={patient}
            displayName={displayName}
            isNextDelivery={isNextDelivery}
            isFinishedDelivery={isFinishedDelivery}
            isPickup={isPickup}
            viewingImageUrl={viewingImageUrl}
            setViewingImageUrl={setViewingImageUrl}
            showSignatureCapture={showSignatureCapture}
            setShowSignatureCapture={setShowSignatureCapture}
            showPhotoCapture={showPhotoCapture}
            setShowPhotoCapture={setShowPhotoCapture}
            forceRefreshDriverDeliveries={forceRefreshDriverDeliveries}
            showButtons={false}
            currentUser={currentUser}
          />

          <FailureReasonDialog
            isOpen={showFailureReasonDialog}
            onClose={() => { setShowFailureReasonDialog(false); setPendingFailureStatus(null); }}
            onConfirm={handleFailureConfirm}
            deliveryName={displayName}
            isPickup={isPickup}
            statusType={pendingFailureStatus}
          />

          <InterStoreDropoffDialog
            open={showInterStoreDialog}
            delivery={delivery}
            match={interStoreMatch}
            pickupPatientName={patient?.full_name || delivery?.patient_name}
            originatingStoreName={store?.name}
            onSkip={() => { setShowInterStoreDialog(false); setInterStoreMatch(null); }}
            onConfirm={async () => {
              if (!interStoreMatch) return;
              const nextTrackingNumber = String((Number(delivery.tracking_number || 0) + 1)).padStart(2, '0');
              const now = new Date();
              const startInFiveMinutes = new Date(now.getTime() + 5 * 60 * 1000);
              const deliveryTimeStart = `${String(startInFiveMinutes.getHours()).padStart(2, '0')}:${String(startInFiveMinutes.getMinutes()).padStart(2, '0')}`;
              await createDeliveryLocal({
                patient_id: interStoreMatch.id,
                store_id: delivery.store_id,
                driver_id: delivery.driver_id,
                driver_name: delivery.driver_name,
                delivery_date: delivery.delivery_date,
                delivery_time_start: deliveryTimeStart,
                delivery_time_end: delivery.delivery_time_end,
                delivery_time_eta: delivery.delivery_time_eta,
                status: 'in_transit',
                puid: delivery.stop_id || delivery.puid || null,
                tracking_number: nextTrackingNumber,
                ampm_deliveries: delivery.ampm_deliveries,
                extra_time: 5,
                delivery_notes: 'InterStore Drop-off'
              });
              setShowInterStoreDialog(false);
              setInterStoreMatch(null);
            }}
          />

          {showBodySection && (
            <StopCardBody
              isExpanded={isExpanded}
              isStrippedForDispatcher={isStrippedForDispatcher}
              finalDisplayPhone={finalDisplayPhone}
              alternateDisplayPhone={patient?.phone_secondary || ''}
              isFinishedDelivery={isFinishedDelivery}
              isPickup={isPickup}
              hasCODRequired={hasCODRequired}
              codTotalRequired={codTotalRequired}
              codPayments={codPayments}
              setCodPayments={setCodPayments}
              showCODCollection={showCODCollection}
              setShowCODCollection={setShowCODCollection}
              handleAddCODPayment={handleAddCODPayment}
              isStrippedForDriver={isStrippedForDriver}
              currentUser={currentUser}
              codTotalCollected={codTotalCollected}
              isCODComplete={isCODComplete}
              delivery={delivery}
              patient={patient}
              store={store}
              patients={patients}
              pendingPickups={pendingPickups}
              canAccessAcceptButtons={canAccessAcceptButtons}
              isAcceptingAll={isAcceptingAll}
              acceptButtonText={acceptButtonText}
              handleAcceptAllStops={handleAcceptAllStops}
              onEdit={onEdit}
              onCODUpdate={onCODUpdate}
              allDeliveries={allDeliveries}
              FINISHED_STATUSES={FINISHED_STATUSES}
              forceRefreshDriverDeliveries={forceRefreshDriverDeliveries}
              isCompleting={isCompleting}
              setIsCompleting={setIsCompleting}
              onSelectionChange={onSelectionChange}
              onClick={onClick}
              notesInput={notesInput}
              setNotesInput={setNotesInput}
              onNotesUpdate={onNotesUpdate}
              isCompleted={isCompleted}
              userHasRole={userHasRole}
              Textarea={Textarea}
              isAppOwnerFn={isAppOwner}
              isPastDate={isPastDeliveryDate}
              appUsers={appUsers}
              preferredTravelMode={currentDriverAppUser?.preferred_travel_mode || currentUser?.preferred_travel_mode || 'driving'}
              onTravelModeChange={null}
              travelModeDisabled={true}
              isAtStoreLocation={isPickup && isWithinActiveStopRange}
              blockCardToggle={blockCardToggle}
            />
          )}

          <StopCardFooter
            shouldAnchorExpandedCard={false}
            showCenteredIncompleteCollapsed={showCenteredIncompleteCollapsed}
            shouldCondenseCompletedRouteForDriver={showCompletedRouteCenteredCondensed}
            isAppOwner={isAppOwner}
            userHasRole={userHasRole}
            currentUser={currentUser}
            isAssignedDriverOrAppOwner={isAssignedDriverOrAppOwner}
            canEdit={canEdit}
            delivery={delivery}
            isPickup={isPickup}
            patient={patient}
            store={store}
            displayName={displayName}
            isNextDelivery={isNextDelivery}
            isFinishedDelivery={isFinishedDelivery}
            viewingImageUrl={viewingImageUrl}
            setViewingImageUrl={setViewingImageUrl}
            showSignatureCapture={showSignatureCapture}
            setShowSignatureCapture={setShowSignatureCapture}
            showPhotoCapture={showPhotoCapture}
            setShowPhotoCapture={setShowPhotoCapture}
            forceRefreshDriverDeliveries={forceRefreshDriverDeliveries}
            showDeleteConfirm={showDeleteConfirm}
            setShowDeleteConfirm={setShowDeleteConfirm}
            isStrippedForDispatcher={isStrippedForDispatcher}
            onEdit={onEdit}
            onEditPatient={onEditPatient}
            handleUpdateGPS={handleUpdateGPS}
            onStatusUpdate={onStatusUpdate}
            blockCardToggle={blockCardToggle}
            setPendingFailureStatus={setPendingFailureStatus}
            setShowFailureReasonDialog={setShowFailureReasonDialog}
            routeCompleted={routeCompleted}
            isPastDeliveryDate={isPastDeliveryDate}
            onRestart={onRestart}
            restartCurrentDelivery={restartCurrentDelivery}
            isRestarting={isRestarting}
            isProcessingBackground={isProcessingBackground}
            isFailing={isFailing}
            isCompleting={isCompleting}
            isGlobalCompleteLocked={false}
            isGlobalRestartLocked={false}
            startTapLockRef={startTapLockRef}
            handleStartAction={handleStartAction}
            isCurrentCardStartLocked={isStarting && startTapLockRef.current}
            isStarting={isStarting}
            isRetrying={isRetrying}
            handleRetryDelivery={handleRetryDelivery}
            canRetry={canRetry}
            hasFutureRetry={hasFutureRetry}
            hasCompletedDelivery={hasCompletedDelivery}
            handleReturnClick={handleReturnClick}
            isPreparingReturn={isPreparingReturn}
            isCreatingReturn={isCreatingReturn}
            hasFutureReturn={hasFutureReturn}
            onDelete={onDelete}
            isExpanded={isExpanded}
            pendingPickups={pendingPickups}
            appUsers={appUsers}
            stores={stores}
            allDeliveries={allDeliveries}
            onStartDelivery={onStartDelivery}
            handleCompleteAction={handleCompleteAction}
          />
        </CardContent>
      </Card>
    </motion.div>
  );
}