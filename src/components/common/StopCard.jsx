import { isRouteCompleted } from '@/components/utils/routeCompletionChecker'; import { motion } from 'framer-motion';
import React, { useState, useRef, useEffect, useMemo } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from
"@/components/ui/select";
import { Phone, MapPin, Edit, Trash2, StickyNote, RotateCcw, MoreVertical, User, CheckCircle, Clock, Package, XCircle, Info, FileText, Save, X, Plus, Undo2, Loader2, Navigation, GripVertical, Bell, BellOff, Mailbox, Locate } from "lucide-react";
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
import { getStoreColor, hexToRgba, getContrastColor } from "../utils/colorGenerator";
import { format, isBefore, startOfDay, addDays } from "date-fns";
import { getDriverDisplayName } from '../utils/driverUtils';
import { userHasRole, shouldShowStoreBadges, isAppOwner } from '../utils/userRoles';
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { formatAddressWithUnit, cleanBuzzerFromAddress } from '../utils/addressCleaner';
import { calculateDeliveryPay, formatPay } from '../utils/payCalculator';
import { base44 } from "@/api/base44Client";
import { locationTracker } from "../utils/locationTracker";
import { useAppData } from "../utils/AppDataContext";
import StopCardHeader from "./StopCardHeader";
import StopCardBody from "./StopCardBody";
import {notifyDriverAcceptedAll, notifyDriverAcceptedOne, notifyDispatcherAssignedAll, notifyDriverStarted, notifyDriverCompleted, notifyDriverFailed, notifyDriverRetry, notifyDriverReturn} from "../utils/deliveryMessaging";
import { triggerRouteOptimization } from "../utils/realTimeRouteOptimizer";
import { toast } from "sonner";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import FailureReasonDialog from "../deliveries/FailureReasonDialog";
import { updateDeliveryLocal } from '../utils/offlineMutations';
import { queueDeliveryUpdate, flushQueuedDeliveryUpdates } from '../utils/updateBatcher';
import { fabControlEvents } from '../utils/fabControlEvents';
import { invalidate } from '../utils/dataManager';
import HelpTooltip, { HELP_CONTENT } from './HelpTooltip';
import { generateCompletionTimestamp } from '../utils/timeRoundingHelper';
import StopCardCODCollection from './StopCardCODCollection';
import StopCardConfirmDialogs from './StopCardConfirmDialogs';
import StopCardPOD from './StopCardPOD';
import { useDeliveryDisplayInfo } from './StopCardRedaction';
import { updatePatientGPS } from "../utils/patientGPSUpdater";

// Global statusConfig
const statusConfig = {
  'pending': { label: 'Pending', color: 'bg-slate-100 text-slate-800' },
  'in_transit': { label: 'In Transit', color: 'bg-blue-100 text-blue-800' },
  'en_route': { label: 'En Route', color: 'bg-cyan-100 text-cyan-800' },
  'next': { label: 'Next', color: 'bg-lime-100 text-lime-800' },
  'completed': { label: 'Complete', color: 'bg-emerald-100 text-emerald-800' },
  'delivered': { label: 'Complete', color: 'bg-emerald-100 text-emerald-800' },
  'failed': { label: 'Failed', color: 'bg-red-100 text-red-800' },
  'cancelled': { label: 'Cancelled', color: 'bg-red-100 text-red-800' },
  'returned': { label: 'Return', color: 'bg-orange-100 text-orange-800' }
};

// MOVED OUTSIDE COMPONENT: Define finished statuses as a constant (no 'returned' status)
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

// Helper function to format time to 12-hour format with AM/PM
const formatTime12Hour = (timeString) => {
  // Silently handle missing, invalid, or placeholder times (common for pending deliveries)
  if (!timeString ||
    timeString === '--:--' ||
    timeString === 'null' ||
    timeString === 'undefined' ||
    timeString === 'NaN:NaN' ||
    String(timeString).includes('NaN')) {
    return '--:--';
  }

  try {
    const timeParts = String(timeString).split(':');
    if (timeParts.length < 2) return '--:--';

    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);

    // Silently return placeholder for invalid times (no console warnings)
    if (isNaN(hours) || isNaN(minutes)) {
      return '--:--';
    }

    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
  } catch (error) {
    return '--:--';
  }
};

