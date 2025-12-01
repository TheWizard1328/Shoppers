import React, { useState, useRef, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
import { Phone, MapPin, Edit, Trash2, StickyNote, RotateCcw, MoreVertical, User, CheckCircle, Clock, Package, XCircle, Info, FileText, Save, X, Plus, Undo2, Loader2, Navigation } from "lucide-react";
import { getStoreColor, hexToRgba, getContrastColor } from "../utils/colorGenerator";
import { format, isBefore, startOfDay, addDays } from "date-fns";
import { getDriverDisplayName } from '../utils/driverUtils';
import { userHasRole, shouldShowStoreBadges, isAppOwner } from '../utils/userRoles';
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { formatAddressWithUnit, cleanBuzzerFromAddress } from '../utils/addressCleaner';
import { base44 } from "@/api/base44Client";
import { locationTracker } from "../utils/locationTracker";
import {
  notifyDriverAcceptedAll,
  notifyDriverAcceptedOne,
  notifyDispatcherAssignedAll,
  notifyDriverStarted,
  notifyDriverCompleted,
  notifyDriverFailed,
  notifyDriverRetry,
  notifyDriverReturn
} from "../utils/deliveryMessaging";

// Global statusConfig
const statusConfig = {
  'pending': { label: 'Pending', color: 'bg-slate-100 text-slate-800' },
  'Ready For Pickup': { label: 'Ready', color: 'bg-amber-100 text-amber-800' },
  'in_transit': { label: 'In Transit', color: 'bg-blue-100 text-blue-800' },
  'en_route': { label: 'En Route', color: 'bg-cyan-100 text-cyan-800' },
  'next': { label: 'Next', color: 'bg-lime-100 text-lime-800' },
  'completed': { label: 'Done', color: 'bg-emerald-100 text-emerald-800' },
  'delivered': { label: 'Done', color: 'bg-emerald-100 text-emerald-800' },
  'failed': { label: 'Failed', color: 'bg-red-100 text-red-800' },
  'cancelled': { label: 'Cancelled', color: 'bg-red-100 text-red-800' },
  'returned': { label: 'Returned', color: 'bg-orange-100 text-orange-800' }
};

// MOVED OUTSIDE COMPONENT: Define finished statuses as a constant
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned', 'picked_up'];

// Helper function to format time to 12-hour format with AM/PM
const formatTime12Hour = (timeString) => {
  if (!timeString) return '';

  try {
    // Handle cases where timeString might include seconds or be an invalid format
    const timeParts = timeString.split(':');
    if (timeParts.length < 2) return timeString; // Not a valid HH:mm or HH:mm:ss

    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);

    if (isNaN(hours) || isNaN(minutes)) {
      return timeString; // Return original if parsing fails
    }

    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12; // Convert 0 to 12 for midnight
    return `${displayHours}:${String(minutes).padStart(2, '0')} ${period}`;
  } catch (error) {
    console.error("Error formatting time:", error, "Input:", timeString);
    return timeString; // Return original if parsing fails
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
  isNextDelivery = false,
  onStartDelivery,
  allStopsPending = false,
  onDriverStatusChange,
  appUsers = []
}) {
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
  const codAmountInputRefs = useRef([]);

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

  // Check if this is a first delivery based on notes, instructions, or delivery count
  const isFirstDelivery = useMemo(() => {
    if (!delivery || isPickup) return false;

    // Check if already marked as first_delivery
    if (delivery.first_delivery) return true;

    // Check patient notes for "First Delivery"
    if (patient?.notes?.toLowerCase().includes('first delivery')) return true;

    // Check delivery instructions for "First Delivery"
    if (delivery.delivery_instructions?.toLowerCase().includes('first delivery')) return true;

    // Check driver notes for "First Delivery"
    if (delivery.delivery_notes?.toLowerCase().includes('first delivery')) return true;

    // Check total delivery count for this patient
    if (!patient?.id || !allDeliveries || allDeliveries.length === 0) return false;

    const patientDeliveryCount = allDeliveries.filter((d) =>
    d && d.patient_id === patient.id && FINISHED_STATUSES.includes(d.status)
    ).length;

    // If no completed deliveries, it's a first delivery
    return patientDeliveryCount === 0;
  }, [delivery, patient, isPickup, allDeliveries]);

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

  const shouldRedact = useMemo(() => {
    if (!delivery || !currentUser) return false;
    return isCompleted && !isPickup &&
    !userHasRole(currentUser, 'admin') &&
    !userHasRole(currentUser, 'dispatcher') &&
    userHasRole(currentUser, 'driver');
  }, [isCompleted, isPickup, currentUser, delivery]);

  const shouldShowStoreBadge = useMemo(() => shouldShowStoreBadges(currentUser), [currentUser]);

  const finalDisplayName = useMemo(() => {
    if (isStrippedDelivery) {
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

  const { hasFutureRetry, hasFutureReturn } = useMemo(() => {
    if (delivery.status !== 'failed' || isPickup || !patient) {
      return { hasFutureRetry: false, hasFutureReturn: false };
    }

    const fromDate = startOfDay(new Date(delivery.delivery_date));
    const toDate = addDays(fromDate, 4); // delivery day + 3 more days

    const failedPatientName = patient.full_name;

    let futureRetryExists = false;
    let futureReturnExists = false;

    for (const d of allDeliveries) {
      if (!d || d.id === delivery.id) continue;

      let dDate;
      try {
        dDate = startOfDay(new Date(d.delivery_date));
      } catch (e) {
        continue;
      }

      if (dDate >= fromDate && dDate < toDate) {
        // Check for a retry of the same delivery
        if (d.patient_id === delivery.patient_id && d.stop_id === delivery.stop_id && d.status !== 'failed') {
          futureRetryExists = true;
        }

        // Check for a return delivery
        const notesMatch = (d.delivery_notes || '').toLowerCase().includes(failedPatientName.toLowerCase());
        const sidMatch = d.stop_id === delivery.stop_id;
        if ((notesMatch || sidMatch) && !d.patient_id) {
          futureReturnExists = true;
        }
      }

      if (futureRetryExists && futureReturnExists) break;
    }

    return { hasFutureRetry: futureRetryExists, hasFutureReturn: futureReturnExists };
  }, [delivery, allDeliveries, patient, isPickup]);

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

  const isRouteCompleted = useMemo(() => {
    if (!delivery || !allDeliveries || !Array.isArray(allDeliveries)) return false;

    const driverDeliveriesForDate = allDeliveries.filter((d) => {
      if (!d) return false;
      return d.delivery_date === delivery.delivery_date && d.driver_id === delivery.driver_id;
    });

    if (driverDeliveriesForDate.length === 0) return false;

    return driverDeliveriesForDate.every((d) => FINISHED_STATUSES.includes(d.status));
  }, [delivery, allDeliveries]);

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
  const acceptButtonText = useMemo(() => {
    if (!currentUser) return 'Assign All';
    if (userHasRole(currentUser, 'driver') && delivery?.driver_id === currentUser.id && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher')) {
      return 'Accept All';
    }
    return 'Assign All';
  }, [currentUser, delivery?.driver_id]);

  const nextAvailableStatuses = useMemo(() => {
    if (!onStatusUpdate || !currentUser) return [];

    // Only assigned driver or app owner can change status
    if (!isAssignedDriverOrAppOwner) return [];

    const canChangeStatus = userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver');
    if (!canChangeStatus) return [];

    // No status changes for completed/cancelled/returned
    if (['completed', 'cancelled', 'returned'].includes(delivery.status)) {
      return [];
    }

    let statuses = [];
    if (isPickup) {
      // Pickup statuses: Pending, Ready For Pickup, En Route
      statuses = ['pending', 'Ready For Pickup', 'en_route', 'completed', 'failed'];
    } else {
      // Delivery statuses: Pending, Ready For Pickup, In Transit
      statuses = ['pending', 'Ready For Pickup', 'in_transit', 'completed', 'failed'];
    }
    return statuses.filter((s) => s !== delivery.status);
  }, [delivery?.status, onStatusUpdate, currentUser, isPickup]);

  // CRITICAL: Hide status dropdown when entire route is completed
  const showStatusDropdown = useMemo(() => {
    if (isRouteCompleted) return false;
    return nextAvailableStatuses.length > 0;
  }, [isRouteCompleted, nextAvailableStatuses]);

  // NOW safe to return null AFTER all hooks
  if (!delivery) {
    console.warn('[StopCard] Received undefined delivery, rendering null.');
    return null;
  }

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

  const handleAddCODPayment = () => {
    const remainingAmount = codTotalRequired - codTotalCollected;
    const newPayment = { type: 'Cash', amount: Math.max(0, remainingAmount) };
    setCodPayments([...codPayments, newPayment]);

    // Focus and select the new input after render
    setTimeout(() => {
      const lastIndex = codPayments.length;
      if (codAmountInputRefs.current[lastIndex]) {
        codAmountInputRefs.current[lastIndex].focus();
        codAmountInputRefs.current[lastIndex].select();
      }
    }, 50);
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

  return (
    <motion.div
      id={`stop-card-${delivery.id}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className={`min-w-[325px] max-w-[325px] cursor-pointer transition-all self-end ${isSelected && !isStrippedDelivery ? 'ring-2 ring-blue-500' : ''}`}
      style={{ scrollSnapAlign: 'center' }}>
      <Card
        className={`${isNextDelivery && !isCompleted ? 'border-2 border-emerald-500 ring-2 ring-emerald-300' : isPickup ? 'border-emerald-500' : 'border-blue-500'} ${isSelected && !isStrippedDelivery ? 'ring-2 ring-blue-400 shadow-xl' : 'shadow-md'} ${isProjected ? 'border-2 border-dashed border-purple-400 bg-purple-50/30' : ''} ${isStrippedDelivery ? 'opacity-80' : ''} cursor-pointer hover:shadow-lg transition-all duration-200`}
        onClick={() => {
          // Don't trigger click/expand for stripped deliveries
          if (!isStrippedDelivery) {
            onClick && onClick(delivery);
          }
        }}>
        <CardContent className="mx-1 px-3 py-2 flex flex-col">
          {/* HEADER SECTION - Always Visible */}
          <div className="flex items-start gap-2">
            <div className="flex flex-col gap-2 items-start items-center">
              <Badge
                variant="secondary"
                className={`font-bold text-xs px-2 py-0.5 text-white w-[40px] justify-center ${delivery.ampm_deliveries === 'AM' ? 'rounded-full' : 'rounded-xs'}`}
                style={{
                  backgroundColor: storeColor || '#10B981',
                  color: 'white'
                }}>
                #{delivery.display_stop_order || delivery.stop_order || 0}
              </Badge>

              {isPickup && pendingPickups && pendingPickups.length > 0 &&
              <Badge
                variant="secondary"
                className="font-bold text-xs px-2 py-0.5 bg-purple-500 text-white justify-center rounded-lg">
                  P: {pendingPickups.length}
                </Badge>
              }

              <Badge
                variant="secondary"
                className={`inline-flex items-center gap-0.5 border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80 font-bold text-xs px-1.5 py-0.5 bg-slate-300 text-white min-w-[25px] justify-center rounded-full ${
                !(hasCODRequired || isFirstDelivery || delivery.oversized || delivery.fridge_item || delivery.signature_needed) ? 'invisible' : ''}`
                }>
                {hasCODRequired &&
                <span className="relative inline-flex items-center justify-center">
                    $
                    {delivery.status === 'failed' &&
                  <svg
                    className="absolute"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth="2.5"
                    style={{
                      pointerEvents: 'none',
                      width: '260%',
                      height: '260%',
                      left: '50%',
                      top: '50%',
                      transform: 'translate(-50%, -50%)'
                    }}>
                        <circle cx="12" cy="12" r="10" />
                        <line x1="4" y1="4" x2="20" y2="20" />
                      </svg>
                  }
                  </span>
                }
                {isFirstDelivery && (hasCODRequired ? ' N' : 'N')}
                {delivery.oversized && (hasCODRequired || isFirstDelivery ? ' O' : 'O')}
                {delivery.fridge_item && (hasCODRequired || isFirstDelivery ? ' F' : 'F')}
                {delivery.signature_needed && (hasCODRequired || isFirstDelivery || delivery.fridge_item ? ' S' : 'S')}
              </Badge>
            </div>

            <div className="flex-1 min-w-0">
              <h3 className="text-slate-900 pt-1 text-lg font-semibold text-center truncate">
                {finalDisplayName}
              </h3>
              <div className="flex flex-col items-center">
                <div className="text-slate-600 text-xs flex items-center justify-center">
                  {FINISHED_STATUSES.includes(delivery.status) && delivery.actual_delivery_time ?
                  <>
                      <Clock className="w-3 h-3" />
                      <span className="font-medium">{formatTime12Hour(format(new Date(delivery.actual_delivery_time), 'HH:mm'))}</span>
                    </> :

                  <span className="font-medium">ETA: {formatTime12Hour(delivery.delivery_time_eta || delivery.delivery_time_start || delivery.time_window_start || '--:--')}</span>
                  }
                  {showDriverName && safeDriver &&
                  <>
                      <span className="bg-secondary text-secondary-foreground px-2 py-0.5 text-xs font-semibold opacity-60 rounded-full inline-flex items-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80">•</span>
                      <Badge
                      variant="secondary"
                      className="px-2 py-0.5 rounded-full text-xs font-semibold"
                      style={{ backgroundColor: driverBadgeColor, color: driverBadgeTextColor }}>
                        {getDriverDisplayName(safeDriver)}
                      </Badge>
                    </>
                  }
                </div>
                <div className="text-[10px] text-slate-500 min-h-[14px]">
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

            <div className="flex flex-col gap-2 items-end items-center">
              <div className="flex items-center gap-1">
                {showStatusDropdown ?
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                      className={`font-medium inline-flex items-center gap-1 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-xs font-bold px-2 py-0.5 cursor-pointer hover:opacity-80 ${statusConfig[delivery.status]?.color || 'bg-slate-100 text-slate-800'}`}
                      onClick={(e) => e.stopPropagation()}>

                        {statusConfig[delivery.status]?.label || delivery.status}
                        <MoreVertical className="w-3 h-3" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="z-[99999]">
                      <DropdownMenuLabel>Change Status</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {nextAvailableStatuses.map((status) =>
                    <DropdownMenuItem
                      key={status}
                      onClick={async (e) => {
                        e.stopPropagation();
                        // Pass skipAutoCenter=false for finished statuses so ETAs get recalculated
                        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
                        const skipAutoCenter = !finishedStatuses.includes(status);
                        await onStatusUpdate(delivery.id, status, {}, skipAutoCenter);
                        
                        // Send notification for failed status
                        if (status === 'failed' && userHasRole(currentUser, 'driver')) {
                          await notifyDriverFailed({
                            driver: currentUser,
                            patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                            delivery,
                            store,
                            appUsers
                          });
                        }
                        // Send notification for completed status
                        if (status === 'completed' && userHasRole(currentUser, 'driver')) {
                          await notifyDriverCompleted({
                            driver: currentUser,
                            patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                            delivery,
                            store,
                            appUsers
                          });
                        }
                      }}
                      className="capitalize">

                              {statusConfig[status]?.label || status}
                          </DropdownMenuItem>
                    )}
                    </DropdownMenuContent>
                  </DropdownMenu> :

                <Badge
                  variant="secondary"
                  className={`font-medium inline-flex items-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 text-xs font-bold px-2 py-0.5 ${statusConfig[delivery.status]?.color || 'bg-slate-100 text-slate-800'}`}>
                    {statusConfig[delivery.status]?.label || delivery.status}
                  </Badge>
                }
              </div>

              {delivery.tracking_number && store?.abbreviation &&
              <Badge
                variant="secondary" className="inline-flex items-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80 font-mono text-xs font-bold px-2 py-0.5"
                style={{ backgroundColor: `${storeColor}20`, color: storeColor }}>
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
          {!isStrippedDelivery && <div className="border-t border-slate-200"></div>}

          {!isStrippedDelivery && <div className="flex flex-col">
            <div className="mt-2 flex items-start justify-between">
              <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                {finalDisplayAddress ?
                <>
                    {/* Main address without unit/buzzer */}
                    <div className="flex items-start gap-2 text-sm text-slate-700">
                      <MapPin className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                      <span className="text-lg font-medium truncate">
                        {isPickup ? store?.address || '' : patient?.address || ''}
                      </span>
                    </div>
                    
                    {/* Unit/Buzzer + Phone on second row */}
                    {!isStrippedDelivery && !shouldRedact &&
                  <div className="flex items-center gap-2 text-xs text-slate-600 pl-6">
                        {/* Unit and Buzzer info */}
                        {(() => {
                      const unitNum = !isPickup ? delivery?.unit_number || patient?.unit_number : null;
                      const fullAddress = isPickup ? store?.address || '' : patient?.address || '';
                      const buzzerMatch = fullAddress.match(/buzz(?:er)?\s*(\d+)/i);
                      const buzzerNum = buzzerMatch ? buzzerMatch[1] : null;

                      if (!unitNum && !buzzerNum) return null;

                      return (
                        <>
                              {unitNum && <span className="font-medium">#{unitNum}</span>}
                              {buzzerNum && <span className="font-medium">Buzz {buzzerNum}</span>}
                            </>);

                    })()}
                        
                        {/* Phone number */}
                        {finalDisplayPhone &&
                    <span className="font-medium">Ph: {formatPhoneNumber(finalDisplayPhone)}</span>
                    }
                      </div>
                  }
                  </> :

                <div className="w-full h-[26px]" />
                }
              </div>
              
              {/* Navigation and Phone buttons - right justified - Only for assigned driver or app owner */}
              {isAssignedDriverOrAppOwner && (
              <div className="py-1 flex items-center gap-2 flex-shrink-0">
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
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center justify-center w-9 h-9 rounded-full bg-blue-100 hover:bg-blue-200 text-blue-600 transition-colors">

                    <Navigation className="w-4 h-4" />
                  </a>
                }
                {finalDisplayPhone &&
                <a
                  href={`tel:${finalDisplayPhone.replace(/\D/g, '')}`}
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center justify-center w-9 h-9 rounded-full bg-emerald-100 hover:bg-emerald-200 text-emerald-600 transition-colors">

                    <Phone className="w-4 h-4" />
                  </a>
                }
              </div>
              )}
            </div>
          </div>}

          {/* Delete Confirmation Dialog */}
          <AnimatePresence>
            {showDeleteConfirm &&
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 flex items-center justify-center z-[10000]"
              onClick={() => setShowDeleteConfirm(false)}>
                <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 text-red-600">
                    <Trash2 className="w-5 h-5" />
                    Confirm Delete
                  </h3>

                  <div className="space-y-3 mb-6">
                    <p className="text-slate-700">
                      Are you sure you want to delete this {isPickup ? 'pickup' : 'delivery'}?
                    </p>

                    <div className="bg-slate-50 rounded-lg p-3 space-y-1 text-sm">
                      <div>
                        <span className="font-semibold text-slate-700">Name:</span>
                        <p className="text-slate-900 pl-16">{displayName}</p>
                      </div>

                      {displayAddress &&
                    <div>
                          <span className="font-semibold text-slate-700">Address:</span>
                        <p className="text-slate-900 pl-16">{displayAddress}</p>
                        </div>
                    }

                      {delivery.tracking_number &&
                    <div>
                          <span className="font-semibold text-slate-700">Tr#:</span>
                        <p className="text-slate-900 pl-16">{delivery.tracking_number}</p>
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
                    onClick={() => {
                      onDeleteDelivery(delivery.id);
                      setShowDeleteConfirm(false);
                    }}>
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete
                    </Button>
                  </div>
                </motion.div>
              </motion.div>
            }
          </AnimatePresence>

          {/* Return Confirmation Dialog */}
          <AnimatePresence>
            {showReturnConfirm && returnPatient &&
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 flex items-center justify-center z-[10000]"
              onClick={handleCancelReturn}>
                <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                onClick={(e) => e.stopPropagation()}
                className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
                  <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <Undo2 className="w-5 h-5 text-orange-600" />
                    Confirm Return Delivery
                  </h3>
                  
                  <div className="space-y-3 mb-6 text-sm">
                    <p className="text-slate-600">A new return delivery will be created with the following details:</p>
                    
                    <div className="bg-slate-50 rounded-lg p-3 space-y-2">
                      <div>
                        <span className="font-semibold text-slate-700">Return To: {returnPatient.full_name}</span>
                        <p className="text-slate-900"></p>
                      </div>
                      
                      <div>
                        <span className="font-semibold text-slate-700">Address: {returnPatient.address || store?.address || 'N/A'}</span>
                        <p className="text-slate-900"></p>
                      </div>
                      
                      <div>
                        <span className="font-semibold text-slate-700">Phone: {formatPhoneNumber(returnPatient.phone || store?.phone || 'N/A')}</span>
                        <p className="text-slate-900"></p>
                      </div>
                      
                      <div>
                        <span className="font-semibold text-slate-700">Delivery Date: {delivery.delivery_date}</span>
                        <p className="text-slate-900"></p>
                      </div>
                      
                      <div>
                        <span className="font-semibold text-slate-700">Assigned Driver: {getDriverDisplayName(driver) || 'N/A'}</span>
                        <p className="text-slate-900"></p>
                      </div>
                      
                      <div>
                        <span className="font-semibold text-slate-700">Notes:</span>
                        <p className="text-slate-900 text-xs">PATIENT RETURN For: {patient?.full_name || delivery.patient_name || 'Unknown'}</p>
                      </div>
                      
                      <div>
                        <span className="font-semibold text-slate-700">Tracking Number:</span>
                        <p className="text-slate-500 italic">Will be assigned when saved</p>
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
                </motion.div>
              </motion.div>
            }
          </AnimatePresence>

          {/* BODY SECTION - Expandable */}
          <AnimatePresence>
            {isExpanded && !isStrippedDelivery &&
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                <div className="pt-3 space-y-3 border-t border-slate-200 mt-2">
                  {/* COD Information - Moved to expandable section */}
                  {hasCODRequired && !isPickup && !FINISHED_STATUSES.includes(delivery.status) &&
                <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                      <span className="text-xs font-semibold text-amber-800">COD Required: ${codTotalRequired.toFixed(2)}</span>
                      {userHasRole(currentUser, 'driver') &&
                  <Button size="sm" variant="ghost" className="h-6 text-xs text-amber-700 hover:text-amber-900" onClick={(e) => {e.stopPropagation();setShowCODCollection(!showCODCollection);}}>
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
                                <SelectTrigger className="h-7 text-xs w-24" onClick={(e) => e.stopPropagation()}>
                                  <SelectValue placeholder="Type" />
                                </SelectTrigger>
                                <SelectContent onClick={(e) => e.stopPropagation()} className="z-[99999]">
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
                            onChange={(e) => handleCODPaymentChange(index, 'amount', e.target.value)}
                            className="h-7 w-full pl-5 pr-2 text-xs border border-slate-300 rounded-md"
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

                          <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700" onClick={(e) => {e.stopPropagation();handleSaveCODPayments();}} disabled={codPayments.length === 0}>
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
                        <p className="text-xs font-semibold text-slate-700 mb-0.5">Patient Info:</p>
                        <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-2 py-1.5 space-y-1">
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
                <div className="pt-2 border-t border-slate-200">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="text-xs font-bold text-slate-700 flex items-center gap-2">
                          <Package className="w-3.5 h-3.5" />
                          Pending Pickup List ({pendingPickups.length})
                        </h4>
                        {canAccessAcceptButtons && (
                        <Button
                      size="sm"
                      variant="default"
                      className="h-6 px-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                      onClick={async (e) => {
                        e.stopPropagation();
                        console.log('🟢 [Assign All Button] Clicked!');
                        console.log('  onStatusUpdate exists:', !!onStatusUpdate);
                        console.log('  pendingPickups count:', pendingPickups?.length || 0);

                        if (!onStatusUpdate) {
                          console.error('❌ [Assign All Button] No onStatusUpdate handler!');
                          return;
                        }

                        // Get pickup's TR# as the base
                        const pickupTR = parseInt(delivery.tracking_number, 10);
                        const baseTR = isNaN(pickupTR) ? 0 : pickupTR;
                        console.log('  Pickup TR#:', delivery.tracking_number, '→ baseTR:', baseTR);

                        // Filter to ALL pending deliveries (including those with TR# already assigned)
                        const allPendingDeliveries = pendingPickups.filter((p) => p.status === 'pending');
                        console.log('  All pending deliveries:', allPendingDeliveries.length);

                        // Sort by patient name for consistent processing
                        const sortedPending = [...allPendingDeliveries].sort((a, b) =>
                          (a.patient_name || '').localeCompare(b.patient_name || '')
                        );

                        // Update ALL pending deliveries to 'in_transit' status
                        for (let i = 0; i < sortedPending.length; i++) {
                          const pendingDelivery = sortedPending[i];
                          const existingTR = pendingDelivery.tracking_number || '99';
                          console.log(`  Accepting: ${pendingDelivery.patient_name} (TR#${existingTR}) → status: in_transit`);

                          // Update status to in_transit (keep existing TR#), skip auto-center
                          await onStatusUpdate(pendingDelivery.id, 'in_transit', {}, true);
                        }

                        console.log('✅ [Assign All Button] All pending deliveries accepted');

                        // Send notification message
                        const isDriverAction = userHasRole(currentUser, 'driver') && delivery.driver_id === currentUser.id && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher');
                        if (isDriverAction) {
                          // Driver accepted all - notify dispatchers
                          await notifyDriverAcceptedAll({
                            driver: currentUser,
                            store,
                            appUsers
                          });
                        } else {
                          // Dispatcher/Admin assigned all - notify driver
                          const assignedDriver = drivers.find(d => d?.id === delivery.driver_id);
                          if (assignedDriver) {
                            await notifyDispatcherAssignedAll({
                              dispatcher: currentUser,
                              driver: assignedDriver,
                              store,
                              deliveries: sortedPendingWithoutTR,
                              patients
                            });
                          }
                        }
                      }}>

                          {acceptButtonText}
                        </Button>
                        )}
                      </div>
                      <div
                    className="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar"
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

                      const hasSpecialBadge = hasCOD || projIsFirstDelivery || hasOversized || hasFridge || hasSignature;

                      return (
                        <div
                          key={deliveryId}
                          className="flex items-center justify-between gap-2 bg-white border border-slate-200 px-2.5 py-1.5 rounded-md cursor-pointer hover:bg-slate-50 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (onEditDelivery && projectedDelivery.id) {
                              onEditDelivery(projectedDelivery);
                            }
                          }}>

                                <span className="text-xs font-medium text-slate-900 truncate flex-1">
                                  {projectedDelivery.patient_name || 'Unknown Patient'}
                                </span>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  {/* Special badge on the RIGHT, to the LEFT of TR# */}
                                  {hasSpecialBadge &&
                            <Badge className="bg-yellow-400 text-black text-[9px] px-1 py-0 h-4 font-bold">
                                      {hasCOD && '$'}
                                      {projIsFirstDelivery && (hasCOD ? ' N' : 'N')}
                                      {hasOversized && (hasCOD || projIsFirstDelivery ? ' O' : 'O')}
                                      {hasFridge && (hasCOD || projIsFirstDelivery || hasOversized ? ' F' : 'F')}
                                      {hasSignature && (hasCOD || projIsFirstDelivery || hasOversized || hasFridge ? ' S' : 'S')}
                                    </Badge>
                            }
                                  <span className="text-xs font-semibold text-slate-600">
                                    TR#{projectedDelivery.tracking_number || '??'}
                                  </span>
                                        {/* Individual accept button - only for assigned driver, dispatcher, or admin */}
                                        {canAccessAcceptButtons && (
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

                                // Update this single delivery to in_transit (don't touch isNextDelivery)
                                await onStatusUpdate(projectedDelivery.id, 'in_transit', { tracking_number: newTR }, true);

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
                                  const assignedDriver = drivers.find(d => d?.id === delivery.driver_id);
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
                                        )}
                                </div>
                              </div>);
                    })}
                      </div>
                    </div>
                }

                  <div className="space-y-1 mt-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-medium text-slate-700 flex items-center gap-1">Driver Notes</Label>
                    </div>
                    <Textarea
                    value={notesInput}
                    onChange={(e) => setNotesInput(e.target.value)}
                    onBlur={handleNotesBlur}
                    onKeyDown={handleNotesKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="Add driver notes..."
                    className="text-xs resize-none h-16 border-slate-200"
                    disabled={isCompleted && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher')} />
                  </div>
                </div>
              </motion.div>
            }
          </AnimatePresence>

          {/* FOOTER SECTION - Only visible to assigned driver or app owner */}
          {!isStrippedDelivery && isAssignedDriverOrAppOwner && <div className="space-y-3 mt-2">
            <div className="border-t border-slate-200">
              <div className="mx-auto mt-2 flex justify-between items-center">
                {(isAssignedDriverOrAppOwner || canEdit) &&
                <>
                      {/* Return button for failed deliveries - creates new return delivery */}
                      {delivery.status === 'failed' && !isPickup &&
                  <Button
                    onClick={handleReturnClick}
                    size="sm"
                    className="bg-orange-600 hover:bg-orange-700 text-white h-8"
                    disabled={isPreparingReturn || hasFutureReturn}>
                          {isPreparingReturn ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Undo2 className="w-3 h-3 mr-1" />}
                          Return
                        </Button>
                  }

                      {/* Start/Complete/Retry button and menu - right aligned */}
                      <div className="flex items-center ml-auto">
                        {delivery.status === 'failed' && onStatusUpdate ?
                    <Button
                      onClick={async (e) => {
                        e.stopPropagation();
                        setIsRetrying(true);
                        try {
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
                        }
                      }}
                      size="sm"
                      className="bg-blue-600 hover:bg-blue-700 h-8 rounded-r-none border-r border-blue-500 !text-white"
                      disabled={isRetrying || !canRetry || hasFutureRetry}>

                          {isRetrying ? <Loader2 className="w-3 h-3 mr-1 !text-white animate-spin" /> : <RotateCcw className="w-3 h-3 mr-1 !text-white" />}
                          <span className="text-white">Retry</span>
                        </Button> :
                    delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'returned' && (
                    isNextDelivery ?
                    <Button
                      onClick={async (e) => {
                        e.stopPropagation();
                        setIsCompleting(true);
                        // NOTE: We intentionally do NOT reset isCompleting to false here.
                        // The button will remain in loading state until the card is unmounted
                        // (after the delivery status changes and the card is hidden/replaced).
                        try {
                          // Auto-toggle driver online if offline
                          await ensureDriverOnline();

                          if (isPickup) {
                            // For a pickup, auto-accept all pending stops first, then complete the pickup
                            // Get pickup's TR# as the base
                            const pickupTR = parseInt(delivery.tracking_number, 10);
                            const baseTR = isNaN(pickupTR) ? 0 : pickupTR;

                            // Filter to only pending deliveries that don't already have a valid TR# assigned
                            // (i.e., they haven't been individually accepted yet)
                            const pendingWithoutTR = (pendingPickups || []).filter((p) => {
                              const tr = parseInt(p.tracking_number, 10);
                              // Consider it needing a TR# if: no TR#, TR# is 99, or TR# is 0
                              return isNaN(tr) || tr === 99 || tr === 0 || !p.tracking_number;
                            });

                            // Get the highest TR# already assigned to this pickup's deliveries
                            const existingTRs = (pendingPickups || []).
                            map((p) => parseInt(p.tracking_number, 10)).
                            filter((tr) => !isNaN(tr) && tr !== 99 && tr !== 0 && tr > baseTR);
                            const highestExistingTR = existingTRs.length > 0 ? Math.max(...existingTRs) : baseTR;

                            // Sort pending without TR by patient name for consistent TR# assignment
                            const sortedPendingWithoutTR = [...pendingWithoutTR].sort((a, b) =>
                            (a.patient_name || '').localeCompare(b.patient_name || '')
                            );

                            // Assign sequential TR#s starting after the highest existing TR#
                            for (let i = 0; i < sortedPendingWithoutTR.length; i++) {
                              const pendingDelivery = sortedPendingWithoutTR[i];
                              const newTR = String(highestExistingTR + i + 1);

                              // Update with new tracking number AND status (skip auto-center), do NOT touch isNextDelivery
                              await onStatusUpdate(pendingDelivery.id, 'in_transit', { tracking_number: newTR }, true);
                            }

                            // Now complete the pickup itself - let the backend optimizer handle next delivery selection
                            await onStatusUpdate(delivery.id, 'completed');
                          } else {
                            // For a regular delivery, just mark it as completed
                            await onStatusUpdate(delivery.id, 'completed');
                          }

                          // Send notification to dispatchers
                          if (userHasRole(currentUser, 'driver')) {
                            await notifyDriverCompleted({
                              driver: currentUser,
                              patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                              delivery,
                              store,
                              appUsers
                            });
                          }
                        } catch (error) {
                          // Only reset on error so user can retry
                          console.error('Complete button error:', error);
                          setIsCompleting(false);
                        }
                        // Success case: leave isCompleting=true until card unmounts
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
                      setIsStarting(true);
                      try {
                        await ensureDriverOnline();
                        
                        // Send notification to dispatchers BEFORE updating the delivery
                        if (userHasRole(currentUser, 'driver')) {
                          await notifyDriverStarted({
                            driver: currentUser,
                            patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
                            delivery,
                            store,
                            appUsers
                          });
                        }
                        
                        await onStartDelivery(delivery.id);
                      } finally {
                        setIsStarting(false);
                      }
                    }} size="sm" disabled={isStarting} className="bg-blue-600 px-3 text-xs font-medium rounded-r-none inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow hover:bg-blue-700 h-8 border-r border-blue-500 !text-white">
                              {isStarting ? <Loader2 className="w-3 h-3 mr-1 !text-white animate-spin" /> : <Clock className="w-3 h-3 mr-1 !text-white" />}
                              <span className="text-white">Start</span>
                            </Button>)
                    }
                        
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" className={`h-8 w-8 border border-slate-300 hover:bg-slate-100 ${delivery.status !== 'completed' && delivery.status !== 'cancelled' && delivery.status !== 'returned' ? 'rounded-l-none' : 'rounded-md'}`}>
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="z-[99999]" onClick={(e) => e.stopPropagation()}>
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
                                    onRestart(delivery.id);
                                  }}>
                                    <RotateCcw className="w-4 h-4 mr-2" />
                                    Restart Delivery
                                  </DropdownMenuItem>
                                </>
                        }

                              {onDeleteDelivery && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (onEditDelivery || !isPickup && patient && onEditPatient || isCompleted && onRestart && delivery.delivery_date === format(new Date(), 'yyyy-MM-dd')) && <DropdownMenuSeparator className="bg-slate-200" />}

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