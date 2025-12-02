import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { X, Save, Package, Search, Clock, Plus, Trash2, CheckCircle, Edit2 } from "lucide-react";
import { sortUsers } from "../utils/sorting";
import { Badge } from "@/components/ui/badge";
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

const CheckboxField = ({ id, label, checked, onChange, disabled }) =>
<div className="flex items-center space-x-2">
    <Checkbox id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    <Label htmlFor={id} className={`text-sm font-medium leading-none ${disabled ? 'text-slate-400' : ''}`}>
      {label}
    </Label>
  </div>;


const statusColorMap = {
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
      time_window_start: "", time_window_end: "", status: "Ready For Pickup",
      driver_name: "", driver_id: "", prescription_number: "",
      delivery_instructions: "", delivery_notes: "",
      cod_total_amount_required: 0, cod_payments: [],
      cod_payment_type: "No Payment", cod_amount: "",
      tracking_number: "", delivery_stop_id: "", stop_id: "", puid: "",
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
  const { deviceType } = getUserAgentInfo();
  const isMobileDevice = deviceType === 'Mobile';
  const hasLoadedPending = useRef(false);
  
  // Responsive layout state
  const [screenWidth, setScreenWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024);
  const [screenHeight, setScreenHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 768);
  const formRef = useRef(null);
  
  // Desktop form width threshold (max-w-4xl = 896px + padding)
  const DESKTOP_FORM_WIDTH = 920;
  
  // Rule 1: Use mobile layout if screen width < desktop form width (regardless of device type)
  const useMobileLayout = screenWidth < DESKTOP_FORM_WIDTH;
  
  // Rule 2: Use fullscreen ONLY if mobile layout AND on mobile device (never fullscreen on desktop)
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

  useEffect(() => {
    if (delivery) {
      const patient = delivery.patient_id ? patients?.find((p) => p && p.id === delivery.patient_id) : null;

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
        store_id: delivery.store_id || "",
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
        recurring_bimonthly: delivery.recurring_bimonthly || false
      });

      setIsPickupMode(!delivery.patient_id);

      if (patient) {
        setSelectedPatient(patient);
      }
    }
  }, [delivery, patients]);

  const hasFormData = useMemo(() => !!(
  formData.patient_id || formData.patient_name || formData.patient_phone ||
  formData.unit_number || formData.delivery_notes || formData.prescription_number ||
  formData.cod_total_amount_required > 0 || formData.recurring),
  [formData]);

  const buttonState = useMemo(() => {
    if (delivery) return 'update';
    if (editingStagedId) return 'updateStaged';
    if (stagedDeliveries.length > 0 && !hasFormData) return 'done';
    return 'add';
  }, [delivery, editingStagedId, stagedDeliveries.length, hasFormData]);

  const cancelButtonState = useMemo(() => hasFormData ? 'clear' : 'cancel', [hasFormData]);

  const isCompletionStatus = useMemo(() =>
  ['completed', 'cancelled', 'failed', 'returned'].includes(formData.status),
  [formData.status]
  );

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

    // Admins always see ALL stores
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

    // Get IDs of already staged patients
    const stagedPatientIds = new Set(stagedDeliveries.map((d) => d.patient_id).filter(Boolean));

    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      if (dispatcherStoreIds.length > 0) {
        availablePatients = availablePatients.filter((p) =>
        p && p.store_id && dispatcherStoreIds.includes(p.store_id)
        );
      }
    }

    const results = availablePatients.filter((patient) => {
      if (!patient) return false;
      // Exclude patients already in staged list
      if (stagedPatientIds.has(patient.id)) return false;

      // Filter out inactive patients
      if (patient.status === 'inactive') return false;

      // Filter out Deceased and (Old
      const name = patient.full_name?.toLowerCase() || '';
      if (name.includes('deceased') || name.includes('(old')) return false;

      return patient.full_name?.toLowerCase().includes(searchLower) ||
      patient.address?.toLowerCase().includes(searchLower) ||
      patient.phone?.toLowerCase().includes(searchLower);
    });

    // Sort: Most recently delivered first, then (Temp to the bottom
    results.sort((a, b) => {
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

    return results.slice(0, 50);
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

  useEffect(() => {
    if (delivery || !formData.delivery_date || !currentUser || !stores || !allDeliveries) return;

    const fetchPredictions = async (forceRefresh = false) => {
      setIsLoadingPredictions(true);
      setProjectedDeliveries([]);

      try {
        let storeIdsToPredict = [];

        // CRITICAL FIX: For admins viewing a single store (via dispatcher filter), 
        // only predict for that store, not ALL stores
        // Check if admin has a selected store context (e.g., viewing Kingsway specifically)
        const isAdmin = userHasRole(currentUser, 'admin');
        const isDispatcher = userHasRole(currentUser, 'dispatcher');
        
        if (isDispatcher && !isAdmin) {
          // Pure dispatcher: use their assigned stores
          storeIdsToPredict = currentUser.store_ids || [];
        } else if (isAdmin) {
          // Admin: If they also have dispatcher store_ids set, use those for focused predictions
          // Otherwise fall back to all stores (but this is rare - admins usually filter by store)
          if (currentUser.store_ids && currentUser.store_ids.length > 0) {
            storeIdsToPredict = currentUser.store_ids;
            console.log('[DeliveryForm] Admin with store filter, using stores:', storeIdsToPredict);
          } else {
            storeIdsToPredict = stores.map((s) => s.id);
            console.log('[DeliveryForm] Admin without store filter, using all stores:', storeIdsToPredict.length);
          }
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

        const response = await base44.functions.invoke('predictDeliveries', {
          delivery_date: formData.delivery_date,
          store_ids: storeIdsToPredict
        });

        if (response.data && response.data.predictions) {
          console.log('[DeliveryForm] Received predictions from API:', response.data.predictions.length);
          
          const stagedPatientIds = new Set(stagedDeliveries.map((d) => d.patient_id));

          const filteredPredictions = response.data.predictions.filter(
            (pred) => {
              // Filter out staged only
              if (stagedPatientIds.has(pred.patient_id)) {
                console.log('[DeliveryForm] Filtered out (staged):', pred.patient_name);
                return false;
              }

              // Safety check: ensure patient is not inactive
              const patient = patients?.find((p) => p && p.id === pred.patient_id);
              if (patient && patient.status === 'inactive') {
                console.log('[DeliveryForm] Filtered out (inactive):', pred.patient_name);
                return false;
              }

              // Filter based on recurring type and last delivery date
              if (patient && patient.last_delivery_date) {
                const lastDeliveryDate = new Date(patient.last_delivery_date + 'T00:00:00');
                const today = new Date();
                const daysSinceLastDelivery = Math.floor((today - lastDeliveryDate) / (1000 * 60 * 60 * 24));

                // Daily: exclude if last delivery was more than 3 days ago
                if (patient.recurring_daily && daysSinceLastDelivery > 3) {
                  console.log('[DeliveryForm] Filtered out (daily stale):', pred.patient_name, daysSinceLastDelivery, 'days');
                  return false;
                }

                // Weekly: exclude if last delivery was more than 2 weeks (14 days) ago
                if ((patient.recurring_weekly_mon || patient.recurring_weekly_tue ||
                patient.recurring_weekly_wed || patient.recurring_weekly_thu ||
                patient.recurring_weekly_fri || patient.recurring_weekly_sat ||
                patient.recurring_weekly_sun) && daysSinceLastDelivery > 14) {
                  console.log('[DeliveryForm] Filtered out (weekly stale):', pred.patient_name, daysSinceLastDelivery, 'days');
                  return false;
                }

                // Bi-Weekly: exclude if last delivery was more than 4 weeks (28 days) ago
                if (patient.recurring_biweekly && daysSinceLastDelivery > 28) {
                  console.log('[DeliveryForm] Filtered out (bi-weekly stale):', pred.patient_name, daysSinceLastDelivery, 'days');
                  return false;
                }

                // Weekly x4 & Monthly: exclude if last delivery was more than 60 days ago
                if ((patient.recurring_weekly_x4 || patient.recurring_monthly) && daysSinceLastDelivery > 60) {
                  console.log('[DeliveryForm] Filtered out (monthly stale):', pred.patient_name, daysSinceLastDelivery, 'days');
                  return false;
                }

                // Bi-Monthly: exclude if last delivery was more than 120 days ago
                if (patient.recurring_bimonthly && daysSinceLastDelivery > 120) {
                  console.log('[DeliveryForm] Filtered out (bi-monthly stale):', pred.patient_name, daysSinceLastDelivery, 'days');
                  return false;
                }
              }

              return true;
            }
          );

          console.log('[DeliveryForm] Filtered predictions:', filteredPredictions.length, 'of', response.data.predictions.length);
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

  const handlePatientSelect = useCallback(async (patient) => {
    if (!patient) return;

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

      const deliveryAMPM = determineDeliveryAMPM(patient); // Changed here

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
      delivery_instructions: isFirstDelivery ? 'First Delivery' : patient.notes || '',
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

    if (!patientStore || !autoSelectedDriverId) {
      return;
    }

    if (!patient._isNew) {
      try {
        await base44.entities.Patient.update(patient.id, {
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

    let distanceFromStore = null;
    if (patient.latitude && patient.longitude && patientStore.latitude && patientStore.longitude) {
      distanceFromStore = calculateDistance(patientStore.latitude, patientStore.longitude, patient.latitude, patient.longitude);
    }

    const timeSlot = getStoreAssignedTimeSlot(patientStore, formData.delivery_date, allDeliveries);
    const puid = getPickupStopIdForDelivery(patientStore.id, formData.delivery_date, timeSlot, allDeliveries);

    setStagedDeliveries((prev) => [...prev, {
      ...updatedFormData,
      delivery_time_start: patient.time_window_start || '',
      delivery_time_end: patient.time_window_end || '',
      puid: puid || '',
      ampm_deliveries: timeSlot,
      _tempId: Date.now() + Math.random(),
      patient_name: updatedFormData.patient_name || patient.full_name || 'N/A',
      store_name: patientStore.name,
      store_abbreviation: patientStore.abbreviation,
      distanceFromStore: distanceFromStore,
      delivery_address: patient.address || patientStore.address
    }]);

    // Remove from projected deliveries if exists
    setProjectedDeliveries((prev) => prev.filter((p) => p.patient_id !== patient.id));

    setError(null);
    setSelectedPatient(null);
    setSelectedPatientIds(new Set());
    setPatientSearch('');
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
      store_id: '',
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

    setTimeout(() => patientSearchInputRef.current?.focus(), 100);
  }, [formData, stores, drivers, allDeliveries]);

  const handleAddSelectedPatients = useCallback(async () => {
    if (selectedPatientIds.size === 0) return;

    const patientsToAdd = filteredPatients.filter((p) => selectedPatientIds.has(p.id));

    for (const patient of patientsToAdd) {
      await handlePatientSelect(patient);
    }

    setSelectedPatientIds(new Set());
  }, [selectedPatientIds, filteredPatients, handlePatientSelect]);

  const handleStagedDeliveryClick = useCallback((staged) => {
    console.log('📦 [DeliveryForm] Clicking staged item:', staged);
    console.log('📦 PUID in staged:', staged.puid);
    console.log('📦 Store ID in staged:', staged.store_id);
    console.log('📦 AMPM in staged:', staged.ampm_deliveries);

    setEditingStagedId(staged._tempId);

    let formDataToSet = {
      ...staged,
      cod_total_amount_required: staged.cod_total_amount_required > 0 ? staged.cod_total_amount_required * 100 : 0
    };

    // If it's a patient delivery and has a PUID, find the parent pickup to get the correct AM/PM slot.
    if (staged.patient_id && staged.puid) {
      const allPossiblePickups = [...stagedDeliveries, ...(allDeliveries || [])];
      const parentPickup = allPossiblePickups.find((d) => d && !d.patient_id && d.stop_id === staged.puid);

      if (parentPickup && parentPickup.ampm_deliveries) {
        console.log(`📦 Matched to pickup with PUID ${staged.puid}. Using its AM/PM slot: ${parentPickup.ampm_deliveries}`);
        formDataToSet.ampm_deliveries = parentPickup.ampm_deliveries;
      }
    }

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
    if (delivery) return true;
    if (isPickupMode) return selectedPickupOption !== '' && !!formData.delivery_date && !!formData.driver_id;
    return (!!formData.patient_id || !!formData.patient_name) && !!formData.store_id &&
    !!formData.delivery_date && !!formData.driver_id && !isFormDisabled;
  }, [formData, selectedPickupOption, isPickupMode, delivery, isFormDisabled]);

  const handleAddToStaging = useCallback(async () => {
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
        await base44.entities.Patient.update(formData.patient_id, {
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

    let distanceFromStore = null;
    if (patient && patient.latitude && patient.longitude && store.latitude && store.longitude) {
      distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
    }

    // Check for existing pickup for this store/driver/date
    let puid = null;
    const timeSlot = getStoreAssignedTimeSlot(store, formData.delivery_date, allDeliveries);

    const existingPickup = allDeliveries.find((d) =>
    d &&
    !d.patient_id &&
    d.store_id === store.id &&
    d.delivery_date === formData.delivery_date &&
    d.driver_id === formData.driver_id &&
    d.ampm_deliveries === timeSlot
    );

    if (existingPickup) {
      const now = new Date();
      const isNotCompleted = existingPickup.status !== 'completed';
      const wasCompletedRecently = existingPickup.actual_delivery_time &&
      now - new Date(existingPickup.actual_delivery_time) < 60 * 60 * 1000; // 60 minutes

      if (isNotCompleted || wasCompletedRecently) {
        puid = existingPickup.stop_id;
        console.log(`✅ Using existing pickup PUID: ${puid} (status: ${existingPickup.status}, completed recently: ${wasCompletedRecently})`);
      } else {
        console.log(`⏭️ Existing pickup found but too old, will create new pickup`);
      }
    }

    if (!puid) {
      puid = getPickupStopIdForDelivery(store.id, formData.delivery_date, timeSlot, allDeliveries);
    }

    setStagedDeliveries((prev) => [...prev, {
      ...formData,
      delivery_time_start: patient?.time_window_start || '',
      delivery_time_end: patient?.time_window_end || '',
      cod_total_amount_required: codAmount,
      puid: puid || '',
      ampm_deliveries: timeSlot,
      _tempId: Date.now() + Math.random(),
      patient_name: formData.patient_name || patient?.full_name || 'N/A (Pickup)',
      store_name: store.name,
      store_abbreviation: store.abbreviation,
      distanceFromStore: distanceFromStore,
      delivery_address: patient?.address || store.address
    }]);

    // Remove matching projected delivery if exists
    setProjectedDeliveries((prev) => prev.filter((p) => p.patient_id !== formData.patient_id));

    setError(null);
    setSelectedPatient(null);
    setPatientSearch('');
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
  }, [formData, isFormValid, patients, stores, isPickupMode]);

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
        await base44.entities.Patient.update(formData.patient_id, {
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
        setError('Failed to update patient data. Delivery will still be updated.');
      }
    }

    let distanceFromStore = null;
    if (patient && patient.latitude && patient.longitude && store.latitude && store.longitude) {
      distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
    }

    setStagedDeliveries((prev) => prev.map((staged) => {
      if (staged._tempId !== editingStagedId) return staged;
      
      // CRITICAL: Preserve the original 'id' field if it exists (pending delivery)
      // This ensures pending deliveries don't get re-saved as new when clicking Done
      const updatedStaged = {
        ...formData,
        cod_total_amount_required: codAmount,
        _tempId: editingStagedId,
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
        signature_needed: formData.signature_needed || false
      };
      
      console.log('📝 [DeliveryForm] Updated staged delivery:', {
        _tempId: updatedStaged._tempId,
        id: updatedStaged.id,
        patient_name: updatedStaged.patient_name,
        status: updatedStaged.status
      });
      
      return updatedStaged;
    }));

    setError(null);
    setEditingStagedId(null);
    setSelectedPatient(null);
    setPatientSearch('');
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

    if (stagedDeliveries.length === 0) {
      console.warn('[AddToRoute] ⚠️ No staged deliveries to save');
      hasLoadedPending.current = false; // Reset flag when closing without saves
      return;
    }

    // CRITICAL: Split into NEW deliveries (no id) and UPDATED deliveries (have id, status changed from pending)
    const newDeliveries = stagedDeliveries.filter((staged) => !staged.id);
    const updatedDeliveries = stagedDeliveries.filter((staged) => staged.id && staged.status !== 'pending');

    console.log('[AddToRoute] 🔍 Total staged:', stagedDeliveries.length, '| New:', newDeliveries.length, '| Updated:', updatedDeliveries.length, '| Unchanged pending:', stagedDeliveries.length - newDeliveries.length - updatedDeliveries.length);
    console.log('[AddToRoute] 🔍 New deliveries to save:', newDeliveries.map((s) => ({
      _tempId: s._tempId,
      patient_name: s.patient_name
    })));
    console.log('[AddToRoute] 🔍 Updated deliveries to save:', updatedDeliveries.map((s) => ({
      id: s.id,
      patient_name: s.patient_name,
      status: s.status
    })));

    if (newDeliveries.length === 0 && updatedDeliveries.length === 0) {
      console.log('[AddToRoute] ℹ️ No new or updated deliveries to save');
      console.log('[AddToRoute] 🚪 Calling onCancel to close form...');
      hasLoadedPending.current = false; // Reset flag to allow reload next time
      onCancel();
      console.log('[AddToRoute] ✅ onCancel called');
      return;
    }

    // Calculate sequential TR#s based on pickup TR# for each store/driver/AMPM group
    const calculateSequentialTRs = (deliveries) => {
      // Group by store_id + driver_id + ampm_deliveries (pickup group key)
      const groups = {};

      deliveries.forEach((del) => {
        const groupKey = `${del.store_id}_${del.driver_id}_${del.ampm_deliveries || 'AM'}`;
        if (!groups[groupKey]) {
          groups[groupKey] = {
            pickupTR: null,
            existingDeliveryCount: 0,
            deliveries: []
          };
        }
        groups[groupKey].deliveries.push(del);
      });

      // For each group, find the pickup's TR# and count existing deliveries
      Object.keys(groups).forEach((groupKey) => {
        const [storeId, driverId, ampm] = groupKey.split('_');

        // Find the pickup for this group in allDeliveries
        const existingPickup = allDeliveries?.find((d) =>
        d &&
        !d.patient_id &&
        d.store_id === storeId &&
        d.driver_id === driverId &&
        d.delivery_date === formData.delivery_date &&
        (d.ampm_deliveries || 'AM') === ampm
        );

        if (existingPickup && existingPickup.tracking_number !== undefined && existingPickup.tracking_number !== null && existingPickup.tracking_number !== '') {
          // Handle "00" and other string numbers correctly
          const baseTR = parseInt(existingPickup.tracking_number, 10);
          // Note: parseInt("00", 10) returns 0, which is valid
          groups[groupKey].pickupTR = isNaN(baseTR) ? null : baseTR;
          console.log(`[AddToRoute] 📍 Found pickup TR# ${groups[groupKey].pickupTR} for group ${groupKey} (raw: "${existingPickup.tracking_number}")`);
        }

        // Count existing deliveries for this group (already saved, not in new deliveries)
        const existingDeliveriesForGroup = allDeliveries?.filter((d) =>
        d &&
        d.patient_id && // Is a delivery, not pickup
        d.store_id === storeId &&
        d.driver_id === driverId &&
        d.delivery_date === formData.delivery_date &&
        (d.ampm_deliveries || 'AM') === ampm
        ) || [];

        groups[groupKey].existingDeliveryCount = existingDeliveriesForGroup.length;
        console.log(`[AddToRoute] 📊 Group ${groupKey} has ${existingDeliveriesForGroup.length} existing deliveries`);

        // If no pickup TR found, check staged deliveries for a pickup
        if (groups[groupKey].pickupTR === null) {
          const stagedPickup = stagedDeliveries.find((d) =>
          d &&
          !d.patient_id &&
          d.store_id === storeId &&
          d.driver_id === driverId &&
          (d.ampm_deliveries || 'AM') === ampm
          );
          if (stagedPickup && stagedPickup.tracking_number !== undefined && stagedPickup.tracking_number !== null && stagedPickup.tracking_number !== '') {
            const baseTR = parseInt(stagedPickup.tracking_number, 10);
            groups[groupKey].pickupTR = isNaN(baseTR) ? null : baseTR;
            console.log(`[AddToRoute] 📍 Found staged pickup TR# ${groups[groupKey].pickupTR} for group ${groupKey}`);
          }
        }

        // CRITICAL: Only default to 0 if pickupTR is still null (no pickup found at all)
        // DO NOT default if pickupTR is 0 from parseInt("00")
        if (groups[groupKey].pickupTR === null) {
          console.log(`[AddToRoute] ⚠️ No pickup TR# found for group ${groupKey}, using 99 for all deliveries in this group`);
        }
      });

      // Assign sequential TR#s starting from pickup TR# + existing count + 1
      const updatedDeliveries = deliveries.map((del) => {
        const groupKey = `${del.store_id}_${del.driver_id}_${del.ampm_deliveries || 'AM'}`;
        const group = groups[groupKey];

        // Only assign TR# to patient deliveries (not pickups)
        if (del.patient_id) {
          // CRITICAL: If no pickup TR found (still null), assign 99
          if (group.pickupTR === null) {
            console.log(`[AddToRoute] 🔢 ${del.patient_name}: TR# 99 (no pickup found for group ${groupKey})`);
            return {
              ...del,
              tracking_number: '99'
            };
          }

          // Find this delivery's index within NEW deliveries for this group (sorted by patient name)
          const newDeliveriesInGroup = [...group.deliveries].
          filter((d) => d.patient_id) // Only patient deliveries
          .sort((a, b) => (a.patient_name || '').localeCompare(b.patient_name || ''));

          const indexInNewDeliveries = newDeliveriesInGroup.findIndex((d) => d._tempId === del._tempId);
          // TR# = pickup TR + existing deliveries count + new delivery index + 1
          const newTR = group.pickupTR + group.existingDeliveryCount + indexInNewDeliveries + 1;

          console.log(`[AddToRoute] 🔢 ${del.patient_name}: TR# ${newTR} (pickup: ${group.pickupTR}, existing: ${group.existingDeliveryCount}, newIndex: ${indexInNewDeliveries})`);

          return {
            ...del,
            tracking_number: String(newTR)
          };
        }

        return del;
      });

      return updatedDeliveries;
    };

    const deliveriesWithTRs = calculateSequentialTRs(newDeliveries);

    // STEP 2: Re-number ALL existing deliveries for affected pickup groups
    const affectedGroups = new Set(newDeliveries.map((del) =>
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

      if (!existingPickup || existingPickup.tracking_number === undefined || existingPickup.tracking_number === null || existingPickup.tracking_number === '') {
        console.log(`[AddToRoute] ⚠️ No pickup found for group ${groupKey}, skipping existing delivery renumbering`);
        continue;
      }

      const pickupTR = parseInt(existingPickup.tracking_number, 10);
      const effectivePickupTR = isNaN(pickupTR) ? 0 : pickupTR;
      console.log(`[AddToRoute] 🔢 Using pickup TR# ${effectivePickupTR} for group ${groupKey} (raw: "${existingPickup.tracking_number}")`);


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

      // Re-assign sequential TR#s starting from pickup TR + 1
      existingDeliveriesInGroup.forEach((delivery, index) => {
        const correctTR = String(effectivePickupTR + index + 1);
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
      // First, update existing deliveries with corrected TR#s
      if (existingDeliveriesToUpdate.length > 0) {
        console.log(`[AddToRoute] 📝 Updating ${existingDeliveriesToUpdate.length} existing deliveries with corrected TR#s...`);
        for (const update of existingDeliveriesToUpdate) {
          await base44.entities.Delivery.update(update.id, { tracking_number: update.tracking_number });
        }
        console.log('[AddToRoute] ✅ Existing TR#s corrected');
      }

      // Second, update pending deliveries that had status changes (from "pending" to "in_transit")
      if (updatedDeliveries.length > 0) {
        console.log(`[AddToRoute] 📝 Updating ${updatedDeliveries.length} pending deliveries with status changes...`);
        for (const updated of updatedDeliveries) {
          console.log(`[AddToRoute] 🔄 Updating delivery ${updated.id}: ${updated.patient_name}`);
          console.log(`   - Old status: pending → New status: ${updated.status}`);
          console.log(`   - Tracking Number: ${updated.tracking_number}`);
          
          await base44.entities.Delivery.update(updated.id, {
            status: updated.status,
            delivery_notes: updated.delivery_notes || '',
            prescription_number: updated.prescription_number || '',
            cod_total_amount_required: updated.cod_total_amount_required || 0,
            delivery_instructions: updated.delivery_instructions || '',
            time_window_start: updated.time_window_start || '',
            time_window_end: updated.time_window_end || '',
            tracking_number: updated.tracking_number || '99'
          });
          console.log(`[AddToRoute] ✅ Updated pending delivery: ${updated.patient_name} → status: ${updated.status}`);
        }
        console.log('[AddToRoute] ✅ All pending deliveries updated');
      }

      // Then save new deliveries OR trigger data refresh
      if (newDeliveries.length > 0) {
        console.log('[AddToRoute] 📤 Calling Dashboard save handler with batch data...');
        await onSave({ _isBatchSave: true, _stagedDeliveries: deliveriesWithTRs });
        console.log('[AddToRoute] ✅ Batch save completed successfully');
      }
      
      // CRITICAL: Always trigger data refresh to show updated status changes
      if (updatedDeliveries.length > 0 && newDeliveries.length === 0) {
        console.log('[AddToRoute] 🔄 Triggering data refresh for status updates...');
        // Use invalidate and manual close instead of calling onSave with empty array
        const { invalidate } = await import('../utils/dataManager');
        invalidate('Delivery');
      }
      
      setStagedDeliveries([]);
      setProjectedDeliveries([]);
      onCancel(); // Always close after successful batch save
    } catch (err) {
      console.error('[AddToRoute] ❌ Batch save error:', err);
      setError(`Failed to save: ${err.message || 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  }, [stagedDeliveries, onSave, onCancel, allDeliveries, formData.delivery_date]);

  const handleSearchKeyDown = useCallback((e) => {
    if (!patientSearch) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredPatients.length > 0) {
        setHighlightedPatientIndex((prev) => prev < filteredPatients.length - 1 ? prev + 1 : prev);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedPatientIndex((prev) => prev > 0 ? prev - 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();

      if (highlightedPatientIndex >= 0 && filteredPatients.length > 0) {
        const selectedPat = filteredPatients[highlightedPatientIndex];
        if (selectedPat) {
          handlePatientSelect(selectedPat);
          setPatientSearch('');
          setHighlightedPatientIndex(-1);
        }
      } else if (filteredPatients.length === 0 && onCreatePatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher'))) {
        onCreatePatient((newPatient) => {
          handlePatientSelect(newPatient);
          setPatientSearch('');
        });
      } else if (!hasFormData) {
        if (buttonState === 'done') handleBatchSave();else
        if (buttonState === 'updateStaged' && isFormValid) handleUpdateStaged();else
        if (buttonState === 'add' && isFormValid) handleAddToStaging();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setPatientSearch('');
      setHighlightedPatientIndex(-1);
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
        const completionDateTime = new Date(`${dateStr}T${timeStr}:00`);
        dataToSave.actual_delivery_time = completionDateTime.toISOString();
      }

      // Check if status changed to a completion status (completed, cancelled, failed)
      const statusChangedToCompletion = delivery &&
      ['completed', 'cancelled', 'failed', 'returned'].includes(formData.status) &&
      delivery.status !== formData.status;

      await onSave(dataToSave);
      
      // CRITICAL: Always invalidate delivery cache after update to force refresh
      const { invalidate } = await import('../utils/dataManager');
      invalidate('Delivery');
      invalidate('Patient');

      // If status changed to completion, recalculate stop orders for remaining deliveries
      if (statusChangedToCompletion && delivery.driver_id && delivery.delivery_date) {
        console.log('[DeliveryForm] Status changed to completion, recalculating stop orders...');

        // Get all deliveries for this driver on this date that are NOT completed/cancelled/failed
        const remainingDeliveries = allDeliveries.filter((d) =>
        d &&
        d.id !== delivery.id &&
        d.delivery_date === delivery.delivery_date &&
        d.driver_id === delivery.driver_id &&
        !['completed', 'cancelled', 'failed', 'returned'].includes(d.status)
        );

        // Sort by current stop_order
        remainingDeliveries.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

        // Reassign sequential stop orders starting from 1
        for (let i = 0; i < remainingDeliveries.length; i++) {
          const newStopOrder = i + 1;
          if (remainingDeliveries[i].stop_order !== newStopOrder) {
            await base44.entities.Delivery.update(remainingDeliveries[i].id, { stop_order: newStopOrder });
            console.log(`[DeliveryForm] Updated stop_order for ${remainingDeliveries[i].patient_name || 'Pickup'}: ${remainingDeliveries[i].stop_order} -> ${newStopOrder}`);
          }
        }

        console.log(`[DeliveryForm] Recalculated stop orders for ${remainingDeliveries.length} remaining deliveries`);
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

      if (closeOnSave) onCancel();
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
    // Only show confirmation if there are NEW staged deliveries (without an id)
    const hasNewStagedDeliveries = stagedDeliveries.some((d) => !d.id);

    if (hasNewStagedDeliveries && !delivery) {
      const confirmed = window.confirm('You have unsaved deliveries. Discard them?');
      if (confirmed) {
        setStagedDeliveries([]);
        setProjectedDeliveries([]);
        hasLoadedPending.current = false; // Reset flag to allow reload
        onCancel();
      }
    } else {
      // CRITICAL: Reset the auto-load flag when canceling without changes
      // This allows the form to re-load pending deliveries next time
      if (!delivery) {
        hasLoadedPending.current = false;
      }
      onCancel();
    }
  }, [stagedDeliveries, onCancel, delivery]);

  useEffect(() => {
    const handleEnterKey = (event) => {
      if (event.key !== 'Enter') return;
      if (event.target.tagName === 'TEXTAREA') return;
      if (event.target.getAttribute('role') === 'combobox') return;
      if (event.target === patientSearchInputRef.current) return;

      event.preventDefault();
      
      // If editing an existing delivery, trigger submit (Update Delivery button)
      if (delivery && isFormValid && !isSaving) {
        handleSubmit(event);
        return;
      }
      
      // New delivery flow
      if (buttonState === 'done') handleBatchSave();
      else if (buttonState === 'updateStaged' && isFormValid) handleUpdateStaged();
      else if (buttonState === 'add' && isFormValid) handleAddToStaging();
    };

    document.addEventListener('keydown', handleEnterKey);
    return () => document.removeEventListener('keydown', handleEnterKey);
  }, [buttonState, isFormValid, handleAddToStaging, handleUpdateStaged, handleBatchSave, delivery, isSaving, handleSubmit]);

  useEffect(() => {
    const handleEscapeKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (delivery) {
          handleCancelClick();
        } else if (cancelButtonState === 'clear') {
          handleClearForm();
        } else {
          handleCancelClick();
        }
      }
    };

    document.addEventListener('keydown', handleEscapeKey);
    return () => document.removeEventListener('keydown', handleEscapeKey);
  }, [delivery, cancelButtonState, handleCancelClick, handleClearForm]);

  useEffect(() => {
    if (!delivery) {
      setTimeout(() => patientSearchInputRef.current?.focus(), 100);
    }
  }, [delivery]);

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
    window.addEventListener('keyup', handleKeyUp);

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
      const store = stores.find((s) => s && s.id === delivery.store_id);

      if (!patient || !store) return null;

      let distanceFromStore = null;
      if (patient?.latitude && patient?.longitude && store?.latitude && store?.longitude) {
        distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
      }

      // CRITICAL: If the delivery already has a PUID, find its parent pickup to get the correct AM/PM slot
      let timeSlot = delivery.ampm_deliveries; // First, use the delivery's own ampm_deliveries if set
      let puid = delivery.puid;

      if (puid) {
        // Find the parent pickup by PUID (stop_id)
        const parentPickup = allDeliveries.find((d) => d && !d.patient_id && d.stop_id === puid);
        if (parentPickup && parentPickup.ampm_deliveries) {
          timeSlot = parentPickup.ampm_deliveries;
          console.log(`📦 [AutoLoad] Delivery for ${delivery.patient_name} linked to pickup PUID ${puid}, using AM/PM: ${timeSlot}`);
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
        patient_name: delivery.patient_name || patient?.full_name || 'Unknown',
        store_name: store?.name || 'Unknown Store',
        store_abbreviation: store?.abbreviation || '',
        distanceFromStore: distanceFromStore,
        delivery_address: patient?.address || '',
        cod_total_amount_required: delivery.cod_total_amount_required || 0,
        cod_payments: delivery.cod_payments || [],
        ampm_deliveries: timeSlot,
        puid: puid || ''
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
      hasLoadedPending.current = true;
      console.log(`✅ [DeliveryForm] Auto-loaded ${newStagedItems.length} pending deliveries to staged list`);
    }, 100);
  }, [delivery, allDeliveries, currentUser, patients, stores, suggestedDate]);

  useEffect(() => {
    // Auto-update PUID when store changes for an existing delivery
    if (delivery && !isPickupMode && formData.store_id && formData.delivery_date && allDeliveries && stores) {
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

  const confirmAddProjectedToStaged = useCallback((projected) => {
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

    let distanceFromStore = null;
    if (patient.latitude && patient.longitude && store.latitude && store.longitude) {
      distanceFromStore = calculateDistance(store.latitude, store.longitude, patient.latitude, patient.longitude);
    }

    // Auto-select driver based on patient's store and time window
    let autoSelectedDriverId = '';
    let autoSelectedDriverName = '';

    const deliveryDate = formData.delivery_date ? new Date(formData.delivery_date + 'T00:00:00') : new Date();
    const dayOfWeek = deliveryDate.getDay();

    const deliveryAMPM = determineDeliveryAMPM(patient); // Changed here

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
    const timeSlot = getStoreAssignedTimeSlot(store, formData.delivery_date, allDeliveries);

    const autoDriverId = autoSelectedDriverId || formData.driver_id;
    const existingPickup = allDeliveries.find((d) =>
    d &&
    !d.patient_id &&
    d.store_id === projected.store_id &&
    d.delivery_date === formData.delivery_date &&
    d.driver_id === autoDriverId &&
    d.ampm_deliveries === timeSlot
    );

    if (existingPickup) {
      const now = new Date();
      const isNotCompleted = existingPickup.status !== 'completed';
      const wasCompletedRecently = existingPickup.actual_delivery_time &&
      now - new Date(existingPickup.actual_delivery_time) < 60 * 60 * 1000; // 60 minutes

      if (isNotCompleted || wasCompletedRecently) {
        puid = existingPickup.stop_id;
        console.log(`✅ [Projected] Using existing pickup PUID: ${puid} (status: ${existingPickup.status})`);
      }
    }

    if (!puid) {
      puid = getPickupStopIdForDelivery(store.id, formData.delivery_date, timeSlot, allDeliveries);
    }

    setStagedDeliveries((prev) => [...prev, {
      patient_id: projected.patient_id,
      patient_name: projected.patient_name,
      patient_phone: patient.phone || '',
      unit_number: patient.unit_number || '',
      delivery_date: formData.delivery_date,
      delivery_time_start: patient.time_window_start || '',
      delivery_time_end: patient.time_window_end || '',
      time_window_start: patient.time_window_start || '',
      time_window_end: patient.time_window_end || '',
      puid: puid || '',
      ampm_deliveries: timeSlot,
      status: 'Ready For Pickup',
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
      delivery_address: patient.address || ''
    }]);

    setProjectedDeliveries((prev) => prev.filter((p) => p.patient_id !== projected.patient_id));
  }, [formData, stores, patients, allDrivers, currentUser]);

  const sortedStagedDeliveries = useMemo(() => {
    return [...stagedDeliveries].sort((a, b) => {
      // First: Sort new staged (no id) to top, pending (with id) below
      const aIsPending = !!a.id;
      const bIsPending = !!b.id;

      if (!aIsPending && bIsPending) return -1;
      if (aIsPending && !bIsPending) return 1;

      const storeA = stores?.find((s) => s && s.id === a.store_id);
      const storeB = stores?.find((s) => s && s.id === b.store_id);

      // Second: Sort by store
      const sortOrderA = storeA?.sort_order ?? Infinity;
      const sortOrderB = storeB?.sort_order ?? Infinity;
      if (sortOrderA !== sortOrderB) {
        return sortOrderA - sortOrderB;
      }

      // Third: Sort by distance from store
      if (a.distanceFromStore !== null && b.distanceFromStore !== null) {
        return a.distanceFromStore - b.distanceFromStore;
      } else if (a.distanceFromStore !== null) {
        return -1;
      } else if (b.distanceFromStore !== null) {
        return 1;
      }

      return 0;
    });
  }, [stagedDeliveries, stores]);


  return (
    <div className={`fixed inset-0 z-[10010] overflow-hidden ${useFullscreen ? 'bg-white' : 'bg-black/60 flex items-center justify-center p-4'}`}>
      <motion.div ref={formRef} initial={{ opacity: 0, scale: useFullscreen ? 1 : 0.95 }} animate={{ opacity: 1, y: 0 }} className={`w-full ${useFullscreen ? 'h-full' : !delivery ? 'max-w-4xl max-h-[90vh]' : 'max-w-lg max-h-[90vh]'} flex`}>
        <Card className={`border-0 text-card-foreground bg-white flex flex-col w-full ${useFullscreen ? 'h-full' : 'rounded-xl border border-slate-200 shadow-xl'}`}>
          <CardHeader className="border-b border-slate-200 p-4 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Package className="w-5 h-5 text-emerald-600" />
                <CardTitle className="text-xl font-bold">
                  {delivery ? isPickupMode ? 'Edit Pickup' : 'Edit Delivery' : 'Add To Route'}
                </CardTitle>

                {!delivery &&
                <div className="flex gap-2 ml-4">
                    <Button
                    type="button"
                    variant={!isPickupMode ? "default" : "outline"}
                    size="sm"
                    onClick={() => setIsPickupMode(false)} className="bg-emerald-600 text-white px-3 text-xs font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow h-8 hover:bg-emerald-700">

                      Add Delivery
                    </Button>
                    <Button
                    type="button"
                    variant={isPickupMode ? "default" : "outline"}
                    size="sm"
                    onClick={() => setIsPickupMode(true)}
                    className={isPickupMode ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""}>
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

          {error && <div className="p-3 bg-red-100 text-red-700 text-sm text-center">Error: {error}</div>}

          <CardContent className="p-4 flex-1 relative overflow-hidden">
            <div className="space-y-3 h-full flex flex-col">
              {/* Section 1: Patient Search - STATIC */}
              <div className={`flex gap-3 ${useMobileLayout ? 'flex-wrap' : ''} ${!delivery && !useMobileLayout ? 'flex-shrink-0' : ''}`}>
                {!delivery && !isPickupMode &&
                <div className={`${useMobileLayout ? 'w-full' : 'flex-[2]'} space-y-1 relative bg-slate-50 p-3 rounded-lg border border-slate-200`}>
                    <div className="flex items-center justify-between mb-1">
                      <Label className="text-sm font-semibold">Patient Search</Label>
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
                              </>);

                      })()}
                        </div>
                    }
                    </div>
                    <div className="relative">
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

                    {patientSearch && !formData.patient_id &&
                  <div className="absolute top-full left-0 right-0 mt-1 max-h-64 overflow-y-auto border rounded-lg bg-white shadow-lg z-[100]">
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
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full mt-3 gap-2"
                        onClick={() => onCreatePatient((newPatient) => {
                          handlePatientSelect(newPatient);
                          setPatientSearch('');
                        })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            onCreatePatient((newPatient) => {
                              handlePatientSelect(newPatient);
                              setPatientSearch('');
                            });
                          }
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

                        return (
                          <div
                            key={patient.id}
                            id={`patient-item-${index}`}
                            className={`w-full text-left p-2 transition-colors text-sm flex items-start gap-2 ${isHighlighted ? 'bg-emerald-50 border-l-4 border-emerald-500' : 'hover:bg-slate-50'} ${isSelected ? 'bg-blue-50' : ''}`
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
                                if (e.shiftKey || e.ctrlKey || e.metaKey) {
                                  // Multi-select mode
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
                                  // Direct add
                                  handlePatientSelect(patient);
                                  setPatientSearch('');
                                  setHighlightedPatientIndex(-1);
                                }
                              }}
                              className="flex-1 text-left">
                                    <div className="font-medium truncate flex items-center gap-1.5">
                                      {patient.full_name}
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
                                    {patient.phone && <div className="text-xs text-slate-500 truncate">{patient.phone}</div>}
                                  </button>
                                </div>);

                      })}
                          </div>
                    }
                      </div>
                  }
                  </div>
                }

                {/* Section 2: Pickup Location (for pickup mode) - STATIC */}
                {isPickupMode && !delivery &&
                <div className={`${useMobileLayout ? 'w-full' : 'flex-[2]'} space-y-1 bg-slate-50 p-3 rounded-lg border border-slate-200`}>
                    <Label className="text-sm font-semibold">Pickup Location *</Label>
                    <Select
                    value={selectedPickupOption}
                    onValueChange={(value) => {
                      setSelectedPickupOption(value);
                      const selectedStore = availableStores.find((s) => s.id === value);
                      const storeId = selectedStore?._originalStoreId || value;
                      const timeSlot = selectedStore?._timeSlot || null;

                      // Calculate new PUID based on selected store and time slot
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

                {/* Section 2: Delivery Date - STATIC */}
                <div className={`${useMobileLayout ? 'w-[calc(50%-0.375rem)]' : 'flex-1'} space-y-1 bg-slate-50 p-3 rounded-lg border border-slate-200`}>
                  <Label className="text-sm font-semibold">Delivery Date *</Label>
                  <Input
                    type="date"
                    value={formData.delivery_date}
                    onChange={(e) => setFormData((prev) => ({ ...prev, delivery_date: e.target.value }))}
                    disabled={isSaving}
                    className="h-9" />

                </div>

                {/* Section 3: Driver Selection - STATIC */}
                <div className={`${useMobileLayout ? 'w-[calc(50%-0.375rem)]' : 'flex-1'} space-y-1 bg-slate-50 p-3 rounded-lg border border-slate-200`}>
                  <Label className="text-sm font-semibold">Driver *</Label>
                  <Select
                    value={formData.driver_id || ''}
                    onValueChange={(driverId) => {
                      const driver = allDrivers.find((d) => d.id === driverId);
                      setFormData((prev) => ({
                        ...prev,
                        driver_id: driverId,
                        driver_name: driver ? getDriverNameForStorage(driver) : ''
                      }));
                    }}
                    disabled={isSaving}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select driver" />
                    </SelectTrigger>
                    <SelectContent className="z-[999999]">
                      {allDrivers.map((driver) =>
                      <SelectItem key={driver.id} value={driver.id}>
                          {getDriverDisplayName(driver)}
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isAppOwner(currentUser) && delivery &&
              <div className="space-y-1 bg-slate-100 p-3 rounded-lg border border-slate-200">
                    <Label className="text-sm font-semibold">Delivery Identifiers</Label>
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
                    </div>
                </div>
              }

              {/* Scrollable container for Sections 4 & 5 on desktop */}
              <div className={`flex gap-3 max-w-full ${delivery || useMobileLayout ? 'overflow-y-auto flex-1' : 'flex-1 min-h-0 overflow-hidden'}`}>
                <div className={`flex flex-col gap-3 ${delivery || useMobileLayout ? 'flex-1' : 'flex-[13] overflow-y-auto'} ${isFormDisabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  
                  {/* Section 1: Notes */}
                  <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                    {!isPickupMode ?
                    <div className="flex gap-3">
                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold">Patient Notes</Label>
                          <Textarea
                          value={formData.delivery_instructions || selectedPatient?.notes || ''}
                          onChange={(e) => setFormData((prev) => ({ ...prev, delivery_instructions: e.target.value }))}
                          placeholder="Patient delivery instructions..."
                          className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm h-[100px] text-sm resize-none"
                          disabled={isSaving} />
                        </div>

                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold">Driver Notes</Label>
                          <Textarea
                          value={formData.delivery_notes}
                          onChange={(e) => setFormData((prev) => ({ ...prev, delivery_notes: e.target.value }))}
                          placeholder="Driver notes for this delivery..."
                          className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm h-[100px] text-sm resize-none"
                          disabled={isSaving} />
                        </div>
                      </div> :
                    <div className="space-y-1">
                        <Label className="text-sm font-semibold">Pickup Notes</Label>
                        <Textarea
                        value={formData.delivery_notes}
                        onChange={(e) => setFormData((prev) => ({ ...prev, delivery_notes: e.target.value }))}
                        placeholder="Notes for this pickup..."
                        className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm h-[100px] text-sm resize-none"
                        disabled={isSaving} />
                      </div>
                    }
                  </div>

                  {/* Section 2: Delivery Options & COD */}
                  {!isPickupMode &&
                  <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                      <div className="flex gap-3">
                        <div className="flex gap-3">
                          <div className="flex-1 space-y-2">
                            <Label className="text-sm font-semibold">Delivery Options</Label>
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

                          {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                        <div className="flex-1 space-y-2">
                              <Label className="text-sm font-semibold">COD</Label>
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
                        }
                        </div>
                      </div>
                    </div>
                  }

                  {/* Section 3: Store/Status/Time Windows - Only visible to dispatchers and admins */}
                  {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                  <div className={`space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-200 ${
                    delivery && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') &&
                    ['completed', 'failed', 'returned', 'cancelled', 'in_transit', 'en_route'].includes(formData.status)
                      ? 'opacity-50 pointer-events-none' : ''
                  }`}>
                    <div className="flex gap-3">
                      <div className="flex-1 space-y-1">
                        <Label className="text-sm font-semibold">{isPickupMode ? 'Pickup Store *' : 'Store *'}</Label>
                        <Select
                          value={(() => {
                            // For stores with AM/PM variants, find the correct variant based on store_id and ampm_deliveries
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

                            // Calculate new PUID based on selected store and time slot
                            const newPuid = getPickupStopIdForDelivery(storeId, formData.delivery_date, timeSlot || 'AM', allDeliveries);

                            setFormData((prev) => ({
                              ...prev,
                              store_id: storeId,
                              ampm_deliveries: timeSlot || prev.ampm_deliveries,
                              puid: newPuid || ''
                            }));
                            // Update pickup option if in pickup mode
                            if (isPickupMode) {
                              setSelectedPickupOption(value);
                            }
                          }}
                          disabled={isSaving || isPickupMode && delivery}>
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

                      <div className="flex-1 space-y-1">
                        <Label className="text-sm font-semibold">{isPickupMode ? 'Pickup Status' : 'Delivery Status'}</Label>
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
                          <SelectContent className="z-[999999]">
                            <SelectItem value="pending">Pending</SelectItem>
                            <SelectItem value="Ready For Pickup">Ready For Pickup</SelectItem>
                            {isPickupMode ?
                            <SelectItem value="en_route">En Route</SelectItem> :
                            <SelectItem value="in_transit">In Transit</SelectItem>
                            }
                            <SelectItem value="completed">Completed</SelectItem>
                            {isPickupMode ?
                            <SelectItem value="cancelled">Cancelled</SelectItem> :
                            <>
                                <SelectItem value="failed">Failed</SelectItem>
                                <SelectItem value="returned">Returned</SelectItem>
                              </>
                            }
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {isCompletionStatus && delivery ?
                    <div className="space-y-1">
                        <Label className="text-sm font-semibold">Completion Time *</Label>
                        <Input
                        type="time"
                        value={completionTime}
                        onChange={(e) => setCompletionTime(e.target.value)}
                        disabled={isSaving}
                        className="h-9 text-sm" />
                      </div> :

                    <div className="space-y-1">
                        <Label className="text-sm font-semibold">Time Windows</Label>
                        <div className="flex gap-3">
                          <div className="flex-1 relative">
                            <Input
                            type="time"
                            value={formData.time_window_start}
                            onChange={(e) => setFormData((prev) => ({ ...prev, time_window_start: e.target.value }))}
                            disabled={isSaving}
                            placeholder="Start"
                            className="h-9 text-sm pr-8" />
                            {formData.time_window_start &&
                          <button
                            type="button"
                            onClick={() => setFormData((prev) => ({ ...prev, time_window_start: '' }))}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                            disabled={isSaving}>
                                <X className="w-3.5 h-3.5" />
                              </button>
                          }
                          </div>

                          <div className="flex-1 relative">
                            <Input
                            type="time"
                            value={formData.time_window_end}
                            onChange={(e) => setFormData((prev) => ({ ...prev, time_window_end: e.target.value }))}
                            disabled={isSaving}
                            placeholder="End"
                            className="h-9 text-sm pr-8" />
                            {formData.time_window_end &&
                          <button
                            type="button"
                            onClick={() => setFormData((prev) => ({ ...prev, time_window_end: '' }))}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                            disabled={isSaving}>
                                <X className="w-3.5 h-3.5" />
                              </button>
                          }
                          </div>
                        </div>
                      </div>
                    }
                  </div>
                  }

                  {/* Section 4: Patient Name/Phone/Address/Unit */}
                  {!isPickupMode &&
                  <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                      <div className="flex gap-3">
                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold">Patient Name *</Label>
                          <Input
                          value={formData.patient_name}
                          onChange={(e) => setFormData((prev) => ({ ...prev, patient_name: e.target.value }))}
                          placeholder="Patient name"
                          disabled={isSaving}
                          className="h-9 text-sm" />
                        </div>

                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold">Phone</Label>
                          <PhoneInput
                          value={formData.patient_phone}
                          onChange={(value) => setFormData((prev) => ({ ...prev, patient_phone: value }))}
                          disabled={isSaving}
                          className="h-9 text-sm" />
                        </div>
                      </div>

                      <div className="flex gap-3">
                        <div className="flex-[65] space-y-1">
                          <Label className="text-sm font-semibold">Patient Address</Label>
                          <Input
                          value={selectedPatient?.address || ''}
                          disabled
                          placeholder="Address from patient record"
                          className="bg-white h-9 text-sm" />
                        </div>

                        <div className="flex-[35] space-y-1">
                          <Label className="text-sm font-semibold">Unit #</Label>
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

                  {/* Section 5: Patient Preferences & Recurring */}
                  {!isPickupMode &&
                  <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                      <div className="flex gap-3">
                        <div className="flex-1 space-y-2">
                          <Label className="text-sm font-semibold">Patient Preferences</Label>
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

                        <div className="flex-1 space-y-2 relative">
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

                  {isPickupMode &&
                  <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                      <Label className="text-sm font-semibold">Pickup Options</Label>
                      <div className="space-y-3">
                        <CheckboxField
                        id="after_hours_pickup"
                        label="After Hours Pickup"
                        checked={formData.after_hours_pickup}
                        onChange={(checked) => setFormData((prev) => ({ ...prev, after_hours_pickup: checked }))}
                        disabled={isSaving} />
                      </div>
                    </div>
                  }
                </div>

                {/* Staged Panel - STATIC */}
                {!delivery && !useMobileLayout &&
                <div className="w-[21rem] flex-shrink-0 bg-slate-50 p-3 rounded-lg border-2 border-slate-400 flex flex-col h-full">
                    <Label className="text-sm font-semibold mb-2">Staged: (S: {stagedDeliveries.length} P: {projectedDeliveries.length})</Label>
                    <div className="space-y-1 flex-1 overflow-y-auto min-h-0">
                      {sortedStagedDeliveries.map((staged) => {
                      const stagedStore = stores?.find((s) => s && s.id === staged.store_id);
                      const storeColor = stagedStore ? getStoreColor(stagedStore) : '#64748b';
                      const fadedBgColor = hexToRgba(storeColor, 0.1);
                      const isPendingStop = !!staged.id;

                      return (
                        <div
                          key={staged._tempId}
                          className={`flex flex-col p-2 rounded border text-xs cursor-pointer transition-colors ${editingStagedId === staged._tempId ? 'border-blue-300' : 'hover:bg-slate-50'}`
                          }
                          style={{
                            backgroundColor: editingStagedId === staged._tempId ? hexToRgba(storeColor, 0.2) : fadedBgColor
                          }}
                          onClick={() => handleStagedDeliveryClick(staged)}>

                            <div className="flex items-start justify-between">
                              <div className="flex-1 min-w-0">
                                <div className="font-medium flex items-center gap-1.5 min-w-0 w-full">
                                  <span className="truncate flex-shrink min-w-0">{staged.patient_name}</span>
                                  <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
                                    {staged.store_abbreviation && shouldShowStoreBadges(currentUser) &&
                                  <Badge
                                    className="text-white text-[10px] px-1.5 py-0 h-4"
                                    style={{ backgroundColor: storeColor }}>
                                        {staged.store_abbreviation}
                                      </Badge>
                                  }
                                    {staged.distanceFromStore !== null &&
                                  <Badge
                                    className="text-white text-[10px] px-1.5 py-0 h-4"
                                    style={{
                                      backgroundColor: staged.distanceFromStore <= 10 ? '#10b981' :
                                      staged.distanceFromStore <= 15 ? '#f59e0b' : '#ef4444'
                                    }}>
                                        {staged.distanceFromStore.toFixed(1)} km
                                      </Badge>
                                  }
                                  </div>
                                </div>
                              </div>
                              <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-5 w-5 p-0 text-red-600 flex-shrink-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (staged.id) {
                                  setDeleteConfirmation({ show: true, staged });
                                } else {
                                  if (staged._wasProjected && staged._originalProjected) {
                                    setProjectedDeliveries((prev) => [...prev, staged._originalProjected]);
                                  }
                                  setStagedDeliveries((prev) => prev.filter((item) => item._tempId !== staged._tempId));
                                  if (editingStagedId === staged._tempId) {
                                    setEditingStagedId(null);
                                    handleClearForm();
                                  }
                                  // Trigger projections refresh after removing staged item
                                  setPredictionTrigger((prev) => prev + 1);
                                }
                              }}>
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                            {/* Second row: Address on left, badges on right */}
                            <div className="flex items-center justify-between">
                              <div className="text-slate-600 truncate flex-1 min-w-0">{staged.delivery_address}</div>
                              {(staged.cod_total_amount_required > 0 || staged.first_delivery || staged.oversized || staged.fridge_item || staged.signature_needed || staged.ampm_deliveries) &&
                            <div className="flex items-center gap-1 flex-shrink-0 ml-1">
                                  {(staged.cod_total_amount_required > 0 || staged.first_delivery || staged.oversized || staged.fridge_item || staged.signature_needed) &&
                              <Badge className="bg-yellow-400 text-black text-[10px] px-1.5 py-0 h-4 font-bold">
                                      {staged.cod_total_amount_required > 0 && '$'}
                                      {staged.first_delivery && (staged.cod_total_amount_required > 0 ? ' N' : 'N')}
                                      {staged.oversized && (staged.cod_total_amount_required > 0 || staged.first_delivery ? ' O' : 'O')}
                                      {staged.fridge_item && (staged.cod_total_amount_required > 0 || staged.first_delivery || staged.oversized ? ' F' : 'F')}
                                      {staged.signature_needed && (staged.cod_total_amount_required > 0 || staged.first_delivery || staged.oversized || staged.fridge_item ? ' S' : 'S')}
                                    </Badge>
                              }
                                  {staged.ampm_deliveries &&
                              <Badge className={`text-[10px] px-1.5 py-0 h-4 ${staged.ampm_deliveries === 'AM' ? 'bg-sky-100 text-sky-700 rounded-full' : 'bg-indigo-100 text-indigo-700 rounded-lg'}`}>
                                      {staged.ampm_deliveries}
                                    </Badge>
                              }
                                </div>
                            }
                            </div>
                          </div>);

                    })}

                      {projectedDeliveries.map((projected) => {
                      const projectedStore = stores?.find((s) => s && s.id === projected.store_id);
                      const storeColor = projectedStore ? getStoreColor(projectedStore) : '#64748b';

                      return (
                        <div
                          key={`proj-${projected.patient_id}`}
                          className="flex items-start justify-between p-2 rounded border border-yellow-400 bg-yellow-50 text-xs transition-colors">

                            <div className="flex-1 min-w-0">
                              <div className="font-medium flex items-center gap-1.5 min-w-0 w-full">
                                <span className="truncate flex-shrink min-w-0">{projected.patient_name}</span>
                                <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
                                  {projectedStore?.abbreviation && shouldShowStoreBadges(currentUser) &&
                                <Badge
                                  className="text-white text-[10px] px-1.5 py-0 h-4"
                                  style={{ backgroundColor: storeColor }}>
                                      {projectedStore.abbreviation}
                                    </Badge>
                                }
                                  <Badge className="bg-yellow-500 text-white text-[10px] px-1.5 py-0 h-4">PROJ</Badge>
                                </div>
                              </div>
                              <div className="text-slate-600 text-[10px] mt-0.5 truncate">{projected.reason}</div>
                            </div>
                            <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-5 w-5 p-0 text-emerald-600 flex-shrink-0 hover:bg-emerald-100"
                            onClick={() => confirmAddProjectedToStaged(projected)}
                            title="Add to route">

                              <Plus className="w-3 h-3" />
                            </Button>
                          </div>);

                    })}

                      {isLoadingPredictions &&
                    <div className="p-4 text-center text-slate-500 text-xs flex items-center justify-center gap-2">
                          <div className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full"></div>
                          Analyzing patterns...
                        </div>
                    }

                      {!isLoadingPredictions && stagedDeliveries.length === 0 && projectedDeliveries.length === 0 &&
                    <div className="p-4 text-center text-slate-400 text-xs">
                          No deliveries staged yet
                        </div>
                    }
                    </div>
                    
                    {/* Refresh Projections Button */}
                    <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full mt-2 text-xs"
                    onClick={() => setPredictionTrigger((prev) => prev + 1)}
                    disabled={isLoadingPredictions}>
                      {isLoadingPredictions ? 'Analyzing...' : 'Refresh Projections'}
                    </Button>
                  </div>
                }
              </div>
            </div>

            {/* Mobile Staged Panel */}
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
                  className="absolute right-0 top-0 bottom-0 w-[75%] bg-white shadow-2xl flex flex-col">
                    
                    <div className="border-b p-4 flex items-center justify-between bg-slate-50">
                      <h3 className="text-lg font-semibold">Staged: (S: {stagedDeliveries.length} P: {projectedDeliveries.length})</h3>
                      <Button variant="ghost" size="icon" onClick={() => setShowStagedPanel(false)}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>

                    <div className="flex-1 overflow-y-auto p-3 space-y-1">
                      {sortedStagedDeliveries.map((staged) => {
                      const stagedStore = stores?.find((s) => s && s.id === staged.store_id);
                      const storeColor = stagedStore ? getStoreColor(stagedStore) : '#64748b';
                      const fadedBgColor = hexToRgba(storeColor, 0.1);
                      const isPendingStop = !!staged.id;

                      return (
                        <div
                          key={staged._tempId}
                          className={`flex flex-col p-2 rounded border text-xs cursor-pointer transition-colors ${editingStagedId === staged._tempId ? 'border-blue-300' : 'hover:bg-slate-50'}`
                          }
                          style={{
                            backgroundColor: editingStagedId === staged._tempId ? hexToRgba(storeColor, 0.2) : fadedBgColor
                          }}
                          onClick={() => handleStagedDeliveryClick(staged)}>

                            <div className="flex items-start justify-between">
                              <div className="flex-1 min-w-0">
                                <div className="font-medium flex items-center gap-1.5 min-w-0 w-full">
                                  <span className="truncate flex-shrink min-w-0">{staged.patient_name}</span>
                                  <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
                                    {staged.store_abbreviation && shouldShowStoreBadges(currentUser) &&
                                  <Badge
                                    className="text-white text-[10px] px-1.5 py-0 h-4"
                                    style={{ backgroundColor: storeColor }}>
                                        {staged.store_abbreviation}
                                      </Badge>
                                  }
                                    {staged.distanceFromStore !== null &&
                                  <Badge
                                    className="text-white text-[10px] px-1.5 py-0 h-4"
                                    style={{
                                      backgroundColor: staged.distanceFromStore <= 10 ? '#10b981' :
                                      staged.distanceFromStore <= 15 ? '#f59e0b' : '#ef4444'
                                    }}>
                                        {staged.distanceFromStore.toFixed(1)} km
                                      </Badge>
                                  }
                                  </div>
                                </div>
                              </div>
                              <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-5 w-5 p-0 text-red-600 flex-shrink-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                if (staged.id) {
                                  setDeleteConfirmation({ show: true, staged });
                                } else {
                                  if (staged._wasProjected && staged._originalProjected) {
                                    setProjectedDeliveries((prev) => [...prev, staged._originalProjected]);
                                  }
                                  setStagedDeliveries((prev) => prev.filter((item) => item._tempId !== staged._tempId));
                                  if (editingStagedId === staged._tempId) {
                                    setEditingStagedId(null);
                                    handleClearForm();
                                  }
                                  // Trigger projections refresh after removing staged item
                                  setPredictionTrigger((prev) => prev + 1);
                                }
                              }}>
                                <Trash2 className="w-3 h-3" />
                              </Button>
                            </div>
                            {/* Second row: Address on left, badges on right */}
                            <div className="flex items-center justify-between">
                              <div className="text-slate-600 truncate flex-1 min-w-0">{staged.delivery_address}</div>
                              {(staged.cod_total_amount_required > 0 || staged.first_delivery || staged.oversized || staged.fridge_item || staged.signature_needed || staged.ampm_deliveries) &&
                            <div className="flex items-center gap-1 flex-shrink-0 ml-1">
                                  {(staged.cod_total_amount_required > 0 || staged.first_delivery || staged.oversized || staged.fridge_item || staged.signature_needed) &&
                              <Badge className="bg-yellow-400 text-black text-[10px] px-1.5 py-0 h-4 font-bold">
                                      {staged.cod_total_amount_required > 0 && '$'}
                                      {staged.first_delivery && (staged.cod_total_amount_required > 0 ? ' N' : 'N')}
                                      {staged.oversized && (staged.cod_total_amount_required > 0 || staged.first_delivery ? ' O' : 'O')}
                                      {staged.fridge_item && (staged.cod_total_amount_required > 0 || staged.first_delivery || staged.oversized ? ' F' : 'F')}
                                      {staged.signature_needed && (staged.cod_total_amount_required > 0 || staged.first_delivery || staged.oversized || staged.fridge_item ? ' S' : 'S')}
                                    </Badge>
                              }
                                  {staged.ampm_deliveries &&
                              <Badge className={`text-[10px] px-1.5 py-0 h-4 ${staged.ampm_deliveries === 'AM' ? 'bg-sky-100 text-sky-700 rounded-full' : 'bg-indigo-100 text-indigo-700 rounded-lg'}`}>
                                      {staged.ampm_deliveries}
                                    </Badge>
                              }
                                </div>
                            }
                            </div>
                          </div>);

                    })}

                      {projectedDeliveries.map((projected) => {
                      const projectedStore = stores?.find((s) => s && s.id === projected.store_id);
                      const storeColor = projectedStore ? getStoreColor(projectedStore) : '#64748b';

                      return (
                        <div
                          key={`proj-${projected.patient_id}`}
                          className="flex items-start justify-between p-2 rounded border border-yellow-400 bg-yellow-50 text-xs transition-colors">
                            <div className="flex-1 min-w-0">
                              <div className="font-medium flex items-center gap-1.5 min-w-0 w-full">
                                <span className="truncate flex-shrink min-w-0">{projected.patient_name}</span>
                                <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
                                  {projectedStore?.abbreviation && shouldShowStoreBadges(currentUser) &&
                                <Badge
                                  className="text-white text-[10px] px-1.5 py-0 h-4"
                                  style={{ backgroundColor: storeColor }}>
                                      {projectedStore.abbreviation}
                                    </Badge>
                                }
                                  <Badge className="bg-yellow-500 text-white text-[10px] px-1.5 py-0 h-4">PROJ</Badge>
                                </div>
                              </div>
                              <div className="text-slate-600 text-[10px] mt-0.5 truncate">{projected.reason}</div>
                            </div>
                            <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-5 w-5 p-0 text-emerald-600 flex-shrink-0 hover:bg-emerald-100"
                            onClick={() => confirmAddProjectedToStaged(projected)}
                            title="Add to route">
                              <Plus className="w-3 h-3" />
                            </Button>
                          </div>);

                    })}

                      {isLoadingPredictions &&
                    <div className="p-4 text-center text-slate-500 text-xs flex items-center justify-center gap-2">
                          <div className="animate-spin w-3 h-3 border-2 border-slate-300 border-t-transparent rounded-full"></div>
                          Analyzing patterns...
                        </div>
                    }

                      {!isLoadingPredictions && stagedDeliveries.length === 0 && projectedDeliveries.length === 0 &&
                    <div className="p-4 text-center text-slate-400 text-xs">
                          No deliveries staged yet
                        </div>
                    }
                    </div>
                  </motion.div>
                </motion.div>
              }
            </AnimatePresence>
          </CardContent>

          <CardFooter className="border-t p-3 bg-slate-50 flex-shrink-0">
            <div className="flex items-center justify-between w-full gap-4">
              {!delivery && useMobileLayout &&
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowStagedPanel(!showStagedPanel)}
                className="gap-2">
                  <Package className="w-4 h-4" />
                  Staged: (S: {stagedDeliveries.length} P: {projectedDeliveries.length})
                </Button>
              }
              <div className="flex gap-2 ml-auto">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={delivery ? handleCancelClick : cancelButtonState === 'clear' ? handleClearForm : handleCancelClick}
                  disabled={isSaving}>
                  {delivery ? 'Cancel' : cancelButtonState === 'clear' ? 'Clear' : 'Cancel'}
                </Button>

                {buttonState === 'done' ?
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleBatchSave()}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                  disabled={isSaving || stagedDeliveries.length === 0}>
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
                  onClick={handleUpdateStaged}
                  className="bg-blue-600 hover:bg-blue-700 gap-2"
                  disabled={isSaving || !isFormValid}>
                      <Edit2 className="w-4 h-4" />
                      Update
                    </Button> :
                buttonState === 'add' ?
                <Button
                  type="button"
                  size="sm"
                  onClick={handleAddToStaging}
                  className="bg-blue-600 hover:bg-blue-700 gap-2"
                  disabled={isSaving || !isFormValid}>
                        <Plus className="w-4 h-4" />
                        Add
                      </Button> :

                <Button
                  type="submit"
                  size="sm"
                  onClick={handleSubmit}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
                  disabled={isSaving || !isFormValid}>
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
    </div>);

}