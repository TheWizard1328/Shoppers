import DeliveryFormView from './DeliveryFormView';
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { buildInTransitDirectSaveData } from './inTransitDirectSave';
import { format } from "date-fns";
import { formatPhoneNumber } from '../utils/phoneFormatter';
import PatientMatchPopup from './PatientMatchPopup';
import { sortUsers } from "../utils/sorting";
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { getDriverDisplayName, getDriverNameForStorage } from '../utils/driverUtils';
import { PhoneInput } from "@/components/ui/phone-input";
import { determineDeliveryAMPM, getStoreAssignedTimeSlot, getStoreAssignedTimeSlotForDriver, getPickupStopIdForDelivery } from '../utils/ampmUtils';
import { base44 } from "@/api/base44Client";
import { useAppData } from '../utils/AppDataContext';
import { getUserAgentInfo } from '../utils/deviceUtils';
import { shouldShowStoreBadges, isAppOwner } from '../utils/userRoles';
import {
  createPatient as createPatientLocal,
  updatePatient as updatePatientLocal,
  createDelivery as createDeliveryLocal,
  updateDelivery as updateDeliveryLocal,
  deleteDelivery as deleteDeliveryLocal
} from '../utils/entityMutations';
import { checkPayrollLock } from '../utils/payrollLockManager';
import { buildPatientUpdatePayload } from '../utils/patientUpdateHelper';
import { triggerSquareCodCreate, triggerSquareCodDelete, triggerPatientLastDeliverySync } from '../utils/directDeliverySideEffects';
import useDeliveryProjectionManager from './useDeliveryProjectionManager';
import { runDeliverySubmitSideEffects } from './deliverySubmitSideEffects';
import { resolvePatientDriverAssignment, buildSelectedPatientFormData, buildDuplicatePatientDraft, buildNewAddressPatientDraft } from './deliveryPatientSelectionHelpers';
import { resetDraftEditorState, cleanupDetachedAutoCreatedPickups } from './deliveryDraftStateHelpers';
import { filterPendingDeliveriesForUser, mapPendingDeliveriesToStaged } from './deliveryPendingLoadHelpers';
import { scanPrescriptionLabel, handlePrescriptionScanResult } from './prescriptionScanHelpers';
import { resolveProjectedDeliveryDriver, buildProjectedStagedItem } from './projectedDeliveryHelpers';
import { prepareDeliverySaveData, buildPickupSnapshot, getDeliverySubmitFlags } from './deliverySubmitHelpers';
import { resolveDistanceFromStore, buildPickupStagedDelivery, buildPatientStagedDelivery } from './deliveryStagingHelpers';
import { closeDeliveryFormAfterSave } from '../utils/deliveryFormActionHelpers';
import { resolveDefaultDriverForNewDelivery, expandStoresForTimeSlots } from './deliveryStoreResolutionHelpers';
import { createPatientFromDraft, resolvePickupPuid, resolvePickupTimeWindow } from './deliveryAddHelpers';
import { useConfirmDelete } from './useConfirmDelete';
import useFreshStores from './useFreshStores';
import { buildRecurringLabel } from './recurringLabels';
import { sortFilteredPatients } from './patientSearchSorter';
import { resumeDeliveryFormManagers } from './resumeDeliveryFormManagers';
import { clearRecurringSelection } from './recurringHelpers';
import { handleBatchSave as runHandleBatchSave } from './handleBatchSave';

const CheckboxField = ({ id, label, checked, onChange, disabled }) => (<div className="flex items-center space-x-2"><Checkbox id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} /><Label htmlFor={id} className={`text-sm font-medium leading-none ${disabled ? 'text-slate-400' : ''}`}>{label}</Label></div>);

const statusColorMap = { 'Staged': 'text-purple-700 bg-purple-100 border-purple-200', 'pending': 'text-slate-500 bg-slate-100 border-slate-200', 'Ready For Pickup': 'text-amber-700 bg-amber-100 border-amber-200', 'in_transit': 'text-blue-700 bg-blue-100 border-blue-100', 'completed': 'text-emerald-700 bg-emerald-100 border-emerald-200', 'failed': 'text-red-700 bg-red-100 border-red-200', 'cancelled': 'text-red-700 bg-red-100 border-red-200', 'en_route': 'text-blue-700 bg-blue-100 border-blue-100', 'returned': 'text-red-700 bg-red-100 border-red-200' };
const getStatusColorClass = (status) => statusColorMap[status] || 'text-slate-700 bg-slate-100 border-slate-200';

const userHasRole = (user, role) => {
  if (!user || !role) return false;
  if (Array.isArray(user.app_roles)) return user.app_roles.includes(role);
  if (user.app_role === role) return true;
  return false;
};

