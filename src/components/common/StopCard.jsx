import { isRouteCompleted } from '@/components/utils/routeCompletionChecker';import { motion } from 'framer-motion';
import React, { useState, useRef, useEffect, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Phone, MapPin, Edit, Trash2, StickyNote, RotateCcw, MoreVertical, User, CheckCircle, Clock, Package, XCircle, Info, FileText, Save, X, Plus, Undo2, Loader2, Navigation, GripVertical, Bell, BellOff, Mailbox, Locate } from "lucide-react";
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
import { getStoreColor, hexToRgba, getContrastColor } from "../utils/colorGenerator";
import { format, isBefore, startOfDay, addDays } from "date-fns";
import { getDriverDisplayName } from '../utils/driverUtils';
import { userHasRole, shouldShowStoreBadges, isAppOwner } from '../utils/userRoles';
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { isMobileDevice } from '../utils/deviceUtils';
import { getCurrentDevice } from '../utils/deviceManager';
import { formatAddressWithUnit, cleanBuzzerFromAddress } from '../utils/addressCleaner';
import { calculateDeliveryPay, formatPay } from '../utils/payCalculator';
import { base44 } from "@/api/base44Client";
import { locationTracker } from "../utils/locationTracker";
import { useAppData } from "../utils/AppDataContext";
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
import { generateCompletionTimestamp } from '../utils/timeRoundingHelper';
import { generateUniqueSID } from '../dashboard/DashboardHelpers';
import { recalculateAndUpdateStopOrders } from '../utils/stopOrderManager';
import StopCardCODCollection from './StopCardCODCollection';
import StopCardConfirmDialogs from './StopCardConfirmDialogs';
import StopCardPOD from './StopCardPOD';
import { useDeliveryDisplayInfo } from './StopCardRedaction';
import { updatePatientGPS } from "../utils/patientGPSUpdater";
import { buildRetryDelivery, getCurrentLocalTimeString, getDriverRouteDeliveries, getFinishedLegEncodedPolyline, getNextActiveDelivery, getNextTrackingNumberInGroup, incrementTrackingNumber, refreshDriverRoute, setAndCenterNextDelivery, verifyDeliveryStillExists, withPausedDriverLocationPoller } from "./stopCardActionHelpers";
import { clearPendingBreadcrumbsForDriver, getPendingBreadcrumbsForDriver } from '../utils/pendingBreadcrumbsManager';
import { runTerminalDeliverySideEffects } from '../utils/directDeliverySideEffects';
const statusConfig = { 'pending': { label: 'Pending', color: 'bg-slate-100 text-slate-800' }, 'in_transit': { label: 'In Transit', color: 'bg-blue-100 text-blue-800' }, 'en_route': { label: 'En Route', color: 'bg-cyan-100 text-cyan-800' }, 'next': { label: 'Next', color: 'bg-lime-100 text-lime-800' }, 'completed': { label: 'Complete', color: 'bg-emerald-100 text-emerald-800' }, 'delivered': { label: 'Complete', color: 'bg-emerald-100 text-emerald-800' }, 'failed': { label: 'Failed', color: 'bg-red-100 text-red-800' }, 'cancelled': { label: 'Cancelled', color: 'bg-red-100 text-red-800' }, 'returned': { label: 'Return', color: 'bg-orange-100 text-orange-800' } };
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];
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
  const [notesInput, setNotesInput] = useState(delivery?.delivery_notes || "No driver notes");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [codPayments, setCodPayments] = useState(delivery?.cod_payments || []);
  const [showCODCollection, setShowCODCollection] = useState(false);
  const [showReturnConfirm, setShowReturnConfirm] = useState(false);const [isCreatingReturn, setIsCreatingReturn] = useState(false);
  const [returnPatient, setReturnPatient] = useState(null);const [isStarting, setIsStarting] = useState(false);const [isCompleting, setIsCompleting] = useState(false);const [isRetrying, setIsRetrying] = useState(false);const [isPreparingReturn, setIsPreparingReturn] = useState(false);const [isProcessingBackground, setIsProcessingBackground] = useState(false);const [isAcceptingAll, setIsAcceptingAll] = useState(false);const [acceptingIndividual, setAcceptingIndividual] = useState({});
  const { setIsEntityUpdating, forceRefreshDriverDeliveries, refreshData, updateDeliveriesLocally } = useAppData();
  const [showSignatureCapture, setShowSignatureCapture] = useState(false);const [showPhotoCapture, setShowPhotoCapture] = useState(false);const [viewingImageUrl, setViewingImageUrl] = useState(null);const [selectedTransferPickupId, setSelectedTransferPickupId] = useState('');const [isHovered, setIsHovered] = useState(false);const [showFailureReasonDialog, setShowFailureReasonDialog] = useState(false);const [pendingFailureStatus, setPendingFailureStatus] = useState(null);const [isFailing, setIsFailing] = useState(false);const [isRestarting, setIsRestarting] = useState(false);const [isPrimaryDevice, setIsPrimaryDevice] = useState(true);
  const startTapLockRef = useRef(false);const codAmountInputRefs = useRef([]);
  const isStrippedForDriver = useMemo(() => {if (!currentUser || !delivery) return false;if (userHasRole(currentUser, 'admin')) return false;if (userHasRole(currentUser, 'driver')) return delivery._isStripped === true;return false;}, [delivery?._isStripped, currentUser]);
  const isStrippedForDispatcher = useMemo(() => {if (!currentUser || !delivery) return false;if (!userHasRole(currentUser, 'dispatcher')) return false;if (userHasRole(currentUser, 'admin')) return false;const dispatcherStoreIds = currentUser.store_ids || [];return !dispatcherStoreIds.includes(delivery.store_id);}, [delivery?.store_id, currentUser]);
  const isStrippedDelivery = isStrippedForDriver || isStrippedForDispatcher;
  const ensureDriverOnline = async () => {
    if (!currentUser?.id) return;
    try {
      const { offlineDB } = await import('../utils/offlineDatabase');
      let appUserData = await offlineDB.getAll(offlineDB.STORES.APP_USERS);let appUser = appUserData?.find((au) => au.user_id === currentUser.id);
      if (!appUser) {
        const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });appUser = appUsers?.[0];
        if (appUsers && appUsers.length > 0) await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
      }
      if (appUser && appUser.driver_status !== 'on_duty') {
        await base44.entities.AppUser.update(appUser.id, { driver_status: 'on_duty', location_tracking_enabled: true });
        try {await locationTracker.startTracking({ ...currentUser, appUserId: appUser.id });} catch (trackingError) {console.warn('Could not start location tracking:', trackingError.message);}
        if (onDriverStatusChange) onDriverStatusChange('on_duty');
      }
    } catch (error) {console.error('Failed to auto-toggle driver online:', error);}
  };
  const isFinishedDelivery = FINISHED_STATUSES.includes(delivery?.status);const isExpanded = isStrippedForDispatcher ? false : compact ? false : isSelected;
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
  const patient = useMemo(() => {if (!delivery?.patient_id || !patients || patients.length === 0) return null;return patients.find((p) => p && (p.id === delivery.patient_id || p.patient_id === delivery.patient_id));}, [delivery?.patient_id, patients]);
  const isPickup = useMemo(() => {if (!delivery) return false;return !delivery.patient_id && !!delivery.store_id;}, [delivery?.patient_id, delivery?.store_id]);
  const availableTransferPickups = useMemo(() => {if (!delivery || !isPickup) return [];return allDeliveries?.filter((d) => d && !d.patient_id && d.store_id === delivery.store_id && d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id && d.id !== delivery.id && d.status !== 'completed' && d.status !== 'cancelled') || [];}, [delivery, allDeliveries, isPickup]);
  useEffect(() => {if (showDeleteConfirm && isPickup && pendingPickups?.length > 0) {if (availableTransferPickups.length === 0) setSelectedTransferPickupId('delete_all');else if (availableTransferPickups.length >= 1) setSelectedTransferPickupId(availableTransferPickups[0].id);}}, [showDeleteConfirm, isPickup, pendingPickups, availableTransferPickups]);
  const isInterStorePickup = useMemo(() => {if (!delivery) return false;const patientName = (delivery.patient_name || '').toLowerCase();if (patientName.includes('interstore') || patientName.includes('inter-store') || patientName.includes('inter store')) return true;const deliveryNotes = (delivery.delivery_notes || '').toLowerCase();if (deliveryNotes.includes('interstore pickup') || deliveryNotes.includes('inter-store pickup') || deliveryNotes.includes('isp')) return true;return false;}, [delivery]);
  const canChangeDriver = useMemo(() => {if (!delivery || !currentUser || !onDriverChange) return false;if (isPickup) return false;if (FINISHED_STATUSES.includes(delivery.status)) return false;return userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher');}, [currentUser, delivery, onDriverChange, isPickup]);
  const patientDisplayAddress = useMemo(() => {if (isPickup || !patient) return '';return formatAddressWithUnit(patient.address, patient.unit_number);}, [patient, delivery?.unit_number, isPickup]);
  const safeDriver = useMemo(() => driver && typeof driver === 'object' ? driver : null, [driver]);
  const driverBadgeColor = useMemo(() => {if (getDriverColor && safeDriver) return getDriverColor(safeDriver);return '#64748b';}, [getDriverColor, safeDriver]);
  const driverBadgeTextColor = useMemo(() => getContrastColor(driverBadgeColor), [driverBadgeColor]);
  const codTotalCollected = useMemo(() => codPayments.reduce((sum, payment) => sum + (parseFloat(payment.amount) || 0), 0), [codPayments]);
  const codTotalRequired = useMemo(() => delivery?.cod_total_amount_required || 0, [delivery?.cod_total_amount_required]);const hasCODRequired = useMemo(() => codTotalRequired > 0, [codTotalRequired]);const isCODComplete = useMemo(() => codTotalCollected >= codTotalRequired, [codTotalCollected, codTotalRequired]);const isCompleted = useMemo(() => delivery ? FINISHED_STATUSES.includes(delivery.status) : false, [delivery?.status]);
  const isReturnDelivery = useMemo(() => {if (!delivery || isPickup) return false;const patientName = (patient?.full_name || '').toUpperCase();const deliveryNotes = (delivery.delivery_notes || '').toUpperCase();const patientNotes = (patient?.notes || '').toUpperCase();return patientName.includes('(RTN)') || deliveryNotes.includes('(RTN)') || patientNotes.includes('(RTN)');}, [delivery, patient, isPickup]);
  const isFirstDelivery = useMemo(() => {if (!delivery || isPickup) return false;if (patient && !patient.last_delivery_date) return true;if (delivery.delivery_notes?.toLowerCase().includes('first delivery')) return true;if (delivery.first_delivery === true) return true;return false;}, [delivery, patient, isPickup]);
  const storeColor = useMemo(() => store ? getStoreColor(store) : "#71717A", [store]);
  const routeCompleted = React.useMemo(() => isRouteCompleted(delivery, allDeliveries, FINISHED_STATUSES, new Date(), "America/Edmonton"), [delivery, allDeliveries]);
  const routeCompletedForLayout = React.useMemo(() => {if (!delivery || !Array.isArray(allDeliveries)) return false;const driverDeliveriesForDate = allDeliveries.filter((d) => {if (!d) return false;return d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id;});if (driverDeliveriesForDate.length === 0) return false;return driverDeliveriesForDate.every((d) => FINISHED_STATUSES.includes(d.status));}, [delivery, allDeliveries]);
  const edmontonTodayStr = React.useMemo(() => {const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}-${parts.find((p) => p.type === 'day')?.value}`;}, []);
  const isPastDeliveryDate = React.useMemo(() => !!delivery?.delivery_date && delivery.delivery_date < edmontonTodayStr, [delivery?.delivery_date, edmontonTodayStr]);
  const shouldCondenseCompletedRouteForDriver = userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') && routeCompletedForLayout && !isExpanded;
  const showCompletedRouteCenteredCondensed = shouldCondenseCompletedRouteForDriver;const showIncompleteRouteSideCondensed = !routeCompletedForLayout && !isExpanded && !isRailCentered;const showCenteredIncompleteCollapsed = !routeCompletedForLayout && !isExpanded && isRailCentered;const isDispatcherCenteredCard = userHasRole(currentUser, 'dispatcher') && isRailCentered;const hideBodyForDispatcherCenteredCard = isDispatcherCenteredCard && !isStrippedForDispatcher && !isExpanded;const showMiddleSection = !isStrippedForDriver && !isStrippedForDispatcher && !showIncompleteRouteSideCondensed && (!isFinishedDelivery || isExpanded || isRailCentered) && !showCompletedRouteCenteredCondensed && !(isFinishedDelivery && isExpanded && isPastDeliveryDate);const showBodySection = !showCompletedRouteCenteredCondensed && !showIncompleteRouteSideCondensed && !hideBodyForDispatcherCenteredCard;
  const isInterStore = useMemo(() => {if (!delivery) return false;const patientName = (patient?.full_name || '').toLowerCase();if (patientName.includes('interstore') || patientName.includes('inter-store') || patientName.includes('inter store')) return true;const patientNotes = (patient?.notes || '').toLowerCase();if (patientNotes.includes('interstore') || patientNotes.includes('inter-store') || patientNotes.includes('inter store')) return true;return false;}, [delivery, patient]);
  const shouldShowStoreBadge = useMemo(() => shouldShowStoreBadges(currentUser), [currentUser]);
  const { displayName, displayAddress, displayPhone, shouldRedact, finalDisplayName, finalDisplayAddress, finalDisplayPhone } = useDeliveryDisplayInfo({ delivery, patient, store, currentUser, isPickup, isInterStore, isInterStorePickup, isStrippedDelivery, isStrippedForDispatcher });
  const shouldDisableRetryReturn = useMemo(() => {if (delivery.status !== 'failed' || isPickup || !patient) return false;const patientDeliveries = allDeliveries.filter((d) => d && d.patient_id === delivery.patient_id && d.delivery_date === delivery.delivery_date);const totalDeliveries = patientDeliveries.length;const failedDeliveries = patientDeliveries.filter((d) => d.status === 'failed');if (totalDeliveries >= 3) {const maxFailedStopOrder = Math.max(...failedDeliveries.map((d) => d.stop_order || 0));return delivery.stop_order !== maxFailedStopOrder;}if (failedDeliveries.length === 2) {const otherFailed = failedDeliveries.find((d) => d.id !== delivery.id);if (otherFailed) return delivery.stop_order < otherFailed.stop_order;}if (patientDeliveries.some((d) => d.id !== delivery.id && d.status !== 'failed' && d.status !== 'cancelled')) return true;return false;}, [delivery, allDeliveries, patient, isPickup]);
  const { hasFutureRetry, hasFutureReturn, hasCompletedDelivery } = useMemo(() => {
    if (delivery.status !== 'failed' || isPickup || !patient) return { hasFutureRetry: false, hasFutureReturn: false, hasCompletedDelivery: false };
    const failedDate = startOfDay(new Date(delivery.delivery_date));const toDate = addDays(failedDate, 7);const failedPatientName = patient.full_name || '';const failedPatientNameNormalized = failedPatientName.trim().toLowerCase();
    let futureRetryExists = false;let futureReturnExists = false;let completedDeliveryExists = false;
    for (const d of allDeliveries) {
      if (!d || d.id === delivery.id) continue;
      let dDate;try {dDate = startOfDay(new Date(d.delivery_date));} catch (e) {continue;}
      if (dDate >= failedDate && dDate < toDate) {
        if (d.patient_id === delivery.patient_id && d.stop_id === delivery.stop_id && d.status !== 'failed') futureRetryExists = true;
        const matchedPatient = patients.find((p) => p && (p.id === d.patient_id || p.patient_id === d.patient_id));
        const deliveryPatientNameNormalized = (d.patient_name || matchedPatient?.full_name || '').trim().toLowerCase();
        const matchesSamePatient = d.patient_id === delivery.patient_id || !!failedPatientNameNormalized && deliveryPatientNameNormalized === failedPatientNameNormalized;
        if (d.delivery_date === delivery.delivery_date && matchesSamePatient && d.status === 'completed') completedDeliveryExists = true;
        const notesLower = (d.delivery_notes || '').toLowerCase();
        const patientNotesLower = (() => {const returnPatient = patients.find((p) => p && (p.id === d.patient_id || p.patient_id === d.patient_id));return (returnPatient?.notes || '').toLowerCase();})();
        const hasPatientReturnMarker = notesLower.includes('patient return') || patientNotesLower.includes('patient return');
        const hasFailedPatientName = d.patient_id === delivery.patient_id || !!failedPatientNameNormalized && ((d.patient_name || '').trim().toLowerCase() === failedPatientNameNormalized || notesLower.includes(failedPatientNameNormalized) || patientNotesLower.includes(failedPatientNameNormalized));
        const sidMatch = d.stop_id === delivery.stop_id;const sameDate = d.delivery_date === delivery.delivery_date;
        if (sameDate && (hasPatientReturnMarker && hasFailedPatientName || sidMatch && !d.patient_id)) futureReturnExists = true;
      }
      if (futureRetryExists && futureReturnExists && completedDeliveryExists) break;
    }
    return { hasFutureRetry: futureRetryExists, hasFutureReturn: futureReturnExists, hasCompletedDelivery: completedDeliveryExists };
  }, [delivery, allDeliveries, patient, isPickup, patients]);
  const canRetry = useMemo(() => {if (!delivery || delivery.status !== 'failed' || isPickup || !patient) return true;if (hasFutureReturn) return false;const hasLaterDelivery = allDeliveries.some((d) => {if (!d || d.id === delivery.id) return false;if (d.delivery_date !== delivery.delivery_date) return false;if (d.patient_id !== delivery.patient_id) return false;return (d.stop_order || 0) > (delivery.stop_order || 0);});return !hasLaterDelivery;}, [delivery, allDeliveries, patient, isPickup, hasFutureReturn]);
  const _isProjectedData = useMemo(() => delivery?.isProjected || false, [delivery?.isProjected]);
  const isAssignedDriverOrAppOwner = useMemo(() => {if (!currentUser || !delivery) return false;if (isAppOwner(currentUser)) return true;if (!userHasRole(currentUser, 'driver')) return false;return delivery.driver_id === currentUser.id;}, [currentUser, delivery]);
  const isAssignedDispatcher = useMemo(() => {if (!currentUser || !delivery) return false;if (!userHasRole(currentUser, 'dispatcher')) return false;const dispatcherStoreIds = currentUser.store_ids || [];return dispatcherStoreIds.includes(delivery.store_id);}, [currentUser, delivery]);
  const canAccessAcceptButtons = useMemo(() => {if (!currentUser || !delivery) return false;if (isAppOwner(currentUser) || userHasRole(currentUser, 'admin')) return true;if (isAssignedDispatcher) return true;if (userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id) return true;return false;}, [currentUser, delivery, isAssignedDispatcher]);
  const acceptButtonText = useMemo(() => {if (!currentUser || !delivery) return 'Assign All';const isAssignedDriver = delivery.driver_id === currentUser.id && userHasRole(currentUser, 'driver');if (isAssignedDriver) return 'Accept All';return 'Assign All';}, [currentUser, delivery?.driver_id]);
  const nextAvailableStatuses = useMemo(() => {if (!onStatusUpdate || !currentUser) return [];if (!isAssignedDriverOrAppOwner) return [];const canChangeStatus = userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver');if (!canChangeStatus) return [];if (FINISHED_STATUSES.includes(delivery.status)) return [];let statuses = [];if (isPickup) statuses = ['en_route', 'completed', 'cancelled'];else statuses = ['pending', 'in_transit', 'completed', 'failed'];return statuses.filter((s) => s !== delivery.status);}, [delivery?.status, onStatusUpdate, currentUser, isPickup, isAssignedDriverOrAppOwner]);
  const showStatusDropdown = useMemo(() => {if (isRouteCompleted) return false;return nextAvailableStatuses.length > 0;}, [isRouteCompleted, nextAvailableStatuses]);
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
      preferCrosshair: !isMobileDevice() && !isPrimaryDevice,
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
  const collapseAndCenterNextDelivery = async (args) => {if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('collapseAllStopCards'));return await setAndCenterNextDelivery(args);};
  const handleStartAction = async (e) => {
    e?.preventDefault?.();e?.stopPropagation?.();if (startTapLockRef.current || isStarting || isProcessingBackground) return;
    startTapLockRef.current = true;setIsStarting(true);setIsEntityUpdating(true);fabControlEvents.deactivateFAB();const { driverLocationPoller } = await import('../utils/driverLocationPoller');driverLocationPoller.pause();smartRefreshManager.pause();
    try {
      const now = new Date();const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const isValidObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);if (!isValidObjectId(delivery.id) || !isValidObjectId(delivery.driver_id)) throw new Error('This stop is still syncing. Please try again in a moment.');
      const routeDeliveries = getDriverRouteDeliveries(allDeliveries, delivery);
      const optimisticRouteDeliveries = routeDeliveries.map((d) => {if (!d) return d;const isCurrent = d.id === delivery.id;return { ...d, isNextDelivery: isCurrent, ...(isCurrent ? { status: isPickup ? 'en_route' : 'in_transit', delivery_time_start: currentLocalTime, delivery_time_eta: currentLocalTime } : {}) };});
      const { offlineDB } = await import('../utils/offlineDatabase');
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, optimisticRouteDeliveries.filter(Boolean));
      if (updateDeliveriesLocally) {
        const optimisticMap = new Map(optimisticRouteDeliveries.filter(Boolean).map((d) => [d.id, d]));
        const updatedDeliveries = allDeliveries.map((d) => d && optimisticMap.has(d.id) ? optimisticMap.get(d.id) : d);
        updateDeliveriesLocally(updatedDeliveries, true);
      }
      await collapseAndCenterNextDelivery({ driverDeliveries: optimisticRouteDeliveries, targetDeliveryId: delivery.id, updateDeliveryLocal, updateDeliveriesLocally });
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      Promise.resolve().then(async () => {
        window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
        try {
          await base44.functions.invoke('handleStartDelivery', { deliveryId: delivery.id, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
          await recalculateAndUpdateStopOrders(delivery.driver_id, delivery.delivery_date);
          const [etaRes, optimizeRes] = await Promise.allSettled([base44.functions.invoke('calculateRealTimeETA', { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime, deviceTime: currentLocalTime }), base44.functions.invoke('optimizeRouteRealTime', { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime, generatePolyline: false })]);
          const etaData = etaRes.status === 'fulfilled' ? etaRes.value?.data || etaRes.value : null;const optimizeData = optimizeRes.status === 'fulfilled' ? optimizeRes.value?.data || optimizeRes.value : null;const etaUpdates = etaData?.durationUpdates || etaData?.etas || optimizeData?.optimizedRoute || [];
          if (Array.isArray(etaUpdates) && etaUpdates.length > 0) window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { updates: etaUpdates.map((u) => ({ deliveryId: u.deliveryId || u.delivery_id, newEta: u.eta || u.newETA })) } }));
          invalidate('Delivery');await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);fabControlEvents.reactivatePhaseTwoIfAvailable();window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'startOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
        } catch (optErr) {console.warn('⚠️ [Start] background optimization failed:', optErr?.message || optErr);} finally
        {window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));}
      });
      Promise.all([ensureDriverOnline(), userHasRole(currentUser, 'driver') ? notifyDriverStarted({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers }) : Promise.resolve()]).catch((err) => console.warn('Background tasks failed:', err));
    } catch (error) {console.error('❌ [START] Error:', error);toast.error(`Failed to start: ${error.message}`);} finally
    {driverLocationPoller.resume();smartRefreshManager.resume();fabControlEvents.reactivateFAB(true);startTapLockRef.current = false;setIsStarting(false);setIsEntityUpdating(false);}
  };
  const handleAcceptAllStops = async () => {
    setIsAcceptingAll(true);const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    try {
      driverLocationPoller.pause();smartRefreshManager.pause();setIsEntityUpdating(true);
      const allPendingDeliveries = pendingPickups.filter((p) => p.status === 'pending');const now = new Date();const currentMinutes = now.getHours() * 60 + now.getMinutes();const startMinutes = currentMinutes + 5;const deliveryTimeStart = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const sortedPending = [...allPendingDeliveries].sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));
      sortedPending.forEach((pendingDelivery, i) => {queueDeliveryUpdate(pendingDelivery.id, { status: 'in_transit', delivery_time_start: deliveryTimeStart, tracking_number: incrementTrackingNumber(delivery.tracking_number, i + 1) });});
      await flushQueuedDeliveryUpdates();
      const codBatch = allPendingDeliveries.filter((pd) => pd.cod_total_amount_required > 0 && pd.patient_id).map((pendingDelivery) => {const storeForCod = stores.find((s) => s && s.id === pendingDelivery.store_id);return { deliveryId: pendingDelivery.id, patientName: pendingDelivery.patient_name, storeAbbreviation: storeForCod?.abbreviation || '', codAmount: pendingDelivery.cod_total_amount_required, deliveryDate: pendingDelivery.delivery_date, storeId: pendingDelivery.store_id };});
      invalidate('Delivery');await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAll', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      window.dispatchEvent(new CustomEvent('pendingToInTransit', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      Promise.resolve().then(async () => {
        window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
        try {
          await base44.functions.invoke('optimizeRouteRealTime', { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime: currentLocalTime, generatePolyline: false });
          invalidate('Delivery');await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'acceptAllOptimized', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, alreadyOptimized: true } }));
        } catch (optErr) {console.warn('⚠️ [Accept All] background optimization failed:', optErr?.message || optErr);} finally
        {window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));}
      });
      if (typeof codBatch !== 'undefined' && codBatch.length > 0) {console.log(`📦 [Square] Queuing ${codBatch.length} COD items to backend...`, codBatch);base44.functions.invoke('syncSquareCods', { items: codBatch }).then(() => {try {toast?.success?.(`Queued ${codBatch.length} CODs to Square`);} catch (_) {}}).catch((e) => console.warn('⚠️ [Square] Batch COD sync failed to start:', e));}
      const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id;
      if (isDriverAction) notifyDriverAcceptedAll({ driver: currentUser, store, appUsers }).catch((err) => console.warn('Notification failed:', err));else
      {const assignedDriver = drivers.find((d) => d?.id === delivery.driver_id);if (assignedDriver) notifyDispatcherAssignedAll({ dispatcher: currentUser, driver: assignedDriver, store, deliveries: allPendingDeliveries, patients }).catch((err) => console.warn('Notification failed:', err));}
    } catch (error) {console.error('❌ [Accept All] Error:', error);toast.error(`Failed to accept all: ${error.message}`);} finally
    {driverLocationPoller.resume();smartRefreshManager.resume();setIsEntityUpdating(false);setIsAcceptingAll(false);if (onClick) onClick(null);}
  };
  const handleReturnClick = async (e) => {e.stopPropagation();setIsPreparingReturn(true);try {if (!delivery || !store) {alert('Missing delivery or store information');return;}const returnPatientName = `${store.name.replace(/-/g, ' ')} Return`;const foundReturnPatient = patients.find((p) => p && p.full_name === returnPatientName && p.store_id === delivery.store_id);if (!foundReturnPatient) {alert(`Return patient "${returnPatientName}" not found. Please ensure a patient with this name exists for the store.`);return;}setReturnPatient(foundReturnPatient);setShowReturnConfirm(true);} finally {setIsPreparingReturn(false);}};
  const handleConfirmReturn = async () => {
    if (!onCreateReturn || !returnPatient) return;setIsCreatingReturn(true);
    try {
      await onCreateReturn({ originalDelivery: delivery, returnPatient: returnPatient, store: store });
      await collapseAndCenterNextDelivery({ driverDeliveries: getDriverRouteDeliveries(allDeliveries, delivery), targetDeliveryId: null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
      try {invalidate('Delivery');await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);} catch (_) {}
      const refreshedDriverDeliveries = await base44.entities.Delivery.filter({ driver_id: delivery.driver_id, delivery_date: delivery.delivery_date });
      const nextReturnDelivery = getNextActiveDelivery(refreshedDriverDeliveries, null, FINISHED_STATUSES);
      await collapseAndCenterNextDelivery({ driverDeliveries: refreshedDriverDeliveries, targetDeliveryId: nextReturnDelivery?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'return', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      if (userHasRole(currentUser, 'driver')) await notifyDriverReturn({ driver: currentUser, patientName: patient?.full_name, delivery, store, appUsers });
      setShowReturnConfirm(false);setReturnPatient(null);
    } catch (error) {console.error('Failed to create return:', error);alert('Failed to create return delivery');} finally
    {setIsCreatingReturn(false);}
  };
  const handleCancelReturn = () => {setShowReturnConfirm(false);setReturnPatient(null);};
  const handleRetryDelivery = async () => {
    fabControlEvents.deactivateFAB();setIsRetrying(true);setIsProcessingBackground(true);
    try {
      await withPausedDriverLocationPoller(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const retryTrackingNumber = getNextTrackingNumberInGroup(delivery.tracking_number, allDeliveries, delivery.driver_id, delivery.delivery_date);
        const retryDraft = buildRetryDelivery(delivery, retryTrackingNumber);
        const retryDate = retryDraft.delivery_date;
        const retryDateDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === retryDate);
        await createDeliveryLocal({
          ...retryDraft,
          stop_id: generateUniqueSID(retryDateDeliveries),
          puid: delivery.puid || delivery.stop_id || null,
          ampm_deliveries: delivery.ampm_deliveries,
          tracking_number: String(retryTrackingNumber)
        });
        await ensureDriverOnline();
        await collapseAndCenterNextDelivery({ driverDeliveries: getDriverRouteDeliveries(allDeliveries, delivery), targetDeliveryId: null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
        try {await base44.functions.invoke('optimizeRouteRealTime', { driverId: delivery.driver_id, deliveryDate: retryDate, currentLocalTime: getCurrentLocalTimeString(), generatePolyline: false });} catch (optimizeError) {console.warn('⚠️ [Retry] Route optimizer failed:', optimizeError);}
        await refreshDriverRoute({ driverId: delivery.driver_id, deliveryDate: retryDate, forceRefreshDriverDeliveries, triggeredBy: 'retry' });
        const refreshedDriverDeliveries = await base44.entities.Delivery.filter({ driver_id: delivery.driver_id, delivery_date: retryDate });
        const nextRetryDelivery = getNextActiveDelivery(refreshedDriverDeliveries, null, FINISHED_STATUSES);
        await collapseAndCenterNextDelivery({ driverDeliveries: refreshedDriverDeliveries, targetDeliveryId: nextRetryDelivery?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: retryDate });
        if (userHasRole(currentUser, 'driver')) await notifyDriverRetry({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers });
      });
    } finally {setIsRetrying(false);setIsProcessingBackground(false);fabControlEvents.reactivateFAB(true);}
  };
  const restartCurrentDelivery = async (shouldOptimize = false) => {
    fabControlEvents.deactivateFAB();setIsRestarting(true);setIsEntityUpdating(true);setIsProcessingBackground(true);
    try {
      await withPausedDriverLocationPoller(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));await verifyDeliveryStillExists(delivery.id);
        const driverDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
        await collapseAndCenterNextDelivery({ driverDeliveries, targetDeliveryId: null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
        const newStatus = isPickup ? 'en_route' : 'in_transit';
        await updateDeliveryLocal(delivery.id, { status: newStatus, isNextDelivery: false, actual_delivery_time: null, delivery_notes: '', finished_leg_encoded_polyline: null }, { skipSmartRefresh: true });
        if (shouldOptimize) {try {await base44.functions.invoke('optimizeRouteRealTime', { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, currentLocalTime: getCurrentLocalTimeString(), generatePolyline: false });} catch (optimizeError) {console.warn('⚠️ [Restart Delivery] Route optimizer failed:', optimizeError);}}
        await refreshDriverRoute({ driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, forceRefreshDriverDeliveries, triggeredBy: 'restart' });
        await collapseAndCenterNextDelivery({ driverDeliveries, targetDeliveryId: delivery.id, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
        if (userHasRole(currentUser, 'driver')) await notifyDriverRetry({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers });
      });
    } finally {fabControlEvents.reactivateFAB(true);setIsProcessingBackground(false);setIsRestarting(false);setIsEntityUpdating(false);}
  };
  const shouldFade = false;const cardZIndex = isHovered && !isRailCentered ? 52 : isRailCentered ? 51 : 50;const shouldAnchorExpandedCard = isMobileDevice() && isSelected && !isStrippedDelivery;
  return (
    <motion.div id={`stop-card-${delivery.id}`} data-is-condensed={shouldFade && !isExpanded && !isHovered} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className={`w-full cursor-pointer transition-all ${showCenteredIncompleteCollapsed ? 'self-start' : ''} ${isSelected && !isStrippedDelivery ? 'ring-2 ring-blue-500' : ''}`} style={{ scrollSnapAlign: 'center', position: 'relative', zIndex: cardZIndex }} onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}>
      <Card data-route-completed-condensed={showCompletedRouteCenteredCondensed ? "true" : "false"} className={`bg-card text-card-foreground rounded-xl border shadow-md cursor-pointer hover:shadow-lg transition-all duration-200 overflow-hidden ${isStrippedForDispatcher ? 'h-[72px] min-h-[72px]' : showCompletedRouteCenteredCondensed ? 'h-[72px] min-h-[72px]' : !isRailCentered && !isExpanded ? 'h-[72px] min-h-[72px]' : showCenteredIncompleteCollapsed ? 'min-h-0 h-auto self-start' : isFinishedDelivery && isExpanded ? 'h-auto min-h-[120px]' : 'min-h-[120px]'} min-w-[338px] max-w-[338px] border-blue-500`} onClick={(e) => {if (startTapLockRef.current || e.target?.closest?.('[data-stopcard-action="start"]')) return;onClick && onClick(delivery);}} style={{ background: 'var(--bg-white)', borderColor: isNextDelivery ? '#10B981' : '#3B82F6', opacity: shouldFade ? 0.4 : 1, transition: 'opacity 0.2s ease-in-out', maxHeight: shouldAnchorExpandedCard ? 'calc(100dvh - var(--bottom-nav-height, 64px) - 1rem)' : undefined }}>
        <CardContent className={`p-6 px-1 flex flex-col py-0 ${shouldAnchorExpandedCard ? 'max-h-full overflow-y-auto overscroll-contain' : ''}`}>
          <div className="flex items-start">{showDragHandle && dragHandleProps && !FINISHED_STATUSES.includes(delivery.status) && <div {...dragHandleProps} className="flex items-center justify-center cursor-grab active:cursor-grabbing pt-1 mr-1"><GripVertical className="w-5 h-5 text-slate-400 hover:text-slate-600" /></div>}<StopCardHeader delivery={delivery} store={store} patient={patient} isPickup={isPickup} pendingPickups={pendingPickups} storeColor={storeColor} finalDisplayName={finalDisplayName} FINISHED_STATUSES={FINISHED_STATUSES} showDriverName={showDriverName} safeDriver={safeDriver} driverBadgeColor={driverBadgeColor} driverBadgeTextColor={driverBadgeTextColor} currentUser={currentUser} appUsers={appUsers} isReturnDelivery={isReturnDelivery} /></div>
          {showMiddleSection && <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}></div>}
          {showMiddleSection && <div className="flex flex-col"><div className="flex items-start justify-between"><div className="flex flex-col justify-center gap-0.5 flex-1 min-w-0 min-h-[55px]">{finalDisplayAddress ? <><div className="flex items-start gap-2 text-lg" style={{ color: 'var(--text-slate-700)' }}><span className="text-xl font-medium truncate">{isPickup ? store?.address || '' : patient?.address || ''}</span></div>{!isStrippedDelivery && !shouldRedact && <div className="flex items-center text-lg min-h-[26px]" style={{ color: 'var(--text-slate-600)' }}>{(() => {const unitNum = !isPickup ? delivery?.unit_number || patient?.unit_number : null;const fullAddress = isPickup ? store?.address || '' : patient?.address || '';const buzzerMatch = fullAddress.match(/buzz(?:er)?\s*(\d+)/i);const buzzerNum = buzzerMatch ? buzzerMatch[1] : null;return <>{unitNum && <span className="text-md">#{unitNum}</span>}{buzzerNum && <span className="text-lg font-medium">Buzz {buzzerNum}</span>}{!unitNum && !buzzerNum && <span className="invisible">&nbsp;</span>}</>;})()}</div>}</> : <div className="w-full h-[26px]" />}</div>{isAssignedDriverOrAppOwner && !isStrippedForDriver && <div className="flex-shrink-0 flex items-center gap-2 min-h-[55px]">{finalDisplayPhone && <a href={`tel:${finalDisplayPhone.replace(/\D/g, '')}`} onClick={(e) => e.stopPropagation()} className="flex items-center justify-center w-12 h-12 rounded-full bg-emerald-100 hover:bg-emerald-200 text-emerald-600 transition-colors"><Phone className="w-6 h-6" /></a>}{isNextDelivery && (!isPickup && patient?.latitude && patient?.longitude || isPickup && store?.latitude && store?.longitude) && <a href={(() => {if (!isPickup && patient?.latitude && patient?.longitude) return `https://www.google.com/maps/dir/?api=1&destination=${patient.latitude},${patient.longitude}`;else if (isPickup && store?.latitude && store?.longitude) return `https://www.google.com/maps/dir/?api=1&destination=${store.latitude},${store.longitude}`;})()} target="_blank" rel="noopener noreferrer" onClick={(e) => {e.stopPropagation();fabControlEvents.reactivatePhaseTwoIfAvailable();}} className="flex items-center justify-center w-12 h-12 rounded-full bg-blue-100 hover:bg-blue-200 text-blue-600 transition-colors"><Navigation className="w-6 h-6" /></a>}</div>}</div></div>}
          <StopCardConfirmDialogs showDeleteConfirm={showDeleteConfirm} setShowDeleteConfirm={setShowDeleteConfirm} isPickup={isPickup} delivery={delivery} displayName={displayName} displayAddress={displayAddress} store={store} pendingPickups={pendingPickups} availableTransferPickups={availableTransferPickups} selectedTransferPickupId={selectedTransferPickupId} setSelectedTransferPickupId={setSelectedTransferPickupId} allDeliveries={allDeliveries} onDeleteDelivery={onDelete} showReturnConfirm={showReturnConfirm} returnPatient={returnPatient} handleCancelReturn={handleCancelReturn} handleConfirmReturn={handleConfirmReturn} isCreatingReturn={isCreatingReturn} driver={driver} patient={patient} />
          <StopCardPOD delivery={delivery} displayName={displayName} isNextDelivery={isNextDelivery} isFinishedDelivery={isFinishedDelivery} isPickup={isPickup} viewingImageUrl={viewingImageUrl} setViewingImageUrl={setViewingImageUrl} showSignatureCapture={showSignatureCapture} setShowSignatureCapture={setShowSignatureCapture} showPhotoCapture={showPhotoCapture} setShowPhotoCapture={setShowPhotoCapture} forceRefreshDriverDeliveries={forceRefreshDriverDeliveries} showButtons={false} />
          <FailureReasonDialog isOpen={showFailureReasonDialog} onClose={() => {setShowFailureReasonDialog(false);setPendingFailureStatus(null);}} onConfirm={async (reason) => {
            const status = pendingFailureStatus;
            try {
              setShowFailureReasonDialog(false);setPendingFailureStatus(null);setIsFailing(true);fabControlEvents.deactivateFAB();fabControlEvents.notifyPhaseTwoTempUnlock();smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);await new Promise((resolve) => setTimeout(resolve, 50));
              const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });if (!deliveryExists || deliveryExists.length === 0) {console.warn('⚠️ [FAILURE] Delivery no longer exists - aborting');toast.error('This delivery has been deleted. Please refresh the page.');return;}
              await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
              const existingNotes = delivery.delivery_notes || '';const updatedNotes = existingNotes ? `${existingNotes}\n[${status.toUpperCase()}] ${reason}` : `[${status.toUpperCase()}] ${reason}`;
              const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);
              const pendingBreadcrumbsString = await getPendingBreadcrumbsForDriver({ driverUserId: delivery.driver_id, appUsers });
              const finishedLegEncodedPolyline = await getFinishedLegEncodedPolyline({ delivery, allDeliveries, driver: safeDriver, patient, store, patients, stores, finishedStatuses: FINISHED_STATUSES, breadcrumbPayload: pendingBreadcrumbsString });
              try {
                await updateDeliveryLocal(delivery.id, { status: status, delivery_notes: updatedNotes, actual_delivery_time: localTimeString, finished_leg_encoded_polyline: finishedLegEncodedPolyline, ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}) }, { skipSmartRefresh: true });
                if (onStatusUpdate) await onStatusUpdate(delivery.id, status, { delivery_notes: updatedNotes, actual_delivery_time: localTimeString, finished_leg_encoded_polyline: finishedLegEncodedPolyline, ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}) }, false);
                if (pendingBreadcrumbsString) await clearPendingBreadcrumbsForDriver({ driverUserId: delivery.driver_id, appUsers });
                runTerminalDeliverySideEffects({ delivery, previousStatus: delivery.status, nextStatus: status, overrides: { delivery_notes: updatedNotes, actual_delivery_time: localTimeString, finished_leg_encoded_polyline: finishedLegEncodedPolyline, ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}) } });
              } catch (statusError) {console.error('❌ [FAILURE] Update failed:', statusError);toast.error(`Failed to update status: ${statusError.message}`);fabControlEvents.reactivateFAB(true);return;}
              const allDriverDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
              const incompleteAfterThis = allDriverDeliveries.filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending');
              if (incompleteAfterThis.length === 0) {
                fabControlEvents.notifyDoneButtonClicked();window.dispatchEvent(new CustomEvent('showRouteSummary', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
                if (currentUser?.id) {const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });if (appUsers && appUsers.length > 0) {const appUser = appUsers[0];await base44.entities.AppUser.update(appUser.id, { driver_status: 'off_duty', location_tracking_enabled: false });locationTracker.stopTracking();if (onDriverStatusChange) onDriverStatusChange('off_duty');}}
              }
              try {invalidate('Delivery');await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);} catch (_) {}
              const driverDeliveries = allDriverDeliveries.map((item) => item.id === delivery.id ? { ...item, status, isNextDelivery: false } : { ...item, isNextDelivery: false });
              const incompleteDeliveries = driverDeliveries.filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending').sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
              await collapseAndCenterNextDelivery({ driverDeliveries, targetDeliveryId: incompleteDeliveries[0]?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
              onClick?.(null);
              invalidate('Delivery');await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
              fabControlEvents.notifyPhaseTwoCompleteRecenter();
              if (userHasRole(currentUser, 'driver')) await notifyDriverFailed({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery: { ...delivery, delivery_notes: updatedNotes }, store, appUsers, failureReason: reason });
              toast.success(`${isPickup ? 'Pickup' : 'Delivery'} marked as ${status}`, { description: `Dispatch has been notified. Reason: ${reason}` });
              if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('collapseAllStopCards'));
            } catch (error) {console.error('❌ [FAILURE] Error:', error);toast.error(`Failed to mark as ${status}: ${error.message}`);} finally
            {setIsFailing(false);fabControlEvents.reactivateFAB(true);}
          }} deliveryName={displayName} isPickup={isPickup} statusType={pendingFailureStatus} />
          {showBodySection && <StopCardBody isExpanded={isExpanded} isStrippedForDispatcher={isStrippedForDispatcher} finalDisplayPhone={finalDisplayPhone} isFinishedDelivery={isFinishedDelivery} isPickup={isPickup} hasCODRequired={hasCODRequired} codTotalRequired={codTotalRequired} codPayments={codPayments} setCodPayments={setCodPayments} showCODCollection={showCODCollection} setShowCODCollection={setShowCODCollection} handleAddCODPayment={handleAddCODPayment} isStrippedForDriver={isStrippedForDriver} currentUser={currentUser} codTotalCollected={codTotalCollected} isCODComplete={isCODComplete} delivery={delivery} patient={patient} store={store} patients={patients} pendingPickups={pendingPickups} canAccessAcceptButtons={canAccessAcceptButtons} isAcceptingAll={isAcceptingAll} acceptButtonText={acceptButtonText} handleAcceptAllStops={handleAcceptAllStops} onEdit={onEdit} onCODUpdate={onCODUpdate} allDeliveries={allDeliveries} FINISHED_STATUSES={FINISHED_STATUSES} forceRefreshDriverDeliveries={forceRefreshDriverDeliveries} isCompleting={isCompleting} setIsCompleting={setIsCompleting} onSelectionChange={onSelectionChange} onClick={onClick} notesInput={notesInput} setNotesInput={setNotesInput} onNotesUpdate={onNotesUpdate} isCompleted={isCompleted} userHasRole={userHasRole} Textarea={Textarea} isAppOwnerFn={isAppOwner} />}
          {(() => {if (shouldCondenseCompletedRouteForDriver) return null;if (isStrippedForDriver && !isAppOwner(currentUser) && !userHasRole(currentUser, 'admin')) {const hasRetryButton = delivery.status === 'failed' && canRetry && !hasFutureRetry && !hasCompletedDelivery;const hasReturnButton = delivery.status === 'failed' && !isPickup && !hasFutureReturn && !hasCompletedDelivery;if (!hasRetryButton && !hasReturnButton) return null;}if (isDispatcherCenteredCard && !isExpanded) return null;if (!isAppOwner(currentUser) && !userHasRole(currentUser, 'admin') && isStrippedForDispatcher) return null;const shouldShowFooter = isExpanded ? true : isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || !(routeCompletedForLayout && (isPickup || delivery.status === 'failed' || delivery.status === 'cancelled')) && (!isFinishedDelivery || isRailCentered || isFinishedDelivery && !routeCompletedForLayout);if (isExpanded) return true;return (isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || isAssignedDriverOrAppOwner) && shouldShowFooter;})() && <div className={shouldAnchorExpandedCard ? 'sticky bottom-0 z-10' : ''} style={shouldAnchorExpandedCard ? { background: 'var(--bg-white)' } : undefined}><div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}><div className={`mx-1 flex justify-between items-center ${showCenteredIncompleteCollapsed ? 'mt-1 mb-0' : 'my-1'}`}>{(isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || isAssignedDriverOrAppOwner || canEdit) && <>{delivery.status === 'failed' && !isPickup ? <div className="flex items-center gap-2 w-full">{onStatusUpdate && <Button onClick={async (e) => {e.stopPropagation();await handleRetryDelivery();}} size="sm" className="bg-blue-600 hover:bg-blue-700 h-10 !text-white text-sm flex-1" disabled={isRetrying || isProcessingBackground || !canRetry || hasFutureRetry || hasCompletedDelivery || shouldDisableRetryReturn || isFailing}>{isRetrying || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}<span className="text-white">Retry</span></Button>}<Button onClick={handleReturnClick} size="sm" className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow rounded-md px-4 text-sm bg-orange-600 hover:bg-orange-700 !text-white h-10 flex-1" disabled={isPreparingReturn || isCreatingReturn || hasFutureReturn || hasCompletedDelivery || shouldDisableRetryReturn || isFailing}>{isPreparingReturn || isCreatingReturn ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Undo2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}Return</Button><div className="flex items-center ml-auto">{onRestart && ['completed', 'failed', 'cancelled'].includes(delivery.status) && !routeCompleted && !isPastDeliveryDate && <Button onClick={async (e) => {e.stopPropagation();await restartCurrentDelivery(false);}} size="sm" className="bg-blue-600 hover:bg-blue-700 h-10 rounded-r-none border-r border-blue-500 !text-white text-sm" disabled={isRestarting || isProcessingBackground || isFailing}>{isRestarting || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}<span className="text-white">Restart</span></Button>}<DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 border border-slate-300 hover:bg-slate-100 relative z-[10]" onClick={(e) => e.stopPropagation()}><MoreVertical className="w-5 h-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="p-1 rounded-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-[8rem] overflow-hidden border-2 shadow-md z-[200]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>{onEdit && !isStrippedForDispatcher && (isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) && <DropdownMenuItem onClick={(e) => {e.stopPropagation();onEdit(delivery);}} className="text-base py-2.5 md:py-1.5"><Edit className="w-5 h-5 mr-2" />Edit Delivery</DropdownMenuItem>}{(isNextDelivery || isFinishedDelivery) && !isPickup && patient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && <DropdownMenuItem onClick={handleUpdateGPS} className="text-base py-2.5 md:py-1.5"><Locate className="w-5 h-5 mr-2" />Update GPS</DropdownMenuItem>}{onDelete && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && <><DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} /><DropdownMenuItem onClick={(e) => {e.stopPropagation();setShowDeleteConfirm(true);}} className="text-red-600 text-base py-2.5 md:py-1.5" disabled={!userHasRole(currentUser, 'admin') && isRouteCompleted}><Trash2 className="w-5 h-5 mr-2" />Delete</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu></div></div> : <><StopCardPOD delivery={delivery} displayName={displayName} isNextDelivery={isNextDelivery} isFinishedDelivery={isFinishedDelivery} isPickup={isPickup} viewingImageUrl={viewingImageUrl} setViewingImageUrl={setViewingImageUrl} showSignatureCapture={showSignatureCapture} setShowSignatureCapture={setShowSignatureCapture} showPhotoCapture={showPhotoCapture} setShowPhotoCapture={setShowPhotoCapture} forceRefreshDriverDeliveries={forceRefreshDriverDeliveries} /><div className="flex items-center ml-auto">{delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && (isNextDelivery ? <Button onClick={async (e) => {
                        e.stopPropagation();if (isCompleting || isProcessingBackground || isFailing) return;fabControlEvents.deactivateFAB();fabControlEvents.notifyPhaseTwoTempUnlock();setIsCompleting(true);setIsProcessingBackground(true);const { driverLocationPoller } = await import('../utils/driverLocationPoller');driverLocationPoller.pause();smartRefreshManager.pause();smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);await new Promise((resolve) => setTimeout(resolve, 50));
                        try {
                          const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });if (!deliveryExists || deliveryExists.length === 0) {console.warn('⚠️ [COMPLETE] Delivery no longer exists - aborting');throw new Error('This delivery has been deleted. Please refresh the page.');}
                          await ensureDriverOnline();
                          const autoCODPayment = hasCODRequired && codPayments.length === 0 && onCODUpdate ? [{ type: 'Cash', amount: codTotalRequired }] : null;if (autoCODPayment) setCodPayments(autoCODPayment);
                          const pendingBreadcrumbsString = await getPendingBreadcrumbsForDriver({ driverUserId: delivery.driver_id, appUsers });
                          if (isPickup && pendingPickups && pendingPickups.length > 0) {const hasPendingDeliveries = pendingPickups.some((p) => p.status === 'pending');if (hasPendingDeliveries) await handleAcceptAllStops();}
                          const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);const completionCodPayments = autoCODPayment || codPayments;const sameRouteDeliveries = allDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);
                          await collapseAndCenterNextDelivery({ driverDeliveries: sameRouteDeliveries, targetDeliveryId: null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
                          const completionUpdate = { status: 'completed', actual_delivery_time: localTimeString, isNextDelivery: false, finished_leg_encoded_polyline: null, ...(pendingBreadcrumbsString ? { delivery_route_breadcrumbs: pendingBreadcrumbsString } : {}), ...(completionCodPayments.length > 0 ? { cod_payments: completionCodPayments } : {}) };
                          await updateDeliveryLocal(delivery.id, completionUpdate, { skipSmartRefresh: true });
                          if (pendingBreadcrumbsString) await clearPendingBreadcrumbsForDriver({ driverUserId: delivery.driver_id, appUsers });
                          runTerminalDeliverySideEffects({ delivery, previousStatus: delivery.status, nextStatus: 'completed', overrides: completionUpdate });
                          const pendingPickupIds = isPickup ? new Set((pendingPickups || []).filter((p) => p?.status === 'pending').map((p) => p.id)) : null;
                          const optimisticDeliveries = allDeliveries.map((d) => {if (!d || d.driver_id !== delivery.driver_id || d.delivery_date !== delivery.delivery_date) return d;if (d.id === delivery.id) return { ...d, ...completionUpdate, isNextDelivery: false };if (pendingPickupIds?.has(d.id)) return { ...d, status: 'in_transit', isNextDelivery: false };return { ...d, isNextDelivery: false };});
                          const routeDeliveries = optimisticDeliveries.filter((d) => d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date);const incompleteDeliveries = routeDeliveries.filter((d) => d && d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending').sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));const nextStop = incompleteDeliveries[0] || null;
                          await collapseAndCenterNextDelivery({ driverDeliveries: routeDeliveries, targetDeliveryId: nextStop?.id || null, updateDeliveryLocal, updateDeliveriesLocally, driverId: delivery.driver_id, deliveryDate: delivery.delivery_date });
                          if (!nextStop) {fabControlEvents.notifyDoneButtonClicked();window.dispatchEvent(new CustomEvent('showRouteSummary', { detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));try {locationTracker.stopTracking();} catch (trackingError) {console.warn('Could not stop location tracking:', trackingError.message);}if (onDriverStatusChange) onDriverStatusChange('off_duty');}
                          invalidate('Delivery');await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'complete', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('collapseAllStopCards'));fabControlEvents.notifyPhaseTwoCompleteRecenter();fabControlEvents.reactivateFAB(true);
                          Promise.resolve().then(async () => {
                            const backgroundTasks = [];
                            if (autoCODPayment && onCODUpdate) backgroundTasks.push(onCODUpdate(delivery.id, autoCODPayment, true).catch((err) => {console.warn('Background COD sync failed:', err);}));
                            backgroundTasks.push((async () => {const finishedLegEncodedPolyline = await getFinishedLegEncodedPolyline({ delivery, allDeliveries, driver: safeDriver, patient, store, patients, stores, finishedStatuses: FINISHED_STATUSES, breadcrumbPayload: pendingBreadcrumbsString });if (finishedLegEncodedPolyline) await updateDeliveryLocal(delivery.id, { finished_leg_encoded_polyline: finishedLegEncodedPolyline }, { skipSmartRefresh: true });})().catch((err) => {console.warn('Background polyline generation failed:', err);}));
                            if (!nextStop && currentUser?.id) backgroundTasks.push((async () => {const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });if (appUsers && appUsers.length > 0) await base44.entities.AppUser.update(appUsers[0].id, { driver_status: 'off_duty', location_tracking_enabled: false });})().catch((err) => {console.warn('Background driver status update failed:', err);}));
                            backgroundTasks.push((userHasRole(currentUser, 'driver') ? notifyDriverCompleted({ driver: currentUser, patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers }) : Promise.resolve()).catch((err) => {console.warn('Notification failed:', err);}));
                            await Promise.allSettled(backgroundTasks);
                          });
                        } catch (error) {console.error('❌ [COMPLETE] Error:', error);fabControlEvents.reactivateFAB(true);setIsProcessingBackground(false);setIsCompleting(false);} finally
                        {const { driverLocationPoller } = await import('../utils/driverLocationPoller');driverLocationPoller.resume();smartRefreshManager.resume();setIsCompleting(false);setIsProcessingBackground(false);if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('collapseAllStopCards'));}
                      }} size="sm" disabled={isCompleting || isProcessingBackground || isFailing} className={`rounded-md px-4 text-sm font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow h-10 border-r !text-white ${isFailing ? 'bg-red-600 hover:bg-red-700 border-red-500' : 'bg-emerald-600 hover:bg-emerald-700 border-emerald-500'}`}>{isCompleting || isFailing ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <CheckCircle className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}<span className="text-white">Complete</span></Button> : onStartDelivery && <Button data-stopcard-action="start" type="button" onPointerDownCapture={handleStartAction} onPointerDown={(e) => {e.preventDefault();e.stopPropagation();}} onMouseDown={(e) => {e.preventDefault();e.stopPropagation();}} onTouchStart={(e) => {e.preventDefault();e.stopPropagation();}} onClick={(e) => {e.preventDefault();e.stopPropagation();}} size="sm" disabled={isStarting || isProcessingBackground} className="bg-blue-600 px-4 text-sm font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 border-r border-blue-500 !text-white" title="Start this delivery">{isStarting ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Clock className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}<span className="text-white">Start</span></Button>)}{delivery.status !== 'failed' && ['completed', 'cancelled'].includes(delivery.status) && onRestart && !routeCompleted && !isPastDeliveryDate && <Button onClick={async (e) => {e.stopPropagation();await restartCurrentDelivery(true);}} size="sm" className="bg-blue-600 hover:bg-blue-700 h-10 rounded-r-none border-r border-blue-500 !text-white text-sm" disabled={isRestarting || isProcessingBackground || isFailing}>{isRestarting || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}<span className="text-white">Restart</span></Button>}<DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 border border-slate-300 hover:bg-slate-100 relative z-[10]" onClick={(e) => e.stopPropagation()}><MoreVertical className="w-5 h-5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="p-1 rounded-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-[8rem] overflow-hidden border-2 shadow-md z-[200]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>{onEdit && !isStrippedForDispatcher && (isAppOwner(currentUser) || userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && <DropdownMenuItem onClick={(e) => {e.stopPropagation();onEdit(delivery);}} className="text-base py-2.5 md:py-1.5"><Edit className="w-5 h-5 mr-2" />{isPickup ? 'Edit Pickup' : 'Edit Delivery'}</DropdownMenuItem>}{onEditPatient && patient && !isPickup && !isStrippedForDispatcher && isAppOwner(currentUser) && <DropdownMenuItem onClick={(e) => {e.stopPropagation();onEditPatient(patient);}} className="text-base py-2.5 md:py-1.5"><User className="w-5 h-5 mr-2" />Edit Patient</DropdownMenuItem>}{(isNextDelivery || isFinishedDelivery) && !isPickup && patient && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && <DropdownMenuItem onClick={handleUpdateGPS} className="text-base py-2.5 md:py-1.5"><Locate className="w-5 h-5 mr-2" />Update GPS</DropdownMenuItem>}{delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && isNextDelivery && onStatusUpdate && <><DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} /><DropdownMenuItem onClick={(e) => {e.stopPropagation();setPendingFailureStatus(isPickup ? 'cancelled' : 'failed');setShowFailureReasonDialog(true);}} className="text-red-600 text-base py-2.5 md:py-1.5"><XCircle className="w-5 h-5 mr-2" />{isPickup ? 'Cancel Pickup' : 'Mark as Failed'}</DropdownMenuItem></>}{onDelete && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) && (onEdit || !isPickup && patient && onEditPatient || isCompleted && onRestart && delivery.delivery_date === format(new Date(), 'yyyy-MM-dd')) && <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />}{onDelete && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) && <DropdownMenuItem onClick={(e) => {e.stopPropagation();setShowDeleteConfirm(true);}} className="text-red-600 text-base py-2.5 md:py-1.5" disabled={false}><Trash2 className="w-5 h-5 mr-2" />Delete</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu></div></>}</>}</div></div></div>}
        </CardContent>
      </Card>
    </motion.div>);
}