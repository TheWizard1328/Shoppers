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
  SelectValue } from
"@/components/ui/select";
import { Phone, MapPin, Edit, Trash2, StickyNote, RotateCcw, MoreVertical, User, CheckCircle, Clock, Package, XCircle, Info, FileText, Save, X, Plus, Undo2, Loader2, Navigation, GripVertical, Bell, BellOff, Mailbox } from "lucide-react";
import { CombinedSpecialBadges, hasAnySpecialBadges } from '../utils/SpecialSymbolsBadges';
import { getStoreColor, hexToRgba, getContrastColor } from "../utils/colorGenerator";
import { format, isBefore, startOfDay, addDays } from "date-fns";
import { getDriverDisplayName } from '../utils/driverUtils';
import { userHasRole, shouldShowStoreBadges, isAppOwner } from '../utils/userRoles';
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { formatAddressWithUnit, cleanBuzzerFromAddress } from '../utils/addressCleaner';
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
  notifyDriverReturn } from
"../utils/deliveryMessaging";
import { triggerRouteOptimization } from "../utils/realTimeRouteOptimizer";
import { toast } from "sonner";
import { smartRefreshManager } from "../utils/smartRefreshManager";
import FailureReasonDialog from "../deliveries/FailureReasonDialog";
import { updateDeliveryLocal } from '../utils/offlineMutations';
import { fabControlEvents } from '../utils/fabControlEvents';
import { invalidate } from '../utils/dataManager';

