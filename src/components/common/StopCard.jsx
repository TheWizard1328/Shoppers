import { isRouteCompleted } from '@/components/utils/routeCompletionChecker';import { motion } from 'framer-motion';
import { scheduleCompletionSideEffects } from '../utils/completeRequestQueue';
import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Phone, MapPin, Edit, Trash2, StickyNote, RotateCcw, MoreVertical, User, CheckCircle, Clock, Package, XCircle, Info, FileText, Save, X, Plus, Undo2, Loader2, Navigation, GripVertical, Bell, BellOff, Mailbox, Locate, Crosshair } from "lucide-react";
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
import { getStoreColor, hexToRgba, getContrastColor } from "../utils/colorGenerator";
import { format } from "date-fns";
import { getDriverDisplayName } from '../utils/driverUtils';
import { userHasRole, shouldShowStoreBadges, isAppOwner } from '../utils/userRoles';
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { isMobileDevice } from '../utils/deviceUtils';
import { getCurrentDevice } from '../utils/deviceManager';
import { formatAddressWithUnit, cleanBuzzerFromAddress } from '../utils/addressCleaner';
import { calculateDeliveryPay, formatPay } from '../utils/payCalculator';
import { base44 } from "@/api/base44Client";
import { setDriverStatus } from "@/functions/setDriverStatus";
import { locationTracker } from "../utils/locationTracker";
import { useAppData } from "../utils/AppDataContext";
import { calculateHaversineDistance } from "../utils/distanceCalculator";
import { createCODWithTimeout, deleteCODWithTimeout } from '../utils/squareCODHandler';
import { cleanupSquareCodCatalogForDate } from '../utils/squareCodCatalogCleanup';
import StopCardHeader from "./StopCardHeader";
import StopCardBody from "./StopCardBody";
import { notifyDriverAcceptedAll, notifyDriverAcceptedOne, notifyDispatcherAssignedAll, notifyDriverStarted, notifyDriverCompleted, notifyDriverFailed, notifyDriverRetry, notifyDriverReturn } from "../utils/deliveryMessaging";
import { triggerRouteOptimization } from "../utils/realTimeRouteOptimizer";
import { toast } from "sonner";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import FailureReasonDialog from "../deliveries/FailureReasonDialog";
import { createDeliveryLocal, updateDeliveryLocal } from '../utils/offlineMutations';
import { queueDeliveryUpdate, flushQueuedDeliveryUpdates } from '../utils/updateBatcher';
import { fabControlEvents } from '../utils/fabControlEvents';
import { invalidate } from '../utils/dataManager';
import HelpTooltip, { HELP_CONTENT } from './HelpTooltip';
import { generateCompletionTimestamp, calculateRetroactiveStopTiming, parseLocalTimestamp, shouldUseRegularTiming } from '../utils/timeRoundingHelper';
import { generateUniqueSID } from '../dashboard/DashboardHelpers';
import { recalculateAndUpdateStopOrders } from '../utils/stopOrderManager';
import StopCardCODCollection from './StopCardCODCollection';
import StopCardConfirmDialogs from './StopCardConfirmDialogs';
import StopCardReturnDialog from './StopCardReturnDialog';
import StopCardPOD from './StopCardPOD';
import { useDeliveryDisplayInfo } from './StopCardRedaction';
import { updatePatientGPS } from "../utils/patientGPSUpdater";
import { buildRetryDelivery, collapseExpandedStopCardsForDriver, getCurrentLocalTimeString, getDriverRouteDeliveries, getFinishedLegEncodedPolyline, getNextActiveDelivery, getNextTrackingNumberInGroup, incrementTrackingNumber, optimizeRouteAndApplyNextDelivery, refreshDriverRoute, rehydrateLiveBreadcrumbsForRestart, reorderActiveRouteLocally, setAndCenterNextDelivery, syncDriverLocationToStop, waitForRouteTransitionSettle, withPausedDriverLocationPoller } from "./stopCardActionHelpers";
import { clearPendingBreadcrumbsForDelivery, getPendingBreadcrumbsForDelivery } from '../utils/pendingBreadcrumbsManager';
import { runTerminalDeliverySideEffects, triggerSquareCodUpsert } from '../utils/directDeliverySideEffects';
import { getActiveDeliveryAction, runWithDeliveryActionLock, subscribeDeliveryActionLock } from '../utils/deliveryActionLock';
import { pauseOfflineSync, resumeOfflineSync } from '../utils/offlineSync';

const START_ACTION_NAME = 'start_delivery';
const statusConfig = { 'pending': { label: 'Pending', color: 'bg-slate-100 text-slate-800' }, 'in_transit': { label: 'In Transit', color: 'bg-blue-100 text-blue-800' }, 'en_route': { label: 'En Route', color: 'bg-cyan-100 text-cyan-800' }, 'next': { label: 'Next', color: 'bg-lime-100 text-lime-800' }, 'completed': { label: 'Complete', color: 'bg-emerald-100 text-emerald-800' }, 'delivered': { label: 'Complete', color: 'bg-emerald-100 text-emerald-800' }, 'failed': { label: 'Failed', color: 'bg-red-100 text-red-800' }, 'cancelled': { label: 'Cancelled', color: 'bg-red-100 text-red-800' }, 'returned': { label: 'Return', color: 'bg-orange-100 text-orange-800' } };
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];
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
  return Math.abs(actualMinutes - etaMinutes) > ETA_REFRESH_THRESHOLD_MINUTES;
};

