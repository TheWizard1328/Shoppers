import DeliveryFormView from './DeliveryFormView';
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { X, Save, Package, Search, Clock, Plus, Trash2, CheckCircle, Edit2, Camera, Phone, Bell, BellOff, Mailbox, StickyNote, Copy, MapPin, AlertCircle } from "lucide-react";
import { formatPhoneNumber } from '../utils/phoneFormatter';
import PatientMatchPopup from './PatientMatchPopup';
import { sortUsers } from "../utils/sorting";
import { Badge } from "@/components/ui/badge";
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { generateStopId, formatId } from '../utils/idGenerator';
import { getDriverDisplayName, getDriverNameForStorage } from '../utils/driverUtils';
import { PhoneInput } from "@/components/ui/phone-input";
import { determineDeliveryAMPM, getStoreAssignedTimeSlot, getPickupStopIdForDelivery, calculateInitialDeliveryTimeStart } from '../utils/ampmUtils';
import { base44 } from "@/api/base44Client";
import { getStoreColor, hexToRgba } from '../utils/colorGenerator';
import { useAppData } from '../utils/AppDataContext';
import { getUserAgentInfo } from '../utils/deviceUtils';
import { shouldShowStoreBadges, isAppOwner } from '../utils/userRoles';
import { sendDeliveryMessage } from '../utils/deliveryMessaging';
import { reorderStops } from '../utils/stopReorderer';
import {
  createPatient as createPatientLocal,
  updatePatient as updatePatientLocal,
  createDelivery as createDeliveryLocal,
  updateDelivery as updateDeliveryLocal,
  deleteDelivery as deleteDeliveryLocal,
  batchCreateDeliveries as batchCreateDeliveriesLocal,
  setBatchFormSaving
} from '../utils/entityMutations';
import DeliveryFormStaged from './DeliveryFormStaged';
import BarcodeScanner from './BarcodeScanner';
import { checkPayrollLock } from '../utils/payrollLockManager';

const CheckboxField = ({ id, label, checked, onChange, disabled }) => (
  <div className="flex items-center space-x-2">
    <Checkbox id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    <Label htmlFor={id} className={`text-sm font-medium leading-none ${disabled ? 'text-slate-400' : ''}`}>
      {label}
    </Label>
  </div>
);


const statusColorMap = {
  'Staged': 'text-purple-700 bg-purple-100 border-purple-200',
  'pending': 'text-slate-500 bg-slate-100 border-slate-200',
  'Ready For Pickup': 'text-amber-700 bg-amber-100 border-amber-200',
  'in_transit': 'text-blue-700 bg-blue-100 border-blue-100',
  'completed': 'text-emerald-700 bg-emerald-100 border-emerald-200',
  'failed': 'text-red-700 bg-red-100 border-red-200',
  'cancelled': 'text-red-700 bg-red-100 border-red-200',
  'en_route': 'text-blue-700 bg-blue-100 border-blue-100',
  'returned': 'text-red-700 bg-red-100 border-red-200'
};

const getStatusColorClass = (status) => statusColorMap[status] || 'text-slate-700 bg-slate-100 border-slate-200';

const userHasRole = (user, role) => {
  if (!user || !role) return false;
  if (Array.isArray(user.app_roles)) return user.app_roles.includes(role);
  if (user.app_role === role) return true;
  return false;
};