// Global statusConfig
const statusConfig = {
  'pending': { label: 'Pending', color: 'bg-slate-100 text-slate-800' },
  'in_transit': { label: 'In Transit', color: 'bg-blue-100 text-blue-800' },
  'en_route': { label: 'En Route', color: 'bg-cyan-100 text-cyan-800' },
  'next': { label: 'Next', color: 'bg-lime-100 text-lime-800' },
  'completed': { label: 'Complete', color: 'bg-emerald-100 text-emerald-800' },
  'delivered': { label: 'Complete', color: 'bg-emerald-100 text-emerald-800' },
  'failed': { label: 'Failed', color: 'bg-red-100 text-red-800' },
  'cancelled': { label: 'Cancelled', color: 'bg-red-100 text-red-800' }
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
  dragHandleProps
}) {
  // CRITICAL: Use delivery.isNextDelivery from the entity, not the prop
  const isNextDelivery = delivery?.isNextDelivery || false;
  // CRITICAL FIX: ALL HOOKS MUST BE CALLED UNCONDITIONALLY AT THE TOP
  // Initialize with delivery prop values to maintain consistency
  const [notesInput, setNotesInput] = useState(delivery?.delivery_notes || "");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [codPayments, setCodPayments] = useState(delivery?.cod_payments || []);
  const [showCODCollection, setShowCODCollection] = useState(false);
  const [showReturnConfirm, setShowReturnConfirm] = useState(false);
  const [returnPatient, setReturnPatient] = useState(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPreparingReturn, setIsPreparingReturn] = useState(false);
  const [showFailureReasonDialog, setShowFailureReasonDialog] = useState(false);
  const [pendingFailureStatus, setPendingFailureStatus] = useState(null);
  const [isHovered, setIsHovered] = useState(false);
  const codAmountInputRefs = useRef([]);
  const { setIsEntityUpdating, forceRefreshDriverDeliveries, refreshData, updateDeliveriesLocally } = useAppData();

  // Detect if this is a stripped delivery (from other store)
  // For dispatchers: strip deliveries that aren't from their assigned stores
  // CRITICAL: Must be defined BEFORE isExpanded which depends on it
  const isStrippedDelivery = useMemo(() => {
    if (delivery?._isStripped === true) return true;

    // Check if current user is a dispatcher (but not admin)
    if (!currentUser) return false;
    const isDispatcher = userHasRole(currentUser, 'dispatcher');
    const isAdmin = userHasRole(currentUser, 'admin');

    // Admins see everything, drivers see their own deliveries (handled elsewhere)
    if (isAdmin || !isDispatcher) return false;

    // For dispatchers, check if this delivery's store is in their assigned stores
    const dispatcherStoreIds = currentUser.store_ids || [];
    if (dispatcherStoreIds.length === 0) return false;

    // If the delivery's store is not in dispatcher's stores, strip it
    return delivery?.store_id && !dispatcherStoreIds.includes(delivery.store_id);
  }, [delivery?._isStripped, delivery?.store_id, currentUser]);

  // Helper to auto-toggle driver online if offline
  const ensureDriverOnline = async () => {
    if (!currentUser?.id) return;

    try {
      const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
      if (appUsers && appUsers.length > 0) {
        const appUser = appUsers[0];
        if (appUser.driver_status !== 'on_duty') {
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
      }
    } catch (error) {
      console.error('Failed to auto-toggle driver online:', error);
    }
  };

  // Use isSelected prop to control expansion (parent controls state)
  // CRITICAL: Stripped deliveries cannot be expanded
  const isExpanded = isSelected && !isStrippedDelivery;

  // Sync state with delivery prop changes
  useEffect(() => {
    setNotesInput(delivery?.delivery_notes || "");
  }, [delivery?.delivery_notes]);

  useEffect(() => {
    setCodPayments(delivery?.cod_payments || []);
  }, [delivery?.cod_payments]);

  // Memoized values - ALWAYS calculated
  const patient = useMemo(() => {
    if (!delivery?.patient_id || !patients || patients.length === 0) return null;
    return patients.find((p) => p && p.id === delivery.patient_id);
  }, [delivery?.patient_id, patients]);

  const isPickup = useMemo(() => {
    if (!delivery) return false;
    return !delivery.patient_id && !!delivery.store_id;
  }, [delivery?.patient_id, delivery?.store_id]);

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
    if (isPickup) return `${store?.name || 'Unknown Store'} Pickup`;
    return patient?.full_name || 'Unknown';
  }, [delivery, isPickup, store, patient]);

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

  const shouldRedact = useMemo(() => {
    if (!delivery || !currentUser) return false;
    // Redact completed deliveries for drivers (not admins/dispatchers)
    if (isCompleted && !isPickup &&
    !userHasRole(currentUser, 'admin') &&
    !userHasRole(currentUser, 'dispatcher') &&
    userHasRole(currentUser, 'driver')) {
      return true;
    }
    // Redact when route is complete for drivers
    if (isRouteCompleted && !isPickup &&
    !userHasRole(currentUser, 'admin') &&
    !userHasRole(currentUser, 'dispatcher') &&
    userHasRole(currentUser, 'driver')) {
      return true;
    }
    return false;
  }, [isCompleted, isPickup, currentUser, delivery, isRouteCompleted]);

  const shouldShowStoreBadge = useMemo(() => shouldShowStoreBadges(currentUser), [currentUser]);

  const finalDisplayName = useMemo(() => {
    if (isStrippedDelivery && !shouldRedact) {
      if (store?.name) {
        return `${store.name} ${isPickup ? 'Pickup' : 'Delivery'}`;
      }
      return isPickup ? 'Other Store Pickup' : 'Other Store Delivery';
    }
    if (!shouldRedact) return displayName;
    const firstName = patient?.full_name?.split(' ')[0] || '';
    return firstName + ' *****';
  }, [isStrippedDelivery, shouldRedact, displayName, patient, isPickup, store]);

  const finalDisplayAddress = useMemo(() => {
    if (isStrippedDelivery) return '';
    if (!shouldRedact) return displayAddress;
    const firstPart = displayAddress?.split(' ')[0] || '';
    return firstPart + ' *****';
  }, [isStrippedDelivery, shouldRedact, displayAddress]);

  const finalDisplayPhone = useMemo(() => {
    if (isStrippedDelivery) return null;
    if (!shouldRedact) return displayPhone;
    if (!displayPhone) return null;
    return `(***) ***-${displayPhone.replace(/\D/g, '').slice(-4)}`;
  }, [isStrippedDelivery, shouldRedact, displayPhone]);

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
      // Focus and select the input after type change
      setTimeout(() => {
        if (codAmountInputRefs.current[index]) {
          codAmountInputRefs.current[index].focus();
          codAmountInputRefs.current[index].select();
        }
      }, 50);
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
        console.error('Failed to save COD payments:', error);
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

    try {
      await onCreateReturn({
        originalDelivery: delivery,
        returnPatient: returnPatient,
        store: store
      });

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
    }
  };

  const handleCancelReturn = () => {
    setShowReturnConfirm(false);
    setReturnPatient(null);
  };

  // Determine if card should be faded
  // CRITICAL: Only fade completed stops on current date (not past dates)
  const shouldFade = useMemo(() => {
    if (!delivery || isExpanded || isHovered) return false;
    
    // Check if this is current date
    const today = startOfDay(new Date());
    const deliveryDateObj = startOfDay(new Date(delivery.delivery_date));
    const isCurrentDate = deliveryDateObj.getTime() === today.getTime();
    
    // Only fade if: current date AND finished status
    if (isCurrentDate && FINISHED_STATUSES.includes(delivery.status)) {
      return true;
    }
    
    return false;
  }, [delivery, isExpanded, isHovered]);

  return (
    <motion.div
      id={`stop-card-${delivery.id}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className={`w-full cursor-pointer transition-all ${isSelected && !isStrippedDelivery ? 'ring-2 ring-blue-500' : ''}`}
      style={{ scrollSnapAlign: 'center' }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}>
      <Card className="bg-card text-card-foreground rounded-xl border shadow-md cursor-pointer hover:shadow-lg transition-all duration-200 min-w-[340px] max-w-[340px] border-blue-500"


      onClick={() => {
        // Don't trigger click/expand for stripped deliveries
        if (!isStrippedDelivery) {
          onClick && onClick(delivery);
        }
      }}
      style={{
        background: 'var(--bg-white)',
        borderColor: isNextDelivery ? '#10B981' : '#3B82F6',
        opacity: shouldFade ? 0.4 : 1,
        transition: 'opacity 0.2s ease-in-out'
      }}>
        <CardContent className="mt-1 mb-1 px-3 py-0 flex flex-col">
          {/* HEADER SECTION - Always Visible */}
          <div className="flex items-start gap-1">
            {/* Drag Handle - Only show for non-finished deliveries */}
            {showDragHandle && dragHandleProps && !FINISHED_STATUSES.includes(delivery.status) &&
            <div {...dragHandleProps} className="flex items-center justify-center cursor-grab active:cursor-grabbing pt-1 mr-1">
                <GripVertical className="w-5 h-5 text-slate-400 hover:text-slate-600" />
              </div>
            }
            
            <div className="flex flex-col py-0. gap-0.5  items-center">
              <Badge
                variant="secondary" className={`inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary hover:bg-secondary/80 font-bold text-sm px-2 py-0.5 text-white w-[40px] justify-center ${delivery.ampm_deliveries === 'PM' ? 'rounded-md' : 'rounded-full'}`}
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

              {hasAnySpecialBadges(delivery, patient, isPickup) && (
                <CombinedSpecialBadges
                  delivery={delivery}
                  patient={patient}
                  isPickup={isPickup}
                  size="md"
                  className="mt-1"
                />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <h3 className="pt-0 text-xl font-semibold text-center truncate" style={{ color: 'var(--text-slate-900)' }}>
                {finalDisplayName}
              </h3>
              <div className="flex flex-col items-center">
                <div className="text-sm flex items-center justify-center" style={{ color: 'var(--text-slate-600)' }}>
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
                <div className="text-[11px] min-h-[14px]" style={{ color: 'var(--text-slate-500)' }}>
                  {!FINISHED_STATUSES.includes(delivery.status) && (delivery.time_window_start || delivery.time_window_end) &&
                  <>
                      {delivery.time_window_start && formatTime12Hour(delivery.time_window_start)}
                      {delivery.time_window_start && delivery.time_window_end && ' - '}
                      {delivery.time_window_end && formatTime12Hour(delivery.time_window_end)}
                    </>
                  }
                </div>
              </div>
            </div>

            <div className="flex flex-col py-0.5 gap-0.5 items-center">
              <div className="flex items-center gap-1">
                {showStatusDropdown && !FINISHED_STATUSES.includes(delivery.status) && !isReturnDelivery ?
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className={`inline-flex items-center gap-1 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-sm font-bold px-2 py-0.5 cursor-pointer hover:opacity-80 ${
                    delivery.status === 'en_route' ? 'bg-cyan-100 text-cyan-800' :
                    statusConfig[delivery.status]?.color || ''}`
                    }
                    style={!delivery.status || delivery.status === 'en_route' || statusConfig[delivery.status] ? {} : {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-800)'
                    }}
                    onClick={(e) => e.stopPropagation()}>
                        {statusConfig[delivery.status]?.label || delivery.status}
                        <MoreVertical className="w-3 h-3" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="z-[200] text-base p-2 space-y-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                      {nextAvailableStatuses.filter((s) => !['pending', 'Ready For Pickup'].includes(s)).map((status) => {
                      const isCompleteStatus = status === 'completed';
                      const isFailedStatus = status === 'failed' || status === 'cancelled';

                      if (isCompleteStatus || isFailedStatus) {
                        return (
                          <Button
                            key={status}
                            onClick={async (e) => {
                              e.stopPropagation();

                              // Show failure reason dialog for failed/cancelled
                              if (isFailedStatus) {
                                setPendingFailureStatus(status);
                                setShowFailureReasonDialog(true);
                                return;
                              }

                              fabControlEvents.deactivateFAB();
                              setIsEntityUpdating(true);
                              smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
                              await new Promise((resolve) => setTimeout(resolve, 100));

                              try {
                                await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                                await onStatusUpdate(delivery.id, status, {}, false);

                                // CRITICAL: Run recursive route optimization after completion
                                try {
                                  const now = new Date();
                                  const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
                                  console.log('🔄 [Completed] Running optimizeRouteRealTime...');
                                  await base44.functions.invoke('optimizeRouteRealTime', {
                                    driverId: delivery.driver_id,
                                    deliveryDate: delivery.delivery_date,
                                    currentLocalTime: currentLocalTime,
                                    generatePolyline: false
                                  });
                                  console.log('✅ [Completed] Route optimized');

                                  // CRITICAL: Refresh UI to show reordered stops
                                  invalidate('Delivery');
                                  await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                                  console.log('✅ [Completed] UI refreshed with new stop order');
                                } catch (optimizeError) {
                                  console.warn('⚠️ [Completed] Route optimizer failed:', optimizeError);
                                }

                                if (status === 'completed' && userHasRole(currentUser, 'driver')) {
                                  await notifyDriverCompleted({
                                    driver: currentUser,
                                    patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                                    delivery,
                                    store,
                                    appUsers
                                  });
                                }
                              } finally {
                                setIsEntityUpdating(false);
                                await new Promise((resolve) => setTimeout(resolve, 100));
                                fabControlEvents.reactivateFAB(true);
                              }
                            }}
                            className={`w-full justify-center text-center font-semibold ${
                            isCompleteStatus ? 'bg-emerald-600 hover:bg-emerald-700 text-white' :
                            isFailedStatus ? 'bg-red-600 hover:bg-red-700 text-white' : ''}`
                            }
                            size="sm">

                              {isCompleteStatus ? 'Complete' : isFailedStatus ? isPickup ? 'Cancelled' : 'Failed' : statusConfig[status]?.label || status}
                            </Button>);

                      }

                      return (
                        <DropdownMenuItem
                          key={status}
                          className="capitalize text-base"
                          onClick={async (e) => {
                            e.stopPropagation();
                            setIsEntityUpdating(true);
                            smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
                            await new Promise((resolve) => setTimeout(resolve, 100));

                            try {
                              await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                              const finishedStatuses = ['completed', 'failed', 'cancelled'];
                              const skipAutoCenter = !finishedStatuses.includes(status);
                              await onStatusUpdate(delivery.id, status, {}, skipAutoCenter);

                              // Next delivery flag handled by route optimizer
                            } finally {
                              console.log('▶️ [STATUS MENU] Resuming smart refresh');
                              setIsEntityUpdating(false);
                              await new Promise((resolve) => setTimeout(resolve, 100));
                              console.log('✅ [STATUS MENU] Status change cycle complete');
                            }
                          }}>

                            {statusConfig[status]?.label || status}
                          </DropdownMenuItem>);

                    })}
                    </DropdownMenuContent>
                  </DropdownMenu> :

                <Badge
                  variant="secondary" className={`border-transparent inline-flex items-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-sm font-bold px-2 py-0.5 ${
                  isReturnDelivery ? 'bg-orange-500 !text-white' :
                  delivery.status === 'failed' ? 'bg-red-500 !text-white' :
                  delivery.status === 'cancelled' ? 'bg-red-500 !text-white' :
                  'bg-emerald-500 !text-white'}`
                  }>

                    {isReturnDelivery ? 'Return' : statusConfig[delivery.status]?.label || delivery.status}
                  </Badge>
                }
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

          {/* Hide address/phone section for stripped deliveries */}
          {!isStrippedDelivery && <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}></div>}

          {!isStrippedDelivery && <div className="flex flex-col">
            <div className="flex items-start justify-between">
              <div className="mt-1 flex flex-col justify-center gap-0.5 flex-1 min-w-0 min-h-[50px]">
                {finalDisplayAddress ?
                <>
                  {/* Main address without unit/buzzer */}
                  <div className="flex items-start gap-2 text-sm" style={{ color: 'var(--text-slate-700)' }}>
                    <span className="text-xl font-medium truncate">
                      {isPickup ? store?.address || '' : patient?.address || ''}
                    </span>
                  </div>

                    {/* Unit/Buzzer row (phone removed - now in expanded section) */}
                    {!isStrippedDelivery && !shouldRedact &&
                  <div className="flex items-center text-sm" style={{ color: 'var(--text-slate-600)' }}>
                        {/* Unit and Buzzer info */}
                        {(() => {
                      const unitNum = !isPickup ? delivery?.unit_number || patient?.unit_number : null;
                      const fullAddress = isPickup ? store?.address || '' : patient?.address || '';
                      const buzzerMatch = fullAddress.match(/buzz(?:er)?\s*(\d+)/i);
                      const buzzerNum = buzzerMatch ? buzzerMatch[1] : null;

                      if (!unitNum && !buzzerNum) return null;

                      return (
                        <>
                              {unitNum && <span className="text-base font-medium">#{unitNum}</span>}
                              {buzzerNum && <span className="text-sm font-medium">Buzz {buzzerNum}</span>}
                            </>);
                    })()}
                      </div>
                  }
                  </> :
                <div className="w-full h-[26px]" />
                }
              </div>

              {/* Navigation and Phone buttons - right justified - Only for assigned driver or app owner */}
              {isAssignedDriverOrAppOwner &&
              <div className="mt-1 py-1 flex items-center gap-2 flex-shrink-0">
                  {finalDisplayPhone &&
                <a
                  href={`tel:${finalDisplayPhone.replace(/\D/g, '')}`}
                  onClick={(e) => e.stopPropagation()} className="flex items-center justify-center w-11 h-11 rounded-full bg-emerald-100 hover:bg-emerald-200 text-emerald-600 transition-colors">
                      <Phone className="w-5 h-5" />
                    </a>
                }
                  {finalDisplayAddress &&
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
                  onClick={(e) => e.stopPropagation()} className="flex items-center justify-center w-11 h-11 rounded-full bg-blue-100 hover:bg-blue-200 text-blue-600 transition-colors">
                      <Navigation className="w-5 h-5" />
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

                  <div className="rounded-lg p-3 space-y-1 text-sm" style={{ background: 'var(--bg-slate-50)' }}>
                    <div>
                      <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Name:</span>
                      <p className="pl-16" style={{ color: 'var(--text-slate-900)' }}>{displayName}</p>
                    </div>

                    {displayAddress &&
                    <div>
                        <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Address:</span>
                        <p className="pl-16" style={{ color: 'var(--text-slate-900)' }}>{displayAddress}</p>
                      </div>
                    }

                    {delivery.tracking_number &&
                    <div>
                        <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Tr#:</span>
                        <p className="pl-16" style={{ color: 'var(--text-slate-900)' }}>{delivery.tracking_number}</p>
                      </div>
                    }
                  </div>

                  <p className="text-sm text-red-600 font-medium">
                    This action cannot be undone.
                  </p>
                </div>

                <div className="flex gap-3">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setShowDeleteConfirm(false)}>
                    Cancel
                  </Button>
                  <Button
                    className="flex-1 bg-red-600 hover:bg-red-700"
                    onClick={async () => {
                      setIsEntityUpdating(true);
                      await new Promise((resolve) => setTimeout(resolve, 100));

                      try {
                        await onDeleteDelivery(delivery.id);
                      } finally {
                        setShowDeleteConfirm(false);
                        smartRefreshManager.lastRefreshTimes = {
                          driverLocation: 0,
                          activeDeliveries: 0,
                          todayDeliveries: 0,
                          appUsers: 0,
                          patients: 0,
                          stores: 0
                        };
                        setIsEntityUpdating(false);
                      }
                    }}>
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* Failure Reason Dialog */}
          <FailureReasonDialog
            isOpen={showFailureReasonDialog}
            onClose={() => {
              setShowFailureReasonDialog(false);
              setPendingFailureStatus(null);
            }}
            onConfirm={async (reason) => {
              setShowFailureReasonDialog(false);
              const status = pendingFailureStatus;
              setPendingFailureStatus(null);

              fabControlEvents.deactivateFAB();
              setIsEntityUpdating(true);
              smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
              await new Promise((resolve) => setTimeout(resolve, 100));

              try {
                await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                // Add reason to delivery notes
                const existingNotes = delivery.delivery_notes || '';
                const updatedNotes = existingNotes ?
                `${existingNotes}\n[${status.toUpperCase()}] ${reason}` :
                `[${status.toUpperCase()}] ${reason}`;

                await onStatusUpdate(delivery.id, status, { delivery_notes: updatedNotes }, false);

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
                } catch (optimizeError) {
                  console.warn('⚠️ [Failed/Cancelled] Route optimizer failed:', optimizeError);
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

                toast.error(`${isPickup ? 'Pickup' : 'Delivery'} marked as ${status}`, {
                  description: `Dispatch has been notified. Reason: ${reason}`
                });

              } finally {
                setIsEntityUpdating(false);
                await new Promise((resolve) => setTimeout(resolve, 100));
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
                      <p className="text-xs" style={{ color: 'var(--text-slate-900)' }}>PATIENT RETURN For: {patient?.full_name || delivery.patient_name || 'Unknown'}</p>
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
                    onClick={handleCancelReturn}>
                    Cancel
                  </Button>
                  <Button
                    className="flex-1 bg-orange-600 hover:bg-orange-700"
                    onClick={handleConfirmReturn}>
                    <Undo2 className="w-4 h-4 mr-2" />
                    Create Return
                  </Button>
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* BODY SECTION - Expandable */}
          <AnimatePresence>
            {isExpanded && !isStrippedDelivery &&
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="pt-3 space-y-3 border-t mt-2" style={{ borderColor: 'var(--border-slate-200)' }}>
                  {/* Phone number - moved below divider */}
                  {finalDisplayPhone &&
                <div className="flex items-center text-sm" style={{ color: 'var(--text-slate-600)' }}>
                      <Phone className="w-4 h-4 mr-2 text-slate-500" />
                      <span className="text-base font-medium">{formatPhoneNumber(finalDisplayPhone)}</span>
                    </div>
                }

                  {/* COD Information - Moved to expandable section */}
                  {hasCODRequired && !isPickup && !FINISHED_STATUSES.includes(delivery.status) &&
                <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                      <span className="text-xs font-semibold text-amber-800">COD Required: ${codTotalRequired.toFixed(2)}</span>
                      {userHasRole(currentUser, 'driver') &&
                  <Button size="sm" variant="ghost" className="h-6 text-xs text-amber-700 hover:text-amber-900" onClick={(e) => {
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

                  {hasCODRequired && !isPickup && codPayments.length > 0 &&
                <div className={`flex items-center justify-between rounded-md px-2 py-1 ${isCODComplete ? 'bg-emerald-50 border border-emerald-200' : 'bg-amber-50 border border-amber-200'}`}>
                      <span className={`text-xs font-semibold ${isCODComplete ? 'text-emerald-800' : 'text-amber-800'}`}>
                        {codPayments.map((payment, index) =>
                    <span key={index}>
                            {payment.type}: ${payment.amount.toFixed(2)}
                            {index < codPayments.length - 1 && ', '}
                          </span>
                    )}
                      </span>
                      {!FINISHED_STATUSES.includes(delivery.status) && userHasRole(currentUser, 'driver') ||
                  FINISHED_STATUSES.includes(delivery.status) && userHasRole(currentUser, 'admin') ?
                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={(e) => {e.stopPropagation();setShowCODCollection(!showCODCollection);}}>Edit</Button> :
                  null}
                    </div>
                }

                  <AnimatePresence>
                    {showCODCollection && hasCODRequired && !isPickup && (userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')) &&
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden bg-slate-50 rounded-md p-3 space-y-2 w-full"
                    onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-slate-700">Collect COD Payments</span>
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={(e) => {e.stopPropagation();setShowCODCollection(false);}}>
                            <X className="w-3 h-3" />
                          </Button>
                        </div>

                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {codPayments.map((payment, index) =>
                      <div key={index} className="flex items-center gap-2 bg-white p-2 rounded border border-slate-200">
                              <Select value={payment.type} onValueChange={(value) => handleCODPaymentChange(index, 'type', value)} onOpenChange={(open) => {if (open) setShowCODCollection(true);}}>
                               <SelectTrigger className="h-7 text-xs w-24" onClick={(e) => e.stopPropagation()} data-cod-select-index={index}>
                                 <SelectValue placeholder="Type" />
                               </SelectTrigger>
                                <SelectContent onClick={(e) => e.stopPropagation()} className="z-[200]">
                                  <SelectItem value="Cash">Cash</SelectItem>
                                  <SelectItem value="Debit">Debit</SelectItem>
                                  <SelectItem value="Credit">Credit</SelectItem>
                                  <SelectItem value="Check">Check</SelectItem>
                                </SelectContent>
                              </Select>

                              <div className="relative flex-1">
                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">$</span>
                                <input
                            ref={(el) => codAmountInputRefs.current[index] = el}
                            type="text"
                            value={payment.amount > 0 ? payment.amount.toFixed(2) : payment.amount === 0 ? '0.00' : ''}
                            onChange={(e) => handleCODPaymentChange(index, 'amount', e.target.value)} className="h-7 w-full pl-5 pr-2 text-xs bg-white border border-slate-300 rounded-md"

                            placeholder="0.00"
                            onClick={(e) => e.stopPropagation()}
                            onFocus={(e) => e.target.select()} />

                              </div>

                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-600 hover:text-red-800" onClick={(e) => {e.stopPropagation();handleRemoveCODPayment(index);}}>
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                      )}
                        </div>

                        <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={(e) => {e.stopPropagation();handleAddCODPayment();}}>
                          <Plus className="w-3 h-3 mr-1" />
                          Add Payment
                        </Button>

                        <div className="flex items-center justify-between pt-2 border-t border-slate-200">
                          <div className="text-xs">
                            <span className="text-slate-600">Total: </span>
                            <span className={`font-bold ${isCODComplete ? 'text-emerald-600' : 'text-amber-600'}`}>
                              ${codTotalCollected.toFixed(2)}
                            </span>
                            <span className="text-slate-600"> / ${codTotalRequired.toFixed(2)}</span>
                          </div>

                          <Button size="sm" className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary-foreground shadow rounded-md px-3 h-7 text-xs !text-white bg-emerald-600 hover:bg-emerald-700" onClick={(e) => {e.stopPropagation();handleSaveCODPayments();}} disabled={codPayments.length === 0}>
                            <Save className="w-3 h-3 mr-1" />
                            Save
                          </Button>
                        </div>
                      </motion.div>
                  }
                  </AnimatePresence>

                  {!isPickup && patient && (patient.notes || patient.mailbox_ok || patient.call_upon_arrival || patient.dont_ring_bell || patient.back_door || patient.recurring) &&
                <div className="flex items-start gap-2">
                <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--text-slate-700)' }}>Patient Info:</p>
                  <div className="text-xs rounded px-2 py-1.5 space-y-1" style={{ color: 'var(--text-slate-600)', background: 'var(--bg-slate-50)', borderWidth: '1px', borderColor: 'var(--border-slate-200)' }}>
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

                  {/* Show pending pickup list for pickups that are en_route (equivalent to in_transit for deliveries) */}
                  {isPickup && delivery.status === 'en_route' && pendingPickups && pendingPickups.length > 0 &&
                <div className="pt-2 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-xs font-bold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
                          <Package className="w-3.5 h-3.5" />
                          Pending Pickup List ({pendingPickups.length})
                        </h4>
                        {canAccessAcceptButtons &&
                    <Button
                      size="sm"
                      variant="default" className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow rounded-md h-6 px-2 text-xs !text-white bg-emerald-600 hover:bg-emerald-700 text-white"

                      onClick={async (e) => {
                        e.stopPropagation();
                        console.log('🟢 [Assign All] Step 1: Running smart refresh...');

                        // Step 1: Run smart refresh
                        smartRefreshManager.lastRefreshTimes = {
                          driverLocation: 0,
                          activeDeliveries: 0,
                          todayDeliveries: 0,
                          appUsers: 0,
                          patients: 0,
                          stores: 0
                        };
                        await new Promise((resolve) => setTimeout(resolve, 200));

                        // Step 2: Pause smart refresh
                        console.log('🟢 [Assign All] Step 2: Pausing smart refresh...');
                        setIsEntityUpdating(true);
                        await new Promise((resolve) => setTimeout(resolve, 100));

                        try {
                          // Step 3: Change all pending stops to in_transit
                          console.log('🟢 [Assign All] Step 3: Changing pending stops to in_transit...');
                          const allPendingDeliveries = pendingPickups.filter((p) => p.status === 'pending');
                          console.log(`  Found ${allPendingDeliveries.length} pending deliveries`);

                          // Get pickup's stop_order
                          const pickupStopOrder = delivery.stop_order || 0;
                          console.log(`  Pickup stop order: ${pickupStopOrder}`);

                          // CRITICAL: Set delivery_time_start to current time + 5 minutes for all pending deliveries
                          const now = new Date();
                          const currentMinutes = now.getHours() * 60 + now.getMinutes();
                          const startMinutes = currentMinutes + 5;
                          const deliveryTimeStart = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
                          const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                          // Update all pending deliveries to in_transit with delivery_time_start
                          for (const pendingDelivery of allPendingDeliveries) {
                            await updateDeliveryLocal(pendingDelivery.id, {
                              status: 'in_transit',
                              delivery_time_start: deliveryTimeStart
                            }, { skipSmartRefresh: true });
                            console.log(`    ✅ ${pendingDelivery.patient_name} → in_transit, delivery_time_start: ${deliveryTimeStart}`);
                          }

                          // Step 4: Sort by delivery_time_start and group by store for staged optimization
                          console.log('🟢 [Assign All] Step 4: Sorting by delivery_time_start and optimizing in stages...');

                          // Group deliveries by store_id for staged optimization
                          const deliveriesByStore = new Map();
                          for (const d of allPendingDeliveries) {
                            const storeId = d.store_id;
                            if (!deliveriesByStore.has(storeId)) {
                              deliveriesByStore.set(storeId, []);
                            }
                            deliveriesByStore.get(storeId).push(d);
                          }

                          console.log(`  Found ${deliveriesByStore.size} store groups to optimize`);

                          // CRITICAL: Run recursive route optimizer
                          try {
                            console.log('🔄 [Accept/Assign All] Running optimizeRouteRealTime...');
                            await base44.functions.invoke('optimizeRouteRealTime', {
                              driverId: delivery.driver_id,
                              deliveryDate: delivery.delivery_date,
                              currentLocalTime: currentLocalTime,
                              generatePolyline: false
                            });
                            console.log('✅ [Accept/Assign All] Route optimized');

                            // CRITICAL: Refresh UI to show reordered stops
                            invalidate('Delivery');
                            await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                            console.log('✅ [Accept/Assign All] UI refreshed with new stop order');
                          } catch (optimizeError) {
                            console.warn('⚠️ [Accept/Assign All] Route optimizer failed, continuing without optimization:', optimizeError);
                          }

                          // Step 5: Update TR#s sequentially for newly accepted stops
                          console.log('🟢 [Assign All] Step 5: Assigning sequential TR#s...');

                          const pickupTR = parseInt(delivery.tracking_number, 10);
                          const baseTR = isNaN(pickupTR) ? 0 : pickupTR;
                          console.log(`  Using pickup TR# ${baseTR} as base`);

                          // Sort pending by patient name for consistent TR# assignment
                          const sortedPending = [...allPendingDeliveries].sort((a, b) =>
                          (a.patient_name || '').localeCompare(b.patient_name || '')
                          );

                          // Assign sequential TR#s
                          for (let i = 0; i < sortedPending.length; i++) {
                            const newTR = String(baseTR + i + 1);
                            await updateDeliveryLocal(sortedPending[i].id, {
                              tracking_number: newTR
                            }, { skipSmartRefresh: true });
                            console.log(`  ✅ ${sortedPending[i].patient_name}: TR# ${newTR}`);
                          }
                          console.log('  ✅ TR#s assigned sequentially');

                          // Step 6 & 7: Update UI and sync offline/online DBs
                          console.log('🟢 [Assign All] Step 6-7: Force refreshing data...');
                          await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                          console.log('  ✅ Data refreshed and synced');

                          // Send notifications
                          const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id;
                          if (isDriverAction) {
                            await notifyDriverAcceptedAll({
                              driver: currentUser,
                              store,
                              appUsers
                            });
                          } else {
                            const assignedDriver = drivers.find((d) => d?.id === delivery.driver_id);
                            if (assignedDriver) {
                              await notifyDispatcherAssignedAll({
                                dispatcher: currentUser,
                                driver: assignedDriver,
                                store,
                                deliveries: allPendingDeliveries,
                                patients
                              });
                            }
                          }

                          console.log('✅ [Assign All] Complete');
                        } finally {
                          // Step 8: Reset and resume smart refresh
                          console.log('🟢 [Assign All] Step 8: Resetting smart refresh...');
                          smartRefreshManager.lastRefreshTimes = {
                            driverLocation: 0,
                            activeDeliveries: 0,
                            todayDeliveries: 0,
                            appUsers: 0,
                            patients: 0,
                            stores: 0
                          };
                          setIsEntityUpdating(false);
                          console.log('  ✅ Smart refresh resumed');
                        }
                      }}>
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

                      const hasSpecialSymbols = hasAnySpecialBadges(projectedDelivery, projPatient, false);

                      return (
                        <div
                          key={deliveryId}
                          className="flex items-center justify-between gap-2 border px-2.5 py-1.5 rounded-md cursor-pointer transition-colors"
                          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
                          onMouseEnter={(e) => {e.currentTarget.style.background = 'var(--bg-slate-50)';}}
                          onMouseLeave={(e) => {e.currentTarget.style.background = 'var(--bg-white)';}}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (onEditDelivery && projectedDelivery.id) {
                              onEditDelivery(projectedDelivery);
                            }
                          }}>

                              <span className="text-xs font-medium truncate flex-1" style={{ color: 'var(--text-slate-900)' }}>
                                {projectedDelivery.patient_name || 'Unknown Patient'}
                              </span>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {hasSpecialSymbols && (
                                  <CombinedSpecialBadges
                                    delivery={projectedDelivery}
                                    patient={projPatient}
                                    isPickup={false}
                                    size="sm"
                                  />
                                )}
                                <span className="text-xs font-semibold" style={{ color: 'var(--text-slate-600)' }}>
                                  TR#{projectedDelivery.tracking_number || '??'}
                                </span>
                                {/* Individual accept button - only for assigned driver, dispatcher, or admin */}
                                {canAccessAcceptButtons &&
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-5 w-5 p-0 ml-1 bg-emerald-100 hover:bg-emerald-200 text-emerald-700"
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (!onStatusUpdate) return;

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
                              }}>
                                    <Plus className="w-3 h-3" />
                                  </Button>
                            }
                              </div>
                            </div>);
                    })}
                      </div>
                    </div>
                }

                  <div className="space-y-1 mt-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--text-slate-700)' }}>Driver Notes</Label>
                    </div>
                    <Textarea
                    value={notesInput}
                    onChange={(e) => setNotesInput(e.target.value)}
                    onBlur={handleNotesBlur}
                    onKeyDown={handleNotesKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="Add driver notes..."
                    className="text-xs resize-none h-16"
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}
                    disabled={isCompleted && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher')} />
                  </div>
                </div>
              </motion.div>
            }
          </AnimatePresence>

          {/* FOOTER SECTION - Only visible to assigned driver or app owner */}
          {!isStrippedDelivery && isAssignedDriverOrAppOwner && <div className="space-y-3 mt-2">
            <div className="border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
              <div className="mt-2 mx-auto pb-1 flex justify-between items-center">
                {(isAssignedDriverOrAppOwner || canEdit) &&
                <>
                    {/* Return button for failed deliveries - creates new return delivery */}
                    {delivery.status === 'failed' && !isPickup &&
                  <Button
                    onClick={handleReturnClick}
                    size="sm" className="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow rounded-md px-3 text-xs bg-orange-600 hover:bg-orange-700 !text-white h-8"

                    disabled={isPreparingReturn || hasFutureReturn || hasCompletedDelivery}>
                        {isPreparingReturn ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Undo2 className="w-3 h-3 mr-1 !text-white" />}
                        Return
                      </Button>
                  }

                    {/* Start/Complete/Retry button and menu - right aligned */}
                    <div className="flex items-center ml-auto">
                      {delivery.status === 'failed' && onStatusUpdate ?
                    <Button
                      onClick={async (e) => {
                        e.stopPropagation();
                        fabControlEvents.deactivateFAB();
                        setIsRetrying(true);
                        setIsEntityUpdating(true);
                        smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
                        await new Promise((resolve) => setTimeout(resolve, 100));

                        try {
                          await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                          await ensureDriverOnline();
                          await onStatusUpdate(delivery.id, isPickup ? 'en_route' : 'in_transit');
                          // Send notification to dispatchers
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
                          setIsRetrying(false);
                          console.log('▶️ [RETRY] Resuming smart refresh');
                          setIsEntityUpdating(false);
                          await new Promise((resolve) => setTimeout(resolve, 100));
                          console.log('✅ [RETRY] Retry cycle complete');

                          // CRITICAL: Reactivate FAB after action (skip card scroll - FAB handles it)
                          fabControlEvents.reactivateFAB(true);
                        }
                      }}
                      size="sm"
                      className="bg-blue-600 hover:bg-blue-700 h-8 rounded-r-none border-r border-blue-500 !text-white"
                      disabled={isRetrying || !canRetry || hasFutureRetry || hasCompletedDelivery}>
                          {isRetrying ? <Loader2 className="w-3 h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-3 h-3 mr-1 !text-white" />}
                          <span className="text-white">Retry</span>
                        </Button> :
                    delivery.status !== 'completed' && delivery.status !== 'cancelled' && (
                    isNextDelivery ?
                    <Button
                      onClick={async (e) => {
                        e.stopPropagation();
                        fabControlEvents.deactivateFAB();
                        setIsCompleting(true);
                        setIsEntityUpdating(true);
                        smartRefreshManager.registerPendingUpdate(delivery.id, delivery.driver_id, delivery.delivery_date);
                        await new Promise((resolve) => setTimeout(resolve, 100));

                        try {
                          await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                          // Auto-toggle driver online if offline
                          await ensureDriverOnline();

                          // CRITICAL: For pickups with pending deliveries, force Accept All FIRST
                          if (isPickup && pendingPickups && pendingPickups.length > 0) {
                            // Check if there are pending deliveries that haven't been accepted yet
                            const hasPendingDeliveries = pendingPickups.some((p) => p.status === 'pending');

                            if (hasPendingDeliveries) {
                              console.log('⚠️ [Complete Pickup] Pending deliveries detected - triggering Accept All first...');

                              // Simulate Accept All button click
                              const allPendingDeliveries = pendingPickups.filter((p) => p.status === 'pending');
                              const pickupTR = parseInt(delivery.tracking_number, 10);
                              const baseTR = isNaN(pickupTR) ? 0 : pickupTR;

                              const now = new Date();
                              const currentMinutes = now.getHours() * 60 + now.getMinutes();
                              const startMinutes = currentMinutes + 5;
                              const deliveryTimeStart = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
                              const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                              // Update all pending deliveries to in_transit
                              for (const pendingDelivery of allPendingDeliveries) {
                                await updateDeliveryLocal(pendingDelivery.id, {
                                  status: 'in_transit',
                                  delivery_time_start: deliveryTimeStart
                                }, { skipSmartRefresh: true });
                              }

                              // Run route optimizer
                              try {
                                await base44.functions.invoke('optimizeRouteRealTime', {
                                  driverId: delivery.driver_id,
                                  deliveryDate: delivery.delivery_date,
                                  currentLocalTime: currentLocalTime,
                                  generatePolyline: false
                                });
                              } catch (optimizeError) {
                                console.warn('⚠️ Route optimizer failed:', optimizeError);
                              }

                              // Assign sequential TR#s
                              const sortedPending = [...allPendingDeliveries].sort((a, b) =>
                              (a.patient_name || '').localeCompare(b.patient_name || '')
                              );

                              for (let i = 0; i < sortedPending.length; i++) {
                                const newTR = String(baseTR + i + 1);
                                await updateDeliveryLocal(sortedPending[i].id, {
                                  tracking_number: newTR
                                }, { skipSmartRefresh: true });
                              }

                              // Refresh data
                              await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                              console.log('✅ [Complete Pickup] Accept All completed - now completing pickup...');
                            }
                          }

                          // Now complete the pickup/delivery
                          await onStatusUpdate(delivery.id, 'completed');

                          // Next delivery flag handled by route optimizer

                          // Send notification to dispatchers (don't await - fire and forget)
                          if (userHasRole(currentUser, 'driver')) {
                            notifyDriverCompleted({
                              driver: currentUser,
                              patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                              delivery,
                              store,
                              appUsers
                            }).catch((err) => console.warn('Notification failed:', err));
                          }

                          // Trigger AI route re-optimization after completing a delivery
                          const today = format(new Date(), 'yyyy-MM-dd');
                          triggerRouteOptimization({
                            driverId: currentUser.id,
                            deliveryDate: today,
                            trigger: 'delivery_complete',
                            completedDeliveryId: delivery.id,
                            onNotification: (notification) => {
                              if (notification.type === 'next_stop') {
                                toast.success(notification.message, {
                                  description: notification.aiSuggestion
                                });
                              }
                            }
                          }).catch((err) => console.warn('Route optimization failed:', err));

                        } catch (error) {
                        } finally {
                          setIsCompleting(false);
                          setIsEntityUpdating(false);
                          await new Promise((resolve) => setTimeout(resolve, 100));
                          fabControlEvents.reactivateFAB(true);
                        }
                      }}
                      size="sm"
                      disabled={isCompleting}
                      className="rounded-md bg-emerald-600 px-3 text-xs font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-emerald-700 h-8 border-r border-emerald-500 !text-white">
                              {isCompleting ? <Loader2 className="w-3 h-3 mr-1 !text-white animate-spin" /> : <CheckCircle className="w-3 h-3 mr-1 !text-white" />}
                              <span className="text-white">Complete</span>
                            </Button> :
                    onStartDelivery &&
                    <Button onClick={async (e) => {
                      e.stopPropagation();

                      // CRITICAL: Deactivate FAB before action
                      fabControlEvents.deactivateFAB();

                      setIsStarting(true);

                      // Step 1: Run smart refresh
                      console.log('🟢 [START] Step 1: Running smart refresh...');
                      smartRefreshManager.lastRefreshTimes = {
                        driverLocation: 0,
                        activeDeliveries: 0,
                        todayDeliveries: 0,
                        appUsers: 0,
                        patients: 0,
                        stores: 0
                      };
                      await new Promise((resolve) => setTimeout(resolve, 200));

                      // Step 2: Pause smart refresh
                      console.log('🟢 [START] Step 2: Pausing smart refresh...');
                      setIsEntityUpdating(true);
                      await new Promise((resolve) => setTimeout(resolve, 100));

                      try {
                        // Step 1 already done above

                        // Step 3: Clear all isNextDelivery and set selected stop to true
                        // CRITICAL: Use skipSmartRefresh for all batch updates
                        console.log('🟢 [START] Step 3: Setting isNextDelivery...');
                        const driverDeliveries = allDeliveries.filter((d) =>
                        d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                        );

                        for (const d of driverDeliveries) {
                          if (d.id !== delivery.id && d.isNextDelivery) {
                            await updateDeliveryLocal(d.id, { isNextDelivery: false }, { skipSmartRefresh: true });
                          }
                        }
                        await updateDeliveryLocal(delivery.id, { isNextDelivery: true }, { skipSmartRefresh: true });
                        console.log('  ✅ isNextDelivery flags updated');

                        // Step 4: Set stop order to total finished stops + 1
                        console.log('🟢 [START] Step 4: Setting stop order...');
                        const finishedStops = driverDeliveries.filter((d) =>
                        FINISHED_STATUSES.includes(d.status)
                        ).length;
                        const newStopOrder = finishedStops + 1;
                        await updateDeliveryLocal(delivery.id, { stop_order: newStopOrder }, { skipSmartRefresh: true });
                        console.log(`  ✅ Stop order set to ${newStopOrder}`);

                        // Step 5: Set delivery_time_start to current time BEFORE running optimizer
                        console.log('🟢 [START] Step 5a: Setting delivery_time_start to current time...');
                        const now = new Date();
                        const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                        await updateDeliveryLocal(delivery.id, {
                          delivery_time_start: currentLocalTime
                        }, { skipSmartRefresh: true });
                        console.log(`  ✅ delivery_time_start set to ${currentLocalTime}`);

                        // Step 5b: Run Route Optimizer (with current local time and this stop's location)
                        console.log('🟢 [START] Step 5b: Running route optimizer...');
                        try {
                          // Use this stop's location as starting point
                          let startLat, startLng;
                          if (delivery.puid) {
                            // Pickup - use store location
                            const store = stores.find((s) => s.id === delivery.store_id);
                            startLat = store?.latitude;
                            startLng = store?.longitude;
                          } else {
                            // Delivery - use patient location
                            const patient = patients.find((p) => p.id === delivery.patient_id);
                            startLat = patient?.latitude;
                            startLng = patient?.longitude;
                          }

                          console.log('🔄 [Start Button] Running optimizeRouteRealTime...');
                          const optimizeResponse = await base44.functions.invoke('optimizeRouteRealTime', {
                            driverId: delivery.driver_id,
                            deliveryDate: delivery.delivery_date,
                            currentLocalTime: currentLocalTime,
                            startLocation: startLat && startLng ? { lat: startLat, lng: startLng } : null,
                            generatePolyline: false
                          });
                          console.log('✅ [Start Button] Route optimized');

                          // CRITICAL: Refresh UI to show reordered stops
                          invalidate('Delivery');
                          await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                          console.log('✅ [Start Button] UI refreshed with new stop order');

                          // Step 6: Apply optimized stop orders to local state immediately
                          // CRITICAL: Use skipSmartRefresh for all batch updates
                          console.log('🟢 [START] Step 6: Resorting optimized stops...');
                          const responseData = optimizeResponse?.data || optimizeResponse;
                          if (responseData?.durationUpdates) {
                            // Update backend with new stop orders
                            for (const update of responseData.durationUpdates) {
                              await updateDeliveryLocal(update.deliveryId, {
                                stop_order: update.newOrder
                              }, { skipSmartRefresh: true });
                            }
                            console.log('  ✅ Stop orders updated from optimizer');
                          }
                        } catch (optimizeError) {
                          console.warn('⚠️ Route optimizer failed, continuing without optimization:', optimizeError);
                        }

                        // Step 8-9: Invalidate and refresh UI to sync everything
                        console.log('🟢 [START] Step 8-9: Refreshing data...');
                        invalidate('Delivery');
                        await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                        console.log('  ✅ UI and DBs synced');

                        await ensureDriverOnline();

                        // Send notification
                        if (userHasRole(currentUser, 'driver')) {
                          await notifyDriverStarted({
                            driver: currentUser,
                            patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                            delivery,
                            store,
                            appUsers
                          });
                        }

                        console.log('✅ [START] Complete');
                      } catch (error) {
                        console.error('❌ [START] Error:', error);
                        alert('Failed to start delivery. Please try again.');
                      } finally {
                        // Step 10: Reset and resume smart refresh
                        console.log('🟢 [START] Step 10: Resetting smart refresh...');
                        smartRefreshManager.lastRefreshTimes = {
                          driverLocation: 0,
                          activeDeliveries: 0,
                          todayDeliveries: 0,
                          appUsers: 0,
                          patients: 0,
                          stores: 0
                        };
                        setIsEntityUpdating(false);
                        setIsStarting(false);
                        fabControlEvents.reactivateFAB();
                        console.log('  ✅ Smart refresh resumed');
                      }
                    }} size="sm" disabled={isStarting} className="bg-blue-600 px-3 text-xs font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-8 border-r border-blue-500 !text-white">
                              {isStarting ? <Loader2 className="w-3 h-3 mr-1 !text-white animate-spin" /> : <Clock className="w-3 h-3 mr-1 !text-white" />}
                              <span className="text-white">Start</span>
                            </Button>)
                    }

                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                          variant="ghost"
                          size="icon" className="bg-transparent text-sm font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 hover:text-accent-foreground h-8 w-8 border border-slate-300 hover:bg-slate-100 relative z-[10]"

                          onClick={(e) => e.stopPropagation()}>
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="p-1 rounded-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 min-w-[8rem] overflow-hidden border-2 shadow-md z-[200]" sideOffset={5} onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-white)', borderColor: 'var(--menu-border)', color: 'var(--text-slate-900)' }}>
                          {onEditDelivery && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                        <DropdownMenuItem onClick={(e) => {e.stopPropagation();onEditDelivery(delivery);}}>
                              <Edit className="w-4 h-4 mr-2" />
                              {isPickup ? 'Edit Pickup' : 'Edit Delivery'}
                            </DropdownMenuItem>
                        }

                          {!isPickup && patient && onEditPatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                        <DropdownMenuItem onClick={(e) => {e.stopPropagation();onEditPatient(patient);}}>
                              <User className="w-4 h-4 mr-2" />
                              Edit Patient
                            </DropdownMenuItem>
                        }

                          {isCompleted && onRestart && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && delivery.delivery_date === format(new Date(), 'yyyy-MM-dd') && !isRouteCompleted &&
                        <>
                              <DropdownMenuSeparator className="bg-slate-200" />
                              <DropdownMenuItem onClick={async (e) => {
                            e.stopPropagation();

                            // CRITICAL: Deactivate FAB before restart
                            fabControlEvents.deactivateFAB();
                            setIsEntityUpdating(true);
                            await new Promise((resolve) => setTimeout(resolve, 100));

                            try {
                              console.log('🔄 [RESTART] Restarting delivery:', delivery.id);

                              // Step 1: Clear all isNextDelivery flags for this driver/date
                              const driverDeliveries = allDeliveries.filter((d) =>
                              d && d.driver_id === delivery.driver_id && d.delivery_date === delivery.delivery_date
                              );

                              for (const d of driverDeliveries) {
                                if (d.isNextDelivery) {
                                  await updateDeliveryLocal(d.id, { isNextDelivery: false }, { skipSmartRefresh: true });
                                }
                              }

                              // Step 2: Set restarted delivery to in_transit/en_route and isNextDelivery: true
                              const newStatus = isPickup ? 'en_route' : 'in_transit';
                              await updateDeliveryLocal(delivery.id, {
                                status: newStatus,
                                isNextDelivery: true
                              }, { skipSmartRefresh: true });

                              // Step 3: Run recursive route optimization
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

                                // CRITICAL: Refresh UI to show reordered stops
                                invalidate('Delivery');
                                await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);
                                console.log('✅ [Restart Delivery] UI refreshed with new stop order');
                              } catch (optimizeError) {
                                console.warn('⚠️ [Restart Delivery] Route optimizer failed:', optimizeError);
                              }

                              // Step 4: Refresh data and sync UI
                              invalidate('Delivery');
                              await forceRefreshDriverDeliveries(delivery.driver_id, delivery.delivery_date);

                              console.log('✅ [RESTART] Delivery restarted successfully');
                            } finally {
                              setIsEntityUpdating(false);
                              await new Promise((resolve) => setTimeout(resolve, 100));

                              // CRITICAL: Reactivate FAB after restart (skip card scroll - FAB handles it)
                              fabControlEvents.reactivateFAB(true);
                            }
                          }}>
                                <RotateCcw className="w-4 h-4 mr-2" />
                                Restart Delivery
                              </DropdownMenuItem>
                            </>
                        }

                          {onDeleteDelivery && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (onEditDelivery || !isPickup && patient && onEditPatient || isCompleted && onRestart && delivery.delivery_date === format(new Date(), 'yyyy-MM-dd')) && <DropdownMenuSeparator style={{ background: 'var(--border-slate-200)' }} />}

                          {onDeleteDelivery && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                        <DropdownMenuItem
                          onClick={(e) => {e.stopPropagation();setShowDeleteConfirm(true);}}
                          className="text-red-600"
                          disabled={!userHasRole(currentUser, 'admin') && isRouteCompleted}>
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                        }
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </>
                }
              </div>


            </div>
          </div>}
        </CardContent>
      </Card>
    </motion.div>);

}