const hasDebitOrCreditCod = (deliveryRecord, paymentList = null) => {
  const payments = Array.isArray(paymentList) ? paymentList : deliveryRecord?.cod_payments;
  if (Array.isArray(payments) && payments.some((payment) => ['Debit', 'Credit'].includes(payment?.type) && Number(payment?.amount || 0) > 0)) {
    return true;
  }
  return ['Debit', 'Credit'].includes(deliveryRecord?.cod_payment_type);
};
const formatTime12Hour = (timeString) => {
  if (!timeString || timeString === '--:--' || timeString === 'null' || timeString === 'undefined' || timeString === 'NaN:NaN' || String(timeString).includes('NaN')) return '--:--';
  try {
    const timeParts = String(timeString).split(':');
    if (timeParts.length < 2) return '--:--';
    const hours = parseInt(timeParts[0], 10);const minutes = parseInt(timeParts[1], 10);
    if (isNaN(hours) || isNaN(minutes)) return '--:--';
    const period = hours >= 12 ? 'PM' : 'AM';const displayHours = hours % 12 || 12;
    return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
  } catch (error) {return '--:--';}
};
export default function StopCard({ delivery, store, driver, patients = [], currentUser, isExpanded: externalIsExpanded, showDriverName = false, onStatusUpdate, onNotesUpdate, onEdit, onDelete, onRestart, allDeliveries = [], selectedDate, onEditPatient, drivers = [], onDriverChange, canEdit = false, getDriverColor, onClick, isSelected, isProjected = false, pendingPickups = [], onSelectionChange, selectedDeliveryIds = [], stopOrder = {}, onCODUpdate, stores = [], onCreateReturn, onStartDelivery, allStopsPending = false, onDriverStatusChange, appUsers = [], showDragHandle = false, dragHandleProps, compact = false, isRailCentered = true }) {
  const isNextDelivery = delivery?.isNextDelivery || false;
  const [, setRangeRefreshTick] = useState(0);
  const [notesInput, setNotesInput] = useState(delivery?.delivery_notes || "No driver notes");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [codPayments, setCodPayments] = useState(delivery?.cod_payments || []);
  const [showCODCollection, setShowCODCollection] = useState(false);
  const [showReturnConfirm, setShowReturnConfirm] = useState(false);const [isCreatingReturn, setIsCreatingReturn] = useState(false);
  const [returnPatient, setReturnPatient] = useState(null);const [isStarting, setIsStarting] = useState(false);const [isCompleting, setIsCompleting] = useState(false);const [isRetrying, setIsRetrying] = useState(false);const [isPreparingReturn, setIsPreparingReturn] = useState(false);const [isProcessingBackground, setIsProcessingBackground] = useState(false);const [isAcceptingAll, setIsAcceptingAll] = useState(false);const [acceptingIndividual, setAcceptingIndividual] = useState({});
  const { setIsEntityUpdating, forceRefreshDriverDeliveries, refreshData, updateDeliveriesLocally } = useAppData();
  const [showSignatureCapture, setShowSignatureCapture] = useState(false);const [showPhotoCapture, setShowPhotoCapture] = useState(false);const [viewingImageUrl, setViewingImageUrl] = useState(null);const [selectedTransferPickupId, setSelectedTransferPickupId] = useState('');const [isHovered, setIsHovered] = useState(false);const [showFailureReasonDialog, setShowFailureReasonDialog] = useState(false);const [pendingFailureStatus, setPendingFailureStatus] = useState(null);const [isFailing, setIsFailing] = useState(false);const [isRestarting, setIsRestarting] = useState(false);const [isPrimaryDevice, setIsPrimaryDevice] = useState(true);const [activeDeliveryAction, setActiveDeliveryAction] = useState(() => getActiveDeliveryAction());
  const startTapLockRef = useRef(false);const completeTapLockRef = useRef(false);const actionTapLockRef = useRef(false);const codAmountInputRefs = useRef([]);
  const isStrippedForDriver = useMemo(() => {if (!currentUser || !delivery) return false;if (userHasRole(currentUser, 'admin')) return false;if (userHasRole(currentUser, 'driver')) return delivery._isStripped === true;return false;}, [delivery?._isStripped, currentUser]);
  const isStrippedForDispatcher = useMemo(() => {if (!currentUser || !delivery) return false;if (!userHasRole(currentUser, 'dispatcher')) return false;if (userHasRole(currentUser, 'admin')) return false;const dispatcherStoreIds = currentUser.store_ids || [];return !dispatcherStoreIds.includes(delivery.store_id);}, [delivery?.store_id, currentUser]);
  const isStrippedDelivery = isStrippedForDriver || isStrippedForDispatcher;
  const ensureDriverOnline = async () => {
    if (!currentUser?.id || currentUser.id !== delivery?.driver_id) return;
    if (delivery?.delivery_date !== localDeviceTodayStr) return;
    try {
      const { data } = await setDriverStatus({ newStatus: 'on_duty' });
      try { await locationTracker.startTracking({ ...currentUser, appUserId: data?.appUserId }); } catch (trackingError) { console.warn('Could not start location tracking:', trackingError.message); }
      if (onDriverStatusChange) onDriverStatusChange('on_duty');
    } catch (error) { console.error('Failed to auto-toggle driver online:', error); }
  };
  const isFinishedDelivery = FINISHED_STATUSES.includes(delivery?.status);const isExpanded = isStrippedForDispatcher ? false : compact ? false : isSelected;
  const shouldCollapseBeforeAction = isExpanded; // only selected cards are eligible; height check happens at action time
  useEffect(() => {setNotesInput(delivery?.delivery_notes || "No driver notes");}, [delivery?.delivery_notes]);
  useEffect(() => {if (!showCODCollection) setCodPayments(delivery?.cod_payments || []);}, [delivery?.cod_payments, showCODCollection]);
  useEffect(() => {
    if (!currentUser?.id) return;
    let isMounted = true;
    getCurrentDevice(currentUser.id).then((device) => {
      if (!isMounted) return;
      setIsPrimaryDevice(device === null || device?.status !== 'inactive' && device?.is_primary_tracker !== false);
    }).catch(() => {
      if (isMounted) setIsPrimaryDevice(true);
    });
    return () => {
      isMounted = false;
    };
  }, [currentUser?.id]);
  useEffect(() => subscribeDeliveryActionLock(setActiveDeliveryAction), []);
  useEffect(() => {
    if (!delivery) return;
    const isActiveStartStatus = delivery.status === 'in_transit' || delivery.status === 'en_route';
    if (!isActiveStartStatus) {
      startTapLockRef.current = false;
      setIsStarting(false);
    }
  }, [delivery?.status, delivery?.id]);
  useEffect(() => {
    const refreshRangeCheck = () => setRangeRefreshTick((prev) => prev + 1);
    window.addEventListener('deliveryRangeCheckRefresh', refreshRangeCheck);
    window.addEventListener('driverLocationFocusRefresh', refreshRangeCheck);
    window.addEventListener('driverLocationsUpdated', refreshRangeCheck);
    return () => {
      window.removeEventListener('deliveryRangeCheckRefresh', refreshRangeCheck);
      window.removeEventListener('driverLocationFocusRefresh', refreshRangeCheck);
      window.removeEventListener('driverLocationsUpdated', refreshRangeCheck);
    };
  }, []);
  const patient = useMemo(() => {if (!delivery?.patient_id || !patients || patients.length === 0) return null;return patients.find((p) => p && (p.id === delivery.patient_id || p.patient_id === delivery.patient_id));}, [delivery?.patient_id, patients]);
  const isPickup = useMemo(() => {if (!delivery) return false;return !delivery.patient_id && !!delivery.store_id;}, [delivery?.patient_id, delivery?.store_id]);
  const availableTransferPickups = useMemo(() => {if (!delivery || !isPickup) return [];return allDeliveries?.filter((d) => d && !d.patient_id && d.store_id === delivery.store_id && d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id && d.id !== delivery.id && d.status !== 'completed' && d.status !== 'cancelled') || [];}, [delivery, allDeliveries, isPickup]);
  useEffect(() => {if (showDeleteConfirm && isPickup && pendingPickups?.length > 0) {if (availableTransferPickups.length === 0) setSelectedTransferPickupId('delete_all');else if (availableTransferPickups.length >= 1) setSelectedTransferPickupId(availableTransferPickups[0].id);}}, [showDeleteConfirm, isPickup, pendingPickups, availableTransferPickups]);
  const isInterStorePickup = useMemo(() => {if (!delivery) return false;const patientName = (delivery.patient_name || '').toLowerCase();if (patientName.includes('interstore') || patientName.includes('inter-store') || patientName.includes('inter store')) return true;const deliveryNotes = (delivery.delivery_notes || '').toLowerCase();if (deliveryNotes.includes('interstore pickup') || deliveryNotes.includes('inter-store pickup') || deliveryNotes.includes('isp')) return true;return false;}, [delivery]);
  const canChangeDriver = useMemo(() => {if (!delivery || !currentUser || !onDriverChange) return false;if (isPickup) return false;if (FINISHED_STATUSES.includes(delivery.status)) return false;return userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher');}, [currentUser, delivery, onDriverChange, isPickup]);
  const currentDriverAppUser = useMemo(() => {
    if (!currentUser?.id || !Array.isArray(appUsers)) return null;
    return appUsers.find((appUser) => appUser?.user_id === currentUser.id) || null;
  }, [appUsers, currentUser?.id]);
  const patientDisplayAddress = useMemo(() => {if (isPickup || !patient) return '';return formatAddressWithUnit(patient.address, patient.unit_number);}, [patient, delivery?.unit_number, isPickup]);
  const safeDriver = useMemo(() => driver && typeof driver === 'object' ? driver : null, [driver]);
  const driverBadgeColor = useMemo(() => {if (getDriverColor && safeDriver) return getDriverColor(safeDriver);return '#64748b';}, [getDriverColor, safeDriver]);
  const driverBadgeTextColor = useMemo(() => getContrastColor(driverBadgeColor), [driverBadgeColor]);
  const codTotalCollected = useMemo(() => codPayments.reduce((sum, payment) => sum + (parseFloat(payment.amount) || 0), 0), [codPayments]);
  const codTotalRequired = useMemo(() => delivery?.cod_total_amount_required || 0, [delivery?.cod_total_amount_required]);const hasCODRequired = useMemo(() => codTotalRequired > 0, [codTotalRequired]);const isCODComplete = useMemo(() => codTotalCollected >= codTotalRequired, [codTotalCollected, codTotalRequired]);const isCompleted = useMemo(() => delivery ? FINISHED_STATUSES.includes(delivery.status) : false, [delivery?.status]);
  const isReturnDelivery = useMemo(() => {
    if (!delivery || isPickup) return false;
    return delivery.status === 'completed' && (patient?.address || '').toUpperCase().includes('(RTN)');
  }, [delivery, patient?.address, isPickup]);
  const shouldShowReturnStatus = useMemo(() => isReturnDelivery, [isReturnDelivery]);
  const isFirstDelivery = useMemo(() => {if (!delivery || isPickup) return false;if (patient && !patient.last_delivery_date) return true;if (delivery.delivery_notes?.toLowerCase().includes('first delivery')) return true;if (delivery.first_delivery === true) return true;return false;}, [delivery, patient, isPickup]);
  const storeColor = useMemo(() => store ? getStoreColor(store) : "#71717A", [store]);
  const routeCompleted = React.useMemo(() => isRouteCompleted(delivery, allDeliveries), [delivery, allDeliveries]);
  const routeCompletedForLayout = React.useMemo(() => {if (!delivery || !Array.isArray(allDeliveries)) return false;if (!FINISHED_STATUSES.includes(delivery.status)) return false;const driverDeliveriesForDate = allDeliveries.filter((d) => {if (!d) return false;return d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id;});if (driverDeliveriesForDate.length === 0) return false;return driverDeliveriesForDate.every((d) => FINISHED_STATUSES.includes(d.status));}, [delivery, allDeliveries]);
  const localNowParts = React.useMemo(() => {
    const now = new Date();
    return {
      date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    };
  }, []);
  const edmontonNowParts = localNowParts;
  const selectedRouteDateStr = selectedDate ? format(new Date(selectedDate), 'yyyy-MM-dd') : localNowParts.date;
  const localDeviceTodayStr = localNowParts.date;
  const selectedDateSourceStr = selectedDate
    ? (typeof selectedDate === 'string'
      ? selectedDate.slice(0, 10)
      : format(new Date(selectedDate), 'yyyy-MM-dd'))
    : null;
  const comparisonRouteDateStr = delivery?.delivery_date || selectedDateSourceStr || selectedRouteDateStr;
  const edmontonTodayStr = localDeviceTodayStr;
  const isPastDeliveryDate = React.useMemo(() => !!comparisonRouteDateStr && comparisonRouteDateStr < localDeviceTodayStr, [comparisonRouteDateStr, localDeviceTodayStr]);
  const shouldUseRegularStopTiming = React.useMemo(() => {
    return shouldUseRegularTiming({
      deliveryDate: comparisonRouteDateStr,
      todayDateString: localDeviceTodayStr,
      currentTimeString: localNowParts.time
    });
  }, [comparisonRouteDateStr, localDeviceTodayStr, localNowParts.time]);
  const shouldPreserveWindowTimesOnStart = React.useMemo(() => {
    if (!delivery?.delivery_date) return false;
    return !shouldUseRegularStopTiming;
  }, [delivery?.delivery_date, shouldUseRegularStopTiming]);
  const shouldUseRetroactiveStopTiming = React.useMemo(() => !shouldUseRegularStopTiming, [shouldUseRegularStopTiming]);
  const shouldCondenseCompletedRouteForDriver = userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') && isFinishedDelivery && routeCompletedForLayout && !isExpanded;
  const showCompletedRouteCenteredCondensed = shouldCondenseCompletedRouteForDriver;
  const showIncompleteRouteSideCondensed = !routeCompletedForLayout && !isExpanded && !isRailCentered;
  const showCenteredIncompleteCollapsed = !routeCompletedForLayout && !isExpanded && isRailCentered;
  const isDispatcherCenteredCard = userHasRole(currentUser, 'dispatcher') && isRailCentered;
  const hideBodyForDispatcherCenteredCard = isDispatcherCenteredCard && !isStrippedForDispatcher && !isExpanded;
  const forceCompactCollapsed = compact && !isExpanded;
  const showMiddleSection = !forceCompactCollapsed && !isStrippedForDriver && !isStrippedForDispatcher && !showIncompleteRouteSideCondensed && (!isFinishedDelivery || isExpanded || isRailCentered) && !showCompletedRouteCenteredCondensed;
  const showBodySection = !forceCompactCollapsed && !showCompletedRouteCenteredCondensed && !showIncompleteRouteSideCondensed && !hideBodyForDispatcherCenteredCard;
  const isInterStore = useMemo(() => {if (!delivery) return false;const patientName = (patient?.full_name || '').toLowerCase();if (patientName.includes('interstore') || patientName.includes('inter-store') || patientName.includes('inter store')) return true;const patientNotes = (patient?.notes || '').toLowerCase();if (patientNotes.includes('interstore') || patientNotes.includes('inter-store') || patientNotes.includes('inter store')) return true;return false;}, [delivery, patient]);
  const isFirstRouteStop = useMemo(() => {
    if (!delivery) return false;
    const activeRouteStops = (allDeliveries || [])
      .filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date)
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
    return activeRouteStops[0]?.id === delivery.id;
  }, [allDeliveries, delivery]);
  const shouldShowStoreBadge = useMemo(() => shouldShowStoreBadges(currentUser), [currentUser]);
  const isGlobalCompleteLocked = !!activeDeliveryAction && activeDeliveryAction.actionName === 'complete_delivery';
  const isGlobalRestartLocked = !!activeDeliveryAction && activeDeliveryAction.actionName === 'restart_delivery';
  const isGlobalStartLocked = !!activeDeliveryAction && activeDeliveryAction.actionName === START_ACTION_NAME;
  const isCurrentCardStartLocked = isStarting && (isGlobalStartLocked || startTapLockRef.current);
  const { displayName, displayAddress, displayPhone, shouldRedact, finalDisplayName, finalDisplayAddress, finalDisplayPhone } = useDeliveryDisplayInfo({ delivery, patient, store, currentUser, isPickup, isInterStore, isInterStorePickup, isStrippedDelivery, isStrippedForDispatcher });
  const shouldDisableRetryReturn = useMemo(() => false, []);
  const { hasFutureRetry, hasFutureReturn, hasCompletedDelivery } = useMemo(() => {
    if (delivery.status !== 'failed' || isPickup || !patient) return { hasFutureRetry: false, hasFutureReturn: false, hasCompletedDelivery: false };
    const failedDate = String(delivery.delivery_date || '');
    const failedDateValue = Number(failedDate.replace(/-/g, ''));
    const toDateValue = failedDateValue + 7;
    let futureRetryExists = false;
    let completedDeliveryExists = false;
    for (const d of allDeliveries) {
      if (!d || d.id === delivery.id || !d.delivery_date) continue;
      const dDateValue = Number(String(d.delivery_date).replace(/-/g, ''));
      if (dDateValue >= failedDateValue && dDateValue < toDateValue) {
        if (d.patient_id === delivery.patient_id && d.stop_id === delivery.stop_id && d.status !== 'failed') futureRetryExists = true;
        if (d.delivery_date === delivery.delivery_date && d.patient_id === delivery.patient_id && d.status === 'completed') completedDeliveryExists = true;
      }
      if (futureRetryExists && completedDeliveryExists) break;
    }
    return { hasFutureRetry: futureRetryExists, hasFutureReturn: false, hasCompletedDelivery: completedDeliveryExists };
  }, [delivery, allDeliveries, patient, isPickup]);
  const canRetry = useMemo(() => {if (!delivery || delivery.status !== 'failed' || isPickup || !patient) return true;if (hasFutureReturn) return false;const hasLaterDelivery = allDeliveries.some((d) => {if (!d || d.id === delivery.id) return false;if (d.delivery_date !== delivery.delivery_date) return false;if (d.patient_id !== delivery.patient_id) return false;return (d.stop_order || 0) > (delivery.stop_order || 0);});return !hasLaterDelivery;}, [delivery, allDeliveries, patient, isPickup, hasFutureReturn]);
  const _isProjectedData = useMemo(() => delivery?.isProjected || false, [delivery?.isProjected]);
  const isAssignedDriverOrAppOwner = useMemo(() => {if (!currentUser || !delivery) return false;if (isAppOwner(currentUser)) return true;if (!userHasRole(currentUser, 'driver')) return false;return delivery.driver_id === currentUser.id;}, [currentUser, delivery]);
  const isAssignedDispatcher = useMemo(() => {if (!currentUser || !delivery) return false;if (!userHasRole(currentUser, 'dispatcher')) return false;const dispatcherStoreIds = currentUser.store_ids || [];return dispatcherStoreIds.includes(delivery.store_id);}, [currentUser, delivery]);
  const canAccessAcceptButtons = useMemo(() => {if (!currentUser || !delivery) return false;if (isAppOwner(currentUser) || userHasRole(currentUser, 'admin')) return true;if (isAssignedDispatcher) return true;if (userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id) return true;return false;}, [currentUser, delivery, isAssignedDispatcher]);
  const acceptButtonText = useMemo(() => {if (!currentUser || !delivery) return 'Assign All';const isAssignedDriver = delivery.driver_id === currentUser.id && userHasRole(currentUser, 'driver');if (isAssignedDriver) return 'Accept All';return 'Assign All';}, [currentUser, delivery?.driver_id]);
  const nextAvailableStatuses = useMemo(() => {if (!onStatusUpdate || !currentUser) return [];if (!isAssignedDriverOrAppOwner) return [];const canChangeStatus = userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver');if (!canChangeStatus) return [];if (FINISHED_STATUSES.includes(delivery.status)) return [];let statuses = [];if (isPickup) statuses = ['en_route', 'completed', 'cancelled'];else statuses = ['pending', 'in_transit', 'completed', 'failed'];return statuses.filter((s) => s !== delivery.status);}, [delivery?.status, onStatusUpdate, currentUser, isPickup, isAssignedDriverOrAppOwner]);
  const showStatusDropdown = useMemo(() => {if (isRouteCompleted) return false;return nextAvailableStatuses.length > 0;}, [isRouteCompleted, nextAvailableStatuses]);
  const resetActionLocks = React.useCallback((skipCardScroll = true) => {
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
  }, [setIsEntityUpdating]);
  const shouldCondenseCardOnAction = useCallback(() => {
    if (!isSelected) return false;
    const cardElement = document.getElementById(`stop-card-${delivery?.id}`);
    const cardSurface = cardElement?.querySelector('.rounded-xl');
    if (!cardSurface) return false;
    return cardSurface.offsetHeight > 72;
  }, [delivery?.id, isSelected]);
  const routeHasIncompleteStops = useMemo(() => {
    if (!delivery) return false;
    return (allDeliveries || []).some((item) => item && item.driver_id === delivery.driver_id && item.delivery_date === delivery.delivery_date && !FINISHED_STATUSES.includes(item.status) && item.status !== 'pending');
  }, [allDeliveries, delivery]);
  if (!delivery) return null;
  const handleNotesBlur = () => {if (!notesInput.trim() || notesInput.trim() === 'No driver notes') {setNotesInput('No driver notes');if (delivery?.delivery_notes && delivery.delivery_notes.trim() && onNotesUpdate) onNotesUpdate(delivery.id, '');return;}if (notesInput !== delivery.delivery_notes && onNotesUpdate) onNotesUpdate(delivery.id, notesInput);};
  const handleNotesKeyDown = (e) => {if (e.key === 'Enter' && !e.shiftKey) {e.preventDefault();if (notesInput !== delivery.delivery_notes && onNotesUpdate) onNotesUpdate(delivery.id, notesInput);e.target.blur();}};
  const handleUpdateGPS = async (e) => {
    e?.stopPropagation?.();
    await updatePatientGPS({
      patientId: patient.id,
      storeId: delivery.store_id,
      stores,
      mapCrosshairCoords: window.__mapCrosshairCoords || null,
      preferCrosshair: delivery?.status === 'completed' || (!isMobileDevice() && !isPrimaryDevice),
      currentPatientCoords: {
        latitude: patient?.latitude,
        longitude: patient?.longitude
      }
    });
  };
  const handleCODPaymentChange = (index, field, value) => {const newPayments = [...codPayments];if (field === 'amount') {const cleaned = String(value).replace(/[^\d]/g, '');const cents = parseInt(cleaned) || 0;newPayments[index] = { ...newPayments[index], [field]: cents / 100 };} else if (field === 'type') {newPayments[index] = { ...newPayments[index], [field]: value };if (newPayments[index].amount === 0) {const remainingAmount = codTotalRequired - codTotalCollected;newPayments[index].amount = Math.max(0, remainingAmount);}} else newPayments[index] = { ...newPayments[index], [field]: value };setCodPayments(newPayments);};
  const handleAddCODPayment = (shouldFocusType = false) => {const remainingAmount = codTotalRequired - codTotalCollected;const newPayment = { type: 'Cash', amount: Math.max(0, remainingAmount) };setCodPayments([...codPayments, newPayment]);if (shouldFocusType) {setTimeout(() => {const lastIndex = codPayments.length;const selectTrigger = document.querySelector(`[data-cod-select-index="${lastIndex}"]`);if (selectTrigger) selectTrigger.click();}, 100);} else {setTimeout(() => {const lastIndex = codPayments.length;if (codAmountInputRefs.current[lastIndex]) {codAmountInputRefs.current[lastIndex].focus();codAmountInputRefs.current[lastIndex].select();}}, 50);}};
  const handleRemoveCODPayment = (index) => {const newPayments = codPayments.filter((_, i) => i !== index);setCodPayments(newPayments);};
  const handleSaveCODPayments = async () => {if (onCODUpdate) {try {await onCODUpdate(delivery.id, codPayments, true);setShowCODCollection(false);} catch (error) {console.error('❌ [COD Save] Failed:', error);alert(`Failed to save COD: ${error.message}`);}}};
  const collapseAndCenterNextDelivery = async (args) => await setAndCenterNextDelivery(args);
  const collapseDriverStopCards = async () => {
    if (!shouldCondenseCardOnAction()) return;
    await collapseExpandedStopCardsForDriver(delivery?.driver_id);
  };

  const blockCardToggle = (e, options = {}) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (isExpanded && !options.keepExpanded) {
      onClick?.(null);
    }
    actionTapLockRef.current = true;
    window.setTimeout(() => {
      actionTapLockRef.current = false;
    }, 350);
  };

  const handleStartAction = async (e) => {
    e?.preventDefault?.();e?.stopPropagation?.();if (isCurrentCardStartLocked || isProcessingBackground || isCompleting || isFailing || isRetrying || isRestarting) return;
    if (isGlobalStartLocked && !isStarting) return;
    startTapLockRef.current = true;setIsStarting(true);setIsEntityUpdating(true);setIsProcessingBackground(true);fabControlEvents.deactivateFAB();const { driverLocationPoller } = await import('../utils/driverLocationPoller');driverLocationPoller.pause();smartRefreshManager.pause();
    const lockResult = await runWithDeliveryActionLock(START_ACTION_NAME, async () => {
    pauseOfflineSync('delivery_actions');
    try {
      const now = new Date();const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const isValidObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);if (!isValidObjectId(delivery.id) || !isValidObjectId(delivery.driver_id)) throw new Error('This stop is still syncing. Please try again in a moment.');
      const routeDeliveries = getDriverRouteDeliveries(allDeliveries, delivery);
      await collapseDriverStopCards();
      const startedRouteDeliveries = routeDeliveries.map((d) => {
        if (!d) return d;
        const isCurrent = d.id === delivery.id;
        return {
          ...d,
          ...(isCurrent ? {
            status: isPickup ? 'en_route' : 'in_transit',
            ...(shouldPreserveWindowTimesOnStart ? {} : { delivery_time_start: currentLocalTime, delivery_time_end: currentLocalTime }),
            delivery_time_eta: currentLocalTime,
            isNextDelivery: true
          } : {})
        };
      });
      const { offlineDB } = await import('../utils/offlineDatabase');
      const startedChangedDeliveries = startedRouteDeliveries.filter((item) => {
        const existing = routeDeliveries.find((routeItem) => routeItem?.id === item?.id);
        return existing && JSON.stringify(existing) !== JSON.stringify(item);
      });
      if (startedChangedDeliveries.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, startedChangedDeliveries.filter(Boolean));
      }
      if (updateDeliveriesLocally) {
        const optimisticMap = new Map(startedRouteDeliveries.filter(Boolean).map((d) => [d.id, d]));
        const updatedDeliveries = allDeliveries.map((d) => d && optimisticMap.has(d.id) ? optimisticMap.get(d.id) : d);
        updateDeliveriesLocally(updatedDeliveries, true);
      }
      await collapseAndCenterNextDelivery({ driverDeliveries: startedRouteDeliveries, targetDeliveryId: delivery.id, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
      window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: delivery.id } }));
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true } }));
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      Promise.resolve().then(async () => {
        window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
        try {
          const startResponse = await base44.functions.invoke('handleStartDelivery', { deliveryId: delivery.id, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
          const startData = startResponse?.data || startResponse || {};
          const backendOptimizedRoute = Array.isArray(startData?.optimization?.optimizedRoute) ? startData.optimization.optimizedRoute : [];
          if (backendOptimizedRoute.length > 0) {
            window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { updates: backendOptimizedRoute.map((u) => ({ deliveryId: u.deliveryId || u.delivery_id, newEta: u.eta || u.newETA })) } }));
          }
          fabControlEvents.reactivatePhaseTwoIfAvailable();
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'startOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true, preserveLocalState: true } }));
        } catch (optErr) {console.warn('⚠️ [Start] background optimization failed:', optErr?.message || optErr);} finally
        {window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));}
      });
      Promise.all([ensureDriverOnline(), userHasRole(currentUser, 'driver') && currentUser.id === delivery.driver_id ? notifyDriverStarted({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers }) : Promise.resolve()]).catch((err) => console.warn('Background tasks failed:', err));
    } catch (error) {console.error('❌ [START] Error:', error);toast.error(`Failed to start: ${error.message}`);} finally
    {resumeOfflineSync('delivery_actions');driverLocationPoller.resume();smartRefreshManager.resume();resetActionLocks(true);}
    });
    if (lockResult?.skipped) return;
  };
  const executeAcceptAllStops = async () => {
    pauseOfflineSync('delivery_actions');
    setIsAcceptingAll(true);const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    try {
      driverLocationPoller.pause();smartRefreshManager.pause();setIsEntityUpdating(true);
      const allPendingDeliveries = pendingPickups.filter((p) => p.status === 'pending');const now = new Date();const currentMinutes = now.getHours() * 60 + now.getMinutes();const startMinutes = currentMinutes + 5;const deliveryTimeStart = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const sortedPending = [...allPendingDeliveries].sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));

      const localUpdates = sortedPending.map((pendingDelivery, i) => ({
        id: pendingDelivery.id,
        status: 'in_transit',
        delivery_time_start: deliveryTimeStart,
        tracking_number: incrementTrackingNumber(delivery.tracking_number, i + 1),
        isNextDelivery: false,
        ...(pendingDelivery.active === false ? { active: true } : {})
      }));

      await Promise.all(localUpdates.map((update) => updateDeliveryLocal(update.id, update, { skipSmartRefresh: true })));

      fabControlEvents.notifyAcceptAllClicked();
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAll', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true } }));
      window.dispatchEvent(new CustomEvent('pendingToInTransit', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));

      const codBatch = allPendingDeliveries.filter((pd) => pd.cod_total_amount_required > 0 && pd.patient_id).map((pendingDelivery) => {const storeForCod = stores.find((s) => s && s.id === pendingDelivery.store_id);return { deliveryId: pendingDelivery.id, patientName: pendingDelivery.patient_name, storeAbbreviation: storeForCod?.abbreviation || '', codAmount: pendingDelivery.cod_total_amount_required, deliveryDate: pendingDelivery.delivery_date, storeId: pendingDelivery.store_id };});

      sortedPending.forEach((pendingDelivery, i) => {queueDeliveryUpdate(pendingDelivery.id, { status: 'in_transit', delivery_time_start: deliveryTimeStart, tracking_number: incrementTrackingNumber(delivery.tracking_number, i + 1), ...(pendingDelivery.active === false ? { active: true } : {}) });});
      await flushQueuedDeliveryUpdates();
      invalidate('Delivery');
      await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

      Promise.resolve().then(async () => {
        window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
        try {
          const optimizeResponse = await base44.functions.invoke('optimizeRouteRealTime', { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime: currentLocalTime, generatePolyline: false });
          const optimizeData = optimizeResponse?.data || optimizeResponse;
          if (optimizeData?.success && Array.isArray(optimizeData.optimizedRoute) && optimizeData.optimizedRoute.length > 0) {
            window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { driverId: delivery.driver_id, updates: optimizeData.optimizedRoute.map((stop) => ({ deliveryId: stop.deliveryId || stop.delivery_id, newEta: stop.newETA || stop.eta })).filter((stop) => stop.deliveryId && stop.newEta) } }));
            window.dispatchEvent(new CustomEvent('routeReordered', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, source: 'acceptAllAutoOptimize' } }));
          }
          invalidate('Delivery');
          await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

          const refreshedRouteDeliveries = await base44.entities.Delivery.filter({ driver_id: delivery.driver_id, delivery_date: delivery.delivery_date });
          const nextOptimizedStop = getNextActiveDelivery(refreshedRouteDeliveries, null, FINISHED_STATUSES);
          await collapseAndCenterNextDelivery({
            driverDeliveries: refreshedRouteDeliveries,
            targetDeliveryId: nextOptimizedStop?.id || null,
            updateDeliveryLocal,
            updateDeliveriesLocally,
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date
          });
        } catch (optErr) {console.warn('⚠️ [Accept All] background optimization failed:', optErr?.message || optErr);} finally
        {
          window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAllOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true } }));
        }
      });

      if (typeof codBatch !== 'undefined' && codBatch.length > 0) {console.log(`📦 [Square] Queuing ${codBatch.length} COD items to backend...`, codBatch);base44.functions.invoke('syncSquareCods', { items: codBatch }).then(() => {try {toast?.success?.(`Queued ${codBatch.length} CODs to Square`);} catch (_) {}}).catch((e) => console.warn('⚠️ [Square] Batch COD sync failed to start:', e));}

      const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id;
      if (isDriverAction) notifyDriverAcceptedAll({ driver: currentUser, store, appUsers }).catch((err) => console.warn('Notification failed:', err));else
      {const assignedDriver = drivers.find((d) => d?.id === delivery.driver_id);if (assignedDriver) notifyDispatcherAssignedAll({ dispatcher: currentUser, driver: assignedDriver, store, deliveries: allPendingDeliveries, patients }).catch((err) => console.warn('Notification failed:', err));}
    } catch (error) {console.error('❌ [Accept All] Error:', error);toast.error(`Failed to accept all: ${error.message}`);throw error;} finally
    {resumeOfflineSync('delivery_actions');driverLocationPoller.resume();smartRefreshManager.resume();setIsEntityUpdating(false);setIsAcceptingAll(false);if (onClick) onClick(null);}
  };

  const handleAcceptAllStops = async () => {
    const lockResult = await runWithDeliveryActionLock('accept_all_delivery', async () => {
      await executeAcceptAllStops();
    });
    if (lockResult?.skipped) return;
  };
  const handleReturnClick = async (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (isPreparingReturn || showReturnConfirm) return;
    blockCardToggle(e, { keepExpanded: true });
    setIsPreparingReturn(true);
    try {
      const resolvedStore = store || stores.find((s) => s && s.id === delivery?.store_id);
      if (!delivery || !resolvedStore) {
        alert('Missing delivery or store information');
        return;
      }
      const returnPatientName = `${resolvedStore.name.replace(/-/g, ' ')} Return`;
      const foundReturnPatient = patients.find((p) => p && p.full_name === returnPatientName && p.store_id === delivery.store_id);
      if (!foundReturnPatient) {
        alert(`Return patient "${returnPatientName}" not found. Please ensure a patient with this name exists for the store.`);
        return;
      }
      setReturnPatient(foundReturnPatient);
      setShowReturnConfirm(true);
    } finally {
      setIsPreparingReturn(false);
    }
  };
  const handleConfirmReturn = async () => {
    if (!onCreateReturn || !returnPatient || isCreatingReturn) return;
    setIsCreatingReturn(true);
    const selectedReturnPatient = returnPatient;
    const resolvedStore = store || stores.find((s) => s && s.id === delivery?.store_id);
    setShowReturnConfirm(false);
    setReturnPatient(null);
    onClick?.(null);
    try {
      await onCreateReturn({ originalDelivery: delivery, returnPatient: selectedReturnPatient, store: resolvedStore, _skipPickupCreation: true });
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'return', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      toast.success('Return created');
      Promise.resolve().then(async () => {
        try {
          const backgroundTasks = [];
          if ((delivery.cod_total_amount_required || 0) > 0) {
            backgroundTasks.push(deleteCODWithTimeout(delivery.id, 'Removed after creating return delivery'));
          }
          backgroundTasks.push((async () => {
            await optimizeRouteAndApplyNextDelivery({
              driverId: delivery.driver_id,
              deliveryDate: delivery.delivery_date,
              currentLocalTime: getCurrentLocalTimeString(),
              updateDeliveryLocal,
              updateDeliveriesLocally,
              forceRefreshDriverDeliveries,
              generatePolyline: false
            });
          })());
          if (userHasRole(currentUser, 'driver')) {
            backgroundTasks.push(notifyDriverReturn({ driver: currentUser, patientName: patient?.full_name, delivery, store, appUsers }));
          }
          await Promise.allSettled(backgroundTasks);
        } catch (_) {}
      });
    } catch (error) {
      console.error('Failed to create return:', error);
      alert('Failed to create return delivery');
    } finally {
      setIsCreatingReturn(false);
    }
  };
  const handleCancelReturn = () => {setShowReturnConfirm(false);setReturnPatient(null);};
  const handleRetryDelivery = async (e) => {
    blockCardToggle(e, { keepExpanded: true });
    const lockResult = await runWithDeliveryActionLock('retry_delivery', async () => {
    pauseOfflineSync('delivery_actions');
    fabControlEvents.deactivateFAB();setIsRetrying(true);setIsProcessingBackground(true);
    try {
      await withPausedDriverLocationPoller(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const retryTrackingNumber = getNextTrackingNumberInGroup(delivery.tracking_number, allDeliveries, delivery.driver_id, delivery.delivery_date);
        const retryDraft = buildRetryDelivery(delivery, retryTrackingNumber);
        const retryDate = retryDraft.delivery_date;
        const retryDateDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === retryDate);
        const newRetryDelivery = await createDeliveryLocal({
          ...retryDraft,
          stop_id: generateUniqueSID(retryDateDeliveries),
          puid: delivery.puid || delivery.stop_id || null,
          ampm_deliveries: delivery.ampm_deliveries,
          tracking_number: String(retryTrackingNumber),
          _skipPickupCreation: true
        });
        if ((delivery.cod_total_amount_required || 0) > 0) {
          await deleteCODWithTimeout(delivery.id, 'Removed after creating retry delivery');
          const retryDeliveryId = newRetryDelivery?.id || newRetryDelivery?.data?.id;
          if (retryDeliveryId && !isPickup) {
            triggerSquareCodUpsert({
              deliveryId: retryDeliveryId,
              patientName: patient?.full_name || delivery.patient_name || 'Patient',
              storeAbbreviation: store?.abbreviation || '',
              codAmount: delivery.cod_total_amount_required,
              deliveryDate: retryDate,
              storeId: delivery.store_id
            });
          }
        }
        await ensureDriverOnline();
        try {
          await optimizeRouteAndApplyNextDelivery({
            driverId: delivery.driver_id,
            deliveryDate: retryDate,
            currentLocalTime: getCurrentLocalTimeString(),
            updateDeliveryLocal,
            updateDeliveriesLocally,
            forceRefreshDriverDeliveries,
            generatePolyline: false
          });
        } catch (optimizeError) {console.warn('⚠️ [Retry] Route optimizer failed:', optimizeError);}
        if (userHasRole(currentUser, 'driver')) await notifyDriverRetry({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers });
      });
    } finally {resumeOfflineSync('delivery_actions');resetActionLocks(true);}
    });
    if (lockResult?.skipped) return;
  };
  const restartCurrentDelivery = async (shouldOptimize = false) => {
    const lockResult = await runWithDeliveryActionLock('restart_delivery', async () => {
      pauseOfflineSync('delivery_actions');
      fabControlEvents.deactivateFAB();setIsRestarting(true);setIsEntityUpdating(true);setIsProcessingBackground(true);
      try {
        await withPausedDriverLocationPoller(async () => {
        await collapseDriverStopCards();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await rehydrateLiveBreadcrumbsForRestart(delivery);
        const driverDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        const newStatus = isPickup ? 'en_route' : 'in_transit';
        const restartedRouteDeliveries = reorderActiveRouteLocally(
          driverDeliveries.map((item) => item?.id === delivery.id ? { ...item, status: newStatus, isNextDelivery: true, actual_delivery_time: null, delivery_notes: '', finished_leg_encoded_polyline: null, travel_dist: 0, PolylineUpdated: false } : { ...item, isNextDelivery: false }),
          delivery.id
        );
        console.warn('[StopCard][restart] restarted target delivery', restartedRouteDeliveries.find((item) => item?.id === delivery.id));
        await Promise.all(
          restartedRouteDeliveries
            .filter((item) => item && (item.id === delivery.id || item.isNextDelivery === false))
            .map((item) => {
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
              if (item.id === delivery.id) {
                console.warn('[StopCard][restart] updateDeliveryLocal payload', { id: item.id, updates, existingRouteItem, item });
              }
              return updateDeliveryLocal(item.id, updates, { skipSmartRefresh: true });
            })
        );
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
        if ((delivery.cod_total_amount_required || 0) > 0 && !isPickup) {
          triggerSquareCodUpsert({
            deliveryId: delivery.id,
            patientName: patient?.full_name || delivery.patient_name || 'Patient',
            storeAbbreviation: store?.abbreviation || '',
            codAmount: delivery.cod_total_amount_required,
            deliveryDate: delivery.delivery_date,
            storeId: delivery.store_id
          });
        }
        let restartOptimizeData = null;
        try {
          const optimizationResult = await optimizeRouteAndApplyNextDelivery({
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date,
            currentLocalTime: getCurrentLocalTimeString(),
            updateDeliveryLocal,
            updateDeliveriesLocally,
            forceRefreshDriverDeliveries,
            generatePolyline: false
          });
          restartOptimizeData = optimizationResult?.optimizeData || null;
        } catch (optimizeError) {
          console.warn('⚠️ [Restart Delivery] Route optimizer failed:', optimizeError);
        }
        if (restartOptimizeData?.success && Array.isArray(restartOptimizeData.optimizedRoute) && restartOptimizeData.optimizedRoute.length > 0) {
          window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { driverId: delivery.driver_id, updates: restartOptimizeData.optimizedRoute.map((stop) => ({ deliveryId: stop.deliveryId || stop.delivery_id, newEta: stop.newETA || stop.eta })).filter((stop) => stop.deliveryId && stop.newEta) } }));
        }
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'restart', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true, suppressFabIfPhase1: true } }));
        window.dispatchEvent(new CustomEvent('deliveryStatusChanged', { detail: { triggeredBy: 'restart', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, maxStops: 5 } }));
        if (userHasRole(currentUser, 'driver')) await notifyDriverRetry({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers });
      });
    } finally {resumeOfflineSync('delivery_actions');resetActionLocks(true);}
    });
    if (lockResult?.skipped) return;
  };
  const shouldFade = isFinishedDelivery && routeHasIncompleteStops && !isSelected && !isHovered;
  const isMobileCard = isMobileDevice();
  const cardZIndex = isMobileCard
    ? (isExpanded ? 320 : isHovered && !isRailCentered ? 260 : isRailCentered ? 250 : 240)
    : (isExpanded ? 70 : isHovered && !isRailCentered ? 52 : isRailCentered ? 51 : 50);
  const shouldAnchorExpandedCard = isMobileCard && isSelected && !isStrippedDelivery;const stopLat = Number(isPickup ? store?.latitude : patient?.latitude);const stopLon = Number(isPickup ? store?.longitude : patient?.longitude);const driverLat = Number(currentDriverAppUser?.current_latitude ?? currentUser?.current_latitude);const driverLon = Number(currentDriverAppUser?.current_longitude ?? currentUser?.current_longitude);const isWithinActiveStopRange = Number.isFinite(driverLat) && Number.isFinite(driverLon) && Number.isFinite(stopLat) && Number.isFinite(stopLon) && calculateHaversineDistance(driverLat, driverLon, stopLat, stopLon) <= 100;
  return (
    <motion.div id={`stop-card-${delivery.id}`} data-is-condensed={shouldFade && !isExpanded && !isHovered} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className={`w-full cursor-pointer transition-all ${showCenteredIncompleteCollapsed ? 'self-start' : ''} ${isSelected && !isStrippedDelivery ? 'ring-2 ring-blue-500' : ''}`} style={{ scrollSnapAlign: 'center', position: 'relative', zIndex: cardZIndex, isolation: isExpanded ? 'isolate' : 'auto' }} onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
      <Card data-route-completed-condensed={showCompletedRouteCenteredCondensed ? "true" : "false"} className={`bg-card text-card-foreground rounded-xl border shadow-md cursor-pointer hover:shadow-lg transition-all duration-200 overflow-hidden ${forceCompactCollapsed ? 'h-[72px] min-h-[72px]' : isStrippedForDispatcher ? 'h-[72px] min-h-[72px]' : showCompletedRouteCenteredCondensed ? 'h-[72px] min-h-[72px]' : !isRailCentered && !isExpanded ? 'h-[72px] min-h-[72px]' : showCenteredIncompleteCollapsed ? 'min-h-0 h-auto self-start' : isFinishedDelivery && isExpanded ? 'h-auto min-h-[120px]' : 'min-h-[120px]'} min-w-[338px] max-w-[338px] border-blue-500`} onClick={(e) => {
          const actionButton = e.target?.closest?.('[data-stopcard-action="start"], [data-stopcard-action="complete"], [data-stopcard-action="restart"], [data-stopcard-action="retry"], [data-stopcard-action="return"]');
          if (startTapLockRef.current || completeTapLockRef.current || actionTapLockRef.current || isStarting || isCompleting || isRestarting || isProcessingBackground || isFailing || actionButton) return;
          onClick && onClick(delivery);
        }} style={{ background: 'var(--bg-white)', borderColor: isNextDelivery ? '#10B981' : '#3B82F6', opacity: shouldFade ? 0.4 : 1, transition: 'opacity 0.2s ease-in-out', maxHeight: shouldAnchorExpandedCard ? 'calc(100dvh - var(--bottom-nav-height, 64px) - 1rem)' : undefined }}>
        <CardContent className={`p-6 px-1 flex flex-col py-0 ${shouldAnchorExpandedCard ? 'max-h-full overflow-y-auto overscroll-contain' : ''}`}>
          <div className="flex items-start">{showDragHandle && dragHandleProps && !FINISHED_STATUSES.includes(delivery.status) && <div {...dragHandleProps} className="flex items-center justify-center cursor-grab active:cursor-grabbing pt-1 mr-1"><GripVertical className="w-5 h-5 text-slate-400 hover:text-slate-600" /></div>}<StopCardHeader delivery={delivery} store={store} patient={patient} isPickup={isPickup} pendingPickups={pendingPickups} storeColor={storeColor} finalDisplayName={finalDisplayName} FINISHED_STATUSES={FINISHED_STATUSES} showDriverName={showDriverName} safeDriver={safeDriver} driverBadgeColor={driverBadgeColor} driverBadgeTextColor={driverBadgeTextColor} currentUser={currentUser} appUsers={appUsers} isReturnDelivery={shouldShowReturnStatus} /></div>
          {showMiddleSection && <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}></div>}
          {showMiddleSection && <div className="flex flex-col"><div className="flex items-start justify-between"><div className="flex flex-col justify-center gap-0.5 flex-1 min-w-0 min-h-[55px]">{finalDisplayAddress ? <><div className="flex items-start gap-2 text-lg" style={{ color: 'var(--text-slate-700)' }}><span className="text-xl font-medium truncate">{isPickup ? store?.address || '' : patient?.address || ''}</span></div>{!isStrippedDelivery && !shouldRedact && <div className="flex items-center text-lg min-h-[26px]" style={{ color: 'var(--text-slate-600)' }}>{(() => {const unitNum = !isPickup ? delivery?.unit_number || patient?.unit_number : null;const fullAddress = isPickup ? store?.address || '' : patient?.address || '';const buzzerMatch = fullAddress.match(/buzz(?:er)?\s*(\d+)/i);const buzzerNum = buzzerMatch ? buzzerMatch[1] : null;return <>{unitNum && <span className="text-md">#{unitNum}</span>}{buzzerNum && <span className="text-lg font-medium">Buzz {buzzerNum}</span>}{!unitNum && !buzzerNum && <span className="invisible">&nbsp;</span>}</>;})()}</div>}</> : <div className="w-full h-[26px]" />}</div>{isAssignedDriverOrAppOwner && !isStrippedForDriver && <div className="flex-shrink-0 flex items-center gap-2 min-h-[55px]">{finalDisplayPhone && <a href={`tel:${finalDisplayPhone.replace(/\D/g, '')}`} onClick={(e) => e.stopPropagation()} className="flex items-center justify-center w-12 h-12 rounded-full bg-emerald-100 hover:bg-emerald-200 text-emerald-600 transition-colors"><Phone className="w-6 h-6" /></a>}{isNextDelivery && (!isPickup && patient?.latitude && patient?.longitude || isPickup && store?.latitude && store?.longitude) && <button onClick={(e) => {e.stopPropagation();if (isWithinActiveStopRange) {handleUpdateGPS(e);return;}const navUrl = isPickup ? `https://www.google.com/maps/dir/?api=1&destination=${store.latitude},${store.longitude}` : `https://www.google.com/maps/dir/?api=1&destination=${patient.latitude},${patient.longitude}`;window.open(navUrl, '_blank');fabControlEvents.reactivatePhaseTwoIfAvailable();}} className={`flex items-center justify-center w-12 h-12 rounded-full transition-colors cursor-pointer ${isWithinActiveStopRange ? 'bg-green-700 hover:bg-green-800 text-white' : 'bg-blue-100 hover:bg-blue-200 text-blue-600'}`}>{isWithinActiveStopRange ? <Crosshair className="w-6 h-6" /> : <Navigation className="w-6 h-6" />}</button>}</div>}</div></div>}
          <StopCardConfirmDialogs showDeleteConfirm={showDeleteConfirm} setShowDeleteConfirm={setShowDeleteConfirm} isPickup={isPickup} delivery={delivery} displayName={displayName} displayAddress={displayAddress} store={store} pendingPickups={pendingPickups} availableTransferPickups={availableTransferPickups} selectedTransferPickupId={selectedTransferPickupId} setSelectedTransferPickupId={setSelectedTransferPickupId} allDeliveries={allDeliveries} onDeleteDelivery={onDelete} />
          <StopCardReturnDialog showReturnConfirm={showReturnConfirm} returnPatient={returnPatient} handleCancelReturn={handleCancelReturn} handleConfirmReturn={handleConfirmReturn} isCreatingReturn={isCreatingReturn} store={store || stores.find((s) => s && s.id === delivery?.store_id)} delivery={delivery} driver={driver} patient={patient} />
          <StopCardPOD delivery={delivery} patient={patient} displayName={displayName} isNextDelivery={isNextDelivery} isFinishedDelivery={isFinishedDelivery} isPickup={isPickup} viewingImageUrl={viewingImageUrl} setViewingImageUrl={setViewingImageUrl} showSignatureCapture={showSignatureCapture} setShowSignatureCapture={setShowSignatureCapture} showPhotoCapture={showPhotoCapture} setShowPhotoCapture={setShowPhotoCapture} forceRefreshDriverDeliveries={forceRefreshDriverDeliveries} showButtons={false} currentUser={currentUser} />
          <FailureReasonDialog isOpen={showFailureReasonDialog} onClose={() => {setShowFailureReasonDialog(false);setPendingFailureStatus(null);}} onConfirm={async (reason) => {
            const status = pendingFailureStatus;
            const lockResult = await runWithDeliveryActionLock('failure_delivery', async () => {
            pauseOfflineSync('delivery_actions');
            try {
              setShowFailureReasonDialog(false);setPendingFailureStatus(null);setIsFailing(true);fabControlEvents.deactivateFAB();fabControlEvents.notifyPhaseTwoTempUnlock();smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);await collapseDriverStopCards();await new Promise((resolve) => setTimeout(resolve, 50));
              const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });if (!deliveryExists || deliveryExists.length === 0) {console.warn('⚠️ [FAILURE] Delivery no longer exists - aborting');toast.error('This delivery has been deleted. Please refresh the page.');return;}
              await syncDriverLocationToStop({ currentUser, delivery, patient, store, targetDriverId: delivery.driver_id });
              await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
              const existingNotes = delivery.delivery_notes || '';const updatedNotes = existingNotes ? `${existingNotes}\n[${status.toUpperCase()}] ${reason}` : `[${status.toUpperCase()}] ${reason}`;
              const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);
              const useRetroactiveTiming = !shouldUseRegularTiming({
                deliveryDate: delivery?.delivery_date,
                todayDateString: localDeviceTodayStr,
                currentTimeString: localNowParts.time
              });
              console.warn('[StopCard] failure retro timing gate', {
                deliveryId: delivery?.id,
                status,
                useRetroactiveTiming,
                shouldUseRetroactiveStopTiming,
                isPastDeliveryDate,
                deliveryDate: delivery?.delivery_date,
                comparisonRouteDate: comparisonRouteDateStr,
                selectedRouteDate: selectedRouteDateStr,
                selectedDateSource: selectedDateSourceStr,
                todayDateString: edmontonTodayStr,
                edmontonTime: edmontonNowParts.time
              });
              const retroactiveTiming = useRetroactiveTiming ? await calculateRetroactiveStopTiming({
                delivery,
                allDeliveries,
                patients,
                stores,
                todayDateString: localDeviceTodayStr,
                allowSameDay: true
              }) : null;
              const pendingBreadcrumbsString = await getPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers });
              const forcedFailureTimestamp = useRetroactiveTiming ? (retroactiveTiming?.actual_delivery_time || localTimeString) : localTimeString;
              const forcedFailureArrivalTimestamp = useRetroactiveTiming ? (retroactiveTiming?.arrival_time || forcedFailureTimestamp) : (delivery.arrival_time || localTimeString);
              const existingArrivalDate = parseLocalTimestamp(delivery.arrival_time);
              const retroactiveArrivalDate = parseLocalTimestamp(forcedFailureArrivalTimestamp);
              const arrivalVsRetroArrivalDiffMinutes = existingArrivalDate && retroactiveArrivalDate ? Math.abs(retroactiveArrivalDate.getTime() - existingArrivalDate.getTime()) / 60000 : 0;
              const shouldAutoSetArrivalTime = (useRetroactiveTiming && !!retroactiveArrivalDate && (!existingArrivalDate || arrivalVsRetroArrivalDiffMinutes > 5)) || (!useRetroactiveTiming && !delivery.arrival_time);
              const criticalUpdate = {
                status: status,
                delivery_notes: updatedNotes,
                actual_delivery_time: forcedFailureTimestamp,
                finished_leg_transport_mode: delivery?.finished_leg_transport_mode || 'driving',
                isNextDelivery: false,
                PolylineUpdated: true,
                ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}),
                ...(shouldAutoSetArrivalTime ? { arrival_time: forcedFailureArrivalTimestamp } : {}),
                ...(typeof retroactiveTiming?.travel_dist === 'number' ? { travel_dist: retroactiveTiming.travel_dist } : {})
              };
              const shouldDeleteSquareCodBeforeFailure = Number(delivery?.cod_total_amount_required || 0) > 0;
              console.warn('[Retro][failure] timing comparison', {
                deliveryId: delivery.id,
                useRetroactiveTiming,
                retroActual: retroactiveTiming?.actual_delivery_time || null,
                retroArrival: retroactiveTiming?.arrival_time || null,
                finalActual: criticalUpdate?.actual_delivery_time || null,
                finalArrival: criticalUpdate?.arrival_time || null
              });
              if (shouldDeleteSquareCodBeforeFailure) {
                await deleteCODWithTimeout(delivery.id, `Deleted before marking as ${status}`);
              }
              // CRITICAL: Also clear isNextDelivery on all other route deliveries immediately in offline DB
              const { offlineDB: _failOfflineDB } = await import('../utils/offlineDatabase');
              const failRouteDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
              const clearFailNextFlags = failRouteDeliveries.filter((d) => d && d.id !== delivery.id && d.isNextDelivery === true).map((d) => _failOfflineDB.bulkSave(_failOfflineDB.STORES.DELIVERIES, [{ ...d, isNextDelivery: false }]));
              try {
                await Promise.allSettled([
                updateDeliveryLocal(delivery.id, criticalUpdate, { skipSmartRefresh: true }),
                ...clearFailNextFlags]
                );
                if (onStatusUpdate) await onStatusUpdate(delivery.id, status, criticalUpdate, false);
                if (pendingBreadcrumbsString) await clearPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers, force: true });
                runTerminalDeliverySideEffects({ delivery, previousStatus: delivery.status, nextStatus: status, overrides: criticalUpdate });
                // Background: generate polyline and patch it in after critical save
                Promise.resolve().then(async () => {
                  try {
                    const finishedLegEncodedPolyline = await getFinishedLegEncodedPolyline({ delivery, allDeliveries, driver: safeDriver, patient, store, patients, stores, finishedStatuses: FINISHED_STATUSES, breadcrumbPayload: pendingBreadcrumbsString });
                    if (finishedLegEncodedPolyline) await updateDeliveryLocal(delivery.id, { finished_leg_encoded_polyline: finishedLegEncodedPolyline, finished_leg_transport_mode: delivery?.finished_leg_transport_mode || 'driving', PolylineUpdated: true }, { skipSmartRefresh: true });
                  } catch (_) {}
                });
              } catch (statusError) {console.error('❌ [FAILURE] Update failed:', statusError);toast.error(`Failed to update status: ${statusError.message}`);fabControlEvents.reactivateFAB(true);return;}
              const allDriverDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
              const incompleteAfterThis = allDriverDeliveries.filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending');
              const shouldRecalculateFailureEtas = shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, criticalUpdate.actual_delivery_time);
              if (incompleteAfterThis.length === 0) {
                fabControlEvents.notifyDoneButtonClicked();window.dispatchEvent(new CustomEvent('showRouteSummary', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
                if (currentUser?.id) {await setDriverStatus({ newStatus: 'off_duty' });locationTracker.stopTracking();if (onDriverStatusChange) onDriverStatusChange('off_duty');}
              }
              window.dispatchEvent(new CustomEvent('deliveryStatusChanged', { detail: { triggeredBy: status, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, maxStops: 5 } }));
              const driverDeliveries = allDriverDeliveries.map((item) => item.id === delivery.id ? { ...item, ...criticalUpdate, isNextDelivery: false } : item);
              const incompleteDeliveries = driverDeliveries.filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending').sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
              await collapseAndCenterNextDelivery({ driverDeliveries, targetDeliveryId: incompleteDeliveries[0]?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
              if (shouldRecalculateFailureEtas && incompleteDeliveries.length > 0) {
                Promise.resolve().then(() => base44.functions.invoke('optimizeRouteRealTime', {
                  driverId: delivery.driver_id,
                  deliveryDate: delivery.delivery_date,
                  currentLocalTime: getCurrentLocalTimeString(),
                  generatePolyline: false
                }).catch((error) => console.warn('⚠️ [Failure] ETA refresh skipped:', error?.message || error)));
              }
              onClick?.(null);
              fabControlEvents.notifyPhaseTwoCompleteRecenter();
              if (userHasRole(currentUser, 'driver')) await notifyDriverFailed({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery: { ...delivery, delivery_notes: updatedNotes }, store, appUsers, failureReason: reason });
              toast.success(`${isPickup ? 'Pickup' : 'Delivery'} marked as ${status}`, { description: `Dispatch has been notified. Reason: ${reason}` });
            } catch (error) {console.error('❌ [FAILURE] Error:', error);toast.error(`Failed to mark as ${status}: ${error.message}`);} finally
            {resumeOfflineSync('delivery_actions');resetActionLocks(true);}
            });
            if (lockResult?.skipped) return;
          }} deliveryName={displayName} isPickup={isPickup} statusType={pendingFailureStatus} />
          {showBodySection && <StopCardBody isExpanded={isExpanded} isStrippedForDispatcher={isStrippedForDispatcher} finalDisplayPhone={finalDisplayPhone} isFinishedDelivery={isFinishedDelivery} isPickup={isPickup} hasCODRequired={hasCODRequired} codTotalRequired={codTotalRequired} codPayments={codPayments} setCodPayments={setCodPayments} showCODCollection={showCODCollection} setShowCODCollection={setShowCODCollection} handleAddCODPayment={handleAddCODPayment} isStrippedForDriver={isStrippedForDriver} currentUser={currentUser} codTotalCollected={codTotalCollected} isCODComplete={isCODComplete} delivery={delivery} patient={patient} store={store} patients={patients} pendingPickups={pendingPickups} canAccessAcceptButtons={canAccessAcceptButtons} isAcceptingAll={isAcceptingAll} acceptButtonText={acceptButtonText} handleAcceptAllStops={handleAcceptAllStops} onEdit={onEdit} onCODUpdate={onCODUpdate} allDeliveries={allDeliveries} FINISHED_STATUSES={FINISHED_STATUSES} forceRefreshDriverDeliveries={forceRefreshDriverDeliveries} isCompleting={isCompleting} setIsCompleting={setIsCompleting} onSelectionChange={onSelectionChange} onClick={onClick} notesInput={notesInput} setNotesInput={setNotesInput} onNotesUpdate={onNotesUpdate} isCompleted={isCompleted} userHasRole={userHasRole} Textarea={Textarea} isAppOwnerFn={isAppOwner} isPastDate={isPastDeliveryDate} />}
          {(() => {if (shouldCondenseCompletedRouteForDriver) return null;if (isStrippedForDriver && !isAppOwner(currentUser) && !userHasRole(currentUser, 'admin')) {const hasRetryButton = delivery.status === 'failed' && canRetry && !hasFutureRetry && !hasCompletedDelivery;const hasReturnButton = delivery.status === 'failed' && !isPickup && !hasFutureReturn && !hasCompletedDelivery;if (!hasRetryButton && !hasReturnButton && !isExpanded) return null;}if (isDispatcherCenteredCard && !isExpanded) return null;if (!isAppOwner(currentUser) && !userHasRole(currentUser, 'admin') && isStrippedForDispatcher) return null;const shouldShowFooter = isExpanded ? true : isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || !(isFinishedDelivery && routeCompletedForLayout && (isPickup || delivery.status === 'failed' || delivery.status === 'cancelled')) && (!isFinishedDelivery || isRailCentered || isFinishedDelivery && !routeCompletedForLayout);if (isExpanded) return shouldShowFooter || isFinishedDelivery;return (isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || isAssignedDriverOrAppOwner) && shouldShowFooter;})() && <div className={shouldAnchorExpandedCard ? 'sticky bottom-0 z-10' : ''} style={shouldAnchorExpandedCard ? { background: 'var(--bg-white)' } : undefined}><div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}><div className={`mx-1 flex justify-between items-center ${showCenteredIncompleteCollapsed ? 'mt-1 mb-0' : 'my-1'}`}>{(isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || isAssignedDriverOrAppOwner || canEdit) && <>{delivery.status === 'failed' && !isPickup ? <div className="flex items-center gap-2 w-full relative z-20">{onStatusUpdate && <Button data-stopcard-action="retry" type="button" onPointerDownCapture={handleRetryDelivery} onPointerDown={blockCardToggle} onMouseDown={blockCardToggle} onTouchStart={blockCardToggle} onClick={blockCardToggle} size="sm" className="bg-blue-600 hover:bg-blue-700 h-10 !text-white text-sm flex-1 relative z-30 pointer-events-auto" disabled={isRetrying || isProcessingBackground || !canRetry || hasFutureRetry || hasCompletedDelivery || shouldDisableRetryReturn || isFailing}>{isRetrying || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}<span className="text-white">Retry</span></Button>}<Button data-stopcard-action="return" type="button" onPointerDownCapture={handleReturnClick} onPointerDown={blockCardToggle} onMouseDown={blockCardToggle} onTouchStart={blockCardToggle} onClick={(e) => { e.preventDefault(); e.stopPropagation(); }} size="sm" className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow rounded-md px-4 text-sm bg-orange-600 hover:bg-orange-700 !text-white h-10 flex-1 relative z-30 pointer-events-auto" disabled={isPreparingReturn || isCreatingReturn || hasFutureReturn || hasCompletedDelivery || shouldDisableRetryReturn || isFailing}>{isPreparingReturn ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Undo2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}Return</Button><div className="flex items-center ml-auto">{onRestart && ['completed', 'failed', 'cancelled'].includes(delivery.status) && !routeCompleted && !isPastDeliveryDate && <Button onClick={async (e) => {e.stopPropagation();await restartCurrentDelivery(false);}} size="sm" className="bg-[#ff0000] text-primary-foreground px-3 text-sm font-medium rounded-r-none inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" disabled={isRestarting || isProcessingBackground || isFailing}>{isRestarting || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}<span className="text-white">Restart</span></Button>}<DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 border border-slate-300 hover:bg-slate-100 relative z-[10]" onClick={(e) => e.stopPropagation()}><MoreVertical className="w-5 h-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="p-1 rounded-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-[8rem] overflow-hidden border-2 shadow-md z-[9999]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>{onEdit && !isStrippedForDispatcher && (isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) && <DropdownMenuItem onClick={(e) => {blockCardToggle(e);e.stopPropagation();onEdit(delivery);}} className="text-base py-2.5 md:py-1.5"><Edit className="w-5 h-5 mr-2" />Edit Delivery</DropdownMenuItem>}{(isNextDelivery || isFinishedDelivery) && !isPickup && patient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && <DropdownMenuItem onClick={(e) => {blockCardToggle(e);handleUpdateGPS(e);}} className="text-base py-2.5 md:py-1.5"><Locate className="w-5 h-5 mr-2" />Update GPS</DropdownMenuItem>}{onDelete && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && <><DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} /><DropdownMenuItem onClick={(e) => {blockCardToggle(e);e.stopPropagation();setShowDeleteConfirm(true);}} className="text-red-600 text-base py-2.5 md:py-1.5" disabled={!userHasRole(currentUser, 'admin') && isRouteCompleted}><Trash2 className="w-5 h-5 mr-2" />Delete</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu></div></div> : <><StopCardPOD delivery={delivery} patient={patient} displayName={displayName} isNextDelivery={isNextDelivery} isFinishedDelivery={isFinishedDelivery} isPickup={isPickup} viewingImageUrl={viewingImageUrl} setViewingImageUrl={setViewingImageUrl} showSignatureCapture={showSignatureCapture} setShowSignatureCapture={setShowSignatureCapture} showPhotoCapture={showPhotoCapture} setShowPhotoCapture={setShowPhotoCapture} forceRefreshDriverDeliveries={forceRefreshDriverDeliveries} currentUser={currentUser} /><div className="flex items-center ml-auto">{delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && (isNextDelivery ? <Button data-stopcard-action="complete" type="button" onClickCapture={blockCardToggle} onPointerDownCapture={async (e) => {
                        blockCardToggle(e);
                        if (completeTapLockRef.current || isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked) return;completeTapLockRef.current = true;console.warn('[Complete] shared click handler entered', { deliveryId: delivery?.id, deliveryDate: delivery?.delivery_date, isPastDeliveryDate, isCompleting, isProcessingBackground, isFailing, isStarting, isRetrying, isRestarting, isGlobalCompleteLocked, isGlobalRestartLocked, isSelectedAtClick: isSelected });const lockResult = await runWithDeliveryActionLock('complete_delivery', async () => {pauseOfflineSync('delivery_actions');fabControlEvents.deactivateFAB();fabControlEvents.notifyPhaseTwoTempUnlock();setIsCompleting(true);setIsProcessingBackground(true);const { driverLocationPoller } = await import('../utils/driverLocationPoller');driverLocationPoller.pause();smartRefreshManager.pause();smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
                        try {
                          const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });if (!deliveryExists || deliveryExists.length === 0) {console.warn('⚠️ [COMPLETE] Delivery no longer exists - aborting');toast.error('This delivery has been deleted. Please refresh the page.');return;}
                          await ensureDriverOnline();
                          await syncDriverLocationToStop({ currentUser, delivery, patient, store, targetDriverId: delivery.driver_id });
                          const autoCODPayment = hasCODRequired && codPayments.length === 0 && onCODUpdate ? [{ type: 'Cash', amount: codTotalRequired }] : null;if (autoCODPayment) setCodPayments(autoCODPayment);
                          let pendingBreadcrumbsString = null;
                          try {pendingBreadcrumbsString = await getPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers });} catch (breadcrumbErr) {console.warn('⚠️ [COMPLETE] Breadcrumb fetch failed, continuing without:', breadcrumbErr.message);}
                          const hasPendingPickupTransitions = isPickup && pendingPickups && pendingPickups.some((p) => p.status === 'pending');
                          if (hasPendingPickupTransitions) {
                            await executeAcceptAllStops();
                            await waitForRouteTransitionSettle(pendingPickups?.length || 0);
                          }
                          const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);
                          const useRetroactiveTiming = !shouldUseRegularTiming({
                            deliveryDate: delivery?.delivery_date,
                            todayDateString: localDeviceTodayStr,
                            currentTimeString: localNowParts.time
                          });
                          console.warn('[StopCard] complete retro timing gate', { deliveryId: delivery?.id, useRetroactiveTiming, isPickup, isPastDeliveryDate, deliveryDate: delivery?.delivery_date, comparisonRouteDate: comparisonRouteDateStr, selectedRouteDate: selectedRouteDateStr, selectedDateSource: selectedDateSourceStr, todayDateString: localDeviceTodayStr, edmontonTime: edmontonNowParts.time });
                          const retroactiveTiming = useRetroactiveTiming ? await calculateRetroactiveStopTiming({ delivery, allDeliveries, patients, stores, todayDateString: localDeviceTodayStr, allowSameDay: true }) : null;const completionCodPayments = autoCODPayment || codPayments;const sameRouteDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
                          const forcedCompletionTimestamp = useRetroactiveTiming ? (retroactiveTiming?.actual_delivery_time || localTimeString) : localTimeString;
                          const forcedArrivalTimestamp = useRetroactiveTiming ? (retroactiveTiming?.arrival_time || delivery.arrival_time || localTimeString) : (delivery.arrival_time || localTimeString);
                          const existingArrivalDate = parseLocalTimestamp(delivery.arrival_time);
                          const retroactiveArrivalDate = parseLocalTimestamp(forcedArrivalTimestamp);
                          const arrivalVsRetroArrivalDiffMinutes = existingArrivalDate && retroactiveArrivalDate ? Math.abs(retroactiveArrivalDate.getTime() - existingArrivalDate.getTime()) / 60000 : 0;
                          const shouldOverwriteArrivalTime = useRetroactiveTiming ? !!forcedArrivalTimestamp : !delivery.arrival_time;
                          const patientSavedSignatureUrl = patient?.signature_image_url || patient?.saved_signature_image_url || null;
                          const fallbackSignatureUrl = patientSavedSignatureUrl || null;
                          const completionUpdate = { status: 'completed', actual_delivery_time: forcedCompletionTimestamp || localTimeString, finished_leg_transport_mode: delivery?.finished_leg_transport_mode || 'driving', isNextDelivery: false, finished_leg_encoded_polyline: null, PolylineUpdated: true, ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}), ...(completionCodPayments.length > 0 ? { cod_payments: completionCodPayments } : {}), ...(fallbackSignatureUrl ? { signature_image_url: fallbackSignatureUrl } : {}), ...(shouldOverwriteArrivalTime && forcedArrivalTimestamp ? { arrival_time: forcedArrivalTimestamp } : {}), ...(typeof retroactiveTiming?.travel_dist === 'number' ? { travel_dist: retroactiveTiming.travel_dist } : {}) };
                          const shouldDeleteSquareCodBeforeComplete = Number(delivery?.cod_total_amount_required || 0) > 0 && hasDebitOrCreditCod(delivery, completionCodPayments);
                          const shouldRecalculateCompletionEtas = shouldRefreshRemainingEtas(delivery?.delivery_time_eta || delivery?.delivery_time_start, completionUpdate.actual_delivery_time);
                          console.warn('[StopCard][complete] timing before save', {
                            deliveryId: delivery.id,
                            existingDelivery: delivery,
                            completionUpdate,
                            forcedCompletionTimestamp,
                            forcedArrivalTimestamp,
                            shouldOverwriteArrivalTime,
                            retroactiveTiming
                          });
                          console.warn('[Retro][complete] timing comparison', {
                            deliveryId: delivery.id,
                            useRetroactiveTiming,
                            retroActual: retroactiveTiming?.actual_delivery_time || null,
                            retroArrival: retroactiveTiming?.arrival_time || null,
                            finalActual: completionUpdate?.actual_delivery_time || null,
                            finalArrival: completionUpdate?.arrival_time || null
                          });
                          if (shouldDeleteSquareCodBeforeComplete) {
                            await deleteCODWithTimeout(delivery.id, 'Deleted after card COD completion');
                          }
                          const { offlineDB: _offlineDB } = await import('../utils/offlineDatabase');
                          const clearNextFlags = sameRouteDeliveries.filter((d) => d && d.id !== delivery.id && d.isNextDelivery === true).map((d) => _offlineDB.bulkSave(_offlineDB.STORES.DELIVERIES, [{ ...d, isNextDelivery: false }]));
                          if (isExpanded) {
                            await collapseDriverStopCards();
                          }
                          const saveResults = await Promise.all([
                          updateDeliveryLocal(delivery.id, completionUpdate, { skipSmartRefresh: true }),
                          ...clearNextFlags]
                          );
                          if (fallbackSignatureUrl && patient?.id) {
                            try {
                              const { updatePatientLocal } = await import('../utils/offlineMutations');
                              await updatePatientLocal(patient.id, { signature_image_url: fallbackSignatureUrl });
                            } catch (_) {}
                          }
                          if (pendingBreadcrumbsString) {try {await clearPendingBreadcrumbsForDelivery({ driverUserId: delivery.driver_id, deliveryId: delivery.id, stopOrder: delivery.stop_order, appUsers, force: true });} catch (_) {}}
                          runTerminalDeliverySideEffects({ delivery, previousStatus: delivery.status, nextStatus: 'completed', overrides: completionUpdate });
                          const optimisticDeliveries = allDeliveries.map((d) => {if (!d || d.driver_id !== delivery.driver_id || d.delivery_date !== delivery.delivery_date) return d;if (d.id === delivery.id) return { ...d, ...completionUpdate, isNextDelivery: false };return d;});
                          const routeDeliveries = optimisticDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);const incompleteDeliveries = routeDeliveries.filter((d) => d && d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending').sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));const nextStop = incompleteDeliveries[0] || null;
                          await collapseAndCenterNextDelivery({ driverDeliveries: routeDeliveries, targetDeliveryId: nextStop?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
                          if (!nextStop) {fabControlEvents.notifyDoneButtonClicked();window.dispatchEvent(new CustomEvent('showRouteSummary', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));try {await setDriverStatus({ newStatus: 'off_duty' });locationTracker.stopTracking();} catch (trackingError) {console.warn('Could not stop location tracking:', trackingError.message);}if (onDriverStatusChange) onDriverStatusChange('off_duty');}
                          fabControlEvents.notifyPhaseTwoCompleteRecenter();fabControlEvents.reactivateFAB(true, { suppressIfPhase1: true, reason: 'stop_status_change' });
                          const backgroundTasks = [];
                          if (autoCODPayment && onCODUpdate) backgroundTasks.push(onCODUpdate(delivery.id, autoCODPayment, true));
                          if (shouldRecalculateCompletionEtas && nextStop) {
                            backgroundTasks.push(
                              base44.functions.invoke('optimizeRouteRealTime', {
                                driverId: delivery.driver_id,
                                deliveryDate: delivery.delivery_date,
                                currentLocalTime: getCurrentLocalTimeString(),
                                generatePolyline: false
                              }).catch((error) => console.warn('⚠️ [Complete] ETA refresh skipped:', error?.message || error))
                            );
                          }
                          backgroundTasks.push(cleanupSquareCodCatalogForDate(delivery.delivery_date));
                          const currentDriverAppUserId = currentDriverAppUser?.id || null;
                          backgroundTasks.push(scheduleCompletionSideEffects({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, nextDeliveryId: nextStop?.id || null, lastCompletedDeliveryId: delivery.id, setOffDuty: !nextStop, appUserId: currentDriverAppUserId }));
                          backgroundTasks.push(userHasRole(currentUser, 'driver') ? notifyDriverCompleted({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers }) : Promise.resolve());
                          await Promise.allSettled(backgroundTasks);
                        } catch (error) {console.error('❌ [COMPLETE] Error:', error);toast.error(`Failed to complete: ${error.message}`);throw error;} finally {
                          resumeOfflineSync('delivery_actions');
                          driverLocationPoller?.resume?.();
                          smartRefreshManager.resume();
                          resetActionLocks(true);
                        }
                      });if (lockResult?.skipped) return;}} onPointerDown={(e) => {e.preventDefault();e.stopPropagation();}} onMouseDown={(e) => {e.preventDefault();e.stopPropagation();}} onTouchStart={(e) => {e.preventDefault();e.stopPropagation();}} onClick={(e) => {e.preventDefault();e.stopPropagation();}} size="sm" disabled={isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked} className={`rounded-md px-4 text-sm font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow h-10 border-r !text-white ${isFailing ? 'bg-red-600 hover:bg-red-700 border-red-500' : 'bg-emerald-600 hover:bg-emerald-700 border-emerald-500'}`}>{isCompleting || isProcessingBackground || isFailing || isGlobalCompleteLocked || isGlobalRestartLocked ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <CheckCircle className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}<span className="text-white">Complete</span></Button> : onStartDelivery && <Button data-stopcard-action="start" type="button" onPointerDownCapture={handleStartAction} onPointerDown={(e) => {e.preventDefault();e.stopPropagation();}} onMouseDown={(e) => {e.preventDefault();e.stopPropagation();}} onTouchStart={(e) => {e.preventDefault();e.stopPropagation();}} onClick={(e) => {e.preventDefault();e.stopPropagation();}} size="sm" disabled={isCurrentCardStartLocked || isProcessingBackground || isCompleting || isFailing || isRetrying || isRestarting} className="bg-blue-600 px-4 text-sm font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" title="Start this delivery">{isCurrentCardStartLocked ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Clock className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}<span className="text-white">Start</span></Button>)}{delivery.status !== 'failed' && ['completed', 'cancelled'].includes(delivery.status) && onRestart && !routeCompleted && <Button data-stopcard-action="restart" type="button" onPointerDownCapture={async (e) => {blockCardToggle(e);if (isRestarting || isProcessingBackground || isFailing) return;await restartCurrentDelivery(false);}} onPointerDown={blockCardToggle} onMouseDown={blockCardToggle} onTouchStart={blockCardToggle} onClick={blockCardToggle} size="sm" className="bg-[#ff0000] text-primary-foreground px-3 text-sm font-medium rounded-r-none inline-flex min-h-11 min-w-11 items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" disabled={isRestarting || isProcessingBackground || isFailing}>{isRestarting || isProcessingBackground || isFailing ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}<span className="text-white">Restart</span></Button>}<DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 border border-slate-300 hover:bg-slate-100 relative z-[10]" onClick={(e) => e.stopPropagation()}><MoreVertical className="w-5 h-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="p-1 rounded-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-[8rem] overflow-hidden border-2 shadow-md z-[9999]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>{onEdit && !isStrippedForDispatcher && (isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id && !routeCompleted) && <DropdownMenuItem onClick={(e) => {blockCardToggle(e);e.stopPropagation();onEdit(delivery);}} className="text-base py-2.5 md:py-1.5"><Edit className="w-5 h-5 mr-2" />{isPickup ? 'Edit Pickup' : 'Edit Delivery'}</DropdownMenuItem>}{onEditPatient && patient && !isPickup && !isStrippedForDispatcher && isAppOwner(currentUser) && <DropdownMenuItem onClick={(e) => {blockCardToggle(e);e.stopPropagation();onEditPatient(patient);}} className="text-base py-2.5 md:py-1.5"><User className="w-5 h-5 mr-2" />Edit Patient</DropdownMenuItem>}{(isNextDelivery || isFinishedDelivery) && !isPickup && patient && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && <DropdownMenuItem onClick={(e) => {blockCardToggle(e);handleUpdateGPS(e);}} className="text-base py-2.5 md:py-1.5"><Locate className="w-5 h-5 mr-2" />Update GPS</DropdownMenuItem>}{delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && isNextDelivery && onStatusUpdate && <><DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} /><DropdownMenuItem onClick={(e) => {blockCardToggle(e);e.stopPropagation();setPendingFailureStatus(isPickup ? 'cancelled' : 'failed');setShowFailureReasonDialog(true);}} className="text-red-600 text-base py-2.5 md:py-1.5"><XCircle className="w-5 h-5 mr-2" />{isPickup ? 'Cancel Pickup' : 'Mark as Failed'}</DropdownMenuItem></>}{onDelete && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) && (onEdit || !isPickup && patient && onEditPatient || isCompleted && onRestart && delivery.delivery_date === format(new Date(), 'yyyy-MM-dd')) && <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />}{onDelete && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) && <DropdownMenuItem onClick={(e) => {blockCardToggle(e);e.stopPropagation();setShowDeleteConfirm(true);}} className="text-red-600 text-base py-2.5 md:py-1.5" disabled={false}><Trash2 className="w-5 h-5 mr-2" />Delete</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu></div></>}</>}</div></div></div>}
        </CardContent>
      </Card>
    </motion.div>);
}