const sortStores = (stores) => {
  if (!stores) return [];
  return [...stores].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
};

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
  Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export default function DeliveryForm({
  delivery,
  patients,
  stores,
  drivers,
  onSave,
  onCancel,
  initialPatientId,
  suggestedDate,
  currentUser,
  allDeliveries,
  initialDriverId,
  defaultToPickupMode = false,
  closeOnSave = false,
  onCreatePatient
}) {
  const { setIsFormOverlayOpen } = useAppData();
  
  // CRITICAL: Load fresh stores from offline DB on mount to prevent "Store information missing" error
  const [freshStores, setFreshStores] = useState(stores);
  
  useEffect(() => {
    const loadFreshStores = async () => {
      try {
        const { offlineDB } = await import('../utils/offlineDatabase');
        const offlineStores = await offlineDB.getAll(offlineDB.STORES.STORES);
        
        if (offlineStores && offlineStores.length > 0) {
          console.log('✅ [DeliveryForm] Loaded fresh stores from offline DB:', offlineStores.length);
          setFreshStores(offlineStores);
        } else {
          console.log('📦 [DeliveryForm] Using stores from props:', stores?.length || 0);
          setFreshStores(stores);
        }
      } catch (error) {
        console.warn('⚠️ [DeliveryForm] Failed to load stores from offline DB:', error);
        setFreshStores(stores);
      }
    };
    
    loadFreshStores();
  }, []);

  const allDrivers = useMemo(() => {
    // Layout already filters drivers correctly via getActiveDriversForCity
    // Just ensure they have user_name - no additional role filtering needed
    const sorted = sortUsers(drivers || []);
    return sorted.filter((driver) => driver && driver.user_name);
  }, [drivers]);

  const [formData, setFormData] = useState(() => {
    const initialState = {
      patient_id: "",
      delivery_date: suggestedDate || format(new Date(), 'yyyy-MM-dd'),
      delivery_time_start: "", delivery_time_end: "", delivery_time_eta: "",
      time_window_start: "", time_window_end: "", status: "Staged",
      driver_name: "", driver_id: "", prescription_number: "",
      delivery_instructions: "", delivery_notes: "",
      cod_total_amount_required: 0, cod_payments: [],
      cod_payment_type: "No Payment", cod_amount: "",
      tracking_number: "", delivery_stop_id: "", stop_id: "", puid: "",
      paid_km_override: null,
      patient_name: "", patient_phone: "", unit_number: "", store_phone: "", store_id: "",
      mailbox_ok: false, call_upon_arrival: false, ring_bell: false,
      dont_ring_bell: false, back_door: false, signature_needed: false,
      fridge_item: false, oversized: false, after_hours_pickup: false, no_charge: false, extra_time: 0,
      barcode_values: [],
      recurring: false, recurring_daily: false,
      recurring_weekly_mon: false, recurring_weekly_tue: false, recurring_weekly_wed: false,
      recurring_weekly_thu: false, recurring_weekly_fri: false, recurring_weekly_sat: false,
      recurring_weekly_sun: false, recurring_biweekly: false, recurring_weekly_x4: false,
      recurring_monthly: false, recurring_bimonthly: false
    };

    if (!delivery && currentUser && stores && drivers) {
      const isDriver = userHasRole(currentUser, 'driver');
      const isDispatcher = userHasRole(currentUser, 'dispatcher');
      const isAdmin = userHasRole(currentUser, 'admin');

      if (isDriver && !isAdmin && !isDispatcher) {
        const currentUserDriver = allDrivers.find((d) => d.id === currentUser.id);
        if (currentUserDriver) {
          initialState.driver_id = currentUser.id;
          initialState.driver_name = getDriverNameForStorage(currentUserDriver);
        }
      } else if (isDispatcher && !isDriver && !isAdmin) {
        const dispatcherStoreIds = currentUser.store_ids || [];
        if (dispatcherStoreIds.length === 1) {
          const dispatcherStore = stores.find((s) => s && s.id === dispatcherStoreIds[0]);
          if (dispatcherStore) {
            const selectedDate = new Date(initialState.delivery_date + 'T00:00:00');
            const dayOfWeek = selectedDate.getDay();
            let driverIdField = '';
            if (dayOfWeek === 6) {
              driverIdField = 'saturday_am_driver_id';
            } else if (dayOfWeek === 0) {
              driverIdField = 'sunday_am_driver_id';
            } else {
              driverIdField = 'weekday_am_driver_id';
            }
            const driverId = dispatcherStore[driverIdField];
            if (driverId) {
              const driver = drivers.find((d) => d && d.id === driverId);
              if (driver) {
                initialState.driver_id = driverId;
                initialState.driver_name = getDriverNameForStorage(driver);
              }
            }
          }
        }
      }
    }

    return initialState;
  });

  const [patientSearch, setPatientSearch] = useState("");
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [selectedPatientIds, setSelectedPatientIds] = useState(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedPickupOption, setSelectedPickupOption] = useState('');
  const [isPickupMode, setIsPickupMode] = useState(defaultToPickupMode);
  const [selectedStoreForPickup, setSelectedStoreForPickup] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [highlightedPatientIndex, setHighlightedPatientIndex] = useState(-1);
  const patientSearchInputRef = useRef(null);
  const codAmountInputRef = useRef(null);
  const addPatientButtonRef = useRef(null);
  const patientNameInputRef = useRef(null);
  const patientAddressInputRef = useRef(null);
  
  // State for creating new patient from existing patient data
  const [newPatientMode, setNewPatientMode] = useState(null); // 'duplicate' | 'new_address' | null
  const [stagedDeliveries, setStagedDeliveries] = useState([]);
  const [projectedDeliveries, setProjectedDeliveries] = useState([]);
  const [isLoadingPredictions, setIsLoadingPredictions] = useState(false);
  const [predictionTrigger, setPredictionTrigger] = useState(0);
  const [showDayPopup, setShowDayPopup] = useState(false);
  const [activeRecurringType, setActiveRecurringType] = useState(null);
  const [editingStagedId, setEditingStagedId] = useState(null);
  const [completionTime, setCompletionTime] = useState(() => {
    if (delivery?.actual_delivery_time) {
      return format(new Date(delivery.actual_delivery_time), 'HH:mm');
    }
    return format(new Date(), 'HH:mm');
  });
  const [showStagedPanel, setShowStagedPanel] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState({ show: false, staged: null, transferPickupId: null });
  const [isDeletingPending, setIsDeletingPending] = useState(false);
  const [isPatientFormOpen, setIsPatientFormOpen] = useState(false);
  const { deviceType } = getUserAgentInfo();
  const isMobileDevice = deviceType === 'Mobile';
  const hasLoadedPending = useRef(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMatches, setScanMatches] = useState([]);
  const [showMatchPopup, setShowMatchPopup] = useState(false);
  const [extractedData, setExtractedData] = useState(null);
  const [hasPendingDeletes, setHasPendingDeletes] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [isPayrollLocked, setIsPayrollLocked] = useState(false);
  const [payrollLockMessage, setPayrollLockMessage] = useState(null);
  const [isNewRouteWithZeroStops, setIsNewRouteWithZeroStops] = useState(false);
  
  // PID lookup state (for the Delivery Identifiers panel)
  const [pidInputValue, setPidInputValue] = useState('');
  const [pidLookupStatus, setPidLookupStatus] = useState(null); // null | 'found' | 'not_found'
  const originalPidRef = useRef('');
  const autoCreatedPickupsRef = useRef(new Set());

  // Camera state
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [showCameraOverlay, setShowCameraOverlay] = useState(false);


  // Responsive layout state
  const [screenWidth, setScreenWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024);
  const [screenHeight, setScreenHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 768);
  const formRef = useRef(null);

  // Desktop form width threshold (max-w-4xl = 896px + padding)
  const DESKTOP_FORM_WIDTH = 825;

  // Rule 1: Use mobile layout (hidden staged panel) only if screen width < desktop form width
  // This is PURELY screen-width based - wide mobile screens should show the staged panel
  const useMobileLayout = screenWidth < DESKTOP_FORM_WIDTH;

  // Rule 2: Use fullscreen layout ONLY if screen is too narrow AND on a mobile device
  // Wide mobile screens should get desktop-style layout with visible staged panel
  const useFullscreen = useMobileLayout && isMobileDevice;

  // Track screen dimensions
  useEffect(() => {
    const handleResize = () => {
      setScreenWidth(window.innerWidth);
      setScreenHeight(window.innerHeight);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Update all staged deliveries when date or driver changes
  useEffect(() => {
    if (delivery || stagedDeliveries.length === 0) return;

    setStagedDeliveries((prev) => prev.map((staged) => ({
      ...staged,
      delivery_date: formData.delivery_date,
      driver_id: formData.driver_id,
      driver_name: formData.driver_name
    })));
  }, [formData.delivery_date, formData.driver_id, formData.driver_name]);

  // Set default driver when form loads for new deliveries
  useEffect(() => {
    if (delivery || formData.driver_id) return; // Skip if editing or driver already set

    if (!currentUser || !stores || !drivers || allDrivers.length === 0) return;

    const isDriver = userHasRole(currentUser, 'driver');
    const isDispatcher = userHasRole(currentUser, 'dispatcher');
    const isAdmin = userHasRole(currentUser, 'admin');

    let driverIdToSet = '';
    let driverNameToSet = '';

    if (isDriver && !isAdmin && !isDispatcher) {
      const currentUserDriver = allDrivers.find((d) => d.id === currentUser.id);
      if (currentUserDriver) {
        driverIdToSet = currentUser.id;
        driverNameToSet = getDriverNameForStorage(currentUserDriver);
        console.log('🚗 [DeliveryForm] Setting driver (pure driver):', driverNameToSet);
      }
    } else if (isDispatcher && !isDriver && !isAdmin) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      if (dispatcherStoreIds.length === 1) {
        const dispatcherStore = stores.find((s) => s && s.id === dispatcherStoreIds[0]);
        if (dispatcherStore) {
          const selectedDate = new Date(formData.delivery_date + 'T00:00:00');
          const dayOfWeek = selectedDate.getDay();
          let driverIdField = '';
          if (dayOfWeek === 6) {
            driverIdField = 'saturday_am_driver_id';
            } else if (dayOfWeek === 0) {
            driverIdField = 'sunday_am_driver_id';
            } else {
            driverIdField = 'weekday_am_driver_id';
            }
          const driverId = dispatcherStore[driverIdField];
          if (driverId) {
            const driver = drivers.find((d) => d && d.id === driverId);
            if (driver) {
              driverIdToSet = driverId;
              driverNameToSet = getDriverNameForStorage(driver);
            }
          }
        }
      }
    }

    if (driverIdToSet && driverNameToSet) {
      setFormData((prev) => ({
        ...prev,
        driver_id: driverIdToSet,
        driver_name: driverNameToSet
      }));
    }
  }, [delivery, currentUser, stores, drivers, allDrivers, formData.delivery_date, formData.driver_id]);

  // Ref to track if we're loading an existing delivery (prevent patient auto-load from clearing PUID)
  const isLoadingExistingDelivery = useRef(false);
  
  // CRITICAL: Track which delivery we've loaded to prevent re-loading on prop updates
  const loadedDeliveryIdRef = useRef(null);

  // Check payroll lock status when editing a delivery
  useEffect(() => {
    if (!delivery || !delivery.delivery_date || !delivery.driver_id) return;

    const checkLock = async () => {
      const { isLocked, payrollRecord } = await checkPayrollLock(delivery.delivery_date, delivery.driver_id);
      setIsPayrollLocked(isLocked);
      
      if (isLocked && payrollRecord) {
        const periodLabel = `${new Date(payrollRecord.pay_period_start).toLocaleDateString()} - ${new Date(payrollRecord.pay_period_end).toLocaleDateString()}`;
        setPayrollLockMessage(`This delivery is locked. Payroll for ${periodLabel} has been finalized.`);
      } else {
        setPayrollLockMessage(null);
      }
    };

    checkLock();
  }, [delivery?.id, delivery?.delivery_date, delivery?.driver_id]);

  // CRITICAL: Listen for patient updates and refresh form if editing that patient
  useEffect(() => {
    if (!delivery?.patient_id) return;

    const handlePatientUpdated = async (event) => {
      const { patientId, updates } = event.detail;
      if (patientId !== delivery.patient_id) return;

      console.log('🔄 [DeliveryForm] Patient updated externally, refreshing form data:', patientId);
      
      // Only update form fields that correspond to patient data
      setFormData(prev => ({
        ...prev,
        patient_name: updates.full_name || prev.patient_name,
        patient_phone: updates.phone || prev.patient_phone,
        unit_number: updates.unit_number || prev.unit_number,
        delivery_instructions: updates.notes || prev.delivery_instructions,
        mailbox_ok: updates.mailbox_ok !== undefined ? updates.mailbox_ok : prev.mailbox_ok,
        call_upon_arrival: updates.call_upon_arrival !== undefined ? updates.call_upon_arrival : prev.call_upon_arrival,
        ring_bell: updates.ring_bell !== undefined ? updates.ring_bell : prev.ring_bell,
        dont_ring_bell: updates.dont_ring_bell !== undefined ? updates.dont_ring_bell : prev.dont_ring_bell,
        back_door: updates.back_door !== undefined ? updates.back_door : prev.back_door,
        signature_needed: updates.signature_needed !== undefined ? updates.signature_needed : prev.signature_needed,
        recurring: updates.recurring !== undefined ? updates.recurring : prev.recurring,
        recurring_daily: updates.recurring_daily !== undefined ? updates.recurring_daily : prev.recurring_daily,
        recurring_weekly_mon: updates.recurring_weekly_mon !== undefined ? updates.recurring_weekly_mon : prev.recurring_weekly_mon,
        recurring_weekly_tue: updates.recurring_weekly_tue !== undefined ? updates.recurring_weekly_tue : prev.recurring_weekly_tue,
        recurring_weekly_wed: updates.recurring_weekly_wed !== undefined ? updates.recurring_weekly_wed : prev.recurring_weekly_wed,
        recurring_weekly_thu: updates.recurring_weekly_thu !== undefined ? updates.recurring_weekly_thu : prev.recurring_weekly_thu,
        recurring_weekly_fri: updates.recurring_weekly_fri !== undefined ? updates.recurring_weekly_fri : prev.recurring_weekly_fri,
        recurring_weekly_sat: updates.recurring_weekly_sat !== undefined ? updates.recurring_weekly_sat : prev.recurring_weekly_sat,
        recurring_weekly_sun: updates.recurring_weekly_sun !== undefined ? updates.recurring_weekly_sun : prev.recurring_weekly_sun,
        recurring_biweekly: updates.recurring_biweekly !== undefined ? updates.recurring_biweekly : prev.recurring_biweekly,
        recurring_weekly_x4: updates.recurring_weekly_x4 !== undefined ? updates.recurring_weekly_x4 : prev.recurring_weekly_x4,
        recurring_monthly: updates.recurring_monthly !== undefined ? updates.recurring_monthly : prev.recurring_monthly,
        recurring_bimonthly: updates.recurring_bimonthly !== undefined ? updates.recurring_bimonthly : prev.recurring_bimonthly
      }));
    };

    window.addEventListener('patientUpdated', handlePatientUpdated);
    return () => window.removeEventListener('patientUpdated', handlePatientUpdated);
  }, [delivery?.patient_id]);

  useEffect(() => {
    // CRITICAL: Only load delivery data once when delivery.id changes
    // Prevent re-loading on prop updates (patients, allDeliveries) which would reset user changes
    if (delivery) {
      // Skip if we've already loaded this delivery
      if (loadedDeliveryIdRef.current === delivery.id) {
        return;
      }
      
      console.log('📝 [DeliveryForm] Loading delivery for edit (ONCE):', delivery.id);
      loadedDeliveryIdRef.current = delivery.id;
      
      isLoadingExistingDelivery.current = true;
      const patient = delivery.patient_id ? patients?.find((p) => p && p.id === delivery.patient_id) : null;
      
      console.log('📝 [DeliveryForm] Loading delivery for edit:', {
        id: delivery.id,
        patient_name: delivery.patient_name,
        puid: delivery.puid,
        stop_id: delivery.stop_id,
        store_id: delivery.store_id,
        ampm_deliveries: delivery.ampm_deliveries,
        isPickup: !delivery.patient_id
      });

      // CRITICAL: If delivery has PUID, find parent pickup to get correct AM/PM slot
      let finalStoreId = delivery.store_id || "";
      let finalAmpm = delivery.ampm_deliveries || null;
      
      if (delivery.patient_id && delivery.puid && allDeliveries) {
        const parentPickup = allDeliveries.find((d) => d && !d.patient_id && d.stop_id === delivery.puid);
        if (parentPickup) {
          finalStoreId = parentPickup.store_id || delivery.store_id;
          finalAmpm = parentPickup.ampm_deliveries || delivery.ampm_deliveries;
          console.log(`📦 [LoadDelivery] Found parent pickup via PUID ${delivery.puid}: store=${finalStoreId}, AM/PM=${finalAmpm}`);
        }
      }

      setFormData({
        patient_id: delivery.patient_id || "",
        delivery_date: delivery.delivery_date || format(new Date(), 'yyyy-MM-dd'),
        delivery_time_start: delivery.delivery_time_start || "",
        delivery_time_end: delivery.delivery_time_end || "",
        delivery_time_eta: delivery.delivery_time_eta || "",
        time_window_start: delivery.time_window_start || "",
        time_window_end: delivery.time_window_end || "",
        status: delivery.status || "Ready For Pickup",
        driver_name: delivery.driver_name || "",
        driver_id: delivery.driver_id || "",
        prescription_number: delivery.prescription_number || "",
        delivery_instructions: delivery.delivery_instructions || "",
        delivery_notes: delivery.delivery_notes || "",
        cod_total_amount_required: delivery.cod_total_amount_required ? delivery.cod_total_amount_required * 100 : 0,
        cod_payments: delivery.cod_payments || [],
        cod_payment_type: delivery.cod_payment_type || "No Payment",
        cod_amount: delivery.cod_amount || "",
        tracking_number: delivery.tracking_number || "",
        delivery_stop_id: delivery.delivery_stop_id || "",
        stop_id: delivery.stop_id || "",
        puid: delivery.puid || "",
        patient_name: delivery.patient_name || "",
        patient_phone: delivery.patient_phone || "",
        unit_number: delivery.unit_number || "",
        store_phone: delivery.store_phone || "",
        store_id: finalStoreId,
        ampm_deliveries: finalAmpm,
        mailbox_ok: delivery.mailbox_ok || false,
        call_upon_arrival: delivery.call_upon_arrival || false,
        ring_bell: delivery.ring_bell || false,
        dont_ring_bell: delivery.dont_ring_bell || false,
        back_door: delivery.back_door || false,
        signature_needed: delivery.signature_needed || false,
        fridge_item: delivery.fridge_item || false,
        oversized: delivery.oversized || false,
        after_hours_pickup: delivery.after_hours_pickup || false,
        no_charge: delivery.no_charge || false,
        extra_time: delivery.extra_time || 0,
        barcode_values: delivery.barcode_values || [],
        recurring: delivery.recurring || false,
        recurring_daily: delivery.recurring_daily || false,
        recurring_weekly_mon: delivery.recurring_weekly_mon || false,
        recurring_weekly_tue: delivery.recurring_weekly_tue || false,
        recurring_weekly_wed: delivery.recurring_weekly_wed || false,
        recurring_weekly_thu: delivery.recurring_weekly_thu || false,
        recurring_weekly_fri: delivery.recurring_weekly_fri || false,
        recurring_weekly_sat: delivery.recurring_weekly_sat || false,
        recurring_weekly_sun: delivery.recurring_weekly_sun || false,
        recurring_biweekly: delivery.recurring_biweekly || false,
        recurring_weekly_x4: delivery.recurring_weekly_x4 || false,
        recurring_monthly: delivery.recurring_monthly || false,
        recurring_bimonthly: delivery.recurring_bimonthly || false,
        paid_km_override: delivery.paid_km_override ?? null
      });

      setIsPickupMode(!delivery.patient_id);

      if (patient) {
        setSelectedPatient(patient);
        // Initialize PID state for the identifiers panel
        const initialPid = patient?.patient_id || '';
        setPidInputValue(initialPid);
        originalPidRef.current = initialPid;
        setPidLookupStatus(null);
      }
      
      // Reset flag after form is loaded
      setTimeout(() => {
        isLoadingExistingDelivery.current = false;
      }, 500);
    }
  }, [delivery?.id]);

  const hasFormData = useMemo(() => !!(
  formData.patient_id || formData.patient_name || formData.patient_phone ||
  formData.unit_number || formData.delivery_notes || formData.prescription_number ||
  formData.cod_total_amount_required > 0 || formData.recurring),
  [formData]);

  // CRITICAL: Done button only shows when there are staged items to process
  // hasChanges tracks whether user has actually added/edited something (not just auto-loaded pending items)
  const buttonState = useMemo(() => {
    if (delivery) return 'update';
    if (editingStagedId) return 'updateStaged';
    if ((stagedDeliveries.length > 0 || hasPendingDeletes) && !hasFormData) return 'done';
    return 'add';
  }, [delivery, editingStagedId, stagedDeliveries.length, hasFormData, hasPendingDeletes]);

  const cancelButtonState = useMemo(() => hasFormData ? 'clear' : 'cancel', [hasFormData]);

  const isCompletionStatus = useMemo(() =>
  ['completed', 'cancelled', 'failed', 'returned'].includes(formData.status),
  [formData.status]
  );

  // Disable form if payroll is locked (unless admin)
  const isFormLockedByPayroll = useMemo(() => {
    if (!delivery || !isPayrollLocked) return false;
    // Admins can still edit
    if (currentUser && userHasRole(currentUser, 'admin')) return false;
    return true;
  }, [delivery, isPayrollLocked, currentUser]);

  useEffect(() => {
    if (delivery && isCompletionStatus && !delivery.actual_delivery_time) {
      setCompletionTime(format(new Date(), 'HH:mm'));
    }
  }, [formData.status, delivery, isCompletionStatus]);

  const isPatientSelectionRequired = !isPickupMode && !delivery;
  const isFormDisabled = isPatientSelectionRequired && !selectedPatient && !editingStagedId;

  const selectedDateObj = useMemo(() => {
    if (!formData.delivery_date) return null;
    try {
      return new Date(formData.delivery_date + 'T00:00:00');
    } catch (error) {
      return null;
    }
  }, [formData.delivery_date]);

  const availableStores = useMemo(() => {
    const storesToUse = freshStores || stores;
    if (!storesToUse || !Array.isArray(storesToUse)) return [];

    let relevantStores = storesToUse;

    // CRITICAL: In patient delivery mode (non-pickup), filter to ONLY the selected patient's store
    // This ensures the dropdown shows only "Bonnie Doon" for Bonnie Doon patients, etc.
    if (!isPickupMode && !delivery) {
      // Check selectedPatient first (when patient is selected but formData not updated yet)
      // Then check formData.patient_id (after formData is updated)
      const patientToCheck = selectedPatient || (formData.patient_id && patients ? patients.find((p) => p && p.id === formData.patient_id) : null);
      
      if (patientToCheck && patientToCheck.store_id) {
        const patientStore = stores.find((s) => s && s.id === patientToCheck.store_id);
        relevantStores = patientStore ? [patientStore] : stores;
        console.log(`🏪 [AvailableStores] Patient delivery mode - filtering to patient's store only: ${patientStore?.name}`);
      } else if (userHasRole(currentUser, 'dispatcher')) {
        // If no patient selected yet, show dispatcher's stores
        const dispatcherStoreIds = currentUser.store_ids || [];
        relevantStores = stores.filter((s) => s && dispatcherStoreIds.includes(s.id));
      }
    } else if (isPickupMode) {
      // Pickup mode - show all stores for admin, dispatcher's stores for dispatcher
      if (userHasRole(currentUser, 'admin')) {
        relevantStores = stores;
      } else if (userHasRole(currentUser, 'dispatcher')) {
        const dispatcherStoreIds = currentUser.store_ids || [];
        relevantStores = stores.filter((s) => s && dispatcherStoreIds.includes(s.id));
      }
    } else if (delivery) {
      // Editing existing delivery - admins see all, others see their stores
      if (userHasRole(currentUser, 'admin')) {
        relevantStores = stores;
      } else if (formData.patient_id && patients) {
        const patient = patients.find((p) => p && p.id === formData.patient_id);
        if (patient && patient.store_id) {
          const patientStore = stores.find((s) => s && s.id === patient.store_id);
          relevantStores = patientStore ? [patientStore] : stores;
        }
      }
      if (userHasRole(currentUser, 'dispatcher')) {
        const dispatcherStoreIds = currentUser.store_ids || [];
        relevantStores = relevantStores.filter((s) => s && dispatcherStoreIds.includes(s.id));
      }
    }

    const processedStores = [];

    relevantStores.forEach((store) => {
      if (!store) return;

      const dateObj = formData.delivery_date ? new Date(formData.delivery_date + 'T00:00:00') : new Date();
      const dayOfWeek = dateObj.getDay();
      const isSaturday = dayOfWeek === 6;
      const isSunday = dayOfWeek === 0;

      let amDriverId, pmDriverId;
      if (isSaturday) {
        amDriverId = store.saturday_am_driver_id;
        pmDriverId = store.saturday_pm_driver_id;
      } else if (isSunday) {
        amDriverId = store.sunday_am_driver_id;
        pmDriverId = store.sunday_pm_driver_id;
      } else {
        amDriverId = store.weekday_am_driver_id;
        pmDriverId = store.weekday_pm_driver_id;
      }

      if (amDriverId && pmDriverId) {
        processedStores.push({
          ...store,
          id: `${store.id}_AM`,
          name: `${store.name} [AM]`,
          _originalStoreId: store.id,
          _timeSlot: 'AM'
        });
        processedStores.push({
          ...store,
          id: `${store.id}_PM`,
          name: `${store.name} [PM]`,
          _originalStoreId: store.id,
          _timeSlot: 'PM'
        });
      } else {
        processedStores.push(store);
      }
    });

    return sortStores(processedStores);
  }, [freshStores, stores, isPickupMode, formData.patient_id, formData.delivery_date, patients, currentUser, selectedPatient, delivery]);

  const filteredPatients = useMemo(() => {
    if (!patientSearch || !patients || formData.patient_id) return [];
    const searchLower = patientSearch.toLowerCase().trim();
    if (!searchLower) return [];
    let availablePatients = patients || [];

    // Get IDs of already staged patients (to mark them, not exclude them)
    const stagedPatientIds = new Set(stagedDeliveries.map((d) => d.patient_id).filter(Boolean));

    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      if (dispatcherStoreIds.length > 0) {
        availablePatients = availablePatients.filter((p) =>
        p && p.store_id && dispatcherStoreIds.includes(p.store_id)
        );
      }
    }

    // Search both active and inactive patients
    let results = availablePatients.filter((patient) => {
      if (!patient) return false;

      // Filter out Deceased and (Old
      const name = patient.full_name?.toLowerCase() || '';
      if (name.includes('deceased') || name.includes('(old')) return false;

      return patient.full_name?.toLowerCase().includes(searchLower) ||
      patient.address?.toLowerCase().includes(searchLower) ||
      patient.phone?.toLowerCase().includes(searchLower) ||
      patient.notes?.toLowerCase().includes(searchLower);
    });

    // Sort: Inactive to bottom, staged to bottom, (Temp to bottom, then by recent delivery
    results.sort((a, b) => {
      // Inactive patients always to the bottom
      const aIsInactive = a.status === 'inactive';
      const bIsInactive = b.status === 'inactive';
      if (!aIsInactive && bIsInactive) return -1;
      if (aIsInactive && !bIsInactive) return 1;

      const aIsStaged = stagedPatientIds.has(a.id);
      const bIsStaged = stagedPatientIds.has(b.id);
      
      // Staged items to the bottom
      if (aIsStaged && !bIsStaged) return 1;
      if (!aIsStaged && bIsStaged) return -1;
      
      const aIsTemp = a.full_name?.toLowerCase().includes('(temp') || false;
      const bIsTemp = b.full_name?.toLowerCase().includes('(temp') || false;

      // (Temp items always to the bottom
      if (aIsTemp && !bIsTemp) return 1;
      if (!aIsTemp && bIsTemp) return -1;

      // Sort by most recent delivery date (descending)
      const aDate = a.last_delivery_date ? new Date(a.last_delivery_date).getTime() : 0;
      const bDate = b.last_delivery_date ? new Date(b.last_delivery_date).getTime() : 0;

      return bDate - aDate;
    });

    // Mark patients that are already staged
    return results.slice(0, 50).map(patient => ({
      ...patient,
      _isAlreadyStaged: stagedPatientIds.has(patient.id)
    }));
  }, [patientSearch, patients, currentUser, formData.patient_id, stagedDeliveries]);

  const hasAnyDaySelected = useMemo(() => {
    return formData.recurring_weekly_mon || formData.recurring_weekly_tue ||
    formData.recurring_weekly_wed || formData.recurring_weekly_thu ||
    formData.recurring_weekly_fri || formData.recurring_weekly_sat ||
    formData.recurring_weekly_sun;
  }, [formData]);

  const currentFrequency = useMemo(() => {
    if (!formData.recurring) return '';
    if (formData.recurring_daily) return 'daily';
    if (formData.recurring_biweekly && hasAnyDaySelected) return 'bi-weekly';
    if (hasAnyDaySelected) return 'weekly';
    if (formData.recurring_weekly_x4) return 'weekly-x4';
    if (formData.recurring_monthly) return 'monthly';
    if (formData.recurring_bimonthly) return 'bi-monthly';
    return '';
  }, [formData, hasAnyDaySelected]);

  const weeklyLabel = useMemo(() => {
    if (currentFrequency === 'weekly' && hasAnyDaySelected) {
      const days = [];
      if (formData.recurring_weekly_mon) days.push('Mon');
      if (formData.recurring_weekly_tue) days.push('Tue');
      if (formData.recurring_weekly_wed) days.push('Wed');
      if (formData.recurring_weekly_thu) days.push('Thu');
      if (formData.recurring_weekly_fri) days.push('Fri');
      if (formData.recurring_weekly_sat) days.push('Sat');
      if (formData.recurring_weekly_sun) days.push('Sun');
      return `Weekly (${days.join(', ')})`;
    }
    return 'Weekly';
  }, [currentFrequency, hasAnyDaySelected, formData]);

  const biWeeklyLabel = useMemo(() => {
    if (currentFrequency === 'bi-weekly' && hasAnyDaySelected) {
      const days = [];
      if (formData.recurring_weekly_mon) days.push('Mon');
      if (formData.recurring_weekly_tue) days.push('Tue');
      if (formData.recurring_weekly_wed) days.push('Wed');
      if (formData.recurring_weekly_thu) days.push('Thu');
      if (formData.recurring_weekly_fri) days.push('Fri');
      if (formData.recurring_weekly_sat) days.push('Sat');
      if (formData.recurring_weekly_sun) days.push('Sun');
      return `Bi-Weekly (${days.join(', ')})`;
    }
    return 'Bi-Weekly';
  }, [currentFrequency, hasAnyDaySelected, formData]);

  const weeklyX4Label = useMemo(() => {
    if (currentFrequency === 'weekly-x4' && hasAnyDaySelected) {
      const days = [];
      if (formData.recurring_weekly_mon) days.push('Mon');
      if (formData.recurring_weekly_tue) days.push('Tue');
      if (formData.recurring_weekly_wed) days.push('Wed');
      if (formData.recurring_weekly_thu) days.push('Thu');
      if (formData.recurring_weekly_fri) days.push('Fri');
      if (formData.recurring_weekly_sat) days.push('Sat');
      if (formData.recurring_weekly_sun) days.push('Sun');
      return `Weekly x4 (${days.join(', ')})`;
    }
    return 'Weekly x4';
  }, [currentFrequency, hasAnyDaySelected, formData]);

  // CRITICAL: Track if predictions should be stopped (when Done button is clicked or form is closing)
  const predictionsStopped = useRef(false);
  // CRITICAL: Store full prediction list from backend (never refetch unless date/user changes)
  const fullPredictionListRef = useRef([]);

  useEffect(() => {
    if (delivery || !formData.delivery_date || !currentUser || !stores || !allDeliveries) return;
    
    // CRITICAL: Stop predictions if explicitly stopped (Done button clicked)
    if (predictionsStopped.current) {
      console.log('⏸️ [DeliveryForm] Predictions STOPPED - Done button clicked');
      return;
    }

    console.log('🔄 [DeliveryForm] Fetching predictions...', { trigger: predictionTrigger });

    const fetchPredictions = async () => {
      setIsLoadingPredictions(true);

      try {
        let storeIdsToPredict = [];

        const isAdmin = userHasRole(currentUser, 'admin');
        const isDispatcher = userHasRole(currentUser, 'dispatcher');

        if (isDispatcher && !isAdmin) {
          storeIdsToPredict = currentUser.store_ids || [];
        } else if (isAdmin) {
          if (currentUser.store_ids && currentUser.store_ids.length > 0) {
            storeIdsToPredict = currentUser.store_ids;
          } else {
            storeIdsToPredict = stores.map((s) => s.id);
          }
          console.log('🔄 [DeliveryForm] Store IDs To Predict...', { storeIdsToPredict });
        } else if (userHasRole(currentUser, 'driver')) {
          const driverStores = stores.filter((store) => {
            const dateObj = new Date(formData.delivery_date + 'T00:00:00');
            const dayOfWeek = dateObj.getDay();
            const isSaturday = dayOfWeek === 6;
            const isSunday = dayOfWeek === 0;

            return isSaturday && (store.saturday_am_driver_id === currentUser.id || store.saturday_pm_driver_id === currentUser.id) ||
            isSunday && (store.sunday_am_driver_id === currentUser.id || store.sunday_pm_driver_id === currentUser.id) ||
            !isSaturday && !isSunday && (store.weekday_am_driver_id === currentUser.id || store.weekday_pm_driver_id === currentUser.id);
          });
          storeIdsToPredict = driverStores.map((s) => s.id);
        }

        if (storeIdsToPredict.length === 0 && !isAdmin) {
          setIsLoadingPredictions(false);
          return;
        }

        // Call backend function for predictions (ONLY once per form open)
        const response = await base44.functions.invoke('getDeliveryPredictions', {
          selectedDate: formData.delivery_date,
          storeIds: storeIdsToPredict,
          excludePatientIds: [] // Don't exclude any on initial load
        });

        const result = response?.data || response;
        if (result.predictions) {
          console.log('[DeliveryForm] Received predictions from backend:', result.predictions.length);
          
          // Map predictions to the format expected by UI
          const formattedPredictions = result.predictions.map(pred => ({
            patient_id: pred.patient_id,
            patient_name: pred.patient_name,
            store_id: pred.store_id,
            reason: `${pred.frequency} delivery`,
            cod_total_amount_required: pred.cod_total_amount_required || 0,
            prescription_number: pred.prescription_number || '',
            extra_time: pred.extra_time || 0
          }));

          // CRITICAL: Store full list in ref (never refetch)
          fullPredictionListRef.current = formattedPredictions;
          
          // Filter out staged patients and display
          const stagedPatientIds = new Set(stagedDeliveries.map((d) => d.patient_id).filter(Boolean));
          const filteredPredictions = formattedPredictions.filter(pred => !stagedPatientIds.has(pred.patient_id));
          setProjectedDeliveries(filteredPredictions);
        }
      } catch (error) {
        console.error('Error fetching predictions:', error);
      } finally {
        setIsLoadingPredictions(false);
      }
    };

    fetchPredictions();
  }, [delivery, formData.delivery_date, currentUser, stores, allDeliveries, predictionTrigger]);

  const handlePatientSelect = useCallback(async (patient, autoAddToStaged = false) => {
    if (!patient) return;
    
    console.log('[handlePatientSelect] patient:', patient.id);
    
    // CRITICAL: Pause location poller during patient operations
    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    driverLocationPoller.pause();
    
    // CRITICAL: Check if patient is already in staged list
    const alreadyStaged = stagedDeliveries.some(s => s.patient_id === patient.id);
    if (alreadyStaged) {
      console.log('⏸️ [handlePatientSelect] Patient already staged, skipping:', patient.full_name);
      setPatientSearch('');
      setHighlightedPatientIndex(-1);
      driverLocationPoller.resume();
      return;
    }
    
    // CRITICAL: Don't auto-load patient data if we're editing an existing delivery
    if (isLoadingExistingDelivery.current) {
      console.log('⏸️ [handlePatientSelect] Blocked - editing existing delivery');
      driverLocationPoller.resume();
      return;
    }

    const hasCompletedDelivery = allDeliveries?.some((d) =>
    d && d.patient_id === patient.id && d.status === 'completed'
    );
    const isFirstDelivery = !hasCompletedDelivery;

    setSelectedPatient(patient);

    // Find patient's store FIRST (needed throughout this function)
    const patientStore = stores.find((s) => s && s.id === patient.store_id);

    let autoSelectedDriverId = '';
    let autoSelectedDriverName = '';

    if (patient.store_id && formData.delivery_date && stores && drivers && patientStore) {
      const selectedDate = new Date(formData.delivery_date + 'T00:00:00');
      const dayOfWeek = selectedDate.getDay();

      const deliveryAMPM = determineDeliveryAMPM(patient) || (patientStore ? getStoreAssignedTimeSlot(patientStore, formData.delivery_date, allDeliveries) : null) || 'AM'; // Prefer patient window, then store-assigned slot, default AM

      let amDriverIdField = '';
      let pmDriverIdField = '';
      if (dayOfWeek === 6) {
        amDriverIdField = 'saturday_am_driver_id';
        pmDriverIdField = 'saturday_pm_driver_id';
      } else if (dayOfWeek === 0) {
        amDriverIdField = 'sunday_am_driver_id';
        pmDriverIdField = 'sunday_pm_driver_id';
      } else {
        amDriverIdField = 'weekday_am_driver_id';
        pmDriverIdField = 'weekday_pm_driver_id';
      }

      const preferredDriverIdField = deliveryAMPM === 'PM' ? pmDriverIdField : amDriverIdField;
      const fallbackDriverIdField = deliveryAMPM === 'PM' ? amDriverIdField : pmDriverIdField;

      let driverId = patientStore[preferredDriverIdField];
      let usedField = preferredDriverIdField;

      if (!driverId) {
        driverId = patientStore[fallbackDriverIdField];
        usedField = fallbackDriverIdField;
      }

      if (driverId) {
        const driver = drivers.find((d) => d && d.id === driverId);

        if (driver) {
          autoSelectedDriverId = driverId;
          autoSelectedDriverName = getDriverNameForStorage(driver);
        }
      }
    }

    // CRITICAL: Calculate AM/PM and set store variant in formData
    const deliveryAMPM = determineDeliveryAMPM(patient);
    let storeVariantId = patient.store_id || '';
    
    // If store has both AM & PM drivers, append variant suffix to show correct selection
    if (patientStore) {
      const dateObj = formData.delivery_date ? new Date(formData.delivery_date + 'T00:00:00') : new Date();
      const dayOfWeek = dateObj.getDay();
      
      let amDriverId, pmDriverId;
      if (dayOfWeek === 6) {
        amDriverId = patientStore.saturday_am_driver_id;
        pmDriverId = patientStore.saturday_pm_driver_id;
      } else if (dayOfWeek === 0) {
        amDriverId = patientStore.sunday_am_driver_id;
        pmDriverId = patientStore.sunday_pm_driver_id;
      } else {
        amDriverId = patientStore.weekday_am_driver_id;
        pmDriverId = patientStore.weekday_pm_driver_id;
      }
      
      // If both AM & PM slots exist, set variant ID for UI display
      if (amDriverId && pmDriverId && deliveryAMPM) {
        storeVariantId = `${patient.store_id}_${deliveryAMPM}`;
        console.log(`📦 [handlePatientSelect] Store has AM+PM drivers, setting variant: ${storeVariantId}`);
      }
    }

    const updatedFormData = {
      ...formData,
      patient_id: patient.id,
      patient_name: patient.full_name,
      patient_phone: patient.phone || '',
      unit_number: patient.unit_number || '',
      time_window_start: patient.time_window_start || patient.time_window_end ? patient.time_window_start || '' : '',
      time_window_end: patient.time_window_start || patient.time_window_end ? patient.time_window_end || '' : '',
      mailbox_ok: patient.mailbox_ok || false,
      call_upon_arrival: patient.call_upon_arrival || false,
      ring_bell: patient.ring_bell || false,
      dont_ring_bell: patient.dont_ring_bell || false,
      back_door: patient.back_door || false,
      signature_needed: patient.signature_needed || false,
      delivery_instructions: patient.notes || '',
      store_id: patient.store_id || '',
      ampm_deliveries: deliveryAMPM, // CRITICAL: Set calculated AM/PM
      driver_id: autoSelectedDriverId,
      driver_name: autoSelectedDriverName,
      recurring: patient.recurring || false,
      recurring_daily: patient.recurring_daily || false,
      recurring_weekly_mon: patient.recurring_weekly_mon || false,
      recurring_weekly_tue: patient.recurring_weekly_tue || false,
      recurring_weekly_wed: patient.recurring_weekly_wed || false,
      recurring_weekly_thu: patient.recurring_weekly_thu || false,
      recurring_weekly_fri: patient.recurring_weekly_fri || false,
      recurring_weekly_sat: patient.recurring_weekly_sat || false,
      recurring_weekly_sun: patient.recurring_weekly_sun || false,
      recurring_biweekly: patient.recurring_biweekly || false,
      recurring_weekly_x4: patient.recurring_weekly_x4 || false,
      recurring_monthly: patient.recurring_monthly || false,
      recurring_bimonthly: patient.recurring_bimonthly || false
    };

    setFormData(updatedFormData);
    if (!autoAddToStaged) {
      try { if (patientStore && updatedFormData.driver_id && updatedFormData.delivery_date) {
        const slot = deliveryAMPM || getStoreAssignedTimeSlot(patientStore, formData.delivery_date, allDeliveries) || 'AM';
        const r = await base44.functions.invoke('ensurePickupForDelivery', { storeId: patientStore.id, deliveryDate: updatedFormData.delivery_date, driverId: updatedFormData.driver_id, ampmDeliveries: slot, allowCreateIfMissing: true });
        const pu = r?.data?.puid; if (pu) setFormData(prev => ({ ...prev, puid: pu, ampm_deliveries: slot }));
        if (r?.data?.isNew && r?.data?.pickup) {
          const p = r.data.pickup; const staged = { ...p, _tempId: Date.now() + Math.random(), _autoCreated: true, store_name: patientStore.name, store_abbreviation: patientStore.abbreviation };
          setStagedDeliveries(prev => [...prev, staged]); if (p.id) autoCreatedPickupsRef.current.add(p.id);
        }
      } } catch {}
      if (!isMobileDevice) setTimeout(() => codAmountInputRef.current?.focus?.(), 100);
      setPatientSearch(''); setHighlightedPatientIndex(-1); driverLocationPoller.resume(); return;
    }

    if (!patientStore || !autoSelectedDriverId) {
      driverLocationPoller.resume();
      return;
    }

    if (!patient._isNew) {
      try {
        // Calculate recurring_weekly_x4_day from weekly days
        let weeklyX4Day = undefined;
        if (updatedFormData.recurring_weekly_x4) {
          if (updatedFormData.recurring_weekly_mon) weeklyX4Day = 'mon';
          else if (updatedFormData.recurring_weekly_tue) weeklyX4Day = 'tue';
          else if (updatedFormData.recurring_weekly_wed) weeklyX4Day = 'wed';
          else if (updatedFormData.recurring_weekly_thu) weeklyX4Day = 'thu';
          else if (updatedFormData.recurring_weekly_fri) weeklyX4Day = 'fri';
          else if (updatedFormData.recurring_weekly_sat) weeklyX4Day = 'sat';
          else if (updatedFormData.recurring_weekly_sun) weeklyX4Day = 'sun';
        }

        await updatePatientLocal(patient.id, {
          full_name: updatedFormData.patient_name,
          phone: updatedFormData.patient_phone,
          unit_number: updatedFormData.unit_number,
          notes: updatedFormData.delivery_instructions,
          mailbox_ok: updatedFormData.mailbox_ok,
          call_upon_arrival: updatedFormData.call_upon_arrival,
          ring_bell: updatedFormData.ring_bell,
          dont_ring_bell: updatedFormData.dont_ring_bell,
          back_door: updatedFormData.back_door,
          signature_needed: updatedFormData.signature_needed,
          recurring: updatedFormData.recurring,
          recurring_daily: updatedFormData.recurring_daily,
          recurring_weekly_mon: updatedFormData.recurring_weekly_mon,
          recurring_weekly_tue: updatedFormData.recurring_weekly_tue,
          recurring_weekly_wed: updatedFormData.recurring_weekly_wed,
          recurring_weekly_thu: updatedFormData.recurring_weekly_thu,
          recurring_weekly_fri: updatedFormData.recurring_weekly_fri,
          recurring_weekly_sat: updatedFormData.recurring_weekly_sat,
          recurring_weekly_sun: updatedFormData.recurring_weekly_sun,
          recurring_biweekly: updatedFormData.recurring_biweekly,
          recurring_weekly_x4: updatedFormData.recurring_weekly_x4,
          recurring_weekly_x4_day: weeklyX4Day,
          recurring_monthly: updatedFormData.recurring_monthly,
          recurring_bimonthly: updatedFormData.recurring_bimonthly
        });
      } catch (error) {
        console.error('Failed to update patient:', error);
      }
    }

    // Use existing distance_from_store if available, otherwise calculate
    let distanceFromStore = patient.distance_from_store;
    if (distanceFromStore === null || distanceFromStore === undefined) {
      if (patient.latitude && patient.longitude && patientStore.latitude && patientStore.longitude) {
        distanceFromStore = calculateDistance(patientStore.latitude, patientStore.longitude, patient.latitude, patient.longitude);
      }
    }

    const timeSlot = getStoreAssignedTimeSlot(patientStore, formData.delivery_date, allDeliveries);

    // CRITICAL: Check staged pickups FIRST before calling backend
    const stagedPickup = stagedDeliveries.find((d) =>
      !d.patient_id && d.store_id === patientStore.id &&
      d.delivery_date === formData.delivery_date &&
      d.driver_id === autoSelectedDriverId &&
      (d.ampm_deliveries || 'AM') === timeSlot
    );

    let puid = stagedPickup?.puid || stagedPickup?.stop_id;

    if (!puid) {
      puid = getPickupStopIdForDelivery(patientStore.id, formData.delivery_date, timeSlot, allDeliveries);
      console.log(`✅ [handlePatientSelect] Using calculated PUID: ${puid} (pickup will be created on Done)`);
    } else {
      console.log(`✅ [handlePatientSelect] Using PUID from staged pickup: ${puid}`);
    }

    const stagedDelivery = {
      ...updatedFormData,
      time_window_start: patient.time_window_start || '',
      time_window_end: patient.time_window_end || (patient.time_window_start ? '' : ''),
      puid: puid || '',
      ampm_deliveries: timeSlot,
      status: 'Staged',
      _tempId: Date.now() + Math.random(),
      patient_name: updatedFormData.patient_name || patient.full_name || 'N/A',
      store_name: patientStore.name,
      store_abbreviation: patientStore.abbreviation,
      distanceFromStore: distanceFromStore,
      delivery_address: patient.address || patientStore.address,
      isNextDelivery: false,
      paid_km_override: distanceFromStore !== null && distanceFromStore !== undefined ? parseFloat(distanceFromStore.toFixed(2)) : null,
      // CRITICAL: Include patient coordinates for map markers
      latitude: patient.latitude,
      longitude: patient.longitude
    };
    
    console.log('[handlePatientSelect] staging patient');
    
    setStagedDeliveries((prev) => [...prev, stagedDelivery]);

    setHasChanges(true);

    // CRITICAL: Filter projected deliveries locally (don't refetch from backend)
    const stagedPatientIds = new Set([...stagedDeliveries.map(d => d.patient_id), patient.id].filter(Boolean));
    const filteredPredictions = fullPredictionListRef.current.filter(pred => !stagedPatientIds.has(pred.patient_id));
    setProjectedDeliveries(filteredPredictions);

    // CRITICAL: Clear form completely after adding to staged
    setError(null);
    setSelectedPatient(null);
    setSelectedPatientIds(new Set());
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    setEditingStagedId(null);
    setFormData((prev) => ({
      ...prev,
      patient_id: '',
      patient_name: '',
      patient_phone: '',
      unit_number: '',
      delivery_instructions: '',
      delivery_notes: '',
      prescription_number: '',
      cod_total_amount_required: 0,
      cod_payments: [],
      cod_payment_type: 'No Payment',
      cod_amount: '',
      mailbox_ok: false,
      call_upon_arrival: false,
      ring_bell: false,
      dont_ring_bell: false,
      back_door: false,
      signature_needed: false,
      fridge_item: false,
      oversized: false,
      no_charge: false,
      store_id: '',
      time_window_start: '',
      time_window_end: '',
      recurring: false,
      recurring_daily: false,
      recurring_weekly_mon: false,
      recurring_weekly_tue: false,
      recurring_weekly_wed: false,
      recurring_weekly_thu: false,
      recurring_weekly_fri: false,
      recurring_weekly_sat: false,
      recurring_weekly_sun: false,
      recurring_biweekly: false,
      recurring_weekly_x4: false,
      recurring_monthly: false,
      recurring_bimonthly: false
    }));
    setSelectedPickupOption('');

    // Only auto-focus on desktop
    if (!isMobileDevice) {
      setTimeout(() => codAmountInputRef.current?.focus(), 100);
    }
    
    // Resume location poller after operations complete
    driverLocationPoller.resume();
  }, [formData, stores, drivers, allDeliveries, stagedDeliveries, isMobileDevice]);

  const handleAddSelectedPatients = useCallback(async () => {
    if (selectedPatientIds.size === 0) return;

    const patientsToAdd = filteredPatients.filter((p) => selectedPatientIds.has(p.id));

    // CRITICAL: Auto-add to staged for multiple patients
    for (const patient of patientsToAdd) {
      await handlePatientSelect(patient, true);
    }

    setSelectedPatientIds(new Set());
  }, [selectedPatientIds, filteredPatients, handlePatientSelect]);

  const compressImage = useCallback((file, maxWidth = 1200, quality = 0.7) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          if (width > maxWidth) {
            height = height * maxWidth / width;
            width = maxWidth;
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          canvas.toBlob((blob) => {
            if (blob) {
              const compressedFile = new File([blob], file.name, {
                type: 'image/jpeg',
                lastModified: Date.now()
              });
              resolve(compressedFile);
            } else {
              reject(new Error('Failed to compress image'));
            }
          }, 'image/jpeg', quality);
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  // Original handleCameraScan (for file input method) - Kept as per outline instructions
  const handleCameraScan = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsScanning(true);
    setError(null);

    try {
      console.log('📸 [DeliveryForm] Starting camera scan...', { fileName: file.name, fileSize: file.size, fileType: file.type });

      // Compress image first
      console.log('🗜️ [DeliveryForm] Compressing image...');
      const compressedFile = await compressImage(file);
      console.log('✅ [DeliveryForm] Image compressed:', {
        originalSize: file.size,
        compressedSize: compressedFile.size,
        reduction: `${((1 - compressedFile.size / file.size) * 100).toFixed(1)}%`
      });

      // Get current selected city for admin filtering
      const { globalFilters } = await import('../utils/globalFilters');
      const selectedCityId = globalFilters.getSelectedCityId();
      console.log('🏙️ [DeliveryForm] Selected city:', selectedCityId);

      // Upload the compressed image
      console.log('📤 [DeliveryForm] Uploading compressed image...');
      const uploadResult = await base44.integrations.Core.UploadFile({ file: compressedFile });
      console.log('✅ [DeliveryForm] Image uploaded:', uploadResult.file_url);

      // Now call the backend function with the file URL
      console.log('📤 [DeliveryForm] Calling scanPrescriptionLabel function...');
      const response = await base44.functions.invoke('scanPrescriptionLabel', {
        fileUrl: uploadResult.file_url,
        selectedCityId: selectedCityId
      });
      console.log('✅ [DeliveryForm] Response received:', response);

      const result = response?.data || response;

      if (result.error) {
        throw new Error(result.error);
      }

      setExtractedData(result.extractedData);

      // Check for exact matches first
      if (result.exactMatches && result.exactMatches.length === 1) {
        // Single exact match - populate form only (don't auto-add to staged)
        console.log('✅ [DeliveryForm] Single exact match found - populating form only');
        await handlePatientSelect(result.exactMatches[0].patient, false);
      } else if (result.exactMatches && result.exactMatches.length > 1) {
        // Multiple exact matches - show popup with exact matches only
        console.log('⚠️ [DeliveryForm] Multiple exact matches found - showing selection popup');
        setScanMatches(result.exactMatches);
        setShowMatchPopup(true);
      } else if (result.matches && result.matches.length > 0) {
        // No exact matches, but partial matches found - show popup
        console.log('📋 [DeliveryForm] Partial matches found - showing selection popup');
        setScanMatches(result.matches);
        setShowMatchPopup(true);
      } else {
        // No matches at all - open new patient form with pre-filled data
        console.log('➕ [DeliveryForm] No matches found - opening new patient form');
        if (onCreatePatient) {
          const newPatientData = {
            full_name: result.extractedData.patient_name,
            address: result.extractedData.street_address,
            phone: result.extractedData.phone_number,
            _isNew: true
          };

          setIsPatientFormOpen(true);
          onCreatePatient((createdPatient) => {
            setIsPatientFormOpen(false);
            // CRITICAL: Auto-add new patient to staged (true parameter)
            handlePatientSelect({
              ...createdPatient,
              ...newPatientData
            }, true);
          }, newPatientData);
        }
      }
    } catch (error) {
      console.error('Error scanning prescription:', error);
      setError(`Scan failed: ${error.message}`);
    } finally {
      setIsScanning(false);
      // Reset file input
      // cameraInputRef.current is only for file input, not for the live camera overlay.
      // The current camera button's onClick now opens the live camera overlay.
      // So this specific ref might not be directly used by the visible button anymore, but kept for compliance.
      if (patientSearchInputRef.current) {// Assuming cameraInputRef was meant to be patientSearchInputRef for clearing the search box
        patientSearchInputRef.current.value = '';
      }
    }
  }, [onCreatePatient, handlePatientSelect, compressImage]);

  // Camera functions (for live camera stream)
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setIsCameraActive(true);
      }
    } catch (err) {
      console.error("Error accessing camera:", err);
      setError("Could not access camera. Please check permissions.");
      setIsCameraActive(false);
      setShowCameraOverlay(false); // Close overlay if camera fails
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
    setIsCameraActive(false);
  }, []);

  const handleCameraCapture = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current) {
      setError("Camera not ready");
      return;
    }

    setIsScanning(true);
    setError(null);

    const video = videoRef.current;
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(async (blob) => {
      if (!blob) {
        setError("Failed to capture image");
        setIsScanning(false);
        return;
      }

      const file = new File([blob], "prescription_scan.jpg", { type: "image/jpeg" });

      try {
        console.log('📸 [DeliveryForm] Starting camera scan from capture...');

        // Compress image
        console.log('🗜️ [DeliveryForm] Compressing image...');
        const compressedFile = await compressImage(file);
        console.log('✅ [DeliveryForm] Image compressed:', {
          originalSize: file.size,
          compressedSize: compressedFile.size,
          reduction: `${((1 - compressedFile.size / file.size) * 100).toFixed(1)}%`
        });

        // Convert to Base64
        console.log('🔄 [DeliveryForm] Converting to Base64...');
        const reader = new FileReader();
        const base64Image = await new Promise((resolve, reject) => {
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(compressedFile);
        });
        console.log('✅ [DeliveryForm] Base64 conversion complete');

        // Get current selected city
        const { globalFilters } = await import('../utils/globalFilters');
        const selectedCityId = globalFilters.getSelectedCityId();

        // Call backend function
        console.log('📤 [DeliveryForm] Calling scanPrescriptionLabel...');
        const response = await base44.functions.invoke('scanPrescriptionLabel', {
          base64Image: base64Image,
          selectedCityId: selectedCityId
        });
        console.log('✅ [DeliveryForm] Response received:', response);

        const result = response?.data || response;

        if (result.error) {
          throw new Error(result.error);
        }

        setExtractedData(result.extractedData);

        // Handle matches
        if (result.exactMatches && result.exactMatches.length === 1) {
          console.log('✅ [DeliveryForm] Single exact match - populating form only');
          await handlePatientSelect(result.exactMatches[0].patient, false);
        } else if (result.exactMatches && result.exactMatches.length > 1) {
          console.log('⚠️ [DeliveryForm] Multiple exact matches - showing popup');
          setScanMatches(result.exactMatches);
          setShowMatchPopup(true);
        } else if (result.matches && result.matches.length > 0) {
          console.log('📋 [DeliveryForm] Partial matches - showing popup');
          setScanMatches(result.matches);
          setShowMatchPopup(true);
        } else {
          console.log('➕ [DeliveryForm] No matches - opening new patient form');
          if (onCreatePatient) {
            const newPatientData = {
              full_name: result.extractedData.patient_name,
              address: result.extractedData.street_address,
              phone: result.extractedData.phone_number,
              _isNew: true
            };

            setIsPatientFormOpen(true);
            onCreatePatient((createdPatient) => {
              setIsPatientFormOpen(false);
              // CRITICAL: Auto-add new patient to staged (true parameter)
              handlePatientSelect({
                ...createdPatient,
                ...newPatientData
              }, true);
            }, newPatientData);
          }
        }
      } catch (error) {
        console.error('Error scanning prescription:', error);
        setError(`Scan failed: ${error.message}`);
      } finally {
        setIsScanning(false);
        stopCamera();
        setShowCameraOverlay(false); // Close overlay after scan attempt
      }
    }, 'image/jpeg', 0.8);
  }, [onCreatePatient, handlePatientSelect, compressImage, stopCamera]);

  // Stop camera when component unmounts
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  const handleSelectMatchedPatient = useCallback(async (patient) => {
    setShowMatchPopup(false);
    setScanMatches([]);
    setExtractedData(null);
    // CRITICAL: Don't auto-add to staged when selecting from popup (single selection)
    await handlePatientSelect(patient, false);
  }, [handlePatientSelect]);

  // Handler for "Duplicate Patient" button - opens PatientForm to create new patient
  const handleDuplicatePatient = useCallback((patient) => {
    if (!patient || !onCreatePatient) return;
    
    // Get full patient data
    const fullPatient = patients.find((p) => p && p.id === patient.id) || patient;
    
    // Create patient object for form with empty name/phone/patient_id (indicating duplicate mode)
    const patientWithEmpty = {
      ...fullPatient,
      patient_id: '', // CRITICAL: Clear patient_id to trigger new PID generation
      full_name: '',
      phone: '',
      phone_secondary: '',
      _duplicateSource: true,
      _isNew: true
    };
    
    // Open patient form with duplicate mode
    setIsPatientFormOpen(true);
    onCreatePatient((createdPatient) => {
      setIsPatientFormOpen(false);
      handlePatientSelect(createdPatient, true);
    }, patientWithEmpty, 'duplicate');
    
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    
    // Find patient's store
    const patientStore = stores.find((s) => s && s.id === patient.store_id);
    
    // Auto-select driver based on patient's store
    let autoSelectedDriverId = '';
    let autoSelectedDriverName = '';
    
    if (patient.store_id && formData.delivery_date && stores && drivers && patientStore) {
      const selectedDate = new Date(formData.delivery_date + 'T00:00:00');
      const dayOfWeek = selectedDate.getDay();
      const deliveryAMPM = determineDeliveryAMPM(patient);
      
      let amDriverIdField = '';
      let pmDriverIdField = '';
      if (dayOfWeek === 6) {
        amDriverIdField = 'saturday_am_driver_id';
        pmDriverIdField = 'saturday_pm_driver_id';
      } else if (dayOfWeek === 0) {
        amDriverIdField = 'sunday_am_driver_id';
        pmDriverIdField = 'sunday_pm_driver_id';
      } else {
        amDriverIdField = 'weekday_am_driver_id';
        pmDriverIdField = 'weekday_pm_driver_id';
      }
      
      const preferredDriverIdField = deliveryAMPM === 'PM' ? pmDriverIdField : amDriverIdField;
      const fallbackDriverIdField = deliveryAMPM === 'PM' ? amDriverIdField : pmDriverIdField;
      
      let driverId = patientStore[preferredDriverIdField];
      if (!driverId) driverId = patientStore[fallbackDriverIdField];
      
      if (driverId) {
        const driver = drivers.find((d) => d && d.id === driverId);
        if (driver) {
          autoSelectedDriverId = driverId;
          autoSelectedDriverName = getDriverNameForStorage(driver);
        }
      }
    }
    
    // Fill form with patient data but clear patient_id (to create new) and name
    setFormData((prev) => ({
      ...prev,
      patient_id: '', // Empty to create new patient
      patient_name: '', // Clear name for user to enter
      patient_phone: patient.phone || '',
      unit_number: patient.unit_number || '',
      time_window_start: patient.time_window_start || '',
      time_window_end: patient.time_window_end || '',
      mailbox_ok: patient.mailbox_ok || false,
      call_upon_arrival: patient.call_upon_arrival || false,
      ring_bell: patient.ring_bell || false,
      dont_ring_bell: patient.dont_ring_bell || false,
      back_door: patient.back_door || false,
      signature_needed: patient.signature_needed || false,
      delivery_instructions: patient.notes || '',
      store_id: patient.store_id || '',
      driver_id: autoSelectedDriverId,
      driver_name: autoSelectedDriverName,
      recurring: patient.recurring || false,
      recurring_daily: patient.recurring_daily || false,
      recurring_weekly_mon: patient.recurring_weekly_mon || false,
      recurring_weekly_tue: patient.recurring_weekly_tue || false,
      recurring_weekly_wed: patient.recurring_weekly_wed || false,
      recurring_weekly_thu: patient.recurring_weekly_thu || false,
      recurring_weekly_fri: patient.recurring_weekly_fri || false,
      recurring_weekly_sat: patient.recurring_weekly_sat || false,
      recurring_weekly_sun: patient.recurring_weekly_sun || false,
      recurring_biweekly: patient.recurring_biweekly || false,
      recurring_weekly_x4: patient.recurring_weekly_x4 || false,
      recurring_monthly: patient.recurring_monthly || false,
      recurring_bimonthly: patient.recurring_bimonthly || false
    }));
    
    // Store original patient data for reference when creating new patient
    setSelectedPatient({ ...patient, _duplicateSource: true });
    
    // Focus name input after a short delay
    setTimeout(() => patientNameInputRef.current?.focus(), 150);
  }, [formData.delivery_date, stores, drivers]);

  // Handler for "New Address" button - creates new patient with same info but empty address/unit
  const handleNewAddressPatient = useCallback((patient) => {
    if (!patient) return;
    
    // CRITICAL: Get full patient data to ensure all fields are populated
    const fullPatient = patients.find((p) => p && p.id === patient.id) || patient;
    
    if (isAppOwner(currentUser)) { console.log('DEBUG: Creating new address for patient:', fullPatient); }
    
    setNewPatientMode('new_address');
    setSelectedPatient(null); // Clear selected patient since we're creating new
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    
    // Find patient's store
    const patientStore = stores.find((s) => s && s.id === fullPatient.store_id);
    
    // Auto-select driver based on patient's store
    let autoSelectedDriverId = '';
    let autoSelectedDriverName = '';
    
    if (patient.store_id && formData.delivery_date && stores && drivers && patientStore) {
      const selectedDate = new Date(formData.delivery_date + 'T00:00:00');
      const dayOfWeek = selectedDate.getDay();
      const deliveryAMPM = determineDeliveryAMPM(patient);
      
      let amDriverIdField = '';
      let pmDriverIdField = '';
      if (dayOfWeek === 6) {
        amDriverIdField = 'saturday_am_driver_id';
        pmDriverIdField = 'saturday_pm_driver_id';
      } else if (dayOfWeek === 0) {
        amDriverIdField = 'sunday_am_driver_id';
        pmDriverIdField = 'sunday_pm_driver_id';
      } else {
        amDriverIdField = 'weekday_am_driver_id';
        pmDriverIdField = 'weekday_pm_driver_id';
      }
      
      const preferredDriverIdField = deliveryAMPM === 'PM' ? pmDriverIdField : amDriverIdField;
      const fallbackDriverIdField = deliveryAMPM === 'PM' ? amDriverIdField : pmDriverIdField;
      
      let driverId = patientStore[preferredDriverIdField];
      if (!driverId) driverId = patientStore[fallbackDriverIdField];
      
      if (driverId) {
        const driver = drivers.find((d) => d && d.id === driverId);
        if (driver) {
          autoSelectedDriverId = driverId;
          autoSelectedDriverName = getDriverNameForStorage(driver);
        }
      }
    }
    
    // Fill form with patient data but clear patient_id (to create new), address and unit_number
    setFormData((prev) => ({
      ...prev,
      patient_id: '', // Empty to create new patient
      patient_name: fullPatient.full_name || '',
      patient_phone: fullPatient.phone || '',
      unit_number: '', // Clear unit number
      time_window_start: fullPatient.time_window_start || '',
      time_window_end: fullPatient.time_window_end || '',
      mailbox_ok: fullPatient.mailbox_ok || false,
      call_upon_arrival: fullPatient.call_upon_arrival || false,
      ring_bell: fullPatient.ring_bell || false,
      dont_ring_bell: fullPatient.dont_ring_bell || false,
      back_door: fullPatient.back_door || false,
      signature_needed: fullPatient.signature_needed || false,
      delivery_instructions: fullPatient.notes || '',
      store_id: fullPatient.store_id || '',
      driver_id: autoSelectedDriverId,
      driver_name: autoSelectedDriverName,
      recurring: fullPatient.recurring || false,
      recurring_daily: fullPatient.recurring_daily || false,
      recurring_weekly_mon: fullPatient.recurring_weekly_mon || false,
      recurring_weekly_tue: fullPatient.recurring_weekly_tue || false,
      recurring_weekly_wed: fullPatient.recurring_weekly_wed || false,
      recurring_weekly_thu: fullPatient.recurring_weekly_thu || false,
      recurring_weekly_fri: fullPatient.recurring_weekly_fri || false,
      recurring_weekly_sat: fullPatient.recurring_weekly_sat || false,
      recurring_weekly_sun: fullPatient.recurring_weekly_sun || false,
      recurring_biweekly: fullPatient.recurring_biweekly || false,
      recurring_weekly_x4: fullPatient.recurring_weekly_x4 || false,
      recurring_monthly: fullPatient.recurring_monthly || false,
      recurring_bimonthly: fullPatient.recurring_bimonthly || false
    }));
    
    // Create patient object with all pre-filled data but empty address/patient_id
    const patientWithoutAddress = {
      ...fullPatient,
      patient_id: '', // CRITICAL: Clear patient_id to trigger new PID generation
      address: '', // Empty address
      unit_number: '', // Empty unit
      _newAddressSource: true,
      _isNew: true,
      _focusAddress: !isMobileDevice
    };
    
    setSelectedPatient(patientWithoutAddress);
    
    // Trigger patient form to open with pre-filled data
    if (onCreatePatient) {
      setIsPatientFormOpen(true);
      onCreatePatient((createdPatient) => {
        setIsPatientFormOpen(false);
        setNewPatientMode(null);
        // CRITICAL: Auto-add new patient to staged (true parameter)
        handlePatientSelect(createdPatient, true);
      }, patientWithoutAddress, 'newAddress');
    }
  }, [formData.delivery_date, stores, drivers, onCreatePatient, handlePatientSelect, patients, isMobileDevice]);

  const handleStagedDeliveryClick = useCallback((staged) => {
    console.log('[DeliveryForm] Click staged');

    // Hide staged panel on mobile when clicking a staged item
    if (isMobileDevice) {
      setShowStagedPanel(false);
    }

    setEditingStagedId(staged._tempId);

    let formDataToSet = {
      ...staged,
      puid: staged.puid || '', // Ensure PUID is explicitly set from staged item
      driver_id: staged.driver_id || '', // CRITICAL: Ensure driver_id is explicitly set from staged item
      driver_name: staged.driver_name || '', // CRITICAL: Ensure driver_name is explicitly set from staged item
      cod_total_amount_required: staged.cod_total_amount_required > 0 ? staged.cod_total_amount_required * 100 : 0
    };
    console.log('📦 formDataToSet.puid:', formDataToSet.puid);
    console.log('📦 formDataToSet.store_id (before PUID lookup):', formDataToSet.store_id);
    console.log('📦 formDataToSet.driver_id:', formDataToSet.driver_id);
    console.log('📦 formDataToSet.driver_name:', formDataToSet.driver_name);

    // CRITICAL: If it's a patient delivery with PUID, find parent pickup to get correct store_id AND AM/PM slot
    if (staged.patient_id && staged.puid) {
      const allPossiblePickups = [...stagedDeliveries, ...(allDeliveries || [])];
      const parentPickup = allPossiblePickups.find((d) => d && !d.patient_id && d.stop_id === staged.puid);

      if (parentPickup) {
        console.log(`📦 Found parent pickup via PUID ${staged.puid}:`, {
          store_id: parentPickup.store_id,
          ampm: parentPickup.ampm_deliveries
        });
        formDataToSet.store_id = parentPickup.store_id || staged.store_id;
        formDataToSet.ampm_deliveries = parentPickup.ampm_deliveries || staged.ampm_deliveries;
      }
    }

    console.log('📦 formDataToSet.store_id (after PUID lookup):', formDataToSet.store_id);
    console.log('📦 formDataToSet.ampm_deliveries:', formDataToSet.ampm_deliveries);

    setFormData(formDataToSet);
    setSelectedPatient(null);

    // Set pickup option and find the correct store variant
    if (staged.store_id && isPickupMode) {
      const timeSlot = formDataToSet.ampm_deliveries || determineDeliveryAMPM(staged);

      // Try to find variant first (store_id_AM or store_id_PM)
      let matchingStoreId = null;
      if (timeSlot) {
        const variantId = `${staged.store_id}_${timeSlot}`;
        const variantExists = availableStores.some((s) => s && s.id === variantId);
        if (variantExists) {
          matchingStoreId = variantId;
          console.log('📦 Found variant store:', variantId);
        }
      }

      // Fallback to base store ID if no variant found
      if (!matchingStoreId) {
        const baseExists = availableStores.some((s) => s && s.id === staged.store_id);
        if (baseExists) {
          matchingStoreId = staged.store_id;
          console.log('📦 Using base store:', staged.store_id);
        }
      }

      if (matchingStoreId) {
        setSelectedPickupOption(matchingStoreId);
        console.log('📦 Set selectedPickupOption to:', matchingStoreId);
      }
    }

    // If patient exists, set it
    if (staged.patient_id && patients) {
      const patient = patients.find((p) => p && p.id === staged.patient_id);
      if (patient) {
        setSelectedPatient(patient);
        console.log('📦 Set selected patient:', patient.full_name);
      }
    }
  }, [isPickupMode, stores, patients, availableStores, stagedDeliveries, allDeliveries]);

  const isFormValid = useMemo(() => {
    if (delivery) {
      // Editing existing delivery - always valid
      return true;
    }
    
    // Editing staged delivery - check if has required data
    if (editingStagedId) {
      if (isPickupMode) {
        return !!formData.store_id && !!formData.delivery_date && !!formData.driver_id;
      }
      return (!!formData.patient_id || !!formData.patient_name) && 
             !!formData.store_id && 
             !!formData.delivery_date;
    }
    
    // For new deliveries, driver is optional (can use "All Drivers" filter)
    if (isPickupMode) return selectedPickupOption !== '' && !!formData.delivery_date && !!formData.driver_id;
    return (!!formData.patient_id || !!formData.patient_name) && !!formData.store_id &&
    !!formData.delivery_date && !isFormDisabled;
  }, [formData, selectedPickupOption, isPickupMode, delivery, isFormDisabled, editingStagedId]);

  const handleAddToStaging = useCallback(async () => {
    if (!isFormValid || !isPickupMode && !formData.patient_id && !formData.patient_name || !formData.store_id) {
      setError('Please fill all required fields.');
      return;
    }

    let patient = null;
    let isNewPatient = false;
    
    if (!isPickupMode) {
      patient = patients.find((p) => p && p.id === formData.patient_id);
      
      // CRITICAL: If no patient_id but we have patient_name, create new patient
      if (!patient && formData.patient_name && (newPatientMode === 'duplicate' || newPatientMode === 'new_address')) {
        if (!selectedPatient) {
          setError('Patient information missing for new patient creation.');
          return;
        }
        
        // CRITICAL: Check if we already have a patient_id in formData (patient was already created)
        // This prevents duplicate creation when the form state was updated but patient lookup failed
        if (formData.patient_id) {
          console.log('⏸️ [handleAddToStaging] Patient already has ID, skipping creation:', formData.patient_id);
          patient = { id: formData.patient_id, full_name: formData.patient_name };
          isNewPatient = false;
        } else {
          console.log('➕ [handleAddToStaging] Creating new patient from Duplicate/New mode:', formData.patient_name);
          
          try {
            // Create new patient with form data
            const newPatientData = {
              full_name: formData.patient_name,
              address: selectedPatient.address || '', // Use original address for duplicate, empty for new_address
              phone: formData.patient_phone || '',
              unit_number: formData.unit_number || '',
              store_id: formData.store_id,
              notes: formData.delivery_instructions || '',
              mailbox_ok: formData.mailbox_ok || false,
              call_upon_arrival: formData.call_upon_arrival || false,
              ring_bell: formData.ring_bell || false,
              dont_ring_bell: formData.dont_ring_bell || false,
              back_door: formData.back_door || false,
              signature_needed: formData.signature_needed || false,
              recurring: formData.recurring || false,
              recurring_daily: formData.recurring_daily || false,
              recurring_weekly_mon: formData.recurring_weekly_mon || false,
              recurring_weekly_tue: formData.recurring_weekly_tue || false,
              recurring_weekly_wed: formData.recurring_weekly_wed || false,
              recurring_weekly_thu: formData.recurring_weekly_thu || false,
              recurring_weekly_fri: formData.recurring_weekly_fri || false,
              recurring_weekly_sat: formData.recurring_weekly_sat || false,
              recurring_weekly_sun: formData.recurring_weekly_sun || false,
              recurring_biweekly: formData.recurring_biweekly || false,
              recurring_weekly_x4: formData.recurring_weekly_x4 || false,
              recurring_monthly: formData.recurring_monthly || false,
              recurring_bimonthly: formData.recurring_bimonthly || false,
              latitude: selectedPatient.latitude,
              longitude: selectedPatient.longitude,
              distance_from_store: selectedPatient.distance_from_store,
              status: 'active'
            };
            
            patient = await createPatientLocal(newPatientData);
            isNewPatient = true;
            
            // Update formData with new patient_id
            setFormData(prev => ({ ...prev, patient_id: patient.id }));
            
            console.log('✅ [handleAddToStaging] New patient created:', patient.id, patient.full_name);
          } catch (error) {
            console.error('Failed to create new patient:', error);
            setError('Failed to create new patient. Please try again.');
            return;
          }
        }
      } else if (!patient && !formData.patient_name) {
        setError('Patient information missing.');
        return;
      }
    }

    const store = stores.find((s) => s && s.id === formData.store_id);

    if (!store) {
      setError('Store information missing.');
      return;
    }

    const codAmount = formData.cod_total_amount_required > 0 ? formData.cod_total_amount_required / 100 : 0;

    if (formData.patient_id && !isNewPatient) {
      try {
        // Calculate recurring_weekly_x4_day from weekly days
        let weeklyX4Day = undefined;
        if (formData.recurring_weekly_x4) {
          if (formData.recurring_weekly_mon) weeklyX4Day = 'mon';
          else if (formData.recurring_weekly_tue) weeklyX4Day = 'tue';
          else if (formData.recurring_weekly_wed) weeklyX4Day = 'wed';
          else if (formData.recurring_weekly_thu) weeklyX4Day = 'thu';
          else if (formData.recurring_weekly_fri) weeklyX4Day = 'fri';
          else if (formData.recurring_weekly_sat) weeklyX4Day = 'sat';
          else if (formData.recurring_weekly_sun) weeklyX4Day = 'sun';
        }

        await updatePatientLocal(formData.patient_id, {
          full_name: formData.patient_name,
          phone: formData.patient_phone,
          unit_number: formData.unit_number,
          notes: formData.delivery_instructions,
          mailbox_ok: formData.mailbox_ok,
          call_upon_arrival: formData.call_upon_arrival,
          ring_bell: formData.ring_bell,
          dont_ring_bell: formData.dont_ring_bell,
          back_door: formData.back_door,
          signature_needed: formData.signature_needed,
          recurring: formData.recurring,
          recurring_daily: formData.recurring_daily,
          recurring_weekly_mon: formData.recurring_weekly_mon,
          recurring_weekly_tue: formData.recurring_weekly_tue,
          recurring_weekly_wed: formData.recurring_weekly_wed,
          recurring_weekly_thu: formData.recurring_weekly_thu,
          recurring_weekly_fri: formData.recurring_weekly_fri,
          recurring_weekly_sat: formData.recurring_weekly_sat,
          recurring_weekly_sun: formData.recurring_weekly_sun,
          recurring_biweekly: formData.recurring_biweekly,
          recurring_weekly_x4: formData.recurring_weekly_x4,
          recurring_weekly_x4_day: weeklyX4Day,
          recurring_monthly: formData.recurring_monthly,
          recurring_bimonthly: formData.recurring_bimonthly
        });
      } catch (error) {
        console.error('Failed to update patient:', error);
        setError('Failed to update patient data. Delivery will still be staged.');
      }
    }

    // Use existing distance_from_store if available, otherwise calculate
    let distanceFromStore = patient?.distance_from_store;
    if (distanceFromStore === null || distanceFromStore === undefined) {
      if (patient && patient.latitude && patient.longitude && store.latitude && store.longitude) {
        distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
      }
    }

    // Check for existing pickup for this store/driver/date
    let puid = null;
    const timeSlot = formData.ampm_deliveries || getStoreAssignedTimeSlot(store, formData.delivery_date, allDeliveries);

    // CRITICAL: Check staged pickups FIRST
    const stagedPickup = stagedDeliveries.find((d) =>
      !d.patient_id && d.store_id === store.id &&
      d.delivery_date === formData.delivery_date &&
      d.driver_id === formData.driver_id &&
      (d.ampm_deliveries || 'AM') === timeSlot
    );

    if (stagedPickup) {
      puid = stagedPickup.puid || stagedPickup.stop_id;
      console.log(`✅ [handleAddToStaging] Using PUID from staged pickup: ${puid}`);
    } else {
      const existingPickup = allDeliveries.find((d) =>
        d && !d.patient_id && d.store_id === store.id && d.delivery_date === formData.delivery_date && d.driver_id === formData.driver_id && (d.ampm_deliveries || 'AM') === timeSlot
      );
      if (existingPickup) {
        const reusable=(['pending','en_route','in_transit','Staged'].includes(existingPickup.status));
        if (reusable) { puid = existingPickup.stop_id; }
      }
      if (!puid) {
        try {
          const r = await base44.functions.invoke('ensurePickupForDelivery', { storeId: store.id, deliveryDate: formData.delivery_date, driverId: formData.driver_id, ampmDeliveries: timeSlot, allowCreateIfMissing: true });
          puid = r.data?.puid || getPickupStopIdForDelivery(store.id, formData.delivery_date, timeSlot, allDeliveries);
        } catch {
          puid = getPickupStopIdForDelivery(store.id, formData.delivery_date, timeSlot, allDeliveries);
        }
      }
    }

    const newStagedDelivery = {
      ...formData,
      time_window_start: patient?.time_window_start || '',
      time_window_end: patient?.time_window_end || '',
      cod_total_amount_required: codAmount,
      puid: puid || '',
      ampm_deliveries: timeSlot,
      status: 'Staged',
      _tempId: Date.now() + Math.random(),
      patient_name: formData.patient_name || patient?.full_name || 'N/A (Pickup)',
      store_name: store.name,
      store_abbreviation: store.abbreviation,
      distanceFromStore: distanceFromStore,
      delivery_address: patient?.address || store.address,
      paid_km_override: distanceFromStore !== null && distanceFromStore !== undefined ? parseFloat(distanceFromStore.toFixed(2)) : null,
      first_delivery: isNewPatient || !patient?.last_delivery_date // Mark as first delivery if new patient or no last delivery date
    };

    setStagedDeliveries((prev) => [...prev, newStagedDelivery]);

    // CRITICAL: Only auto-add default pickups when ADDING to an existing driver route
    // SKIP if this is a NEW route with zero stops (isNewRouteWithZeroStops flag)
    if (!isPickupMode && formData.driver_id && formData.delivery_date && stores && !isNewRouteWithZeroStops) {
      const specialStores = ['WestPark', 'SouthPoint', 'Lakeland Ridge', 'Sherwood Pk Mall'];
      const isSpecialStore = specialStores.some(name => 
        (stores.find(s => s?.id === formData.store_id)?.name || '').includes(name)
      );

      // Only auto-add pickups for non-special stores
      if (!isSpecialStore) {
        console.log(`📦 [AutoAddPickups] Route has existing stops - creating additional pickups as needed`);
        
        // Get the stores this driver is assigned to for the delivery date
        const selectedDate = new Date(formData.delivery_date + 'T00:00:00');
        const dayOfWeek = selectedDate.getDay();
        
        const driverAssignedStores = stores.filter(s => {
          if (!s) return false;
          
          let driverIds = [];
          if (dayOfWeek === 6) {
            driverIds = [s.saturday_am_driver_id, s.saturday_pm_driver_id];
          } else if (dayOfWeek === 0) {
            driverIds = [s.sunday_am_driver_id, s.sunday_pm_driver_id];
          } else {
            driverIds = [s.weekday_am_driver_id, s.weekday_pm_driver_id];
          }
          
          return driverIds.includes(formData.driver_id);
        });

        console.log(`📦 [AutoAddPickups] Driver ${formData.driver_id} assigned to ${driverAssignedStores.length} stores for ${formData.delivery_date}`);
        // Create all default pickups in parallel using ensurePickupForDelivery
        setTimeout(async () => {
            const pickupPromises = driverAssignedStores
              .filter(assignedStore => assignedStore && assignedStore.id !== formData.store_id)
              .map(async (assignedStore) => {
                const assignedTimeSlot = getStoreAssignedTimeSlot(assignedStore, formData.delivery_date, allDeliveries);

                // CRITICAL: Check BOTH staged AND allDeliveries for existing pickup
                const pickupExists = stagedDeliveries.some(d =>
                  !d.patient_id && d.store_id === assignedStore.id &&
                  d.delivery_date === formData.delivery_date &&
                  d.driver_id === formData.driver_id &&
                  (d.ampm_deliveries || 'AM') === assignedTimeSlot
                ) || allDeliveries?.some(d => !d?.patient_id && d.store_id===assignedStore.id && d.delivery_date===formData.delivery_date && d.driver_id===formData.driver_id && (d.ampm_deliveries||'AM')===assignedTimeSlot && (['pending','en_route','in_transit','Staged'].includes(d.status) || (d.status==='completed' && d.actual_delivery_time && (()=>{const n=new Date(),ts=n.toISOString().slice(0,10),sel=formData.delivery_date,ds=String(d.actual_delivery_time).slice(0,10);return sel===ts && ds===ts && (n - new Date(d.actual_delivery_time) < 60*60*1000)})())));

                if (!pickupExists) {
                  try {
                    console.log(`📦 [AutoAddPickups] Creating en_route pickup for: ${assignedStore.name} [${assignedTimeSlot}]`);
                    
                    const pickupResponse = await base44.functions.invoke('ensurePickupForDelivery', {
                      storeId: assignedStore.id,
                      deliveryDate: formData.delivery_date,
                      driverId: formData.driver_id,
                      ampmDeliveries: assignedTimeSlot
                    });

                    if (pickupResponse.data?.puid && pickupResponse.data?.pickup) {
                      console.log(`✅ [AutoAddPickups] Created en_route pickup for ${assignedStore.name}: ${pickupResponse.data.puid}`);
                      return pickupResponse.data.pickup;
                    }
                  } catch (error) {
                    console.warn(`⚠️ [AutoAddPickups] Failed to create pickup for ${assignedStore.name}:`, error.message);
                  }
                } else {
                  console.log(`⏭️ [AutoAddPickups] Pickup already exists for ${assignedStore.name} [${assignedTimeSlot}]`);
                }
                return null;
              });

            // Wait for all pickups to be created
            const newPickups = (await Promise.all(pickupPromises)).filter(Boolean);
            
            // CRITICAL: Add new pickups to staged list immediately
            if (newPickups.length > 0) {
              setStagedDeliveries((prev) => [...prev, ...newPickups.map(p => ({
                ...p,
                _tempId: Date.now() + Math.random(),
                store_name: stores.find(s => s?.id === p.store_id)?.name,
                store_abbreviation: stores.find(s => s?.id === p.store_id)?.abbreviation
              }))]);
              console.log(`✅ [AutoAddPickups] Added ${newPickups.length} new pickups to staged list`);
            }
            
            console.log(`✅ [AutoAddPickups] Pickup generation complete for driver's existing route`);

            // Trigger data refresh to show new pickups
            const { invalidate, invalidateDeliveriesForDate } = await import('../utils/dataManager');
            invalidate('Delivery');
            invalidateDeliveriesForDate(formData.delivery_date);
            
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
              detail: { 
                deliveryDate: formData.delivery_date, 
                driverId: formData.driver_id,
                triggeredBy: 'autoPickupCreation'
              }
            }));
        }, 100);
      }
    } else if (isNewRouteWithZeroStops) {
      console.log(`⏭️ [AutoAddPickups] SKIPPING auto-pickup creation - new route with 0 stops (isNewRouteWithZeroStops = true)`);
    }

    setHasChanges(true);

    // CRITICAL: Filter projected deliveries locally (don't refetch from backend)
    const stagedPatientIds = new Set([...stagedDeliveries.map(d => d.patient_id), formData.patient_id].filter(Boolean));
    const filteredPredictions = fullPredictionListRef.current.filter(pred => !stagedPatientIds.has(pred.patient_id));
    setProjectedDeliveries(filteredPredictions);

    // CRITICAL: Clear form completely after adding to staged
    setError(null);
    setSelectedPatient(null);
    setSelectedPatientIds(new Set());
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    setEditingStagedId(null);
    setNewPatientMode(null); // Reset new patient mode
    setFormData((prev) => ({
      ...prev, patient_id: '', patient_name: '', patient_phone: '',
      unit_number: '', delivery_instructions: '', delivery_notes: '',
      prescription_number: '', cod_total_amount_required: 0,
      cod_payments: [], cod_payment_type: 'No Payment', cod_amount: '',
      mailbox_ok: false, call_upon_arrival: false, ring_bell: false,
      dont_ring_bell: false, back_door: false, signature_needed: false, 
      fridge_item: false, oversized: false, no_charge: false, store_id: '',
      time_window_start: '', time_window_end: '',
      recurring: false, recurring_daily: false,
      recurring_weekly_mon: false, recurring_weekly_tue: false, recurring_weekly_wed: false,
      recurring_weekly_thu: false, recurring_weekly_fri: false, recurring_weekly_sat: false,
      recurring_weekly_sun: false, recurring_biweekly: false, recurring_weekly_x4: false,
      recurring_monthly: false, recurring_bimonthly: false
    }));
    setSelectedPickupOption('');

    // Only auto-focus on desktop
    if (!isMobileDevice) {
      setTimeout(() => patientSearchInputRef.current?.focus(), 100);
    }
  }, [formData, isFormValid, patients, stores, isPickupMode, newPatientMode, selectedPatient, stagedDeliveries, isMobileDevice, isNewRouteWithZeroStops, allDeliveries]);

  const handleUpdateStaged = useCallback(async () => {
    if (!editingStagedId) return;

    if (!isFormValid || !isPickupMode && !formData.patient_id && !formData.patient_name || !formData.store_id) {
      setError('Please fill all required fields.');
      return;
    }

    let patient = null;
    if (!isPickupMode) {
      patient = patients.find((p) => p && p.id === formData.patient_id);
      if (!patient && !formData.patient_name) {
        setError('Patient information missing.');
        return;
      }
    }

    const store = stores.find((s) => s && s.id === formData.store_id);

    if (!store) {
      setError('Store information missing.');
      return;
    }

    const codAmount = formData.cod_total_amount_required > 0 ? formData.cod_total_amount_required / 100 : 0;

    if (formData.patient_id) {
      try {
        // Calculate recurring_weekly_x4_day from weekly days
        let weeklyX4Day = undefined;
        if (formData.recurring_weekly_x4) {
          if (formData.recurring_weekly_mon) weeklyX4Day = 'mon';
          else if (formData.recurring_weekly_tue) weeklyX4Day = 'tue';
          else if (formData.recurring_weekly_wed) weeklyX4Day = 'wed';
          else if (formData.recurring_weekly_thu) weeklyX4Day = 'thu';
          else if (formData.recurring_weekly_fri) weeklyX4Day = 'fri';
          else if (formData.recurring_weekly_sat) weeklyX4Day = 'sat';
          else if (formData.recurring_weekly_sun) weeklyX4Day = 'sun';
        }

        await updatePatientLocal(formData.patient_id, {
          full_name: formData.patient_name,
          phone: formData.patient_phone,
          unit_number: formData.unit_number,
          notes: formData.delivery_instructions,
          mailbox_ok: formData.mailbox_ok,
          call_upon_arrival: formData.call_upon_arrival,
          ring_bell: formData.ring_bell,
          dont_ring_bell: formData.dont_ring_bell,
          back_door: formData.back_door,
          signature_needed: formData.signature_needed,
          recurring: formData.recurring,
          recurring_daily: formData.recurring_daily,
          recurring_weekly_mon: formData.recurring_weekly_mon,
          recurring_weekly_tue: formData.recurring_weekly_tue,
          recurring_weekly_wed: formData.recurring_weekly_wed,
          recurring_weekly_thu: formData.recurring_weekly_thu,
          recurring_weekly_fri: formData.recurring_weekly_fri,
          recurring_weekly_sat: formData.recurring_weekly_sat,
          recurring_weekly_sun: formData.recurring_weekly_sun,
          recurring_biweekly: formData.recurring_biweekly,
          recurring_weekly_x4: formData.recurring_weekly_x4,
          recurring_weekly_x4_day: weeklyX4Day,
          recurring_monthly: formData.recurring_monthly,
          recurring_bimonthly: formData.recurring_bimonthly
        });
      } catch (error) {
        console.error('Failed to update patient:', error);
        setError('Failed to update patient data. Delivery will still be updated.');
      }
    }

    // Use existing distance_from_store if available, otherwise calculate
    let distanceFromStore = patient?.distance_from_store;
    if (distanceFromStore === null || distanceFromStore === undefined) {
      if (patient && patient.latitude && patient.longitude && store.latitude && store.longitude) {
        distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
      }
    }

    setStagedDeliveries((prev) => prev.map((staged) => {
      if (staged._tempId !== editingStagedId) return staged;

      // CRITICAL: Preserve the original 'id' field if it exists (pending delivery)
      // This ensures pending deliveries don't get re-saved as new when clicking Done
      const updatedStaged = {
        ...formData,
        cod_total_amount_required: codAmount,
        _tempId: editingStagedId,
        _wasEdited: true, // Mark as explicitly edited by user
        id: staged.id, // PRESERVE ORIGINAL ID
        patient_name: formData.patient_name || patient?.full_name || 'N/A (Pickup)',
        store_name: store.name,
        store_abbreviation: store.abbreviation,
        distanceFromStore: distanceFromStore,
        delivery_address: patient?.address || store.address,
        // Ensure special flags are preserved
        first_delivery: formData.first_delivery || false,
        oversized: formData.oversized || false,
        fridge_item: formData.fridge_item || false,
        signature_needed: formData.signature_needed || false,
        paid_km_override: formData.paid_km_override !== null && formData.paid_km_override !== undefined 
          ? parseFloat(formData.paid_km_override.toFixed(2)) 
          : null
        };

      console.log('📝 [DeliveryForm] Updated staged delivery:', {
        _tempId: updatedStaged._tempId,
        id: updatedStaged.id,
        patient_name: updatedStaged.patient_name,
        status: updatedStaged.status
      });

      return updatedStaged;
    }));

    // CRITICAL: Clear form completely after updating staged
    setHasChanges(true);
    setError(null);
    setEditingStagedId(null);
    setSelectedPatient(null);
    setSelectedPatientIds(new Set());
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    setFormData((prev) => ({
      ...prev, patient_id: '', patient_name: '', patient_phone: '',
      unit_number: '', delivery_instructions: '', delivery_notes: '',
      prescription_number: '', cod_total_amount_required: 0,
      cod_payments: [], cod_payment_type: 'No Payment', cod_amount: '',
      mailbox_ok: false, call_upon_arrival: false, ring_bell: false,
      dont_ring_bell: false, back_door: false, signature_needed: false, 
      fridge_item: false, oversized: false, no_charge: false, store_id: '',
      time_window_start: '', time_window_end: '',
      recurring: false, recurring_daily: false,
      recurring_weekly_mon: false, recurring_weekly_tue: false, recurring_weekly_wed: false,
      recurring_weekly_thu: false, recurring_weekly_fri: false, recurring_weekly_sat: false,
      recurring_weekly_sun: false, recurring_biweekly: false, recurring_weekly_x4: false,
      recurring_monthly: false, recurring_bimonthly: false
    }));
    setSelectedPickupOption('');

    // Only auto-focus on desktop
    if (!isMobileDevice) {
      setTimeout(() => patientSearchInputRef.current?.focus(), 100);
    }
  }, [editingStagedId, formData, isFormValid, patients, stores, isPickupMode, isMobileDevice]);

  const handleBatchSave = useCallback(async () => {
    console.log('='.repeat(50));
    console.log('[AddToRoute] 🎯 DeliveryForm: handleBatchSave initiated');
    console.log('[AddToRoute] 📦 Staged deliveries count:', stagedDeliveries.length);
    console.log('[AddToRoute] 📦 Staged deliveries:', stagedDeliveries.map((s) => ({
      id: s.id,
      _tempId: s._tempId,
      patient_name: s.patient_name,
      status: s.status,
      hasId: !!s.id
    })));

    // CRITICAL: Stop prediction manager COMPLETELY when Done button is clicked
    console.log('⏸️ [DeliveryForm] Stopping delivery prediction manager PERMANENTLY...');
    predictionsStopped.current = true; // Block predictions permanently
    setIsLoadingPredictions(true); // Block predictions immediately
    setProjectedDeliveries([]); // Clear projections

    if (stagedDeliveries.length === 0 && !hasPendingDeletes) {
      console.warn('[AddToRoute] ⚠️ No staged deliveries to save');
      hasLoadedPending.current = false; // Reset flag when closing without saves
      predictionsStopped.current = false; // Reset for next open
      base44.functions.invoke('cleanupStagedPickups', { driverId: formData.driver_id, deliveryDate: formData.delivery_date }).catch(()=>{}); onCancel(); // Close form immediately
      return;
    }

    // CRITICAL: If only pending deletes (no staged items), close form FIRST then refresh
    if (stagedDeliveries.length === 0 && hasPendingDeletes) {
      console.log('[AddToRoute] 🗑️ Processing pending deletes (Done button clicked)...');
      
      // Clear state and close form IMMEDIATELY
      setStagedDeliveries([]);
      setProjectedDeliveries([]);
      setHasPendingDeletes(false);
      setHasChanges(false);
      hasLoadedPending.current = false;
      predictionsStopped.current = false;
      setIsLoadingPredictions(true);
      
      // CRITICAL: Resume background operations before closing
      (async () => {
        try {
          const { smartRefreshManager } = await import('../utils/smartRefreshManager');
          const { driverLocationPoller } = await import('../utils/driverLocationPoller');
          const { routePolylineManager } = await import('../utils/routePolylineManager');
          const { fabControlEvents } = await import('../utils/fabControlEvents');
          
          smartRefreshManager.resume();
          driverLocationPoller.resume();
          routePolylineManager?.resume?.();
          fabControlEvents.resumeFAB();
          
          console.log('▶️ [AddToRoute Deletes] Resumed background operations');
        } catch (error) {
          console.warn('⚠️ [AddToRoute] Failed to resume managers:', error);
        }
      })();
      
      base44.functions.invoke('cleanupStagedPickups', { driverId: formData.driver_id, deliveryDate: formData.delivery_date }).catch(()=>{}); onCancel();
      
      // Background refresh (non-blocking)
      setTimeout(async () => {
        try {
          const { invalidate, invalidateDeliveriesForDate } = await import('../utils/dataManager');
          invalidate('Delivery');
          invalidateDeliveriesForDate(formData.delivery_date);
          
          if (formData.driver_id && formData.delivery_date) {
            console.log('[AddToRoute] 🔄 Background: Forcing backend refresh after deletions...');
            const { base44 } = await import('@/api/base44Client');
            const freshDeliveries = await base44.entities.Delivery.filter({
              driver_id: formData.driver_id,
              delivery_date: formData.delivery_date
            });
            console.log(`✅ [AddToRoute] Background: ${freshDeliveries.length} deliveries`);
          }
          
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: { 
              deliveryDate: formData.delivery_date, 
              driverId: formData.driver_id,
              triggeredBy: 'doneButtonDeletes' 
            }
          }));
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
          
          const { fabControlEvents } = await import('../utils/fabControlEvents');
          fabControlEvents.notifyDataReady();
          
          console.log('[AddToRoute] ✅ Background: UI refreshed and FAB activated');
        } catch (error) {
          console.error('[AddToRoute] ❌ Background refresh failed:', error);
        }
      }, 100);
      
      return;
    }

    // CRITICAL: Filter out any deliveries that no longer exist in the database
    // This prevents errors when a delivery was deleted but still in stagedDeliveries
    const validStagedDeliveries = stagedDeliveries.filter((staged) => {
      // If it has an id, verify it still exists in allDeliveries
      if (staged.id) {
        const stillExists = allDeliveries?.some((d) => d && d.id === staged.id);
        if (!stillExists) {
          console.log(`[AddToRoute] ⏭️ Skipping deleted delivery: ${staged.id} (${staged.patient_name})`);
          return false;
        }
      }
      return true;
    });

    // CRITICAL: Separate into 2 groups:
    // 1. New deliveries (no id) - create new
    // 2. Existing deliveries (id) - update, BUT only process:
    //    - Items explicitly edited by user (_wasEdited = true), OR
    //    - Items that are NOT in a completion status (i.e. pending/in_transit still need to be saved)
    //    - SKIP unedited items with completed/cancelled/failed status
    const newDeliveries = validStagedDeliveries.filter((staged) => !staged.id);
    const existingDeliveries = validStagedDeliveries.filter((staged) => {
      if (!staged.id) return false;
      // Always process explicitly edited items
      if (staged._wasEdited) return true;
      // Skip unedited completion-status items (completed, failed, cancelled)
      const completionStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      if (completionStatuses.includes(staged.status)) {
        console.log(`[AddToRoute] ⏭️ Skipping unedited ${staged.status} delivery: ${staged.patient_name}`);
        return false;
      }
      // Process unedited pending/in_transit items (they need status transition to pending)
      return true;
    });

    console.log('[AddToRoute] 🔍 Total staged:', validStagedDeliveries.length, '| New:', newDeliveries.length, '| Existing:', existingDeliveries.length);
    console.log('[AddToRoute] 🔍 New deliveries to save:', newDeliveries.map((s) => ({
      _tempId: s._tempId,
      patient_name: s.patient_name
    })));
    console.log('[AddToRoute] 🔍 Existing deliveries to save:', existingDeliveries.map((s) => ({
      id: s.id,
      patient_name: s.patient_name,
      status: s.status
    })));

    if (newDeliveries.length === 0 && existingDeliveries.length === 0) {
      console.log('[AddToRoute] ℹ️ No deliveries to save');
      setStagedDeliveries([]);
      setProjectedDeliveries([]);
      hasLoadedPending.current = false;
      predictionsStopped.current = false; // Reset for next open
      setIsLoadingPredictions(true); // Keep predictions blocked
      base44.functions.invoke('cleanupStagedPickups', { driverId: formData.driver_id, deliveryDate: formData.delivery_date }).catch(()=>{}); onCancel();
      return;
    }

    // Get delivery date from form data for use in TR# calculation
    const deliveryDate = formData.delivery_date;

    // Calculate sequential TR#s based on pickup's TR# for each store/AM-PM combination
    const calculateSequentialTRs = (deliveries) => {
      // Group by store_id + ampm_deliveries (each store/AM-PM slot has its own pickup with TR#)
      const groups = {};

      deliveries.forEach((del) => {
        const groupKey = `${del.store_id}_${del.ampm_deliveries || 'AM'}`;
        if (!groups[groupKey]) {
          const store = stores?.find((s) => s && s.id === del.store_id);
          const storeAbbrev = store?.abbreviation || '';

          // CRITICAL: Find the pickup's TR# for this store/AM-PM combination
          const pickup = allDeliveries?.find((d) =>
            d &&
            !d.patient_id &&
            d.store_id === del.store_id &&
            d.delivery_date === formData.delivery_date &&
            d.driver_id === del.driver_id &&
            (d.ampm_deliveries || 'AM') === (del.ampm_deliveries || 'AM')
          );

          let pickupTR = store?.base_tracking_number || 0;
          if (pickup?.tracking_number) {
            const parsedTR = parseInt(pickup.tracking_number, 10);
            if (!isNaN(parsedTR)) {
              pickupTR = parsedTR;
            }
          }

          groups[groupKey] = {
            pickupTR: pickupTR,
            abbreviation: storeAbbrev,
            deliveries: []
          };
          console.log(`[AddToRoute] 🏪 Store ${store?.name} [${del.ampm_deliveries || 'AM'}] - Pickup TR: ${pickupTR}, Abbrev: ${storeAbbrev}`);
        }
        groups[groupKey].deliveries.push(del);
      });

      // Count existing deliveries for each group (store + AM/PM)
      Object.keys(groups).forEach((groupKey) => {
        const [storeId, ampm] = groupKey.split('_');
        const existingCount = allDeliveries?.filter((d) =>
          d &&
          d.patient_id && // Only count deliveries, not pickups
          d.store_id === storeId &&
          d.delivery_date === formData.delivery_date &&
          (d.ampm_deliveries || 'AM') === ampm
        ).length || 0;

        groups[groupKey].existingCount = existingCount;
        console.log(`[AddToRoute] 📊 Group ${groupKey}: ${existingCount} existing deliveries`);
      });

      // Assign sequential TR#s: abbreviation + (pickupTR + existing + index + 1)
      const updatedDeliveries = deliveries.map((del) => {
        if (!del.patient_id) return del; // Skip pickups

        const groupKey = `${del.store_id}_${del.ampm_deliveries || 'AM'}`;
        const group = groups[groupKey];
        if (!group) return del;

        // Sort this group's new deliveries by patient name for consistent ordering
        const newDeliveriesInGroup = [...group.deliveries].
        filter((d) => d.patient_id).
        sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));

        const indexInGroup = newDeliveriesInGroup.findIndex((d) => d._tempId === del._tempId);
        const trNumber = group.pickupTR + group.existingCount + indexInGroup + 1;
        const trString = `${group.abbreviation}${trNumber}`;

        console.log(`[AddToRoute] 🔢 ${del.patient_name}: ${trString} (pickup: ${group.pickupTR}, existing: ${group.existingCount}, index: ${indexInGroup})`);

        return {
          ...del,
          tracking_number: trString
        };
      });

      return updatedDeliveries;
    };

    // CRITICAL: Before calculating TRs, ensure ALL deliveries have correct store_id via PUID lookup
    const deliveriesWithCorrectStores = newDeliveries.map((del) => {
      if (!del.patient_id || !del.puid) return del; // Skip pickups or deliveries without PUID
      
      // Find parent pickup via PUID
      const parentPickup = allDeliveries?.find((d) => 
        d && !d.patient_id && d.stop_id === del.puid
      );
      
      if (parentPickup && parentPickup.store_id) {
        console.log(`📦 [BatchSave] Correcting store for ${del.patient_name}: ${del.store_id} → ${parentPickup.store_id} (via PUID ${del.puid})`);
        return {
          ...del,
          store_id: parentPickup.store_id,
          ampm_deliveries: parentPickup.ampm_deliveries || del.ampm_deliveries
        };
      }
      
      return del;
    });

    const deliveriesWithTRs = calculateSequentialTRs(deliveriesWithCorrectStores);

    // STEP 2: Re-number ALL existing deliveries for affected pickup groups
    const affectedGroups = new Set(deliveriesWithCorrectStores.map((del) =>
    `${del.store_id}_${del.driver_id}_${del.ampm_deliveries || 'AM'}`
    ));

    console.log('[AddToRoute] 🔄 Affected pickup groups:', Array.from(affectedGroups));

    // Collect existing deliveries that need TR# updates
    const existingDeliveriesToUpdate = [];

    for (const groupKey of affectedGroups) {
      const [storeId, driverId, ampm] = groupKey.split('_');

      // Find the pickup for this group
      const existingPickup = allDeliveries?.find((d) =>
      d &&
      !d.patient_id &&
      d.store_id === storeId &&
      d.driver_id === driverId &&
      d.delivery_date === formData.delivery_date &&
      (d.ampm_deliveries || 'AM') === ampm
      );

      // CRITICAL: Get store reference FIRST
      const store = stores?.find((s) => s && s.id === storeId);
      const storeAbbrev = store?.abbreviation || '';

      // CRITICAL: Use pickup's TR# if available, fallback to store base_tracking_number
      let effectivePickupTR = store?.base_tracking_number || 0;

      if (existingPickup && existingPickup.tracking_number !== undefined && existingPickup.tracking_number !== null && existingPickup.tracking_number !== '') {
        const pickupTR = parseInt(existingPickup.tracking_number, 10);
        effectivePickupTR = isNaN(pickupTR) ? effectivePickupTR : pickupTR;
        console.log(`[AddToRoute] 🔢 Using pickup TR# ${effectivePickupTR} for group ${groupKey} (raw: "${existingPickup.tracking_number}")`);
      } else {
        console.log(`[AddToRoute] 🏪 No pickup TR found for group ${groupKey}, using store base TR# ${effectivePickupTR}`);
      }

      // Get all existing deliveries for this group (already saved in DB)
      const existingDeliveriesInGroup = (allDeliveries || []).filter((d) =>
      d &&
      d.patient_id && // Is a delivery, not pickup
      d.store_id === storeId &&
      d.driver_id === driverId &&
      d.delivery_date === formData.delivery_date &&
      (d.ampm_deliveries || 'AM') === ampm
      );

      // Sort by patient name for consistent ordering
      existingDeliveriesInGroup.sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));

      // Re-assign sequential TR#s: abbreviation + (pickupTR + index + 1)
      existingDeliveriesInGroup.forEach((delivery, index) => {
        const correctTR = `${storeAbbrev}${effectivePickupTR + index + 1}`;
        if (delivery.tracking_number !== correctTR) {
          console.log(`[AddToRoute] 🔧 Fixing existing TR#: ${delivery.patient_name} from ${delivery.tracking_number} to ${correctTR}`);
          existingDeliveriesToUpdate.push({
            id: delivery.id,
            tracking_number: correctTR
          });
        }
      });
    }

    setIsSaving(true);
    setError(null);

    // CRITICAL: Set batch form saving flag to prevent SmartRefresh spam
    setBatchFormSaving(true);
    console.log('🔒 [AddToRoute] Batch form saving ACTIVE - SmartRefresh restarts will be skipped');

    // CRITICAL: Pause SmartRefresh ONCE for the entire batch operation
    try {
      const { smartRefreshManager } = await import('../utils/smartRefreshManager');
      smartRefreshManager.pause();
      console.log('⏸️ [AddToRoute] Paused SmartRefresh for batch operation');
    } catch (error) {
      console.warn('⚠️ [AddToRoute] Failed to pause SmartRefresh:', error);
    }

    try {
      // First, update existing deliveries with corrected TR#s (batched for speed)
      if (existingDeliveriesToUpdate.length > 0) {
        console.log(`[AddToRoute] 📝 Updating ${existingDeliveriesToUpdate.length} existing deliveries with corrected TR#s...`);
        const { base44 } = await import('@/api/base44Client');
        const trUpdatePromises = existingDeliveriesToUpdate.map((update) =>
          base44.entities.Delivery.update(update.id, { tracking_number: update.tracking_number })
            .catch((error) => {
              if (error.message?.includes('not found') || error.response?.status === 404) {
                console.log(`[AddToRoute] ⏭️ Skipping deleted delivery: ${update.id}`);
                return null;
              }
              const delivery = allDeliveries?.find((d) => d?.id === update.id);
              const deliveryName = delivery?.patient_name || 'Unknown';
              const errorMessage = error.message?.replace(update.id, deliveryName) || error.message;
              throw new Error(errorMessage);
            })
        );
        await Promise.all(trUpdatePromises);
        console.log('[AddToRoute] ✅ Existing TR#s corrected');
      }

      // Second, update existing deliveries (both pending and status-changed) - batched for speed
      if (existingDeliveries.length > 0) {
        console.log(`[AddToRoute] 📝 Updating ${existingDeliveries.length} existing deliveries...`);

        // Check if any deliveries are completed for this driver/date
        const hasCompletedDeliveries = allDeliveries?.some((d) =>
        d &&
        d.driver_id === formData.driver_id &&
        d.delivery_date === formData.delivery_date &&
        d.status === 'completed'
        );

        const updatePromises = existingDeliveries.map((updated) => {
          // Convert statuses for batch save
          let finalStatus = updated.status;
          if (finalStatus === 'Staged') {
            finalStatus = (!updated.patient_id) ? 'en_route' : 'pending';
            // If it's a delivery (not a pickup) check if it's InterStore
            if (updated.patient_id) {
              const patientName = (updated.patient_name || '').toLowerCase();
              const deliveryNotes = (updated.delivery_notes || '').toLowerCase();
              const patientNotes = (updated.delivery_instructions || '').toLowerCase();
              const deliveryAddress = (updated.delivery_address || '').toLowerCase();
              const isInterStore = patientName.includes('interstore') || deliveryNotes.includes('interstore') || patientNotes.includes('interstore') || deliveryAddress.includes('(isp)') || deliveryAddress.includes('(isd)');
              if (isInterStore) {
                finalStatus = 'in_transit';
              }
            }
          }

          const updateData = {
            status: finalStatus,
            delivery_notes: updated.delivery_notes || '',
            prescription_number: updated.prescription_number || '',
            cod_total_amount_required: updated.cod_total_amount_required || 0,
            delivery_instructions: updated.delivery_instructions || '',
            tracking_number: updated.tracking_number || '99',
            isNextDelivery: hasCompletedDeliveries ? false : updated.isNextDelivery || false,
            patient_name: updated.patient_name || '',
            patient_phone: updated.patient_phone || '',
            unit_number: updated.unit_number || '',
            mailbox_ok: updated.mailbox_ok || false,
            call_upon_arrival: updated.call_upon_arrival || false,
            ring_bell: updated.ring_bell || false,
            dont_ring_bell: updated.dont_ring_bell || false,
            back_door: updated.back_door || false,
            signature_needed: updated.signature_needed || false,
            fridge_item: updated.fridge_item || false,
            oversized: updated.oversized || false,
            no_charge: updated.no_charge || false,
            extra_time: updated.extra_time || 0,
            paid_km_override: updated.paid_km_override ?? null,
            store_id: updated.store_id || '',
            ampm_deliveries: updated.ampm_deliveries || null,
            puid: updated.puid || ''
          };

          return updateDeliveryLocal(updated.id, updateData, { isBatchOperation: true, skipSmartRefresh: true })
            .then(() => {
              console.log(`[AddToRoute] ✅ Updated delivery: ${updated.patient_name} to status ${updateData.status}`);
              return null;
            })
            .catch((error) => {
              // Skip deliveries that were deleted
              if (error.message?.includes('not found') || error.response?.status === 404) {
                console.log(`[AddToRoute] ⏭️ Skipping deleted delivery: ${updated.id} (${updated.patient_name})`);
                return null;
              }
              const errorMessage = error.message?.replace(updated.id, updated.patient_name || 'Unknown Patient') || error.message;
              throw new Error(errorMessage);
            });
        });

        console.log(`[AddToRoute] 🚀 Batching ${updatePromises.length} updates in parallel...`);
        await Promise.all(updatePromises);
        console.log('[AddToRoute] ✅ All existing deliveries updated');(()=>{try{const __todayLocal=format(new Date(),'yyyy-MM-dd');const ids=Array.from(new Set(existingDeliveries.filter(d=>(d.status==='completed'||d.status==='failed')&&d.patient_id).map(d=>d.patient_id)));ids.forEach(pid=>{updatePatientLocal(pid,{last_delivery_date:__todayLocal});});if(ids.length)console.log('🗓️ [BatchSave] Updated last_delivery_date for',ids.length,'patients');}catch(_){}})()
      }

      // CRITICAL: Create ALL default pickups ONLY for new routes (isNewRouteWithZeroStops = true)
      if (newDeliveries.length > 0 && isNewRouteWithZeroStops) {
        console.log('📦 [DoneButton] NEW ROUTE - Creating all default pickups for assigned drivers...');
        
        // Group deliveries by driver_id
        const driverGroups = {};
        newDeliveries.forEach(del => {
          if (!del.patient_id || !del.driver_id) return; // Skip pickups
          
          if (!driverGroups[del.driver_id]) {
            driverGroups[del.driver_id] = {
              driverId: del.driver_id,
              deliveryDate: del.delivery_date,
              deliveries: []
            };
          }
          driverGroups[del.driver_id].deliveries.push(del);
        });
        
        // For each driver, create pickups for ALL assigned stores
        for (const driverId of Object.keys(driverGroups)) {
          const group = driverGroups[driverId];
          
          // Get all stores this driver is assigned to
          const selectedDate = new Date(group.deliveryDate + 'T00:00:00');
          const dayOfWeek = selectedDate.getDay();
          
          const driverAssignedStores = stores.filter(s => {
            if (!s) return false;
            
            let driverIds = [];
            if (dayOfWeek === 6) {
              driverIds = [s.saturday_am_driver_id, s.saturday_pm_driver_id];
            } else if (dayOfWeek === 0) {
              driverIds = [s.sunday_am_driver_id, s.sunday_pm_driver_id];
            } else {
              driverIds = [s.weekday_am_driver_id, s.weekday_pm_driver_id];
            }
            
            return driverIds.includes(driverId);
          });
          
          console.log(`📦 [DoneButton] Creating pickups for driver ${driverId} - ${driverAssignedStores.length} assigned stores`);
          
          // Create pickup for each assigned store (both AM and PM if applicable)
          const specialStores = ['WestPark', 'SouthPoint', 'Lakeland Ridge', 'Sherwood Pk Mall'];
          
          for (const assignedStore of driverAssignedStores) {
            const isSpecialStore = specialStores.some(name => assignedStore.name?.includes(name));
            if (isSpecialStore) {
              console.log(`⏭️ [DoneButton] Skipping special store: ${assignedStore.name}`);
              continue;
            }
            
            // Determine which time slots this driver covers for this store
            const timeSlots = [];
            if (dayOfWeek === 6) {
              if (assignedStore.saturday_am_driver_id === driverId) timeSlots.push('AM');
              if (assignedStore.saturday_pm_driver_id === driverId) timeSlots.push('PM');
            } else if (dayOfWeek === 0) {
              if (assignedStore.sunday_am_driver_id === driverId) timeSlots.push('AM');
              if (assignedStore.sunday_pm_driver_id === driverId) timeSlots.push('PM');
            } else {
              if (assignedStore.weekday_am_driver_id === driverId) timeSlots.push('AM');
              if (assignedStore.weekday_pm_driver_id === driverId) timeSlots.push('PM');
            }
            
            // Create pickup for each time slot
            for (const timeSlot of timeSlots) {
              try {
                const pickupResponse = await base44.functions.invoke('ensurePickupForDelivery', {
                  storeId: assignedStore.id,
                  deliveryDate: group.deliveryDate,
                  driverId: driverId,
                  ampmDeliveries: timeSlot
                });
                
                console.log(`✅ [DoneButton] Pickup ensured for ${assignedStore.name} [${timeSlot}]: ${pickupResponse.data?.puid}`);
              } catch (error) {
                console.warn(`⚠️ [DoneButton] Failed to ensure pickup for ${assignedStore.name} [${timeSlot}]:`, error.message);
              }
            }
          }
        }
        
        console.log('✅ [DoneButton] All default pickups created for new route');
      } else if (newDeliveries.length > 0 && !isNewRouteWithZeroStops) {
        console.log('⏭️ [DoneButton] EXISTING ROUTE - Skipping default pickup creation (pickups already exist)');
      }
      
      // Then save new deliveries OR trigger data refresh
      if (newDeliveries.length > 0) {
        console.log('[AddToRoute] 📤 Calling Dashboard save handler with batch data...');
        // CRITICAL: Convert status before saving
        // - 'Staged' → 'pending' for regular deliveries
        // - 'Staged' → 'in_transit' for InterStore deliveries (patient with 'InterStore', '(ISP)', or '(ISD)' in name/notes/address)
        const deliveriesReadyForDB = deliveriesWithTRs.map(d => {
          if (d.status === 'Staged') {
            let newStatus = (!d.patient_id) ? 'en_route' : 'pending';
            // If it's a delivery (not a pickup) check if it's InterStore
            if (d.patient_id) {
              const patientName = (d.patient_name || '').toLowerCase();
              const deliveryNotes = (d.delivery_notes || '').toLowerCase();
              const patientNotes = (d.delivery_instructions || '').toLowerCase();
              const deliveryAddress = (d.delivery_address || '').toLowerCase();
              const isInterStore = patientName.includes('interstore') || deliveryNotes.includes('interstore') || patientNotes.includes('interstore') || deliveryAddress.includes('(isp)') || deliveryAddress.includes('(isd)');
              if (isInterStore) {
                newStatus = 'in_transit';
              }
            }
            return {
              ...d,
              status: newStatus
            };
          }
          return d;
        });
        await onSave({ _isBatchSave: true, _stagedDeliveries: deliveriesReadyForDB });
        
        // SQUARE INTEGRATION: Create COD items only for in_transit deliveries (not pending) - batched for speed
        // Note: At this point, cod_total_amount_required is already in DOLLARS (converted earlier in batch save)
        const squarePromises = deliveriesReadyForDB
          .filter(d => d.cod_total_amount_required > 0 && d.patient_id && d.driver_id && d.status === 'in_transit')
          .map(delivery => {
            const store = stores?.find(s => s && s.id === delivery.store_id);
            console.log('💳 [Square] Creating COD item for in_transit delivery:', delivery.patient_name, 'Amount:', delivery.cod_total_amount_required);
            return base44.functions.invoke('squareCreateCodItem', {
              deliveryId: delivery.id || delivery._tempId,
              patientName: delivery.patient_name,
              storeAbbreviation: store?.abbreviation || '',
              codAmount: delivery.cod_total_amount_required,
              deliveryDate: delivery.delivery_date,
              storeId: delivery.store_id
            })
              .then(() => {
                console.log('✅ [Square] COD item created for:', delivery.patient_name);
                return null;
              })
              .catch(squareError => {
                console.error('⚠️ [Square] Failed to create COD item:', squareError);
                return null; // Don't block if Square fails
              });
          });

        if (squarePromises.length > 0) {
          await Promise.all(squarePromises);
        }
        console.log('[AddToRoute] ✅ Batch save completed successfully');
      }

      // CRITICAL: Resume SmartRefresh ONCE after all updates complete
      try {
        setBatchFormSaving(false); // Release batch flag FIRST
        console.log('🔓 [AddToRoute] Batch form saving COMPLETE - SmartRefresh restarts re-enabled');
        
        const { smartRefreshManager } = await import('../utils/smartRefreshManager');
        smartRefreshManager.restart();
        console.log('▶️ [AddToRoute] Resumed SmartRefresh after batch operation');
      } catch (error) {
        console.warn('⚠️ [AddToRoute] Failed to resume SmartRefresh:', error);
      }

      // CRITICAL: Always trigger data refresh if only updating existing deliveries
      if (existingDeliveries.length > 0 && newDeliveries.length === 0) {
        console.log('[AddToRoute] 🔄 Updating existing deliveries only...');
        
        // Clear staged deliveries and close form FIRST
        console.log('[AddToRoute] 🧹 Clearing staged deliveries and closing form...');
        setStagedDeliveries([]);
        setProjectedDeliveries([]);
        setHasPendingDeletes(false);
        setHasChanges(false);
        hasLoadedPending.current = false;
        predictionsStopped.current = false;
        setIsLoadingPredictions(true);
        console.log('[AddToRoute] ✅ Staged deliveries cleared');

        // CRITICAL: Resume background operations before closing
        (async () => {
          try {
            const { smartRefreshManager } = await import('../utils/smartRefreshManager');
            const { driverLocationPoller } = await import('../utils/driverLocationPoller');
            const { routePolylineManager } = await import('../utils/routePolylineManager');
            const { fabControlEvents } = await import('../utils/fabControlEvents');
            
            smartRefreshManager.resume();
            driverLocationPoller.resume();
            routePolylineManager?.resume?.();
            fabControlEvents.resumeFAB();
            
            console.log('▶️ [AddToRoute Updates] Resumed background operations');
          } catch (error) {
            console.warn('⚠️ [AddToRoute] Failed to resume managers:', error);
          }
        })();

        base44.functions.invoke('cleanupStagedPickups', { driverId: formData.driver_id, deliveryDate: formData.delivery_date }).catch(()=>{}); onCancel(); // Close form IMMEDIATELY

        // CRITICAL: Immediate UI refresh events
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { 
            deliveryDate: formData.delivery_date, 
            driverId: formData.driver_id,
            triggeredBy: 'doneButtonUpdates',
            immediate: true
          }
        }));
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

        // Background refresh (non-blocking)
        setTimeout(async () => {
          try {
            const { invalidate, invalidateDeliveriesForDate } = await import('../utils/dataManager');
            invalidate('Delivery');
            invalidateDeliveriesForDate(formData.delivery_date);
            
            if (formData.driver_id && formData.delivery_date) {
              console.log('[AddToRoute] 🔄 Background: Forcing backend refresh...');
              const { base44 } = await import('@/api/base44Client');
              const freshDeliveries = await base44.entities.Delivery.filter({
                driver_id: formData.driver_id,
                delivery_date: formData.delivery_date
              });
              console.log(`✅ [AddToRoute] Background: ${freshDeliveries.length} deliveries`);
            }

            const { fabControlEvents } = await import('../utils/fabControlEvents');
            fabControlEvents.notifyDataReady();

            // CRITICAL: Trigger done button event to activate FAB phase 1 for 500ms
            fabControlEvents.notifyDoneButtonClicked();
            console.log('[AddToRoute] ✅ Background: UI refreshed, FAB activated, and done button event triggered');
          } catch (error) {
            console.error('[AddToRoute] ❌ Background refresh failed:', error);
          }
        }, 100);

        return; // CRITICAL: Exit early to prevent duplicate processing
      }

      // CRITICAL: Force IMMEDIATE backend data fetch (don't wait for smart refresh cycle)
      console.log('[AddToRoute] 🔄 IMMEDIATE: Fetching fresh data from backend...');
      try {
        const freshDeliveries = await base44.entities.Delivery.filter({
          driver_id: formData.driver_id,
          delivery_date: formData.delivery_date
        });
        
        // Update offline DB immediately
        const { offlineDB } = await import('../utils/offlineDatabase');
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
        
        // Dispatch immediate update event with fresh data
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { 
            deliveryDate: formData.delivery_date, 
            driverId: formData.driver_id,
            triggeredBy: 'doneButtonCreates',
            immediate: true,
            freshDeliveries: freshDeliveries // Include fresh data for instant UI update
          }
        }));
        
        console.log(`✅ [AddToRoute] Immediate refresh complete - ${freshDeliveries.length} deliveries`);
      } catch (fetchError) {
        console.warn('⚠️ [AddToRoute] Immediate fetch failed, will rely on smart refresh:', fetchError);
        // Fallback to regular event without fresh data
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { 
            deliveryDate: formData.delivery_date, 
            driverId: formData.driver_id,
            triggeredBy: 'doneButtonCreates'
          }
        }));
      }
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

      // CRITICAL: Clear staged state AFTER dispatching event
      console.log('[AddToRoute] 🧹 Clearing staged deliveries from state...');
      setStagedDeliveries([]);
      setProjectedDeliveries([]);
      setHasPendingDeletes(false);
      setHasChanges(false);
      hasLoadedPending.current = false;
      predictionsStopped.current = false;
      setIsLoadingPredictions(true);
      console.log('[AddToRoute] ✅ Staged deliveries cleared');

      // CRITICAL: Resume background operations before closing form
      (async () => {
        try {
          const { smartRefreshManager } = await import('../utils/smartRefreshManager');
          const { driverLocationPoller } = await import('../utils/driverLocationPoller');
          const { routePolylineManager } = await import('../utils/routePolylineManager');
          const { fabControlEvents } = await import('../utils/fabControlEvents');
          
          smartRefreshManager.resume();
          driverLocationPoller.resume();
          routePolylineManager?.resume?.();
          fabControlEvents.resumeFAB();
          
          console.log('▶️ [AddToRoute] Resumed background operations before close');
        } catch (error) {
          console.warn('⚠️ [AddToRoute] Failed to resume managers:', error);
        }
      })();

      // Close form FIRST
      console.log('[AddToRoute] 🚪 Closing form...');
      base44.functions.invoke('cleanupStagedPickups', { driverId: formData.driver_id, deliveryDate: formData.delivery_date }).catch(()=>{}); onCancel();

      // CRITICAL: Wait for form to close, reload from offline DB, then update UI
      setTimeout(async () => {
        try {
          console.log('[AddToRoute] ⏳ Form closed - starting data reload...');
          
          // Load complete deliveries from offline DB
          const { offlineDB } = await import('../utils/offlineDatabase');
          const allDeliveriesOffline = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
          const completeDeliveries = allDeliveriesOffline.filter(d => d && d.delivery_date === formData.delivery_date);
          console.log(`✅ [AddToRoute] Loaded ${completeDeliveries.length} deliveries from offline DB`);
          
          // Dispatch UI update with complete data
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: { 
              deliveryDate: formData.delivery_date, 
              driverId: formData.driver_id,
              triggeredBy: 'doneButtonCompleteLoad',
              immediate: true,
              freshDeliveries: completeDeliveries
            }
          }));
          
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

          const { invalidate, invalidateDeliveriesForDate } = await import('../utils/dataManager');
          invalidate('Delivery');
          invalidateDeliveriesForDate(formData.delivery_date);

          // Activate FAB
          const { fabControlEvents } = await import('../utils/fabControlEvents');
          fabControlEvents.notifyDataReady();
          fabControlEvents.notifyDoneButtonClicked();
          
          console.log('[AddToRoute] ✅ UI updated with offline data, FAB activated');
        } catch (error) {
          console.error('[AddToRoute] ❌ Background reload failed:', error);
        }
      }, 300);
    } catch (err) {
      console.error('[AddToRoute] ❌ Batch save error:', err);
      setError(`Failed to save: ${err.message || 'Unknown error'}`);
      predictionsStopped.current = false; // Reset on error (form stays open, allow predictions)
      setIsLoadingPredictions(false); // Re-enable predictions on error
      
      // CRITICAL: Release batch flag on error
      setBatchFormSaving(false);
      
      // Resume SmartRefresh on error
      try {
        const { smartRefreshManager } = await import('../utils/smartRefreshManager');
        smartRefreshManager.restart();
      } catch (error) {
        console.warn('⚠️ [AddToRoute] Failed to resume SmartRefresh on error:', error);
      }
    } finally {
      setIsSaving(false);
    }
  }, [stagedDeliveries, onSave, onCancel, allDeliveries, formData.delivery_date, formData.driver_id, editingStagedId, isNewRouteWithZeroStops, stores]);

  const handleSearchKeyDown = useCallback((e) => {
    // Handle Escape key - always trigger Clear button behavior
    if (e.key === 'Escape') {
      e.preventDefault();
      // If there's form data, clear the form (like clicking Clear button)
      if (hasFormData) {
        // Inline clear form logic to avoid circular dependency
        setSelectedPatient(null);
        setSelectedPatientIds(new Set());
        setPatientSearch('');
        setError(null);
        setEditingStagedId(null);
        setFormData((prev) => ({
          ...prev, patient_id: '', patient_name: '', patient_phone: '',
          unit_number: '', delivery_instructions: '', delivery_notes: '',
          prescription_number: '', cod_total_amount_required: 0,
          cod_payments: [], cod_payment_type: 'No Payment', cod_amount: '',
          mailbox_ok: false, call_upon_arrival: false, ring_bell: false,
          dont_ring_bell: false, back_door: false, signature_needed: false, no_charge: false, store_id: '',
          recurring: false, recurring_daily: false,
          recurring_weekly_mon: false, recurring_weekly_tue: false, recurring_weekly_wed: false,
          recurring_weekly_thu: false, recurring_weekly_fri: false, recurring_weekly_sat: false,
          recurring_weekly_sun: false, recurring_biweekly: false, recurring_weekly_x4: false,
          recurring_monthly: false, recurring_bimonthly: false
        }));
        setSelectedPickupOption('');
        setTimeout(() => patientSearchInputRef.current?.focus(), 100);
      } else {
        // Just clear the search field
        setPatientSearch('');
        setHighlightedPatientIndex(-1);
      }
      return;
    }

    // Handle Enter key on empty search field - trigger Done or Add button
    if (e.key === 'Enter' && !patientSearch.trim()) {
      e.preventDefault();
      if (buttonState === 'done') {
        handleBatchSave();
      } else if (buttonState === 'add' && isFormValid) {
        handleAddToStaging();
      } else if (buttonState === 'updateStaged' && isFormValid) {
        handleUpdateStaged();
      }
      return;
    }

    // Rest of the key handling requires patientSearch to have content
    if (!patientSearch) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredPatients.length > 0) {
        setHighlightedPatientIndex((prev) => prev < filteredPatients.length - 1 ? prev + 1 : prev);
      } else if (filteredPatients.length === 0 && addPatientButtonRef.current) {
        // Focus the Add New Patient button when no results
        addPatientButtonRef.current.focus();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedPatientIndex((prev) => prev > 0 ? prev - 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();

      if (highlightedPatientIndex >= 0 && filteredPatients.length > 0) {
        const selectedPat = filteredPatients[highlightedPatientIndex];
        if (selectedPat) {
          // CRITICAL: Populate form only when pressing Enter (single selection)
          handlePatientSelect(selectedPat, false);
          setPatientSearch('');
          setHighlightedPatientIndex(-1);
        }
      } else if (filteredPatients.length === 0 && onCreatePatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver'))) {
        // Auto-click the Add New Patient button
        if (addPatientButtonRef.current) {
          addPatientButtonRef.current.click();
        } else {
          setIsPatientFormOpen(true);
          onCreatePatient((newPatient) => {
            setIsPatientFormOpen(false);
            handlePatientSelect(newPatient);
            setPatientSearch('');
          });
        }
      } else if (!hasFormData) {
        if (buttonState === 'done') handleBatchSave();else
        if (buttonState === 'updateStaged' && isFormValid) handleUpdateStaged();else
        if (buttonState === 'add' && isFormValid) handleAddToStaging();
      }
    }
  }, [patientSearch, filteredPatients, highlightedPatientIndex, handlePatientSelect, hasFormData, buttonState, isFormValid, handleBatchSave, handleUpdateStaged, handleAddToStaging, onCreatePatient, currentUser]);

  useEffect(() => {
    setHighlightedPatientIndex(-1);
  }, [filteredPatients.length]);

  useEffect(() => {
    if (highlightedPatientIndex >= 0) {
      const element = document.getElementById(`patient-item-${highlightedPatientIndex}`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [highlightedPatientIndex]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSaving) return;
    setIsSaving(true);
    setError(null);

    try {
      const dataToSave = { ...formData };

      if (dataToSave.cod_total_amount_required > 0) {
        dataToSave.cod_total_amount_required = dataToSave.cod_total_amount_required / 100;
      }

      // CRITICAL: Sync patient-specific changes to Patient entity
      if (delivery?.id && delivery?.patient_id && formData.patient_id) {
        const patientChanged = 
          delivery.patient_name !== formData.patient_name ||
          delivery.patient_phone !== formData.patient_phone ||
          delivery.unit_number !== formData.unit_number ||
          delivery.delivery_instructions !== formData.delivery_instructions ||
          delivery.mailbox_ok !== formData.mailbox_ok ||
          delivery.call_upon_arrival !== formData.call_upon_arrival ||
          delivery.ring_bell !== formData.ring_bell ||
          delivery.dont_ring_bell !== formData.dont_ring_bell ||
          delivery.back_door !== formData.back_door ||
          delivery.signature_needed !== formData.signature_needed ||
          delivery.recurring !== formData.recurring ||
          delivery.recurring_daily !== formData.recurring_daily ||
          delivery.recurring_weekly_mon !== formData.recurring_weekly_mon ||
          delivery.recurring_weekly_tue !== formData.recurring_weekly_tue ||
          delivery.recurring_weekly_wed !== formData.recurring_weekly_wed ||
          delivery.recurring_weekly_thu !== formData.recurring_weekly_thu ||
          delivery.recurring_weekly_fri !== formData.recurring_weekly_fri ||
          delivery.recurring_weekly_sat !== formData.recurring_weekly_sat ||
          delivery.recurring_weekly_sun !== formData.recurring_weekly_sun ||
          delivery.recurring_biweekly !== formData.recurring_biweekly ||
          delivery.recurring_weekly_x4 !== formData.recurring_weekly_x4 ||
          delivery.recurring_monthly !== formData.recurring_monthly ||
          delivery.recurring_bimonthly !== formData.recurring_bimonthly;

        if (patientChanged) {
          try {
            console.log('🔄 [DeliveryForm] Syncing patient-specific changes to Patient entity:', formData.patient_id);
            
            // Calculate recurring_weekly_x4_day from weekly days
            let weeklyX4Day = undefined;
            if (formData.recurring_weekly_x4) {
              if (formData.recurring_weekly_mon) weeklyX4Day = 'mon';
              else if (formData.recurring_weekly_tue) weeklyX4Day = 'tue';
              else if (formData.recurring_weekly_wed) weeklyX4Day = 'wed';
              else if (formData.recurring_weekly_thu) weeklyX4Day = 'thu';
              else if (formData.recurring_weekly_fri) weeklyX4Day = 'fri';
              else if (formData.recurring_weekly_sat) weeklyX4Day = 'sat';
              else if (formData.recurring_weekly_sun) weeklyX4Day = 'sun';
            }

            await updatePatientLocal(formData.patient_id, {
              full_name: formData.patient_name,
              phone: formData.patient_phone,
              unit_number: formData.unit_number,
              notes: formData.delivery_instructions,
              mailbox_ok: formData.mailbox_ok,
              call_upon_arrival: formData.call_upon_arrival,
              ring_bell: formData.ring_bell,
              dont_ring_bell: formData.dont_ring_bell,
              back_door: formData.back_door,
              signature_needed: formData.signature_needed,
              recurring: formData.recurring,
              recurring_daily: formData.recurring_daily,
              recurring_weekly_mon: formData.recurring_weekly_mon,
              recurring_weekly_tue: formData.recurring_weekly_tue,
              recurring_weekly_wed: formData.recurring_weekly_wed,
              recurring_weekly_thu: formData.recurring_weekly_thu,
              recurring_weekly_fri: formData.recurring_weekly_fri,
              recurring_weekly_sat: formData.recurring_weekly_sat,
              recurring_weekly_sun: formData.recurring_weekly_sun,
              recurring_biweekly: formData.recurring_biweekly,
              recurring_weekly_x4: formData.recurring_weekly_x4,
              recurring_weekly_x4_day: weeklyX4Day,
              recurring_monthly: formData.recurring_monthly,
              recurring_bimonthly: formData.recurring_bimonthly
            });
            console.log('✅ [DeliveryForm] Patient entity updated');
          } catch (error) {
            console.error('❌ [DeliveryForm] Failed to sync patient changes:', error);
          }
        }
      }

      if (delivery && isCompletionStatus && completionTime) {
        const dateStr = formData.delivery_date;
        const timeStr = completionTime;
        // CRITICAL: Store as local time string WITHOUT UTC conversion
        // Format: "YYYY-MM-DDTHH:MM:00" (no 'Z' suffix = treated as local time)
        dataToSave.actual_delivery_time = `${dateStr}T${timeStr}:00`;
        console.log('⏱️ [DeliveryForm] Saving actual_delivery_time as LOCAL:', dataToSave.actual_delivery_time);
      }

      // CRITICAL: Check if driver assignment changed
      const driverChanged = delivery && delivery.driver_id !== formData.driver_id;
      const oldDriver = driverChanged ? drivers.find((d) => d?.id === delivery.driver_id) : null;
      const newDriver = driverChanged ? drivers.find((d) => d?.id === formData.driver_id) : null;

      // CRITICAL: Check if delivery date changed
      const dateChanged = delivery && delivery.delivery_date !== formData.delivery_date;

      // CRITICAL: If date changes, keep status as in_transit and set delivery_time_start to 10:00
      if (dateChanged) {
        console.log('📅 [DeliveryForm] Date changed - keeping in_transit status and setting 10:00 AM start time');
        dataToSave.status = 'in_transit';
        dataToSave.time_window_start = '10:00';
      }

      // Check if status changed to in_transit (trigger Square COD creation)
      const statusChangedToInTransit = delivery &&
      formData.status === 'in_transit' &&
      delivery.status !== 'in_transit';

      // SQUARE INTEGRATION: Create COD item when delivery transitions to in_transit
      // Note: formData.cod_total_amount_required is in CENTS (multiplied by 100 in form)
      if (statusChangedToInTransit && delivery?.id && formData.cod_total_amount_required > 0) {
        try {
          const store = stores?.find(s => s && s.id === formData.store_id);
          const codAmountDollars = formData.cod_total_amount_required / 100;
          console.log('💳 [Square] Creating COD item for in_transit delivery:', delivery.id, 'Amount:', codAmountDollars);
          await base44.functions.invoke('squareCreateCodItem', {
            deliveryId: delivery.id,
            patientName: formData.patient_name,
            storeAbbreviation: store?.abbreviation || '',
            codAmount: codAmountDollars,
            deliveryDate: formData.delivery_date,
            storeId: formData.store_id
          });
          console.log('✅ [Square] COD item created');
        } catch (squareError) {
          console.error('⚠️ [Square] Failed to create COD item:', squareError);
        }
      }

      // Check if status changed to a completion status (completed, cancelled, failed)
      const statusChangedToCompletion = delivery &&
      ['completed', 'cancelled', 'failed', 'returned'].includes(formData.status) &&
      delivery.status !== formData.status;

      // SQUARE INTEGRATION: Delete COD item when delivery is completed or failed
      if (statusChangedToCompletion && delivery?.id && (formData.status === 'completed' || formData.status === 'failed')) {
        try {
          console.log('💳 [Square] Deleting COD item for completed/failed delivery:', delivery.id);
          await base44.functions.invoke('squareDeleteCodItem', {
            deliveryId: delivery.id,
            reason: formData.status
          });
          console.log('✅ [Square] COD item deleted');
        } catch (squareError) {
          console.warn('⚠️ [Square] Failed to delete COD item:', squareError.message);
          // Don't block the delivery update if Square fails
        }
      }

      // SQUARE INTEGRATION: Delete COD item if COD was removed (checkbox unchecked)
      const codWasRemoved = delivery?.cod_total_amount_required > 0 && 
        (formData.cod_total_amount_required === 0 || !formData.cod_total_amount_required);
      
      if (codWasRemoved && delivery?.id) {
        try {
          console.log('💳 [Square] Deleting COD item - COD was removed from delivery:', delivery.id);
          
          // CRITICAL: Clear cod_payments array when COD is removed
          dataToSave.cod_payments = [];
          dataToSave.cod_payment_type = 'No Payment';
          dataToSave.cod_amount = '';
          
          await base44.functions.invoke('squareDeleteCodItem', {
            deliveryId: delivery.id,
            reason: 'cod_removed'
          });
          console.log('✅ [Square] COD item deleted (COD removed)');
        } catch (squareError) {
          console.warn('⚠️ [Square] Failed to delete COD item:', squareError.message);
        }
      }

      // CRITICAL: Save to both offline and online databases using local-first approach
      // offlineMutations handles: pausing smart refresh, saving to offline DB, syncing to backend, restarting smart refresh
      if (delivery?.id) {
        console.log('📝 [DeliveryForm] Updating delivery via local-first mutation...');
        console.log('📝 [DeliveryForm] Fields to save:', {
          tracking_number: dataToSave.tracking_number,
          stop_id: dataToSave.stop_id,
          puid: dataToSave.puid,
          paid_km_override: dataToSave.paid_km_override,
          actual_delivery_time: dataToSave.actual_delivery_time,
          status: dataToSave.status,
          driver_id: formData.driver_id,
          delivery_date: formData.delivery_date
        });
        
        const updatedDelivery = await updateDeliveryLocal(delivery.id, dataToSave);
        console.log('✅ [DeliveryForm] Delivery updated - UI should update immediately via mutation notification'); if ((formData.status==='completed'||formData.status==='failed')&&formData.patient_id){ try{ const __todayLocal=format(new Date(),'yyyy-MM-dd'); updatePatientLocal(formData.patient_id,{ last_delivery_date: __todayLocal }); console.log('🗓️ [DeliveryForm] Updated patient last_delivery_date to',__todayLocal);}catch(e){} }
        
        // CRITICAL: Force stats refresh AND deliveries update after any delivery update
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { 
            deliveryId: delivery.id,
            deliveryDate: formData.delivery_date, 
            driverId: formData.driver_id,
            triggeredBy: 'deliveryFormUpdate'
          }
        }));
        console.log('✅ [DeliveryForm] Triggered stats and deliveries refresh');
        
        // NOTE: updateDeliveryLocal already notifies mutation listeners immediately after local save
        // The Layout component subscribes to these mutations and updates state instantly
      } else {
        await onSave(dataToSave);
      }

      // Send message if driver changed (from active driver to new driver)
      if (driverChanged && oldDriver && newDriver && currentUser && userHasRole(currentUser, 'driver')) {
        const patientName = delivery.patient_name || selectedPatient?.full_name || 'Unknown';
        const messageContent = `🚚 ${getDriverDisplayName(oldDriver)} reassigned a Delivery to you:\n• ${patientName}\n• ${format(new Date(formData.delivery_date), 'MMM d, yyyy')}`;

        await sendDeliveryMessage({
          senderId: currentUser.id,
          senderName: getDriverDisplayName(currentUser),
          receiverId: newDriver.id,
          receiverName: getDriverDisplayName(newDriver),
          content: messageContent
        });
        console.log('✉️ [DeliveryForm] Sent driver reassignment message');
      }



      // AUTO BACK ON DUTY: If driver is on_break and completes their next stop, auto set to on_duty
      if (statusChangedToCompletion && delivery && formData.status === 'completed') {
        try {
          // Check if this was the isNextDelivery stop
          if (delivery.isNextDelivery) {
            // Get driver's AppUser to check status
            const appUsers = await base44.entities.AppUser.filter({ user_id: formData.driver_id });
            const driverAppUser = appUsers?.[0];
            
            if (driverAppUser && driverAppUser.driver_status === 'on_break') {
              console.log('🔄 [DeliveryForm] Auto setting driver back to on_duty (completed next stop while on break)');
              await base44.entities.AppUser.update(driverAppUser.id, {
                driver_status: 'on_duty'
              });
              console.log('✅ [DeliveryForm] Driver auto-set to on_duty');
            }
          }
        } catch (error) {
          console.error('❌ [DeliveryForm] Auto back-on-duty failed:', error);
        }
      }

      // CRITICAL: Resort completed/failed/cancelled deliveries and update stop order after status change
      if (delivery && formData.driver_id && formData.delivery_date && statusChangedToCompletion) {
        console.log('🔄 [DeliveryForm] Resorting completed/failed/cancelled deliveries...');
        try {
          const { base44 } = await import('@/api/base44Client');
          
          // Get all deliveries for this driver/date
          const driverDeliveries = allDeliveries.filter(d => 
            d && d.driver_id === formData.driver_id && d.delivery_date === formData.delivery_date
          );
          
          // Get completed/failed/cancelled deliveries (including the one just updated)
          const completedDeliveries = driverDeliveries.filter(d => 
            ['completed', 'failed', 'cancelled'].includes(d.id === delivery.id ? formData.status : d.status)
          );
          
          // Sort by actual_delivery_time (earliest first)
          completedDeliveries.sort((a, b) => {
            const timeA = a.id === delivery.id && dataToSave.actual_delivery_time 
              ? new Date(dataToSave.actual_delivery_time).getTime()
              : a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : 0;
            const timeB = b.id === delivery.id && dataToSave.actual_delivery_time 
              ? new Date(dataToSave.actual_delivery_time).getTime()
              : b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : 0;
            return timeA - timeB;
          });
          
          // Update stop_order for all completed/failed/cancelled deliveries
          let stopOrder = 1;
          const updatePromises = completedDeliveries.map(d => {
            const newStopOrder = stopOrder++;
            if (d.stop_order !== newStopOrder) {
              console.log(`📝 [DeliveryForm] Updating stop_order for ${d.patient_name}: ${d.stop_order} → ${newStopOrder}`);
              return base44.entities.Delivery.update(d.id, { stop_order: newStopOrder });
            }
            return Promise.resolve();
          });
          
          await Promise.all(updatePromises);
          console.log('✅ [DeliveryForm] Completed deliveries resorted and stop orders updated');
        } catch (error) {
          console.error('❌ [DeliveryForm] Resort failed:', error);
        }
      }
      
      // CRITICAL: Update ETAs for all incomplete stops if delivery time windows changed
      const timeWindowChanged = delivery && (
        delivery.time_window_start !== formData.time_window_start ||
        delivery.time_window_end !== formData.time_window_end
      );
      
      if (timeWindowChanged && formData.driver_id && formData.delivery_date) {
        console.log('⏱️ [DeliveryForm] Time windows changed - updating ETAs for all incomplete stops...');
        try {
          const incompleteStatuses = ['pending', 'in_transit', 'en_route'];
          const incompleteDeliveries = allDeliveries.filter(d =>
            d && 
            d.driver_id === formData.driver_id &&
            d.delivery_date === formData.delivery_date &&
            incompleteStatuses.includes(d.status)
          );
          
          if (incompleteDeliveries.length > 0) {
            const response = await base44.functions.invoke('calculateRealTimeETA', {
              driverId: formData.driver_id,
              deliveryDate: formData.delivery_date
            });
            console.log(`✅ [DeliveryForm] ETAs updated for ${incompleteDeliveries.length} incomplete stops`);
          }
        } catch (error) {
          console.error('❌ [DeliveryForm] ETA update failed:', error);
        }
      }

      // CRITICAL: Always reorder stops after any delivery update or status change
      if (delivery && formData.driver_id && formData.delivery_date) {
        console.log('🔄 [DeliveryForm] Reordering stops after delivery update...');
        try {
          await reorderStops(formData.driver_id, formData.delivery_date, allDeliveries);
          console.log('✅ [DeliveryForm] Stop reordering complete');
        } catch (error) {
          console.error('❌ [DeliveryForm] Stop reordering failed:', error);
        }
      }

      // CRITICAL: Trigger patient update function when delivery is completed
      if (statusChangedToCompletion && delivery && formData.status === 'completed') {
        console.log('🔄 [DeliveryForm] Triggering patient update after route completion...');
        try {
          await base44.functions.invoke('updatePatientsAfterRouteCompletion', {
            deliveryDate: formData.delivery_date,
            driverId: formData.driver_id
          });
          console.log('✅ [DeliveryForm] Patient update complete');
        } catch (error) {
          console.error('❌ [DeliveryForm] Patient update failed:', error);
        }
      }

      if (isPickupMode && delivery && formData.status === 'completed' && formData.store_id && formData.ampm_deliveries) {
        const relatedDeliveries = allDeliveries.filter((d) =>
        d &&
        d.id !== delivery.id &&
        d.delivery_date === formData.delivery_date &&
        d.store_id === formData.store_id &&
        d.ampm_deliveries === formData.ampm_deliveries &&
        d.status === 'pending' &&
        d.patient_id
        );

        if (relatedDeliveries.length > 0) {
          console.log(`🔄 [DeliveryForm] Transitioning ${relatedDeliveries.length} pending deliveries to in_transit...`);
          
          // CRITICAL: Update all pending deliveries in parallel and WAIT for all to complete
          const updatePromises = relatedDeliveries.map(relatedDelivery =>
            updateDeliveryLocal(relatedDelivery.id, { status: 'in_transit' })
              .catch(err => console.error(`Failed to update ${relatedDelivery.patient_name}:`, err))
          );
          await Promise.all(updatePromises);
          
          console.log(`✅ [DeliveryForm] All ${relatedDeliveries.length} deliveries transitioned to in_transit`);
          
          // CRITICAL: Wait 500ms for route optimization to complete and isNextDelivery to be set
          console.log('⏳ [DeliveryForm] Waiting for route optimization to complete...');
          await new Promise(resolve => setTimeout(resolve, 500));
          console.log('✅ [DeliveryForm] Route optimization complete');
        }
      }

      // CRITICAL: Resume background operations AFTER closing form
      // CRITICAL: Always close form after successful update
      base44.functions.invoke('cleanupStagedPickups', { driverId: formData.driver_id, deliveryDate: formData.delivery_date }).catch(()=>{}); onCancel();
      // Resume managers immediately (non-blocking)
      setTimeout(async () => {
        try {
          const { smartRefreshManager } = await import('../utils/smartRefreshManager');
          const { driverLocationPoller } = await import('../utils/driverLocationPoller');
          const { routePolylineManager } = await import('../utils/routePolylineManager');
          const { fabControlEvents } = await import('../utils/fabControlEvents');
          
          smartRefreshManager.resume();
          driverLocationPoller.resume();
          routePolylineManager?.resume?.();
          fabControlEvents.resumeFAB();
          
          console.log('▶️ [DeliveryForm] Resumed background operations');
        } catch (error) {
          console.warn('⚠️ [DeliveryForm] Failed to resume managers:', error);
        }
      }, 0);
    } catch (error) {
      setError(error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearForm = useCallback(() => {
    (async()=>{try{const c=stagedDeliveries.filter(d=>!d.patient_id&&d._autoCreated);for(const p of c){const attached=stagedDeliveries.some(sd=>sd.patient_id&&sd.puid===p.stop_id);if(!attached&&p.id){await deleteDeliveryLocal(p.id);autoCreatedPickupsRef.current.delete(p.id);}}setStagedDeliveries(prev=>{const hasAttached=(sid)=>prev.some(sd=>sd.patient_id&&sd.puid===sid);return prev.filter(d=>!( !d.patient_id && d._autoCreated && !hasAttached(d.stop_id) ));});}catch(e){}})();
    setSelectedPatient(null);
    setSelectedPatientIds(new Set());
    setPatientSearch('');
    setError(null);
    setEditingStagedId(null);
    setNewPatientMode(null);
    setFormData((prev) => ({
      ...prev, patient_id: '', patient_name: '', patient_phone: '',
      unit_number: '', delivery_instructions: '', delivery_notes: '',
      prescription_number: '', cod_total_amount_required: 0,
      cod_payments: [], cod_payment_type: 'No Payment', cod_amount: '',
      mailbox_ok: false, call_upon_arrival: false, ring_bell: false,
      dont_ring_bell: false, back_door: false, signature_needed: false, no_charge: false, store_id: '',
      recurring: false, recurring_daily: false,
      recurring_weekly_mon: false, recurring_weekly_tue: false, recurring_weekly_wed: false,
      recurring_weekly_thu: false, recurring_weekly_fri: false, recurring_weekly_sat: false,
      recurring_weekly_sun: false, recurring_biweekly: false, recurring_weekly_x4: false,
      recurring_monthly: false, recurring_bimonthly: false
    }));
    setSelectedPickupOption('');
    // Only auto-focus on desktop
    if (!isMobileDevice) {
      setTimeout(() => patientSearchInputRef.current?.focus(), 100);
    }
  }, [isMobileDevice]);

  const handleCancelClick = useCallback(() => {
    // Only show confirmation if there are NEW staged deliveries (without an id)
    const hasNewStagedDeliveries = stagedDeliveries.some((d) => !d.id);

    if (hasNewStagedDeliveries && !delivery) {
      const confirmed = window.confirm('You have unsaved deliveries. Discard them?');
      if (confirmed) {
        (async()=>{try{const c=stagedDeliveries.filter(d=>!d.patient_id&&d._autoCreated);for(const p of c){const attached=stagedDeliveries.some(sd=>sd.patient_id&&sd.puid===p.stop_id);if(!attached&&p.id){await deleteDeliveryLocal(p.id);autoCreatedPickupsRef.current.delete(p.id);}}}catch(e){}})();
        setStagedDeliveries([]);
        setProjectedDeliveries([]);
        hasLoadedPending.current = false; // Reset flag to allow reload
        
        // CRITICAL: Resume background operations before closing
        (async () => {
          try {
            const { smartRefreshManager } = await import('../utils/smartRefreshManager');
            const { driverLocationPoller } = await import('../utils/driverLocationPoller');
            const { routePolylineManager } = await import('../utils/routePolylineManager');
            const { fabControlEvents } = await import('../utils/fabControlEvents');
            
            smartRefreshManager.resume();
            driverLocationPoller.resume();
            routePolylineManager?.resume?.();
            fabControlEvents.resumeFAB();
            
            console.log('▶️ [DeliveryForm Cancel] Resumed background operations');
          } catch (error) {
            console.warn('⚠️ [DeliveryForm] Failed to resume managers:', error);
          }
        })();
        (async()=>{try{const c=stagedDeliveries.filter(d=>!d.patient_id&&d._autoCreated);for(const p of c){const attached=stagedDeliveries.some(sd=>sd.patient_id&&sd.puid===p.stop_id);if(!attached&&p.id){await deleteDeliveryLocal(p.id);autoCreatedPickupsRef.current.delete(p.id);}}setStagedDeliveries(prev=>{const hasAttached=(sid)=>prev.some(sd=>sd.patient_id&&sd.puid===sid);return prev.filter(d=>!( !d.patient_id && d._autoCreated && !hasAttached(d.stop_id) ));});}catch(e){}})();
        
        base44.functions.invoke('cleanupStagedPickups', { driverId: formData.driver_id, deliveryDate: formData.delivery_date }).catch(()=>{}); onCancel();
      }
    } else {
      // CRITICAL: Reset the auto-load flag when canceling without changes
      // This allows the form to re-load pending deliveries next time
      if (!delivery) {
        hasLoadedPending.current = false;
      }
      
      // CRITICAL: Resume background operations before closing
      (async () => {
        try {
          const { smartRefreshManager } = await import('../utils/smartRefreshManager');
          const { driverLocationPoller } = await import('../utils/driverLocationPoller');
          const { routePolylineManager } = await import('../utils/routePolylineManager');
          const { fabControlEvents } = await import('../utils/fabControlEvents');
          
          smartRefreshManager.resume();
          driverLocationPoller.resume();
          routePolylineManager?.resume?.();
          fabControlEvents.resumeFAB();
          
          console.log('▶️ [DeliveryForm Cancel] Resumed background operations');
        } catch (error) {
          console.warn('⚠️ [DeliveryForm] Failed to resume managers:', error);
        }
      })();
      
      base44.functions.invoke('cleanupStagedPickups', { driverId: formData.driver_id, deliveryDate: formData.delivery_date }).catch(()=>{}); onCancel();
    }
  }, [stagedDeliveries, onCancel, delivery]);

  useEffect(() => {
    const handleEnterKey = (event) => {
      if (event.key !== 'Enter') return;
      // CRITICAL: Don't handle Enter if PatientForm is open
      if (isPatientFormOpen) return;
      if (event.target.tagName === 'TEXTAREA') return;
      if (event.target.getAttribute('role') === 'combobox') return;
      if (event.target === patientSearchInputRef.current) return;
      // CRITICAL: Don't prevent Enter on buttons - let them execute their onClick handlers
      if (event.target.tagName === 'BUTTON') return;

      event.preventDefault();

      // If editing an existing delivery, trigger submit (Update Delivery button)
      if (delivery && isFormValid && !isSaving) {
        handleSubmit(event);
        return;
      }

      // New delivery flow
      if (buttonState === 'done') handleBatchSave();else
      if (buttonState === 'updateStaged' && isFormValid) handleUpdateStaged();else
      if (buttonState === 'add' && isFormValid) handleAddToStaging();
    };

    document.addEventListener('keydown', handleEnterKey);
    return () => document.removeEventListener('keydown', handleEnterKey);
  }, [buttonState, isFormValid, handleAddToStaging, handleUpdateStaged, handleBatchSave, delivery, isSaving, handleSubmit, isPatientFormOpen]);

  useEffect(() => {
    const handleEscapeKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Always trigger cancel on Escape (closes form or clears based on state)
        if (showCameraOverlay) {// If camera overlay is open, close it first
          stopCamera();
          setShowCameraOverlay(false);
          setIsScanning(false);
        } else {
          handleCancelClick();
        }
      }
    };

    document.addEventListener('keydown', handleEscapeKey);
    return () => document.removeEventListener('keydown', handleEscapeKey);
  }, [handleCancelClick, showCameraOverlay, stopCamera]);

  useEffect(() => {
    if (!delivery && !isMobileDevice) {
      setTimeout(() => patientSearchInputRef.current?.focus(), 100);
    }
  }, [delivery, isMobileDevice]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        setIsMultiSelectMode(true);
      }
    };

    const handleKeyUp = (e) => {
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
        setIsMultiSelectMode(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  useEffect(() => {
    console.log('📝 [DeliveryForm] Setting isFormOverlayOpen = true');
    setIsFormOverlayOpen(true);
    
    // CRITICAL: Keep location tracking active but pause UI updates
    // Location updates will continue, but Dashboard won't refresh until form closes
    (async () => {
      try {
        // Keep smart refresh active - form data needs to stay fresh while editing
        // The staged deliveries are local-only and won't be affected
        const { smartRefreshManager } = await import('../utils/smartRefreshManager');
        // Don't pause smart refresh - let it continue updating form data
        
        // Keep driver location poller ACTIVE - location tracking continues
        // const { driverLocationPoller } = await import('../utils/driverLocationPoller');
        // driverLocationPoller.pause(); // REMOVED - location tracking continues
        
        // Pause polyline manager
        const { routePolylineManager } = await import('../utils/routePolylineManager');
        routePolylineManager?.pause?.();
        
        // Pause FAB
        const { fabControlEvents } = await import('../utils/fabControlEvents');
        fabControlEvents.pauseFAB();
        
        console.log('⏸️ [DeliveryForm] Paused: Polylines, FAB (Location tracking + SmartRefresh continue)');
      } catch (error) {
        console.warn('⚠️ [DeliveryForm] Failed to pause some managers:', error);
      }
    })();
    
    return () => {
      console.log('📝 [DeliveryForm] Cleanup - setting isFormOverlayOpen = false');
      setIsFormOverlayOpen(false);
      
      // CRITICAL: Reset delivery ID ref to allow fresh load next time
      loadedDeliveryIdRef.current = null;
      
      // CRITICAL: Resume all background operations and trigger Dashboard UI refresh
      (async () => {
        try {
          // Resume smart refresh
          const { smartRefreshManager } = await import('../utils/smartRefreshManager');
          smartRefreshManager.resume();
          
          // Location poller is already running, no need to resume
          
          // Resume polyline manager
          const { routePolylineManager } = await import('../utils/routePolylineManager');
          routePolylineManager?.resume?.();
          
          // Resume FAB
          const { fabControlEvents } = await import('../utils/fabControlEvents');
          fabControlEvents.resumeFAB();
          
          // CRITICAL: Trigger immediate Dashboard UI refresh with current data
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: null }
          }));
          
          console.log('▶️ [DeliveryForm] Resumed: SmartRefresh, Polylines, FAB + Dashboard UI refreshed');
        } catch (error) {
          console.warn('⚠️ [DeliveryForm] Failed to resume some managers:', error);
        }
      })();
    };
  }, [setIsFormOverlayOpen]);

  const handleRecurringChange = useCallback((checked) => {
    if (!checked) {
      setFormData((prev) => ({
        ...prev,
        recurring: false,
        recurring_daily: false,
        recurring_biweekly: false,
        recurring_weekly_x4: false,
        recurring_monthly: false,
        recurring_bimonthly: false,
        recurring_weekly_mon: false,
        recurring_weekly_tue: false,
        recurring_weekly_wed: false,
        recurring_weekly_thu: false,
        recurring_weekly_fri: false,
        recurring_weekly_sat: false,
        recurring_weekly_sun: false
      }));
      setShowDayPopup(false);
    } else {
      setFormData((prev) => ({ ...prev, recurring: true }));
    }
  }, []);

  const handleFrequencyChange = useCallback((newFrequency) => {
    if (newFrequency === 'weekly' || newFrequency === 'bi-weekly' || newFrequency === 'weekly-x4') {
      setActiveRecurringType(newFrequency);
      setShowDayPopup(true);
    } else {
      setShowDayPopup(false);
      setActiveRecurringType(null);
    }

    setFormData((prev) => {
      const newState = {
        ...prev,
        recurring_daily: newFrequency === 'daily',
        recurring_biweekly: newFrequency === 'bi-weekly',
        recurring_weekly_x4: newFrequency === 'weekly-x4',
        recurring_monthly: newFrequency === 'monthly',
        recurring_bimonthly: newFrequency === 'bi-monthly'
      };

      if (newFrequency !== 'weekly' && newFrequency !== 'bi-weekly' && newFrequency !== 'weekly-x4') {
        newState.recurring_weekly_mon = false;
        newState.recurring_weekly_tue = false;
        newState.recurring_weekly_wed = false;
        newState.recurring_weekly_thu = false;
        newState.recurring_weekly_fri = false;
        newState.recurring_weekly_sat = false;
        newState.recurring_weekly_sun = false;
      }

      if (newFrequency) {
        newState.recurring = true;
      }

      return newState;
    });
  }, []);

  const handleWeeklyDaysDone = useCallback(() => {
    setShowDayPopup(false);
    setActiveRecurringType(null);

    setFormData((prev) => {
      const anyDaySelected = prev.recurring_weekly_mon || prev.recurring_weekly_tue || prev.recurring_weekly_wed ||
      prev.recurring_weekly_thu || prev.recurring_weekly_fri || prev.recurring_weekly_sat ||
      prev.recurring_weekly_sun;

      const newRecurringState = anyDaySelected || prev.recurring_daily || prev.recurring_biweekly ||
      prev.recurring_weekly_x4 || prev.recurring_monthly || prev.recurring_bimonthly;

      return { ...prev, recurring: newRecurringState };
    });
  }, []);

  // CRITICAL: Check if driver has any existing stops for the selected date
  // Sets isNewRouteWithZeroStops flag
  useEffect(() => {
    if (delivery || !allDeliveries || !formData.driver_id || !formData.delivery_date) {
      return;
    }

    // Check if driver has ANY existing Pending/En Route/In Transit deliveries for this date
    const existingActiveStops = allDeliveries.filter((d) =>
      d &&
      d.patient_id && // Only count patient deliveries, not pickups
      d.driver_id === formData.driver_id &&
      d.delivery_date === formData.delivery_date &&
      ['pending', 'en_route', 'in_transit'].includes(d.status)
    );

    const hasExistingStops = existingActiveStops.length > 0;
    setIsNewRouteWithZeroStops(!hasExistingStops);
    
    console.log(`🚦 [DeliveryForm] Route flag check for driver ${formData.driver_id} on ${formData.delivery_date}:`, {
      existingActiveStops: existingActiveStops.length,
      isNewRouteWithZeroStops: !hasExistingStops
    });
  }, [delivery, allDeliveries, formData.driver_id, formData.delivery_date]);

  // Update flag when first patient is added to staged
  useEffect(() => {
    if (delivery || stagedDeliveries.length === 0) return;
    
    // If we're adding the first patient and flag is currently true, set it to false
    if (isNewRouteWithZeroStops && stagedDeliveries.some(s => s.patient_id)) {
      console.log('🚦 [DeliveryForm] First patient added - setting isNewRouteWithZeroStops to false');
      setIsNewRouteWithZeroStops(false);
    }
  }, [delivery, stagedDeliveries.length, isNewRouteWithZeroStops]);

  // Monitor for deleted pending deliveries on other devices
  useEffect(() => {
    if (delivery || stagedDeliveries.length === 0) return;

    // Find any staged deliveries that have an ID (pending) but are no longer in allDeliveries
    const deletedPendingDeliveries = stagedDeliveries.filter((staged) => {
      if (!staged.id) return false; // Skip new staged items
      return !allDeliveries?.some((d) => d && d.id === staged.id);
    });

    if (deletedPendingDeliveries.length > 0) {
      console.log('🗑️ [DeliveryForm] Detected deleted pending deliveries on other devices:', deletedPendingDeliveries.map((d) => d.patient_name));

      // Remove deleted pending deliveries from staged list
      setStagedDeliveries((prev) => prev.filter((staged) => !deletedPendingDeliveries.some((del) => del.id === staged.id)));

      // Update projected deliveries - restore deleted patient IDs
      const remainingStagedIds = new Set(
        stagedDeliveries
          .filter((staged) => !deletedPendingDeliveries.some((del) => del.id === staged.id))
          .map((d) => d.patient_id)
          .filter(Boolean)
      );
      const filteredPredictions = fullPredictionListRef.current.filter((pred) => !remainingStagedIds.has(pred.patient_id));
      setProjectedDeliveries(filteredPredictions);

      // If editing one of the deleted deliveries, clear the form
      if (editingStagedId && deletedPendingDeliveries.some((d) => d._tempId === editingStagedId)) {
        console.log('📝 [DeliveryForm] Clearing form - edited pending delivery was deleted');
        setEditingStagedId(null);
        handleClearForm();
      }
    }
  }, [allDeliveries, stagedDeliveries.length, delivery]);

  // Auto-load pending deliveries on form mount - ONLY ONCE
  useEffect(() => {
    // Skip if editing existing delivery
    if (delivery) {
      console.log('⏸️ [DeliveryForm] Skipping auto-load - editing existing delivery');
      return;
    }

    // Skip if already loaded
    if (hasLoadedPending.current) {
      console.log('⏸️ [DeliveryForm] Skipping auto-load - already loaded');
      return;
    }

    // Wait for all required data (driver_id NOT required)
    if (!allDeliveries || !suggestedDate || !currentUser || !patients || !stores) {
      console.log('⏸️ [DeliveryForm] Waiting for data...', {
        hasDeliveries: !!allDeliveries,
        hasDate: !!suggestedDate,
        hasUser: !!currentUser,
        hasPatients: !!patients,
        hasStores: !!stores
      });
      return;
    }

    console.log('🔄 [DeliveryForm] Auto-loading pending deliveries based on role...');
    console.log('  - Date:', suggestedDate);
    console.log('  - Total deliveries:', allDeliveries.length);
    console.log('  - Current user:', currentUser.user_name || currentUser.full_name);
    console.log('  - Current user roles:', currentUser.app_roles);
    console.log('  - Current user store_ids:', currentUser.store_ids);

    // Filter pending deliveries based on user role
    let pendingDeliveries = allDeliveries.filter((d) =>
    d &&
    d.status === 'pending' &&
    d.delivery_date === suggestedDate &&
    d.patient_id // Only patient deliveries, not pickups
    );

    console.log('  - Found pending deliveries for date (before role filter):', pendingDeliveries.length);
    if (pendingDeliveries.length > 0) {
      console.log('  - Pending deliveries:', pendingDeliveries.map((d) => ({
        patient_name: d.patient_name,
        driver_id: d.driver_id,
        store_id: d.store_id
      })));
    }

    // Role-based filtering - ADMIN takes priority over other roles
    if (userHasRole(currentUser, 'admin')) {
      // Admins: all pending stops (no additional filtering)
      console.log(`  - Admin mode: ${pendingDeliveries.length} pending stops (no filtering)`);
    } else if (userHasRole(currentUser, 'dispatcher')) {
      // Dispatchers: only pending stops for their stores
      const dispatcherStoreIds = currentUser.store_ids || [];
      console.log(`  - Dispatcher mode: checking stores ${dispatcherStoreIds.join(', ')}`);
      pendingDeliveries = pendingDeliveries.filter((d) => dispatcherStoreIds.includes(d.store_id));
      console.log(`  - Dispatcher mode: filtered to ${pendingDeliveries.length} pending stops for dispatcher stores`);
      if (pendingDeliveries.length > 0) {
        console.log('  - Dispatcher pending deliveries:', pendingDeliveries.map((d) => ({
          patient_name: d.patient_name,
          store_id: d.store_id
        })));
      }
    } else if (userHasRole(currentUser, 'driver')) {
      // Drivers (not admin/dispatcher): only their pending stops
      pendingDeliveries = pendingDeliveries.filter((d) => d.driver_id === currentUser.id);
      console.log(`  - Driver mode: filtered to ${pendingDeliveries.length} pending stops for driver ${currentUser.id}`);
    }

    if (pendingDeliveries.length === 0) {
      console.log('  - No pending deliveries to load after role filtering');
      hasLoadedPending.current = true;
      return;
    }

    console.log('✅ [DeliveryForm] Found pending deliveries to auto-load:', pendingDeliveries.length);

    // Convert pending deliveries to staged format
    const newStagedItems = pendingDeliveries.map((delivery, index) => {
    const patient = patients.find((p) => p && p.id === delivery.patient_id);
    
    // CRITICAL: Find correct store via PUID first, fallback to delivery.store_id
    let finalStoreId = delivery.store_id;
    let timeSlot = delivery.ampm_deliveries;
    let puid = delivery.puid || '';
    
    if (puid) {
      // Find the parent pickup by PUID (stop_id)
      const parentPickup = allDeliveries.find((d) => d && !d.patient_id && d.stop_id === puid);
      if (parentPickup) {
        finalStoreId = parentPickup.store_id || delivery.store_id;
        timeSlot = parentPickup.ampm_deliveries || delivery.ampm_deliveries;
        console.log(`📦 [AutoLoad] Delivery ${delivery.patient_name}: PUID=${puid} → store=${finalStoreId}, AM/PM=${timeSlot}`);
      }
    }
    
    const store = stores.find((s) => s && s.id === finalStoreId);

    if (!patient || !store) return null;

    // Use existing distance_from_store if available, otherwise calculate
    let distanceFromStore = patient.distance_from_store;
    if (distanceFromStore === null || distanceFromStore === undefined) {
      if (patient?.latitude && patient?.longitude && store?.latitude && store?.longitude) {
        distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
      }
    }

      // Fallback: calculate if no PUID or no parent pickup found
      if (!timeSlot) {
        timeSlot = getStoreAssignedTimeSlot(store, delivery.delivery_date, allDeliveries);
        puid = getPickupStopIdForDelivery(store.id, delivery.delivery_date, timeSlot, allDeliveries);
      }

      return {
        ...delivery,
        _tempId: Date.now() + Math.random() + index,
        _wasEdited: false, // Track if user explicitly edited this pending item
        patient_name: delivery.patient_name || patient?.full_name || 'Unknown',
        store_id: finalStoreId,
        store_name: store?.name || 'Unknown Store',
        store_abbreviation: store?.abbreviation || '',
        distanceFromStore: distanceFromStore,
        delivery_address: patient?.address || '',
        cod_total_amount_required: delivery.cod_total_amount_required || 0,
        cod_payments: delivery.cod_payments || [],
        ampm_deliveries: timeSlot,
        puid: puid || '',
        paid_km_override: delivery.paid_km_override ?? distanceFromStore ?? null
      };
    }).filter(Boolean); // Filter out nulls if patient/store not found

    // Force state update with timeout to ensure re-render
    setTimeout(() => {
      console.log('💾 [DeliveryForm] Setting staged deliveries state with', newStagedItems.length, 'items');
      console.log('💾 [DeliveryForm] Items:', newStagedItems.map((item) => ({
        patient_name: item.patient_name,
        _tempId: item._tempId,
        id: item.id
      })));
      setStagedDeliveries(newStagedItems);
      setHasChanges(false); // Done button stays disabled until user adds/edits something
      hasLoadedPending.current = true;
      console.log(`✅ [DeliveryForm] Auto-loaded ${newStagedItems.length} pending deliveries to staged list`);
    }, 100);
  }, [delivery, allDeliveries, currentUser, patients, stores, suggestedDate]);

  // CRITICAL: Track initial PUID from delivery to prevent overwrites
  const initialPuidRef = useRef(null);
  
  useEffect(() => {
    if (delivery && delivery.puid) {
      initialPuidRef.current = delivery.puid;
    }
  }, [delivery?.id]); // Only set once when delivery loads

  useEffect(() => {
    // CRITICAL: Never auto-update PUID for existing deliveries with a PUID already set
    // This prevents the blinking issue where PUID gets recalculated and overwrites the correct value
    if (delivery && initialPuidRef.current) {
      console.log('⏸️ [DeliveryForm] Preserving original PUID:', initialPuidRef.current);
      return; // Skip PUID recalculation entirely for deliveries with existing PUID
    }
    
    // Auto-update PUID only for NEW deliveries or deliveries that never had a PUID
    if (delivery && !isPickupMode && formData.store_id && formData.delivery_date && allDeliveries && stores && !initialPuidRef.current) {
      const store = stores.find((s) => s && s.id === formData.store_id);
      if (store) {
        const timeSlot = getStoreAssignedTimeSlot(store, formData.delivery_date, allDeliveries);
        const newPuid = getPickupStopIdForDelivery(store.id, formData.delivery_date, timeSlot, allDeliveries);

        if (newPuid !== formData.puid) {
          setFormData((prev) => ({ ...prev, puid: newPuid || '' }));
        }
      }
    }
  }, [formData.store_id, delivery, isPickupMode, formData.delivery_date, stores, allDeliveries]);

  const confirmAddProjectedToStaged = useCallback(async (projected) => {
    const store = stores.find((s) => s && s.id === projected.store_id);
    if (!store) {
      console.error('Store not found for projected delivery:', projected.store_id);
      return;
    }

    const patient = patients.find((p) => p && p.id === projected.patient_id);
    if (!patient) {
      console.error('Patient not found for projected delivery:', projected.patient_id);
      return;
    }

    // Use existing distance_from_store if available, otherwise calculate
    let distanceFromStore = patient.distance_from_store;
    if (distanceFromStore === null || distanceFromStore === undefined) {
      if (patient.latitude && patient.longitude && store.latitude && store.longitude) {
        distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
      }
    }

    // Auto-select driver based on patient's store and time window
    let autoSelectedDriverId = '';
    let autoSelectedDriverName = '';

    const deliveryDate = formData.delivery_date ? new Date(formData.delivery_date + 'T00:00:00') : new Date();
    const dayOfWeek = deliveryDate.getDay();

    const deliveryAMPM = determineDeliveryAMPM(patient);

    let amDriverIdField = '';
    let pmDriverIdField = '';
    if (dayOfWeek === 6) {
      amDriverIdField = 'saturday_am_driver_id';
      pmDriverIdField = 'saturday_pm_driver_id';
    } else if (dayOfWeek === 0) {
      amDriverIdField = 'sunday_am_driver_id';
      pmDriverIdField = 'sunday_pm_driver_id';
    } else {
      amDriverIdField = 'weekday_am_driver_id';
      pmDriverIdField = 'weekday_pm_driver_id';
    }

    const preferredDriverIdField = deliveryAMPM === 'PM' ? pmDriverIdField : amDriverIdField;
    const fallbackDriverIdField = deliveryAMPM === 'PM' ? amDriverIdField : pmDriverIdField;

    let driverId = store[preferredDriverIdField];
    if (!driverId) {
      driverId = store[fallbackDriverIdField];
    }

    if (driverId) {
      const driver = drivers.find((d) => d && d.id === driverId);
      if (driver) {
        autoSelectedDriverId = driverId;
        autoSelectedDriverName = getDriverNameForStorage(driver);
      }
    }

    // Check for existing pickup for this store/driver/date
    let puid = null;
    const timeSlot = formData.ampm_deliveries || getStoreAssignedTimeSlot(store, formData.delivery_date, allDeliveries);
    const autoDriverId = autoSelectedDriverId || formData.driver_id;

    // CRITICAL: Check staged pickups FIRST
    const stagedPickup = stagedDeliveries.find((d) =>
      !d.patient_id && d.store_id === projected.store_id &&
      d.delivery_date === formData.delivery_date &&
      d.driver_id === autoDriverId &&
      (d.ampm_deliveries || 'AM') === timeSlot
    );

    if (stagedPickup) {
      puid = stagedPickup.puid || stagedPickup.stop_id;
      console.log(`✅ [confirmAddProjectedToStaged] Using PUID from staged pickup: ${puid}`);
    }

    // CRITICAL: Build staged item FIRST, then update both states atomically
    const newStagedItem = {
      patient_id: projected.patient_id,
      patient_name: projected.patient_name,
      patient_phone: patient.phone || '',
      unit_number: patient.unit_number || '',
      delivery_date: formData.delivery_date,
      delivery_time_start: patient.delivery_time_start || '',
      delivery_time_end: patient.delivery_time_end || (patient.delivery_time_start ? '' : ''),
      time_window_start: patient.time_window_start || '',
      time_window_end: patient.time_window_end || (patient.time_window_start ? '' : ''),
      puid: '', // Will be updated after async call
      ampm_deliveries: timeSlot,
      status: 'Staged',
      driver_id: autoSelectedDriverId,
      driver_name: autoSelectedDriverName,
      prescription_number: projected.prescription_number || '',
      delivery_instructions: patient.notes || '',
      delivery_notes: '',
      cod_total_amount_required: projected.cod_total_amount_required || 0,
      cod_payments: [],
      cod_payment_type: 'No Payment',
      tracking_number: '',
      delivery_stop_id: '',
      stop_id: '',
      store_id: projected.store_id,
      store_name: store.name,
      store_abbreviation: store.abbreviation,
      store_phone: store.phone || '',
      mailbox_ok: patient.mailbox_ok || false,
      call_upon_arrival: patient.call_upon_arrival || false,
      ring_bell: patient.ring_bell || false,
      dont_ring_bell: patient.dont_ring_bell || false,
      back_door: patient.back_door || false,
      signature_needed: patient.signature_needed || false,
      fridge_item: patient.fridge_item || false,
      oversized: patient.oversized || false,
      after_hours_pickup: false,
      no_charge: false,
      extra_time: projected.extra_time || 0,
      recurring: patient.recurring || false,
      recurring_daily: patient.recurring_daily || false,
      recurring_weekly_mon: patient.recurring_weekly_mon || false,
      recurring_weekly_tue: patient.recurring_weekly_tue || false,
      recurring_weekly_wed: patient.recurring_weekly_wed || false,
      recurring_weekly_thu: patient.recurring_weekly_thu || false,
      recurring_weekly_fri: patient.recurring_weekly_fri || false,
      recurring_weekly_sat: patient.recurring_weekly_sat || false,
      recurring_weekly_sun: patient.recurring_weekly_sun || false,
      recurring_biweekly: patient.recurring_biweekly || false,
      recurring_weekly_x4: patient.recurring_weekly_x4 || false,
      recurring_monthly: patient.recurring_monthly || false,
      recurring_bimonthly: patient.recurring_bimonthly || false,
      _tempId: Date.now() + Math.random(),
      _wasProjected: true,
      _originalProjected: projected,
      distanceFromStore: distanceFromStore,
      delivery_address: patient.address || '',
      isNextDelivery: false,
      paid_km_override: distanceFromStore !== null && distanceFromStore !== undefined ? parseFloat(distanceFromStore.toFixed(2)) : null
      };

    // CRITICAL: Remove from projected and add to staged in one synchronous batch
    setProjectedDeliveries((prev) => prev.filter((p) => p.patient_id !== projected.patient_id));
    setStagedDeliveries((prev) => [...prev, newStagedItem]);
    setHasChanges(true);

    // Determine or create PUID if not found in staged
    if (!puid) {
      const existingPickup = allDeliveries.find((d) => d && !d.patient_id && d.store_id === projected.store_id && d.delivery_date === formData.delivery_date && d.driver_id === autoDriverId && (d.ampm_deliveries || 'AM') === timeSlot);
      let reusable = false;
      if (existingPickup) {
        const now = new Date();
        reusable = ['pending','en_route','in_transit'].includes(existingPickup.status) || (existingPickup.status==='completed' && existingPickup.actual_delivery_time && (now - new Date(existingPickup.actual_delivery_time) < 60*60*1000));
        if (reusable) puid = existingPickup.stop_id;
      }
      if (!puid) {
        try {
          const r = await base44.functions.invoke('ensurePickupForDelivery', { storeId: store.id, deliveryDate: formData.delivery_date, driverId: autoDriverId, ampmDeliveries: timeSlot });
          puid = r.data?.puid || getPickupStopIdForDelivery(store.id, formData.delivery_date, timeSlot, allDeliveries);
        } catch {
          puid = getPickupStopIdForDelivery(store.id, formData.delivery_date, timeSlot, allDeliveries);
        }
      }
      if (puid) {
        setStagedDeliveries((prev) => prev.map((item) => item._tempId === newStagedItem._tempId ? { ...item, puid } : item));
      }
    }
  }, [formData, stores, patients, drivers, allDeliveries, stagedDeliveries]);

  const sortedStagedDeliveries = useMemo(() => {
    let filtered = [...stagedDeliveries];

    // Filter by driver if a specific driver is selected
    if (formData.driver_id && formData.driver_id !== '') {
      filtered = filtered.filter((d) => d.driver_id === formData.driver_id);
    }

    return filtered.sort((a, b) => {
      // First: Sort new staged (no id) to top, pending (with id) below
      const aIsPending = !!a.id;
      const bIsPending = !!b.id;

      if (!aIsPending && bIsPending) return -1;
      if (aIsPending && !bIsPending) return 1;

      const storeA = stores?.find((s) => s && s.id === a.store_id);
      const storeB = stores?.find((s) => s && s.id === b.store_id);

      // Second: Sort by store sort_order
      const sortOrderA = storeA?.sort_order ?? Infinity;
      const sortOrderB = storeB?.sort_order ?? Infinity;
      if (sortOrderA !== sortOrderB) {
        return sortOrderA - sortOrderB;
      }

      // Third: Sort by AM/PM (AM before PM)
      const ampmA = a.ampm_deliveries || 'ZZ'; // Default to end if no AMPM
      const ampmB = b.ampm_deliveries || 'ZZ';
      if (ampmA !== ampmB) {
        return ampmA.localeCompare(ampmB); // 'AM' < 'PM' alphabetically
      }

      // Fourth: Sort by distance from store (closest first)
      const distA = a.distanceFromStore ?? Infinity;
      const distB = b.distanceFromStore ?? Infinity;
      if (distA !== distB) {
        return distA - distB;
      }

      return 0;
    });
  }, [stagedDeliveries, stores, formData.driver_id]);

  const sortedProjectedDeliveries = useMemo(() => {
    let filtered = [...projectedDeliveries];

    // Filter by driver if a specific driver is selected (match by store's assigned driver)
    if (formData.driver_id && formData.driver_id !== '') {
      filtered = filtered.filter((proj) => {
        const store = stores?.find((s) => s && s.id === proj.store_id);
        if (!store) return false;

        const deliveryDate = formData.delivery_date ? new Date(formData.delivery_date + 'T00:00:00') : new Date();
        const dayOfWeek = deliveryDate.getDay();

        let amDriverId, pmDriverId;
        if (dayOfWeek === 6) {
          amDriverId = store.saturday_am_driver_id;
          pmDriverId = store.saturday_pm_driver_id;
        } else if (dayOfWeek === 0) {
          amDriverId = store.sunday_am_driver_id;
          pmDriverId = store.sunday_pm_driver_id;
        } else {
          amDriverId = store.weekday_am_driver_id;
          pmDriverId = store.weekday_pm_driver_id;
        }

        return amDriverId === formData.driver_id || pmDriverId === formData.driver_id;
      });
    }

    return filtered.sort((a, b) => {
      const storeA = stores?.find((s) => s && s.id === a.store_id);
      const storeB = stores?.find((s) => s && s.id === b.store_id);

      // Sort by store sort_order
      const sortOrderA = storeA?.sort_order ?? Infinity;
      const sortOrderB = storeB?.sort_order ?? Infinity;
      if (sortOrderA !== sortOrderB) {
        return sortOrderA - sortOrderB;
      }

      // Then by patient name
      return (a.patient_name || '').localeCompare(b.patient_name || '');
    });
  }, [projectedDeliveries, stores, formData.driver_id, formData.delivery_date]);


  const handleConfirmDelete = useCallback(async () => {
    const staged = deleteConfirmation.staged;
    if (!staged || !staged.id) return;
    const isPickup = !staged.patient_id;
    const transferPickupId = deleteConfirmation.transferPickupId;
    setIsDeletingPending(true);
    try {
      if (isPickup && transferPickupId) {
        const linkedStops = sortedStagedDeliveries.filter(s => s.id && s.patient_id && s.puid === staged.stop_id);
        if (linkedStops.length > 0) {
          const targetPickup = sortedStagedDeliveries.find(s => s.id === transferPickupId);
          if (!targetPickup) throw new Error('Target pickup not found');
          const targetPickupTR = parseInt(targetPickup.tracking_number, 10) || 0;
          const targetStore = stores.find(s => s?.id === targetPickup.store_id);
          const storeAbbrev = targetStore?.abbreviation || '';
          const existingTargetStops = sortedStagedDeliveries.filter(s => s.id && s.patient_id && s.puid === targetPickup.stop_id).length;
          for (let i = 0; i < linkedStops.length; i++) {
            const stop = linkedStops[i];
            const newTR = `${storeAbbrev}${targetPickupTR + existingTargetStops + i + 1}`;
            await updateDeliveryLocal(stop.id, { puid: targetPickup.stop_id, tracking_number: newTR, store_id: targetPickup.store_id, ampm_deliveries: targetPickup.ampm_deliveries });
          }
        }
      }
      await deleteDeliveryLocal(staged.id);
      const { invalidate } = await import('../utils/dataManager');
      invalidate('Delivery');
      setStagedDeliveries(prev => prev.filter(item => item.id !== staged.id && item._tempId !== staged._tempId));
      const remainingStagedIds = new Set(stagedDeliveries.filter(item => item.id !== staged.id && item._tempId !== staged._tempId).map(d => d.patient_id).filter(Boolean));
      setProjectedDeliveries(fullPredictionListRef.current.filter(pred => !remainingStagedIds.has(pred.patient_id)));
      setHasChanges(true);
      setHasPendingDeletes(true);
      if (editingStagedId === staged._tempId) { setEditingStagedId(null); handleClearForm(); }
      setDeleteConfirmation({ show: false, staged: null, transferPickupId: null });
    } catch (err) {
      setError(`Failed: ${err.message}`);
    } finally {
      setIsDeletingPending(false);
    }
  }, [deleteConfirmation, sortedStagedDeliveries, stores, stagedDeliveries, editingStagedId, handleClearForm]);

  return (
    <DeliveryFormView
      formRef={formRef} useMobileLayout={useMobileLayout} isMobileDevice={isMobileDevice} useFullscreen={useFullscreen}
      delivery={delivery} formData={formData} setFormData={setFormData} isPickupMode={isPickupMode} setIsPickupMode={setIsPickupMode}
      isSaving={isSaving} error={error} isPayrollLocked={isPayrollLocked} payrollLockMessage={payrollLockMessage} isFormLockedByPayroll={isFormLockedByPayroll}
      isFormDisabled={isFormDisabled} isCompletionStatus={isCompletionStatus}
      patientSearch={patientSearch} setPatientSearch={setPatientSearch} selectedPatient={selectedPatient} filteredPatients={filteredPatients}
      highlightedPatientIndex={highlightedPatientIndex} setHighlightedPatientIndex={setHighlightedPatientIndex}
      selectedPatientIds={selectedPatientIds} setSelectedPatientIds={setSelectedPatientIds} isMultiSelectMode={isMultiSelectMode}
      patientSearchInputRef={patientSearchInputRef} addPatientButtonRef={addPatientButtonRef} patientNameInputRef={patientNameInputRef}
      isScanning={isScanning} showCameraOverlay={showCameraOverlay}
      handleSearchKeyDown={handleSearchKeyDown} handlePatientSelect={handlePatientSelect} handleAddSelectedPatients={handleAddSelectedPatients}
      handleDuplicatePatient={handleDuplicatePatient} handleNewAddressPatient={handleNewAddressPatient}
      onCreatePatient={onCreatePatient} setIsPatientFormOpen={setIsPatientFormOpen}
      videoRef={videoRef} canvasRef={canvasRef} handleCameraCapture={handleCameraCapture}
      startCamera={startCamera} stopCamera={stopCamera} setShowCameraOverlay={setShowCameraOverlay} setIsScanning={setIsScanning}
      showMatchPopup={showMatchPopup} scanMatches={scanMatches} extractedData={extractedData} handleSelectMatchedPatient={handleSelectMatchedPatient}
      setShowMatchPopup={setShowMatchPopup} setScanMatches={setScanMatches} setExtractedData={setExtractedData}
      availableStores={availableStores} allDrivers={allDrivers} stores={stores} patients={patients} currentUser={currentUser}
      allDeliveries={allDeliveries} selectedPickupOption={selectedPickupOption} setSelectedPickupOption={setSelectedPickupOption}
      getDriverDisplayName={getDriverDisplayName} getDriverNameForStorage={getDriverNameForStorage}
      editingStagedId={editingStagedId} setStagedDeliveries={setStagedDeliveries} setHasChanges={setHasChanges}
      completionTime={completionTime} setCompletionTime={setCompletionTime}
      sortedStagedDeliveries={sortedStagedDeliveries} sortedProjectedDeliveries={sortedProjectedDeliveries} stagedDeliveries={stagedDeliveries}
      projectedDeliveries={projectedDeliveries} setProjectedDeliveries={setProjectedDeliveries} fullPredictionListRef={fullPredictionListRef}
      setEditingStagedId={setEditingStagedId} handleStagedDeliveryClick={handleStagedDeliveryClick} handleClearForm={handleClearForm}
      confirmAddProjectedToStaged={confirmAddProjectedToStaged} isLoadingPredictions={isLoadingPredictions}
      setPredictionTrigger={setPredictionTrigger} showStagedPanel={showStagedPanel} setShowStagedPanel={setShowStagedPanel}
      deleteConfirmation={deleteConfirmation} setDeleteConfirmation={setDeleteConfirmation} isDeletingPending={isDeletingPending}
      handleConfirmDelete={handleConfirmDelete}
      currentFrequency={currentFrequency} weeklyLabel={weeklyLabel} biWeeklyLabel={biWeeklyLabel} weeklyX4Label={weeklyX4Label}
      showDayPopup={showDayPopup} setShowDayPopup={setShowDayPopup} setActiveRecurringType={setActiveRecurringType}
      handleRecurringChange={handleRecurringChange} handleFrequencyChange={handleFrequencyChange} handleWeeklyDaysDone={handleWeeklyDaysDone}
      pidInputValue={pidInputValue} setPidInputValue={setPidInputValue} pidLookupStatus={pidLookupStatus} setPidLookupStatus={setPidLookupStatus}
      originalPidRef={originalPidRef} updatePatientLocal={updatePatientLocal} codAmountInputRef={codAmountInputRef}
      handleCancelClick={handleCancelClick} handleBatchSave={handleBatchSave} handleUpdateStaged={handleUpdateStaged} handleAddToStaging={handleAddToStaging}
      handleSubmit={handleSubmit} buttonState={buttonState} cancelButtonState={cancelButtonState}
      isFormValid={isFormValid} hasChanges={hasChanges} isPatientFormOpen={isPatientFormOpen}
      closeOnSave={closeOnSave} onCancel={onCancel}
    />
  );
}