export default function StopCard({
  delivery, store, driver, patients = [],
  currentUser, isExpanded: externalIsExpanded,
  showDriverName = false, onStatusUpdate,
  onNotesUpdate, onEditDelivery, onDeleteDelivery,
  onRestart, allDeliveries = [], selectedDate,
  onEditPatient, drivers = [], onDriverChange,
  canEdit = false, getDriverColor, onClick,
  isSelected, isProjected = false, pendingPickups = [],
  onSelectionChange, selectedDeliveryIds = [], stopOrder = {},
  onCODUpdate, stores = [], onCreateReturn, onStartDelivery,
  allStopsPending = false, onDriverStatusChange, appUsers = [],
  showDragHandle = false, dragHandleProps, compact = false}) 
{
  // CRITICAL: Use delivery.isNextDelivery from the entity, not the prop
  const isNextDelivery = delivery?.isNextDelivery || false;
  // CRITICAL FIX: ALL HOOKS MUST BE CALLED UNCONDITIONALLY AT THE TOP
  // Initialize with delivery prop values to maintain consistency
  const [notesInput, setNotesInput] = useState(delivery?.delivery_notes || "No driver notes");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [codPayments, setCodPayments] = useState(delivery?.cod_payments || []);
  const [showCODCollection, setShowCODCollection] = useState(false);
  const [showReturnConfirm, setShowReturnConfirm] = useState(false); const [isCreatingReturn, setIsCreatingReturn] = useState(false);
  const [returnPatient, setReturnPatient] = useState(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPreparingReturn, setIsPreparingReturn] = useState(false);
  const [isProcessingBackground, setIsProcessingBackground] = useState(false);
  const [isAcceptingAll, setIsAcceptingAll] = useState(false);
  const [acceptingIndividual, setAcceptingIndividual] = useState({});
  const { setIsEntityUpdating, forceRefreshDriverDeliveries, refreshData, updateDeliveriesLocally } = useAppData();
  const [showSignatureCapture, setShowSignatureCapture] = useState(false);
  const [showPhotoCapture, setShowPhotoCapture] = useState(false);
  const [viewingImageUrl, setViewingImageUrl] = useState(null); // URL of image to view fullscreen
  const [selectedTransferPickupId, setSelectedTransferPickupId] = useState(''); const [isHovered, setIsHovered] = useState(false); const [showFailureReasonDialog, setShowFailureReasonDialog] = useState(false); const [pendingFailureStatus, setPendingFailureStatus] = useState(null); const [isFailing, setIsFailing] = useState(false); const [isRestarting, setIsRestarting] = useState(false);

  // Detect if this is a stripped delivery (from other store)
  // For drivers: strip completed deliveries (_isStripped flag from Dashboard)
  // For dispatchers: strip deliveries that aren't from their assigned stores
  // CRITICAL: Must be defined BEFORE isExpanded which depends on it
  const isStrippedForDriver = useMemo(() => {
    if (!currentUser || !delivery) return false;
    if (userHasRole(currentUser, 'admin')) return false;
    if (userHasRole(currentUser, 'driver')) {
      return delivery._isStripped === true;
    }
    return false;
  }, [delivery?._isStripped, currentUser]);

  const isStrippedForDispatcher = useMemo(() => {
    // Dispatchers only see full info for stores they're assigned to
    if (!currentUser || !delivery) return false;
    if (!userHasRole(currentUser, 'dispatcher')) return false;
    
    // Admin dispatchers see everything
    if (userHasRole(currentUser, 'admin')) return false;
    
    // Strip if delivery's store is NOT in dispatcher's assigned stores
    const dispatcherStoreIds = currentUser.store_ids || [];
    return !dispatcherStoreIds.includes(delivery.store_id);
  }, [delivery?.store_id, currentUser]);

  const isStrippedDelivery = isStrippedForDriver || isStrippedForDispatcher;

  // Helper to auto-toggle driver online if offline
  const ensureDriverOnline = async () => {
    if (!currentUser?.id) return;

    try {
      // CRITICAL: Try offline DB FIRST to prevent rate limits
      const { offlineDB } = await import('../utils/offlineDatabase');
      let appUserData = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      let appUser = appUserData?.find(au => au.user_id === currentUser.id);
      
      if (!appUser) {
        // Fallback to API only if offline DB doesn't have data
        const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
        appUser = appUsers?.[0];
        
        // CRITICAL: Always save to offline DB immediately after API fetch
        if (appUsers && appUsers.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
        }
      }
      
      if (appUser && appUser.driver_status !== 'on_duty') {
        await base44.entities.AppUser.update(appUser.id, {
          driver_status: 'on_duty',
          location_tracking_enabled: true
        });

        // Start location tracking
        try {
          await locationTracker.startTracking({
            ...currentUser,
            appUserId: appUser.id
          });
        } catch (trackingError) {
          console.warn('Could not start location tracking:', trackingError.message);
        }

        // Notify parent to refresh UI
        if (onDriverStatusChange) {
          onDriverStatusChange('on_duty');
        }
      }
    } catch (error) {
      console.error('Failed to auto-toggle driver online:', error);
    }
  };

  // Use isSelected prop to control expansion (parent controls state)
  // CRITICAL: Stripped deliveries (for dispatchers) are NOT expandable - always collapsed
  // CRITICAL: Finished deliveries start collapsed but CAN be expanded when selected
  // CRITICAL: If compact mode is enabled (desktop), never expand the card (details shown in panel)
  const isFinishedDelivery = FINISHED_STATUSES.includes(delivery?.status);
  const isExpanded = isStrippedForDispatcher ? false : (compact ? false : isSelected);

  // Sync state with delivery prop changes
  useEffect(() => {
    setNotesInput(delivery?.delivery_notes || "No driver notes");
  }, [delivery?.delivery_notes]);

  // CRITICAL: Don't sync cod_payments from prop when COD collection panel is open
  // This prevents smart refresh from overwriting user's edits
  useEffect(() => {
    if (!showCODCollection) {
      setCodPayments(delivery?.cod_payments || []);
    }
  }, [delivery?.cod_payments, showCODCollection]);

  // Memoized values - ALWAYS calculated
  const patient = useMemo(() => {
    if (!delivery?.patient_id || !patients || patients.length === 0) return null;
    return patients.find((p) => p && p.id === delivery.patient_id);
  }, [delivery?.patient_id, patients]);

  const isPickup = useMemo(() => {
    if (!delivery) return false;
    return !delivery.patient_id && !!delivery.store_id;
  }, [delivery?.patient_id, delivery?.store_id]);
  
  // Calculate available transfer pickups for auto-selection
  const availableTransferPickups = useMemo(() => {
    if (!delivery || !isPickup) return [];
    return allDeliveries?.filter(d => 
      d && !d.patient_id && 
      d.store_id === delivery.store_id && 
      d.delivery_date === delivery.delivery_date &&
      d.driver_id === delivery.driver_id &&
      d.id !== delivery.id &&
      d.status !== 'completed' && d.status !== 'cancelled'
    ) || [];
  }, [delivery, allDeliveries, isPickup]);
  
  // Auto-select on delete confirm dialog open
  useEffect(() => {
    if (showDeleteConfirm && isPickup && pendingPickups?.length > 0) {
      if (availableTransferPickups.length === 0) {
        // No stores available - select the "delete all" option
        setSelectedTransferPickupId('delete_all');
      } else if (availableTransferPickups.length >= 1) {
        // At least 1 store available - auto-select the first one
        setSelectedTransferPickupId(availableTransferPickups[0].id);
      }
    }
  }, [showDeleteConfirm, isPickup, pendingPickups, availableTransferPickups]);

  // Check if this is an InterStore Pickup (store pickup where patient name contains InterStore)
  const isInterStorePickup = useMemo(() => {
    if (!delivery) return false;

    // For pickups, check if patient_name (denormalized) contains InterStore
    const patientName = (delivery.patient_name || '').toLowerCase();
    if (patientName.includes('interstore') || patientName.includes('inter-store') || patientName.includes('inter store')) {
      return true;
    }

    // Also check delivery notes for InterStore marker (in case it was added there)
    const deliveryNotes = (delivery.delivery_notes || '').toLowerCase();
    if (deliveryNotes.includes('interstore pickup') || deliveryNotes.includes('inter-store pickup') || deliveryNotes.includes('isp')) {
      return true;
    }

    return false;
  }, [delivery]);

  const canChangeDriver = useMemo(() => {
    if (!delivery || !currentUser || !onDriverChange) return false;
    if (isPickup) return false;
    if (FINISHED_STATUSES.includes(delivery.status)) return false;
    return userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher');
  }, [currentUser, delivery, onDriverChange, isPickup]);

  const patientDisplayAddress = useMemo(() => {
    if (isPickup || !patient) return '';
    return formatAddressWithUnit(patient.address, delivery?.unit_number || patient.unit_number);
  }, [patient, delivery?.unit_number, isPickup]);

  const safeDriver = useMemo(() =>
    driver && typeof driver === 'object' ? driver : null,
    [driver]);

  const driverBadgeColor = useMemo(() => {
    if (getDriverColor && safeDriver) {
      return getDriverColor(safeDriver);
    }
    return '#64748b';
  }, [getDriverColor, safeDriver]);

  const driverBadgeTextColor = useMemo(() => {
    return getContrastColor(driverBadgeColor);
  }, [driverBadgeColor]);

  const codTotalCollected = useMemo(() => {
    return codPayments.reduce((sum, payment) => sum + (parseFloat(payment.amount) || 0), 0);
  }, [codPayments]);

  const codTotalRequired = useMemo(() => delivery?.cod_total_amount_required || 0, [delivery?.cod_total_amount_required]);
  const hasCODRequired = useMemo(() => codTotalRequired > 0, [codTotalRequired]);
  const isCODComplete = useMemo(() => codTotalCollected >= codTotalRequired, [codTotalCollected, codTotalRequired]);
  const isCompleted = useMemo(() => delivery ? FINISHED_STATUSES.includes(delivery.status) : false, [delivery?.status]);

  // Detect if this is a return delivery (check patient name/notes for "(RTN)" specifically)
  const isReturnDelivery = useMemo(() => {
    if (!delivery || isPickup) return false;

    const patientName = (patient?.full_name || delivery.patient_name || '').toUpperCase();
    const deliveryNotes = (delivery.delivery_notes || '').toUpperCase();
    const patientNotes = (patient?.notes || '').toUpperCase();

    return patientName.includes('(RTN)') ||
      deliveryNotes.includes('(RTN)') ||
      patientNotes.includes('(RTN)');
  }, [delivery, patient, isPickup]);

  // Check if this is a first delivery based on patient's last_delivery_date
  // If patient has no last_delivery_date, they are a new patient
  const isFirstDelivery = useMemo(() => {
    if (!delivery || isPickup) return false;

    // Check if patient has no last_delivery_date (new patient)
    if (patient && !patient.last_delivery_date) return true;

    // Also check driver notes for "First Delivery" (set when staged)
    if (delivery.delivery_notes?.toLowerCase().includes('first delivery')) return true;

    // Check if explicitly marked as first_delivery
    if (delivery.first_delivery === true) return true;

    return false;
  }, [delivery, patient, isPickup]);

  const storeColor = useMemo(() => store ? getStoreColor(store) : "#71717A", [store]);

  const routeCompleted = React.useMemo(() => {
    return isRouteCompleted(delivery, allDeliveries, FINISHED_STATUSES, new Date(), "America/Edmonton");
  }, [delivery, allDeliveries]);

  // Check if this is an InterStore delivery (DropOff or Pickup)
  const isInterStore = useMemo(() => {
    if (!delivery) return false;

    // Check patient name (from patient entity or denormalized field)
    const patientName = (patient?.full_name || delivery.patient_name || '').toLowerCase();
    if (patientName.includes('interstore') || patientName.includes('inter-store') || patientName.includes('inter store')) {
      return true;
    }

    // Check patient notes (NOT delivery notes or driver notes)
    const patientNotes = (patient?.notes || '').toLowerCase();
    if (patientNotes.includes('interstore') || patientNotes.includes('inter-store') || patientNotes.includes('inter store')) {
      return true;
    }

    return false;
  }, [delivery, patient]);

  const shouldShowStoreBadge = useMemo(() => shouldShowStoreBadges(currentUser), [currentUser]);

  const { displayName, displayAddress, displayPhone, shouldRedact, finalDisplayName, finalDisplayAddress, finalDisplayPhone } = useDeliveryDisplayInfo({
    delivery, patient, store, currentUser, isPickup, isInterStore, isInterStorePickup, isStrippedDelivery, isStrippedForDispatcher,
  });

// Check if retry/return should be disabled based on duplicate deliveries
  const shouldDisableRetryReturn = useMemo(() => {
    if (delivery.status !== 'failed' || isPickup || !patient) return false;
    
    // Get all deliveries for this patient on this date
    const patientDeliveries = allDeliveries.filter((d) =>
      d && d.patient_id === delivery.patient_id &&
      d.delivery_date === delivery.delivery_date
    );
    
    // Count total deliveries and failed deliveries
    const totalDeliveries = patientDeliveries.length;
    const failedDeliveries = patientDeliveries.filter(d => d.status === 'failed');
    
    // If 3+ deliveries total (including this one), disable all failed except the highest stop order
    if (totalDeliveries >= 3) {
      const maxFailedStopOrder = Math.max(...failedDeliveries.map(d => d.stop_order || 0));
      return delivery.stop_order !== maxFailedStopOrder;
    }
    
    // If exactly 2 failed deliveries, disable the one with lower stop order
    if (failedDeliveries.length === 2) {
      const otherFailed = failedDeliveries.find(d => d.id !== delivery.id);
      if (otherFailed) {
        return delivery.stop_order < otherFailed.stop_order;
      }
    }
    
    // If there's a non-failed duplicate, disable this failed one
    if (patientDeliveries.some(d => d.id !== delivery.id && d.status !== 'failed' && d.status !== 'cancelled')) {
      return true;
    }
    
    return false;
  }, [delivery, allDeliveries, patient, isPickup]);

  const { hasFutureRetry, hasFutureReturn, hasCompletedDelivery } = useMemo(() => {
    if (delivery.status !== 'failed' || isPickup || !patient) {
      return { hasFutureRetry: false, hasFutureReturn: false, hasCompletedDelivery: false };
    }

    const failedDate = startOfDay(new Date(delivery.delivery_date));
    const toDate = addDays(failedDate, 7); // delivery day + 6 more days

    const failedPatientName = patient.full_name;

    let futureRetryExists = false;
    let futureReturnExists = false;
    let completedDeliveryExists = false;

    for (const d of allDeliveries) {
      if (!d || d.id === delivery.id) continue;

      let dDate;
      try {
        dDate = startOfDay(new Date(d.delivery_date));
      } catch (e) {
        continue;
      }

      // Check within the date range (same day or future within 6 days)
      if (dDate >= failedDate && dDate < toDate) {
        // Check for a retry of the same delivery
        if (d.patient_id === delivery.patient_id && d.stop_id === delivery.stop_id && d.status !== 'failed') {
          futureRetryExists = true;
        }

        // Check for a successful completed delivery for the same patient on same date or future
        if (d.patient_id === delivery.patient_id && d.status === 'completed') {
          completedDeliveryExists = true;
        }

        // Check for a return delivery - look for "Patient Return" in notes with failed patient's name
        const notesLower = (d.delivery_notes || '').toLowerCase();
        const patientNotesLower = (() => {
          const returnPatient = patients.find((p) => p?.id === d.patient_id);
          return (returnPatient?.notes || '').toLowerCase();
        })();

        // Check if this delivery's notes contain "Patient Return" AND the failed patient's name
        const hasPatientReturnMarker = notesLower.includes('patient return') || patientNotesLower.includes('patient return');
        const hasFailedPatientName = notesLower.includes(failedPatientName.toLowerCase()) || patientNotesLower.includes(failedPatientName.toLowerCase());

        // Legacy check: old style return detection
        const legacyNotesMatch = notesLower.includes(failedPatientName.toLowerCase());
        const sidMatch = d.stop_id === delivery.stop_id;

        if (hasPatientReturnMarker && hasFailedPatientName || (legacyNotesMatch || sidMatch) && !d.patient_id) {
          futureReturnExists = true;
        }
      }
      if (futureRetryExists && futureReturnExists && completedDeliveryExists) break;
    }
    return { hasFutureRetry: futureRetryExists, hasFutureReturn: futureReturnExists, hasCompletedDelivery: completedDeliveryExists };
  }, [delivery, allDeliveries, patient, isPickup, patients]);

  const canRetry = useMemo(() => {
    if (!delivery || delivery.status !== 'failed' || isPickup || !patient) return true;

    // Cannot retry if there's already a return delivery
    if (hasFutureReturn) return false;

    // Cannot retry if there's another delivery for the same patient later on the same date
    const hasLaterDelivery = allDeliveries.some((d) => {
      if (!d || d.id === delivery.id) return false;
      if (d.delivery_date !== delivery.delivery_date) return false;
      if (d.patient_id !== delivery.patient_id) return false;

      // Check if this delivery has a later stop order
      return (d.stop_order || 0) > (delivery.stop_order || 0);
    });

    return !hasLaterDelivery;
  }, [delivery, allDeliveries, patient, isPickup, hasFutureReturn]);

  const _isProjectedData = useMemo(() => delivery?.isProjected || false, [delivery?.isProjected]);

  // Check if current user is the assigned driver for this delivery OR is app owner
  const isAssignedDriverOrAppOwner = useMemo(() => {
    if (!currentUser || !delivery) return false;
    if (isAppOwner(currentUser)) return true;
    if (!userHasRole(currentUser, 'driver')) return false;
    return delivery.driver_id === currentUser.id;
  }, [currentUser, delivery]);

  // Check if current user is an assigned dispatcher for this delivery's store
  const isAssignedDispatcher = useMemo(() => {
    if (!currentUser || !delivery) return false;
    if (!userHasRole(currentUser, 'dispatcher')) return false;
    const dispatcherStoreIds = currentUser.store_ids || [];
    return dispatcherStoreIds.includes(delivery.store_id);
  }, [currentUser, delivery]);

  // Check if user can access Accept/Assign buttons (assigned driver, assigned dispatcher, or admin)
  const canAccessAcceptButtons = useMemo(() => {
    if (!currentUser || !delivery) return false;
    // App owner/admin always has access
    if (isAppOwner(currentUser) || userHasRole(currentUser, 'admin')) return true;
    // Assigned dispatcher has access
    if (isAssignedDispatcher) return true;
    // Assigned driver has access
    if (userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id) return true;
    return false;
  }, [currentUser, delivery, isAssignedDispatcher]);

  // Determine button text based on user role
  // Assigned driver (even if admin) sees "Accept All", non-driver admin/dispatcher sees "Assign All"
  const acceptButtonText = useMemo(() => {
    if (!currentUser || !delivery) return 'Assign All';

    // If current user is the assigned driver, show "Accept All"
    const isAssignedDriver = delivery.driver_id === currentUser.id && userHasRole(currentUser, 'driver');
    if (isAssignedDriver) {
      return 'Accept All';
    }

    // Non-driver admin/dispatcher sees "Assign All"
    return 'Assign All';
  }, [currentUser, delivery?.driver_id]);

  const nextAvailableStatuses = useMemo(() => {
    if (!onStatusUpdate || !currentUser) return [];

    // Only assigned driver or app owner can change status
    if (!isAssignedDriverOrAppOwner) return [];

    const canChangeStatus = userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver');
    if (!canChangeStatus) return [];

    // No status changes for finished deliveries
    if (FINISHED_STATUSES.includes(delivery.status)) {
      return [];
    }

    let statuses = [];
    if (isPickup) {
      // Pickup statuses: En Route (default), Completed, Cancelled
      statuses = ['en_route', 'completed', 'cancelled'];
    } else {
      // Delivery statuses: Pending, In Transit, Completed, Failed
      statuses = ['pending', 'in_transit', 'completed', 'failed'];
    }
    return statuses.filter((s) => s !== delivery.status);
  }, [delivery?.status, onStatusUpdate, currentUser, isPickup, isAssignedDriverOrAppOwner]);

  // CRITICAL: Hide status dropdown when entire route is completed
  const showStatusDropdown = useMemo(() => {
    if (isRouteCompleted) return false;
    return nextAvailableStatuses.length > 0;
  }, [isRouteCompleted, nextAvailableStatuses]);

  if (!delivery) return null;

  const handleNotesBlur = () => {
    // If empty or default text, restore default display
    if (!notesInput.trim() || notesInput.trim() === 'No driver notes') {
      setNotesInput('No driver notes');
      // Only update if there were actual notes before
      if (delivery?.delivery_notes && delivery.delivery_notes.trim() && onNotesUpdate) {
        onNotesUpdate(delivery.id, '');
      }
      return;
    }

    if (notesInput !== delivery.delivery_notes && onNotesUpdate) {
      onNotesUpdate(delivery.id, notesInput);
    }
  };

  const handleNotesKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (notesInput !== delivery.delivery_notes && onNotesUpdate) {
        onNotesUpdate(delivery.id, notesInput);
      }
      e.target.blur();
    }
  };

  const handleCODPaymentChange = (index, field, value) => {
    const newPayments = [...codPayments];
    if (field === 'amount') {
      // Handle amount like the DeliveryForm: strip non-digits, store as cents
      const cleaned = String(value).replace(/[^\d]/g, '');
      const cents = parseInt(cleaned) || 0;
      newPayments[index] = { ...newPayments[index], [field]: cents / 100 };
    } else if (field === 'type') {
      // When changing type, auto-populate with remaining amount if current amount is 0
      newPayments[index] = { ...newPayments[index], [field]: value };
      if (newPayments[index].amount === 0) {
        const remainingAmount = codTotalRequired - codTotalCollected;
        newPayments[index].amount = Math.max(0, remainingAmount);
      }
    } else {
      newPayments[index] = { ...newPayments[index], [field]: value };
    }
    setCodPayments(newPayments);
  };

  const handleAddCODPayment = (shouldFocusType = false) => {
    const remainingAmount = codTotalRequired - codTotalCollected;
    const newPayment = { type: 'Cash', amount: Math.max(0, remainingAmount) };
    setCodPayments([...codPayments, newPayment]);

    if (shouldFocusType) {
      // Focus the payment type dropdown after render
      setTimeout(() => {
        const lastIndex = codPayments.length;
        const selectTrigger = document.querySelector(`[data-cod-select-index="${lastIndex}"]`);
        if (selectTrigger) {
          selectTrigger.click();
        }
      }, 100);
    } else {
      // Focus and select the amount input after render
      setTimeout(() => {
        const lastIndex = codPayments.length;
        if (codAmountInputRefs.current[lastIndex]) {
          codAmountInputRefs.current[lastIndex].focus();
          codAmountInputRefs.current[lastIndex].select();
        }
      }, 50);
    }
  };

  const handleRemoveCODPayment = (index) => {
    const newPayments = codPayments.filter((_, i) => i !== index);
    setCodPayments(newPayments);
  };

  const handleSaveCODPayments = async () => {
    if (onCODUpdate) {
      try {
        // Pass skipAutoCenter=true to prevent card scrolling after COD save
        await onCODUpdate(delivery.id, codPayments, true);

        setShowCODCollection(false);
      } catch (error) {
        console.error('❌ [COD Save] Failed:', error);
        alert(`Failed to save COD: ${error.message}`);
      }
    }
  };

  const handleAcceptAllStops = async () => {
    setIsAcceptingAll(true);
    
    // Import poller early to ensure it's available
    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    
    try {
      driverLocationPoller.pause();
      smartRefreshManager.pause();
      setIsEntityUpdating(true);

      const allPendingDeliveries = pendingPickups.filter((p) => p.status === 'pending');
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const startMinutes = currentMinutes + 5;
      const deliveryTimeStart = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
      const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      // Batch all status updates + TR# assignments
      const pickupTR = parseInt(delivery.tracking_number, 10);
      const baseTR = isNaN(pickupTR) ? 0 : pickupTR;
      const sortedPending = [...allPendingDeliveries].sort((a, b) =>
        (a.patient_name || '').localeCompare(b.patient_name || '')
      );

      sortedPending.forEach((pendingDelivery, i) => {
        queueDeliveryUpdate(pendingDelivery.id, {
          status: 'in_transit',
          delivery_time_start: deliveryTimeStart,
          tracking_number: String(baseTR + i + 1)
        });
      });
      await flushQueuedDeliveryUpdates();

      // Prepare Square COD batch for gentle backend processing
      const codBatch = allPendingDeliveries
        .filter(pd => pd.cod_total_amount_required > 0 && pd.patient_id)
        .map((pendingDelivery) => {
          const storeForCod = stores.find((s) => s && s.id === pendingDelivery.store_id);
          return {
            deliveryId: pendingDelivery.id,
            patientName: pendingDelivery.patient_name,
            storeAbbreviation: storeForCod?.abbreviation || '',
            codAmount: pendingDelivery.cod_total_amount_required,
            deliveryDate: pendingDelivery.delivery_date,
            storeId: pendingDelivery.store_id
          };
        });

      // ═══════════ PHASE 2: SINGLE UI UPDATE ═══════════
      invalidate('Delivery');
      await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
      
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { triggeredBy: 'acceptAll', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
      }));
      window.dispatchEvent(new CustomEvent('pendingToInTransit', {
        detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
      }));
      
      // ═══════════ PHASE 3: BACKEND OPTIMIZATION ═══════════
      window.dispatchEvent(new CustomEvent('routeOptimizationStarted', {
        detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
      }));
      
      try {
        await base44.functions.invoke('optimizeRouteRealTime', {
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          currentLocalTime: currentLocalTime,
          generatePolyline: false
        });
      } finally {
        // CRITICAL: Mark that optimization is complete - prevents RealTimeRouteOptimizer from re-running
        window.dispatchEvent(new CustomEvent('routeOptimizationComplete', {
          detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
        }));
      }

      // ═══════════ PHASE 4: FINAL UI UPDATE ═══════════
      invalidate('Delivery');
      await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

      // Kick off gentle Square COD creation in backend (fire-and-forget)
      if (typeof codBatch !== 'undefined' && codBatch.length > 0) {
        console.log(`📦 [Square] Queuing ${codBatch.length} COD items to backend...`, codBatch);
        base44.functions.invoke('syncSquareCods', { items: codBatch })
          .then(() => {
            try { toast?.success?.(`Queued ${codBatch.length} CODs to Square`); } catch (_) {}
          })
          .catch((e) => console.warn('⚠️ [Square] Batch COD sync failed to start:', e));
      }

      // CRITICAL: Dispatch event with flag indicating data is already optimized
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { 
          triggeredBy: 'acceptAllOptimized', 
          driverId: delivery.driver_id, 
          deliveryDate: delivery.delivery_date,
          alreadyOptimized: true 
        }
      }));
      
      // Send notifications
      const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id;
      if (isDriverAction) {
        notifyDriverAcceptedAll({ driver: currentUser, store, appUsers }).catch(err => console.warn('Notification failed:', err));
      } else {
        const assignedDriver = drivers.find((d) => d?.id === delivery.driver_id);
        if (assignedDriver) {
          notifyDispatcherAssignedAll({
            dispatcher: currentUser,
            driver: assignedDriver,
            store,
            deliveries: allPendingDeliveries,
            patients
          }).catch(err => console.warn('Notification failed:', err));
        }
      }

    } catch (error) {
      console.error('❌ [Accept All] Error:', error);
      toast.error(`Failed to accept all: ${error.message}`);
    } finally {
      driverLocationPoller.resume();
      smartRefreshManager.resume();
      setIsEntityUpdating(false);
      setIsAcceptingAll(false);
      if (onClick) {
        onClick(null);
      }
    }
  };

  const handleReturnClick = async (e) => {
    e.stopPropagation();
    setIsPreparingReturn(true);
    try {
      if (!delivery || !store) {
        alert('Missing delivery or store information');
        return;
      }
      // Find the return patient for this store
      const returnPatientName = `${store.name.replace(/-/g, ' ')} Return`;
      const foundReturnPatient = patients.find((p) =>
        p && p.full_name === returnPatientName && p.store_id === delivery.store_id
      );
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
    if (!onCreateReturn || !returnPatient) return;

    setIsCreatingReturn(true);
    try {
      await onCreateReturn({
        originalDelivery: delivery,
        returnPatient: returnPatient,
        store: store
      });

      // CRITICAL: Run route optimizer to insert return at optimal position
      try {
        const now = new Date();
        const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        await base44.functions.invoke('optimizeRouteRealTime', {
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          currentLocalTime: currentLocalTime,
          generatePolyline: false
        });

        // CRITICAL: Refresh UI to show reordered stops
        invalidate('Delivery');
        await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
      } catch (optimizeError) {
        console.warn('⚠️ [Return] Route optimizer failed:', optimizeError);
      }

      // CRITICAL: Trigger immediate map update
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { triggeredBy: 'return', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
      }));

      // Send notification to dispatchers
      if (userHasRole(currentUser, 'driver')) {
        await notifyDriverReturn({
          driver: currentUser,
          patientName: patient?.full_name,
          delivery,
          store,
          appUsers
        });
      }

      setShowReturnConfirm(false);
      setReturnPatient(null);
    } catch (error) {
      console.error('Failed to create return:', error);
      alert('Failed to create return delivery');
    } finally {
      setIsCreatingReturn(false);
    }
  };

  const handleCancelReturn = () => {
    setShowReturnConfirm(false);
    setReturnPatient(null);
  };

  // Determine if card should be faded
  // CRITICAL: Only fade finished stops on delivery date (not past dates or future)
  const shouldFade = useMemo(() => {
    if (!delivery) return false;

    // Don't fade if expanded or hovered
    if (isExpanded || isHovered) return false;

    // Get today and delivery date at start of day
    const today = startOfDay(new Date());
    const deliveryDateObj = startOfDay(new Date(delivery.delivery_date + 'T00:00:00'));

    // Only fade if: delivery date matches today AND has finished status
    if (deliveryDateObj.getTime() === today.getTime() && FINISHED_STATUSES.includes(delivery.status)) {
      return true;
    }

    return false;
  }, [delivery, delivery?.status, isExpanded, isHovered]);

  return (
    <motion.div
      id={`stop-card-${delivery.id}`}
      data-is-condensed={shouldFade && !isExpanded && !isHovered}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className={`w-full cursor-pointer transition-all ${isSelected && !isStrippedDelivery ? 'ring-2 ring-blue-500' : ''}`}
      style={{ scrollSnapAlign: 'center', position: 'relative', zIndex: 50 }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}>
      <Card className="bg-card text-card-foreground rounded-xl border shadow-md cursor-pointer hover:shadow-lg transition-all duration-200 min-w-[338px] max-w-[338px] border-blue-500"


        onClick={() => {
          // Allow clicking even for stripped deliveries (to show driver notes)
          onClick && onClick(delivery);
        }}
        style={{
          background: 'var(--bg-white)',
          borderColor: isNextDelivery ? '#10B981' : '#3B82F6',
          opacity: shouldFade ? 0.4 : 1,
          transition: 'opacity 0.2s ease-in-out'
        }}>
        <CardContent className="p-6 px-2 py-0 flex flex-col">
          {/* HEADER SECTION - Always Visible */}
          <div className="flex items-start">
            {/* Drag Handle - Only show for non-finished deliveries */}
            {showDragHandle && dragHandleProps && !FINISHED_STATUSES.includes(delivery.status) &&
              <div {...dragHandleProps} className="flex items-center justify-center cursor-grab active:cursor-grabbing pt-1 mr-1">
                <GripVertical className="w-5 h-5 text-slate-400 hover:text-slate-600" />
              </div>
            }
            
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
              isReturnDelivery={isReturnDelivery}
            />
          </div>

          {/* Show address/phone: NOT driver-stripped AND NOT dispatcher-stripped, AND (not finished OR expanded) */}
          {!isStrippedForDriver && !isStrippedForDispatcher && (!isFinishedDelivery || isExpanded) && <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}></div>}

          {!isStrippedForDriver && !isStrippedForDispatcher && (!isFinishedDelivery || isExpanded) && <div className="flex flex-col">
            <div className="flex items-start justify-between">
              <div className="flex flex-col justify-center gap-0.5 flex-1 min-w-0 min-h-[50px]">
                {finalDisplayAddress ?
                  <>
                    {/* Main address without unit/buzzer */}
                    <div className="flex items-start gap-2 text-lg md:text-sm" style={{ color: 'var(--text-slate-700)' }}>
                      <span className="text-2xl md:text-xl font-medium truncate">
                        {isPickup ? store?.address || '' : patient?.address || ''}
                      </span>
                    </div>

                    {/* Unit/Buzzer row (phone removed - now in expanded section) */}
                    {!isStrippedDelivery && !shouldRedact &&
                      <div className="flex items-center text-lg md:text-sm" style={{ color: 'var(--text-slate-600)' }}>
                        {/* Unit and Buzzer info */}
                        {(() => {
                          const unitNum = !isPickup ? delivery?.unit_number || patient?.unit_number : null;
                          const fullAddress = isPickup ? store?.address || '' : patient?.address || '';
                          const buzzerMatch = fullAddress.match(/buzz(?:er)?\s*(\d+)/i);
                          const buzzerNum = buzzerMatch ? buzzerMatch[1] : null;

                          if (!unitNum && !buzzerNum) return null;

                          return (
                            <>
                              {unitNum && <span className="text-xl md:text-base font-medium">#{unitNum}</span>}
                              {buzzerNum && <span className="text-lg md:text-sm font-medium">Buzz {buzzerNum}</span>}
                            </>);
                        })()}
                      </div>
                    }
                  </> :
                  <div className="w-full h-[26px]" />
                }
              </div>

              {/* Navigation and Phone buttons - Hide for driver-stripped always (stripped item) */}
              {isAssignedDriverOrAppOwner && !isStrippedForDriver &&
                <div className="mt-1 py-1 flex items-center gap-2 flex-shrink-0 min-h-[50px]">
                  {finalDisplayPhone &&
                    <a
                      href={`tel:${finalDisplayPhone.replace(/\D/g, '')}`}
                      onClick={(e) => e.stopPropagation()} className="flex items-center justify-center w-12 h-12 md:w-11 md:h-11 rounded-full bg-emerald-100 hover:bg-emerald-200 text-emerald-600 transition-colors">
                      <Phone className="w-6 h-6 md:w-5 md:h-5" />
                    </a>
                  }
                  {/* CRITICAL: Only show GPS button for isNextDelivery cards - always use coordinates */}
                  {isNextDelivery && ((!isPickup && patient?.latitude && patient?.longitude) || (isPickup && store?.latitude && store?.longitude)) &&
                    <a
                      href={(() => {
                        if (!isPickup && patient?.latitude && patient?.longitude) {
                          return `https://www.google.com/maps/dir/?api=1&destination=${patient.latitude},${patient.longitude}`;
                        } else if (isPickup && store?.latitude && store?.longitude) {
                          return `https://www.google.com/maps/dir/?api=1&destination=${store.latitude},${store.longitude}`;
                        }
                      })()}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()} className="flex items-center justify-center w-12 h-12 md:w-11 md:h-11 rounded-full bg-blue-100 hover:bg-blue-200 text-blue-600 transition-colors">
                      <Navigation className="w-6 h-6 md:w-5 md:h-5" />
                    </a>
                  }
                </div>
              }
            </div>
          </div>}

          {/* Delete Confirmation Dialog - Portal to body for proper z-index */}
          <StopCardConfirmDialogs
            showDeleteConfirm={showDeleteConfirm} setShowDeleteConfirm={setShowDeleteConfirm}
            isPickup={isPickup} delivery={delivery} displayName={displayName} displayAddress={displayAddress}
            store={store} pendingPickups={pendingPickups} availableTransferPickups={availableTransferPickups}
            selectedTransferPickupId={selectedTransferPickupId} setSelectedTransferPickupId={setSelectedTransferPickupId}
            allDeliveries={allDeliveries} onDeleteDelivery={onDeleteDelivery}
            showReturnConfirm={showReturnConfirm} returnPatient={returnPatient}
            handleCancelReturn={handleCancelReturn} handleConfirmReturn={handleConfirmReturn}
            isCreatingReturn={isCreatingReturn} driver={driver} patient={patient}
          />

          {/* Fullscreen Image Viewer */}
          <StopCardPOD
            delivery={delivery} displayName={displayName} isNextDelivery={isNextDelivery}
            isFinishedDelivery={isFinishedDelivery} isPickup={isPickup}
            viewingImageUrl={viewingImageUrl} setViewingImageUrl={setViewingImageUrl}
            showSignatureCapture={showSignatureCapture} setShowSignatureCapture={setShowSignatureCapture}
            showPhotoCapture={showPhotoCapture} setShowPhotoCapture={setShowPhotoCapture}
            forceRefreshDriverDeliveries={forceRefreshDriverDeliveries}
            showButtons={false}
          />

          {/* Failure Reason Dialog */}
          <FailureReasonDialog
            isOpen={showFailureReasonDialog}
            onClose={() => {
              setShowFailureReasonDialog(false);
              setPendingFailureStatus(null);
            }}
            onConfirm={async (reason) => {
              const status = pendingFailureStatus;

              try {
                setShowFailureReasonDialog(false);
                setPendingFailureStatus(null);
                setIsFailing(true);

                fabControlEvents.deactivateFAB();
                smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
                await new Promise((resolve) => setTimeout(resolve, 50));

                // CRITICAL: Verify delivery still exists before updating
                const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
                if (!deliveryExists || deliveryExists.length === 0) {
                  console.warn('⚠️ [FAILURE] Delivery no longer exists - aborting');
                  toast.error('This delivery has been deleted. Please refresh the page.');
                  return;
                }

                await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                // Add reason to delivery notes
                const existingNotes = delivery.delivery_notes || '';
                const updatedNotes = existingNotes ?
                  `${existingNotes}\n[${status.toUpperCase()}] ${reason}` :
                  `[${status.toUpperCase()}] ${reason}`;

                // CRITICAL: Round completion time to nearest 5-minute mark
                const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES);

                // CRITICAL: Save to both offline and online databases
                try {
                  await updateDeliveryLocal(delivery.id, {
                    status: status,
                    delivery_notes: updatedNotes,
                    actual_delivery_time: localTimeString
                  }, { skipSmartRefresh: true });

                  // Also call onStatusUpdate if available for additional UI updates
                  if (onStatusUpdate) {
                    await onStatusUpdate(delivery.id, status, {
                      delivery_notes: updatedNotes,
                      actual_delivery_time: localTimeString
                    }, false);
                  }
                } catch (statusError) {
                  console.error('❌ [FAILURE] Update failed:', statusError);
                  toast.error(`Failed to update status: ${statusError.message}`);
                  fabControlEvents.reactivateFAB(true);
                  return;
                }

                // Check if this is the FINAL stop
                const allDriverDeliveries = allDeliveries.filter((d) =>
                  d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                );
                const incompleteAfterThis = allDriverDeliveries.filter((d) =>
                  d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending'
                );

                if (incompleteAfterThis.length === 0) {
                  fabControlEvents.notifyDoneButtonClicked();
                  window.dispatchEvent(new CustomEvent('showRouteSummary', {
                    detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                  }));

                  if (currentUser?.id) {
                    const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
                    if (appUsers && appUsers.length > 0) {
                      const appUser = appUsers[0];
                      await base44.entities.AppUser.update(appUser.id, {
                        driver_status: 'off_duty',
                        location_tracking_enabled: false
                      });
                      locationTracker.stopTracking();
                      if (onDriverStatusChange) {
                        onDriverStatusChange('off_duty');
                      }
                    }
                  }
                }

                // CRITICAL: Run recursive route optimization after failure
                try {
                  const now = new Date();
                  const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                  await base44.functions.invoke('optimizeRouteRealTime', {
                    driverId: delivery.driver_id,
                    deliveryDate: delivery.delivery_date,
                    currentLocalTime: currentLocalTime,
                    generatePolyline: false
                  });

                  // CRITICAL: Refresh UI to show reordered stops
                  invalidate('Delivery');
                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                  // CRITICAL: Trigger map update
                  window.dispatchEvent(new CustomEvent('routeOptimizationComplete'));
                } catch (optimizeError) {
                  console.warn('⚠️ [Failed/Cancelled] Route optimizer failed:', optimizeError);
                }

                // CRITICAL: Find next incomplete delivery and set isNextDelivery flag
                const driverDeliveries = allDeliveries.filter((d) =>
                  d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                );
                const incompleteDeliveries = driverDeliveries.filter((d) =>
                  d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending'
                ).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

                if (incompleteDeliveries.length > 0) {
                  await updateDeliveryLocal(incompleteDeliveries[0].id, { isNextDelivery: true }, { skipSmartRefresh: true });
                  
                  // Final refresh to show isNextDelivery update
                  invalidate('Delivery');
                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                }

                // Notify dispatchers
                if (userHasRole(currentUser, 'driver')) {
                  await notifyDriverFailed({
                    driver: currentUser,
                    patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                    delivery: { ...delivery, delivery_notes: updatedNotes },
                    store,
                    appUsers,
                    failureReason: reason
                  });
                }

                toast.success(`${isPickup ? 'Pickup' : 'Delivery'} marked as ${status}`, {
                  description: `Dispatch has been notified. Reason: ${reason}`
                });

                // CRITICAL: Collapse ALL cards after marking as failed/cancelled
                if (typeof window !== 'undefined') {
                  window.dispatchEvent(new CustomEvent('collapseAllStopCards'));
                }

              } catch (error) {
                console.error('❌ [FAILURE] Error:', error);
                toast.error(`Failed to mark as ${status}: ${error.message}`);
              } finally {
                setIsFailing(false);
                fabControlEvents.reactivateFAB(true);
              }
            }}
            deliveryName={displayName}
            isPickup={isPickup}
            statusType={pendingFailureStatus} />




          <StopCardBody
            isExpanded={isExpanded}
            isStrippedForDispatcher={isStrippedForDispatcher}
            finalDisplayPhone={finalDisplayPhone}
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
            onEditDelivery={onEditDelivery}
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
          />

          {/* FOOTER SECTION - Driver/Dispatcher-stripped: hide UNLESS Retry or Return buttons are available */}
          {(() => {
            // For drivers: hide footer unless Retry or Return buttons are available
            if (isStrippedForDriver) {
              const hasRetryButton = delivery.status === 'failed' && canRetry && !hasFutureRetry && !hasCompletedDelivery;
              const hasReturnButton = delivery.status === 'failed' && !isPickup && !hasFutureReturn && !hasCompletedDelivery;
              if (!hasRetryButton && !hasReturnButton) return null;
            }

            // For dispatchers: hide footer completely for non-assigned store deliveries
            if (isStrippedForDispatcher) return null;

            // CRITICAL: Show footer for finished deliveries UNLESS route is complete AND card is collapsed
            // Show if: not finished OR expanded OR (finished but route not complete)
            const shouldShowFooter = !isFinishedDelivery || isExpanded || (isFinishedDelivery && !isRouteCompleted);
            return isAssignedDriverOrAppOwner && shouldShowFooter;
          })() && <div className="space-y-3 mt-2">
            <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
              <div className="mt-2 mx-auto pb-1 flex justify-between items-center">
                {(isAssignedDriverOrAppOwner || canEdit) &&
                  <>
                    {/* FAILED DELIVERY FOOTER - Special layout */}
                    {delivery.status === 'failed' && !isPickup ?
                      <div className="flex items-center gap-2 w-full">
                        {/* 1. Retry button */}
                        {onStatusUpdate &&
                          <Button
                            onClick={async (e) => {
                              e.stopPropagation();

                              fabControlEvents.deactivateFAB();
                              setIsRetrying(true);
                              setIsProcessingBackground(true);
                              const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                              driverLocationPoller.pause();

                              await new Promise((resolve) => setTimeout(resolve, 50));

                              try {
                                const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
                                if (!deliveryExists || deliveryExists.length === 0) {
                                  console.warn('⚠️ [RETRY] Delivery no longer exists - aborting');
                                  throw new Error('This delivery has been deleted. Please refresh the page.');
                                }

                                await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                                await ensureDriverOnline();

                                // Find next tracking number within the same group of 20
                                const originalTR = parseInt(delivery.tracking_number, 10);
                                const groupStart = Math.floor(originalTR / 20) * 20;
                                const groupEnd = groupStart + 19;
                                
                                const driverDeliveries = allDeliveries.filter((d) =>
                                  d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                                );
                                const existingTRsInGroup = driverDeliveries
                                  .map((d) => parseInt(d.tracking_number, 10))
                                  .filter((tr) => !isNaN(tr) && tr >= groupStart && tr <= groupEnd);
                                
                                const nextTR = existingTRsInGroup.length > 0 ? Math.max(...existingTRsInGroup) + 1 : groupStart;

                                // Create duplicate delivery
                                const retryDelivery = {
                                  ...delivery,
                                  status: 'in_transit',
                                  tracking_number: String(nextTR),
                                  delivery_notes: '[Redelivered]',
                                  actual_delivery_time: null,
                                  isNextDelivery: false,
                                  signature_image_url: null,
                                  proof_photo_urls: [],
                                  cod_payments: []
                                };

                                // Remove internal fields
                                delete retryDelivery.id;
                                delete retryDelivery.created_date;
                                delete retryDelivery.updated_date;
                                delete retryDelivery.created_by;

                                const newDelivery = await base44.entities.Delivery.create(retryDelivery);
                                try {
                                  const now = new Date();
                                  const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                                  await base44.functions.invoke('optimizeRouteRealTime', {
                                    driverId: delivery.driver_id,
                                    deliveryDate: delivery.delivery_date,
                                    currentLocalTime: currentLocalTime,
                                    generatePolyline: false
                                  });

                                  invalidate('Delivery');
                                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                                } catch (optimizeError) {
                                  console.warn('⚠️ [Retry] Route optimizer failed:', optimizeError);
                                }

                                window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                                  detail: { triggeredBy: 'retry', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                                }));

                                if (userHasRole(currentUser, 'driver')) {
                                  await notifyDriverRetry({
                                    driver: currentUser,
                                    patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                                    delivery,
                                    store,
                                    appUsers
                                  });
                                }
                              } finally {
                                const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                                driverLocationPoller.resume();

                                setIsRetrying(false);
                                setIsProcessingBackground(false);
                                fabControlEvents.reactivateFAB(true);
                              }
                            }}
                            size="sm"
                            className="bg-blue-600 hover:bg-blue-700 h-10 md:h-8 !text-white text-sm md:text-xs flex-1"
                            disabled={isRetrying || isProcessingBackground || !canRetry || hasFutureRetry || hasCompletedDelivery || shouldDisableRetryReturn || isFailing}>
                            {isRetrying || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
                            <span className="text-white">Retry</span>
                          </Button>
                        }

                        {/* 2. Return button */}
                        <Button
                          onClick={handleReturnClick}
                          size="sm"
                          className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow rounded-md px-4 md:px-3 text-sm md:text-xs bg-orange-600 hover:bg-orange-700 !text-white h-10 md:h-8 flex-1"
                          disabled={isPreparingReturn || isCreatingReturn || hasFutureReturn || hasCompletedDelivery || shouldDisableRetryReturn || isFailing}>
                          {isPreparingReturn || isCreatingReturn ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Undo2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
                          Return
                        </Button>

                        {/* 3. Restart button */}
                        {onRestart && delivery.delivery_date === format(new Date(), 'yyyy-MM-dd') && !isRouteCompleted &&
                          <Button
                            onClick={async (e) => {
                              e.stopPropagation();
                              fabControlEvents.deactivateFAB();
                              setIsRestarting(true);
                              setIsEntityUpdating(true);
                              setIsProcessingBackground(true);
                              const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                              driverLocationPoller.pause();

                              await new Promise((resolve) => setTimeout(resolve, 100));

                              try {
                                const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
                                if (!deliveryExists || deliveryExists.length === 0) {
                                  console.warn('⚠️ [RESTART] Delivery no longer exists - aborting');
                                  throw new Error('This delivery has been deleted. Please refresh the page.');
                                }

                                const driverDeliveries = allDeliveries.filter((d) =>
                                  d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                                );

                                for (const d of driverDeliveries) {
                                  if (d.isNextDelivery) {
                                    await updateDeliveryLocal(d.id, { isNextDelivery: false }, { skipSmartRefresh: true });
                                  }
                                }

                                const newStatus = isPickup ? 'en_route' : 'in_transit';
                                await updateDeliveryLocal(delivery.id, {
                                  status: newStatus,
                                  isNextDelivery: true,
                                  actual_delivery_time: null,
                                  delivery_notes: ''
                                }, { skipSmartRefresh: true });

                                try {
                                  const now = new Date();
                                  const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                                  await base44.functions.invoke('optimizeRouteRealTime', {
                                    driverId: delivery.driver_id,
                                    deliveryDate: delivery.delivery_date,
                                    currentLocalTime: currentLocalTime,
                                    generatePolyline: false
                                  });

                                  invalidate('Delivery');
                                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                                } catch (optimizeError) {
                                  console.warn('⚠️ [Restart Delivery] Route optimizer failed:', optimizeError);
                                }

                                invalidate('Delivery');
                                await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                                window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                                  detail: { triggeredBy: 'restart', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                                }));

                                if (userHasRole(currentUser, 'driver')) {
                                  await notifyDriverRetry({
                                    driver: currentUser,
                                    patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                                    delivery, store, appUsers
                                  });
                                }
                              } finally {
                                const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                                driverLocationPoller.resume();

                                fabControlEvents.reactivateFAB(true);
                                setIsProcessingBackground(false);
                              }
                            }}
                            size="sm"
                            className="bg-blue-600 hover:bg-blue-700 h-10 md:h-8 !text-white text-sm md:text-xs flex-1"
                            disabled={isProcessingBackground}>
                            <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />
                            <span className="text-white">Restart</span>
                          </Button>
                        }

                        {/* 4. Menu button */}
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 md:h-8 md:w-8 border border-slate-300 hover:bg-slate-100 relative z-[10]"
                              onClick={(e) => e.stopPropagation()}>
                              <MoreVertical className="w-5 h-5 md:w-4 md:h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="p-1 rounded-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-[8rem] overflow-hidden border-2 shadow-md z-[200]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                            {onEditDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditDelivery(delivery); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                                <Edit className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                                Edit Delivery
                              </DropdownMenuItem>
                            }



                            {/* New: Update GPS above the divider - only for Next Delivery */}
                            {isNextDelivery && !isPickup && patient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
                              <DropdownMenuItem
                                onClick={async (e) => { e.stopPropagation(); await updatePatientGPS({ patientId: patient.id, storeId: delivery.store_id, stores }); }}
                                className="text-base md:text-sm py-2.5 md:py-1.5"
                              >
                                <Locate className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                                Update GPS
                              </DropdownMenuItem>
                            )}

                            {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                              <>
                                <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
                                <DropdownMenuItem
                                  onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
                                  className="text-red-600 text-base md:text-sm py-2.5 md:py-1.5"
                                  disabled={!userHasRole(currentUser, 'admin') && isRouteCompleted}>
                                  <Trash2 className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                                  Delete
                                </DropdownMenuItem>
                              </>
                            }
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    :
                      /* NON-FAILED DELIVERY FOOTER - Original layout */
                      <>
                        {/* Proof of Delivery Buttons - Only on next delivery, OR completed with captured proof */}
                        <StopCardPOD
                          delivery={delivery} displayName={displayName} isNextDelivery={isNextDelivery}
                          isFinishedDelivery={isFinishedDelivery} isPickup={isPickup}
                          viewingImageUrl={viewingImageUrl} setViewingImageUrl={setViewingImageUrl}
                          showSignatureCapture={showSignatureCapture} setShowSignatureCapture={setShowSignatureCapture}
                          showPhotoCapture={showPhotoCapture} setShowPhotoCapture={setShowPhotoCapture}
                          forceRefreshDriverDeliveries={forceRefreshDriverDeliveries}
                        />

                        {/* Start/Complete/Restart button and menu - right aligned */}
                        <div className="flex items-center ml-auto">

                        {/* Start button for active non-failed deliveries */}
                        {delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && (
                            isNextDelivery ?
                              <Button
                                onClick={async (e) => {
                                 e.stopPropagation();

                                 fabControlEvents.deactivateFAB();
                                 setIsCompleting(true);
                                 setIsProcessingBackground(true);
                                 const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                                 driverLocationPoller.pause();

                                 smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
                                 await new Promise((resolve) => setTimeout(resolve, 50));

                                  try {
                                    // CRITICAL: Verify delivery still exists before completing
                                    const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
                                    if (!deliveryExists || deliveryExists.length === 0) {
                                      console.warn('⚠️ [COMPLETE] Delivery no longer exists - aborting');
                                      throw new Error('This delivery has been deleted. Please refresh the page.');
                                    }

                                    await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                                    // Auto-toggle driver online if offline
                                    await ensureDriverOnline();

                                    // CRITICAL: Auto-collect COD if required and not already collected
                                    if (hasCODRequired && codPayments.length === 0 && onCODUpdate) {
                                      const autoCODPayment = [{
                                        type: 'Cash',
                                        amount: codTotalRequired
                                      }];

                                      // Update local state FIRST for immediate UI update
                                      setCodPayments(autoCODPayment);

                                      // Save COD payment to both databases
                                      await onCODUpdate(delivery.id, autoCODPayment, true);
                                    }

                                    // CRITICAL: For pickups with pending deliveries, trigger Accept All FIRST, then continue to complete pickup
                                    if (isPickup && pendingPickups && pendingPickups.length > 0) {
                                      const hasPendingDeliveries = pendingPickups.some((p) => p.status === 'pending');
                                      if (hasPendingDeliveries) {
                                        await handleAcceptAllStops();  // Continue execution - don't return early
                                      }
                                    }

                                    // ═══════════ PHASE 1: IMMEDIATE UI UPDATES ═══════════
                                    const localTimeString = generateCompletionTimestamp(delivery, allDeliveries, FINISHED_STATUSES); // Update status to completed with timestamp
                                    const completionUpdate = {
                                      status: 'completed',
                                      actual_delivery_time: localTimeString,
                                      isNextDelivery: false
                                    };

                                    // CRITICAL: Save to both offline and online databases
                                    await updateDeliveryLocal(delivery.id, completionUpdate, { skipSmartRefresh: true });
                                    // CRITICAL: Re-fetch ALL deliveries to ensure we see the newly transitioned deliveries
                                    const refreshedAfterAccept = await base44.entities.Delivery.filter({
                                      driver_id: delivery.driver_id,
                                      delivery_date: delivery.delivery_date
                                    });

                                    // Find and update next delivery flag
                                    const incompleteDeliveries = refreshedAfterAccept.
                                      filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending').
                                      sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

                                    if (incompleteDeliveries.length > 0) {
                                      const nextStop = incompleteDeliveries[0];
                                      await updateDeliveryLocal(nextStop.id, { isNextDelivery: true }, { skipSmartRefresh: true });
                                    } else {
                                      // CRITICAL: This is the FINAL stop - activate FAB phase 1 and show route summary
                                      // Activate FAB phase 1
                                      fabControlEvents.notifyDoneButtonClicked();

                                      // Show route summary popup
                                      window.dispatchEvent(new CustomEvent('showRouteSummary', {
                                        detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                                      }));

                                      // Toggle location sharing off and driver status to off_duty
                                      if (currentUser?.id) {
                                        const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
                                        if (appUsers && appUsers.length > 0) {
                                          const appUser = appUsers[0];
                                          await base44.entities.AppUser.update(appUser.id, {
                                            driver_status: 'off_duty',
                                            location_tracking_enabled: false
                                          });

                                          // Stop location tracking
                                          try {
                                            locationTracker.stopTracking();
                                          } catch (trackingError) {
                                            console.warn('Could not stop location tracking:', trackingError.message);
                                          }

                                          // Notify parent to refresh UI
                                          if (onDriverStatusChange) {
                                            onDriverStatusChange('off_duty');
                                          }
                                        }
                                      }
                                    }

                                    // Force UI refresh with ONLY local data (skip API call)
                                    invalidate('Delivery');

                                    // CRITICAL: Use local data only to avoid slow API call
                                    if (updateDeliveriesLocally) {
                                     const updatedDeliveries = allDeliveries.map(d => {
                                       if (d.id === delivery.id) {
                                         return { ...d, ...completionUpdate };
                                       }
                                       if (incompleteDeliveries.length > 0 && d.id === incompleteDeliveries[0].id) {
                                         return { ...d, isNextDelivery: true };
                                       }
                                       return d;
                                     });
                                     updateDeliveriesLocally(updatedDeliveries, true);
                                    }

                                    // CRITICAL: Trigger map and stop cards update immediately
                                    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                                      detail: { triggeredBy: 'complete', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                                    }));

                                    // CRITICAL: Collapse ALL cards first
                                    if (typeof window !== 'undefined') {
                                      window.dispatchEvent(new CustomEvent('collapseAllStopCards'));
                                    }

                                    // CRITICAL: Scroll to next delivery card immediately
                                    if (incompleteDeliveries.length > 0) {
                                      setTimeout(() => {
                                        const nextCardElement = document.getElementById(`stop-card-${incompleteDeliveries[0].id}`);
                                        if (nextCardElement) {
                                          nextCardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                        }
                                      }, 100);
                                    }

                                    // CRITICAL: Reactivate FAB immediately (before background work)
                                    fabControlEvents.reactivateFAB(true);
                                    // ═══════════ PHASE 2: BACKGROUND TASKS ═══════════
                                    setIsProcessingBackground(true);

                                    // Background: Route optimization (fire and forget - don't wait)
                                    Promise.all([
                                     base44.functions.invoke('optimizeRouteRealTime', {
                                       driverId: delivery.driver_id,
                                       deliveryDate: delivery.delivery_date,
                                       currentLocalTime: format(new Date(), 'HH:mm'),
                                       generatePolyline: false
                                     }).then(() => {
                                       window.dispatchEvent(new CustomEvent('routeOptimizationComplete'));
                                     }).catch((err) => console.warn('⚠️ [COMPLETE] Background optimization failed:', err)),

                                     // Background: Send notification
                                     userHasRole(currentUser, 'driver') ? notifyDriverCompleted({
                                       driver: currentUser,
                                       patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                                       delivery,
                                       store,
                                       appUsers
                                     }).catch((err) => console.warn('Notification failed:', err)) : Promise.resolve(),

                                     // Background: AI route re-optimization
                                     triggerRouteOptimization({
                                       driverId: currentUser.id,
                                       deliveryDate: format(new Date(), 'yyyy-MM-dd'),
                                       trigger: 'delivery_complete',
                                       completedDeliveryId: delivery.id,
                                       onNotification: (notification) => {
                                         if (notification.type === 'next_stop') {
                                           toast.success(notification.message, {
                                             description: notification.aiSuggestion
                                           });
                                         }
                                       }
                                     }).catch((err) => console.warn('Route optimization failed:', err))
                                    ]).finally(() => {
                                     setIsProcessingBackground(false);
                                    });

                                  } catch (error) {
                                  console.error('❌ [COMPLETE] Error:', error);
                                  fabControlEvents.reactivateFAB(true);
                                  setIsProcessingBackground(false);
                                  setIsCompleting(false);
                                  } finally {
                                  const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                                  driverLocationPoller.resume();

                                   // Reset UI flags after completion success
                                   setIsCompleting(false);
                                   setIsProcessingBackground(false);

                                   // CRITICAL: Collapse ALL cards after completion
                                  if (typeof window !== 'undefined') {
                                    window.dispatchEvent(new CustomEvent('collapseAllStopCards'));
                                  }
                                  }
                                }}
                                size="sm"
                                disabled={isCompleting || isProcessingBackground || isFailing}
                                className={`rounded-md px-4 md:px-3 text-sm md:text-xs font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow h-10 md:h-8 border-r !text-white ${
                                  isFailing ? 'bg-red-600 hover:bg-red-700 border-red-500' : 'bg-emerald-600 hover:bg-emerald-700 border-emerald-500'
                                }`}>
                                {isCompleting || isFailing ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <CheckCircle className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
                                <span className="text-white">Complete</span>
                              </Button> :
                              onStartDelivery &&
                              <Button type="button" onClick={async (e) => {
                                e.stopPropagation();
                                setIsStarting(true);
                                setIsEntityUpdating(true);
                                
                                fabControlEvents.deactivateFAB();
                                const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                                driverLocationPoller.pause();

                                try {
                                  // Get all driver deliveries
                                  const driverDeliveries = allDeliveries.filter((d) =>
                                    d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                                  );

                                  // Ensure single isNextDelivery atomically on the server
                                  await base44.functions.invoke('setNextDeliveryFlag', {
                                    driverId: delivery.driver_id,
                                    deliveryDate: delivery.delivery_date,
                                    targetDeliveryId: delivery.id
                                  });

                                  // Set this delivery as isNextDelivery with status update
                                  const now = new Date();
                                  const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                                  // Backend safety handled earlier with awaited setNextDeliveryFlag
                                  
                                  await updateDeliveryLocal(delivery.id, {
                                    status: isPickup ? 'en_route' : 'in_transit',
                                    delivery_time_start: currentLocalTime
                                  }, { skipSmartRefresh: true });

                                  // Refresh UI
                                  invalidate('Delivery');
                                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                                  // Trigger map update
                                  window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                                    detail: { triggeredBy: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                                  }));

                                  // Background tasks (fire and forget)
                                  Promise.all([
                                    base44.functions.invoke('optimizeRouteRealTime', {
                                      driverId: delivery.driver_id,
                                      deliveryDate: delivery.delivery_date,
                                      currentLocalTime: currentLocalTime,
                                      generatePolyline: false
                                    }).then(() => {
                                      window.dispatchEvent(new CustomEvent('routeOptimizationComplete'));
                                    }),
                                    ensureDriverOnline(),
                                    userHasRole(currentUser, 'driver') ? notifyDriverStarted({
                                      driver: currentUser,
                                      patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                                      delivery,
                                      store,
                                      appUsers
                                    }) : Promise.resolve()
                                  ]).catch((err) => console.warn('Background tasks failed:', err));

                                } catch (error) {
                                  console.error('❌ [START] Error:', error);
                                  toast.error(`Failed to start: ${error.message}`);
                                } finally {
                                  driverLocationPoller.resume();
                                  fabControlEvents.reactivateFAB(true);
                                  setIsStarting(false);
                                  setIsEntityUpdating(false);
                                }
                              }} size="sm" disabled={isStarting || isProcessingBackground} className="bg-blue-600 px-4 md:px-3 text-sm md:text-xs font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-10 md:h-8 border-r border-blue-500 !text-white" title="Start this delivery">
                                {isStarting ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <Clock className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
                                <span className="text-white">Start</span>
                              </Button>
                          )}
                      
                      {/* Restart button for completed/cancelled on today's date when route not finished (NOT failed) */}
                      {delivery.status !== 'failed' && FINISHED_STATUSES.includes(delivery.status) && onRestart && delivery.delivery_date === format(new Date(), 'yyyy-MM-dd') && !isRouteCompleted &&
                        <Button
                          onClick={async (e) => {
                            e.stopPropagation();
                            fabControlEvents.deactivateFAB();
                            setIsRestarting(true);
                            setIsEntityUpdating(true);
                            setIsProcessingBackground(true);
                            const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                            driverLocationPoller.pause();

                            await new Promise((resolve) => setTimeout(resolve, 100));

                            try {
                              const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
                              if (!deliveryExists || deliveryExists.length === 0) {
                                console.warn('⚠️ [RESTART] Delivery no longer exists - aborting');
                                throw new Error('This delivery has been deleted. Please refresh the page.');
                              }
                              const driverDeliveries = allDeliveries.filter((d) =>
                                d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                              );

                              for (const d of driverDeliveries) {
                                if (d.isNextDelivery) {
                                  await updateDeliveryLocal(d.id, { isNextDelivery: false }, { skipSmartRefresh: true });
                                }
                              }

                              const newStatus = isPickup ? 'en_route' : 'in_transit';
                              await updateDeliveryLocal(delivery.id, {
                                status: newStatus,
                                isNextDelivery: true,
                                actual_delivery_time: null,
                                delivery_notes: ''
                              }, { skipSmartRefresh: true });

                              try {
                                const now = new Date();
                                const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                                await base44.functions.invoke('optimizeRouteRealTime', {
                                  driverId: delivery.driver_id,
                                  deliveryDate: delivery.delivery_date,
                                  currentLocalTime: currentLocalTime,
                                  generatePolyline: false
                                });
                                invalidate('Delivery');
                                await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                              } catch (optimizeError) {
                                console.warn('⚠️ [Restart Delivery] Route optimizer failed:', optimizeError);
                              }

                              invalidate('Delivery');
                              await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                              window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                                detail: { triggeredBy: 'restart', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                              }));

                              if (userHasRole(currentUser, 'driver')) {
                                await notifyDriverRetry({
                                  driver: currentUser,
                                  patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name, delivery, store, appUsers
                                });
                              }
                            } finally {
                              const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                              driverLocationPoller.resume();

                              fabControlEvents.reactivateFAB(true);
                              setIsProcessingBackground(false);
                              setIsRestarting(false);
                              setIsEntityUpdating(false);
                            }
                            }}
                            size="sm"
                            className="bg-blue-600 hover:bg-blue-700 h-10 md:h-8 rounded-r-none border-r border-blue-500 !text-white text-sm md:text-xs"
                            disabled={isRestarting || isProcessingBackground || isFailing}>
                            {isRestarting || isProcessingBackground ? <Loader2 className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-4 h-4 md:w-3 md:h-3 mr-1 !text-white" />}
                            <span className="text-white">Restart</span>
                            </Button>
                            }

                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon" className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-10 w-10 md:h-8 md:w-8 border border-slate-300 hover:bg-slate-100 relative z-[10]"

                            onClick={(e) => e.stopPropagation()}>
                            <MoreVertical className="w-5 h-5 md:w-4 md:h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="p-1 rounded-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-[8rem] overflow-hidden border-2 shadow-md z-[200]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                          {onEditDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditDelivery(delivery); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                              <Edit className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                              {isPickup ? 'Edit Pickup' : 'Edit Delivery'}
                            </DropdownMenuItem>
                          }

                          {/* Update GPS moved directly under Edit Delivery - only for Next Delivery */}
                          {isNextDelivery && !isPickup && patient && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
                            <DropdownMenuItem
                              onClick={async (e) => { e.stopPropagation(); await updatePatientGPS({ patientId: patient.id, storeId: delivery.store_id, stores }); }}
                              className="text-base md:text-sm py-2.5 md:py-1.5"
                            >
                              <Locate className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                              Update GPS
                            </DropdownMenuItem>
                          )}



                          {/* Failed/Cancel menu item - for active deliveries */}
                          {delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'failed' && isNextDelivery && onStatusUpdate &&
                            <>
                              <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingFailureStatus(isPickup ? 'cancelled' : 'failed');
                                  setShowFailureReasonDialog(true);
                                }}
                                className="text-red-600 text-base md:text-sm py-2.5 md:py-1.5">
                                <XCircle className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                                {isPickup ? 'Cancel Pickup' : 'Mark as Failed'}
                              </DropdownMenuItem>
                            </>
                          }



                          {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (onEditDelivery || !isPickup && patient && onEditPatient || isCompleted && onRestart && delivery.delivery_date === format(new Date(), 'yyyy-MM-dd')) && <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />}
                          {onDeleteDelivery && !isStrippedForDispatcher && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                            <DropdownMenuItem
                              onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(true); }}
                              className="text-red-600 text-base md:text-sm py-2.5 md:py-1.5"
                              disabled={!userHasRole(currentUser, 'admin') && isRouteCompleted}>
                              <Trash2 className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          }
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                      </>
                    }
                  </>
                }
              </div>
            </div>
          </div>}
        </CardContent>
      </Card>
    </motion.div>);
}