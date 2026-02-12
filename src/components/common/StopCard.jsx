import React, { useState, useRef, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactDOM from "react-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from
"@/components/ui/select";
import { Phone, MapPin, Edit, Trash2, StickyNote, RotateCcw, MoreVertical, User, CheckCircle, Clock, Package, XCircle, Info, FileText, Save, X, Plus, Undo2, Loader2, Navigation, GripVertical, Bell, BellOff, Mailbox } from "lucide-react";
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
import { format as formatDateFns } from "date-fns";
import {
  notifyDriverAcceptedAll,
  notifyDriverAcceptedOne,
  notifyDispatcherAssignedAll,
  notifyDriverStarted,
  notifyDriverCompleted,
  notifyDriverFailed,
  notifyDriverRetry,
  notifyDriverReturn
} from
"../utils/deliveryMessaging";
import { triggerRouteOptimization } from "../utils/realTimeRouteOptimizer";
import { toast } from "sonner";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import FailureReasonDialog from "../deliveries/FailureReasonDialog";
import { updateDeliveryLocal } from '../utils/offlineMutations';
import { fabControlEvents } from '../utils/fabControlEvents';
import { invalidate } from '../utils/dataManager';
import SignatureCapture from './SignatureCapture';
import PhotoCapture from './PhotoCapture';
import HelpTooltip, { HELP_CONTENT } from './HelpTooltip';
import { Pen, Camera } from 'lucide-react';

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
  delivery,
  store,
  driver,
  patients = [],
  currentUser,
  isExpanded: externalIsExpanded,
  showDriverName = false,
  onStatusUpdate,
  onNotesUpdate,
  onEditDelivery,
  onDeleteDelivery,
  onRestart,
  allDeliveries = [],
  selectedDate,
  onEditPatient,
  drivers = [],
  onDriverChange,
  canEdit = false,
  getDriverColor,
  onClick,
  isSelected,
  isProjected = false,
  pendingPickups = [],
  onSelectionChange,
  selectedDeliveryIds = [],
  stopOrder = {},
  onCODUpdate,
  stores = [],
  onCreateReturn,
  onStartDelivery,
  allStopsPending = false,
  onDriverStatusChange,
  appUsers = [],
  showDragHandle = false,
  dragHandleProps,
  compact = false
}) {
  // CRITICAL: Use delivery.isNextDelivery from the entity, not the prop
  const isNextDelivery = delivery?.isNextDelivery || false;
  // CRITICAL FIX: ALL HOOKS MUST BE CALLED UNCONDITIONALLY AT THE TOP
  // Initialize with delivery prop values to maintain consistency
  const [notesInput, setNotesInput] = useState(delivery?.delivery_notes || "No driver notes");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [codPayments, setCodPayments] = useState(delivery?.cod_payments || []);
  const [showCODCollection, setShowCODCollection] = useState(false);
  const [showReturnConfirm, setShowReturnConfirm] = useState(false);
  const [returnPatient, setReturnPatient] = useState(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPreparingReturn, setIsPreparingReturn] = useState(false);
  const [isProcessingBackground, setIsProcessingBackground] = useState(false);
  const [isAcceptingAll, setIsAcceptingAll] = useState(false);
  const [acceptingIndividual, setAcceptingIndividual] = useState({});
  const [showFailureReasonDialog, setShowFailureReasonDialog] = useState(false);
  const [pendingFailureStatus, setPendingFailureStatus] = useState(null);
  const [isFailing, setIsFailing] = useState(false);
  const [isCreatingReturn, setIsCreatingReturn] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const codAmountInputRefs = useRef([]);
  const { setIsEntityUpdating, forceRefreshDriverDeliveries, refreshData, updateDeliveriesLocally } = useAppData();
  const [showSignatureCapture, setShowSignatureCapture] = useState(false);
  const [showPhotoCapture, setShowPhotoCapture] = useState(false);
  const [selectedTransferPickupId, setSelectedTransferPickupId] = useState('');

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
        console.log('📥 [ensureDriverOnline] Offline DB empty - fetching from API');
        const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
        appUser = appUsers?.[0];
        
        // CRITICAL: Always save to offline DB immediately after API fetch
        if (appUsers && appUsers.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
          console.log(`💾 [ensureDriverOnline] Saved ${appUsers.length} app users to offline DB`);
        }
      }
      
      if (appUser && appUser.driver_status !== 'on_duty') {
        console.log('🔄 Auto-toggling driver to on_duty');
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

  const displayName = useMemo(() => {
    if (!delivery) return '';
    // For InterStore pickups, show the patient name (e.g., "Shoppers Callingwood(ISP)")
    if (isPickup && isInterStorePickup) {
      return delivery.patient_name || patient?.full_name || `${store?.name || 'Unknown Store'} Pickup`;
    }
    if (isPickup) return `${store?.name || 'Unknown Store'} Pickup`;
    return patient?.full_name || 'Unknown';
  }, [delivery, isPickup, isInterStorePickup, store, patient]);

  const displayAddress = useMemo(() => {
    if (!delivery) return '';
    if (isPickup) {
      // Clean buzzer numbers from store pickup addresses
      return cleanBuzzerFromAddress(store?.address || '');
    }
    return formatAddressWithUnit(patient?.address || "", patient?.unit_number || delivery.unit_number || "");
  }, [delivery, isPickup, store, patient]);

  const displayPhone = useMemo(() => {
    if (!delivery) return '';
    if (isPickup) {
      return store?.phone || '';
    }
    return patient?.phone || '';
  }, [delivery, isPickup, store, patient]);

  const isRouteCompleted = useMemo(() => {
    if (!delivery || !allDeliveries || !Array.isArray(allDeliveries)) return false;

    const driverDeliveriesForDate = allDeliveries.filter((d) => {
      if (!d) return false;
      return d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id;
    });

    if (driverDeliveriesForDate.length === 0) return false;

    return driverDeliveriesForDate.every((d) => FINISHED_STATUSES.includes(d.status));
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

  const shouldRedact = useMemo(() => {
    if (!delivery || !currentUser) return false;
    // Never redact regular pickups, InterStore deliveries, or InterStore pickups
    if (isPickup || isInterStore || isInterStorePickup) return false;
    // Redact completed deliveries for drivers (not admins/dispatchers)
    if (isCompleted &&
      !userHasRole(currentUser, 'admin') &&
      !userHasRole(currentUser, 'dispatcher') &&
      userHasRole(currentUser, 'driver')) {
      return true;
    }
    // Redact when route is complete for drivers
    if (isRouteCompleted &&
      !userHasRole(currentUser, 'admin') &&
      !userHasRole(currentUser, 'dispatcher') &&
      userHasRole(currentUser, 'driver')) {
      return true;
    }
    return false;
  }, [isCompleted, isPickup, isInterStore, isInterStorePickup, currentUser, delivery, isRouteCompleted]);

  const shouldShowStoreBadge = useMemo(() => shouldShowStoreBadges(currentUser), [currentUser]);

  const finalDisplayName = useMemo(() => {
    // InterStore stops (pickups and dropoffs) are store data, never redact
    if (isInterStore || isInterStorePickup) {
      return displayName;
    }
    if (isStrippedDelivery && !shouldRedact) {
      if (store?.name) {
        return `${store.name} ${isPickup ? 'Pickup' : 'Delivery'}`;
      }
      return isPickup ? 'Other Store Pickup' : 'Other Store Delivery';
    }
    if (!shouldRedact) return displayName;
    const firstName = patient?.full_name?.split(' ')[0] || '';
    return firstName + ' *****';
  }, [isStrippedDelivery, shouldRedact, displayName, patient, isPickup, store, isInterStore, isInterStorePickup]);

  const finalDisplayAddress = useMemo(() => {
    // InterStore stops are store data, never redact
    if (isInterStore || isInterStorePickup) return displayAddress;
    if (isStrippedDelivery) return '';
    if (!shouldRedact) return displayAddress;
    const firstPart = displayAddress?.split(' ')[0] || '';
    return firstPart + ' *****';
  }, [isStrippedDelivery, shouldRedact, displayAddress, isInterStore, isInterStorePickup]);

  const finalDisplayPhone = useMemo(() => {
    // InterStore stops are store data, never redact
    if (isInterStore || isInterStorePickup) return displayPhone;
    if (isStrippedDelivery) return null;
    if (!shouldRedact) return displayPhone;
    if (!displayPhone) return null;
    return `(***) ***-${displayPhone.replace(/\D/g, '').slice(-4)}`;
  }, [isStrippedDelivery, shouldRedact, displayPhone, isInterStore, isInterStorePickup]);

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
        console.log('💾 [COD Save] Saving payments:', codPayments);
        console.log('💾 [COD Save] Current delivery cod_payments:', delivery?.cod_payments);

        // Pass skipAutoCenter=true to prevent card scrolling after COD save
        await onCODUpdate(delivery.id, codPayments, true);

        console.log('✅ [COD Save] onCODUpdate completed');
        setShowCODCollection(false);
      } catch (error) {
        console.error('❌ [COD Save] Failed:', error);
        alert(`Failed to save COD: ${error.message}`);
      }
    }
  };

  const handleAcceptAllStops = async () => {
    setIsAcceptingAll(true);
    try {
      console.log('🟢 [Accept All] PHASE 1: Pausing and transitioning all pending stops...');
      const { driverLocationPoller } = await import('../utils/driverLocationPoller');
      driverLocationPoller.pause();
      smartRefreshManager.pause();
      setIsEntityUpdating(true);

      const allPendingDeliveries = pendingPickups.filter((p) => p.status === 'pending');
      console.log(`  Found ${allPendingDeliveries.length} pending deliveries`);

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

      const statusUpdatePromises = sortedPending.map((pendingDelivery, i) =>
        updateDeliveryLocal(pendingDelivery.id, {
          status: 'in_transit',
          delivery_time_start: deliveryTimeStart,
          tracking_number: String(baseTR + i + 1)
        }, { skipSmartRefresh: true })
      );

      await Promise.all(statusUpdatePromises);
      console.log(`✅ Updated ${allPendingDeliveries.length} deliveries to in_transit with TR#s`);

      // Batch Square COD item creation
      const codPromises = allPendingDeliveries
        .filter(pd => pd.cod_total_amount_required > 0 && pd.patient_id)
        .map(async (pendingDelivery) => {
          try {
            const storeForCod = stores.find((s) => s && s.id === pendingDelivery.store_id);
            await base44.functions.invoke('squareCreateCodItem', {
              deliveryId: pendingDelivery.id,
              patientName: pendingDelivery.patient_name,
              storeAbbreviation: storeForCod?.abbreviation || '',
              codAmount: pendingDelivery.cod_total_amount_required,
              deliveryDate: pendingDelivery.delivery_date,
              storeId: pendingDelivery.store_id
            });
          } catch (squareError) {
            console.error('⚠️ [Square] Failed to create COD item:', squareError);
          }
        });

      if (codPromises.length > 0) {
        await Promise.all(codPromises);
        console.log(`✅ Created ${codPromises.length} Square COD items`);
      }

      console.log('✅ [Accept All] PHASE 1 Complete - All transitions done');

      // ═══════════ PHASE 2: SINGLE UI UPDATE ═══════════
      console.log('🎯 [Accept All] PHASE 2: Single UI update...');
      
      invalidate('Delivery');
      await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
      
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { triggeredBy: 'acceptAll', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
      }));
      window.dispatchEvent(new CustomEvent('pendingToInTransit', {
        detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
      }));
      
      console.log('✅ [Accept All] PHASE 2 Complete - UI updated');

      // ═══════════ PHASE 3: BACKEND OPTIMIZATION ═══════════
      console.log('🔄 [Accept All] PHASE 3: Running backend route optimization...');
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
        console.log('✅ [Accept All] Backend optimization complete');
      } finally {
        // CRITICAL: Mark that optimization is complete - prevents RealTimeRouteOptimizer from re-running
        window.dispatchEvent(new CustomEvent('routeOptimizationComplete', {
          detail: { source: 'accept_all', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
        }));
      }

      // ═══════════ PHASE 4: FINAL UI UPDATE ═══════════
      console.log('🎯 [Accept All] PHASE 4: Final UI update with optimized route from backend...');
      
      invalidate('Delivery');
      await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
      
      // CRITICAL: Dispatch event with flag indicating data is already optimized
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { 
          triggeredBy: 'acceptAllOptimized', 
          driverId: delivery.driver_id, 
          deliveryDate: delivery.delivery_date,
          alreadyOptimized: true 
        }
      }));
      
      console.log('✅ [Accept All] All phases complete - data optimized by backend');

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
        console.log('🔄 [Return] Running optimizeRouteRealTime...');
        await base44.functions.invoke('optimizeRouteRealTime', {
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          currentLocalTime: currentLocalTime,
          generatePolyline: false
        });
        console.log('✅ [Return] Route optimized');

        // CRITICAL: Refresh UI to show reordered stops
        invalidate('Delivery');
        await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
        console.log('✅ [Return] UI refreshed with new stop order');
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

            <div className="flex flex-col py-0. gap-0.5  items-center">
              <Badge
                variant="secondary" className="bg-secondary text-white mt-1 px-2 py-0.5 text-sm font-bold rounded-full inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80 w-[40px] justify-center"
                style={{
                  backgroundColor: storeColor || '#10B981',
                  color: 'white'
                }}>
                #{delivery.display_stop_order || delivery.stop_order || 0}
              </Badge>

              {isPickup && pendingPickups && pendingPickups.length > 0 &&
                <Badge
                  variant="secondary" className="bg-purple-500 text-secondary-foreground mt-1 px-2 text-sm font-bold rounded-lg inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80 !text-white justify-center">

                  P: {pendingPickups.length}
                </Badge>
              }

              <SpecialSymbolsBadges
                delivery={delivery}
                patient={patient}
                isPickup={isPickup}
                size="card"
                className="mt-1" />

            </div>

            <div className="flex-1 min-w-0">
              <h3 className="pt-0 text-2xl md:text-xl font-semibold text-center truncate" style={{ color: 'var(--text-slate-900)' }}>
                {finalDisplayName}
              </h3>
              <div className="flex flex-col items-center min-h-[40px]">
                <div className="text-lg md:text-sm flex items-center justify-center" style={{ color: 'var(--text-slate-600)' }}>
                  {FINISHED_STATUSES.includes(delivery.status) && delivery.actual_delivery_time ?
                    <>
                      <Clock className="w-3 h-3" />
                      <span className="font-medium">{formatTime12Hour(format(new Date(delivery.actual_delivery_time), 'HH:mm'))}</span>
                    </> :

                    <span className="font-medium">ETA: {formatTime12Hour(
                      delivery.delivery_time_eta || (
                        isPickup ? delivery.delivery_time_start : null) ||
                      delivery.delivery_time_start ||
                      delivery.time_window_start ||
                      '--:--'
                    )}</span>
                  }
                  {showDriverName && safeDriver &&
                    <>
                      <span className="px-1 py-0.5 text-xs font-semibold opacity-60 rounded-full inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80" style={{ color: 'var(--text-slate-500)' }}>•</span>
                      <Badge
                        variant="secondary" className="inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80 px-2 py-0.5 rounded-full text-xs !text-white  font-semibold"
                        style={{ backgroundColor: driverBadgeColor, color: driverBadgeTextColor }}>
                        {getDriverDisplayName(safeDriver)}
                      </Badge>
                    </>
                  }
                </div>
                {/* Time Window - Only for non-finished stops */}
                {!FINISHED_STATUSES.includes(delivery.status) && (delivery.time_window_start || delivery.time_window_end) &&
                  <div className="text-sm md:text-[11px]" style={{ color: 'var(--text-slate-500)' }}>
                    {delivery.time_window_start && delivery.time_window_end ?
                      <>{formatTime12Hour(delivery.time_window_start)} → {formatTime12Hour(delivery.time_window_end)}</> :
                      delivery.time_window_start ?
                        <>{formatTime12Hour(delivery.time_window_start)} →</> :
                        delivery.time_window_end ?
                          <>← {formatTime12Hour(delivery.time_window_end)}</> :
                          null}
                  </div>
                }
                {/* Driver Pay for Finished Stops - Drivers and Admins */}
                {FINISHED_STATUSES.includes(delivery.status) && (
                  userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')) && (
                  delivery.patient_id || delivery.after_hours_pickup) && (() => {
                  // For drivers viewing their own deliveries, use their own pay rates
                  // For admins, use the assigned driver's pay rates
                  // CRITICAL: delivery.driver_id IS the user_id (auth user ID), NOT AppUser.id
                  let driverAppUser = null;

                  if (appUsers && appUsers.length > 0) {
                    if (userHasRole(currentUser, 'admin')) {
                      // For admin: find AppUser by matching user_id to delivery.driver_id
                      driverAppUser = appUsers.find((au) => au?.user_id === delivery.driver_id);
                    } else {
                      // For driver: find their own AppUser record
                      driverAppUser = appUsers.find((au) => au?.user_id === currentUser?.id);
                    }
                  }

                  // If no appUsers array, try using driver prop if it has pay rates
                  if (!driverAppUser && driver && driver.pay_rate_per_delivery) {
                    driverAppUser = driver;
                  }

                  const pay = driverAppUser ? calculateDeliveryPay(delivery, driverAppUser, patient) : 0;
                  const baseRate = driverAppUser?.pay_rate_per_delivery || 0;
                  const isAfterHours = delivery.after_hours_pickup === true;
                  const hasExtraPay = pay > baseRate && !isAfterHours;

                  // No badge for base pay only
                  if (!isAfterHours && !hasExtraPay) {
                    return (
                      <div className="text-xm font-bold text-emerald-600">
                        {formatPay(pay)}
                      </div>);

                  }

                  // Badge for extra pay or after hours
                  return (
                    <Badge
                      variant="secondary" className="inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80 text-xm font-bold px-2 py-0.5 rounded-full bg-green-200 !text-gray-800">
                      {formatPay(pay)}
                    </Badge>);

                })()}
              </div>
            </div>

            <div className="flex flex-col py-0.5 gap-0.5 items-center">
              <div className="flex items-center gap-1">
                <Badge
                  variant="secondary"
                  className={`text-secondary-foreground mt-1 px-2 text-sm font-bold rounded-full hover:bg-secondary/80 border-transparent inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                    isReturnDelivery ? 'bg-orange-500' :
                      delivery.status === 'failed' || delivery.status === 'cancelled' ? 'bg-red-500' : 'bg-emerald-500'}`
                  }
                  style={{ color: isPickup && delivery.after_hours_pickup && FINISHED_STATUSES.includes(delivery.status) ? '#3b82f6' : 'white' }}>
                  {isReturnDelivery ? 'Return' : statusConfig[delivery.status]?.label || delivery.status}
                </Badge>
              </div>

              {delivery.tracking_number && store?.abbreviation &&
                <Badge
                  variant="secondary" className="bg-secondary text-secondary-foreground mt-1 px-2 py-0.5 text-sm font-bold rounded-full inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80"
                  style={{ backgroundColor: `${storeColor}`, color: `White` }}>
                  {(() => {
                    const storeAbbr = store.abbreviation.slice(0, 2).toUpperCase();
                    const trackingNum = parseInt(delivery.tracking_number) || 0;
                    const formattedNum = trackingNum > 99 ?
                      trackingNum.toString().padStart(3, '0') :
                      trackingNum.toString().padStart(2, '0');
                    return `${storeAbbr}${formattedNum}`;
                  })()}
                </Badge>
              }
            </div>
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
                  {/* CRITICAL: Only show GPS button for isNextDelivery cards */}
                  {isNextDelivery && finalDisplayAddress &&
                    <a
                      href={(() => {
                        if (!shouldRedact && !isPickup && patient?.latitude && patient?.longitude) {
                          return `https://www.google.com/maps/dir/?api=1&destination=${patient.latitude},${patient.longitude}`;
                        } else if (!shouldRedact && isPickup && store?.latitude && store?.longitude) {
                          return `https://www.google.com/maps/dir/?api=1&destination=${store.latitude},${store.longitude}`;
                        } else {
                          return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(finalDisplayAddress)}`;
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
          {showDeleteConfirm && ReactDOM.createPortal(
            <div
              className="fixed inset-0 flex items-center justify-center"
              style={{ background: 'rgba(0, 0, 0, 0.6)', zIndex: 999999, pointerEvents: 'auto' }}
              onClick={() => setShowDeleteConfirm(false)}>
              <div
                onClick={(e) => e.stopPropagation()}
                className="rounded-lg shadow-xl p-6 max-w-md w-full mx-4" style={{ background: 'var(--bg-white)' }}>
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 text-red-600">
                  <Trash2 className="w-5 h-5" />
                  Confirm Delete
                </h3>

                <div className="space-y-3 mb-6">
                  <p className="text-slate-700">
                    Are you sure you want to delete this {isPickup ? 'pickup' : 'delivery'}?
                  </p>

                  <div className="rounded-lg p-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm" style={{ background: 'var(--bg-slate-50)' }}>
                    <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Name:</span>
                    <span style={{ color: 'var(--text-slate-900)' }}>{displayName}</span>

                    {displayAddress && <>
                      <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Address:</span>
                      <span style={{ color: 'var(--text-slate-900)' }}>{displayAddress}</span>
                    </>}

                    {delivery.tracking_number && <>
                      <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Tr#:</span>
                      <span style={{ color: 'var(--text-slate-900)' }}>{delivery.tracking_number}</span>
                    </>}
                  </div>

                  {/* CRITICAL: Warning for pickups with pending deliveries + Transfer option */}
                  {isPickup && delivery.stop_id && pendingPickups && pendingPickups.length > 0 &&
                    <div className="rounded-lg p-3 border-2 border-amber-400 space-y-3" style={{ background: 'var(--bg-amber-50)' }}>
                      <div>
                        <p className="text-sm font-semibold text-amber-800 mb-1">
                          ⚠️ Warning: {pendingPickups.length} Pending Delivery{pendingPickups.length > 1 ? 's' : ''} Will {selectedTransferPickupId ? 'Be Transferred' : 'Also Be Deleted'}
                        </p>
                        <p className="text-xs text-amber-700">
                          {pendingPickups.map(p => p.patient_name).join(', ')}
                        </p>
                      </div>
                      
                      {/* Transfer Pickup Selection */}
                      <div className="space-y-2">
                        <Label className="text-sm font-semibold text-amber-900">Transfer to another pickup (optional):</Label>
                        <Select
                          value={selectedTransferPickupId}
                          onValueChange={(value) => setSelectedTransferPickupId(value)}
                        >
                          <SelectTrigger className="h-8 text-sm bg-white">
                            <SelectValue placeholder="Select pickup location" />
                          </SelectTrigger>
                          <SelectContent className="z-[999999]">
                            <SelectItem value="delete_all">All Stops Will Be Deleted</SelectItem>
                            {availableTransferPickups.map(pickup => (
                              <SelectItem key={pickup.id} value={pickup.id}>
                                {store?.name} [{pickup.ampm_deliveries || 'AM'}] (TR# {pickup.tracking_number})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {selectedTransferPickupId && selectedTransferPickupId !== 'delete_all' && (
                          <p className="text-xs text-blue-700 italic">
                            Pending stops will be updated with new PUID and TR# range
                          </p>
                        )}
                      </div>
                    </div>
                  }

                  <p className="text-sm text-red-600 font-medium">
                    This action cannot be undone.
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      setSelectedTransferPickupId('');
                    }}>
                    Cancel
                  </Button>
                  <Button
                    className="flex-1 bg-red-600 hover:bg-red-700"
                    onClick={async () => {
                      try {
                        // CRITICAL: Unpause mutations before delete operations
                        const { pauseAllMutations, resumeAllMutations } = await import('../utils/entityMutations');
                        resumeAllMutations();
                        
                        // CRITICAL: If transfer pickup selected, transfer pending stops first
                        if (isPickup && selectedTransferPickupId && selectedTransferPickupId !== 'delete_all' && pendingPickups && pendingPickups.length > 0) {
                          console.log('🔄 [Transfer] Transferring pending stops to new pickup:', selectedTransferPickupId);
                          
                          const newPickup = allDeliveries.find(d => d.id === selectedTransferPickupId);
                          if (!newPickup) {
                            toast.error('Selected pickup not found');
                            return;
                          }
                          
                          const newPuid = newPickup.stop_id;
                          const newPickupTR = parseInt(newPickup.tracking_number, 10);
                          
                          // Update all pending stops with new PUID and TR# range
                          const sortedPending = [...pendingPickups].sort((a, b) =>
                            (a.patient_name || '').localeCompare(b.patient_name || '')
                          );
                          
                          const updatePromises = sortedPending.map((pending, index) => {
                            const newTR = String(newPickupTR + index + 1);
                            console.log(`📦 [Transfer] ${pending.patient_name}: PUID ${pending.puid} → ${newPuid}, TR# ${pending.tracking_number} → ${newTR}`);
                            return base44.entities.Delivery.update(pending.id, {
                              puid: newPuid,
                              tracking_number: newTR,
                              ampm_deliveries: newPickup.ampm_deliveries
                            });
                          });
                          
                          await Promise.all(updatePromises);
                          console.log('✅ [Transfer] All pending stops transferred');
                          toast.success(`Transferred ${pendingPickups.length} pending stop(s)`);
                        }
                        
                        // CRITICAL: Delete Square COD item if delivery has COD and is in_transit
                        if (delivery.status === 'in_transit' && delivery.cod_total_amount_required > 0 && delivery.patient_id) {
                          try {
                            console.log('💳 [Delete] Deleting Square COD item for:', delivery.id);
                            await base44.functions.invoke('squareDeleteCodItem', {
                              deliveryId: delivery.id,
                              reason: 'delivery_deleted'
                            });
                            console.log('✅ [Delete] Square COD item deleted');
                          } catch (squareError) {
                            console.error('⚠️ [Delete] Failed to delete Square COD item:', squareError);
                          }
                        }

                        await onDeleteDelivery(delivery.id);
                        setShowDeleteConfirm(false);
                        setSelectedTransferPickupId('');
                      } catch (error) {
                        console.error('Delete failed:', error);
                        toast.error(`Failed: ${error.message}`);
                      }
                    }}>
                    <Trash2 className="w-4 h-4 mr-2" />
                    {selectedTransferPickupId ? 'Trans & Del' : 'Delete'}
                  </Button>
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* Signature Capture - Full Screen Landscape */}
          {showSignatureCapture &&
            <SignatureCapture
              customerName={displayName}
              onSave={async (signatureBlob) => {
                try {
                  console.log('📝 [Signature] Starting upload...', signatureBlob);

                  // Upload signature immediately
                  const uploadResult = await base44.integrations.Core.UploadFile({ file: signatureBlob });
                  const signatureUrl = uploadResult.file_url;

                  console.log('📝 [Signature] Upload complete:', signatureUrl);

                  // Update delivery with signature DIRECTLY
                  await base44.entities.Delivery.update(delivery.id, {
                    signature_image_url: signatureUrl
                  });

                  console.log('📝 [Signature] Database updated');

                  // Close modal
                  setShowSignatureCapture(false);

                  // Force immediate refresh
                  invalidate('Delivery');
                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                  console.log('📝 [Signature] UI refreshed - signature should now show green');

                  toast.success('Signature saved!');
                } catch (error) {
                  console.error('❌ [Signature] Save failed:', error);
                  toast.error(`Failed to save signature: ${error.message}`);
                  setShowSignatureCapture(false);
                }
              }}
              onCancel={() => setShowSignatureCapture(false)} />

          }

          {/* Photo Capture */}
          {showPhotoCapture &&
            <PhotoCapture
              onSave={async (photoBlobs) => {
                try {
                  console.log('📷 [Photos] Starting upload...', photoBlobs.length, 'photos');

                  // Upload photos immediately
                  const uploadPromises = photoBlobs.map((blob) =>
                    base44.integrations.Core.UploadFile({ file: blob })
                  );
                  const results = await Promise.all(uploadPromises);
                  const newPhotoUrls = results.map((r) => r.file_url);

                  console.log('📷 [Photos] Upload complete:', newPhotoUrls);

                  // Update delivery with photos DIRECTLY
                  const existingPhotos = delivery.proof_photo_urls || [];
                  await base44.entities.Delivery.update(delivery.id, {
                    proof_photo_urls: [...existingPhotos, ...newPhotoUrls]
                  });

                  console.log('📷 [Photos] Database updated');

                  // Close modal
                  setShowPhotoCapture(false);

                  // Force immediate refresh
                  invalidate('Delivery');
                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                  console.log('📷 [Photos] UI refreshed - photos should now show green');

                  toast.success(`${photoBlobs.length} photo(s) saved!`);
                } catch (error) {
                  console.error('❌ [Photos] Save failed:', error);
                  toast.error(`Failed to save photos: ${error.message}`);
                  setShowPhotoCapture(false);
                }
              }}
              onCancel={() => setShowPhotoCapture(false)}
              maxPhotos={3} />

          }

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
                console.log('🔴 [FAILURE] Starting failure/cancel with reason:', reason);

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
                const currentTime = new Date();
                const totalMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
                const roundedMinutes = Math.round(totalMinutes / 5) * 5;
                const roundedHours = Math.floor(roundedMinutes / 60);
                const roundedMins = roundedMinutes % 60;

                const year = currentTime.getFullYear();
                const month = String(currentTime.getMonth() + 1).padStart(2, '0');
                const day = String(currentTime.getDate()).padStart(2, '0');
                const hours = String(roundedHours).padStart(2, '0');
                const minutes = String(roundedMins).padStart(2, '0');
                const seconds = '00';
                const offsetMinutes = -currentTime.getTimezoneOffset();
                const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
                const offsetMins = Math.abs(offsetMinutes) % 60;
                const offsetSign = offsetMinutes >= 0 ? '+' : '-';
                const offsetString = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMins).padStart(2, '0')}`;
                const localTimeString = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetString}`;

                console.log('📞 [FAILURE] Saving to both databases with status:', status);
                console.log('📦 [FAILURE] Extra data:', {
                  delivery_notes: updatedNotes,
                  actual_delivery_time: localTimeString
                });

                // CRITICAL: Save to both offline and online databases
                try {
                  await updateDeliveryLocal(delivery.id, {
                    status: status,
                    delivery_notes: updatedNotes,
                    actual_delivery_time: localTimeString
                  }, { skipSmartRefresh: true });
                  console.log('✅ [FAILURE] Saved to both databases');

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
                  console.log('🏁 [FAILED/CANCELLED] FINAL STOP - Activating FAB and showing route summary');
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
                  console.log('🔄 [Failed/Cancelled] Running optimizeRouteRealTime...');
                  await base44.functions.invoke('optimizeRouteRealTime', {
                    driverId: delivery.driver_id,
                    deliveryDate: delivery.delivery_date,
                    currentLocalTime: currentLocalTime,
                    generatePolyline: false
                  });
                  console.log('✅ [Failed/Cancelled] Route optimized');

                  // CRITICAL: Refresh UI to show reordered stops
                  invalidate('Delivery');
                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                  console.log('✅ [Failed/Cancelled] UI refreshed with new stop order');

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
                  console.log(`✅ [FAILURE] Setting isNextDelivery=true on ${incompleteDeliveries[0].patient_name || 'Pickup'}`);
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


          {/* Return Confirmation Dialog - Portal to body for proper z-index */}
          {showReturnConfirm && returnPatient && ReactDOM.createPortal(
            <div
              className="fixed inset-0 flex items-center justify-center"
              style={{ background: 'rgba(0, 0, 0, 0.6)', zIndex: 999999, pointerEvents: 'auto' }}
              onClick={handleCancelReturn}>
              <div
                onClick={(e) => e.stopPropagation()}
                className="rounded-lg shadow-xl p-6 max-w-md w-full mx-4" style={{ background: 'var(--bg-white)' }}>
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Undo2 className="w-5 h-5 text-orange-600" />
                  Confirm Return Delivery
                </h3>

                <div className="space-y-3 mb-6 text-sm">
                  <p className="text-slate-600">A new return delivery will be created with the following details:</p>

                  <div className="rounded-lg p-3 space-y-2" style={{ background: 'var(--bg-slate-50)' }}>
                    <div>
                      <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Return To: {returnPatient.full_name}</span>
                      <p style={{ color: 'var(--text-slate-900)' }}></p>
                    </div>

                    <div>
                      <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Address: {returnPatient.address || store?.address || 'N/A'}</span>
                      <p style={{ color: 'var(--text-slate-900)' }}></p>
                    </div>

                    <div>
                      <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Phone: {formatPhoneNumber(returnPatient.phone || store?.phone || 'N/A')}</span>
                      <p style={{ color: 'var(--text-slate-900)' }}></p>
                    </div>

                    <div>
                      <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Delivery Date: {delivery.delivery_date}</span>
                      <p style={{ color: 'var(--text-slate-900)' }}></p>
                    </div>

                    <div>
                      <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Assigned Driver: {getDriverDisplayName(driver) || 'N/A'}</span>
                      <p style={{ color: 'var(--text-slate-900)' }}></p>
                    </div>

                    <div>
                      <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Notes:</span>
                      <p className="text-xs" style={{ color: 'var(--text-slate-900)' }}>PATIENT RETURN</p>
                      <p className="text-xs" style={{ color: 'var(--text-slate-900)' }}>For: {patient?.full_name || delivery.patient_name || 'Unknown'}</p>
                    </div>

                    <div>
                      <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Tracking Number:</span>
                      <p className="italic" style={{ color: 'var(--text-slate-500)' }}>Will be assigned when saved</p>
                    </div>
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={handleCancelReturn}
                    disabled={isCreatingReturn}>
                    Cancel
                  </Button>
                  <Button
                    className="flex-1 bg-orange-600 hover:bg-orange-700"
                    onClick={handleConfirmReturn}
                    disabled={isCreatingReturn}>
                    {isCreatingReturn ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Undo2 className="w-4 h-4 mr-2" />}
                    Create Return
                  </Button>
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* BODY SECTION - Expandable - Always show when expanded (BUT never for dispatcher-stripped cards) */}
          <AnimatePresence>
            {isExpanded && !isStrippedForDispatcher &&
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="mt-2 pt-3 pb-2 space-y-3 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                  {/* Phone number - moved below divider - HIDE for finished patient deliveries */}
                  {finalDisplayPhone && !(isFinishedDelivery && !isPickup) &&
                    <div className="flex items-center text-lg md:text-sm" style={{ color: 'var(--text-slate-600)' }}>
                      <Phone className="w-4 h-4 mr-2 text-slate-500" />
                      <span className="text-xl md:text-base font-medium">{formatPhoneNumber(finalDisplayPhone)}</span>
                    </div>
                  }

                  {/* COD Information - For active deliveries with COD required (always show, but disable editing for driver-stripped) */}
                  {hasCODRequired && !isPickup && !isFinishedDelivery &&
                    <div className="flex items-center justify-between rounded-md px-2 py-1" style={{ background: '#e5e7eb', borderWidth: '1px', borderColor: '#d1d5db' }}>
                      <span className="text-lg md:text-xs font-semibold" style={{ color: '#374151' }}>COD Required: ${codTotalRequired.toFixed(2)}</span>
                      {userHasRole(currentUser, 'driver') && !isStrippedForDriver &&
                        <Button size="sm" variant="ghost" className="h-6 text-sm md:text-xs hover:bg-gray-300" style={{ color: '#4b5563' }} onClick={(e) => {
                          e.stopPropagation();
                          setShowCODCollection(!showCODCollection);
                          // Auto-add payment when opening COD collection and focus dropdown
                          if (!showCODCollection && codPayments.length === 0) {
                            handleAddCODPayment(true);
                          }
                        }}>
                          {codPayments.length > 0 ? 'Edit' : 'Collect'}
                        </Button>
                      }
                    </div>
                  }

                  {/* COD Collected - Show for active deliveries OR for finished deliveries with COD (disable editing for driver-stripped) */}
                  {hasCODRequired && !isPickup && codPayments.length > 0 &&
                    <div className="flex items-center justify-between rounded-md px-2 py-1" style={{
                      background: '#10b981',
                      borderWidth: '1px',
                      borderColor: '#059669'
                    }}>
                      <span className="text-lg md:text-xs font-semibold" style={{ color: '#ffffff' }}>
                        COD Collected: {codPayments.map((payment, index) =>
                          <span key={index}>
                            {payment.type}: ${payment.amount.toFixed(2)}
                            {index < codPayments.length - 1 && ', '}
                          </span>
                        )}
                      </span>
                      {!isStrippedForDriver && !isFinishedDelivery && userHasRole(currentUser, 'driver') ||
                        isFinishedDelivery && userHasRole(currentUser, 'admin') ?
                        <Button size="sm" variant="ghost" className="h-6 text-sm md:text-xs hover:bg-emerald-700" style={{ color: '#ffffff' }} onClick={(e) => { e.stopPropagation(); setShowCODCollection(!showCODCollection); }}>Edit</Button> :
                        null}
                    </div>
                  }

                  <AnimatePresence>
                    {showCODCollection && hasCODRequired && !isPickup && !isStrippedForDriver && (userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')) &&
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden rounded-md p-3 space-y-2 w-full"
                        style={{ background: 'var(--bg-slate-50)' }}
                        onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm md:text-xs font-semibold" style={{ color: 'var(--text-slate-700)' }}>Collect COD Payments</span>
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={async (e) => {
                            e.stopPropagation();
                            console.log('🗑️ [COD Clear] Clearing all COD payments');
                            setCodPayments([]);
                            if (onCODUpdate) {
                              try {
                                await onCODUpdate(delivery.id, [], true);
                                console.log('✅ [COD Clear] Database updated');
                              } catch (error) {
                                console.error('❌ [COD Clear] Failed:', error);
                              }
                            }
                            setShowCODCollection(false);
                          }}>
                            <X className="w-3 h-3" />
                          </Button>
                        </div>

                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {codPayments.map((payment, index) =>
                            <div key={index} className="flex items-center gap-2 p-2 rounded" style={{ background: 'var(--bg-white)', borderWidth: '1px', borderColor: 'var(--border-slate-200)' }}>
                              <Select value={payment.type} onValueChange={(value) => handleCODPaymentChange(index, 'type', value)} onOpenChange={(open) => { if (open) setShowCODCollection(true); }}>
                                <SelectTrigger className="h-7 text-sm md:text-xs w-24" onClick={(e) => e.stopPropagation()} data-cod-select-index={index}>
                                  <SelectValue placeholder="Type" />
                                </SelectTrigger>
                                <SelectContent onClick={(e) => e.stopPropagation()} className="z-[500]">
                                  <SelectItem value="Cash">Cash</SelectItem>
                                  <SelectItem value="Debit">Debit</SelectItem>
                                  <SelectItem value="Credit">Credit</SelectItem>
                                  <SelectItem value="Check">Check</SelectItem>
                                </SelectContent>
                              </Select>

                              <div className="relative flex-1">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-sm md:text-xs" style={{ color: 'var(--text-slate-500)' }}>$</span>
                                <input
                                  ref={(el) => codAmountInputRefs.current[index] = el}
                                  type="text"
                                  value={payment.amount > 0 ? payment.amount.toFixed(2) : payment.amount === 0 ? '0.00' : ''}
                                  onChange={(e) => handleCODPaymentChange(index, 'amount', e.target.value)}
                                  className="h-7 w-full pl-5 pr-2 text-sm md:text-xs rounded-md"
                                  style={{
                                    background: 'var(--bg-white)',
                                    borderWidth: '1px',
                                    borderColor: 'var(--border-slate-300)',
                                    color: 'var(--text-slate-900)'
                                  }}
                                  placeholder="0.00"
                                  onClick={(e) => e.stopPropagation()}
                                  onFocus={(e) => e.target.select()} />

                              </div>

                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-600 hover:text-red-800" onClick={(e) => { e.stopPropagation(); handleRemoveCODPayment(index); }}>
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                          )}
                        </div>

                        <Button size="sm" variant="outline" className="w-full h-7 text-sm md:text-xs" onClick={(e) => { e.stopPropagation(); handleAddCODPayment(); }}>
                          <Plus className="w-3 h-3 mr-1" />
                          Add Payment
                        </Button>

                        <div className="flex items-center justify-between pt-2" style={{ borderTopWidth: '1px', borderColor: 'var(--border-slate-200)' }}>
                          <div className="text-sm md:text-xs">
                            <span style={{ color: 'var(--text-slate-600)' }}>Total: </span>
                            <span className="font-bold" style={{ color: isCODComplete ? 'var(--text-emerald-600)' : 'var(--text-amber-600)' }}>
                              ${codTotalCollected.toFixed(2)}
                            </span>
                            <span style={{ color: 'var(--text-slate-600)' }}> / ${codTotalRequired.toFixed(2)}</span>
                          </div>

                          <Button size="sm" className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary-foreground shadow rounded-md px-3 h-7 text-sm md:text-xs !text-white bg-emerald-600 hover:bg-emerald-700" onClick={async (e) => { 
                            e.stopPropagation(); 
                            if (onCODUpdate) {
                              try {
                                setIsCompleting(true);
                                
                                // CRITICAL: Check if delivery is already completed
                                const isAlreadyCompleted = delivery.status === 'completed';
                                
                                if (isAlreadyCompleted) {
                                  // JUST SAVE COD - don't change status or anything else
                                  console.log('💰 [COD Edit] Delivery already completed - only saving COD payments');
                                  await onCODUpdate(delivery.id, codPayments, true);
                                  setShowCODCollection(false);
                                  toast.success('COD payments updated!');
                                } else {
                                  // NORMAL FLOW: Save COD and complete delivery
                                  fabControlEvents.deactivateFAB();
                                  const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                                  driverLocationPoller.pause();
                                  
                                  // Save COD payments
                                  await onCODUpdate(delivery.id, codPayments, true);
                                  setShowCODCollection(false);
                                  
                                  // Auto-complete the delivery
                                  const currentTime = new Date();
                                  const totalMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
                                  const roundedMinutes = Math.round(totalMinutes / 5) * 5;
                                  const roundedHours = Math.floor(roundedMinutes / 60);
                                  const roundedMins = roundedMinutes % 60;
                                  const year = currentTime.getFullYear();
                                  const month = String(currentTime.getMonth() + 1).padStart(2, '0');
                                  const day = String(currentTime.getDate()).padStart(2, '0');
                                  const hours = String(roundedHours).padStart(2, '0');
                                  const minutes = String(roundedMins).padStart(2, '0');
                                  const offsetMinutes = -currentTime.getTimezoneOffset();
                                  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
                                  const offsetMins = Math.abs(offsetMinutes) % 60;
                                  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
                                  const offsetString = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMins).padStart(2, '0')}`;
                                  const localTimeString = `${year}-${month}-${day}T${hours}:${minutes}:00${offsetString}`;
                                  
                                  await updateDeliveryLocal(delivery.id, {
                                    status: 'completed',
                                    actual_delivery_time: localTimeString,
                                    isNextDelivery: false
                                  }, { skipSmartRefresh: true });
                                  
                                  // Find next incomplete delivery
                                  const driverDeliveries = allDeliveries.filter(d => 
                                    d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                                  );
                                  const incompleteDeliveries = driverDeliveries.filter(d => 
                                    d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending'
                                  ).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                                  
                                  if (incompleteDeliveries.length > 0) {
                                    await updateDeliveryLocal(incompleteDeliveries[0].id, { isNextDelivery: true }, { skipSmartRefresh: true });
                                    invalidate('Delivery');
                                    await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                                    
                                    setTimeout(() => {
                                      const nextCardElement = document.getElementById(`stop-card-${incompleteDeliveries[0].id}`);
                                      if (nextCardElement) {
                                        nextCardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                      }
                                    }, 100);
                                  } else {
                                    fabControlEvents.notifyDoneButtonClicked();
                                    window.dispatchEvent(new CustomEvent('showRouteSummary', {
                                      detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                                    }));
                                  }
                                  
                                  window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                                    detail: { triggeredBy: 'complete', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                                  }));
                                  
                                  // Collapse the card
                                  if (onSelectionChange) {
                                    onSelectionChange(delivery.id, false);
                                  } else if (onClick) {
                                    onClick(null);
                                  }
                                  
                                  driverLocationPoller.resume();
                                  fabControlEvents.reactivateFAB(true);
                                  toast.success('COD saved and delivery completed!');
                                }
                              } catch (error) {
                                console.error('❌ Failed to save COD:', error);
                                toast.error(`Failed: ${error.message}`);
                                fabControlEvents.reactivateFAB(true);
                              } finally {
                                setIsCompleting(false);
                              }
                            }
                          }} disabled={codPayments.length === 0 || isCompleting}>
                            {isCompleting ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : delivery.status === 'completed' ? <Save className="w-3 h-3 mr-1" /> : <CheckCircle className="w-3 h-3 mr-1" />}
                            {delivery.status === 'completed' ? 'Save' : 'Save & Complete'}
                          </Button>
                        </div>
                      </motion.div>
                    }
                  </AnimatePresence>

                  {/* Patient Notes - Hide for driver-stripped AND non-AppOwner on completed/past routes */}
                  {!isStrippedForDriver && isFinishedDelivery && !isPickup && patient?.notes && (isAppOwner(currentUser) || (delivery.delivery_date === format(new Date(), 'yyyy-MM-dd'))) &&
                    <div className="flex items-start gap-2">
                      <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-base md:text-xs font-semibold mb-0.5" style={{ color: 'var(--text-slate-700)' }}>Patient Notes:</p>
                        <div className="text-base md:text-xs rounded px-2 py-1.5" style={{ color: 'var(--text-slate-600)', background: 'var(--bg-slate-50)', borderWidth: '1px', borderColor: 'var(--border-slate-200)' }}>
                          <p className="whitespace-pre-wrap break-words">{patient.notes}</p>
                        </div>
                      </div>
                    </div>
                  }

                  {/* Full Patient Info - Only AppOwner on completed routes or dispatcher on active deliveries */}
                  {!isStrippedForDriver && !isFinishedDelivery && !isPickup && patient && (patient.notes || patient.mailbox_ok || patient.call_upon_arrival || patient.dont_ring_bell || patient.back_door || patient.recurring) &&
                    <div className="flex items-start gap-2">
                      <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-base md:text-xs font-semibold mb-0.5" style={{ color: 'var(--text-slate-700)' }}>Patient Info:</p>
                        <div className="text-base md:text-xs rounded px-2 py-1.5 space-y-1" style={{ color: 'var(--text-slate-600)', background: 'var(--bg-slate-50)', borderWidth: '1px', borderColor: 'var(--border-slate-200)' }}>
                          {/* Delivery Preferences */}
                          {(patient.mailbox_ok || patient.call_upon_arrival || patient.dont_ring_bell || patient.back_door) &&
                            <div className="flex flex-wrap gap-1">
                              {patient.mailbox_ok && <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-blue-50 border-blue-200 text-blue-700">Mailbox OK</Badge>}
                              {patient.call_upon_arrival && <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-amber-50 border-amber-200 text-amber-700">Call on Arrival</Badge>}
                              {patient.dont_ring_bell && <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-red-50 border-red-200 text-red-700">Don't Ring Bell</Badge>}
                              {patient.back_door && <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-purple-50 border-purple-200 text-purple-700">Back Door</Badge>}
                            </div>
                          }

                          {/* Recurring Schedule */}
                          {patient.recurring &&
                            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 bg-green-50 border-green-200 text-green-700">
                              {(() => {
                                if (patient.recurring_daily) return 'Daily';
                                if (patient.recurring_monthly) return 'Monthly';
                                if (patient.recurring_bimonthly) return 'Bi-Monthly';
                                if (patient.recurring_biweekly) return 'Bi-Weekly';
                                if (patient.recurring_weekly_x4) return '4x Weekly';

                                // Weekly with specific days
                                const days = [];
                                if (patient.recurring_weekly_mon) days.push('Mon');
                                if (patient.recurring_weekly_tue) days.push('Tue');
                                if (patient.recurring_weekly_wed) days.push('Wed');
                                if (patient.recurring_weekly_thu) days.push('Thu');
                                if (patient.recurring_weekly_fri) days.push('Fri');
                                if (patient.recurring_weekly_sat) days.push('Sat');
                                if (patient.recurring_weekly_sun) days.push('Sun');

                                if (days.length > 0) return `Weekly(${days.join(', ')})`;
                                return 'Recurring';
                              })()}
                            </Badge>
                          }

                          {/* Patient Notes */}
                          {patient.notes &&
                            <p className="whitespace-pre-wrap break-words">{patient.notes}</p>
                          }
                        </div>
                      </div>
                    </div>
                  }

                  {/* Show pending pickup list for pickups that are en_route (equivalent to in_transit for deliveries) - HIDE for finished */}
                  {!isFinishedDelivery && isPickup && delivery.status === 'en_route' && pendingPickups && pendingPickups.length > 0 &&
                    <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-base md:text-xs font-bold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
                          <Package className="w-3.5 h-3.5" />
                          Pending Pickup List ({pendingPickups.length})
                          <HelpTooltip
                            title={HELP_CONTENT.pendingPickups.title}
                            content={HELP_CONTENT.pendingPickups.content}
                            size="sm" />

                        </h4>
                        {canAccessAcceptButtons &&
                          <Button
                            size="sm"
                            variant="default" className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow rounded-md h-6 px-2 text-xs !text-white bg-emerald-600 hover:bg-emerald-700 text-white"
                            disabled={isAcceptingAll}
                            onClick={async (e) => {
                              e.stopPropagation();
                              await handleAcceptAllStops();
                            }}>
                            {isAcceptingAll && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                            {acceptButtonText}
                          </Button>
                        }
                      </div>
                      <div className="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar max-h-[150px]"

                        onWheel={(e) => {
                          const el = e.currentTarget;
                          // If the list isn't scrollable, don't interfere with the event.
                          if (el.scrollHeight <= el.clientHeight) {
                            return;
                          }

                          // Scrolling up
                          if (e.deltaY < 0) {
                            // If we're not at the very top, stop the event from bubbling up.
                            if (el.scrollTop > 0) {
                              e.stopPropagation();
                            }
                          }
                          // Scrolling down
                          else if (e.deltaY > 0) {
                            // If we're not at the very bottom, stop the event from bubbling up.
                            // A 1px buffer is for potential floating point rounding errors.
                            if (el.scrollTop < el.scrollHeight - el.clientHeight - 1) {
                              e.stopPropagation();
                            }
                          }
                        }}>

                        {[...pendingPickups].sort((a, b) => {
                          const trA = parseInt(a.tracking_number || '999', 10);
                          const trB = parseInt(b.tracking_number || '999', 10);
                          return trA - trB;
                        }).map((projectedDelivery, idx) => {
                          if (!projectedDelivery) {
                            console.warn('[StopCard] Skipping undefined projected delivery at index', idx);
                            return null;
                          }

                          const deliveryId = projectedDelivery.id || `projected-${delivery.id}-${idx}`;

                          // Calculate special badges for this pending delivery
                          const projPatient = patients.find((p) => p?.id === projectedDelivery.patient_id);

                          // FIXED: Check if first delivery - must explicitly be marked OR have no completed deliveries
                          const projIsFirstDelivery = projectedDelivery.first_delivery === true ||
                            projPatient?.notes?.toLowerCase().includes('first delivery') ||
                            projectedDelivery.delivery_instructions?.toLowerCase().includes('first delivery') ||
                            projectedDelivery.delivery_notes?.toLowerCase().includes('first delivery');

                          const hasCOD = projectedDelivery.cod_total_amount_required > 0;
                          const hasOversized = projectedDelivery.oversized === true;
                          const hasFridge = projectedDelivery.fridge_item === true;
                          const hasSignature = projectedDelivery.signature_needed === true;



                          return (
                            <div
                              key={deliveryId}
                              className="flex items-center justify-between gap-2 border px-2.5 py-1.5 rounded-md cursor-pointer transition-colors"
                              style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
                              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-slate-50)'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg-white)'; }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (onEditDelivery && projectedDelivery.id) {
                                  onEditDelivery(projectedDelivery);
                                }
                              }}>

                              <span className="text-base md:text-xs font-medium truncate flex-1" style={{ color: 'var(--text-slate-900)' }}>
                                {projectedDelivery.patient_name || 'Unknown Patient'}
                              </span>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <SpecialSymbolsBadges
                                  delivery={projectedDelivery}
                                  patient={projPatient}
                                  isPickup={false}
                                  size="sm" />

                                <span className="text-base md:text-xs font-semibold" style={{ color: 'var(--text-slate-600)' }}>
                                  {(() => {
                                    const storeAbbr = store?.abbreviation?.slice(0, 2).toUpperCase() || 'XX';
                                    const trackingNum = parseInt(projectedDelivery.tracking_number) || 0;
                                    const formattedNum = trackingNum > 99 ?
                                      trackingNum.toString().padStart(3, '0') :
                                      trackingNum.toString().padStart(2, '0');
                                    return `${storeAbbr}${formattedNum}`;
                                  })()}
                                </span>
                                {/* Individual accept button - only for assigned driver, dispatcher, or admin */}
                                {canAccessAcceptButtons &&
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-5 w-5 p-0 ml-1 bg-emerald-100 hover:bg-emerald-200 text-emerald-700"
                                    disabled={acceptingIndividual[deliveryId]}
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (!onStatusUpdate) return;
                                      
                                      setAcceptingIndividual(prev => ({ ...prev, [deliveryId]: true }));
                                      try {

                                      // Get pickup's TR# as base
                                      const pickupTR = parseInt(delivery.tracking_number, 10);
                                      const baseTR = isNaN(pickupTR) ? 0 : pickupTR;

                                      // Find the highest TR# already assigned to this pickup's deliveries
                                      const existingTRs = pendingPickups.
                                        map((p) => parseInt(p.tracking_number, 10)).
                                        filter((tr) => !isNaN(tr) && tr !== 99 && tr !== 0 && tr > baseTR);
                                      const highestExistingTR = existingTRs.length > 0 ? Math.max(...existingTRs) : baseTR;

                                      // Assign the next sequential TR#
                                      const newTR = String(highestExistingTR + 1);

                                      // CRITICAL: Set delivery_time_start to current time + 5 minutes
                                      const now = new Date();
                                      const currentMinutes = now.getHours() * 60 + now.getMinutes();
                                      const startMinutes = currentMinutes + 5;
                                      const deliveryTimeStart = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;

                                      // Update this single delivery to in_transit (don't touch isNextDelivery)
                                      await onStatusUpdate(projectedDelivery.id, 'in_transit', {
                                        tracking_number: newTR,
                                        delivery_time_start: deliveryTimeStart
                                      }, true);

                                      // SQUARE INTEGRATION: Create COD item if applicable
                                      if (projectedDelivery.cod_total_amount_required > 0 && projectedDelivery.patient_id) {
                                        try {
                                          const storeForCod = stores.find((s) => s && s.id === projectedDelivery.store_id);
                                          const codAmountDollars = projectedDelivery.cod_total_amount_required;
                                          console.log('💳 [Square] Creating COD item for single accept:', projectedDelivery.id, 'Amount:', codAmountDollars);
                                          await base44.functions.invoke('squareCreateCodItem', {
                                            deliveryId: projectedDelivery.id,
                                            patientName: projectedDelivery.patient_name,
                                            storeAbbreviation: storeForCod?.abbreviation || '',
                                            codAmount: codAmountDollars,
                                            deliveryDate: projectedDelivery.delivery_date,
                                            storeId: projectedDelivery.store_id
                                          });
                                          console.log('✅ [Square] COD item created for:', projectedDelivery.patient_name);
                                        } catch (squareError) {
                                          console.error('⚠️ [Square] Failed to create COD item:', squareError);
                                        }
                                      }

                                      // CRITICAL: Dispatch event to trigger ETA updates
                                      window.dispatchEvent(new CustomEvent('pendingToInTransit', {
                                        detail: { driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                                      }));

                                      // CRITICAL: Trigger immediate map update
                                      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                                        detail: { triggeredBy: 'acceptOne', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                                      }));

                                      // Send notification message
                                      const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher');
                                      if (isDriverAction) {
                                        // Driver accepted one - notify dispatchers
                                        await notifyDriverAcceptedOne({
                                          driver: currentUser,
                                          patientName: projectedDelivery.patient_name,
                                          store,
                                          appUsers
                                        });
                                      } else {
                                        // Dispatcher/Admin assigned one - notify driver
                                        const assignedDriver = drivers.find((d) => d?.id === delivery.driver_id);
                                        if (assignedDriver) {
                                          await notifyDispatcherAssignedAll({
                                            dispatcher: currentUser,
                                            driver: assignedDriver,
                                            store,
                                            deliveries: [projectedDelivery],
                                            patients
                                          });
                                        }
                                      }
                                      } finally {
                                        setAcceptingIndividual(prev => ({ ...prev, [deliveryId]: false }));
                                      }
                                    }}>
                                    {acceptingIndividual[deliveryId] ? 
                                      <Loader2 className="w-3 h-3 animate-spin" /> : 
                                      <Plus className="w-3 h-3" />
                                    }
                                  </Button>
                                }
                              </div>
                            </div>);
                        })}
                      </div>
                    </div>
                  }

                  {/* Driver Notes - ALWAYS show when expanded (even if empty) */}
                  {isFinishedDelivery && !isPickup ?
                    <div className="space-y-1 mt-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-base md:text-xs font-medium flex items-center gap-1" style={{ color: 'var(--text-slate-700)' }}>Driver Notes</Label>
                      </div>
                      {delivery.delivery_notes ?
                        <div
                          className="text-base md:text-xs rounded px-2 py-1.5 min-h-[60px]"
                          style={{ color: 'var(--text-slate-600)', background: 'var(--bg-slate-50)', borderWidth: '1px', borderColor: 'var(--border-slate-200)' }}
                          onClick={(e) => e.stopPropagation()}>
                          <p className="whitespace-pre-wrap break-words">{delivery.delivery_notes}</p>
                        </div> :

                        <div
                          className="text-base md:text-xs rounded px-2 py-1.5 italic min-h-[60px]"
                          style={{ color: 'var(--text-slate-400)', background: 'var(--bg-slate-50)', borderWidth: '1px', borderColor: 'var(--border-slate-200)' }}
                          onClick={(e) => e.stopPropagation()}>
                          No driver notes
                        </div>
                      }
                    </div> :

                    <div className="space-y-1 mt-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-base md:text-xs font-medium flex items-center gap-1" style={{ color: 'var(--text-slate-700)' }}>Driver Notes</Label>
                      </div>
                      <Textarea
                        value={notesInput}
                        onChange={(e) => setNotesInput(e.target.value)}
                        onFocus={(e) => {
                          e.stopPropagation();
                          if (notesInput === 'No driver notes') {
                            setNotesInput('');
                          }
                        }}
                        onBlur={handleNotesBlur}
                        onKeyDown={handleNotesKeyDown}
                        onClick={(e) => e.stopPropagation()}
                        placeholder=""
                        className="text-base md:text-xs resize-none h-24"
                        style={{
                          background: 'var(--bg-white)',
                          borderColor: 'var(--border-slate-200)',
                          color: notesInput === 'No driver notes' ? 'var(--text-slate-400)' : 'var(--text-slate-900)',
                          fontStyle: notesInput === 'No driver notes' ? 'italic' : 'normal'
                        }}
                        disabled={isCompleted && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher')} />
                    </div>
                  }
                </div>
              </motion.div>
            }
          </AnimatePresence>

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
                              console.log('⏸️ [Retry] Pausing location poller...');
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

                                console.log('🔄 [Retry] Creating duplicate delivery with TR#', nextTR);
                                const newDelivery = await base44.entities.Delivery.create(retryDelivery);
                                console.log('✅ [Retry] Duplicate created:', newDelivery.id);

                                try {
                                  const now = new Date();
                                  const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                                  console.log('🔄 [Retry] Running optimizeRouteRealTime...');
                                  await base44.functions.invoke('optimizeRouteRealTime', {
                                    driverId: delivery.driver_id,
                                    deliveryDate: delivery.delivery_date,
                                    currentLocalTime: currentLocalTime,
                                    generatePolyline: false
                                  });
                                  console.log('✅ [Retry] Route optimized');

                                  invalidate('Delivery');
                                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                                  console.log('✅ [Retry] UI refreshed with new stop order');
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
                                console.log('✅ [RETRY] Retry cycle complete');

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
                              console.log('⏸️ [Restart] Pausing location poller...');
                              const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                              driverLocationPoller.pause();

                              await new Promise((resolve) => setTimeout(resolve, 100));

                              try {
                                const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
                                if (!deliveryExists || deliveryExists.length === 0) {
                                  console.warn('⚠️ [RESTART] Delivery no longer exists - aborting');
                                  throw new Error('This delivery has been deleted. Please refresh the page.');
                                }

                                console.log('🔄 [RESTART] Restarting delivery:', delivery.id);

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
                                  console.log('🔄 [Restart Delivery] Running optimizeRouteRealTime...');
                                  await base44.functions.invoke('optimizeRouteRealTime', {
                                    driverId: delivery.driver_id,
                                    deliveryDate: delivery.delivery_date,
                                    currentLocalTime: currentLocalTime,
                                    generatePolyline: false
                                  });
                                  console.log('✅ [Restart Delivery] Route optimized');

                                  invalidate('Delivery');
                                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                                  console.log('✅ [Restart Delivery] UI refreshed with new stop order');
                                } catch (optimizeError) {
                                  console.warn('⚠️ [Restart Delivery] Route optimizer failed:', optimizeError);
                                }

                                invalidate('Delivery');
                                await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                                console.log('✅ [RESTART] Delivery restarted successfully');

                                window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                                  detail: { triggeredBy: 'restart', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
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

                            {patient && onEditPatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                              <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditPatient(patient); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                                <User className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                                Edit Patient
                              </DropdownMenuItem>
                            }

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
                        {!isPickup &&
                          <div className="flex items-center gap-2">
                            {/* Signature Button - show ONLY on next delivery OR completed with signature */}
                            {isNextDelivery && !isFinishedDelivery || delivery.status === 'completed' && delivery.signature_image_url ?
                              <Button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (delivery.status !== 'completed') {
                                    setShowSignatureCapture(true);
                                  }
                                }}
                                size="sm"
                                variant="outline"
                                disabled={delivery.status === 'completed'}
                                className={`h-10 md:h-8 w-10 md:w-8 p-0 ${
                                  delivery.signature_image_url ?
                                    'bg-emerald-100 border-emerald-400 hover:bg-emerald-200' :
                                    'border-white hover:bg-slate-100'}`
                                }>

                                <Pen className={`w-5 h-5 md:w-4 md:h-4 ${
                                  delivery.signature_image_url ? 'text-emerald-700' : 'text-white'}`
                                } />
                              </Button> :
                              null}

                            {/* Photo Button - show ONLY on next delivery OR completed with photos */}
                            {isNextDelivery && !isFinishedDelivery || delivery.status === 'completed' && delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 ?
                              <Button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (delivery.status !== 'completed') {
                                    setShowPhotoCapture(true);
                                  }
                                }}
                                size="sm"
                                variant="outline"
                                disabled={delivery.status === 'completed'}
                                className={`h-10 md:h-8 w-10 md:w-8 p-0 ${
                                  delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 ?
                                    'bg-emerald-100 border-emerald-400 hover:bg-emerald-200' :
                                    'border-white hover:bg-slate-100'}`
                                }>

                                <Camera className={`w-5 h-5 md:w-4 md:h-4 ${
                                  delivery.proof_photo_urls && delivery.proof_photo_urls.length > 0 ? 'text-emerald-700' : 'text-white'}`
                                } />
                              </Button> :
                              null}
                          </div>
                        }

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
                                 console.log('⏸️ [Complete] Pausing location poller...');
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
                                      console.log('💰 [COMPLETE] Auto-collecting COD:', codTotalRequired);
                                      const autoCODPayment = [{
                                        type: 'Cash',
                                        amount: codTotalRequired
                                      }];

                                      // Update local state FIRST for immediate UI update
                                      setCodPayments(autoCODPayment);

                                      // Save COD payment to both databases
                                      await onCODUpdate(delivery.id, autoCODPayment, true);
                                      console.log('✅ [COMPLETE] COD auto-collected and saved');
                                    }

                                    // CRITICAL: For pickups with pending deliveries, trigger Accept All FIRST, then continue to complete pickup
                                    if (isPickup && pendingPickups && pendingPickups.length > 0) {
                                      const hasPendingDeliveries = pendingPickups.some((p) => p.status === 'pending');
                                      if (hasPendingDeliveries) {
                                        console.log('⚠️ [Complete Pickup] Pending deliveries detected - triggering Accept All logic...');
                                        await handleAcceptAllStops();
                                        console.log('✅ [Complete Pickup] Accept All logic completed - now continuing to complete pickup itself...');
                                        // Continue execution - don't return early
                                      }
                                    }

                                    // ═══════════ PHASE 1: IMMEDIATE UI UPDATES ═══════════
                                    console.log('🎯 [COMPLETE] PHASE 1: Updating UI immediately...');

                                    // Update status to completed with timestamp
                                    // CRITICAL: Round completion time to nearest 5-minute mark
                                    const currentTime = new Date();
                                    const totalMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
                                    const roundedMinutes = Math.round(totalMinutes / 5) * 5;
                                    const roundedHours = Math.floor(roundedMinutes / 60);
                                    const roundedMins = roundedMinutes % 60;

                                    const year = currentTime.getFullYear();
                                    const month = String(currentTime.getMonth() + 1).padStart(2, '0');
                                    const day = String(currentTime.getDate()).padStart(2, '0');
                                    const hours = String(roundedHours).padStart(2, '0');
                                    const minutes = String(roundedMins).padStart(2, '0');
                                    const seconds = '00';

                                    // Get timezone offset in minutes and format as ±HH:MM
                                    const offsetMinutes = -currentTime.getTimezoneOffset();
                                    const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
                                    const offsetMins = Math.abs(offsetMinutes) % 60;
                                    const offsetSign = offsetMinutes >= 0 ? '+' : '-';
                                    const offsetString = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMins).padStart(2, '0')}`;

                                    const localTimeString = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetString}`;

                                    const completionUpdate = {
                                      status: 'completed',
                                      actual_delivery_time: localTimeString,
                                      isNextDelivery: false
                                    };

                                    // CRITICAL: Save to both offline and online databases
                                    console.log('💾 [COMPLETE] Saving completion to databases...');
                                    await updateDeliveryLocal(delivery.id, completionUpdate, { skipSmartRefresh: true });
                                    console.log('✅ [COMPLETE] Saved to databases');

                                    // CRITICAL: Re-fetch ALL deliveries to ensure we see the newly transitioned deliveries
                                    console.log('🔄 [Complete Pickup] Re-fetching ALL deliveries after Accept All...');
                                    const refreshedAfterAccept = await base44.entities.Delivery.filter({
                                      driver_id: delivery.driver_id,
                                      delivery_date: delivery.delivery_date
                                    });

                                    // Find and update next delivery flag
                                    const incompleteDeliveries = refreshedAfterAccept.
                                      filter((d) => d.id !== delivery.id && !FINISHED_STATUSES.includes(d.status) && d.status !== 'pending').
                                      sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

                                    console.log(`🎯 [Complete Pickup] Found ${incompleteDeliveries.length} incomplete deliveries`);
                                    if (incompleteDeliveries.length > 0) {
                                      const nextStop = incompleteDeliveries[0];
                                      console.log(`✅ [Complete Pickup] Setting isNextDelivery=true on ${nextStop.patient_name || 'Pickup'}`);
                                      await updateDeliveryLocal(nextStop.id, { isNextDelivery: true }, { skipSmartRefresh: true });
                                    } else {
                                      // CRITICAL: This is the FINAL stop - activate FAB phase 1 and show route summary
                                      console.log('🏁 [COMPLETE] FINAL STOP COMPLETED - Activating FAB and showing route summary');

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
                                    console.log('🔄 [COMPLETE] Refreshing UI with local data...');
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
                                     console.log('✅ [COMPLETE] UI updated with local data');
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
                                          console.log('📍 [COMPLETE] Scrolled to next delivery card');
                                        }
                                      }, 100);
                                    }

                                    // CRITICAL: Reactivate FAB immediately (before background work)
                                    fabControlEvents.reactivateFAB(true);

                                    console.log('✅ [COMPLETE] PHASE 1: UI updated - markers, routes, FAB, and next card centered');

                                    // ═══════════ PHASE 2: BACKGROUND TASKS ═══════════
                                    console.log('🔄 [COMPLETE] PHASE 2: Background tasks starting...');
                                    setIsProcessingBackground(true);

                                    // Background: Route optimization (fire and forget - don't wait)
                                    Promise.all([
                                     base44.functions.invoke('optimizeRouteRealTime', {
                                       driverId: delivery.driver_id,
                                       deliveryDate: delivery.delivery_date,
                                       currentLocalTime: format(currentTime, 'HH:mm'),
                                       generatePolyline: false
                                     }).then(() => {
                                       console.log('✅ [COMPLETE] Background: Route optimized');
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
                                     console.log('✅ [COMPLETE] All background tasks complete');
                                    });

                                  } catch (error) {
                                  console.error('❌ [COMPLETE] Error:', error);
                                  fabControlEvents.reactivateFAB(true);
                                  setIsProcessingBackground(false);
                                  setIsCompleting(false);
                                  } finally {
                                  const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                                  driverLocationPoller.resume();

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
                                  console.log('🎯 [START] Updating database...');

                                  // Get all driver deliveries
                                  const driverDeliveries = allDeliveries.filter((d) =>
                                    d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                                  );

                                  // Clear old isNextDelivery flags in database
                                  const resetPromises = driverDeliveries
                                    .filter((d) => d.isNextDelivery && d.id !== delivery.id)
                                    .map((d) => updateDeliveryLocal(d.id, { isNextDelivery: false }, { skipSmartRefresh: true }));

                                  if (resetPromises.length > 0) {
                                    await Promise.all(resetPromises);
                                    console.log(`✅ [START] Cleared ${resetPromises.length} old isNextDelivery flags`);
                                  }

                                  // Set this delivery as isNextDelivery with status update
                                  const now = new Date();
                                  const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                                  
                                  await updateDeliveryLocal(delivery.id, {
                                    isNextDelivery: true,
                                    status: isPickup ? 'en_route' : 'in_transit',
                                    delivery_time_start: currentLocalTime
                                  }, { skipSmartRefresh: true });
                                  console.log(`✅ [START] Set isNextDelivery=true on ${delivery.id}`);

                                  // Refresh UI
                                  invalidate('Delivery');
                                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                                  // Trigger map update
                                  window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                                    detail: { triggeredBy: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
                                  }));

                                  console.log('✅ [START] Complete');

                                  // Background tasks (fire and forget)
                                  Promise.all([
                                    base44.functions.invoke('optimizeRouteRealTime', {
                                      driverId: delivery.driver_id,
                                      deliveryDate: delivery.delivery_date,
                                      currentLocalTime: currentLocalTime,
                                      generatePolyline: false
                                    }).then(() => {
                                      console.log('✅ [START] Background: Route optimized');
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
                            console.log('⏸️ [Restart] Pausing location poller...');
                            const { driverLocationPoller } = await import('../utils/driverLocationPoller');
                            driverLocationPoller.pause();

                            await new Promise((resolve) => setTimeout(resolve, 100));

                            try {
                              const deliveryExists = await base44.entities.Delivery.filter({ id: delivery.id });
                              if (!deliveryExists || deliveryExists.length === 0) {
                                console.warn('⚠️ [RESTART] Delivery no longer exists - aborting');
                                throw new Error('This delivery has been deleted. Please refresh the page.');
                              }

                              console.log('🔄 [RESTART] Restarting delivery:', delivery.id);

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
                                console.log('🔄 [Restart Delivery] Running optimizeRouteRealTime...');
                                await base44.functions.invoke('optimizeRouteRealTime', {
                                  driverId: delivery.driver_id,
                                  deliveryDate: delivery.delivery_date,
                                  currentLocalTime: currentLocalTime,
                                  generatePolyline: false
                                });
                                console.log('✅ [Restart Delivery] Route optimized');

                                invalidate('Delivery');
                                await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                                console.log('✅ [Restart Delivery] UI refreshed with new stop order');
                              } catch (optimizeError) {
                                console.warn('⚠️ [Restart Delivery] Route optimizer failed:', optimizeError);
                              }

                              invalidate('Delivery');
                              await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                              console.log('✅ [RESTART] Delivery restarted successfully');

                              window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                                detail: { triggeredBy: 'restart', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
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

                              fabControlEvents.reactivateFAB(true);
                              setIsProcessingBackground(false);
                              setIsRestarting(false);
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

                          {!isPickup && patient && onEditPatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEditPatient(patient); }} className="text-base md:text-sm py-2.5 md:py-1.5">
                              <User className="w-5 h-5 md:w-4 md:h-4 mr-2" />
                              Edit Patient
                            </DropdownMenuItem>
                          }



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