const sortStores = (stores) => {
  if (!stores) return [];
  return [...stores].sort((a, b) => { const sA = a.sort_order ?? Infinity; const sB = b.sort_order ?? Infinity; return sA !== sB ? sA - sB : (a.name || '').localeCompare(b.name || ''); });
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
  onCreatePatient,
  openMode = null,
  forceOpenDriverOnLoad = false
}) {
  const { setIsFormOverlayOpen } = useAppData();
  const freshStores = useFreshStores(stores);

  const allDrivers = useMemo(() => {
    // Layout already filters drivers correctly via getActiveDriversForCity
    // Just ensure they have user_name - no additional role filtering needed
    const sorted = sortUsers(drivers || []);
    return sorted.filter((driver) => driver && driver.user_name);
  }, [drivers]);

  const [formData, setFormData] = useState(() => {
    const initialState = {
      patient_id: initialPatientId || "",
      delivery_date: suggestedDate || format(new Date(), 'yyyy-MM-dd'),
      delivery_time_start: "", delivery_time_end: "", delivery_time_eta: "",
      time_window_start: "", time_window_end: "", status: openMode === 'add_to_route' ? "pending" : "Staged",
      driver_name: "", driver_id: "", prescription_number: "",
      delivery_instructions: "", delivery_notes: "",
      cod_total_amount_required: 0, cod_payments: [],
      cod_payment_type: "No Payment", cod_amount: "",
      tracking_number: "", delivery_stop_id: "", stop_id: "", puid: "",
      paid_km_override: null,
      patient_name: (initialPatientId && Array.isArray(patients) ? (patients.find(pt=>pt&&pt.id===initialPatientId)?.full_name || "") : ""), patient_phone: (initialPatientId && Array.isArray(patients) ? (patients.find(pt=>pt&&pt.id===initialPatientId)?.phone || "") : ""), unit_number: (initialPatientId && Array.isArray(patients) ? (patients.find(pt=>pt&&pt.id===initialPatientId)?.unit_number || "") : ""), store_phone: "", store_id: (initialPatientId && Array.isArray(patients) ? (patients.find(pt=>pt&&pt.id===initialPatientId)?.store_id || "") : ""),
      mailbox_ok: false, call_upon_arrival: false, ring_bell: false,
      dont_ring_bell: false, back_door: false, signature_needed: false,
      fridge_item: false, oversized: false, after_hours_pickup: false, no_charge: false, extra_time: 0,
      barcode_values: [], receipt_barcode_values: [],
      recurring: false, recurring_daily: false,
      recurring_weekly_mon: false, recurring_weekly_tue: false, recurring_weekly_wed: false,
      recurring_weekly_thu: false, recurring_weekly_fri: false, recurring_weekly_sat: false,
      recurring_weekly_sun: false, recurring_biweekly: false, recurring_weekly_x4: false,
      recurring_monthly: false, recurring_bimonthly: false
    };

    if (!delivery && currentUser && stores && drivers) {
      const { driverId, driverName } = resolveDefaultDriverForNewDelivery({
        currentUser,
        stores,
        drivers,
        allDrivers,
        deliveryDate: initialState.delivery_date,
        initialDriverId,
        userHasRole,
        getDriverNameForStorage
      });

      if (driverId && driverName) {
        initialState.driver_id = driverId;
        initialState.driver_name = driverName;
      }
    }

    return initialState;
  });

  const [patientSearch, setPatientSearch] = useState(openMode === 'add_to_route' ? '__locked__' : "");
  const [selectedPatient, setSelectedPatient] = useState(() => (initialPatientId && Array.isArray(patients) ? (patients.find((pt) => pt && pt.id === initialPatientId) || null) : null));
  const [selectedPatientIds, setSelectedPatientIds] = useState(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedPickupOption, setSelectedPickupOption] = useState('');
  const [isPickupMode, setIsPickupMode] = useState(defaultToPickupMode); const [isInterStoreMode, setIsInterStoreMode] = useState(false);
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
  const {
    projectedDeliveries,
    setProjectedDeliveries,
    isLoadingPredictions,
    setIsLoadingPredictions,
    fullPredictionListRef,
    handleRefreshProjections,
    blockPredictions,
    unblockPredictions
  } = useDeliveryProjectionManager({
    delivery,
    currentUser,
    stores,
    patients,
    allDeliveries,
    selectedDate: formData.delivery_date,
    stagedDeliveries
  });
  const [showDayPopup, setShowDayPopup] = useState(false);
  const [activeRecurringType, setActiveRecurringType] = useState(null);
  const [editingStagedId, setEditingStagedId] = useState(null);
  const [completionTime, setCompletionTime] = useState(() => {
    if (delivery?.actual_delivery_time && !Number.isNaN(new Date(delivery.actual_delivery_time).getTime())) {
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
  const shouldAutoFocusFields = !isMobileDevice || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && (window.matchMedia('(pointer: fine)').matches || window.matchMedia('(any-pointer: fine)').matches) && (window.matchMedia('(hover: hover)').matches || window.matchMedia('(any-hover: hover)').matches));
  const hasLoadedPending = useRef(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMatches, setScanMatches] = useState([]);
  const [showMatchPopup, setShowMatchPopup] = useState(false);
  const [extractedData, setExtractedData] = useState(null);
  const [hasPendingDeletes, setHasPendingDeletes] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [isBatchFormSaving, setBatchFormSaving] = useState(false);
  const [isPayrollLocked, setIsPayrollLocked] = useState(false);
  const [payrollLockMessage, setPayrollLockMessage] = useState(null);
  const [isNewRouteWithZeroStops, setIsNewRouteWithZeroStops] = useState(false);
  const [forceOpenDriverSelectOnLoad, setForceOpenDriverSelectOnLoad] = useState(forceOpenDriverOnLoad);
  const [pidInputValue, setPidInputValue] = useState('');
  const [pidLookupStatus, setPidLookupStatus] = useState(null); // null | 'found' | 'not_found'
  const originalPidRef = useRef('');
  const autoCreatedPickupsRef = useRef(new Set()), batchSaveLockRef = useRef(false);

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

  // Removed useEffect that was overwriting staged deliveries' driver/date when form changed

  // Set default driver when form loads for new deliveries
  useEffect(() => {
    if (delivery || formData.driver_id) return; // Skip if editing or driver already set

    if (!currentUser || !stores || !drivers || allDrivers.length === 0) return;

    const { driverId: driverIdToSet, driverName: driverNameToSet } = resolveDefaultDriverForNewDelivery({
      currentUser,
      stores,
      drivers,
      allDrivers,
      deliveryDate: formData.delivery_date,
      initialDriverId,
      userHasRole,
      getDriverNameForStorage
    });

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

  useEffect(() => {
    if (!delivery?.id) return;
    const handlePatientUpdated = (event) => {
      const { patientId, updates } = event.detail || {};
      if (patientId !== delivery.patient_id) return;
      setFormData(prev => ({ ...prev, patient_name: updates.full_name || prev.patient_name, patient_phone: updates.phone || prev.patient_phone, unit_number: updates.unit_number || prev.unit_number, delivery_instructions: updates.notes || prev.delivery_instructions, mailbox_ok: updates.mailbox_ok !== undefined ? updates.mailbox_ok : prev.mailbox_ok, call_upon_arrival: updates.call_upon_arrival !== undefined ? updates.call_upon_arrival : prev.call_upon_arrival, ring_bell: updates.ring_bell !== undefined ? updates.ring_bell : prev.ring_bell, dont_ring_bell: updates.dont_ring_bell !== undefined ? updates.dont_ring_bell : prev.dont_ring_bell, back_door: updates.back_door !== undefined ? updates.back_door : prev.back_door, signature_needed: updates.signature_needed !== undefined ? updates.signature_needed : prev.signature_needed, recurring: updates.recurring !== undefined ? updates.recurring : prev.recurring, recurring_daily: updates.recurring_daily !== undefined ? updates.recurring_daily : prev.recurring_daily, recurring_weekly_mon: updates.recurring_weekly_mon !== undefined ? updates.recurring_weekly_mon : prev.recurring_weekly_mon, recurring_weekly_tue: updates.recurring_weekly_tue !== undefined ? updates.recurring_weekly_tue : prev.recurring_weekly_tue, recurring_weekly_wed: updates.recurring_weekly_wed !== undefined ? updates.recurring_weekly_wed : prev.recurring_weekly_wed, recurring_weekly_thu: updates.recurring_weekly_thu !== undefined ? updates.recurring_weekly_thu : prev.recurring_weekly_thu, recurring_weekly_fri: updates.recurring_weekly_fri !== undefined ? updates.recurring_weekly_fri : prev.recurring_weekly_fri, recurring_weekly_sat: updates.recurring_weekly_sat !== undefined ? updates.recurring_weekly_sat : prev.recurring_weekly_sat, recurring_weekly_sun: updates.recurring_weekly_sun !== undefined ? updates.recurring_weekly_sun : prev.recurring_weekly_sun, recurring_biweekly: updates.recurring_biweekly !== undefined ? updates.recurring_biweekly : prev.recurring_biweekly, recurring_weekly_x4: updates.recurring_weekly_x4 !== undefined ? updates.recurring_weekly_x4 : prev.recurring_weekly_x4, recurring_monthly: updates.recurring_monthly !== undefined ? updates.recurring_monthly : prev.recurring_monthly, recurring_bimonthly: updates.recurring_bimonthly !== undefined ? updates.recurring_bimonthly : prev.recurring_bimonthly }));
    };
    const unsubscribeDelivery = base44.entities.Delivery.subscribe((event) => {
      const changedId = event?.id || event?.data?.id;
      if (changedId !== delivery.id) return;
      if (event?.type === 'delete') return onCancel?.();
      const d = event?.data; if (!d) return;
      setFormData(prev => ({ ...prev, delivery_date: d.delivery_date || prev.delivery_date, delivery_time_start: d.delivery_time_start || '', delivery_time_end: d.delivery_time_end || '', delivery_time_eta: d.delivery_time_eta || '', arrival_time: d.arrival_time && !Number.isNaN(new Date(d.arrival_time).getTime()) ? format(new Date(d.arrival_time), 'HH:mm') : '', status: d.status || prev.status, driver_name: d.driver_name || '', driver_id: d.driver_id || '', prescription_number: d.prescription_number || '', delivery_instructions: d.delivery_instructions || prev.delivery_instructions, delivery_notes: d.delivery_notes || '', cod_total_amount_required: d.cod_total_amount_required ? d.cod_total_amount_required * 100 : 0, cod_payments: d.cod_payments || [], cod_payment_type: d.cod_payment_type || 'No Payment', cod_amount: d.cod_amount || '', tracking_number: d.tracking_number || '', stop_id: d.stop_id || '', puid: d.puid || '', store_phone: stores?.find((s) => s && s.id === d.store_id)?.phone || d.store_phone || '', store_id: d.store_id || '', ampm_deliveries: d.ampm_deliveries || null, signature_needed: d.signature_needed || false, fridge_item: d.fridge_item || false, oversized: d.oversized || false, after_hours_pickup: d.after_hours_pickup || false, no_charge: d.no_charge || false, extra_time: d.extra_time || 0, barcode_values: d.barcode_values || [], receipt_barcode_values: d.receipt_barcode_values || [], paid_km_override: d.paid_km_override ?? null }));
      if (d.actual_delivery_time && !Number.isNaN(new Date(d.actual_delivery_time).getTime())) setCompletionTime(format(new Date(d.actual_delivery_time), 'HH:mm'));
    });
    window.addEventListener('patientUpdated', handlePatientUpdated);
    return () => { window.removeEventListener('patientUpdated', handlePatientUpdated); unsubscribeDelivery?.(); };
  }, [delivery?.id, delivery?.patient_id, stores]);

  useEffect(() => {
    // CRITICAL: Only load delivery data once when delivery.id changes
    // Prevent re-loading on prop updates (patients, allDeliveries) which would reset user changes
    if (delivery) {
      // Skip if we've already loaded this delivery
      if (loadedDeliveryIdRef.current === delivery.id) {
        return;
      }
      
      loadedDeliveryIdRef.current = delivery.id;
      
      isLoadingExistingDelivery.current = true;
      const patient = delivery.patient_id ? patients?.find((p) => p && p.id === delivery.patient_id) : null;
      
      // CRITICAL: If delivery has PUID, find parent pickup to get correct AM/PM slot
      let finalStoreId = delivery.store_id || "";
      let finalAmpm = delivery.ampm_deliveries || null;
      
      if (delivery.patient_id && delivery.puid && allDeliveries) {
        const parentPickup = allDeliveries.find((d) => d && !d.patient_id && d.stop_id === delivery.puid);
        if (parentPickup) {
          finalStoreId = parentPickup.store_id || delivery.store_id;
          finalAmpm = parentPickup.ampm_deliveries || delivery.ampm_deliveries;
        }
      }

      setFormData({
        patient_id: delivery.patient_id || "",
        delivery_date: delivery.delivery_date || format(new Date(), 'yyyy-MM-dd'),
        delivery_time_start: delivery.delivery_time_start || "",
        delivery_time_end: delivery.delivery_time_end || "",
        arrival_time: delivery.arrival_time && !Number.isNaN(new Date(delivery.arrival_time).getTime()) ? format(new Date(delivery.arrival_time), 'HH:mm') : "",
        time_window_start: patient?.time_window_start || delivery.time_window_start || "",
        time_window_end: patient?.time_window_end || delivery.time_window_end || "",
        status: delivery.status || "Ready For Pickup",
        driver_name: delivery.driver_name || "",
        driver_id: delivery.driver_id || "",
        prescription_number: delivery.prescription_number || "",
        delivery_instructions: patient?.notes || delivery.delivery_instructions || "",
        delivery_notes: delivery.delivery_notes || "",
        cod_total_amount_required: delivery.cod_total_amount_required ? delivery.cod_total_amount_required * 100 : 0,
        cod_payments: delivery.cod_payments || [],
        cod_payment_type: delivery.cod_payment_type || "No Payment",
        cod_amount: delivery.cod_amount || "",
        tracking_number: delivery.tracking_number || "",
        delivery_stop_id: delivery.delivery_stop_id || "",
        stop_id: delivery.stop_id || "",
        puid: delivery.puid || "",
        patient_name: patient?.full_name || delivery.patient_name || "",
        patient_phone: patient?.phone || delivery.patient_phone || "",
        unit_number: patient?.unit_number || delivery.unit_number || "",
        store_phone: stores?.find((s) => s && s.id === finalStoreId)?.phone || delivery.store_phone || "",
        store_id: finalStoreId,
        ampm_deliveries: finalAmpm,
        mailbox_ok: patient?.mailbox_ok !== undefined && patient?.mailbox_ok !== null ? patient.mailbox_ok : (delivery.mailbox_ok || false),
        call_upon_arrival: patient?.call_upon_arrival !== undefined && patient?.call_upon_arrival !== null ? patient.call_upon_arrival : (delivery.call_upon_arrival || false),
        ring_bell: patient?.ring_bell !== undefined && patient?.ring_bell !== null ? patient.ring_bell : (delivery.ring_bell || false),
        dont_ring_bell: patient?.dont_ring_bell !== undefined && patient?.dont_ring_bell !== null ? patient.dont_ring_bell : (delivery.dont_ring_bell || false),
        back_door: patient?.back_door !== undefined && patient?.back_door !== null ? patient.back_door : (delivery.back_door || false),
        signature_needed: delivery.signature_needed || false,
        fridge_item: delivery.fridge_item || false,
        oversized: delivery.oversized || false,
        after_hours_pickup: delivery.after_hours_pickup || false,
        no_charge: delivery.no_charge || false,
        extra_time: delivery.extra_time || 0,
        barcode_values: delivery.barcode_values || [], receipt_barcode_values: delivery.receipt_barcode_values || [],
        recurring: patient?.recurring || false,
        recurring_daily: patient?.recurring_daily || false,
        recurring_weekly_mon: patient?.recurring_weekly_mon || false,
        recurring_weekly_tue: patient?.recurring_weekly_tue || false,
        recurring_weekly_wed: patient?.recurring_weekly_wed || false,
        recurring_weekly_thu: patient?.recurring_weekly_thu || false,
        recurring_weekly_fri: patient?.recurring_weekly_fri || false,
        recurring_weekly_sat: patient?.recurring_weekly_sat || false,
        recurring_weekly_sun: patient?.recurring_weekly_sun || false,
        recurring_biweekly: patient?.recurring_biweekly || false,
        recurring_weekly_x4: patient?.recurring_weekly_x4 || false,
        recurring_monthly: patient?.recurring_monthly || false,
        recurring_bimonthly: patient?.recurring_bimonthly || false,
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

  // Footer button mode
  const buttonState = useMemo(() => {
    if (openMode === 'add_to_route' && !delivery && !editingStagedId) return 'done';
    if (delivery) return 'update';
    if (editingStagedId) return 'updateStaged';
    if ((stagedDeliveries.length > 0 || hasPendingDeletes) && !hasFormData && !(isPickupMode && !delivery && (selectedPickupOption || formData.store_id || formData.delivery_notes || formData.after_hours_pickup))) return 'done';
    return 'add';
  }, [openMode, delivery, editingStagedId, stagedDeliveries.length, hasFormData, hasPendingDeletes, isPickupMode, selectedPickupOption, formData.store_id, formData.delivery_notes, formData.after_hours_pickup]);

  const cancelButtonState = useMemo(() => openMode === 'add_to_route' ? 'cancel' : (hasFormData ? 'clear' : 'cancel'), [openMode, hasFormData]);

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

  const isPatientSelectionRequired = !isPickupMode && !delivery && openMode !== 'add_to_route';
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

    return sortStores(expandStoresForTimeSlots({
      stores: relevantStores,
      deliveryDate: formData.delivery_date
    }));
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

    let results = availablePatients.filter((patient) => {
      if (!patient) return false;
      const name = patient.full_name?.toLowerCase() || '';
      if (name.includes('deceased') || name.includes('(old')) return false;
      return patient.full_name?.toLowerCase().includes(searchLower) ||
      patient.address?.toLowerCase().includes(searchLower) ||
      patient.phone?.toLowerCase().includes(searchLower) ||
      patient.notes?.toLowerCase().includes(searchLower);
    });

    results = sortFilteredPatients(results, {
      currentUser,
      userHasRole,
      stores,
      stagedPatientIds,
      calculateDistance
    });

    // Mark patients that are already staged
    return results.slice(0, 50).map(patient => ({
      ...patient,
      _isAlreadyStaged: stagedPatientIds.has(patient.id)
    }));
  }, [patientSearch, patients, stores, currentUser, formData.patient_id, stagedDeliveries]);

  const hasAnyDaySelected = useMemo(() => {
    return formData.recurring_weekly_mon || formData.recurring_weekly_tue ||
    formData.recurring_weekly_wed || formData.recurring_weekly_thu ||
    formData.recurring_weekly_fri || formData.recurring_weekly_sat ||
    formData.recurring_weekly_sun;
  }, [formData]);

  const currentFrequency = useMemo(() => !formData.recurring ? '' : formData.recurring_daily ? 'daily' : formData.recurring_biweekly && hasAnyDaySelected ? 'bi-weekly' : hasAnyDaySelected ? 'weekly' : formData.recurring_weekly_x4 ? 'weekly-x4' : formData.recurring_monthly ? 'monthly' : formData.recurring_bimonthly ? 'bi-monthly' : '', [formData, hasAnyDaySelected]);

  const weeklyLabel = useMemo(() => currentFrequency === 'weekly' && hasAnyDaySelected ? buildRecurringLabel(formData, 'Weekly') : 'Weekly', [currentFrequency, hasAnyDaySelected, formData]);
  const biWeeklyLabel = useMemo(() => currentFrequency === 'bi-weekly' && hasAnyDaySelected ? buildRecurringLabel(formData, 'Bi-Weekly') : 'Bi-Weekly', [currentFrequency, hasAnyDaySelected, formData]);
  const weeklyX4Label = useMemo(() => currentFrequency === 'weekly-x4' && hasAnyDaySelected ? buildRecurringLabel(formData, 'Weekly x4') : 'Weekly x4', [currentFrequency, hasAnyDaySelected, formData]);


  const handlePatientSelect = useCallback(async (patient, autoAddToStaged = false) => {
    if (!patient) return;
    
    // CRITICAL: Pause location poller during patient operations
    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    driverLocationPoller.pause();
    
    // CRITICAL: Check if patient is already in staged list
    const alreadyStaged = stagedDeliveries.some(s => s.patient_id === patient.id);
    if (alreadyStaged) {
      setPatientSearch('');
      setHighlightedPatientIndex(-1);
      driverLocationPoller.resume();
      return;
    }
    
    // CRITICAL: Don't auto-load patient data if we're editing an existing delivery
    if (isLoadingExistingDelivery.current) {
      driverLocationPoller.resume();
      return;
    }

    const hasCompletedDelivery = allDeliveries?.some((d) =>
    d && d.patient_id === patient.id && d.status === 'completed'
    );
    const isFirstDelivery = !hasCompletedDelivery;

    setSelectedPatient(patient);

    const patientStore = stores.find((s) => s && s.id === patient.store_id);
    const { autoSelectedDriverId, autoSelectedDriverName, deliveryAMPM } = resolvePatientDriverAssignment({
      patient,
      patientStore,
      deliveryDate: formData.delivery_date,
      drivers,
      allDeliveries,
      getDriverNameForStorage
    });

    const updatedFormData = buildSelectedPatientFormData({
      formData,
      patient,
      deliveryAMPM,
      autoSelectedDriverId,
      autoSelectedDriverName
    });

    setFormData(updatedFormData);
    if (!updatedFormData.driver_id) {
      setForceOpenDriverSelectOnLoad(true);
    }
    if (!autoAddToStaged) {
      if (shouldAutoFocusFields) {
        setTimeout(() => {
          if (updatedFormData.driver_id) {
            codAmountInputRef.current?.focus?.();
            return;
          }
          window.dispatchEvent(new CustomEvent('forceOpenDeliveryDriverSelect'));
        }, 0);
      }
      setPatientSearch(openMode === 'add_to_route' ? '__locked__' : '');
      setHighlightedPatientIndex(-1);
      driverLocationPoller.resume();
      return;
    }

    if (!patientStore || !autoSelectedDriverId) {
      driverLocationPoller.resume();
      return;
    }

    if (!patient._isNew) {
      try { await updatePatientLocal(patient.id, buildPatientUpdatePayload(updatedFormData)); } catch (error) { console.error('Failed to update patient:', error); }
    }

    const distanceFromStore = resolveDistanceFromStore({
      patient,
      store: patientStore,
      calculateDistance
    });

    const timeSlot = getStoreAssignedTimeSlotForDriver(patientStore, formData.delivery_date, autoSelectedDriverId, allDeliveries);
    const puid = await resolvePickupPuid({
      stagedDeliveries,
      allDeliveries,
      storeId: patientStore.id,
      deliveryDate: formData.delivery_date,
      driverId: autoSelectedDriverId,
      timeSlot
    });

    const stagedDelivery = {
      ...buildPatientStagedDelivery({
        formData: updatedFormData,
        patient,
        store: patientStore,
        codAmount: updatedFormData.cod_total_amount_required > 0 ? updatedFormData.cod_total_amount_required / 100 : 0,
        puid,
        timeSlot,
        distanceFromStore,
        isNewPatient: isFirstDelivery
      }),
      time_window_start: patient.time_window_start || '',
      time_window_end: patient.time_window_end || (patient.time_window_start ? '' : ''),
      status: 'Staged',
      isNextDelivery: false,
      latitude: patient.latitude,
      longitude: patient.longitude
    };

    setStagedDeliveries((prev) => [...prev, stagedDelivery]);

    setHasChanges(true);

    // CRITICAL: Filter projected deliveries locally (don't refetch from backend)
    const stagedPatientIds = new Set([...stagedDeliveries.map(d => d.patient_id), patient.id].filter(Boolean));
    const filteredPredictions = fullPredictionListRef.current.filter(pred => !stagedPatientIds.has(pred.patient_id) && !(allDeliveries||[]).some(d => d && d.delivery_date === formData.delivery_date && d.patient_id === pred.patient_id));
    setProjectedDeliveries(filteredPredictions);

    resetDraftEditorState({
      setSelectedPatient,
      setSelectedPatientIds,
      setPatientSearch,
      setError,
      setEditingStagedId,
      setHighlightedPatientIndex,
      setFormData,
      setSelectedPickupOption,
      shouldAutoFocusFields,
      focusRef: codAmountInputRef
    });
    
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

  // Original handleCameraScan (for file input method) - Kept as per outline instructions
  const handleCameraScan = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsScanning(true);
    setError(null);

    try {
      const result = await scanPrescriptionLabel({ file, mode: 'fileUrl' });
      await handlePrescriptionScanResult({
        result,
        onCreatePatient,
        handlePatientSelect,
        setScanMatches,
        setShowMatchPopup,
        setExtractedData,
        setIsPatientFormOpen
      });
    } catch (error) {
      console.error('Error scanning prescription:', error);
      setError(`Scan failed: ${error.message}`);
    } finally {
      setIsScanning(false);
      if (patientSearchInputRef.current) {
        patientSearchInputRef.current.value = '';
      }
    }
  }, [onCreatePatient, handlePatientSelect]);

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
        const result = await scanPrescriptionLabel({ file, mode: 'base64' });
        await handlePrescriptionScanResult({
          result,
          onCreatePatient,
          handlePatientSelect,
          setScanMatches,
          setShowMatchPopup,
          setExtractedData,
          setIsPatientFormOpen
        });
      } catch (error) {
        console.error('Error scanning prescription:', error);
        setError(`Scan failed: ${error.message}`);
      } finally {
        setIsScanning(false);
        stopCamera();
        setShowCameraOverlay(false);
      }
    }, 'image/jpeg', 0.8);
  }, [onCreatePatient, handlePatientSelect, stopCamera]);

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

    const { patientWithEmpty, nextFormData, duplicateSelectedPatient } = buildDuplicatePatientDraft({
      patient,
      patients,
      deliveryDate: formData.delivery_date,
      stores,
      drivers,
      allDeliveries,
      getDriverNameForStorage,
      formData
    });

    setIsPatientFormOpen(true);
    onCreatePatient((createdPatient) => {
      setIsPatientFormOpen(false);
      handlePatientSelect(createdPatient, true);
    }, patientWithEmpty, 'duplicate');

    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    setFormData(nextFormData);
    setSelectedPatient(duplicateSelectedPatient);

    if (shouldAutoFocusFields) setTimeout(() => patientNameInputRef.current?.focus(), 150);
  }, [patients, formData, stores, drivers, allDeliveries, onCreatePatient, handlePatientSelect, shouldAutoFocusFields]);

  // Handler for "New Address" button - creates new patient with same info but empty address/unit
  const handleNewAddressPatient = useCallback((patient) => {
    if (!patient || !onCreatePatient) return;

    const { nextFormData, patientWithoutAddress } = buildNewAddressPatientDraft({
      patient,
      patients,
      deliveryDate: formData.delivery_date,
      stores,
      drivers,
      allDeliveries,
      getDriverNameForStorage,
      formData,
      shouldAutoFocusFields
    });

    setNewPatientMode('new_address');
    setSelectedPatient(null);
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    setFormData(nextFormData);
    setSelectedPatient(patientWithoutAddress);
    setIsPatientFormOpen(true);
    onCreatePatient((createdPatient) => {
      setIsPatientFormOpen(false);
      setNewPatientMode(null);
      handlePatientSelect(createdPatient, true);
    }, patientWithoutAddress, 'newAddress');
  }, [patients, formData, stores, drivers, allDeliveries, onCreatePatient, handlePatientSelect, shouldAutoFocusFields]);

  const handleStagedDeliveryClick = useCallback((staged) => {
    // Hide staged panel on mobile when clicking a staged item
    if (isMobileDevice) {
      setShowStagedPanel(false);
    }

    setEditingStagedId(staged._tempId);

    let formDataToSet = {
      ...staged,
      puid: staged.puid || '',
      driver_id: staged.driver_id || '', driver_name: staged.driver_name || '',
      patient_phone: staged.patient_phone || patients?.find((p) => p && p.id === staged.patient_id)?.phone || '', unit_number: staged.unit_number || patients?.find((p) => p && p.id === staged.patient_id)?.unit_number || '', delivery_instructions: staged.delivery_instructions || patients?.find((p) => p && p.id === staged.patient_id)?.notes || '',
      cod_total_amount_required: staged.cod_total_amount_required > 0 ? staged.cod_total_amount_required * 100 : 0
    };

    // CRITICAL: If it's a patient delivery with PUID, find parent pickup to get correct store_id AND AM/PM slot
    if (staged.patient_id && staged.puid) {
      const allPossiblePickups = [...stagedDeliveries, ...(allDeliveries || [])];
      const parentPickup = allPossiblePickups.find((d) => d && !d.patient_id && d.stop_id === staged.puid);

      if (parentPickup) {
        formDataToSet.store_id = parentPickup.store_id || staged.store_id;
        formDataToSet.ampm_deliveries = parentPickup.ampm_deliveries || staged.ampm_deliveries;
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
        }
      }

      // Fallback to base store ID if no variant found
      if (!matchingStoreId) {
        const baseExists = availableStores.some((s) => s && s.id === staged.store_id);
        if (baseExists) {
          matchingStoreId = staged.store_id;
        }
      }

      if (matchingStoreId) {
        setSelectedPickupOption(matchingStoreId);
      }
    }

    // If patient exists, set it
    if (staged.patient_id && patients) {
      const patient = patients.find((p) => p && p.id === staged.patient_id);
      if (patient) {
        setSelectedPatient(patient);
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
    if (!formData.delivery_date || !formData.driver_id || !isFormValid || !isPickupMode && !formData.patient_id && !formData.patient_name || !formData.store_id) {
      setError(!formData.delivery_date || !formData.driver_id ? 'Please select both a date and driver before adding.' : 'Please fill all required fields.');
      return;
    }

    let patient = null;
    let isNewPatient = false;

    if (!isPickupMode) {
      patient = patients.find((p) => p && p.id === formData.patient_id);

      if (!patient && formData.patient_name && (newPatientMode === 'duplicate' || newPatientMode === 'new_address')) {
        try {
          const created = await createPatientFromDraft({
            formData,
            selectedPatient,
            createPatientLocal,
            setFormData
          });
          patient = created.patient;
          isNewPatient = created.isNewPatient;
        } catch (error) {
          console.error('Failed to create new patient:', error);
          setError(error.message || 'Failed to create new patient. Please try again.');
          return;
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
        await updatePatientLocal(formData.patient_id, buildPatientUpdatePayload(formData));
      } catch (error) {
        console.error('Failed to update patient:', error);
        setError('Failed to update patient data. Delivery will still be staged.');
      }
    }

    const distanceFromStore = resolveDistanceFromStore({
      patient,
      store,
      calculateDistance
    });

    const selectedStore = availableStores.find((s) => s && s.id === selectedPickupOption);
    const timeSlot = selectedStore?._timeSlot || formData.ampm_deliveries || getStoreAssignedTimeSlotForDriver(store, formData.delivery_date, formData.driver_id, allDeliveries) || 'AM';
    let newStagedDelivery;

    if (isPickupMode) {
      const pickupToCreate = buildPickupStagedDelivery({
        formData,
        codAmount,
        store,
        timeSlot,
        existingStopIds: [...(allDeliveries || []).map((d) => d?.stop_id), ...(stagedDeliveries || []).map((d) => d?.stop_id)]
      });

      const pickupTimes = resolvePickupTimeWindow({
        store,
        driverId: formData.driver_id,
        deliveryDate: formData.delivery_date
      });
      const routeDeliveriesForDriver = (allDeliveries || []).filter((delivery) =>
        delivery &&
        delivery.delivery_date === formData.delivery_date &&
        delivery.driver_id === formData.driver_id
      );
      const routePickups = routeDeliveriesForDriver.filter((delivery) => !delivery?.patient_id);
      const existingPickupTrackingNumbers = routePickups
        .map((delivery) => {
          const raw = String(delivery?.tracking_number || '');
          const match = raw.match(/(\d+)$/);
          return match ? parseInt(match[1], 10) : null;
        })
        .filter((value) => Number.isInteger(value));
      const trackingNumberBase = existingPickupTrackingNumbers.length > 0
        ? Math.max(...existingPickupTrackingNumbers) + 20
        : 0;
      const trackingNumber = trackingNumberBase === 0 ? '00' : String(trackingNumberBase);

      await createDeliveryLocal({
        ...pickupToCreate,
        patient_id: null,
        status: 'en_route',
        tracking_number: trackingNumber,
        delivery_time_start: pickupTimes?.delivery_time_start || pickupToCreate.delivery_time_start || '',
        delivery_time_end: pickupTimes?.delivery_time_end || pickupToCreate.delivery_time_end || '',
        time_window_start: pickupTimes?.delivery_time_start || pickupToCreate.time_window_start || '',
        time_window_end: pickupTimes?.delivery_time_end || pickupToCreate.time_window_end || ''
      });

      setHasChanges(true);
      resetDraftEditorState({
        setSelectedPatient,
        setSelectedPatientIds,
        setPatientSearch,
        setError,
        setEditingStagedId,
        setHighlightedPatientIndex,
        setFormData,
        setSelectedPickupOption,
        shouldAutoFocusFields,
        focusRef: patientSearchInputRef,
        setNewPatientMode
      });
      return;
    } else {
      const puid = await resolvePickupPuid({
        stagedDeliveries,
        allDeliveries,
        storeId: store.id,
        deliveryDate: formData.delivery_date,
        driverId: formData.driver_id,
        timeSlot
      });
      newStagedDelivery = buildPatientStagedDelivery({
        formData,
        patient,
        store,
        codAmount,
        puid,
        timeSlot,
        distanceFromStore,
        isNewPatient
      });
    }

    setStagedDeliveries((prev) => [...prev, newStagedDelivery]);


    setHasChanges(true);

    // CRITICAL: Filter projected deliveries locally (don't refetch from backend)
    const stagedPatientIds = new Set([...stagedDeliveries.map(d => d.patient_id), formData.patient_id].filter(Boolean));
    const filteredPredictions = fullPredictionListRef.current.filter(pred => !stagedPatientIds.has(pred.patient_id) && !(allDeliveries||[]).some(d => d && d.delivery_date === formData.delivery_date && d.patient_id === pred.patient_id));
    setProjectedDeliveries(filteredPredictions);

    resetDraftEditorState({
      setSelectedPatient,
      setSelectedPatientIds,
      setPatientSearch,
      setError,
      setEditingStagedId,
      setHighlightedPatientIndex,
      setFormData,
      setSelectedPickupOption,
      shouldAutoFocusFields,
      focusRef: patientSearchInputRef,
      setNewPatientMode
    });
  }, [formData, isFormValid, patients, stores, isPickupMode, newPatientMode, selectedPatient, stagedDeliveries, isMobileDevice, isNewRouteWithZeroStops, allDeliveries, availableStores, selectedPickupOption]);

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

    const distanceFromStore = resolveDistanceFromStore({
      patient,
      store,
      calculateDistance
    });

    const selectedStaged = stagedDeliveries.find((staged) => staged._tempId === editingStagedId);

    if (selectedStaged?.id) {
      const { persistPendingDeliveryUpdate } = await import('./persistPendingDeliveryUpdate.jsx');
      const { stagedDelivery, deliveryId } = await persistPendingDeliveryUpdate({ selectedStaged, formData, patient, store, editingStagedId, distanceFromStore });
      setStagedDeliveries((prev) => prev.map((staged) => staged._tempId === editingStagedId ? stagedDelivery : staged));setHasChanges(true);
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryId, deliveryDate: formData.delivery_date, driverId: formData.driver_id, triggeredBy: 'pendingDeliveryImmediateUpdate' } }));
    } else {
      const codAmount = formData.cod_total_amount_required > 0 ? formData.cod_total_amount_required / 100 : 0;
      if (formData.patient_id) {
        try { await updatePatientLocal(formData.patient_id, buildPatientUpdatePayload(formData)); } catch (error) { console.error('Failed to update patient:', error); setError('Failed to update patient data. Delivery will still be updated.'); }
      }
      setStagedDeliveries((prev) => prev.map((staged) => staged._tempId !== editingStagedId ? staged : ({ ...formData, cod_total_amount_required: codAmount, _tempId: editingStagedId, _wasEdited: false, id: staged.id, patient_name: formData.patient_name || patient?.full_name || 'N/A (Pickup)', store_name: store.name, store_abbreviation: store.abbreviation, distanceFromStore: distanceFromStore, delivery_address: patient?.address || store.address, first_delivery: formData.first_delivery || false, oversized: formData.oversized || false, fridge_item: formData.fridge_item || false, signature_needed: formData.signature_needed || false, paid_km_override: formData.paid_km_override !== null && formData.paid_km_override !== undefined ? parseFloat(formData.paid_km_override.toFixed(2)) : null })));
      setHasChanges(true);
    }

    // CRITICAL: Clear form completely after updating staged
    setError(null);
    setEditingStagedId(null);
    setSelectedPatient(null);
    setSelectedPatientIds(new Set());
    setPatientSearch('');
    setHighlightedPatientIndex(-1);
    const { getClearedDraftFormData } = await import('../utils/deliveryFormActionHelpers');
    setFormData((prev) => getClearedDraftFormData(prev));
    setSelectedPickupOption('');

    // Only auto-focus on desktop
    if (shouldAutoFocusFields) setTimeout(() => patientSearchInputRef.current?.focus(), 100);
  }, [editingStagedId, formData, isFormValid, patients, stores, isPickupMode, isMobileDevice]);


  const handleClearForm = useCallback(() => {
    void cleanupDetachedAutoCreatedPickups({
      stagedDeliveries,
      deleteDeliveryLocal,
      autoCreatedPickupsRef,
      setStagedDeliveries
    });
    resetDraftEditorState({
      setSelectedPatient,
      setSelectedPatientIds,
      setPatientSearch,
      setError,
      setEditingStagedId,
      setHighlightedPatientIndex,
      setFormData,
      setSelectedPickupOption,
      shouldAutoFocusFields,
      focusRef: patientSearchInputRef,
      setNewPatientMode
    });
  }, [stagedDeliveries, shouldAutoFocusFields]);

  const handleBatchSave = useCallback(async () => {
    if (openMode === 'add_to_route' && !delivery && stagedDeliveries.length === 0 && formData.patient_id && formData.store_id && formData.delivery_date) {
      await handleAddToStaging();
    }

    return runHandleBatchSave({
      batchSaveLockRef,
      isSaving,
      blockPredictions,
      stagedDeliveries: openMode === 'add_to_route' && stagedDeliveries.length === 0 ? [{
        ...formData,
        _tempId: `temp-${Date.now()}`,
        patient_name: formData.patient_name || selectedPatient?.full_name || '',
        patient_phone: formData.patient_phone || selectedPatient?.phone || '',
        delivery_address: selectedPatient?.address || '',
        unit_number: formData.unit_number || selectedPatient?.unit_number || '',
        store_name: stores.find((s) => s && s.id === formData.store_id)?.name || '',
        store_abbreviation: stores.find((s) => s && s.id === formData.store_id)?.abbreviation || '',
        cod_total_amount_required: formData.cod_total_amount_required > 0 ? formData.cod_total_amount_required / 100 : 0,
        status: formData.status || 'pending',
        first_delivery: !(allDeliveries || []).some((d) => d && d.patient_id === formData.patient_id && d.status === 'completed')
      }] : stagedDeliveries,
      hasPendingDeletes,
      setStagedDeliveries,
      setProjectedDeliveries,
      setHasPendingDeletes,
      setHasChanges,
      hasLoadedPending,
      unblockPredictions,
      setIsLoadingPredictions,
      handleClearForm,
      onCancel,
      formData,
      allDeliveries,
      stores,
      setIsSaving,
      setError,
      setBatchFormSaving,
      updateDeliveryLocal,
      updatePatientLocal,
      onSave,
      isNewRouteWithZeroStops
    });
  }, [
    isSaving,
    stagedDeliveries,
    hasPendingDeletes,
    formData,
    allDeliveries,
    stores,
    onCancel,
    onSave,
    isNewRouteWithZeroStops,
    handleClearForm,
    openMode,
    delivery,
    formData,
    selectedPatient,
    handleAddToStaging
  ]);

  const handleSearchKeyDown = useCallback((e) => {
    // Handle Escape key - always trigger Clear button behavior
    if (e.key === 'Escape') {
      e.preventDefault();
      // If there's form data, clear the form (like clicking Clear button)
      if (hasFormData) {
        resetDraftEditorState({
          setSelectedPatient,
          setSelectedPatientIds,
          setPatientSearch,
          setError,
          setEditingStagedId,
          setHighlightedPatientIndex,
          setFormData,
          setSelectedPickupOption,
          shouldAutoFocusFields,
          focusRef: patientSearchInputRef,
          setNewPatientMode
        });
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
    if (isSaving) return false;
    setIsSaving(true);
    setError(null);

    try {
      const dataToSave = await buildInTransitDirectSaveData({ prepareDeliverySaveData, formData, delivery, isCompletionStatus, completionTime, selectedPatient, stores, allDeliveries, stagedDeliveries });
      if (delivery?.id && !delivery?.patient_id && buildPickupSnapshot(delivery) === buildPickupSnapshot(dataToSave)) {
        import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm, onCancel })).catch(() => { handleClearForm(); onCancel(); });
        return true;
      }
      if (delivery?.id && delivery?.patient_id && formData.patient_id) {
        try {
          await updatePatientLocal(formData.patient_id, buildPatientUpdatePayload(formData));
        } catch (error) { console.error('❌ [DeliveryForm] Failed to sync patient changes:', error); }
      }

      const {
        driverChanged,
        dateChanged,
        statusChangedToInTransit,
        statusChangedToCompletion,
        actualDeliveryTimeChanged,
        codWasRemoved
      } = getDeliverySubmitFlags({ delivery, formData, dataToSave });
      const oldDriver = driverChanged ? drivers.find((d) => d?.id === delivery.driver_id) : null;
      const newDriver = driverChanged ? drivers.find((d) => d?.id === formData.driver_id) : null;

      if (dateChanged) {
        dataToSave.status = 'in_transit';
        dataToSave.time_window_start = '10:00';
      }

      if (statusChangedToInTransit && delivery?.id && formData.cod_total_amount_required > 0) {
        const store = stores?.find(s => s && s.id === formData.store_id);
        triggerSquareCodCreate({ deliveryId: delivery.id, patientName: formData.patient_name, storeAbbreviation: store?.abbreviation || '', codAmount: formData.cod_total_amount_required / 100, deliveryDate: formData.delivery_date, storeId: formData.store_id });
      }

      if (statusChangedToCompletion) dataToSave.isNextDelivery = false;

      if (statusChangedToCompletion) {
        triggerSquareCodDelete({ deliveryId: delivery?.id, nextStatus: formData.status, delivery: { ...delivery, ...dataToSave, cod_payments: formData.cod_payments, cod_payment_type: formData.cod_payment_type } });
      }

      if (codWasRemoved && delivery?.id) {
        dataToSave.cod_payments = [];
        dataToSave.cod_payment_type = 'No Payment';
        dataToSave.cod_amount = '';
        triggerSquareCodDelete({ deliveryId: delivery.id, reason: 'cod_removed' });
      }

      if (delivery?.id) {
        await updateDeliveryLocal(delivery.id, { ...dataToSave, receipt_barcode_values: Array.isArray(formData.receipt_barcode_values) ? formData.receipt_barcode_values : [] });
        if (statusChangedToCompletion) triggerPatientLastDeliverySync({ delivery: { ...delivery, ...dataToSave, status: formData.status, patient_id: delivery.patient_id, delivery_date: formData.delivery_date }, previousStatus: delivery.status });
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryId: delivery.id, deliveryDate: formData.delivery_date, driverId: formData.driver_id, triggeredBy: 'deliveryFormUpdate' } }));
        if (statusChangedToCompletion) setTimeout(() => { base44.functions.invoke('purgeAndRegeneratePolylines', { driverId: formData.driver_id, deliveryDate: formData.delivery_date, scope: 'active_only' }).catch((e) => console.warn('⚠️ [DeliveryForm] Active polyline refresh failed:', e?.message || e)); }, 0);
        if (statusChangedToCompletion || actualDeliveryTimeChanged) setTimeout(() => { base44.functions.invoke('purgeAndRegeneratePolylines', { driverId: formData.driver_id, deliveryDate: formData.delivery_date, scope: 'completed_only' }).catch((e) => console.warn('⚠️ [DeliveryForm] Completed polyline refresh failed:', e?.message || e)); }, 0);
      } else {
        if (buttonState === 'add' || buttonState === 'updateStaged' || buttonState === 'done') {
          setIsSaving(false);
          return false;
        }
        await onSave({ ...dataToSave, receipt_barcode_values: Array.isArray(formData.receipt_barcode_values) ? formData.receipt_barcode_values : [] });
      }

      await runDeliverySubmitSideEffects({
        delivery, formData, selectedPatient, currentUser, oldDriver, newDriver, driverChanged,
        isCurrentUserDriver:userHasRole(currentUser,'driver'), statusChangedToCompletion,
        actualDeliveryTimeChanged, t:dataToSave.actual_delivery_time, allDeliveries,
        isPickupMode, updateDeliveryLocal
      });
      return true;
    } catch (error) {
      setError(error.message);
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelClick = useCallback(() => {
    // Only show confirmation if there are NEW staged deliveries (without an id)
    const hasNewStagedDeliveries = stagedDeliveries.some((d) => !d.id);

    if (hasNewStagedDeliveries && !delivery) {
      const confirmed = window.confirm('You have unsaved deliveries. Discard them?');
      if (confirmed) {
        (async()=>{try{const c=stagedDeliveries.filter(d=>!d.patient_id&&d._autoCreated);for(const p of c){const attached=stagedDeliveries.some(sd=>sd.patient_id&&sd.puid===p.stop_id);if(!attached&&p.id){await deleteDeliveryLocal(p.id);autoCreatedPickupsRef.current.delete(p.id);}}setStagedDeliveries(prev=>{const hasAttached=(sid)=>prev.some(sd=>sd.patient_id&&sd.puid===sid);return prev.filter(d=>!( !d.patient_id && d._autoCreated && !hasAttached(d.stop_id) ));});}catch(e){}})();
        setStagedDeliveries([]);
        setProjectedDeliveries([]);
        hasLoadedPending.current = false; // Reset flag to allow reload
        
        // CRITICAL: Resume background operations before closing
        import('../utils/deliveryFormActionHelpers')
          .then(({ resumeDeliveryFormManagers }) => resumeDeliveryFormManagers())
          .catch((error) => {
            console.warn('⚠️ [DeliveryForm] Failed to resume managers:', error);
          });
        
        import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm, onCancel })).catch(()=>{handleClearForm();onCancel();});
      }
    } else {
      // CRITICAL: Reset the auto-load flag when canceling without changes
      // This allows the form to re-load pending deliveries next time
      if (!delivery) {
        hasLoadedPending.current = false;
      }
      
      // CRITICAL: Resume background operations before closing
      resumeDeliveryFormManagers().catch((error) => {
        console.warn('⚠️ [DeliveryForm] Failed to resume managers:', error);
      });
      
      import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm, onCancel })).catch(()=>{handleClearForm();onCancel();});
    }
  }, [stagedDeliveries, onCancel, delivery]);

  // NOTE: Enter key handling is done in DeliveryFormView's handleGlobalKeyDown (on the Card element).
  // Do NOT add a duplicate document-level Enter key listener here - it causes double-adds.

  useEffect(() => {
    const handleEscapeKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (showCameraOverlay) {
        stopCamera();
        setShowCameraOverlay(false);
        setIsScanning(false);
      } else if (delivery || cancelButtonState !== 'clear') {
        handleCancelClick();
      } else {
        handleClearForm();
      }
    };
    document.addEventListener('keydown', handleEscapeKey);
    return () => document.removeEventListener('keydown', handleEscapeKey);
  }, [cancelButtonState, delivery, handleCancelClick, handleClearForm, showCameraOverlay, stopCamera]);



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
    if (shouldAutoFocusFields) {
      requestAnimationFrame(() => {
        patientSearchInputRef.current?.focus?.();
      });
    }

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
        
      } catch (error) {
        console.warn('⚠️ [DeliveryForm] Failed to pause some managers:', error);
      }
    })();
    
    return () => {
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
          
        } catch (error) {
          console.warn('⚠️ [DeliveryForm] Failed to resume some managers:', error);
        }
      })();
    };
  }, [setIsFormOverlayOpen]);

  const handleRecurringChange = useCallback((checked) => {
    if (!checked) {
      setFormData((prev) => clearRecurringSelection(prev));
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
    
  }, [delivery, allDeliveries, formData.driver_id, formData.delivery_date]);


  // Monitor for deleted pending deliveries on other devices
  useEffect(() => {
    if (delivery || stagedDeliveries.length === 0) return;

    // Find any staged deliveries that have an ID (pending) but are no longer in allDeliveries
    const deletedPendingDeliveries = stagedDeliveries.filter((staged) => {
      if (!staged.id) return false; // Skip new staged items
      return !allDeliveries?.some((d) => d && d.id === staged.id);
    });

    if (deletedPendingDeliveries.length > 0) {
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
        setEditingStagedId(null);
        handleClearForm();
      }
    }
  }, [allDeliveries, stagedDeliveries.length, delivery]);

  // Auto-load pending deliveries on form mount - ONLY ONCE
  useEffect(() => {
    if (delivery || hasLoadedPending.current) return;
    if (!allDeliveries || !suggestedDate || !currentUser || !Array.isArray(patients) || !Array.isArray(stores) || !patients.length || !stores.length) return;
    const pendingDeliveries = filterPendingDeliveriesForUser({ allDeliveries, suggestedDate, currentUser, userHasRole });
    if (pendingDeliveries.length === 0) {
      hasLoadedPending.current = true;
      return;
    }
    const newStagedItems = mapPendingDeliveriesToStaged({ pendingDeliveries, patients, stores, allDeliveries, calculateDistance });
    const mappedPendingIds = new Set(newStagedItems.map((item) => item?.id).filter(Boolean));
    const unresolvedPendingCount = pendingDeliveries.filter((item) => item?.id && !mappedPendingIds.has(item.id)).length;
    setTimeout(() => {
      setStagedDeliveries(newStagedItems);
      setHasChanges(false);
      if (unresolvedPendingCount === 0) hasLoadedPending.current = true;
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

    const distanceFromStore = resolveDistanceFromStore({
      patient,
      store,
      calculateDistance
    });

    const { autoSelectedDriverId, autoSelectedDriverName } = resolveProjectedDeliveryDriver({
      store,
      patient,
      deliveryDate: formData.delivery_date,
      drivers,
      getDriverNameForStorage
    });

    const autoDriverId = autoSelectedDriverId || formData.driver_id;
    const timeSlot = formData.ampm_deliveries || getStoreAssignedTimeSlotForDriver(store, formData.delivery_date, autoDriverId, allDeliveries);
    const puid = await resolvePickupPuid({
      stagedDeliveries,
      allDeliveries,
      storeId: projected.store_id,
      deliveryDate: formData.delivery_date,
      driverId: autoDriverId,
      timeSlot,
      allowRecentlyCompleted: true
    });

    const newStagedItem = buildProjectedStagedItem({
      projected,
      patient,
      store,
      formData,
      timeSlot,
      autoSelectedDriverId,
      autoSelectedDriverName,
      distanceFromStore
    });

    // CRITICAL: Remove from projected and add to staged in one synchronous batch
    setProjectedDeliveries((prev) => prev.filter((p) => p.patient_id !== projected.patient_id));
    setStagedDeliveries((prev) => [...prev, puid ? { ...newStagedItem, puid } : newStagedItem]);
    setHasChanges(true);
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
    const scheduledPatientIds=new Set((allDeliveries||[]).filter((d)=>d&&d.delivery_date===formData.delivery_date&&d.patient_id).map((d)=>d.patient_id));
    let filtered = projectedDeliveries.filter((proj) => !scheduledPatientIds.has(proj.patient_id));
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
  }, [projectedDeliveries, allDeliveries, stores, formData.driver_id, formData.delivery_date]);


  const handleConfirmDelete = useConfirmDelete({ deleteConfirmation, setDeleteConfirmation, sortedStagedDeliveries, stagedDeliveries, editingStagedId, handleClearForm, setStagedDeliveries, setProjectedDeliveries, fullPredictionListRef, allDeliveries, formData, setHasChanges, setHasPendingDeletes, setEditingStagedId, setError, setIsDeletingPending });

  return (
    <DeliveryFormView
      formRef={formRef} useMobileLayout={useMobileLayout} isMobileDevice={isMobileDevice} useFullscreen={useFullscreen}
      delivery={delivery} formData={formData} setFormData={setFormData} isPickupMode={isPickupMode} setIsPickupMode={setIsPickupMode} isInterStoreMode={isInterStoreMode} setIsInterStoreMode={setIsInterStoreMode}
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
      handleRefreshProjections={handleRefreshProjections} showStagedPanel={showStagedPanel} setShowStagedPanel={setShowStagedPanel}
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
      closeOnSave={closeOnSave} onCancel={onCancel} openMode={openMode}
      forceOpenDriverOnLoad={forceOpenDriverSelectOnLoad}
    />
  );
}