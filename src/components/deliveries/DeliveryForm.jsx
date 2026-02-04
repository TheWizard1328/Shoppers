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
  createPatientLocal,
  updatePatientLocal,
  createDeliveryLocal,
  updateDeliveryLocal,
  deleteDeliveryLocal,
  batchCreateDeliveriesLocal
} from
'../utils/entityMutations';
import DeliveryFormStaged from './DeliveryFormStaged';
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
  const [deleteConfirmation, setDeleteConfirmation] = useState({ show: false, staged: null });
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

  const useMobileLayout = screenWidth < DESKTOP_FORM_WIDTH;
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
    if (delivery || formData.driver_id) return;

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
              console.log('🚗 [DeliveryForm] Setting driver (dispatcher):', driverNameToSet);
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

  const isLoadingExistingDelivery = useRef(false);

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

  useEffect(() => {
    if (delivery) {
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
      }
      
      setTimeout(() => {
        isLoadingExistingDelivery.current = false;
      }, 500);
    }
  }, [delivery, patients, allDeliveries]);

  const hasFormData = useMemo(() => !!(
  formData.patient_id || formData.patient_name || formData.patient_phone ||
  formData.unit_number || formData.delivery_notes || formData.prescription_number ||
  formData.cod_total_amount_required > 0 || formData.recurring),
  [formData]);

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

  const isFormLockedByPayroll = useMemo(() => {
    if (!delivery || !isPayrollLocked) return false;
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
    if (!stores || !Array.isArray(stores)) return [];

    let relevantStores = stores;

    if (userHasRole(currentUser, 'admin')) {
      relevantStores = stores;
    } else if (isPickupMode) {
      if (userHasRole(currentUser, 'dispatcher')) {
        const dispatcherStoreIds = currentUser.store_ids || [];
        relevantStores = stores.filter((s) => s && dispatcherStoreIds.includes(s.id));
      }
    } else {
      if (formData.patient_id && patients) {
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
  }, [stores, isPickupMode, formData.patient_id, formData.delivery_date, patients, currentUser]);

  const filteredPatients = useMemo(() => {
    if (!patientSearch || !patients || formData.patient_id) return [];
    const searchLower = patientSearch.toLowerCase().trim();
    if (!searchLower) return [];
    let availablePatients = patients || [];

    const stagedPatientIds = new Set(stagedDeliveries.map((d) => d.patient_id).filter(Boolean));

    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      if (dispatcherStoreIds.length > 0) {
        availablePatients = availablePatients.filter((p) =>
        p && p.store_id && dispatcherStoreIds.includes(p.store_id)
        );
      }
    }

    let results = availablePatients.filter((patient) => {
      if (!patient) return false;
      if (patient.status === 'inactive') return false;
      const name = patient.full_name?.toLowerCase() || '';
      if (name.includes('deceased') || name.includes('(old')) return false;

      return patient.full_name?.toLowerCase().includes(searchLower) ||
      patient.address?.toLowerCase().includes(searchLower) ||
      patient.phone?.toLowerCase().includes(searchLower) ||
      patient.notes?.toLowerCase().includes(searchLower);
    });

    if (results.length === 0) {
      results = availablePatients.filter((patient) => {
        if (!patient) return false;
        if (patient.status !== 'inactive') return false;
        const name = patient.full_name?.toLowerCase() || '';
        if (name.includes('deceased') || name.includes('(old')) return false;

        return patient.full_name?.toLowerCase().includes(searchLower) ||
        patient.address?.toLowerCase().includes(searchLower) ||
        patient.phone?.toLowerCase().includes(searchLower) ||
        patient.notes?.toLowerCase().includes(searchLower);
      });
    }

    results.sort((a, b) => {
      const aIsStaged = stagedPatientIds.has(a.id);
      const bIsStaged = stagedPatientIds.has(b.id);
      
      if (aIsStaged && !bIsStaged) return 1;
      if (!aIsStaged && bIsStaged) return -1;
      
      const aIsTemp = a.full_name?.toLowerCase().includes('(temp') || false;
      const bIsTemp = b.full_name?.toLowerCase().includes('(temp') || false;

      if (aIsTemp && !bIsTemp) return 1;
      if (!aIsTemp && bIsTemp) return -1;

      const aDate = a.last_delivery_date ? new Date(a.last_delivery_date).getTime() : 0;
      const bDate = b.last_delivery_date ? new Date(b.last_delivery_date).getTime() : 0;

      return bDate - aDate;
    });

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

  const predictionsStopped = useRef(false);
  const fullPredictionListRef = useRef([]);

  useEffect(() => {
    if (delivery || !formData.delivery_date || !currentUser || !stores || !allDeliveries) return;
    
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

        const response = await base44.functions.invoke('getDeliveryPredictions', {
          selectedDate: formData.delivery_date,
          storeIds: storeIdsToPredict,
          excludePatientIds: []
        });

        const result = response?.data || response;
        if (result.predictions) {
          console.log('[DeliveryForm] Received predictions from backend:', result.predictions.length);
          
          const formattedPredictions = result.predictions.map(pred => ({
            patient_id: pred.patient_id,
            patient_name: pred.patient_name,
            store_id: pred.store_id,
            reason: `${pred.frequency} delivery`,
            cod_total_amount_required: pred.cod_total_amount_required || 0,
            prescription_number: pred.prescription_number || '',
            extra_time: pred.extra_time || 0
          }));

          fullPredictionListRef.current = formattedPredictions;
          
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
    
    console.log('🔍 [handlePatientSelect] Called with patient:', {
      id: patient.id,
      name: patient.full_name,
      latitude: patient.latitude,
      longitude: patient.longitude,
      distance_from_store: patient.distance_from_store,
      autoAddToStaged: autoAddToStaged
    });
    
    const alreadyStaged = stagedDeliveries.some(s => s.patient_id === patient.id);
    if (alreadyStaged) {
      console.log('⏸️ [handlePatientSelect] Patient already staged, skipping:', patient.full_name);
      setPatientSearch('');
      setHighlightedPatientIndex(-1);
      return;
    }
    
    if (isLoadingExistingDelivery.current) {
      console.log('⏸️ [handlePatientSelect] Blocked - editing existing delivery');
      return;
    }

    const hasCompletedDelivery = allDeliveries?.some((d) =>
    d && d.patient_id === patient.id && d.status === 'completed'
    );
    const isFirstDelivery = !hasCompletedDelivery;

    setSelectedPatient(patient);

    const patientStore = stores.find((s) => s && s.id === patient.store_id);

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
      console.log('📝 [handlePatientSelect] Single selection - populating form only, not auto-adding to staged');
      setPatientSearch('');
      setHighlightedPatientIndex(-1);
      return;
    }

    if (!patientStore || !autoSelectedDriverId) {
      return;
    }

    if (!patient._isNew) {
      try {
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
          recurring_monthly: updatedFormData.recurring_monthly,
          recurring_bimonthly: updatedFormData.recurring_bimonthly
        });
      } catch (error) {
        console.error('Failed to update patient:', error);
      }
    }

    let distanceFromStore = patient.distance_from_store;
    if (distanceFromStore === null || distanceFromStore === undefined) {
      if (patient.latitude && patient.longitude && patientStore.latitude && patientStore.longitude) {
        distanceFromStore = calculateDistance(patientStore.latitude, patientStore.longitude, patient.latitude, patient.longitude);
      }
    }

    // Determine primary AM/PM slot for this patient
    const patientPreferredTimeSlot = determineDeliveryAMPM(patient);
    
    let puid = '';
    let selectedTimeSlot = patientPreferredTimeSlot;
    let pickupToUse = null;
    
    const allDeliveriesForDate = allDeliveries.filter(d => d && d.delivery_date === formData.delivery_date);

    // Check for existing pickups for this store, date, and assigned driver
    const existingAmPickup = allDeliveriesForDate.find(d => 
      !d.patient_id && d.store_id === patientStore.id && d.ampm_deliveries === 'AM' && d.driver_id === autoSelectedDriverId
    );
    const existingPmPickup = allDeliveriesForDate.find(d => 
      !d.patient_id && d.store_id === patientStore.id && d.ampm_deliveries === 'PM' && d.driver_id === autoSelectedDriverId
    );

    // Prioritize AM
    if (existingAmPickup && existingAmPickup.status !== 'completed' && existingAmPickup.status !== 'cancelled') {
      pickupToUse = existingAmPickup;
      selectedTimeSlot = 'AM';
      console.log(`📦 [handlePatientSelect] Using existing AM pickup: ${pickupToUse.stop_id}`);
    } else if (existingPmPickup && existingPmPickup.status !== 'completed' && existingPmPickup.status !== 'cancelled') {
      pickupToUse = existingPmPickup;
      selectedTimeSlot = 'PM';
      console.log(`📦 [handlePatientSelect] ${existingAmPickup ? 'AM pickup completed,' : 'No AM pickup,'} using existing PM pickup: ${pickupToUse.stop_id}`);
    }

    if (pickupToUse) {
      puid = pickupToUse.stop_id;
    } else {
      const targetAmpm = patientPreferredTimeSlot || 'AM';
      
      try {
        const pickupResponse = await base44.functions.invoke('ensurePickupForDelivery', {
          storeId: patientStore.id,
          deliveryDate: formData.delivery_date,
          driverId: autoSelectedDriverId,
          ampmDeliveries: targetAmpm
        });

        if (pickupResponse.data?.puid) {
          puid = pickupResponse.data.puid;
          selectedTimeSlot = targetAmpm;
          console.log(`✅ [handlePatientSelect] Created new pickup via ensurePickupForDelivery: ${puid} (isNew: ${pickupResponse.data.isNew})`);
        }
      } catch (error) {
        console.warn('⚠️ [handlePatientSelect] ensurePickupForDelivery failed, using fallback PUID:', error.message);
        puid = getPickupStopIdForDelivery(patientStore.id, formData.delivery_date, targetAmpm, allDeliveries);
        selectedTimeSlot = targetAmpm;
      }
    }
    
    const timeSlot = selectedTimeSlot;

    const stagedDelivery = {
      ...updatedFormData,
      delivery_time_start: patient.time_window_start || '',
      delivery_time_end: patient.time_window_end || (patient.time_window_start ? '' : ''),
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
      latitude: patient.latitude,
      longitude: patient.longitude
    };
    
    console.log('📦 [handlePatientSelect] Adding to staged with coordinates:', {
      patient_name: stagedDelivery.patient_name,
      latitude: stagedDelivery.latitude,
      longitude: stagedDelivery.longitude,
      distanceFromStore: stagedDelivery.distanceFromStore
    });
    
    setStagedDeliveries((prev) => [...prev, stagedDelivery]);

    setHasChanges(true);

    const stagedPatientIds = new Set([...stagedDeliveries.map(d => d.patient_id), patient.id].filter(Boolean));
    const filteredPredictions = fullPredictionListRef.current.filter(pred => !stagedPatientIds.has(pred.patient_id));
    setProjectedDeliveries(filteredPredictions);

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

    setTimeout(() => patientSearchInputRef.current?.focus(), 100);
  }, [formData, stores, drivers, allDeliveries, stagedDeliveries]);

  const handleAddSelectedPatients = useCallback(async () => {
    if (selectedPatientIds.size === 0) return;

    const patientsToAdd = filteredPatients.filter((p) => selectedPatientIds.has(p.id));

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
          ctx.drawImage(img, 0, 0, width, height);

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

  const handleCameraScan = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsScanning(true);
    setError(null);

    try {
      console.log('📸 [DeliveryForm] Starting camera scan...', { fileName: file.name, fileSize: file.size, fileType: file.type });

      console.log('🗜️ [DeliveryForm] Compressing image...');
      const compressedFile = await compressImage(file);
      console.log('✅ [DeliveryForm] Image compressed:', {
        originalSize: file.size,
        compressedSize: compressedFile.size,
        reduction: `${((1 - compressedFile.size / file.size) * 100).toFixed(1)}%`
      });

      const { globalFilters } = await import('../utils/globalFilters');
      const selectedCityId = globalFilters.getSelectedCityId();
      console.log('🏙️ [DeliveryForm] Selected city:', selectedCityId);

      console.log('📤 [DeliveryForm] Uploading compressed image...');
      const uploadResult = await base44.integrations.Core.UploadFile({ file: compressedFile });
      console.log('✅ [DeliveryForm] Image uploaded:', uploadResult.file_url);

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

      if (result.exactMatches && result.exactMatches.length === 1) {
        console.log('✅ [DeliveryForm] Single exact match found - populating form only');
        await handlePatientSelect(result.exactMatches[0].patient, false);
      } else if (result.exactMatches && result.exactMatches.length > 1) {
        console.log('⚠️ [DeliveryForm] Multiple exact matches found - showing selection popup');
        setScanMatches(result.exactMatches);
        setShowMatchPopup(true);
      } else if (result.matches && result.matches.length > 0) {
        console.log('📋 [DeliveryForm] Partial matches found - showing selection popup');
        setScanMatches(result.matches);
        setShowMatchPopup(true);
      } else {
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
      if (patientSearchInputRef.current) {
        patientSearchInputRef.current.value = '';
      }
    }
  }, [onCreatePatient, handlePatientSelect, compressImage]);

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
      setShowCameraOverlay(false);
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

        console.log('🗜️ [DeliveryForm] Compressing image...');
        const compressedFile = await compressImage(file);
        console.log('✅ [DeliveryForm] Image compressed:', {
          originalSize: file.size,
          compressedSize: compressedFile.size,
          reduction: `${((1 - compressedFile.size / file.size) * 100).toFixed(1)}%`
        });

        console.log('🔄 [DeliveryForm] Converting to Base64...');
        const reader = new FileReader();
        const base64Image = await new Promise((resolve, reject) => {
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(compressedFile);
        });
        console.log('✅ [DeliveryForm] Base64 conversion complete');

        const { globalFilters } = await import('../utils/globalFilters');
        const selectedCityId = globalFilters.getSelectedCityId();

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
        setShowCameraOverlay(false);
      }
    }, 'image/jpeg', 0.8);
  }, [onCreatePatient, handlePatientSelect, compressImage, stopCamera]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  const handleSelectMatchedPatient = useCallback(async (patient) => {
    setShowMatchPopup(false);
    setScanMatches([]);
    setExtractedData(null);
    await handlePatientSelect(patient, false);
  }, [handlePatientSelect]);

  const handleDuplicatePatient = useCallback((patient) => {
    if (!patient) return;
    
    const fullPatient = patients.find((p) => p && p.id === patient.id) || patient;
    
    if (isAppOwner(currentUser)) { console.log('DEBUG: Duplicating patient:', fullPatient); }
    
    setNewPatientMode('duplicate');
    setSelectedPatient(null);
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    
    const patientStore = stores.find((s) => s && s.id === patient.store_id);
    
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
    
    setFormData((prev) => ({
      ...prev,
      patient_id: '',
      patient_name: '',
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
    
    setSelectedPatient({ ...patient, _duplicateSource: true });
    
    setTimeout(() => patientNameInputRef.current?.focus(), 150);
  }, [formData.delivery_date, stores, drivers]);

  const handleNewAddressPatient = useCallback((patient) => {
    if (!patient) return;
    
    const fullPatient = patients.find((p) => p && p.id === patient.id) || patient;
    
    if (isAppOwner(currentUser)) { console.log('DEBUG: Creating new address for patient:', fullPatient); }
    
    setNewPatientMode('new_address');
    setSelectedPatient(null);
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    
    const patientStore = stores.find((s) => s && s.id === fullPatient.store_id);
    
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
    
    setFormData((prev) => ({
      ...prev,
      patient_id: '',
      patient_name: fullPatient.full_name || '',
      patient_phone: fullPatient.phone || '',
      unit_number: '',
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
    
    const patientWithoutAddress = {
      ...fullPatient,
      address: '',
      unit_number: '',
      _newAddressSource: true,
      _isNew: true,
      _focusAddress: !isMobileDevice
    };
    
    setSelectedPatient(patientWithoutAddress);
    
    if (onCreatePatient) {
      setIsPatientFormOpen(true);
      onCreatePatient((createdPatient) => {
        setIsPatientFormOpen(false);
        setNewPatientMode(null);
        handlePatientSelect(createdPatient, true);
      }, patientWithoutAddress);
    }
  }, [formData.delivery_date, stores, drivers, onCreatePatient, handlePatientSelect, patients, isMobileDevice]);

  const handleStagedDeliveryClick = useCallback((staged) => {
    console.log('📦 [DeliveryForm] Clicking staged item:', staged);
    console.log('📦 PUID in staged:', staged.puid);
    console.log('📦 Store ID in staged:', staged.store_id);
    console.log('📦 AMPM in staged:', staged.ampm_deliveries);
    console.log('📦 Driver ID in staged:', staged.driver_id);
    console.log('📦 Driver Name in staged:', staged.driver_name);
    console.log('📦 Full staged object keys:', Object.keys(staged));
    console.log('📦 Has ID (is pending)?:', !!staged.id);

    if (isMobileDevice) {
      setShowStagedPanel(false);
    }

    setEditingStagedId(staged._tempId);

    let formDataToSet = {
      ...staged,
      puid: staged.puid || '',
      driver_id: staged.driver_id || '',
      driver_name: staged.driver_name || '',
      cod_total_amount_required: staged.cod_total_amount_required > 0 ? staged.cod_total_amount_required * 100 : 0
    };
    console.log('📦 formDataToSet.puid:', formDataToSet.puid);
    console.log('📦 formDataToSet.store_id (before PUID lookup):', formDataToSet.store_id);
    console.log('📦 formDataToSet.driver_id:', formDataToSet.driver_id);
    console.log('📦 formDataToSet.driver_name:', formDataToSet.driver_name);

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

    if (staged.store_id && isPickupMode) {
      const timeSlot = formDataToSet.ampm_deliveries || determineDeliveryAMPM(staged);

      let matchingStoreId = null;
      if (timeSlot) {
        const variantId = `${staged.store_id}_${timeSlot}`;
        const variantExists = availableStores.some((s) => s && s.id === variantId);
        if (variantExists) {
          matchingStoreId = variantId;
          console.log('📦 Found variant store:', variantId);
        }
      }

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
      return true;
    }
    
    if (editingStagedId) {
      if (isPickupMode) {
        return !!formData.store_id && !!formData.delivery_date && !!formData.driver_id;
      }
      return (!!formData.patient_id || !!formData.patient_name) && 
             !!formData.store_id && 
             !!formData.delivery_date;
    }
    
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
      
      if (!patient && formData.patient_name && (newPatientMode === 'duplicate' || newPatientMode === 'new_address')) {
        if (!selectedPatient) {
          setError('Patient information missing for new patient creation.');
          return;
        }
        
        if (formData.patient_id) {
          console.log('⏸️ [handleAddToStaging] Patient already has ID, skipping creation:', formData.patient_id);
          patient = { id: formData.patient_id, full_name: formData.patient_name };
          isNewPatient = false;
        } else {
          console.log('➕ [handleAddToStaging] Creating new patient from Duplicate/New mode:', formData.patient_name);
          
          try {
            const newPatientData = {
              full_name: formData.patient_name,
              address: selectedPatient.address || '',
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
          recurring_monthly: formData.recurring_monthly,
          recurring_bimonthly: formData.recurring_bimonthly
        });
      } catch (error) {
        console.error('Failed to update patient:', error);
        setError('Failed to update patient data. Delivery will still be staged.');
      }
    }

    let distanceFromStore = patient?.distance_from_store;
    if (distanceFromStore === null || distanceFromStore === undefined) {
      if (patient && patient.latitude && patient.longitude && store.latitude && store.longitude) {
        distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
      }
    }

    // Determine primary AM/PM slot for this patient
    const patientPreferredTimeSlot = determineDeliveryAMPM(patient);

    let puid = null;
    let selectedTimeSlot = null;
    let pickupToUse = null;

    const allDeliveriesForDate = allDeliveries.filter(d => d && d.delivery_date === formData.delivery_date);
    
    // Check for existing pickups for this store, date, and assigned driver
    const existingAmPickup = allDeliveriesForDate.find(d => 
      !d.patient_id && d.store_id === store.id && d.ampm_deliveries === 'AM' && d.driver_id === formData.driver_id
    );
    const existingPmPickup = allDeliveriesForDate.find(d => 
      !d.patient_id && d.store_id === store.id && d.ampm_deliveries === 'PM' && d.driver_id === formData.driver_id
    );

    // Prioritize AM
    if (existingAmPickup && existingAmPickup.status !== 'completed' && existingAmPickup.status !== 'cancelled') {
      pickupToUse = existingAmPickup;
      selectedTimeSlot = 'AM';
      console.log(`📦 [handleAddToStaging] Using existing AM pickup: ${pickupToUse.stop_id}`);
    } else if (existingPmPickup && existingPmPickup.status !== 'completed' && existingPmPickup.status !== 'cancelled') {
      pickupToUse = existingPmPickup;
      selectedTimeSlot = 'PM';
      console.log(`📦 [handleAddToStaging] ${existingAmPickup ? 'AM pickup completed,' : 'No AM pickup,'} using existing PM pickup: ${pickupToUse.stop_id}`);
    }

    if (pickupToUse) {
      puid = pickupToUse.stop_id;
    } else {
      const targetAmpm = patientPreferredTimeSlot || 'AM';
      try {
        const pickupResponse = await base44.functions.invoke('ensurePickupForDelivery', {
          storeId: store.id,
          deliveryDate: formData.delivery_date,
          driverId: formData.driver_id,
          ampmDeliveries: targetAmpm
        });

        if (pickupResponse.data?.puid) {
          puid = pickupResponse.data.puid;
          selectedTimeSlot = targetAmpm;
          console.log(`✅ [handleAddToStaging] Created new pickup via ensurePickupForDelivery: ${puid} (isNew: ${pickupResponse.data.isNew})`);
        }
      } catch (error) {
        console.warn('⚠️ [handleAddToStaging] ensurePickupForDelivery failed:', error.message);
        puid = getPickupStopIdForDelivery(store.id, formData.delivery_date, targetAmpm, allDeliveries);
        selectedTimeSlot = targetAmpm;
      }
    }
    const timeSlot = selectedTimeSlot;

    setStagedDeliveries((prev) => [...prev, {
      ...formData,
      delivery_time_start: patient?.time_window_start || '',
      delivery_time_end: patient?.time_window_end || '',
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
      first_delivery: isNewPatient || !patient?.last_delivery_date
    }]);

    setHasChanges(true);

    const stagedPatientIds = new Set([...stagedDeliveries.map(d => d.patient_id), formData.patient_id].filter(Boolean));
    const filteredPredictions = fullPredictionListRef.current.filter(pred => !stagedPatientIds.has(pred.patient_id));
    setProjectedDeliveries(filteredPredictions);

    setError(null);
    setSelectedPatient(null);
    setSelectedPatientIds(new Set());
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    setEditingStagedId(null);
    setNewPatientMode(null);
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

    setTimeout(() => patientSearchInputRef.current?.focus(), 100);
  }, [formData, isFormValid, patients, stores, isPickupMode, newPatientMode, selectedPatient, stagedDeliveries, allDeliveries]);

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
          recurring_weekly_sat: formData.recurring_weekly_sat || false,
          recurring_weekly_sun: formData.recurring_weekly_sun || false,
          recurring_biweekly: formData.recurring_biweekly,
          recurring_weekly_x4: formData.recurring_weekly_x4,
          recurring_monthly: formData.recurring_monthly,
          recurring_bimonthly: formData.recurring_bimonthly
        });
      } catch (error) {
        console.error('Failed to update patient:', error);
        setError('Failed to update patient data. Delivery will still be updated.');
      }
    }

    let distanceFromStore = patient?.distance_from_store;
    if (distanceFromStore === null || distanceFromStore === undefined) {
      if (patient && patient.latitude && patient.longitude && store.latitude && store.longitude) {
        distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
      }
    }

    setStagedDeliveries((prev) => prev.map((staged) => {
      if (staged._tempId !== editingStagedId) return staged;

      const updatedStaged = {
        ...formData,
        cod_total_amount_required: codAmount,
        _tempId: editingStagedId,
        id: staged.id,
        patient_name: formData.patient_name || patient?.full_name || 'N/A (Pickup)',
        store_name: store.name,
        store_abbreviation: store.abbreviation,
        distanceFromStore: distanceFromStore,
        delivery_address: patient?.address || store.address,
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

    setTimeout(() => patientSearchInputRef.current?.focus(), 100);
  }, [editingStagedId, formData, isFormValid, patients, stores, isPickupMode]);

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

    predictionsStopped.current = true;
    setIsLoadingPredictions(true);
    setProjectedDeliveries([]);

    if (stagedDeliveries.length === 0 && !hasPendingDeletes) {
      console.warn('[AddToRoute] ⚠️ No staged deliveries to save');
      hasLoadedPending.current = false;
      predictionsStopped.current = false;
      onCancel();
      return;
    }

    if (stagedDeliveries.length === 0 && hasPendingDeletes) {
      console.log('[AddToRoute] 🗑️ Processing pending deletes (Done button clicked)...');
      
      setStagedDeliveries([]);
      setProjectedDeliveries([]);
      setHasPendingDeletes(false);
      setHasChanges(false);
      hasLoadedPending.current = false;
      predictionsStopped.current = false;
      setIsLoadingPredictions(true);
      onCancel();
      
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

    const validStagedDeliveries = stagedDeliveries.filter((staged) => {
      if (staged.id) {
        const stillExists = allDeliveries?.some((d) => d && d.id === staged.id);
        if (!stillExists) {
          console.log(`[AddToRoute] ⏭️ Skipping deleted delivery: ${staged.id} (${staged.patient_name})`);
          return false;
        }
      }
      return true;
    });

    const newDeliveries = validStagedDeliveries.filter((staged) => !staged.id);
    const existingDeliveries = validStagedDeliveries.filter((staged) => staged.id);

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
      predictionsStopped.current = false;
      setIsLoadingPredictions(true);
      onCancel();
      return;
    }

    const deliveryDate = formData.delivery_date;

    const calculateSequentialTRs = (deliveries) => {
      const groups = {};

      deliveries.forEach((del) => {
        const groupKey = `${del.store_id}_${del.ampm_deliveries || 'AM'}`;
        if (!groups[groupKey]) {
          const store = stores?.find((s) => s && s.id === del.store_id);
          const storeAbbrev = store?.abbreviation || '';

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

      Object.keys(groups).forEach((groupKey) => {
        const [storeId, ampm] = groupKey.split('_');
        const existingCount = allDeliveries?.filter((d) =>
          d &&
          d.patient_id &&
          d.store_id === storeId &&
          d.delivery_date === formData.delivery_date &&
          (d.ampm_deliveries || 'AM') === ampm
        ).length || 0;

        groups[groupKey].existingCount = existingCount;
        console.log(`[AddToRoute] 📊 Group ${groupKey}: ${existingCount} existing deliveries`);
      });

      const updatedDeliveries = deliveries.map((del) => {
        if (!del.patient_id) return del;

        const groupKey = `${del.store_id}_${del.ampm_deliveries || 'AM'}`;
        const group = groups[groupKey];
        if (!group) return del;

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

    const deliveriesWithCorrectStores = newDeliveries.map((del) => {
      if (!del.patient_id || !del.puid) return del;
      
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

    const affectedGroups = new Set(deliveriesWithCorrectStores.map((del) =>
    `${del.store_id}_${del.driver_id}_${del.ampm_deliveries || 'AM'}`
    ));

    console.log('[AddToRoute] 🔄 Affected pickup groups:', Array.from(affectedGroups));

    const existingDeliveriesToUpdate = [];

    for (const groupKey of affectedGroups) {
      const [storeId, driverId, ampm] = groupKey.split('_');

      const existingPickup = allDeliveries?.find((d) =>
      d &&
      !d.patient_id &&
      d.store_id === storeId &&
      d.driver_id === driverId &&
      d.delivery_date === formData.delivery_date &&
      (d.ampm_deliveries || 'AM') === ampm
      );

      const store = stores?.find((s) => s && s.id === storeId);
      const storeAbbrev = store?.abbreviation || '';

      let effectivePickupTR = store?.base_tracking_number || 0;

      if (existingPickup && existingPickup.tracking_number !== undefined && existingPickup.tracking_number !== null && existingPickup.tracking_number !== '') {
        const pickupTR = parseInt(existingPickup.tracking_number, 10);
        effectivePickupTR = isNaN(pickupTR) ? effectivePickupTR : pickupTR;
        console.log(`[AddToRoute] 🔢 Using pickup TR# ${effectivePickupTR} for group ${groupKey} (raw: "${existingPickup.tracking_number}")`);
      } else {
        console.log(`[AddToRoute] 🏪 No pickup TR found for group ${groupKey}, using store base TR# ${effectivePickupTR}`);
      }

      const existingDeliveriesInGroup = (allDeliveries || []).filter((d) =>
      d &&
      d.patient_id &&
      d.store_id === storeId &&
      d.driver_id === driverId &&
      d.delivery_date === formData.delivery_date &&
      (d.ampm_deliveries || 'AM') === ampm
      );

      existingDeliveriesInGroup.sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));

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

    try {
      if (existingDeliveriesToUpdate.length > 0) {
        console.log(`[AddToRoute] 📝 Updating ${existingDeliveriesToUpdate.length} existing deliveries with corrected TR#s...`);
        for (const update of existingDeliveriesToUpdate) {
          try {
            const { base44 } = await import('@/api/base44Client');
            await base44.entities.Delivery.update(update.id, { tracking_number: update.tracking_number });
          } catch (error) {
            if (error.message?.includes('not found') || error.response?.status === 404) {
              console.log(`[AddToRoute] ⏭️ Skipping deleted delivery: ${update.id}`);
              continue;
            }
            const delivery = allDeliveries?.find((d) => d?.id === update.id);
            const deliveryName = delivery?.patient_name || 'Unknown';
            const errorMessage = error.message?.replace(update.id, deliveryName) || error.message;
            throw new Error(errorMessage);
          }
        }
        console.log('[AddToRoute] ✅ Existing TR#s corrected');
      }

      if (existingDeliveries.length > 0) {
        console.log(`[AddToRoute] 📝 Updating ${existingDeliveries.length} existing deliveries...`);

        const hasCompletedDeliveries = allDeliveries?.some((d) =>
        d &&
        d.driver_id === formData.driver_id &&
        d.delivery_date === formData.delivery_date &&
        d.status === 'completed'
        );

        for (const updated of existingDeliveries) {
          try {
            console.log(`[AddToRoute] 🔄 Updating delivery ${updated.id}: ${updated.patient_name}`);
            console.log(`   - Old Status: ${updated.status}`);
            console.log(`   - Time window: ${updated.time_window_start} - ${updated.time_window_end}`);

            let finalStatus = updated.status;
            if (finalStatus === 'Staged') {
              const patientName = (updated.patient_name || '').toLowerCase();
              const deliveryNotes = (updated.delivery_notes || '').toLowerCase();
              const patientNotes = (updated.delivery_instructions || '').toLowerCase();
              const deliveryAddress = (updated.delivery_address || '').toLowerCase();
              
              const isInterStore = patientName.includes('interstore') || 
                                   deliveryNotes.includes('interstore') || 
                                   patientNotes.includes('interstore') ||
                                   deliveryAddress.includes('(isp)') || 
                                   deliveryAddress.includes('(isd)');
              
              finalStatus = isInterStore ? 'in_transit' : 'pending';
              console.log(`[AddToRoute] 🔄 Converting Staged → ${finalStatus} for: ${updated.patient_name}`);
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
              time_window_start: updated.time_window_start || '',
              time_window_end: updated.time_window_end || '',
              paid_km_override: updated.paid_km_override ?? null,
              store_id: updated.store_id || '',
              ampm_deliveries: updated.ampm_deliveries || null,
              puid: updated.puid || ''
            };

            console.log(`[AddToRoute] 🔄 New Status will be: ${updateData.status}`);

            await updateDeliveryLocal(updated.id, updateData);
            console.log(`[AddToRoute] ✅ Updated delivery: ${updated.patient_name} to status ${updateData.status}`);
          } catch (error) {
            if (error.message?.includes('not found') || error.response?.status === 404) {
              console.log(`[AddToRoute] ⏭️ Skipping deleted delivery: ${updated.id} (${updated.patient_name})`);
              continue;
            }
            const errorMessage = error.message?.replace(updated.id, updated.patient_name || 'Unknown Patient') || error.message;
            throw new Error(errorMessage);
          }
        }
        console.log('[AddToRoute] ✅ All existing deliveries updated');
      }

      if (newDeliveries.length > 0) {
        console.log('[AddToRoute] 📤 Calling Dashboard save handler with batch data...');
        const deliveriesReadyForDB = deliveriesWithTRs.map(d => {
          if (d.status === 'Staged') {
            const patientName = (d.patient_name || '').toLowerCase();
            const deliveryNotes = (d.delivery_notes || '').toLowerCase();
            const patientNotes = (d.delivery_instructions || '').toLowerCase();
            const deliveryAddress = (d.delivery_address || '').toLowerCase();
            
            const isInterStore = patientName.includes('interstore') || 
                                 deliveryNotes.includes('interstore') || 
                                 patientNotes.includes('interstore') ||
                                 deliveryAddress.includes('(isp)') || 
                                 deliveryAddress.includes('(isd)');
            
            return {
              ...d,
              status: isInterStore ? 'in_transit' : 'pending'
            };
          }
          return d;
        });
        await onSave({ _isBatchSave: true, _stagedDeliveries: deliveriesReadyForDB });
        
        for (const delivery of deliveriesReadyForDB) {
          if (delivery.cod_total_amount_required > 0 && delivery.patient_id && delivery.driver_id && delivery.status === 'in_transit') {
            try {
              const store = stores?.find(s => s && s.id === delivery.store_id);
              console.log('💳 [Square] Creating COD item for in_transit delivery:', delivery.patient_name, 'Amount:', delivery.cod_total_amount_required);
              await base44.functions.invoke('squareCreateCodItem', {
                deliveryId: delivery.id || delivery._tempId,
                patientName: delivery.patient_name,
                storeAbbreviation: store?.abbreviation || '',
                codAmount: delivery.cod_total_amount_required,
                deliveryDate: delivery.delivery_date,
                storeId: delivery.store_id
              });
              console.log('✅ [Square] COD item created for:', delivery.patient_name);
            } catch (squareError) {
              console.error('⚠️ [Square] Failed to create COD item:', squareError);
            }
          }
        }
        console.log('[AddToRoute] ✅ Batch save completed successfully');
      }

      if (existingDeliveries.length > 0 && newDeliveries.length === 0) {
        console.log('[AddToRoute] 🔄 Updating existing deliveries only...');
        
        console.log('[AddToRoute] 🧹 Clearing staged deliveries and closing form...');
        setStagedDeliveries([]);
        setProjectedDeliveries([]);
        setHasPendingDeletes(false);
        setHasChanges(false);
        hasLoadedPending.current = false;
        predictionsStopped.current = false;
        setIsLoadingPredictions(true);
        console.log('[AddToRoute] ✅ Staged deliveries cleared');

        onCancel();

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
            
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
              detail: { 
                deliveryDate: formData.delivery_date, 
                driverId: formData.driver_id,
                triggeredBy: 'doneButtonUpdates' 
              }
            }));
            window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

            const { fabControlEvents } = await import('../utils/fabControlEvents');
            fabControlEvents.notifyDataReady();

            fabControlEvents.notifyDoneButtonClicked();
            console.log('[AddToRoute] ✅ Background: UI refreshed, FAB activated, and done button event triggered');
          } catch (error) {
            console.error('[AddToRoute] ❌ Background refresh failed:', error);
          }
        }, 100);

        return;
      }

      console.log('[AddToRoute] 🔄 IMMEDIATE: Dispatching deliveries updated event...');
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { 
          deliveryDate: formData.delivery_date, 
          driverId: formData.driver_id,
          triggeredBy: 'doneButtonCreates',
          immediate: true
        }
      }));
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

      console.log('[AddToRoute] 🧹 Clearing staged deliveries from state...');
      setStagedDeliveries([]);
      setProjectedDeliveries([]);
      setHasPendingDeletes(false);
      setHasChanges(false);
      hasLoadedPending.current = false;
      predictionsStopped.current = false;
      setIsLoadingPredictions(true);
      console.log('[AddToRoute] ✅ Staged deliveries cleared');

      onCancel();

      setTimeout(async () => {
        try {
          if (formData.driver_id && formData.delivery_date) {
            console.log('[AddToRoute] 🔄 Background: Forcing backend refresh...');
            const { base44 } = await import('@/api/base44Client');
            const freshDeliveries = await base44.entities.Delivery.filter({
              driver_id: formData.driver_id,
              delivery_date: formData.delivery_date
            });
            console.log(`✅ [AddToRoute] Background: ${freshDeliveries.length} deliveries refreshed`);
          }

          const { invalidate, invalidateDeliveriesForDate } = await import('../utils/dataManager');
          invalidate('Delivery');
          invalidateDeliveriesForDate(formData.delivery_date);

          const { fabControlEvents } = await import('../utils/fabControlEvents');
          fabControlEvents.notifyDataReady();
          
          fabControlEvents.notifyDoneButtonClicked();
          console.log('[AddToRoute] ✅ Background: FAB activated and done button event triggered');
        } catch (error) {
          console.error('[AddToRoute] ❌ Background refresh failed:', error);
        }
      }, 100);
    } catch (err) {
      console.error('[AddToRoute] ❌ Batch save error:', err);
      setError(`Failed to save: ${err.message || 'Unknown error'}`);
      predictionsStopped.current = false;
      setIsLoadingPredictions(false);
    } finally {
      setIsSaving(false);
    }
  }, [stagedDeliveries, onSave, onCancel, allDeliveries, formData.delivery_date, formData.driver_id, editingStagedId, stores, hasPendingDeletes]);

  const handleSearchKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (hasFormData) {
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
        setPatientSearch('');
        setHighlightedPatientIndex(-1);
      }
      return;
    }

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

    if (!patientSearch) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredPatients.length > 0) {
        setHighlightedPatientIndex((prev) => prev < filteredPatients.length - 1 ? prev + 1 : prev);
      } else if (filteredPatients.length === 0 && addPatientButtonRef.current) {
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
          handlePatientSelect(selectedPat, false);
          setPatientSearch('');
          setHighlightedPatientIndex(-1);
        }
      } else if (filteredPatients.length === 0 && onCreatePatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher'))) {
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

      if (delivery && isCompletionStatus && completionTime) {
        const dateStr = formData.delivery_date;
        const timeStr = completionTime;
        dataToSave.actual_delivery_time = `${dateStr}T${timeStr}:00`;
        console.log('⏱️ [DeliveryForm] Saving actual_delivery_time as LOCAL:', dataToSave.actual_delivery_time);
      }

      const driverChanged = delivery && delivery.driver_id !== formData.driver_id;
      const oldDriver = driverChanged ? drivers.find((d) => d?.id === delivery.driver_id) : null;
      const newDriver = driverChanged ? drivers.find((d) => d?.id === formData.driver_id) : null;

      const dateChanged = delivery && delivery.delivery_date !== formData.delivery_date;

      if (dateChanged) {
        console.log('📅 [DeliveryForm] Date changed - keeping in_transit status and setting 10:00 AM start time');
        dataToSave.status = 'in_transit';
        dataToSave.delivery_time_start = '10:00';
      }

      const statusChangedToInTransit = delivery &&
      formData.status === 'in_transit' &&
      delivery.status !== 'in_transit';

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

      const statusChangedToCompletion = delivery &&
      ['completed', 'cancelled', 'failed', 'returned'].includes(formData.status) &&
      delivery.status !== formData.status;

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
        }
      }

      const codWasRemoved = delivery?.cod_total_amount_required > 0 && 
        (formData.cod_total_amount_required === 0 || !formData.cod_total_amount_required);
      
      if (codWasRemoved && delivery?.id) {
        try {
          console.log('💳 [Square] Deleting COD item - COD was removed from delivery:', delivery.id);
          
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
        console.log('✅ [DeliveryForm] Delivery updated - UI should update immediately via mutation notification');
        
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
        
      } else {
        await onSave(dataToSave);
      }

      if (driverChanged && oldDriver && newDriver && currentUser && userHasRole(currentUser, 'driver')) {
        const patientName = delivery.patient_name || selectedPatient?.full_name || 'Unknown';
        const messageContent = `🚚 Delivery reassigned to you:\n• Patient: ${patientName}\n• Date: ${format(new Date(formData.delivery_date), 'MMM d, yyyy')}\n• From: ${getDriverDisplayName(oldDriver)}`;

        await sendDeliveryMessage({
          senderId: currentUser.id,
          senderName: getDriverDisplayName(currentUser),
          receiverId: newDriver.id,
          receiverName: getDriverDisplayName(newDriver),
          content: messageContent
        });
        console.log('✉️ [DeliveryForm] Sent driver reassignment message');
      }


      if (statusChangedToCompletion && delivery && formData.status === 'completed') {
        try {
          if (delivery.isNextDelivery) {
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

      if (delivery && formData.driver_id && formData.delivery_date) {
        console.log('🔄 [DeliveryForm] Reordering stops after delivery update...');
        try {
          await reorderStops(formData.driver_id, formData.delivery_date, allDeliveries);
          console.log('✅ [DeliveryForm] Stop reordering complete');
        } catch (error) {
          console.error('❌ [DeliveryForm] Stop reordering failed:', error);
        }
      }

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
          for (const relatedDelivery of relatedDeliveries) {
            await base44.entities.Delivery.update(relatedDelivery.id, { status: 'in_transit' });
          }
        }
      }

      onCancel();
    } catch (error) {
      setError(error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleClearForm = useCallback(() => {
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
    setTimeout(() => patientSearchInputRef.current?.focus(), 100);
  }, []);

  const handleCancelClick = useCallback(() => {
    const hasNewStagedDeliveries = stagedDeliveries.some((d) => !d.id);

    if (hasNewStagedDeliveries && !delivery) {
      const confirmed = window.confirm('You have unsaved deliveries. Discard them?');
      if (confirmed) {
        setStagedDeliveries([]);
        setProjectedDeliveries([]);
        hasLoadedPending.current = false;
        onCancel();
      }
    } else {
      if (!delivery) {
        hasLoadedPending.current = false;
      }
      onCancel();
    }
  }, [stagedDeliveries, onCancel, delivery]);

  useEffect(() => {
    const handleEnterKey = (event) => {
      if (event.key !== 'Enter') return;
      if (isPatientFormOpen) return;
      if (event.target.tagName === 'TEXTAREA') return;
      if (event.target.getAttribute('role') === 'combobox') return;
      if (event.target === patientSearchInputRef.current) return;
      if (event.target.tagName === 'BUTTON') return;

      event.preventDefault();

      if (delivery && isFormValid && !isSaving) {
        handleSubmit(event);
        return;
      }

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
        if (showCameraOverlay) {
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
    return () => {
      console.log('📝 [DeliveryForm] Cleanup - setting isFormOverlayOpen = false');
      setIsFormOverlayOpen(false);
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
    if (newFrequency === 'weekly' || newFrequency === 'bi-weekly') {
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

      if (newFrequency !== 'weekly' && newFrequency !== 'bi-weekly') {
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

  useEffect(() => {
    if (delivery) {
      console.log('⏸️ [DeliveryForm] Skipping auto-load - editing existing delivery');
      return;
    }

    if (hasLoadedPending.current) {
      console.log('⏸️ [DeliveryForm] Skipping auto-load - already loaded');
      return;
    }

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

    let pendingDeliveries = allDeliveries.filter((d) =>
    d &&
    d.status === 'pending' &&
    d.delivery_date === suggestedDate &&
    d.patient_id
    );

    console.log('  - Found pending deliveries for date (before role filter):', pendingDeliveries.length);
    if (pendingDeliveries.length > 0) {
      console.log('  - Pending deliveries:', pendingDeliveries.map((d) => ({
        patient_name: d.patient_name,
        driver_id: d.driver_id,
        store_id: d.store_id
      })));
    }

    if (userHasRole(currentUser, 'admin')) {
      console.log(`  - Admin mode: ${pendingDeliveries.length} pending stops (no filtering)`);
    } else if (userHasRole(currentUser, 'dispatcher')) {
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
      pendingDeliveries = pendingDeliveries.filter((d) => d.driver_id === currentUser.id);
      console.log(`  - Driver mode: filtered to ${pendingDeliveries.length} pending stops for driver ${currentUser.id}`);
    }

    if (pendingDeliveries.length === 0) {
      console.log('  - No pending deliveries to load after role filtering');
      hasLoadedPending.current = true;
      return;
    }

    console.log('✅ [DeliveryForm] Found pending deliveries to auto-load:', pendingDeliveries.length);

    const newStagedItems = pendingDeliveries.map((delivery, index) => {
    const patient = patients.find((p) => p && p.id === delivery.patient_id);
    
    let finalStoreId = delivery.store_id;
    let timeSlot = delivery.ampm_deliveries;
    let puid = delivery.puid || '';
    
    if (puid) {
      const parentPickup = allDeliveries.find((d) => d && !d.patient_id && d.stop_id === puid);
      if (parentPickup) {
        finalStoreId = parentPickup.store_id || delivery.store_id;
        timeSlot = parentPickup.ampm_deliveries || delivery.ampm_deliveries;
        console.log(`📦 [AutoLoad] Delivery ${delivery.patient_name}: PUID=${puid} → store=${finalStoreId}, AM/PM=${timeSlot}`);
      }
    }
    
    const store = stores.find((s) => s && s.id === finalStoreId);

    if (!patient || !store) return null;

    let distanceFromStore = patient.distance_from_store;
    if (distanceFromStore === null || distanceFromStore === undefined) {
      if (patient?.latitude && patient?.longitude && store?.latitude && store?.longitude) {
        distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
      }
    }

      if (!timeSlot) {
        timeSlot = getStoreAssignedTimeSlot(store, delivery.delivery_date, allDeliveries);
        puid = getPickupStopIdForDelivery(store.id, delivery.delivery_date, timeSlot, allDeliveries);
      }

      return {
        ...delivery,
        _tempId: Date.now() + Math.random() + index,
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
    }).filter(Boolean);

    setTimeout(() => {
      console.log('💾 [DeliveryForm] Setting staged deliveries state with', newStagedItems.length, 'items');
      console.log('💾 [DeliveryForm] Items:', newStagedItems.map((item) => ({
        patient_name: item.patient_name,
        _tempId: item._tempId,
        id: item.id
      })));
      setStagedDeliveries(newStagedItems);
      hasLoadedPending.current = true;
      console.log(`✅ [DeliveryForm] Auto-loaded ${newStagedItems.length} pending deliveries to staged list`);
    }, 100);
  }, [delivery, allDeliveries, currentUser, patients, stores, suggestedDate]);

  const initialPuidRef = useRef(null);
  
  useEffect(() => {
    if (delivery && delivery.puid) {
      initialPuidRef.current = delivery.puid;
    }
  }, [delivery?.id]);

  useEffect(() => {
    if (delivery && initialPuidRef.current) {
      console.log('⏸️ [DeliveryForm] Preserving original PUID:', initialPuidRef.current);
      return;
    }
    
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

    let distanceFromStore = patient.distance_from_store;
    if (distanceFromStore === null || distanceFromStore === undefined) {
      if (patient.latitude && patient.longitude && store.latitude && store.longitude) {
        distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
      }
    }

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

    const autoDriverId = autoSelectedDriverId || formData.driver_id;

    // Determine primary AM/PM slot for this patient
    const patientPreferredTimeSlot = determineDeliveryAMPM(patient);

    let puid = null;
    let selectedTimeSlot = null;
    let pickupToUse = null;

    const allDeliveriesForDate = allDeliveries.filter(d => d && d.delivery_date === formData.delivery_date);

    // Check for existing pickups for this store, date, and assigned driver
    const existingAmPickup = allDeliveriesForDate.find(d => 
      !d.patient_id && d.store_id === store.id && d.ampm_deliveries === 'AM' && d.driver_id === autoDriverId
    );
    const existingPmPickup = allDeliveriesForDate.find(d => 
      !d.patient_id && d.store_id === store.id && d.ampm_deliveries === 'PM' && d.driver_id === autoDriverId
    );

    // Prioritize AM
    if (existingAmPickup && existingAmPickup.status !== 'completed' && existingAmPickup.status !== 'cancelled') {
      pickupToUse = existingAmPickup;
      selectedTimeSlot = 'AM';
      console.log(`📦 [confirmAddProjectedToStaged] Using existing AM pickup: ${pickupToUse.stop_id}`);
    } else if (existingPmPickup && existingPmPickup.status !== 'completed' && existingPmPickup.status !== 'cancelled') {
      pickupToUse = existingPmPickup;
      selectedTimeSlot = 'PM';
      console.log(`📦 [confirmAddProjectedToStaged] ${existingAmPickup ? 'AM pickup completed,' : 'No AM pickup,'} using existing PM pickup: ${pickupToUse.stop_id}`);
    }

    if (pickupToUse) {
      puid = pickupToUse.stop_id;
    } else {
      const targetAmpm = patientPreferredTimeSlot || 'AM';
      try {
        const pickupResponse = await base44.functions.invoke('ensurePickupForDelivery', {
          storeId: projected.store_id,
          deliveryDate: formData.delivery_date,
          driverId: autoDriverId,
          ampmDeliveries: targetAmpm
        });

        if (pickupResponse.data?.puid) {
          puid = pickupResponse.data.puid;
          selectedTimeSlot = targetAmpm;
          console.log(`✅ [confirmAddProjectedToStaged] Created new pickup via ensurePickupForDelivery: ${puid} (isNew: ${pickupResponse.data.isNew})`);
        }
      } catch (error) {
        console.warn('⚠️ [confirmAddProjectedToStaged] ensurePickupForDelivery failed, using fallback PUID:', error.message);
        puid = getPickupStopIdForDelivery(store.id, formData.delivery_date, targetAmpm, allDeliveries);
        selectedTimeSlot = targetAmpm;
      }
    }
    const timeSlot = selectedTimeSlot;

    const newStagedItem = {
      patient_id: projected.patient_id,
      patient_name: projected.patient_name,
      patient_phone: patient.phone || '',
      unit_number: patient.unit_number || '',
      delivery_date: formData.delivery_date,
      delivery_time_start: patient.time_window_start || '',
      delivery_time_end: patient.time_window_end || (patient.time_window_start ? '' : ''),
      time_window_start: patient.time_window_start || '',
      time_window_end: patient.time_window_end || (patient.time_window_start ? '' : ''),
      puid: puid || '',
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

    setProjectedDeliveries((prev) => prev.filter((p) => p.patient_id !== projected.patient_id));
    setStagedDeliveries((prev) => [...prev, newStagedItem]);
    setHasChanges(true);
  }, [formData, stores, patients, drivers, allDeliveries, stagedDeliveries]);

  const sortedStagedDeliveries = useMemo(() => {
    let filtered = [...stagedDeliveries];

    if (formData.driver_id && formData.driver_id !== '') {
      filtered = filtered.filter((d) => d.driver_id === formData.driver_id);
    }

    return filtered.sort((a, b) => {
      const aIsPending = !!a.id;
      const bIsPending = !!b.id;

      if (!aIsPending && bIsPending) return -1;
      if (aIsPending && !bIsPending) return 1;

      const storeA = stores?.find((s) => s && s.id === a.store_id);
      const storeB = stores?.find((s) => s && s.id === b.store_id);

      const sortOrderA = storeA?.sort_order ?? Infinity;
      const sortOrderB = storeB?.sort_order ?? Infinity;
      if (sortOrderA !== sortOrderB) {
        return sortOrderA - sortOrderB;
      }

      const ampmA = a.ampm_deliveries || 'ZZ';
      const ampmB = b.ampm_deliveries || 'ZZ';
      if (ampmA !== ampmB) {
        return ampmA.localeCompare(ampmB);
      }

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

      const sortOrderA = storeA?.sort_order ?? Infinity;
      const sortOrderB = storeB?.sort_order ?? Infinity;
      if (sortOrderA !== sortOrderB) {
        return sortOrderA - sortOrderB;
      }

      return (a.patient_name || '').localeCompare(b.patient_name || '');
    });
  }, [projectedDeliveries, stores, formData.driver_id, formData.delivery_date]);


  return (
    <div className={`fixed inset-0 z-[10020] overflow-hidden ${useMobileLayout && isMobileDevice ? '' : 'bg-black/60 flex items-center justify-center p-4'}`} style={useMobileLayout && isMobileDevice ? { background: 'var(--bg-white)' } : {}}>
      <motion.div ref={formRef} initial={{ opacity: 0, scale: useMobileLayout && isMobileDevice ? 1 : 0.95 }} animate={{ opacity: 1, y: 0 }} className={`w-full ${useMobileLayout && isMobileDevice ? 'h-full' : !delivery ? 'max-w-4xl max-h-[90vh]' : 'max-w-lg max-h-[90vh]'} flex`}>
        <Card className={`border-0 flex flex-col w-full ${useMobileLayout && isMobileDevice ? 'h-full' : 'rounded-xl shadow-xl'}`} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
          <CardHeader className="border-b p-4 flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Package className="w-5 h-5 text-emerald-600" />
                <div className="flex items-center gap-2">
                  <CardTitle className="text-xl font-bold" style={{ color: 'var(--text-slate-900)' }}>
                    {delivery ? isPickupMode ? 'Edit Pickup' : 'Edit Delivery' : 'Add To Route'}
                  </CardTitle>
                  {(() => {
                    let patientToCheck = selectedPatient;

                    if (!patientToCheck && formData.patient_id && patients) {
                      patientToCheck = patients.find((p) => p && p.id === formData.patient_id);
                    }

                    if (!patientToCheck || !patientToCheck.last_delivery_date) return null;

                    try {
                      const date = new Date(patientToCheck.last_delivery_date + 'T00:00:00');
                      if (isNaN(date.getTime())) return null;
                      return (
                        <Badge variant="outline" className="text-xs font-normal ml-2">
                          LD: {format(date, 'MMM d, yyyy')}
                        </Badge>);

                    } catch {
                      return null;
                    }
                  })()}
                </div>

                {!delivery &&
                <div className="flex gap-2 ml-4">
                    <Button
                    type="button"
                    variant={!isPickupMode ? "default" : "outline"}
                    size="sm"
                    onClick={() => setIsPickupMode(false)} className="disabled:opacity-50 bg-emerald-600 text-white px-3 text-xs !text-white font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow h-8 hover:bg-emerald-700">

                      Add Delivery
                    </Button>
                    <Button
                    type="button"
                    variant={isPickupMode ? "default" : "outline"}
                    size="sm"
                    onClick={() => setIsPickupMode(true)}
                    className={isPickupMode ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""}
                    style={!isPickupMode ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>
                      Add Pickup
                    </Button>
                  </div>
                }
              </div>
              <Button variant="ghost" size="icon" onClick={handleCancelClick} disabled={isSaving}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          </CardHeader>

          {error && <div className="p-3 bg-red-100 text-red-700 text-sm text-center" style={{ background: '#fee2e2', color: '#991b1b' }}>Error: {error}</div>}
          {isPayrollLocked && payrollLockMessage && (
            <div className="p-3 bg-amber-100 text-amber-900 text-sm text-center border-b border-amber-200 flex items-center justify-center gap-2" style={{ background: '#fef3c7', color: '#78350f' }}>
              <AlertCircle className="w-4 h-4" />
              <span>{payrollLockMessage}</span>
            </div>
          )}

          <CardContent className={`p-4 flex-1 relative overflow-hidden ${isFormLockedByPayroll ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="space-y-3 h-full flex flex-col">
              <div className={`flex gap-3 ${useMobileLayout ? 'flex-col' : ''} ${!delivery && !useMobileLayout ? 'flex-shrink-0' : ''}`}>
                {!delivery && !isPickupMode &&
                <div className={`relative ${useMobileLayout ? 'w-full' : 'flex-[2]'} space-y-1 p-3 rounded-lg border`} style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <div className="flex items-center justify-between mb-1">
                      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Search</Label>
                      {selectedPatient &&
                      <div className="p-1.5 px-2.5 bg-emerald-50 border border-emerald-200 rounded text-xs flex items-center gap-1.5 max-w-[200px]">
                         <span className="text-emerald-700 font-medium truncate">
                           ✓ {selectedPatient.full_name}
                         </span>
                         {stores && selectedPatient.store_id && (() => {
                       const patientStore = stores.find((s) => s && s.id === selectedPatient.store_id);
                       const storeAbbr = patientStore?.abbreviation;
                       const storeColor = patientStore ? getStoreColor(patientStore) : '#64748b';
                       const ampm = determineDeliveryAMPM(selectedPatient);
                       const showBadge = shouldShowStoreBadges(currentUser);
                       return (
                         <>
                               {storeAbbr && showBadge &&
                           <Badge
                             className="text-white text-[10px] px-1.5 py-0 h-4"
                             style={{ backgroundColor: storeColor }}>
                                   {storeAbbr}
                                 </Badge>
                           }
                               {ampm &&
                           <Badge className="bg-slate-200 text-slate-700 text-[10px] px-1.5 py-0 h-4">
                                   {ampm.toUpperCase()}
                                 </Badge>
                           }
                             </>
                       );
                      })()}
                       </div>
                      }
                      </div>
                    <div className="relative flex gap-2">
                      <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 z-10" />
                        <Input
                        ref={patientSearchInputRef}
                        type="text"
                        placeholder="Search by name, address, phone..."
                        value={patientSearch}
                        onChange={(e) => {
                          setPatientSearch(e.target.value);
                          setHighlightedPatientIndex(-1);
                        }}
                        onKeyDown={handleSearchKeyDown}
                        className="pl-10 h-9"
                        disabled={isSaving} />

                        {patientSearch &&
                      <button
                        type="button"
                        onClick={() => {
                          setPatientSearch('');
                          setHighlightedPatientIndex(-1);
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 z-10">
                            <X className="w-4 h-4" />
                          </button>
                      }
                      </div>

                      <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={handleCameraScan}
                    className="hidden" />

                      <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-9 w-9 p-0 flex-shrink-0"
                      onClick={() => {
                        setShowCameraOverlay(true);
                        startCamera();
                      }}
                      disabled={isSaving || isScanning}
                      title="Scan prescription label">

                        {isScanning ?
                      <div className="animate-spin w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full"></div> :

                      <Camera className="w-4 h-4" />
                      }
                      </Button>
                    </div>

                    {patientSearch && !formData.patient_id &&
                  <div className="absolute top-full left-0 right-0 mt-1 max-h-64 overflow-y-auto border rounded-lg shadow-lg z-[100]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                        {selectedPatientIds.size > 1 &&
                    <div className="sticky top-0 bg-emerald-50 border-b border-emerald-200 p-2 flex items-center justify-between z-10">
                            <span className="text-sm font-medium text-emerald-700">
                              {selectedPatientIds.size} selected
                            </span>
                            <div className="flex gap-2">
                              <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => setSelectedPatientIds(new Set())}>
                                Clear
                              </Button>
                              <Button
                          type="button"
                          size="sm"
                          className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700"
                          onClick={handleAddSelectedPatients}>
                                Add Selected
                              </Button>
                            </div>
                          </div>
                    }
                        {filteredPatients.length === 0 ?
                    <div className="p-4 text-center text-slate-500 text-sm">
                            No patients found
                            {onCreatePatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                      <Button
                        ref={addPatientButtonRef}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full mt-3 gap-2"
                        onClick={() => {
                          setNewPatientMode('new');
                          setSelectedPatient(null);
                          setPatientSearch('');
                          setHighlightedPatientIndex(-1);
                          
                          const isDispatcher = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
                          const dispatcherStoreIds = isDispatcher ? (currentUser.store_ids || []) : [];
                          const defaultStoreId = dispatcherStoreIds.length === 1 ? dispatcherStoreIds[0] : '';
                          
                          setIsPatientFormOpen(true);
                          onCreatePatient((newPatient) => {
                            setIsPatientFormOpen(false);
                            setNewPatientMode(null);
                            handlePatientSelect(newPatient, true);
                          }, {
                            full_name: '',
                            phone: '',
                            store_id: defaultStoreId,
                            address: '',
                            unit_number: '',
                            notes: '',
                            _isNew: true
                          });
                        }}>
                                <Plus className="w-4 h-4" />
                                Add New Patient
                              </Button>
                      }
                          </div> :

                    <div className="divide-y">
                            {filteredPatients.map((patient, index) => {
                        const patientStore = stores?.find((s) => s && s.id === patient.store_id);
                        const storeAbbr = patientStore?.abbreviation || '';
                        const isHighlighted = index === highlightedPatientIndex;
                        const isSelected = selectedPatientIds.has(patient.id);
                        const isAlreadyStaged = patient._isAlreadyStaged;

                        return (
                          <div
                            key={patient.id}
                            id={`patient-item-${index}`}
                            className={`w-full text-left p-2 transition-colors text-sm flex items-start gap-2 ${isHighlighted ? 'bg-emerald-50 border-l-4 border-emerald-500' : 'hover:bg-slate-50'} ${isSelected ? 'bg-blue-50' : ''} ${isAlreadyStaged ? 'bg-amber-50 opacity-70' : ''}`
                            }>
                                  {(isMultiSelectMode || selectedPatientIds.size > 0) &&
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={(checked) => {
                                setSelectedPatientIds((prev) => {
                                  const newSet = new Set(prev);
                                  if (checked) {
                                    newSet.add(patient.id);
                                  } else {
                                    newSet.delete(patient.id);
                                  }
                                  return newSet;
                                });
                              }}
                              className="mt-0.5" />

                            }
                                  <button
                              type="button"
                              onClick={(e) => {
                                if (isAlreadyStaged) {
                                  setPatientSearch('');
                                  setHighlightedPatientIndex(-1);
                                  return;
                                }
                                if (e.shiftKey || e.ctrlKey || e.metaKey) {
                                  setSelectedPatientIds((prev) => {
                                    const newSet = new Set(prev);
                                    if (newSet.has(patient.id)) {
                                      newSet.delete(patient.id);
                                    } else {
                                      newSet.add(patient.id);
                                    }
                                    return newSet;
                                  });
                                } else {
                                  handlePatientSelect(patient, false);
                                  setPatientSearch('');
                                  setHighlightedPatientIndex(-1);
                                }
                              }}
                              className={`flex-1 text-left ${isAlreadyStaged ? 'cursor-not-allowed' : ''}`}>
                                    <div className="font-medium truncate flex items-center gap-1.5">
                                      {patient.full_name}
                                      {isAlreadyStaged && (
                                        <Badge className="bg-amber-200 text-amber-800 text-[10px] px-1.5 py-0 h-4">
                                          STAGED
                                        </Badge>
                                      )}
                                      {storeAbbr && shouldShowStoreBadges(currentUser) && (() => {
                                  const patientStoreData = stores?.find((s) => s && s.id === patient.store_id);
                                  const storeColor = patientStoreData ? getStoreColor(patientStoreData) : '#64748b';
                                  return (
                                    <Badge
                                      className="text-white text-[10px] px-1.5 py-0 h-4"
                                      style={{ backgroundColor: storeColor }}>
                                            {storeAbbr}
                                          </Badge>);

                                })()}
                                    </div>
                                    <div className="text-xs text-slate-600 truncate">{patient.address}</div>
                                    {patient.phone && <div className="text-xs text-slate-500 truncate">{formatPhoneNumber(patient.phone)}</div>}
                                  </button>
                                  
                                  <div className="flex flex-col gap-1 ml-1">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 w-6 p-0 hover:bg-blue-100"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleDuplicatePatient(patient);
                                      }}
                                      title="Duplicate Patient (same address, new name)">
                                      <Copy className="w-3 h-3 text-blue-600" />
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 w-6 p-0 hover:bg-purple-100"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleNewAddressPatient(patient);
                                      }}
                                      title="New Address (same name, new address)">
                                      <MapPin className="w-3 h-3 text-purple-600" />
                                    </Button>
                                  </div>
                                </div>);

                      })}
                          </div>
                    }
                      </div>
                  }

                <div className={`flex gap-3 ${useMobileLayout ? 'flex-row' : 'contents'}`}>
                {isPickupMode && !delivery &&
                  <div className={`${useMobileLayout ? 'w-full' : 'flex-[2]'} space-y-1 p-3 rounded-lg border`} style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup Location *</Label>
                    <Select
                      value={selectedPickupOption}
                      onValueChange={(value) => {
                        setSelectedPickupOption(value);
                        const selectedStore = availableStores.find((s) => s.id === value);
                        const storeId = selectedStore?._originalStoreId || value;
                        const timeSlot = selectedStore?._timeSlot || null;

                        const newPuid = getPickupStopIdForDelivery(storeId, formData.delivery_date, timeSlot || 'AM', allDeliveries);

                        setFormData((prev) => ({
                          ...prev,
                          store_id: storeId,
                          ampm_deliveries: timeSlot,
                          puid: newPuid || ''
                        }));
                      }}
                      disabled={isSaving}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Select store" />
                      </SelectTrigger>
                      <SelectContent className="z-[999999]">
                        {availableStores.map((store) => {
                          const baseStoreId = store._originalStoreId || store.id;
                          const timeSlot = store._timeSlot || null;
                          const puid = getPickupStopIdForDelivery(baseStoreId, formData.delivery_date, timeSlot || 'AM', allDeliveries);
                          const baseStoreName = store._originalStoreId ? store.name.replace(/ \[AM\]| \[PM\]/, '') : store.name;
                          const displayName = `${baseStoreName}${store._timeSlot ? ` [${store._timeSlot}]` : ''}${isAppOwner(currentUser) && puid ? ` {${puid}}` : ''}`;
                          return (
                            <SelectItem key={store.id} value={store.id}>{displayName}</SelectItem>);

                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  }

                <div className={`${useMobileLayout ? 'w-[calc(50%-0.375rem)]' : 'flex-1'} space-y-1 p-3 rounded-lg border`} style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Date *</Label>
                  <Input
                      type="date"
                      value={formData.delivery_date}
                      onChange={(e) => setFormData((prev) => ({ ...prev, delivery_date: e.target.value }))}
                      disabled={isSaving}
                      className="h-9" />

                </div>

                <div className={`${useMobileLayout ? 'flex-1' : 'flex-1'} space-y-1 p-3 rounded-lg border`} style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Driver {delivery ? '*' : ''}</Label>
                  <Select
                      value={formData.driver_id || 'all'}
                      onValueChange={(driverId) => {
                        const newDriverId = driverId === 'all' ? '' : driverId;
                        const driver = driverId === 'all' ? null : allDrivers.find((d) => d.id === driverId);
                        const newDriverName = driver ? getDriverNameForStorage(driver) : '';

                        setFormData((prev) => ({
                          ...prev,
                          driver_id: newDriverId,
                          driver_name: newDriverName
                        }));

                        if (editingStagedId) {
                          setStagedDeliveries((prev) => prev.map((staged) => {
                            if (staged._tempId === editingStagedId) {
                              console.log(`🚗 [DeliveryForm] Updating staged item driver: ${staged.patient_name} → ${newDriverName || 'All Drivers'}`);
                              return {
                                ...staged,
                                driver_id: newDriverId,
                                driver_name: newDriverName
                              };
                            }
                            return staged;
                          }));
                          setHasChanges(true);
                        }
                      }}
                      disabled={isSaving}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select driver" />
                    </SelectTrigger>
                    <SelectContent className="z-[999999]">
                      {!delivery && <SelectItem value="all">All Drivers</SelectItem>}
                      {allDrivers.map((driver) =>
                        <SelectItem key={driver.id} value={driver.id}>
                          {getDriverDisplayName(driver)}
                        </SelectItem>
                        )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isAppOwner(currentUser) && delivery && (
              <div className="space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Identifiers</Label>
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-1">
                      <Label htmlFor="tracking_number" className="text-xs">TR#</Label>
                      <Input
                      id="tracking_number"
                      value={formData.tracking_number}
                      onChange={(e) => setFormData((prev) => ({ ...prev, tracking_number: e.target.value }))}
                      className="h-9 text-sm"
                      disabled={isSaving} />

                    </div>
                    <div className="flex-1 space-y-1">
                      <Label htmlFor="stop_id" className="text-xs">SID</Label>
                      <Input
                      id="stop_id"
                      value={formData.stop_id}
                      onChange={(e) => setFormData((prev) => ({ ...prev, stop_id: e.target.value }))}
                      className="h-9 text-sm"
                      disabled={isSaving} />

                    </div>
                    <div className="flex-1 space-y-1">
                      <Label htmlFor="puid" className="text-xs">PUID</Label>
                      <Input
                      id="puid"
                      value={formData.puid || ''}
                      onChange={(e) => setFormData((prev) => ({ ...prev, puid: e.target.value }))}
                      className="h-9 text-sm"
                      disabled={isSaving} />

                    </div>
                    <div className="flex-1 space-y-1">
                      <Label htmlFor="paid_km_override" className="text-xs">X-KM</Label>
                      <Input
                      id="paid_km_override"
                      type="text"
                      value={formData.paid_km_override !== null && formData.paid_km_override !== undefined ? String(formData.paid_km_override) : ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === '') {
                          setFormData((prev) => ({ ...prev, paid_km_override: null }));
                        } else {
                          setFormData((prev) => ({ 
                            ...prev, 
                            paid_km_override: val
                          }));
                        }
                      }}
                      onBlur={(e) => {
                        const val = e.target.value;
                        if (val !== '' && !isNaN(parseFloat(val))) {
                          setFormData((prev) => ({ 
                            ...prev, 
                            paid_km_override: parseFloat(parseFloat(val).toFixed(2))
                          }));
                        }
                      }}
                      placeholder={selectedPatient?.distance_from_store ? selectedPatient.distance_from_store.toFixed(2) : ''}
                      className="h-9 text-sm"
                      disabled={isSaving} />

                    </div>
                  </div>
                </div>
              )}

              <div className={`flex gap-3 w-full ${delivery || useMobileLayout ? 'overflow-y-auto flex-1' : 'flex-1 min-h-0 overflow-hidden'}`}>
                <div className={`flex flex-col gap-3 min-w-0 ${delivery || useMobileLayout ? 'flex-1' : 'flex-1 overflow-y-auto'} ${isFormDisabled ? 'opacity-40 pointer-events-none' : ''}`}>

                  <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    {!isPickupMode ?
                    <div className="flex gap-3">
                        <div className="flex-1 min-w-0 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Notes</Label>
                          <Textarea
                          value={formData.delivery_instructions || selectedPatient?.notes || ''}
                          onChange={(e) => setFormData((prev) => ({ ...prev, delivery_instructions: e.target.value }))}
                          placeholder="Patient delivery instructions..."
                          className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm text-sm resize-none"
                          disabled={isSaving} />
                        </div>

                        <div className="flex-1 min-w-0 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Driver Notes</Label>
                          <Textarea
                          value={formData.delivery_notes}
                          onChange={(e) => setFormData((prev) => ({ ...prev, delivery_notes: e.target.value }))}
                          placeholder="Driver notes for this delivery..."
                          className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm text-sm resize-none"
                          disabled={isSaving} />
                        </div>
                      </div> :
                    <div className="space-y-1">
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup Notes</Label>
                        <Textarea
                        value={formData.delivery_notes}
                        onChange={(e) => setFormData((prev) => ({ ...prev, delivery_notes: e.target.value }))}
                        placeholder="Notes for this pickup..."
                        className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm text-sm resize-none"
                        disabled={isSaving} />
                      </div>
                    }
                  </div>

                  {!isPickupMode &&
                  <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <div className="flex gap-3">
                        <div className="flex gap-3">
                          <div className="flex-1 space-y-2">
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Options</Label>
                            <div className="space-y-3">
                              <CheckboxField
                              id="fridge_item"
                              label="Fridge Item"
                              checked={formData.fridge_item}
                              onChange={(checked) => setFormData((prev) => ({ ...prev, fridge_item: checked }))}
                              disabled={isSaving} />


                              <CheckboxField
                              id="oversized"
                              label="Oversized"
                              checked={formData.oversized}
                              onChange={(checked) => setFormData((prev) => ({ ...prev, oversized: checked }))}
                              disabled={isSaving} />


                              <CheckboxField
                              id="signature_needed"
                              label="Signature Needed"
                              checked={formData.signature_needed}
                              onChange={(checked) => setFormData((prev) => ({ ...prev, signature_needed: checked }))}
                              disabled={isSaving} />


                              <CheckboxField
                              id="no_charge"
                              label="No Charge Delivery"
                              checked={formData.no_charge}
                              onChange={(checked) => setFormData((prev) => ({ ...prev, no_charge: checked }))}
                              disabled={isSaving} />

                            </div>
                          </div>

                        <div className="flex-1 space-y-2">
                              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>COD</Label>
                              <div className="space-y-3">
                                <div className="flex items-center space-x-2">
                                  <Checkbox
                                id="cod_enabled"
                                checked={formData.cod_total_amount_required > 0}
                                onCheckedChange={(checked) => {
                                  setFormData((prev) => ({
                                    ...prev,
                                    cod_total_amount_required: checked ? 0 : 0
                                  }));
                                  if (checked) {
                                    setTimeout(() => codAmountInputRef.current?.focus(), 100);
                                  }
                                }}
                                disabled={isSaving} />

                                  <Label htmlFor="cod_enabled" className="text-sm font-medium">
                                    COD Required
                                  </Label>
                                </div>

                                {formData.cod_total_amount_required >= 0 &&
                            <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                                    <Input
                                ref={codAmountInputRef}
                                type="text"
                                value={formData.cod_total_amount_required > 0 ? (formData.cod_total_amount_required / 100).toFixed(2) : formData.cod_total_amount_required === 0 ? '0.00' : ''}
                                onChange={(e) => {
                                  const cleaned = e.target.value.replace(/[^\d]/g, '');
                                  const cents = parseInt(cleaned) || 0;
                                  setFormData((prev) => ({
                                    ...prev,
                                    cod_total_amount_required: cents
                                  }));
                                }}
                                placeholder="0.00"
                                className="w-full pl-6 h-9 text-sm"
                                disabled={isSaving} />

                                  </div>
                            }
                              </div>
                            </div>
                        </div>
                      </div>
                    }

                  <div className={`space-y-2 p-3 rounded-lg border ${
                  delivery && !userHasRole(currentUser, 'admin') &&
                  ['completed', 'failed', 'returned', 'cancelled'].includes(formData.status) ?
                  'opacity-50 pointer-events-none' : ''}`
                  } style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      {isCompletionStatus && delivery ?
                    <div className="space-y-2">
                        <div className="flex gap-3">
                          <div className="flex-1 space-y-1">
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{isPickupMode ? 'Pickup Store *' : 'Store *'}</Label>
                            <Select
                            value={(() => {
                              if (formData.store_id && formData.ampm_deliveries) {
                                const variantId = `${formData.store_id}_${formData.ampm_deliveries}`;
                                const variantExists = availableStores.some((s) => s && s.id === variantId);
                                if (variantExists) return variantId;
                              }
                              return formData.store_id || "";
                            })()}
                            onValueChange={(value) => {
                              const selectedStore = availableStores.find((s) => s.id === value);
                              const storeId = selectedStore?._originalStoreId || value;
                              const timeSlot = selectedStore?._timeSlot || null;
                              const newPuid = getPickupStopIdForDelivery(storeId, formData.delivery_date, timeSlot || 'AM', allDeliveries);
                              setFormData((prev) => ({ ...prev, store_id: storeId, ampm_deliveries: timeSlot, puid: newPuid || '' }));
                              if (isPickupMode) setSelectedPickupOption(value);
                            }}
                            disabled={isSaving || isPickupMode && delivery}>
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Select store" />
                              </SelectTrigger>
                              <SelectContent className="z-[10030]">
                                {availableStores.map((store) => {
                                const baseStoreId = store._originalStoreId || store.id;
                                const timeSlot = store._timeSlot || null;
                                const puid = getPickupStopIdForDelivery(baseStoreId, formData.delivery_date, timeSlot || 'AM', allDeliveries);
                                const baseStoreName = store._originalStoreId ? store.name.replace(/ \[AM\]| \[PM\]/, '') : store.name;
                                const displayName = `${baseStoreName}${store._timeSlot ? ` [${store._timeSlot}]` : ''}${isAppOwner(currentUser) && puid ? ` {${puid}}` : ''}`;
                                return <SelectItem key={store.id} value={store.id}>{displayName}</SelectItem>;
                              })}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex-1 space-y-1">
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{isPickupMode ? 'Pickup Status' : 'Status'}</Label>
                            <Select
                            value={formData.status}
                            onValueChange={(value) => {
                              setFormData((prev) => ({ ...prev, status: value }));
                              if (delivery && ['completed', 'failed', 'cancelled', 'returned'].includes(value)) {
                                setCompletionTime(format(new Date(), 'HH:mm'));
                              }
                            }}
                            disabled={isSaving}>
                              <SelectTrigger className="h-9">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="z-[10030]">
                                {isPickupMode ? (
                                  <>
                                    <SelectItem value="en_route">En Route</SelectItem>
                                    <SelectItem value="completed">Completed</SelectItem>
                                    <SelectItem value="cancelled">Cancelled</SelectItem>
                                  </>
                                ) : (
                                  <>
                                    <SelectItem value="pending">Pending</SelectItem>
                                    <SelectItem value="in_transit">In Transit</SelectItem>
                                    <SelectItem value="completed">Completed</SelectItem>
                                    <SelectItem value="failed">Failed</SelectItem>
                                  </>
                                )}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div className="flex gap-3">
                          <div className="flex-1 space-y-1">
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Completion Time *</Label>
                            <Input
                              type="time"
                              value={completionTime}
                              onChange={(e) => setCompletionTime(e.target.value)}
                              disabled={isSaving}
                              className="h-9 text-sm" />
                          </div>
                          {isPickupMode && (
                            <>
                              <div className="flex-1 space-y-1">
                                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Start Time</Label>
                                <Input
                                  type="time"
                                  value={formData.delivery_time_start}
                                  onChange={(e) => setFormData((prev) => ({ ...prev, delivery_time_start: e.target.value }))}
                                  disabled={isSaving}
                                  placeholder="Start"
                                  className="h-9 text-sm" />
                              </div>
                              <div className="flex-1 space-y-1">
                                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>End Time</Label>
                                <Input
                                  type="time"
                                  value={formData.delivery_time_end}
                                  onChange={(e) => setFormData((prev) => ({ ...prev, delivery_time_end: e.target.value }))}
                                  disabled={isSaving}
                                  placeholder="End"
                                  className="h-9 text-sm" />
                              </div>
                            </>
                          )}
                        </div>
                      </div> :

                    <div className="space-y-2">
                      <div className="flex gap-3">
                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{isPickupMode ? 'Pickup Store *' : 'Store *'}</Label>
                          <Select
                          value={(() => {
                            if (formData.store_id && formData.ampm_deliveries) {
                              const variantId = `${formData.store_id}_${formData.ampm_deliveries}`;
                              const variantExists = availableStores.some((s) => s && s.id === variantId);
                              if (variantExists) return variantId;
                            }
                            return formData.store_id || "";
                          })()}
                          onValueChange={(value) => {
                            const selectedStore = availableStores.find((s) => s.id === value);
                            const storeId = selectedStore?._originalStoreId || value;
                            const timeSlot = selectedStore?._timeSlot || null;
                            const newPuid = getPickupStopIdForDelivery(storeId, formData.delivery_date, timeSlot || 'AM', allDeliveries);
                            setFormData((prev) => ({ 
                              ...prev, 
                              store_id: storeId, 
                              ampm_deliveries: timeSlot, 
                              puid: newPuid || '',
                              stop_id: isPickupMode ? newPuid || '' : prev.stop_id
                            }));
                            if (isPickupMode) setSelectedPickupOption(value);
                          }}
                          disabled={isSaving || isPickupMode && delivery}>
                            <SelectTrigger className="h-9">
                              <SelectValue placeholder="Select store" />
                            </SelectTrigger>
                            <SelectContent className="z-[10030]">
                              {availableStores.map((store) => {
                              const baseStoreId = store._originalStoreId || store.id;
                              const timeSlot = store._timeSlot || null;
                              const puid = getPickupStopIdForDelivery(baseStoreId, formData.delivery_date, timeSlot || 'AM', allDeliveries);
                              const baseStoreName = store._originalStoreId ? store.name.replace(/ \[AM\]| \[PM\]/, '') : store.name;
                              const displayName = `${baseStoreName}${store._timeSlot ? ` [${store._timeSlot}]` : ''}${isAppOwner(currentUser) && puid ? ` {${puid}}` : ''}`;
                              return <SelectItem key={store.id} value={store.id}>{displayName}</SelectItem>;
                            })}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{isPickupMode ? 'Pickup Status' : 'Status'}</Label>
                          <Select
                          value={formData.status}
                          onValueChange={(value) => {
                            setFormData((prev) => ({ ...prev, status: value }));
                            if (delivery && ['completed', 'failed', 'cancelled', 'returned'].includes(value)) {
                              setCompletionTime(format(new Date(), 'HH:mm'));
                            }
                          }}
                          disabled={isSaving}>
                            <SelectTrigger className="h-9">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="z-[10030]">
                              {delivery ? (
                                isPickupMode ? (
                                  <>
                                    <SelectItem value="en_route">En Route</SelectItem>
                                    <SelectItem value="completed">Completed</SelectItem>
                                    <SelectItem value="cancelled">Cancelled</SelectItem>
                                  </>
                                ) : (
                                  <>
                                    <SelectItem value="pending">Pending</SelectItem>
                                    <SelectItem value="in_transit">In Transit</SelectItem>
                                    <SelectItem value="completed">Completed</SelectItem>
                                    <SelectItem value="failed">Failed</SelectItem>
                                  </>
                                )
                              ) : (
                                <>
                                  <SelectItem value="Staged">Staged</SelectItem>
                                  <SelectItem value="pending">Pending</SelectItem>
                                  <SelectItem value="in_transit">In Transit</SelectItem>
                                </>
                              )}
                            </SelectContent>
                          </Select>
                        </div>
                        {isPickupMode && (
                          <div className="flex-1 space-y-1">
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup ID</Label>
                            <Input
                              value={formData.puid || formData.stop_id || ''}
                              disabled
                              placeholder="Auto-generated"
                              className="h-9 text-sm bg-slate-100" />
                          </div>
                        )}
                      </div>

                      <div className="flex gap-3">
                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Time Window</Label>
                          <div className="flex gap-1">
                            <div className="flex-1 relative">
                              <Input
                                type="time"
                                value={formData.time_window_start}
                                onChange={(e) => setFormData((prev) => ({ ...prev, time_window_start: e.target.value }))}
                                disabled={isSaving}
                                placeholder="Start"
                                className="h-9 text-sm" />
                            </div>
                            <div className="flex-1 relative">
                              <Input
                                type="time"
                                value={formData.time_window_end}
                                onChange={(e) => setFormData((prev) => ({ ...prev, time_window_end: e.target.value }))}
                                disabled={isSaving}
                                placeholder="End"
                                className="h-9 text-sm" />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    }
                    </div>

                  {!isPickupMode &&
                  <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <div className="flex gap-3">
                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Name *</Label>
                          <Input
                          ref={patientNameInputRef}
                          value={formData.patient_name}
                          onChange={(e) => setFormData((prev) => ({ ...prev, patient_name: e.target.value }))}
                          placeholder="Patient name"
                          disabled={isSaving}
                          className="h-9 text-sm" />
                        </div>

                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Phone</Label>
                          <PhoneInput
                          value={formData.patient_phone}
                          onChange={(value) => setFormData((prev) => ({ ...prev, patient_phone: value }))}
                          disabled={isSaving}
                          className="h-9 text-sm" />
                        </div>
                      </div>

                      <div className="flex gap-3">
                        <div className="flex-[65] space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Address</Label>
                          <Input
                          value={selectedPatient?.address || ''}
                          disabled
                          placeholder="Address from patient record"
                          className="bg-white h-9 text-sm" />
                        </div>

                        <div className="flex-[35] space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Unit #</Label>
                          <Input
                          value={formData.unit_number}
                          onChange={(e) => setFormData((prev) => ({ ...prev, unit_number: e.target.value }))}
                          placeholder="Unit #"
                          disabled={isSaving}
                          className="h-9 text-sm" />
                        </div>
                      </div>
                    </div>
                  }

                  {!isPickupMode &&
                  <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <div className="flex gap-3">
                        <div className="flex-1 space-y-2">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Preferences</Label>
                          <div className="space-y-3">
                            <CheckboxField
                            id="mailbox_ok"
                            label="MailBox OK"
                            checked={formData.mailbox_ok}
                            onChange={(checked) => setFormData((prev) => ({ ...prev, mailbox_ok: checked }))}
                            disabled={isSaving} />

                            <CheckboxField
                            id="ring_bell"
                            label="Ring Bell"
                            checked={formData.ring_bell}
                            onChange={(checked) => setFormData((prev) => ({ ...prev, ring_bell: checked }))}
                            disabled={isSaving} />

                            <CheckboxField
                            id="call_upon_arrival"
                            label="Call Upon Arrival"
                            checked={formData.call_upon_arrival}
                            onChange={(checked) => setFormData((prev) => ({ ...prev, call_upon_arrival: checked }))}
                            disabled={isSaving} />

                            <CheckboxField
                            id="dont_ring_bell"
                            label="Don't Ring Bell"
                            checked={formData.dont_ring_bell}
                            onChange={(checked) => setFormData((prev) => ({ ...prev, dont_ring_bell: checked }))}
                            disabled={isSaving} />

                            <CheckboxField
                            id="back_door"
                            label="Back Door"
                            checked={formData.back_door}
                            onChange={(checked) => setFormData((prev) => ({ ...prev, back_door: checked }))}
                            disabled={isSaving} />
                          </div>
                        </div>

                        <div className="flex-1 space-y-2 relative" id="recurring-section">
                          <div className="py-1 flex items-center space-x-2">
                            <Checkbox
                            id="recurring"
                            checked={formData.recurring}
                            onCheckedChange={handleRecurringChange}
                            disabled={isSaving} />

                            <Label htmlFor="recurring" className="text-sm font-medium">
                              Recurring
                            </Label>
                          </div>

                          {showDayPopup &&
                          <div className="absolute bottom-0 left-0 right-0 z-[100] rounded-lg shadow-xl p-3 border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
                            <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-slate-900)' }}>Select Days</h3>
                            <div className="space-y-2 mb-3">
                              <CheckboxField
                                id="recurring_weekly_mon"
                                label="Monday"
                                checked={formData.recurring_weekly_mon}
                                onChange={(checked) => setFormData((prev) => ({ ...prev, recurring_weekly_mon: checked }))}
                                disabled={isSaving}
                              />
                              <CheckboxField
                                id="recurring_weekly_tue"
                                label="Tuesday"
                                checked={formData.recurring_weekly_tue}
                                onChange={(checked) => setFormData((prev) => ({ ...prev, recurring_weekly_tue: checked }))}
                                disabled={isSaving}
                              />
                              <CheckboxField
                                id="recurring_weekly_wed"
                                label="Wednesday"
                                checked={formData.recurring_weekly_wed}
                                onChange={(checked) => setFormData((prev) => ({ ...prev, recurring_weekly_wed: checked }))}
                                disabled={isSaving}
                              />
                              <CheckboxField
                                id="recurring_weekly_thu"
                                label="Thursday"
                                checked={formData.recurring_weekly_thu}
                                onChange={(checked) => setFormData((prev) => ({ ...prev, recurring_weekly_thu: checked }))}
                                disabled={isSaving}
                              />
                              <CheckboxField
                                id="recurring_weekly_fri"
                                label="Friday"
                                checked={formData.recurring_weekly_fri}
                                onChange={(checked) => setFormData((prev) => ({ ...prev, recurring_weekly_fri: checked }))}
                                disabled={isSaving}
                              />
                              <CheckboxField
                                id="recurring_weekly_sat"
                                label="Saturday"
                                checked={formData.recurring_weekly_sat}
                                onChange={(checked) => setFormData((prev) => ({ ...prev, recurring_weekly_sat: checked }))}
                                disabled={isSaving}
                              />
                              <CheckboxField
                                id="recurring_weekly_sun"
                                label="Sunday"
                                checked={formData.recurring_weekly_sun}
                                onChange={(checked) => setFormData((prev) => ({ ...prev, recurring_weekly_sun: checked }))}
                                disabled={isSaving}
                              />
                            </div>
                            <div className="flex gap-2 justify-end">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setShowDayPopup(false);
                                  setActiveRecurringType(null);
                                }}
                              >
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                className="bg-emerald-600 hover:bg-emerald-700"
                                onClick={handleWeeklyDaysDone}
                              >
                                Done
                              </Button>
                            </div>
                          </div>
                          }

                          <RadioGroup
                          value={currentFrequency}
                          onValueChange={handleFrequencyChange}
                          disabled={!formData.recurring || isSaving} className="grid gap-2">

                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="daily" id="daily" disabled={!formData.recurring || isSaving} />
                              <Label htmlFor="daily" className={`text-sm ${!formData.recurring ? 'text-slate-400' : ''}`}>
                                Daily
                              </Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                              value="weekly"
                              id="weekly"
                              disabled={!formData.recurring || isSaving} />

                              <Label
                              htmlFor="weekly"
                              className={`text-sm cursor-pointer ${!formData.recurring ? 'text-slate-400' : ''}`}>

                                {weeklyLabel}
                              </Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                              value="bi-weekly"
                              id="bi-weekly"
                              disabled={!formData.recurring || isSaving} />

                              <Label
                              htmlFor="bi-weekly"
                              className={`text-sm cursor-pointer ${!formData.recurring ? 'text-slate-400' : ''}`}>

                                {biWeeklyLabel}
                              </Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="weekly-x4" id="weekly-x4" disabled={!formData.recurring || isSaving} />
                              <Label htmlFor="weekly-x4" className={`text-sm ${!formData.recurring ? 'text-slate-400' : ''}`}>
                                Weekly x4
                              </Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="monthly" id="monthly" disabled={!formData.recurring || isSaving} />
                              <Label htmlFor="monthly" className={`text-sm ${!formData.recurring ? 'text-slate-400' : ''}`}>
                                Monthly
                              </Label>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem value="bi-monthly" id="bi-monthly" disabled={!formData.recurring || isSaving} />
                              <Label htmlFor="bi-monthly" className={`text-sm ${!formData.recurring ? 'text-slate-400' : ''}`}>
                                Bi-Monthly
                              </Label>
                            </div>
                          </RadioGroup>
                        </div>
                      </div>
                    </div>
                  }

                  {isPickupMode && (
                  <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup Options</Label>
                      <div className="space-y-3">
                        <CheckboxField
                        id="after_hours_pickup"
                        label="After Hours Pickup"
                        checked={formData.after_hours_pickup}
                        onChange={(checked) => setFormData((prev) => ({ ...prev, after_hours_pickup: checked }))}
                        disabled={isSaving} />
                      </div>
                    </div>
                  )}
                </div>

                {!delivery && !useMobileLayout && (
                <div className="w-[300px] flex-shrink-0 p-3 rounded-lg border-2 flex flex-col h-full" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                  <Label className="text-sm font-semibold mb-2" style={{ color: 'var(--text-slate-900)' }}>Deliveries: (S: {sortedStagedDeliveries.filter(s => !s.id).length} P: {sortedStagedDeliveries.filter(s => s.id).length})</Label>
                  <DeliveryFormStaged
                    sortedStagedDeliveries={sortedStagedDeliveries}
                    sortedProjectedDeliveries={sortedProjectedDeliveries}
                    stores={stores}
                    patients={patients}
                    currentUser={currentUser}
                    editingStagedId={editingStagedId}
                    isMobileDevice={isMobileDevice}
                    handleStagedDeliveryClick={handleStagedDeliveryClick}
                    handleClearForm={handleClearForm}
                    stagedDeliveries={stagedDeliveries}
                    fullPredictionListRef={fullPredictionListRef}
                    setProjectedDeliveries={setProjectedDeliveries}
                    setStagedDeliveries={setStagedDeliveries}
                    setEditingStagedId={setEditingStagedId}
                    patientSearchInputRef={patientSearchInputRef}
                    confirmAddProjectedToStaged={confirmAddProjectedToStaged}
                    setDeleteConfirmation={setDeleteConfirmation}
                    isLoadingPredictions={isLoadingPredictions}
                  />

                    <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full mt-2 text-xs"
                    onClick={() => setPredictionTrigger((prev) => prev + 1)}
                    disabled={isLoadingPredictions}
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                      {isLoadingPredictions ? 'Analyzing...' : 'Refresh Projections'}
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <AnimatePresence>
              {!delivery && useMobileLayout && showStagedPanel &&
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 bg-black/60 z-50"
                onClick={() => setShowStagedPanel(false)}>
                  <motion.div
                  initial={{ x: '100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '100%' }}
                  transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-0 top-0 bottom-0 w-[300px] shadow-2xl flex flex-col" style={{ background: 'var(--bg-white)' }}>

                    <div className="border-b p-4 flex items-center justify-between" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
                      <h3 className="text-lg font-semibold" style={{ color: 'var(--text-slate-900)' }}>Deliveries: (S: {sortedStagedDeliveries.filter(s => !s.id).length} P: {sortedStagedDeliveries.filter(s => s.id).length})</h3>
                      <Button variant="ghost" size="icon" onClick={() => setShowStagedPanel(false)}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-3">
                      <DeliveryFormStaged
                        sortedStagedDeliveries={sortedStagedDeliveries}
                        sortedProjectedDeliveries={sortedProjectedDeliveries}
                        stores={stores}
                        patients={patients}
                        currentUser={currentUser}
                        editingStagedId={editingStagedId}
                        isMobileDevice={isMobileDevice}
                        handleStagedDeliveryClick={handleStagedDeliveryClick}
                        handleClearForm={handleClearForm}
                        stagedDeliveries={stagedDeliveries}
                        fullPredictionListRef={fullPredictionListRef}
                        setProjectedDeliveries={setProjectedDeliveries}
                        setStagedDeliveries={setStagedDeliveries}
                        setEditingStagedId={setEditingStagedId}
                        patientSearchInputRef={patientSearchInputRef}
                        confirmAddProjectedToStaged={confirmAddProjectedToStaged}
                        setDeleteConfirmation={setDeleteConfirmation}
                        isLoadingPredictions={isLoadingPredictions}
                      />
                    </div>

                    <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full mt-2 mx-3 mb-2 text-xs"
                    onClick={() => setPredictionTrigger((prev) => prev + 1)}
                    disabled={isLoadingPredictions}
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                      {isLoadingPredictions ? 'Analyzing...' : 'Refresh Projections'}
                    </Button>
                  </motion.div>
                </motion.div>
              }
            </AnimatePresence>
          </CardContent>

          <CardFooter className="border-t p-3 flex-shrink-0" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
            <div className="flex items-center justify-between w-full gap-4">
              {!delivery && useMobileLayout &&
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowStagedPanel(!showStagedPanel)}
                className="gap-2"
                style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <Package className="w-4 h-4" />
                  Deliveries: (S: {sortedStagedDeliveries.filter(s => !s.id).length} P: {sortedStagedDeliveries.filter(s => s.id).length})
                </Button>
              }
              <div className="flex gap-2 ml-auto">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={delivery ? handleCancelClick : cancelButtonState === 'clear' ? handleClearForm : handleCancelClick}
                  disabled={isSaving || isPatientFormOpen}
                  style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  {delivery ? 'Cancel' : cancelButtonState === 'clear' ? 'Clear' : 'Cancel'}
                </Button>

                {buttonState === 'done' ?
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleBatchSave()} className="inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow h-8 rounded-md px-3 text-xs !text-white bg-emerald-600 hover:bg-emerald-700 text-white gap-2"

                  disabled={isSaving || !hasChanges || isPatientFormOpen}>
                    {isSaving ?
                  <>
                        <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></div>
                        Saving...
                      </> :

                  <>
                        <CheckCircle className="w-4 h-4" />
                        Done
                      </>
                  }
                  </Button> :
                buttonState === 'updateStaged' ?
                <Button
                  type="button"
                  size="sm"
                  onClick={handleUpdateStaged} className="inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary-foreground shadow h-8 rounded-md px-3 text-xs !text-white bg-blue-600 hover:bg-blue-700 gap-2"

                  disabled={isSaving || !isFormValid || isPatientFormOpen}>
                      <Edit2 className="w-4 h-4" />
                      Update
                    </Button> :
                buttonState === 'add' ?
                <Button
                  type="button"
                  size="sm"
                  onClick={handleAddToStaging}
                  className="bg-blue-600 hover:bg-blue-700 gap-2"
                  disabled={isSaving || !isFormValid || isPatientFormOpen}>
                        <Plus className="w-4 h-4" />
                        Add
                      </Button> :

                <Button
                  type="submit"
                  size="sm"
                  onClick={async (e) => {
                    e.preventDefault();
                    await handleSubmit(e);
                    setTimeout(() => {
                      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
                    }, 500);
                    if (closeOnSave) {
                      onCancel();
                    }
                  }}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                  disabled={isSaving || !isFormValid || isPatientFormOpen || isFormLockedByPayroll}>
                        {isSaving ?
                  <>
                            <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></div>
                            Saving...
                          </> :

                  <>
                            <Save className="w-4 h-4" />
                            {isPickupMode ? 'Update Pickup' : 'Update Delivery'}
                          </>
                  }
                      </Button>
                }
              </div>
            </div>
          </CardFooter>
        </Card>
      </motion.div>

      {showMatchPopup &&
      <PatientMatchPopup
        isOpen={showMatchPopup}
        onClose={() => {
          setShowMatchPopup(false);
          setScanMatches([]);
          setExtractedData(null);
        }}
        matches={scanMatches}
        onSelectPatient={handleSelectMatchedPatient}
        extractedData={extractedData}
        stores={stores} />

      }

      {showCameraOverlay &&
      <AnimatePresence>
          <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10030] bg-black flex items-center justify-center p-2">
            <div className="relative w-full max-w-lg h-full max-h-[90vh] bg-black flex flex-col items-center justify-center rounded-lg shadow-xl">
              <video ref={videoRef} autoPlay playsInline className="w-full h-full object-contain rounded-lg"></video>
              <canvas ref={canvasRef} style={{ display: 'none' }}></canvas>
              <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-4">
                <Button variant="outline" onClick={() => {
                stopCamera();
                setShowCameraOverlay(false);
                setIsScanning(false);
              }} disabled={isScanning}>
                  Cancel
                </Button>
                <Button onClick={handleCameraCapture} disabled={isScanning}>
                  {isScanning ?
                <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> :

                <Camera className="w-4 h-4" />
                }
                  Capture & Scan
                </Button>
              </div>
              {error &&
            <div className="absolute top-4 p-2 bg-red-500 text-white rounded">
                  {error}
                </div>
            }
            </div>
          </motion.div>
        </AnimatePresence>
      }

      {deleteConfirmation.show && deleteConfirmation.staged &&
      <div className="fixed inset-0 z-[10020] bg-black/60 flex items-center justify-center p-4">
          <div className="rounded-lg shadow-xl max-w-sm w-full p-4 border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
            <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-slate-900)' }}>Delete Pending Delivery?</h3>
            <p className="text-sm mb-4" style={{ color: 'var(--text-slate-600)' }}>
              Are you sure you want to delete the pending delivery for <strong style={{ color: 'var(--text-slate-900)' }}>{deleteConfirmation.staged.patient_name}</strong>? This action cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteConfirmation({ show: false, staged: null })}
              disabled={isDeletingPending}>
                Cancel
              </Button>
              <Button
              variant="destructive"
              size="sm"
              disabled={isDeletingPending}
              onClick={async () => {
                const staged = deleteConfirmation.staged;
                if (!staged || !staged.id) return;

                setIsDeletingPending(true);
                try {
                  console.log('🗑️ [DeliveryForm] Deleting pending delivery:', staged.id, staged.patient_name);
                  
                  await deleteDeliveryLocal(staged.id);
                  console.log('✅ [DeliveryForm] Pending delivery deleted from offline and online DBs');

                  const { invalidate } = await import('../utils/dataManager');
                  invalidate('Delivery');

                  setStagedDeliveries((prev) => prev.filter((item) => item.id !== staged.id && item._tempId !== staged._tempId));
                  
                  const remainingStagedIds = new Set(
                    stagedDeliveries
                      .filter((item) => item.id !== staged.id && item._tempId !== staged._tempId)
                      .map(d => d.patient_id)
                      .filter(Boolean)
                  );
                  const filteredPredictions = fullPredictionListRef.current.filter(pred => !remainingStagedIds.has(pred.patient_id));
                  setProjectedDeliveries(filteredPredictions);
                  console.log(`✅ [DeliveryForm] Restored ${filteredPredictions.length} projections after pending deletion`);

                  setHasChanges(true);
                  setHasPendingDeletes(true);
                  
                  console.log('✅ [DeliveryForm] Pending delivery deleted and cache invalidated');

                  if (editingStagedId === staged._tempId) {
                    setEditingStagedId(null);
                    handleClearForm();
                  }

                  setDeleteConfirmation({ show: false, staged: null });
                } catch (error) {
                  console.error('❌ [DeliveryForm] Failed to delete pending delivery:', error);
                  setError(`Failed to delete: ${error.message}`);
                } finally {
                  setIsDeletingPending(false);
                }
              }}>
                {isDeletingPending ? 'Deleting...' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      }
    </div>
  );
}