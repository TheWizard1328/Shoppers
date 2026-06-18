/**
 * DeliveryForm - The logic/state layer for the delivery form.
 * Rendering is delegated to DeliveryFormView.jsx.
 */
import { useDevice } from '@/components/utils/DeviceContext';
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
import { generateStopId } from '../utils/idGenerator';
import { base44 } from "@/api/base44Client";
import { useAppData } from '../utils/AppDataContext';

import { shouldShowStoreBadges, isAppOwner } from '../utils/userRoles';
import { getPreferredTravelMode } from '../dashboard/travelModeHelpers';
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
import { buildDeliveryFormInitialState } from './deliveryFormInitialState';
import useDeliveryCamera from './useDeliveryCamera';
import { sortStagedDeliveries, sortProjectedDeliveries } from './deliverySortHelpers';
import { syncDeliveryCodOnUpdate, buildUpdatedDeliveryPayload } from './deliveryCodSaveHelpers';
import { resolveProjectedDeliveryDriver, buildProjectedStagedItem } from './projectedDeliveryHelpers';
import { prepareDeliverySaveData, buildPickupSnapshot, getDeliverySubmitFlags } from './deliverySubmitHelpers';
import { resolveDistanceFromStore, buildPickupStagedDelivery, buildPatientStagedDelivery } from './deliveryStagingHelpers';
import { closeDeliveryFormAfterSave } from '../utils/deliveryFormActionHelpers';
import { resolveDefaultDriverForNewDelivery, expandStoresForTimeSlots } from './deliveryStoreResolutionHelpers';
import { shouldUseImmediateAddToRouteStage, buildImmediateAddToRouteStage } from './Add2RouteStatusHelper';
import { createPatientFromDraft, resolvePickupPuid, resolvePickupTimeWindow } from './deliveryAddHelpers';
import { addPickupToRoute } from './pickupAddHelpers';
import { getRoutePickupsForStore, choosePickupForNewDelivery, buildPickupSelectValue, buildPendingNewPickup, getStorePickupOptions } from './pickupSelectionHelpers';
import { useConfirmDelete } from './useConfirmDelete';
import useFreshStores from './useFreshStores';
import { buildRecurringLabel } from './recurringLabels';
import { sortFilteredPatients } from './patientSearchSorter';
import { resumeDeliveryFormManagers } from './resumeDeliveryFormManagers';
import { clearRecurringSelection } from './recurringHelpers';
import { resetDriverFilterOnClear } from './deliveryClearFormHelper';
import { handleBatchSave as runHandleBatchSave } from './handleBatchSave';
import { pauseOfflineSync, resumeOfflineSync } from '../utils/offlineSync';
import { cleanupSquareCodCatalogForDate } from '../utils/squareCodCatalogCleanup';
import { createInterStoreTransfer } from './interStoreTransferHandler';
import DeliveryFormView from './DeliveryFormView';

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
  const { setIsFormOverlayOpen, appUsers, applyDeliveryChangesLocally } = useAppData();
  const freshStores = useFreshStores(stores);

  const allDrivers = useMemo(() => {
    // Prefer the passed drivers prop; fall back to appUsers from context if drivers is empty
    let source = drivers && drivers.length > 0 ? drivers : [];
    if (source.length === 0 && appUsers && appUsers.length > 0) {
      source = appUsers
        .filter((au) => au && au.app_roles?.includes('driver') && au.status !== 'inactive' && au.user_name)
        .map((au) => ({ ...au, id: au.id || au.user_id }));
    }
    const sorted = sortUsers(source);
    return sorted.filter((driver) => driver && driver.user_name && driver.status !== 'inactive');
  }, [drivers, appUsers]);

  const [formData, setFormData] = useState(() => buildDeliveryFormInitialState({
    initialPatientId,
    patients,
    suggestedDate,
    delivery,
    currentUser,
    stores: freshStores || stores,
    drivers,
    allDrivers,
    initialDriverId,
    resolveDefaultDriverForNewDelivery,
    userHasRole,
    getDriverNameForStorage
  }));

  const [patientSearch, setPatientSearch] = useState("");
  const [selectedPatient, setSelectedPatient] = useState(() => (initialPatientId && Array.isArray(patients) ? (patients.find((pt) => pt && pt.id === initialPatientId) || null) : null));
  const [selectedPatientIds, setSelectedPatientIds] = useState(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedPickupOption, setSelectedPickupOption] = useState('');
  const [selectedRoutePickup, setSelectedRoutePickup] = useState(null);
  const [pendingRoutePickup, setPendingRoutePickup] = useState(null);
  const [isPickupMode, setIsPickupMode] = useState(defaultToPickupMode); const [isInterStoreMode, setIsInterStoreMode] = useState(openMode === 'interstore_edit');

  // Auto-select "in_transit" status when switching to InterStore mode on a new form
  useEffect(() => {
    if (isInterStoreMode && !delivery) {
      setFormData((prev) => ({ ...prev, status: 'in_transit' }));
    }
  }, [isInterStoreMode, delivery]);

  // Sync completionTime when InterStore form sets actual_delivery_time directly
  useEffect(() => {
    if (!isInterStoreMode) return;
    const v = formData.actual_delivery_time;
    if (!v) return;
    const timeStr = v.includes('T') ? v.substring(11, 16) : v.substring(0, 5);
    if (timeStr && timeStr !== completionTime) setCompletionTime(timeStr);
  }, [formData.actual_delivery_time, isInterStoreMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const [isInterStoreReady, setIsInterStoreReady] = useState(false);
  const [isCyclingMarkerMode, setIsCyclingMarkerMode] = useState(false);
  const [selectedStoreForPickup, setSelectedStoreForPickup] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  const [highlightedPatientIndex, setHighlightedPatientIndex] = useState(-1);
  const patientSearchInputRef = useRef(null);
  const codAmountInputRef = useRef(null);
  const addPatientButtonRef = useRef(null);
  const patientNameInputRef = useRef(null);
  const patientAddressInputRef = useRef(null);
  
  const [newPatientMode, setNewPatientMode] = useState(null);
  const [stagedDeliveries, setStagedDeliveries] = useState([]);
  const [scheduledDriverMap, setScheduledDriverMap] = useState({}); // storeId -> driverId
  const scheduledDriverMapRef = useRef({}); // always-current ref for handlePatientSelect closure
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
    stagedDeliveries,
    scheduledDriverMap
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
  const { deviceType } = useDevice();
  const isMobileDevice = deviceType === 'Mobile';
  const shouldAutoFocusFields = !isMobileDevice || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && (window.matchMedia('(pointer: fine)').matches || window.matchMedia('(any-pointer: fine)').matches) && (window.matchMedia('(hover: hover)').matches || window.matchMedia('(any-hover: hover)').matches));
  const hasLoadedPending = useRef(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanMatches, setScanMatches] = useState([]);
  const [showMatchPopup, setShowMatchPopup] = useState(false);
  const [extractedData, setExtractedData] = useState(null);
  const [hasPendingDeletes, setHasPendingDeletes] = useState(false);
  const [allDeletedWerePending, setAllDeletedWerePending] = useState(true);
  const [hasChanges, setHasChanges] = useState(false);
  const [isBatchFormSaving, setBatchFormSaving] = useState(false);
  const [isPayrollLocked, setIsPayrollLocked] = useState(false);
  const [payrollLockMessage, setPayrollLockMessage] = useState(null);
  const [isNewRouteWithZeroStops, setIsNewRouteWithZeroStops] = useState(false);
  const [pickupsAddedCount, setPickupsAddedCount] = useState(0);
  const addedPickupRoutesRef = useRef([]); // each entry: { driverId, deliveryDate, pickup? }
  const addedPickupRecordsRef = useRef([]); // actual created pickup records for dedup in batch save
  const [forceOpenDriverSelectOnLoad, setForceOpenDriverSelectOnLoad] = useState(forceOpenDriverOnLoad);
  const [pidInputValue, setPidInputValue] = useState('');
  const [pidLookupStatus, setPidLookupStatus] = useState(null);
  const originalPidRef = useRef('');
  const autoCreatedPickupsRef = useRef(new Set()), batchSaveLockRef = useRef(false);
  const driverManuallyChangedRef = useRef(false); // true once user explicitly picks a driver

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [showCameraOverlay, setShowCameraOverlay] = useState(false);

  const [screenWidth, setScreenWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1024);
  const [screenHeight, setScreenHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 768);
  const formRef = useRef(null);

  const DESKTOP_FORM_WIDTH = 825;
  const useMobileLayout = screenWidth < DESKTOP_FORM_WIDTH;
  const useFullscreen = useMobileLayout && isMobileDevice;

  useEffect(() => {
    const handleResize = () => {
      setScreenWidth(window.innerWidth);
      setScreenHeight(window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (delivery || formData.driver_id || driverManuallyChangedRef.current) return;
    const storesToUse = freshStores || stores;
    if (!currentUser || !storesToUse || !drivers || allDrivers.length === 0) return;
    const { driverId: driverIdToSet, driverName: driverNameToSet } = resolveDefaultDriverForNewDelivery({
      currentUser,
      stores: storesToUse,
      drivers,
      allDrivers,
      deliveryDate: formData.delivery_date,
      initialDriverId,
      userHasRole,
      getDriverNameForStorage,
      scheduledDriverMap: scheduledDriverMapRef.current
    });
    if (driverIdToSet && driverNameToSet) {
      setFormData((prev) => ({ ...prev, driver_id: driverIdToSet, driver_name: driverNameToSet }));
    }
  }, [delivery, currentUser, freshStores, stores, drivers, allDrivers, formData.delivery_date, formData.driver_id, scheduledDriverMap]);

  // For admins and dispatchers: resolve the scheduled driver from DriverScheduleOverrides
  // and fall back to the store's default driver for the selected date/slot.
  // Runs when the form opens (new delivery only) and when delivery_date changes.
  useEffect(() => {
    if (delivery) return; // editing existing delivery — don't override
    const isDispatcher = userHasRole(currentUser, 'dispatcher');
    const isDriver = userHasRole(currentUser, 'driver');
    const isAdmin = userHasRole(currentUser, 'admin');
    if (isAdmin) return; // admins always show "All Drivers" on load
    if (!isDispatcher) return; // drivers handled by their own effect
    if (isDriver) return;

    const deliveryDate = formData.delivery_date;
    if (!deliveryDate || allDrivers.length === 0) return;

    const storesToUse = freshStores || stores;
    if (!storesToUse || storesToUse.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        // Fetch overrides for this specific date
        const overrides = await base44.entities.DriverScheduleOverride.filter({ date: deliveryDate });

        if (cancelled) return;

        // Dispatchers only reach here — use their single assigned store (store_ids[0])
        const storeId = (currentUser.store_ids || [])[0];
        if (!storeId) return;

        const store = storesToUse.find((s) => s && s.id === storeId);
        if (!store) return;

        const dateObj = new Date(deliveryDate + 'T00:00:00');
        const dow = dateObj.getDay(); // 0=Sun, 6=Sat
        const prefix = dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday';

        // Check override first, fall back to store default
        const overrideAM = overrides.find((o) => o.store_id === storeId && o.slot_key === `${prefix}_am`);
        const overridePM = overrides.find((o) => o.store_id === storeId && o.slot_key === `${prefix}_pm`);

        const driverId =
          (overrideAM ? overrideAM.driver_id : store[`${prefix}_am_driver_id`]) ||
          (overridePM ? overridePM.driver_id : store[`${prefix}_pm_driver_id`]) ||
          null;

        if (!driverId) return;

        const driver = allDrivers.find((d) => d && (d.id === driverId || d.user_id === driverId));
        if (!driver) return;

        setFormData((prev) => {
          if (driverManuallyChangedRef.current) return prev; // user manually chose a driver — never override
          return { ...prev, driver_id: driver.id, driver_name: getDriverNameForStorage(driver) };
        });
      } catch {
        // silent — non-critical
      }
    })();

    return () => { cancelled = true; };
  }, [delivery, currentUser, formData.delivery_date, freshStores, stores, allDrivers]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLoadingExistingDelivery = useRef(false);
  const loadedDeliveryIdRef = useRef(null);

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
      setFormData(prev => ({ ...prev, patient_name: updates.full_name || prev.patient_name, patient_phone: updates.phone || prev.patient_phone, patient_phone_secondary: updates.phone_secondary !== undefined ? (updates.phone_secondary || '') : prev.patient_phone_secondary, unit_number: updates.unit_number || prev.unit_number, delivery_instructions: updates.notes || prev.delivery_instructions,
        ...(updates.time_window_start !== undefined ? { delivery_time_start: updates.time_window_start || '', time_window_start: updates.time_window_start || '' } : {}),
        ...(updates.time_window_end !== undefined ? { delivery_time_end: updates.time_window_end || '', time_window_end: updates.time_window_end || '' } : {}),
        mailbox_ok: updates.mailbox_ok !== undefined ? updates.mailbox_ok : prev.mailbox_ok, call_upon_arrival: updates.call_upon_arrival !== undefined ? updates.call_upon_arrival : prev.call_upon_arrival, ring_bell: updates.ring_bell !== undefined ? updates.ring_bell : prev.ring_bell, dont_ring_bell: updates.dont_ring_bell !== undefined ? updates.dont_ring_bell : prev.dont_ring_bell, back_door: updates.back_door !== undefined ? updates.back_door : prev.back_door, signature_needed: updates.signature_needed !== undefined ? updates.signature_needed : prev.signature_needed, recurring: updates.recurring !== undefined ? updates.recurring : prev.recurring, recurring_daily: updates.recurring_daily !== undefined ? updates.recurring_daily : prev.recurring_daily, recurring_weekly_mon: updates.recurring_weekly_mon !== undefined ? updates.recurring_weekly_mon : prev.recurring_weekly_mon, recurring_weekly_tue: updates.recurring_weekly_tue !== undefined ? updates.recurring_weekly_tue : prev.recurring_weekly_tue, recurring_weekly_wed: updates.recurring_weekly_wed !== undefined ? updates.recurring_weekly_wed : prev.recurring_weekly_wed, recurring_weekly_thu: updates.recurring_weekly_thu !== undefined ? updates.recurring_weekly_thu : prev.recurring_weekly_thu, recurring_weekly_fri: updates.recurring_weekly_fri !== undefined ? updates.recurring_weekly_fri : prev.recurring_weekly_fri, recurring_weekly_sat: updates.recurring_weekly_sat !== undefined ? updates.recurring_weekly_sat : prev.recurring_weekly_sat, recurring_weekly_sun: updates.recurring_weekly_sun !== undefined ? updates.recurring_weekly_sun : prev.recurring_weekly_sun, recurring_biweekly: updates.recurring_biweekly !== undefined ? updates.recurring_biweekly : prev.recurring_biweekly, recurring_weekly_x4: updates.recurring_weekly_x4 !== undefined ? updates.recurring_weekly_x4 : prev.recurring_weekly_x4, recurring_monthly: updates.recurring_monthly !== undefined ? updates.recurring_monthly : prev.recurring_monthly, recurring_bimonthly: updates.recurring_bimonthly !== undefined ? updates.recurring_bimonthly : prev.recurring_bimonthly }));
    };
    const unsubscribeDelivery = base44.entities.Delivery.subscribe((event) => {
      const changedId = event?.id || event?.data?.id;
      if (changedId !== delivery.id) return;
      if (event?.type === 'delete') return onCancel?.();
      const d = event?.data; if (!d) return;
      const livePatient = delivery.patient_id ? patients?.find((p) => p && p.id === delivery.patient_id) : null;
      const canonicalTimeStart = livePatient?.time_window_start || d.delivery_time_start || '';
      const canonicalTimeEnd = livePatient?.time_window_end || d.delivery_time_end || '';
      setFormData(prev => ({ ...prev, delivery_date: d.delivery_date || prev.delivery_date, delivery_time_start: canonicalTimeStart, delivery_time_end: canonicalTimeEnd, delivery_time_eta: d.delivery_time_eta || '', arrival_time: d.arrival_time && !Number.isNaN(new Date(d.arrival_time).getTime()) ? format(new Date(d.arrival_time), 'HH:mm') : '', status: d.status || prev.status, driver_name: d.driver_name || '', driver_id: d.driver_id || '', prescription_number: d.prescription_number || '', delivery_instructions: d.delivery_instructions || prev.delivery_instructions, delivery_notes: d.delivery_notes || '', cod_total_amount_required: d.cod_total_amount_required ? d.cod_total_amount_required * 100 : 0, cod_payments: d.cod_payments || [], cod_payment_type: d.cod_payment_type || 'No Payment', cod_amount: d.cod_amount || '', tracking_number: d.tracking_number || '', stop_id: d.stop_id || '', puid: d.puid || '', store_phone: stores?.find((s) => s && s.id === d.store_id)?.phone || d.store_phone || '', store_id: d.store_id || '', ampm_deliveries: d.ampm_deliveries || null, signature_needed: d.signature_needed || false, fridge_item: d.fridge_item || false, oversized: d.oversized || false, after_hours_pickup: d.after_hours_pickup || false, no_charge: d.no_charge || false, extra_time: d.extra_time || 0, barcode_values: d.barcode_values || [], receipt_barcode_values: d.receipt_barcode_values || [], paid_km_override: d.paid_km_override ?? null }));
      if (d.actual_delivery_time && !Number.isNaN(new Date(d.actual_delivery_time).getTime())) setCompletionTime(format(new Date(d.actual_delivery_time), 'HH:mm'));
    });
    window.addEventListener('patientUpdated', handlePatientUpdated);
    return () => { window.removeEventListener('patientUpdated', handlePatientUpdated); unsubscribeDelivery?.(); };
  }, [delivery?.id, delivery?.patient_id, stores]);

  useEffect(() => {
    if (delivery) {
      if (loadedDeliveryIdRef.current === delivery.id) return;
      loadedDeliveryIdRef.current = delivery.id;
      isLoadingExistingDelivery.current = true;
      const patient = delivery.patient_id ? patients?.find((p) => p && p.id === delivery.patient_id) : null;
      let finalStoreId = delivery.store_id || "";
      let finalAmpm = delivery.ampm_deliveries || null;
      if (delivery.patient_id && delivery.puid && allDeliveries) {
        const parentPickup = allDeliveries.find((d) => d && !d.patient_id && d.stop_id === delivery.puid);
        if (parentPickup) { finalStoreId = parentPickup.store_id || delivery.store_id; finalAmpm = parentPickup.ampm_deliveries || delivery.ampm_deliveries; }
      }
      setFormData({
        patient_id: delivery.patient_id || "", delivery_date: delivery.delivery_date || format(new Date(), 'yyyy-MM-dd'),
        delivery_time_start: patient?.time_window_start || delivery.delivery_time_start || "", delivery_time_end: patient?.time_window_end || delivery.delivery_time_end || "",
        arrival_time: delivery.arrival_time && !Number.isNaN(new Date(delivery.arrival_time).getTime()) ? format(new Date(delivery.arrival_time), 'HH:mm') : "",
        time_window_start: patient?.time_window_start || delivery.time_window_start || "", time_window_end: patient?.time_window_end || delivery.time_window_end || "",
        status: delivery.status || "Ready For Pickup", driver_name: delivery.driver_name || "", driver_id: delivery.driver_id || "",
        prescription_number: delivery.prescription_number || "", delivery_instructions: patient?.notes || delivery.delivery_instructions || "",
        delivery_notes: delivery.delivery_notes || "", cod_total_amount_required: delivery.cod_total_amount_required ? delivery.cod_total_amount_required * 100 : 0,
        cod_payments: delivery.cod_payments || [], cod_payment_type: delivery.cod_payment_type || "No Payment", cod_amount: delivery.cod_amount || "",
        tracking_number: delivery.tracking_number || "", delivery_stop_id: delivery.delivery_stop_id || "", stop_id: delivery.stop_id || "", puid: delivery.puid || "",
        patient_name: patient?.full_name || delivery.patient_name || "", patient_phone: patient?.phone || delivery.patient_phone || "",
        patient_phone_secondary: patient?.phone_secondary || "", unit_number: patient?.unit_number || delivery.unit_number || "",
        store_phone: stores?.find((s) => s && s.id === finalStoreId)?.phone || delivery.store_phone || "", store_id: finalStoreId, ampm_deliveries: finalAmpm,
        mailbox_ok: patient?.mailbox_ok !== undefined && patient?.mailbox_ok !== null ? patient.mailbox_ok : (delivery.mailbox_ok || false),
        call_upon_arrival: patient?.call_upon_arrival !== undefined && patient?.call_upon_arrival !== null ? patient.call_upon_arrival : (delivery.call_upon_arrival || false),
        ring_bell: patient?.ring_bell !== undefined && patient?.ring_bell !== null ? patient.ring_bell : (delivery.ring_bell || false),
        dont_ring_bell: patient?.dont_ring_bell !== undefined && patient?.dont_ring_bell !== null ? patient.dont_ring_bell : (delivery.dont_ring_bell || false),
        back_door: patient?.back_door !== undefined && patient?.back_door !== null ? patient.back_door : (delivery.back_door || false),
        signature_needed: delivery.signature_needed || false, fridge_item: delivery.fridge_item || false, oversized: delivery.oversized || false,
        after_hours_pickup: delivery.after_hours_pickup || false, no_charge: delivery.no_charge || false, extra_time: delivery.extra_time || 0,
        barcode_values: delivery.barcode_values || [], receipt_barcode_values: delivery.receipt_barcode_values || [],
        transport_mode: delivery.transport_mode || delivery.finished_leg_transport_mode || 'driving',
        finished_leg_transport_mode: delivery.transport_mode || delivery.finished_leg_transport_mode || 'driving',
        recurring: patient?.recurring || false, recurring_daily: patient?.recurring_daily || false,
        recurring_weekly_mon: patient?.recurring_weekly_mon || false, recurring_weekly_tue: patient?.recurring_weekly_tue || false,
        recurring_weekly_wed: patient?.recurring_weekly_wed || false, recurring_weekly_thu: patient?.recurring_weekly_thu || false,
        recurring_weekly_fri: patient?.recurring_weekly_fri || false, recurring_weekly_sat: patient?.recurring_weekly_sat || false,
        recurring_weekly_sun: patient?.recurring_weekly_sun || false, recurring_biweekly: patient?.recurring_biweekly || false,
        recurring_weekly_x4: patient?.recurring_weekly_x4 || false, recurring_monthly: patient?.recurring_monthly || false,
        recurring_bimonthly: patient?.recurring_bimonthly || false, paid_km_override: delivery.paid_km_override ?? null,
        is_cycling_marker: delivery.is_cycling_marker || false,
        cycling_latitude: delivery.cycling_latitude ?? null, cycling_longitude: delivery.cycling_longitude ?? null,
        // InterStore fields — pre-populate so the edit form shows the correct From/To stores
        // These may already be saved on the delivery, or will be resolved from delivery_id phones below
        _interstore_source_id: delivery._interstore_source_id || '',
        _interstore_source_name: delivery._interstore_source_name || '',
        _interstore_source_number: delivery._interstore_source_number || '',
        _interstore_dest_id: delivery._interstore_dest_id || '',
        _interstore_dest_name: delivery._interstore_dest_name || '',
        _interstore_dest_number: delivery._interstore_dest_number || '',
        _interstore_distance_km: delivery.estimated_distance_km ?? null,
        _interstore_notes: '', // notes are baked into delivery_notes; leave blank on edit
        _interstore_resolving: !delivery._interstore_source_id && !delivery._interstore_dest_id, // flag while async lookup is running
      });
      setIsPickupMode(!delivery.patient_id);
      if (patient) {
        setSelectedPatient(patient);
        const initialPid = patient?.patient_id || '';
        setPidInputValue(initialPid);
        originalPidRef.current = initialPid;
        setPidLookupStatus(null);
      }
      setTimeout(() => { isLoadingExistingDelivery.current = false; }, 500);
    }
  }, [delivery?.id]);

  const hasFormData = useMemo(() => !!(
  formData.patient_id || formData.patient_name || formData.patient_phone ||
  formData.unit_number || formData.delivery_notes || formData.prescription_number ||
  formData.cod_total_amount_required > 0 || formData.recurring),
  [formData]);

  const buttonState = useMemo(() => {
    if (openMode === 'add_to_route' && !delivery && !editingStagedId && !isInterStoreMode) return 'done';
    if (delivery) return 'update';
    if (editingStagedId) return 'updateStaged';
    if (!isInterStoreMode && (stagedDeliveries.length > 0 || hasPendingDeletes) && !hasFormData && !(isPickupMode && !delivery && (selectedPickupOption || formData.store_id || formData.delivery_notes || formData.after_hours_pickup))) return 'done';
    if (!isInterStoreMode && isPickupMode && pickupsAddedCount > 0 && !hasFormData) return 'done';
    return 'add';
  }, [openMode, delivery, editingStagedId, stagedDeliveries.length, hasFormData, hasPendingDeletes, isPickupMode, isInterStoreMode, selectedPickupOption, formData.store_id, formData.delivery_notes, formData.after_hours_pickup, pickupsAddedCount]);

  const cancelButtonState = useMemo(() => openMode === 'add_to_route' ? 'cancel' : (hasFormData ? 'clear' : 'cancel'), [openMode, hasFormData]);
  const isCompletionStatus = useMemo(() => ['completed', 'cancelled', 'failed', 'returned'].includes(formData.status), [formData.status]);
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

  const isPatientSelectionRequired = !isPickupMode && !delivery && openMode !== 'add_to_route';
  const isFormDisabled = isPatientSelectionRequired && !selectedPatient && !editingStagedId;

  const selectedDateObj = useMemo(() => {
    if (!formData.delivery_date) return null;
    try { return new Date(formData.delivery_date + 'T00:00:00'); } catch (error) { return null; }
  }, [formData.delivery_date]);

  const availableStores = useMemo(() => {
    const storesToUse = freshStores || stores;
    if (!storesToUse || !Array.isArray(storesToUse)) return [];
    let relevantStores = storesToUse;
    if (!isPickupMode && !delivery) {
      const patientToCheck = selectedPatient || (formData.patient_id && patients ? patients.find((p) => p && p.id === formData.patient_id) : null);
      if (patientToCheck && patientToCheck.store_id) {
        const patientStore = storesToUse.find((s) => s && s.id === patientToCheck.store_id);
        if (!patientStore) return [];
        const officialOptions = sortStores(expandStoresForTimeSlots({ stores: [patientStore], deliveryDate: formData.delivery_date }));
        return getStorePickupOptions({ store: patientStore, allDeliveries, stagedDeliveries, driverId: formData.driver_id, deliveryDate: formData.delivery_date, officialStoreOptions: officialOptions });
      }
      if (userHasRole(currentUser, 'dispatcher')) {
        const dispatcherStoreIds = currentUser.store_ids || [];
        relevantStores = stores.filter((s) => s && dispatcherStoreIds.includes(s.id));
      }
    } else if (isPickupMode) {
      if (userHasRole(currentUser, 'admin')) { relevantStores = storesToUse; }
      else if (userHasRole(currentUser, 'dispatcher')) { const dispatcherStoreIds = currentUser.store_ids || []; relevantStores = storesToUse.filter((s) => s && dispatcherStoreIds.includes(s.id)); }
    } else if (delivery) {
      if (userHasRole(currentUser, 'admin')) { relevantStores = storesToUse; }
      else if (formData.patient_id && patients) { const patient = patients.find((p) => p && p.id === formData.patient_id); if (patient && patient.store_id) { const patientStore = storesToUse.find((s) => s && s.id === patient.store_id); relevantStores = patientStore ? [patientStore] : storesToUse; } }
      if (userHasRole(currentUser, 'dispatcher')) { const dispatcherStoreIds = currentUser.store_ids || []; relevantStores = relevantStores.filter((s) => s && dispatcherStoreIds.includes(s.id)); }
    }
    return sortStores(expandStoresForTimeSlots({ stores: relevantStores, deliveryDate: formData.delivery_date }));
  }, [freshStores, stores, isPickupMode, formData.patient_id, formData.driver_id, formData.delivery_date, patients, currentUser, selectedPatient, delivery, allDeliveries, stagedDeliveries]);

  const filteredPatients = useMemo(() => {
    if (!patientSearch || !patients || formData.patient_id) return [];
    const searchLower = patientSearch.toLowerCase().trim();
    if (!searchLower) return [];
    let availablePatients = patients || [];
    const stagedPatientIds = new Set(stagedDeliveries.map((d) => d.patient_id).filter(Boolean));
    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      if (dispatcherStoreIds.length > 0) availablePatients = availablePatients.filter((p) => p && p.store_id && dispatcherStoreIds.includes(p.store_id));
    } else if (userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) {
      // Base store IDs from the driver's profile
      const driverStoreIds = new Set([
        ...(currentUser.store_ids || []),
        ...(currentUser.store_id ? [currentUser.store_id] : [])
      ]);
      // Also include any stores where this driver is the scheduled driver (overrides or store defaults)
      Object.entries(scheduledDriverMap).forEach(([key, driverId]) => {
        if (driverId === currentUser.id) {
          // key may be "storeId", "storeId_AM", or "storeId_PM" — extract base store id
          const baseStoreId = key.replace(/_AM$|_PM$/, '');
          driverStoreIds.add(baseStoreId);
        }
      });
      if (driverStoreIds.size > 0) {
        availablePatients = availablePatients.filter((p) => p && p.store_id && driverStoreIds.has(p.store_id));
      }
    }
    let results = availablePatients.filter((patient) => {
      if (!patient) return false;
      const name = patient.full_name?.toLowerCase() || '';
      if (name.includes('deceased') || name.includes('(old')) return false;
      return patient.full_name?.toLowerCase().includes(searchLower) || patient.address?.toLowerCase().includes(searchLower) || patient.phone?.toLowerCase().includes(searchLower) || patient.notes?.toLowerCase().includes(searchLower);
    });
    results = sortFilteredPatients(results, { currentUser, userHasRole, stores, stagedPatientIds, calculateDistance });
    return results.slice(0, 50).map(patient => ({ ...patient, _isAlreadyStaged: stagedPatientIds.has(patient.id) }));
  }, [patientSearch, patients, stores, currentUser, formData.patient_id, stagedDeliveries]);

  const hasAnyDaySelected = useMemo(() => {
    return formData.recurring_weekly_mon || formData.recurring_weekly_tue || formData.recurring_weekly_wed || formData.recurring_weekly_thu || formData.recurring_weekly_fri || formData.recurring_weekly_sat || formData.recurring_weekly_sun;
  }, [formData]);

  const currentFrequency = useMemo(() => !formData.recurring ? '' : formData.recurring_daily ? 'daily' : formData.recurring_biweekly && hasAnyDaySelected ? 'bi-weekly' : formData.recurring_weekly_x4 ? 'weekly-x4' : hasAnyDaySelected ? 'weekly' : formData.recurring_monthly ? 'monthly' : formData.recurring_bimonthly ? 'bi-monthly' : '', [formData, hasAnyDaySelected]);
  const weeklyLabel = useMemo(() => currentFrequency === 'weekly' && hasAnyDaySelected ? buildRecurringLabel(formData, 'Weekly') : 'Weekly', [currentFrequency, hasAnyDaySelected, formData]);
  const biWeeklyLabel = useMemo(() => currentFrequency === 'bi-weekly' && hasAnyDaySelected ? buildRecurringLabel(formData, 'Bi-Weekly') : 'Bi-Weekly', [currentFrequency, hasAnyDaySelected, formData]);
  const weeklyX4Label = useMemo(() => currentFrequency === 'weekly-x4' && hasAnyDaySelected ? buildRecurringLabel(formData, 'Weekly x4') : 'Weekly x4', [currentFrequency, hasAnyDaySelected, formData]);

  const handlePatientSelect = useCallback(async (patient, autoAddToStaged = false) => {
    if (!patient) return;
    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    driverLocationPoller.pause();
    const alreadyStaged = stagedDeliveries.some(s => s.patient_id === patient.id);
    if (alreadyStaged) { setPatientSearch(''); setHighlightedPatientIndex(-1); driverLocationPoller.resume(); return; }
    if (isLoadingExistingDelivery.current) { driverLocationPoller.resume(); return; }
    const hasCompletedDelivery = allDeliveries?.some((d) => d && d.patient_id === patient.id && d.status === 'completed');
    const isFirstDelivery = !hasCompletedDelivery;
    setSelectedPatient(patient);
    const patientStore = (freshStores || stores).find((s) => s && s.id === patient.store_id);
    const { autoSelectedDriverId: resolvedDriverId, autoSelectedDriverName: resolvedDriverName, deliveryAMPM } = resolvePatientDriverAssignment({ patient, patientStore, deliveryDate: formData.delivery_date, drivers, allDeliveries, getDriverNameForStorage, currentUser, scheduledDriverMap: scheduledDriverMapRef.current });

    // If the dispatcher/admin manually chose a driver, keep it — don't override with the scheduled driver
    const autoSelectedDriverId = driverManuallyChangedRef.current && formData.driver_id ? formData.driver_id : resolvedDriverId;
    const autoSelectedDriverName = driverManuallyChangedRef.current && formData.driver_id ? formData.driver_name : resolvedDriverName;

    const updatedFormData = buildSelectedPatientFormData({ formData, patient, deliveryAMPM, autoSelectedDriverId, autoSelectedDriverName });
    const routePickups = getRoutePickupsForStore({ allDeliveries, stagedDeliveries, storeId: patient.store_id, driverId: autoSelectedDriverId, deliveryDate: formData.delivery_date });
    const fallbackPickup = buildPendingNewPickup({ store: patientStore, formData: { ...updatedFormData, store_id: patient.store_id }, driverName: autoSelectedDriverName, stopId: generateStopId() });
    const chosenPickup = choosePickupForNewDelivery({ pickups: routePickups, fallbackPickup });
    setSelectedRoutePickup(chosenPickup);
    setPendingRoutePickup(chosenPickup?._pendingCreate ? chosenPickup : null);
    setSelectedPickupOption(buildPickupSelectValue(chosenPickup));
    setFormData({ ...updatedFormData, store_id: patient.store_id, puid: chosenPickup?.stop_id || chosenPickup?.puid || '' });
    if (!updatedFormData.driver_id) setForceOpenDriverSelectOnLoad(true);
    if (!autoAddToStaged) {
      if (shouldAutoFocusFields) { setTimeout(() => { if (updatedFormData.driver_id) { codAmountInputRef.current?.focus?.(); return; } window.dispatchEvent(new CustomEvent('forceOpenDeliveryDriverSelect')); }, 0); }
      setPatientSearch(openMode === 'add_to_route' ? '__locked__' : '');
      setHighlightedPatientIndex(-1);
      driverLocationPoller.resume();
      return;
    }
    if (!patientStore || !autoSelectedDriverId) { driverLocationPoller.resume(); return; }
    if (!patient._isNew) { try { await updatePatientLocal(patient.id, buildPatientUpdatePayload(updatedFormData)); } catch (error) { console.error('Failed to update patient:', error); } }
    const distanceFromStore = resolveDistanceFromStore({ patient, store: patientStore, calculateDistance });
    const timeSlot = getStoreAssignedTimeSlotForDriver(patientStore, formData.delivery_date, autoSelectedDriverId, allDeliveries);
    const puid = await resolvePickupPuid({ stagedDeliveries, allDeliveries, storeId: patientStore.id, deliveryDate: formData.delivery_date, driverId: autoSelectedDriverId, timeSlot });
    const stagedDelivery = { ...buildPatientStagedDelivery({ formData: updatedFormData, patient, store: patientStore, codAmount: updatedFormData.cod_total_amount_required > 0 ? updatedFormData.cod_total_amount_required / 100 : 0, puid, timeSlot, distanceFromStore, isNewPatient: isFirstDelivery }), time_window_start: patient.time_window_start || '', time_window_end: patient.time_window_end || (patient.time_window_start ? '' : ''), status: 'Staged', isNextDelivery: false, latitude: patient.latitude, longitude: patient.longitude };
    setStagedDeliveries((prev) => [...prev, stagedDelivery]);
    setHasChanges(true);
    const stagedPatientIds = new Set([...stagedDeliveries.map(d => d.patient_id), patient.id].filter(Boolean));
    const filteredPredictions = fullPredictionListRef.current.filter(pred => !stagedPatientIds.has(pred.patient_id) && !(allDeliveries||[]).some(d => d && d.delivery_date === formData.delivery_date && d.patient_id === pred.patient_id));
    setProjectedDeliveries(filteredPredictions);
    resetDraftEditorState({ setSelectedPatient, setSelectedPatientIds, setPatientSearch, setError, setEditingStagedId, setHighlightedPatientIndex, setFormData, setSelectedPickupOption, shouldAutoFocusFields, focusRef: codAmountInputRef });
    driverLocationPoller.resume();
  }, [formData, freshStores, stores, drivers, allDeliveries, stagedDeliveries, isMobileDevice]);

  const handleAddSelectedPatients = useCallback(async () => {
    if (selectedPatientIds.size === 0) return;
    const patientsToAdd = filteredPatients.filter((p) => selectedPatientIds.has(p.id));
    for (const patient of patientsToAdd) { await handlePatientSelect(patient, true); }
    setSelectedPatientIds(new Set());
  }, [selectedPatientIds, filteredPatients, handlePatientSelect]);

  const handleCameraScan = useCallback(async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsScanning(true); setError(null);
    try {
      const result = await scanPrescriptionLabel({ file, mode: 'fileUrl' });
      await handlePrescriptionScanResult({ result, onCreatePatient, handlePatientSelect, setScanMatches, setShowMatchPopup, setExtractedData, setIsPatientFormOpen });
    } catch (error) { console.error('Error scanning prescription:', error); setError(`Scan failed: ${error.message}`); }
    finally { setIsScanning(false); if (patientSearchInputRef.current) patientSearchInputRef.current.value = ''; }
  }, [onCreatePatient, handlePatientSelect]);

  const { startCamera, stopCamera, handleCameraCapture } = useDeliveryCamera({ videoRef, canvasRef, setIsCameraActive, setShowCameraOverlay, setIsScanning, setError, onCreatePatient, handlePatientSelect, setScanMatches, setShowMatchPopup, setExtractedData, setIsPatientFormOpen });
  const handleSelectMatchedPatient = useCallback(async (patient) => { setShowMatchPopup(false); setScanMatches([]); setExtractedData(null); await handlePatientSelect(patient, false); }, [handlePatientSelect]);

  const handleDuplicatePatient = useCallback((patient) => {
    if (!patient || !onCreatePatient) return;
    const { patientWithEmpty, nextFormData, duplicateSelectedPatient } = buildDuplicatePatientDraft({ patient, patients, deliveryDate: formData.delivery_date, stores, drivers, allDeliveries, getDriverNameForStorage, formData });
    setIsPatientFormOpen(true);
    onCreatePatient((createdPatient) => { setIsPatientFormOpen(false); handlePatientSelect(createdPatient, false); }, patientWithEmpty, 'duplicate');
    setPatientSearch(''); setHighlightedPatientIndex(-1); setFormData(nextFormData); setSelectedPatient(duplicateSelectedPatient);
    if (shouldAutoFocusFields) setTimeout(() => patientNameInputRef.current?.focus(), 150);
  }, [patients, formData, stores, drivers, allDeliveries, onCreatePatient, handlePatientSelect, shouldAutoFocusFields]);

  const handleNewAddressPatient = useCallback((patient) => {
    if (!patient || !onCreatePatient) return;
    const { nextFormData, patientWithoutAddress } = buildNewAddressPatientDraft({ patient, patients, deliveryDate: formData.delivery_date, stores, drivers, allDeliveries, getDriverNameForStorage, formData, shouldAutoFocusFields });
    setNewPatientMode('new_address'); setSelectedPatient(null); setPatientSearch(''); setHighlightedPatientIndex(-1); setFormData(nextFormData); setSelectedPatient(patientWithoutAddress);
    setIsPatientFormOpen(true);
    onCreatePatient((createdPatient) => { setIsPatientFormOpen(false); setNewPatientMode(null); handlePatientSelect(createdPatient, false); }, patientWithoutAddress, 'newAddress');
  }, [patients, formData, stores, drivers, allDeliveries, onCreatePatient, handlePatientSelect, shouldAutoFocusFields]);

  const handleStagedDeliveryClick = useCallback((staged) => {
    if (isMobileDevice) setShowStagedPanel(false);
    setEditingStagedId(staged._tempId);
    const stagedPatient = staged.patient_id ? patients?.find((p) => p && p.id === staged.patient_id) : null;
    let formDataToSet = { ...staged, puid: staged.puid || '', driver_id: staged.driver_id || '', driver_name: staged.driver_name || '', patient_phone: staged.patient_phone || stagedPatient?.phone || '', unit_number: staged.unit_number || stagedPatient?.unit_number || '', delivery_instructions: staged.delivery_instructions || stagedPatient?.notes || '', cod_total_amount_required: staged.cod_total_amount_required > 0 ? staged.cod_total_amount_required * 100 : 0, delivery_time_start: stagedPatient?.time_window_start || staged.delivery_time_start || '', delivery_time_end: stagedPatient?.time_window_end || staged.delivery_time_end || '', time_window_start: stagedPatient?.time_window_start || staged.time_window_start || '', time_window_end: stagedPatient?.time_window_end || staged.time_window_end || '' };
    if (staged.patient_id && staged.puid) {
      const allPossiblePickups = [...stagedDeliveries, ...(allDeliveries || [])];
      const parentPickup = allPossiblePickups.find((d) => d && !d.patient_id && d.stop_id === staged.puid);
      if (parentPickup) { formDataToSet.store_id = parentPickup.store_id || staged.store_id; formDataToSet.ampm_deliveries = parentPickup.ampm_deliveries || staged.ampm_deliveries; }
    }
    setFormData(formDataToSet); setSelectedPatient(null);
    if (staged.store_id && isPickupMode) {
      const timeSlot = formDataToSet.ampm_deliveries || determineDeliveryAMPM(staged);
      let matchingStoreId = null;
      if (timeSlot) { const variantId = `${staged.store_id}_${timeSlot}`; if (availableStores.some((s) => s && s.id === variantId)) matchingStoreId = variantId; }
      if (!matchingStoreId) { if (availableStores.some((s) => s && s.id === staged.store_id)) matchingStoreId = staged.store_id; }
      if (matchingStoreId) setSelectedPickupOption(matchingStoreId);
    }
    if (staged.patient_id && patients) { const patient = patients.find((p) => p && p.id === staged.patient_id); if (patient) setSelectedPatient(patient); }
  }, [isPickupMode, stores, patients, availableStores, stagedDeliveries, allDeliveries]);

  const isFormValid = useMemo(() => {
    if (delivery) return true;
    if (editingStagedId) { if (isPickupMode) return !!formData.store_id && !!formData.delivery_date && !!formData.driver_id; return (!!formData.patient_id || !!formData.patient_name) && !!formData.store_id && !!formData.delivery_date; }
    if (isPickupMode) return selectedPickupOption !== '' && !!formData.delivery_date && !!formData.driver_id;
    return (!!formData.patient_id || !!formData.patient_name) && !!formData.store_id && !!formData.delivery_date && !isFormDisabled;
  }, [formData, selectedPickupOption, isPickupMode, delivery, isFormDisabled, editingStagedId]);

  // ── InterStore transfer handler — delegates to interStoreTransferHandler.js ──
  const handleAddInterStoreTransfer = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      await createInterStoreTransfer({
        formData,
        allDrivers,
        allDeliveries,
        appUsers,
        stores,
        currentUser,
        getDriverNameForStorage,
        applyDeliveryChangesLocally,
        handleClearForm: () => handleClearForm(),
        onCancel,
      });
    } catch (err) {
      setError(err.message || 'Failed to create inter-store transfer.');
    } finally {
      setIsSaving(false);
    }
  }, [formData, allDrivers, allDeliveries, appUsers, currentUser, getDriverNameForStorage, applyDeliveryChangesLocally, onCancel]);

  const handleClearForm = useCallback(() => {
    void cleanupDetachedAutoCreatedPickups({ stagedDeliveries, deleteDeliveryLocal, autoCreatedPickupsRef, setStagedDeliveries });
    resetDraftEditorState({ setSelectedPatient, setSelectedPatientIds, setPatientSearch, setError, setEditingStagedId, setHighlightedPatientIndex, setFormData, setSelectedPickupOption, shouldAutoFocusFields, focusRef: patientSearchInputRef, setNewPatientMode });
    // Admins always reset to "All Drivers" on Clear
    if (userHasRole(currentUser, 'admin')) {
      setFormData((prev) => ({ ...prev, driver_id: '', driver_name: '' }));
    }
    resetDriverFilterOnClear(currentUser, stores, userHasRole);
  }, [stagedDeliveries, shouldAutoFocusFields, currentUser, stores]);

  const handleAddToStaging = useCallback(async (overrideFormData, extraPickups = []) => {
    const fd = overrideFormData || formData;
    if (!fd.delivery_date || !fd.driver_id || (!fd.store_id)) { setError(!fd.delivery_date || !fd.driver_id ? 'Please select both a date and driver before adding.' : 'Please fill all required fields.'); return null; }
    const resolvedFormData = fd;
    let patient = null; let isNewPatient = false;
    if (!isPickupMode) {
      patient = patients.find((p) => p && p.id === resolvedFormData.patient_id);
      if (!patient && resolvedFormData.patient_name && (newPatientMode === 'duplicate' || newPatientMode === 'new_address')) {
        try { const created = await createPatientFromDraft({ formData: resolvedFormData, selectedPatient, createPatientLocal, setFormData }); patient = created.patient; isNewPatient = created.isNewPatient; }
        catch (error) { console.error('Failed to create new patient:', error); setError(error.message || 'Failed to create new patient. Please try again.'); return; }
      } else if (!patient && !resolvedFormData.patient_name) { setError('Patient information missing.'); return; }
    }
    const store = (freshStores || stores).find((s) => s && s.id === resolvedFormData.store_id);
    if (!store) { setError('Store information missing.'); return; }
    const codAmount = resolvedFormData.cod_total_amount_required > 0 ? resolvedFormData.cod_total_amount_required / 100 : 0;
    if (resolvedFormData.patient_id && !isNewPatient) { try { await updatePatientLocal(resolvedFormData.patient_id, buildPatientUpdatePayload(resolvedFormData)); } catch (error) { console.error('Failed to update patient:', error); setError('Failed to update patient data. Delivery will still be staged.'); } }
    const distanceFromStore = resolveDistanceFromStore({ patient, store, calculateDistance });
    const timeSlot = resolvedFormData.ampm_deliveries || getStoreAssignedTimeSlotForDriver(store, resolvedFormData.delivery_date, resolvedFormData.driver_id, allDeliveries) || 'AM';
    let newStagedDelivery;
    if (isPickupMode) {
      const createdPickup = await addPickupToRoute({ formData: resolvedFormData, store, allDeliveries, stagedDeliveries, extraPickups, setHasChanges, setPickupsAddedCount, addedPickupRoutesRef, setError, handleClearForm });
      if (createdPickup) addedPickupRecordsRef.current.push(createdPickup);
      return createdPickup;
    }
    else {
      const puid = await resolvePickupPuid({ stagedDeliveries, allDeliveries, storeId: store.id, deliveryDate: resolvedFormData.delivery_date, driverId: resolvedFormData.driver_id, timeSlot });
      newStagedDelivery = buildPatientStagedDelivery({ formData: resolvedFormData, patient, store, codAmount, puid, timeSlot, distanceFromStore, isNewPatient });
    }
    setStagedDeliveries((prev) => [...prev, newStagedDelivery]);
    setHasChanges(true);
    const stagedPatientIds = new Set([...stagedDeliveries.map(d => d.patient_id), resolvedFormData.patient_id].filter(Boolean));
    const filteredPredictions = fullPredictionListRef.current.filter(pred => !stagedPatientIds.has(pred.patient_id) && !(allDeliveries||[]).some(d => d && d.delivery_date === resolvedFormData.delivery_date && d.patient_id === pred.patient_id));
    setProjectedDeliveries(filteredPredictions);
    setSelectedRoutePickup(null); setPendingRoutePickup(null);
    resetDraftEditorState({ setSelectedPatient, setSelectedPatientIds, setPatientSearch, setError, setEditingStagedId, setHighlightedPatientIndex, setFormData, setSelectedPickupOption, shouldAutoFocusFields, focusRef: patientSearchInputRef, setNewPatientMode });
  }, [formData, patients, freshStores, stores, isPickupMode, newPatientMode, selectedPatient, stagedDeliveries, isMobileDevice, isNewRouteWithZeroStops, allDeliveries, availableStores, selectedPickupOption]);

  useEffect(() => {
    if (delivery || isPickupMode || !selectedPatient || !formData.driver_id || !formData.delivery_date) return;
    const patientStore = (freshStores || stores).find((s) => s && s.id === selectedPatient.store_id);
    if (!patientStore) return;
    const routePickups = getRoutePickupsForStore({ allDeliveries, stagedDeliveries, storeId: selectedPatient.store_id, driverId: formData.driver_id, deliveryDate: formData.delivery_date });
    const fallbackPickup = buildPendingNewPickup({ store: patientStore, formData: { ...formData, store_id: selectedPatient.store_id }, driverName: formData.driver_name, stopId: generateStopId() });
    const chosenPickup = choosePickupForNewDelivery({ pickups: routePickups, fallbackPickup });
    const nextPuid = chosenPickup?.stop_id || chosenPickup?.puid || '';
    setSelectedRoutePickup(chosenPickup); setPendingRoutePickup(chosenPickup?._pendingCreate ? chosenPickup : null); setSelectedPickupOption(buildPickupSelectValue(chosenPickup));
    setFormData((prev) => prev.puid === nextPuid && prev.store_id === selectedPatient.store_id ? prev : { ...prev, store_id: selectedPatient.store_id, puid: nextPuid });
  }, [delivery, isPickupMode, selectedPatient?.id, formData.driver_id, formData.delivery_date, allDeliveries, stagedDeliveries, freshStores, stores]);

  const handleUpdateStaged = useCallback(async () => {
    if (!editingStagedId) return;
    if (!isFormValid || !isPickupMode && !formData.patient_id && !formData.patient_name || !formData.store_id) { setError('Please fill all required fields.'); return; }
    let patient = null;
    if (!isPickupMode) { patient = patients.find((p) => p && p.id === formData.patient_id); if (!patient && !formData.patient_name) { setError('Patient information missing.'); return; } }
    const store = stores.find((s) => s && s.id === formData.store_id);
    if (!store) { setError('Store information missing.'); return; }
    const distanceFromStore = resolveDistanceFromStore({ patient, store, calculateDistance });
    const selectedStaged = stagedDeliveries.find((staged) => staged._tempId === editingStagedId);
    if (selectedStaged?.id) {
      const { persistPendingDeliveryUpdate } = await import('./persistPendingDeliveryUpdate.jsx');
      const { stagedDelivery, deliveryId } = await persistPendingDeliveryUpdate({ selectedStaged, formData, patient, store, editingStagedId, distanceFromStore });
      setStagedDeliveries((prev) => prev.map((staged) => staged._tempId === editingStagedId ? stagedDelivery : staged)); setHasChanges(true);
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryId, deliveryDate: formData.delivery_date, driverId: formData.driver_id, triggeredBy: 'pendingDeliveryImmediateUpdate', preserveLocalState: true, freshDeliveries: [stagedDelivery] } }));
    } else {
      const codAmount = formData.cod_total_amount_required > 0 ? formData.cod_total_amount_required / 100 : 0;
      if (formData.patient_id) { try { await updatePatientLocal(formData.patient_id, buildPatientUpdatePayload(formData)); } catch (error) { console.error('Failed to update patient:', error); setError('Failed to update patient data. Delivery will still be updated.'); } }
      setStagedDeliveries((prev) => prev.map((staged) => staged._tempId !== editingStagedId ? staged : ({ ...formData, cod_total_amount_required: codAmount, _tempId: editingStagedId, _wasEdited: false, id: staged.id, patient_name: formData.patient_name || patient?.full_name || 'N/A (Pickup)', store_name: store.name, store_abbreviation: store.abbreviation, distanceFromStore: distanceFromStore, delivery_address: patient?.address || store.address, first_delivery: formData.first_delivery || false, oversized: formData.oversized || false, fridge_item: formData.fridge_item || false, signature_needed: formData.signature_needed || false, paid_km_override: formData.paid_km_override !== null && formData.paid_km_override !== undefined ? parseFloat(formData.paid_km_override.toFixed(2)) : null })));
      setHasChanges(true);
    }
    setError(null); setEditingStagedId(null); setSelectedRoutePickup(null); setPendingRoutePickup(null); setSelectedPatient(null); setSelectedPatientIds(new Set()); setPatientSearch(''); setHighlightedPatientIndex(-1);
    const { getClearedDraftFormData } = await import('../utils/deliveryFormActionHelpers');
    setFormData((prev) => getClearedDraftFormData(prev)); setSelectedPickupOption('');
    if (shouldAutoFocusFields) setTimeout(() => patientSearchInputRef.current?.focus(), 100);
  }, [editingStagedId, formData, isFormValid, patients, stores, isPickupMode, isMobileDevice]);

  const handleBatchSave = useCallback(async () => {
    if (addedPickupRoutesRef.current.length > 0 && stagedDeliveries.length === 0 && !hasPendingDeletes) {
      const uniqueRoutes = Array.from(new Map(addedPickupRoutesRef.current.map((r) => [`${r.driverId}__${r.deliveryDate}`, r])).values());
      addedPickupRoutesRef.current = [];
      addedPickupRecordsRef.current = [];
      import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm, onCancel })).catch(() => { handleClearForm(); onCancel?.(); });
      for (const { driverId, deliveryDate } of uniqueRoutes) {
        await base44.functions.invoke('optimizeRemainingStops', { driverId, deliveryDate, bypassDriverStatus: true }).catch(() => null);
        const freshDeliveries = await base44.entities.Delivery.filter({ driver_id: driverId, delivery_date: deliveryDate }).catch(() => []);
        const orderedIds = (freshDeliveries || [])
          .filter(d => d?.id && !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(d?.status))
          .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0))
          .map(d => d.id);
        base44.functions.invoke('purgeAndRegeneratePolylines', { driverId, deliveryDate, routeStopOrder: orderedIds, reason: 'stops_added', scope: 'active_only', bypassDriverStatus: true }).catch(() => null);
      }
      return;
    }
    const shouldCreateImmediateStagedDelivery = shouldUseImmediateAddToRouteStage({ openMode, delivery, stagedDeliveries, formData });
    const stagedDeliveriesForSave = shouldCreateImmediateStagedDelivery ? [buildImmediateAddToRouteStage({ formData, selectedPatient, stores, allDeliveries })] : stagedDeliveries;
    if (shouldCreateImmediateStagedDelivery) { setStagedDeliveries(stagedDeliveriesForSave); setHasChanges(true); }
    // CRITICAL: Merge already-created pickups (from addPickupToRoute) into allDeliveries so
    // ensurePickupForDelivery finds them and doesn't create duplicates.
    const alreadyCreatedPickups = addedPickupRecordsRef.current.filter(Boolean);
    const allDeliveriesWithPickups = alreadyCreatedPickups.length > 0
      ? [...(allDeliveries || []), ...alreadyCreatedPickups]
      : allDeliveries;
    addedPickupRecordsRef.current = [];
    return runHandleBatchSave({ batchSaveLockRef, isSaving, blockPredictions, stagedDeliveries: stagedDeliveriesForSave, hasPendingDeletes, allDeletedWerePending, setStagedDeliveries, setProjectedDeliveries, setHasPendingDeletes, setHasChanges, hasLoadedPending, unblockPredictions, setIsLoadingPredictions, handleClearForm, onCancel, formData, allDeliveries: allDeliveriesWithPickups, stores, setIsSaving, setError, setBatchFormSaving, updateDeliveryLocal, updatePatientLocal, onSave, isNewRouteWithZeroStops });
  }, [isSaving, stagedDeliveries, hasPendingDeletes, formData, allDeliveries, stores, onCancel, onSave, isNewRouteWithZeroStops, handleClearForm, openMode, delivery, selectedPatient, setStagedDeliveries, setHasChanges]);

  const handleSearchKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (hasFormData) { resetDraftEditorState({ setSelectedPatient, setSelectedPatientIds, setPatientSearch, setError, setEditingStagedId, setHighlightedPatientIndex, setFormData, setSelectedPickupOption, shouldAutoFocusFields, focusRef: patientSearchInputRef, setNewPatientMode }); }
      else { setPatientSearch(''); setHighlightedPatientIndex(-1); }
      return;
    }
    if (e.key === 'Enter' && !patientSearch.trim()) {
      e.preventDefault();
      if (buttonState === 'done') { handleBatchSave(); } else if (buttonState === 'add' && isFormValid) { handleAddToStaging(); } else if (buttonState === 'updateStaged' && isFormValid) { handleUpdateStaged(); }
      return;
    }
    if (!patientSearch) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (filteredPatients.length > 0) { setHighlightedPatientIndex((prev) => prev < filteredPatients.length - 1 ? prev + 1 : prev); } else if (filteredPatients.length === 0 && addPatientButtonRef.current) { addPatientButtonRef.current.focus(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlightedPatientIndex((prev) => prev > 0 ? prev - 1 : -1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedPatientIndex >= 0 && filteredPatients.length > 0) { const selectedPat = filteredPatients[highlightedPatientIndex]; if (selectedPat) { handlePatientSelect(selectedPat, false); setPatientSearch(''); setHighlightedPatientIndex(-1); } }
      else if (filteredPatients.length === 0 && onCreatePatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver'))) {
        if (addPatientButtonRef.current) { addPatientButtonRef.current.click(); }
        else { setIsPatientFormOpen(true); onCreatePatient((newPatient) => { setIsPatientFormOpen(false); handlePatientSelect(newPatient); setPatientSearch(''); }); }
      } else if (!hasFormData) { if (buttonState === 'done') handleBatchSave(); else if (buttonState === 'updateStaged' && isFormValid) handleUpdateStaged(); else if (buttonState === 'add' && isFormValid) handleAddToStaging(); }
    }
  }, [patientSearch, filteredPatients, highlightedPatientIndex, handlePatientSelect, hasFormData, buttonState, isFormValid, handleBatchSave, handleUpdateStaged, handleAddToStaging, onCreatePatient, currentUser]);

  // Build scheduledDriverMap: storeId -> driverId, based on DriverScheduleOverride → store default fallback.
  // Kept in sync whenever the delivery date or stores/drivers change so it's ready when a patient is selected.
  useEffect(() => {
    if (!formData.delivery_date || !stores || stores.length === 0 || allDrivers.length === 0) {
      scheduledDriverMapRef.current = {};
      setScheduledDriverMap({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const overrides = await base44.entities.DriverScheduleOverride.filter({ date: formData.delivery_date });
        if (cancelled) return;
        const dateObj = new Date(formData.delivery_date + 'T00:00:00');
        const dow = dateObj.getDay();
        const prefix = dow === 0 ? 'sunday' : dow === 6 ? 'saturday' : 'weekday';
        const map = {};
        // For dispatchers: only map their single store; for admins/others: map all stores
        const isDispatcherOnly = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
        const storesToMap = isDispatcherOnly
          ? stores.filter((s) => s && s.id === (currentUser.store_ids || [])[0])
          : stores;
        for (const store of storesToMap) {
          if (!store) continue;
          const overrideAM = overrides.find((o) => o.store_id === store.id && o.slot_key === `${prefix}_am`);
          const overridePM = overrides.find((o) => o.store_id === store.id && o.slot_key === `${prefix}_pm`);
          // Store AM and PM separately so slot-aware lookup works correctly
          const amDriverId = overrideAM ? overrideAM.driver_id : store[`${prefix}_am_driver_id`] || null;
          const pmDriverId = overridePM ? overridePM.driver_id : store[`${prefix}_pm_driver_id`] || null;
          if (amDriverId) {
            const driver = allDrivers.find((d) => d && (d.id === amDriverId || d.user_id === amDriverId));
            if (driver) map[`${store.id}_AM`] = driver.id;
          }
          if (pmDriverId) {
            const driver = allDrivers.find((d) => d && (d.id === pmDriverId || d.user_id === pmDriverId));
            if (driver) map[`${store.id}_PM`] = driver.id;
          }
          // Also set base store key = AM slot for backwards compat (non-PM lookups)
          const primaryDriverId = amDriverId || pmDriverId;
          if (primaryDriverId) {
            const driver = allDrivers.find((d) => d && (d.id === primaryDriverId || d.user_id === primaryDriverId));
            if (driver) map[store.id] = driver.id;
          }
        }
        if (!cancelled) {
          scheduledDriverMapRef.current = map;
          setScheduledDriverMap(map);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [formData.delivery_date, stores, allDrivers]);

  useEffect(() => { setHighlightedPatientIndex(-1); }, [filteredPatients.length]);
  useEffect(() => { if (highlightedPatientIndex >= 0) { const element = document.getElementById(`patient-item-${highlightedPatientIndex}`); if (element) element.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }, [highlightedPatientIndex]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSaving) return false;
    setIsSaving(true); setError(null);
    try {
      const currentTravelMode = getPreferredTravelMode(appUsers || [], currentUser?.id);
      const dataToSave = await buildInTransitDirectSaveData({ prepareDeliverySaveData, formData, delivery, isCompletionStatus, completionTime, selectedPatient, stores, allDeliveries, stagedDeliveries, currentTravelMode });
      if (delivery?.id && !delivery?.patient_id && buildPickupSnapshot(delivery) === buildPickupSnapshot(dataToSave)) { import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm, onCancel })).catch(() => { handleClearForm(); onCancel(); }); return true; }
      if (delivery?.id && delivery?.patient_id && formData.patient_id) { try { await updatePatientLocal(formData.patient_id, buildPatientUpdatePayload(formData)); } catch (error) { console.error('❌ [DeliveryForm] Failed to sync patient changes:', error); } }
      const { driverChanged, dateChanged, timeWindowChanged, travelModeChanged, statusChangedToInTransit, statusChangedToCompletion, actualDeliveryTimeChanged, codWasRemoved } = getDeliverySubmitFlags({ delivery, formData, dataToSave });
      const travelModeOnly = !!delivery && travelModeChanged && !driverChanged && !dateChanged && !timeWindowChanged && !statusChangedToInTransit && !statusChangedToCompletion && !actualDeliveryTimeChanged;
      const oldDriver = driverChanged ? drivers.find((d) => d?.id === delivery.driver_id) : null;
      const newDriver = driverChanged ? drivers.find((d) => d?.id === formData.driver_id) : null;
      if (dateChanged) { dataToSave.status = 'in_transit'; dataToSave.time_window_start = '10:00'; }
      if (statusChangedToInTransit && delivery?.id && formData.cod_total_amount_required > 0) { const store = stores?.find(s => s && s.id === formData.store_id); triggerSquareCodCreate({ deliveryId: delivery.id, patientName: formData.patient_name, storeAbbreviation: store?.abbreviation || '', codAmount: formData.cod_total_amount_required / 100, deliveryDate: formData.delivery_date, storeId: formData.store_id }); }
      if (statusChangedToCompletion) dataToSave.isNextDelivery = false;
      if (statusChangedToCompletion) { triggerSquareCodDelete({ deliveryId: delivery?.id, nextStatus: formData.status, delivery: { ...delivery, ...dataToSave, cod_payments: formData.cod_payments, cod_payment_type: formData.cod_payment_type } }); }
      if (delivery?.id) {
        await syncDeliveryCodOnUpdate({ delivery, formData, stores, base44, dataToSave });
        await updateDeliveryLocal(delivery.id, buildUpdatedDeliveryPayload({ dataToSave, formData }));
        const skipImmediateDeliveriesUpdatedEvent = Boolean(timeWindowChanged || travelModeOnly);
        if (['completed', 'failed', 'cancelled'].includes(formData.status)) {
          const expectedTravelDist = Number(dataToSave.travel_dist ?? formData.travel_dist ?? 0);
          const currentTravelDist = Number(delivery?.travel_dist ?? 0);
          const shouldRefreshTravelDist = currentTravelDist <= 0 || (expectedTravelDist > 0 && Math.abs(currentTravelDist - expectedTravelDist) > 0.25);
          if (shouldRefreshTravelDist) { setTimeout(() => { base44.functions.invoke('recalculateTravelDistance', { deliveryId: delivery.id, expectedTravelDist, force: false }).catch((err) => console.warn('⚠️ [DeliveryForm] Travel distance refresh failed:', err?.message || err)); }, 0); }
        }
        if (statusChangedToCompletion) triggerPatientLastDeliverySync({ delivery: { ...delivery, ...dataToSave, status: formData.status, patient_id: delivery.patient_id, delivery_date: formData.delivery_date }, previousStatus: delivery.status });
        if (formData.status === 'completed') cleanupSquareCodCatalogForDate(formData.delivery_date);
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        if (!skipImmediateDeliveriesUpdatedEvent) { window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryId: delivery.id, deliveryDate: formData.delivery_date, driverId: formData.driver_id, triggeredBy: travelModeOnly ? 'deliveryFormTravelModeOnly' : 'deliveryFormUpdate' } })); }
      } else {
        if (buttonState === 'add' || buttonState === 'updateStaged' || buttonState === 'done') { setIsSaving(false); return false; }
        let resolvedPuid = dataToSave.puid || '';
        if (!delivery?.id && pendingRoutePickup?._pendingCreate && !isPickupMode) {
          const pickupStore = stores?.find((s) => s && s.id === pendingRoutePickup.store_id);
          const pickupTimes = resolvePickupTimeWindow({ store: pickupStore, deliveryDate: pendingRoutePickup.delivery_date, timeSlot: pendingRoutePickup.ampm_deliveries || 'AM' });
          const createdPickup = await createDeliveryLocal({ ...pendingRoutePickup, status: 'en_route', delivery_time_start: pickupTimes?.delivery_time_start || '', delivery_time_end: pickupTimes?.delivery_time_end || '', time_window_start: pickupTimes?.delivery_time_start || '', time_window_end: pickupTimes?.delivery_time_end || '' });
          resolvedPuid = createdPickup?.stop_id || createdPickup?.puid || pendingRoutePickup.stop_id || '';
          setPendingRoutePickup(null); setSelectedRoutePickup(createdPickup || null); setSelectedPickupOption(buildPickupSelectValue(createdPickup || pendingRoutePickup));
        }
        await onSave({ ...dataToSave, puid: resolvedPuid, receipt_barcode_values: Array.isArray(formData.receipt_barcode_values) ? formData.receipt_barcode_values : [] });
      }
      await runDeliverySubmitSideEffects({ delivery, formData, selectedPatient, currentUser, oldDriver, newDriver, driverChanged, isCurrentUserDriver: userHasRole(currentUser, 'driver'), statusChangedToCompletion, actualDeliveryTimeChanged, timeWindowChanged, travelModeChanged, t: dataToSave.actual_delivery_time, allDeliveries, isPickupMode, updateDeliveryLocal, dateChanged, skipRouteOptimization: Boolean(delivery?.isNextDelivery && ['completed', 'failed', 'cancelled'].includes(formData.status)) });
      return true;
    } catch (error) { setError(error.message); return false; }
    finally { setIsSaving(false); }
  };

  const handleCancelClick = useCallback(() => {
    const hasNewStagedDeliveries = stagedDeliveries.some((d) => !d.id);
    if (hasNewStagedDeliveries && !delivery) {
      const confirmed = window.confirm('You have unsaved deliveries. Discard them?');
      if (confirmed) {
        (async()=>{try{const c=stagedDeliveries.filter(d=>!d.patient_id&&d._autoCreated);for(const p of c){const attached=stagedDeliveries.some(sd=>sd.patient_id&&sd.puid===p.stop_id);if(!attached&&p.id){await deleteDeliveryLocal(p.id);autoCreatedPickupsRef.current.delete(p.id);}}setStagedDeliveries(prev=>{const hasAttached=(sid)=>prev.some(sd=>sd.patient_id&&sd.puid===sid);return prev.filter(d=>!( !d.patient_id && d._autoCreated && !hasAttached(d.stop_id) ));});}catch(e){}})();
        setStagedDeliveries([]); setProjectedDeliveries([]); hasLoadedPending.current = false;
        import('../utils/deliveryFormActionHelpers').then(({ resumeDeliveryFormManagers }) => resumeDeliveryFormManagers()).catch((error) => { console.warn('⚠️ [DeliveryForm] Failed to resume managers:', error); });
        import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm, onCancel })).catch(()=>{handleClearForm();onCancel();});
      }
    } else {
      if (!delivery) hasLoadedPending.current = false;
      resumeDeliveryFormManagers().catch((error) => { console.warn('⚠️ [DeliveryForm] Failed to resume managers:', error); });
      import('../utils/deliveryFormActionHelpers').then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm, onCancel })).catch(()=>{handleClearForm();onCancel();});
    }
  }, [stagedDeliveries, onCancel, delivery]);

  useEffect(() => {
    const handleEscapeKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (showCameraOverlay) { stopCamera(); setShowCameraOverlay(false); setIsScanning(false); }
      else if (delivery || cancelButtonState !== 'clear') { handleCancelClick(); }
      else { handleClearForm(); }
    };
    document.addEventListener('keydown', handleEscapeKey);
    return () => document.removeEventListener('keydown', handleEscapeKey);
  }, [cancelButtonState, delivery, handleCancelClick, handleClearForm, showCameraOverlay, stopCamera]);

  useEffect(() => {
    const handleKeyDown = (e) => { if (e.shiftKey || e.ctrlKey || e.metaKey) setIsMultiSelectMode(true); };
    const handleKeyUp = (e) => { if (!e.shiftKey && !e.ctrlKey && !e.metaKey) setIsMultiSelectMode(false); };
    window.addEventListener('keydown', handleKeyDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); window.removeEventListener('keyup', handleKeyUp); };
  }, []);

  useEffect(() => {
    if (shouldAutoFocusFields) requestAnimationFrame(() => { patientSearchInputRef.current?.focus?.(); });
    setIsFormOverlayOpen(true);
    (async () => {
      try {
        const { smartRefreshManager } = await import('../utils/smartRefreshManager'); smartRefreshManager.pause();
        const { routePolylineManager } = await import('../utils/routePolylineManager'); routePolylineManager?.pause?.();
        const { fabControlEvents } = await import('../utils/fabControlEvents'); fabControlEvents.pauseFAB();
      } catch (error) { console.warn('⚠️ [DeliveryForm] Failed to pause some managers:', error); }
    })();
    return () => {
      setIsFormOverlayOpen(false);
      loadedDeliveryIdRef.current = null;
      (async () => {
        try {
          const { smartRefreshManager } = await import('../utils/smartRefreshManager'); smartRefreshManager.resume(); smartRefreshManager.resetTimers?.();
          const { routePolylineManager } = await import('../utils/routePolylineManager'); routePolylineManager?.resume?.();
          const { fabControlEvents } = await import('../utils/fabControlEvents'); fabControlEvents.resumeFAB();
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        } catch (error) { console.warn('⚠️ [DeliveryForm] Failed to resume some managers:', error); }
      })();
    };
  }, [setIsFormOverlayOpen]);

  const handleRecurringChange = useCallback((checked) => {
    if (!checked) { setFormData((prev) => clearRecurringSelection(prev)); setShowDayPopup(false); }
    else { setFormData((prev) => ({ ...prev, recurring: true })); }
  }, []);

  const handleFrequencyChange = useCallback((newFrequency) => {
    if (newFrequency === 'weekly' || newFrequency === 'bi-weekly' || newFrequency === 'weekly-x4') { setActiveRecurringType(newFrequency); setShowDayPopup(true); }
    else { setShowDayPopup(false); setActiveRecurringType(null); }
    setFormData((prev) => {
      const newState = { ...prev, recurring_daily: newFrequency === 'daily', recurring_biweekly: newFrequency === 'bi-weekly', recurring_weekly_x4: newFrequency === 'weekly-x4', recurring_monthly: newFrequency === 'monthly', recurring_bimonthly: newFrequency === 'bi-monthly' };
      if (newFrequency !== 'weekly' && newFrequency !== 'bi-weekly' && newFrequency !== 'weekly-x4') { newState.recurring_weekly_mon = false; newState.recurring_weekly_tue = false; newState.recurring_weekly_wed = false; newState.recurring_weekly_thu = false; newState.recurring_weekly_fri = false; newState.recurring_weekly_sat = false; newState.recurring_weekly_sun = false; }
      if (newFrequency) newState.recurring = true;
      return newState;
    });
  }, []);

  const handleWeeklyDaysDone = useCallback(() => {
    setShowDayPopup(false); setActiveRecurringType(null);
    setFormData((prev) => {
      const anyDaySelected = prev.recurring_weekly_mon || prev.recurring_weekly_tue || prev.recurring_weekly_wed || prev.recurring_weekly_thu || prev.recurring_weekly_fri || prev.recurring_weekly_sat || prev.recurring_weekly_sun;
      const newRecurringState = anyDaySelected || prev.recurring_daily || prev.recurring_biweekly || prev.recurring_weekly_x4 || prev.recurring_monthly || prev.recurring_bimonthly;
      return { ...prev, recurring: newRecurringState };
    });
  }, []);

  useEffect(() => {
    if (delivery || !allDeliveries || !formData.driver_id || !formData.delivery_date) return;
    const existingActiveStops = allDeliveries.filter((d) => d && d.patient_id && d.driver_id === formData.driver_id && d.delivery_date === formData.delivery_date && ['pending', 'en_route', 'in_transit'].includes(d.status));
    setIsNewRouteWithZeroStops(existingActiveStops.length === 0);
  }, [delivery, allDeliveries, formData.driver_id, formData.delivery_date]);

  useEffect(() => {
    if (delivery || stagedDeliveries.length === 0) return;
    const deletedPendingDeliveries = stagedDeliveries.filter((staged) => { if (!staged.id) return false; return !allDeliveries?.some((d) => d && d.id === staged.id); });
    if (deletedPendingDeliveries.length > 0) {
      setStagedDeliveries((prev) => prev.filter((staged) => !deletedPendingDeliveries.some((del) => del.id === staged.id)));
      const remainingStagedIds = new Set(stagedDeliveries.filter((staged) => !deletedPendingDeliveries.some((del) => del.id === staged.id)).map((d) => d.patient_id).filter(Boolean));
      const filteredPredictions = fullPredictionListRef.current.filter((pred) => !remainingStagedIds.has(pred.patient_id));
      setProjectedDeliveries(filteredPredictions);
      if (editingStagedId && deletedPendingDeliveries.some((d) => d._tempId === editingStagedId)) { setEditingStagedId(null); handleClearForm(); }
    }
  }, [allDeliveries, stagedDeliveries.length, delivery]);

  useEffect(() => {
    if (delivery || hasLoadedPending.current) return;
    if (!allDeliveries || !suggestedDate || !currentUser || !Array.isArray(patients) || !Array.isArray(stores) || !patients.length || !stores.length) return;
    if (stagedDeliveries.length > 0) { hasLoadedPending.current = true; return; }
    const pendingDeliveries = filterPendingDeliveriesForUser({ allDeliveries, suggestedDate, currentUser, userHasRole });
    if (pendingDeliveries.length === 0) { hasLoadedPending.current = true; return; }
    const newStagedItems = mapPendingDeliveriesToStaged({ pendingDeliveries, patients, stores, allDeliveries, calculateDistance });
    const mappedPendingIds = new Set(newStagedItems.map((item) => item?.id).filter(Boolean));
    const unresolvedPendingCount = pendingDeliveries.filter((item) => item?.id && !mappedPendingIds.has(item.id)).length;
    setTimeout(() => { setStagedDeliveries(newStagedItems); setHasChanges(false); if (unresolvedPendingCount === 0) hasLoadedPending.current = true; }, 100);
  }, [delivery, allDeliveries, currentUser, patients, stores, suggestedDate, stagedDeliveries.length]);

  // Resolve InterStore From/To locations from delivery_id phone numbers when editing
  useEffect(() => {
    if (!delivery?.id || !isInterStoreMode) return;
    // Already have IDs saved on the delivery — nothing to do
    if (delivery._interstore_source_id && delivery._interstore_dest_id) return;

    const deliveryId = delivery.delivery_id || '';
    if (!deliveryId) return;

    // Parse: ISP-{timestamp}-{fromPhone}-{toPhone}
    const parts = deliveryId.split('-');
    if (parts.length < 4) return;
    const fromPhone = parts[2];
    const toPhone = parts[3];
    if (!fromPhone || !toPhone) return;

    let cancelled = false;
    const resolve = async () => {
      try {
        const allLocs = await base44.entities.InterStoreLocation.list();
        if (cancelled) return;

        const findByPhone = (phone) => allLocs?.find((l) => l?.store_phone && String(l.store_phone).replace(/\D/g, '') === phone);
        const srcLoc = findByPhone(fromPhone);
        const dstLoc = findByPhone(toPhone);

        if (srcLoc || dstLoc) {
          setFormData((prev) => ({
            ...prev,
            _interstore_resolving: false,
            ...(srcLoc ? {
              _interstore_source_id: srcLoc.id,
              _interstore_source_name: srcLoc.store_name,
              _interstore_source_number: srcLoc.store_number || srcLoc.store_name,
            } : {}),
            ...(dstLoc ? {
              _interstore_dest_id: dstLoc.id,
              _interstore_dest_name: dstLoc.store_name,
              _interstore_dest_number: dstLoc.store_number || dstLoc.store_name,
            } : {}),
          }));
        } else {
          setFormData((prev) => ({ ...prev, _interstore_resolving: false }));
        }
      } catch {
        if (!cancelled) setFormData((prev) => ({ ...prev, _interstore_resolving: false }));
      }
    };
    resolve();
    return () => { cancelled = true; };
  }, [delivery?.id, isInterStoreMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const initialPuidRef = useRef(null);
  useEffect(() => { if (delivery && delivery.puid) initialPuidRef.current = delivery.puid; }, [delivery?.id]);
  useEffect(() => {
    if (delivery && initialPuidRef.current) return;
    if (delivery && !isPickupMode && formData.store_id && formData.delivery_date && allDeliveries && stores && !initialPuidRef.current) {
      const store = stores.find((s) => s && s.id === formData.store_id);
      if (store) { const timeSlot = getStoreAssignedTimeSlot(store, formData.delivery_date, allDeliveries); const newPuid = getPickupStopIdForDelivery(store.id, formData.delivery_date, timeSlot, allDeliveries); if (newPuid !== formData.puid) setFormData((prev) => ({ ...prev, puid: newPuid || '' })); }
    }
  }, [formData.store_id, delivery, isPickupMode, formData.delivery_date, stores, allDeliveries]);

  const confirmAddProjectedToStaged = useCallback(async (projected) => {
    const store = (freshStores || stores).find((s) => s && s.id === projected.store_id);
    if (!store) { console.error('Store not found for projected delivery:', projected.store_id); return; }
    const patient = patients.find((p) => p && p.id === projected.patient_id);
    if (!patient) { console.error('Patient not found for projected delivery:', projected.patient_id); return; }
    const distanceFromStore = resolveDistanceFromStore({ patient, store, calculateDistance });
    const isDispatcherOnly = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
    const { autoSelectedDriverId, autoSelectedDriverName } = isDispatcherOnly
      ? { autoSelectedDriverId: '', autoSelectedDriverName: '' }
      : resolveProjectedDeliveryDriver({ store, patient, deliveryDate: formData.delivery_date, drivers, getDriverNameForStorage, scheduledDriverMap: scheduledDriverMapRef.current });
    const autoDriverId = autoSelectedDriverId || formData.driver_id;
    const timeSlot = formData.ampm_deliveries || getStoreAssignedTimeSlotForDriver(store, formData.delivery_date, autoDriverId, allDeliveries);
    const puid = await resolvePickupPuid({ stagedDeliveries, allDeliveries, storeId: projected.store_id, deliveryDate: formData.delivery_date, driverId: autoDriverId, timeSlot, allowRecentlyCompleted: true });
    const newStagedItem = buildProjectedStagedItem({ projected, patient, store, formData, timeSlot, autoSelectedDriverId, autoSelectedDriverName, distanceFromStore });
    setProjectedDeliveries((prev) => prev.filter((p) => p.patient_id !== projected.patient_id));
    setStagedDeliveries((prev) => [...prev, puid ? { ...newStagedItem, puid } : newStagedItem]);
    setHasChanges(true);
  }, [formData, freshStores, stores, patients, drivers, allDeliveries, stagedDeliveries]);

  const sortedStagedDeliveries = useMemo(() => sortStagedDeliveries({ stagedDeliveries, stores, selectedDriverId: formData.driver_id }), [stagedDeliveries, stores, formData.driver_id]);
  const isDispatcherOnly = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
  const sortedProjectedDeliveries = useMemo(() => sortProjectedDeliveries({ projectedDeliveries, allDeliveries, stores, selectedDriverId: formData.driver_id, deliveryDate: formData.delivery_date, isDispatcher: isDispatcherOnly, scheduledDriverMap }), [projectedDeliveries, allDeliveries, stores, formData.driver_id, formData.delivery_date, isDispatcherOnly, scheduledDriverMap]);
  const handleConfirmDelete = useConfirmDelete({ deleteConfirmation, setDeleteConfirmation, sortedStagedDeliveries, stagedDeliveries, editingStagedId, handleClearForm, setStagedDeliveries, setProjectedDeliveries, fullPredictionListRef, allDeliveries, formData, setHasChanges, setHasPendingDeletes, setEditingStagedId, setError, setIsDeletingPending, setAllDeletedWerePending });

  // Reset manual-change flag whenever the delivery date changes (so auto-select re-runs)
  const prevDeliveryDateRef = useRef(formData.delivery_date);
  useEffect(() => {
    if (formData.delivery_date !== prevDeliveryDateRef.current) {
      prevDeliveryDateRef.current = formData.delivery_date;
      driverManuallyChangedRef.current = false; // date changed — re-derive scheduled driver
    }
  }, [formData.delivery_date]);

  return (
    <DeliveryFormView
      formRef={formRef} useMobileLayout={useMobileLayout} isMobileDevice={isMobileDevice} useFullscreen={useFullscreen}
      delivery={delivery} formData={formData} setFormData={setFormData} isPickupMode={isPickupMode} setIsPickupMode={setIsPickupMode} isInterStoreMode={isInterStoreMode} setIsInterStoreMode={setIsInterStoreMode}
      isCyclingMarkerMode={isCyclingMarkerMode} setIsCyclingMarkerMode={setIsCyclingMarkerMode}
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
      onDriverManuallyChanged={() => { driverManuallyChangedRef.current = true; }}
      appUsers={appUsers}
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
      handleCancelClick={handleCancelClick} handleBatchSave={handleBatchSave} handleUpdateStaged={handleUpdateStaged} handleAddToStaging={handleAddToStaging} handleAddInterStoreTransfer={handleAddInterStoreTransfer}
      handleSubmit={handleSubmit} buttonState={buttonState} cancelButtonState={cancelButtonState} pickupsAddedCount={pickupsAddedCount}
      isFormValid={isFormValid} hasChanges={hasChanges} isPatientFormOpen={isPatientFormOpen}
      closeOnSave={closeOnSave} onCancel={onCancel} openMode={openMode}
      forceOpenDriverOnLoad={forceOpenDriverSelectOnLoad}
      applyDeliveryChangesLocally={applyDeliveryChangesLocally}
      scheduledDriverMap={scheduledDriverMap}
    />
  );
}