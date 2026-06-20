/**
 * DeliveryFormView - The pure render/JSX layer for DeliveryForm.
 * All logic remains in DeliveryForm.jsx; this file just renders it.
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { X, Save, Package, Plus, CheckCircle, Edit2, AlertCircle, Car, Bike } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PhoneInput } from "@/components/ui/phone-input";
import { getPickupStopIdForDelivery, determineDeliveryAMPM, getStoreAssignedTimeSlot } from '../utils/ampmUtils';
import { generateBikDeliveryId } from '@/components/utils/idGenerator';
import { isAppOwner } from '../utils/userRoles';
import SmartBarcodeScanner from './SmartBarcodeScanner';
import PatientMatchPopup from './PatientMatchPopup';
import DeliveryPatientSearch from './DeliveryPatientSearch';
import DeliveryRecurringOptions from './DeliveryRecurringOptions';
import { getAddButtonStatus } from './Add2RouteStatusHelper';
import LargeBarcodePreview from './LargeBarcodePreview';
import DeliveryStatusAndTiming from './DeliveryStatusAndTiming';
import DeliveryCameraOverlay from './DeliveryCameraOverlay';
import { DeliveryStagedPanelDesktop, DeliveryStagedPanelMobile, DeliveryDeleteConfirmDialog } from './DeliveryStagedPanel';
import { runPostDeliveryUpdateSync, closeDeliveryFormAfterSave } from '../utils/deliveryFormActionHelpers';
import { recalculateAndUpdateStopOrders } from '../utils/stopOrderManager';
import { handleBatchSaveDelivery } from '@/components/dashboard/handleBatchSaveDelivery.jsx';
import { toast } from 'sonner';
import { globalFilters } from '@/components/utils/globalFilters';
import { fabControlEvents } from '@/components/utils/fabControlEvents';
import { acquireDeliveryActionLock, releaseDeliveryActionLock, getActiveDeliveryAction, subscribeDeliveryActionLock } from '../utils/deliveryActionLock';
import { renderDeliveryIdentifiersSection } from './deliveryFormHelpers';
import PickupLocationMultiSelect from './PickupLocationMultiSelect';
import { buildDeliveryStagedPanelProps } from './deliveryStagedPanelPropsHelper';
import InterStoreFormContent from './InterStoreFormContent';

const CheckboxField = ({ id, label, checked, onChange, disabled }) =>
<div className="flex items-center space-x-2">
    <Checkbox id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    <Label htmlFor={id} className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">{label}</Label>
  </div>;

const TravelModeButtons = ({ value, onChange, disabled, currentUser, appUsers = [], useMobileLayout = false }) => {
  const options = [
  { value: 'driving', label: 'Driving', icon: Car },
  { value: 'cycling', label: 'Cycling', icon: Bike }];

  return (
    <div className={`${useMobileLayout ? 'flex flex-col gap-1' : 'flex flex-row gap-2'} shrink-0`}>
      {options.map((option) => {
        const Icon = option.icon;
        const isActive = value === option.value;

        return (
          <button
            key={option.value}
            type="button"
            title={option.label}
            aria-label={option.label}
            onClick={async () => {
              await onChange(option.value, currentUser, appUsers);
            }}
            disabled={disabled}
            className={`h-6 w-12 rounded-full border transition-all flex items-center justify-center ${
            isActive ?
            'bg-emerald-600 border-emerald-600 text-white' :
            'bg-white border-slate-300 text-slate-600 hover:bg-slate-100'}`
            }>
            <Icon className="w-4 h-4" />
          </button>);

      })}
    </div>);

};

const userHasRole = (user, role) => {
  if (!user || !role) return false;
  if (Array.isArray(user.app_roles)) return user.app_roles.includes(role);
  if (user.app_role === role) return true;
  return false;
};

export default function DeliveryFormView({
  // Layout
  formRef, useMobileLayout, isMobileDevice, useFullscreen,
  // Core state
  delivery, formData, setFormData, isPickupMode, setIsPickupMode, isInterStoreMode, setIsInterStoreMode,
  isCyclingMarkerMode = false, setIsCyclingMarkerMode,
  isSaving, isDeliveryActionBusy = false, error, isPayrollLocked, payrollLockMessage, isFormLockedByPayroll,
  isFormDisabled, isCompletionStatus,
  // Patient search
  patientSearch, setPatientSearch, selectedPatient, filteredPatients,
  highlightedPatientIndex, setHighlightedPatientIndex,
  selectedPatientIds, setSelectedPatientIds, isMultiSelectMode,
  patientSearchInputRef, addPatientButtonRef, patientNameInputRef,
  shouldAutoFocusFields = !isMobileDevice,
  isScanning, showCameraOverlay,
  handleSearchKeyDown, handlePatientSelect, handleAddSelectedPatients,
  handleDuplicatePatient, handleNewAddressPatient,
  onCreatePatient, setIsPatientFormOpen,
  // Camera
  videoRef, canvasRef, handleCameraCapture,
  startCamera, stopCamera, setShowCameraOverlay, setIsScanning,
  // Patient match popup
  showMatchPopup, scanMatches, extractedData, handleSelectMatchedPatient,
  setShowMatchPopup, setScanMatches, setExtractedData,
  // Stores/drivers
  availableStores, allDrivers, stores, patients, currentUser,
  appUsers, allDeliveries, selectedPickupOption, setSelectedPickupOption,
  getDriverDisplayName, getDriverNameForStorage,
  editingStagedId, setStagedDeliveries, setHasChanges,
  // Completion time
  completionTime, setCompletionTime,
  // Staged panel
  sortedStagedDeliveries, sortedProjectedDeliveries, stagedDeliveries,
  projectedDeliveries, setProjectedDeliveries, fullPredictionListRef,
  setEditingStagedId, handleStagedDeliveryClick, handleClearForm,
  confirmAddProjectedToStaged, isLoadingPredictions,
  handleRefreshProjections, showStagedPanel, setShowStagedPanel,
  // Delete dialog
  deleteConfirmation, setDeleteConfirmation, isDeletingPending,
  handleConfirmDelete,
  // Recurring
  currentFrequency, weeklyLabel, biWeeklyLabel, weeklyX4Label,
  showDayPopup, setShowDayPopup, setActiveRecurringType,
  handleRecurringChange, handleFrequencyChange, handleWeeklyDaysDone,
  // PID
  pidInputValue, setPidInputValue, pidLookupStatus, setPidLookupStatus,
  originalPidRef, updatePatientLocal, codAmountInputRef,
  // Actions
  handleCancelClick, handleBatchSave, handleUpdateStaged, handleAddToStaging, handleAddInterStoreTransfer,
  handleSubmit, handleClearForm: _handleClearForm,
  buttonState, cancelButtonState, isFormValid, hasChanges, isPatientFormOpen,
  closeOnSave, onCancel, openMode, forceOpenDriverOnLoad = false, pickupsAddedCount = 0,
  applyDeliveryChangesLocally, onDriverManuallyChanged,
  scheduledDriverMap = {}
}) {
  const activeFieldScrollFrameRef = useRef(null);
  const barcodeInputRef = useRef(null);
  // Multi-select pickup store IDs (local to view)
  const [selectedPickupStoreIds, setSelectedPickupStoreIds] = React.useState(new Set());
  // InterStore: tracks whether both From + To are selected (gates the Add/Done button)
  const [interStoreReady, setInterStoreReady] = React.useState(false);
  // InterStore: force-open the driver dropdown when both stores selected but no driver
  const [forceOpenInterStoreDriverSelect, setForceOpenInterStoreDriverSelect] = React.useState(false);
  const prevInterStoreReadyRef = React.useRef(false);
  React.useEffect(() => {
    if (!isInterStoreMode || !interStoreReady || formData.driver_id) {
      prevInterStoreReadyRef.current = interStoreReady;
      return;
    }
    // Both stores selected and no driver yet — try to auto-select from schedule
    const deliveryDate = formData.delivery_date;
    if (deliveryDate) {
      // Try destination store first (match InterStoreLocation name → Store), fall back to origin store
      const destLocName = formData._interstore_dest_name || '';
      const srcLocName = formData._interstore_source_name || '';
      const destStore = stores?.find((s) => s && s.name && destLocName && s.name.toLowerCase() === destLocName.toLowerCase());
      const srcStore = stores?.find((s) => s && s.name && srcLocName && s.name.toLowerCase() === srcLocName.toLowerCase());
      const storeToUse = destStore || srcStore;
      if (storeToUse) {
        const { driverId } = getDefaultDriverForStoreSlot(storeToUse.id, 'AM', deliveryDate);
        if (driverId) {
          const driver = allDrivers.find((d) => d.id === driverId);
          if (driver) {
            setFormData((prev) => ({ ...prev, driver_id: driverId, driver_name: getDriverNameForStorage(driver) }));
            prevInterStoreReadyRef.current = interStoreReady;
            return;
          }
        }
      }
    }
    // No scheduled driver found — prompt manual selection
    setForceOpenInterStoreDriverSelect(true);
    prevInterStoreReadyRef.current = interStoreReady;
  }, [isInterStoreMode, interStoreReady, formData.driver_id]);
  // In interstore mode, keep the 'add' button visible — never auto-switch to 'done'
  // In pickup mode with stores checked, keep 'add' active so user can add more pickups
  const effectiveButtonState = isInterStoreMode && !delivery ? 'add'
    : isPickupMode && !delivery && selectedPickupStoreIds.size > 0 ? 'add'
    : buttonState;

  // Clear selectedPickupStoreIds when form is cleared (selectedPickupOption reset to '')
  React.useEffect(() => {
    if (!selectedPickupOption && !formData.store_id) {
      setSelectedPickupStoreIds(new Set());
    }
  }, [selectedPickupOption, formData.store_id]);

  // Handle the Add button: iterate through all selected stores sequentially
  const handleAddPickupsMulti = React.useCallback(async () => {
    if (!isPickupMode) {
      await handleAddToStaging();
      return;
    }

    // Build the list of stores to add — either multi-select or single (current formData)
    // Sort by delivery_time_start so pickups are added in chronological order
    const idsToAdd = selectedPickupStoreIds.size > 0 ?
    Array.from(selectedPickupStoreIds) :
    selectedPickupOption ? [selectedPickupOption] : [];

    if (idsToAdd.length === 0) {
      await handleAddToStaging();
      return;
    }

    // Sort the store options by their scheduled start time before processing
    const getStoreSlotStartTime = (store) => {
      if (!store) return '';
      const slot = store._timeSlot || 'AM';
      const dateObj = new Date((formData.delivery_date || '') + 'T00:00:00');
      const day = dateObj.getDay(); // 0=Sun, 6=Sat
      if (slot === 'PM') {
        if (day === 6) return store.saturday_pm_start || '';
        if (day === 0) return store.sunday_pm_start || '';
        return store.weekday_pm_start || '';
      }
      if (day === 6) return store.saturday_am_start || '';
      if (day === 0) return store.sunday_am_start || '';
      return store.weekday_am_start || '';
    };

    const sortedIds = [...idsToAdd].sort((a, b) => {
      const storeA = availableStores.find((s) => s && s.id === a);
      const storeB = availableStores.find((s) => s && s.id === b);
      return getStoreSlotStartTime(storeA).localeCompare(getStoreSlotStartTime(storeB));
    });

    setSelectedPickupStoreIds(new Set());

    const createdPickupsThisBatch = [];
    for (const storeOptionId of sortedIds) {
      const sel = availableStores.find((s) => s && s.id === storeOptionId);
      if (!sel) continue;
      const baseId = sel._originalStoreId || sel.id;
      const slot = sel._timeSlot || 'AM';
      // Build override form data for this store
      const overrideFormData = {
        ...formData,
        store_id: baseId,
        ampm_deliveries: slot
      };
      // Pass previously created pickups so tracking numbers don't collide
      const created = await handleAddToStaging(overrideFormData, createdPickupsThisBatch);
      if (created) createdPickupsThisBatch.push(created);
    }

    // After all pickups are created, recalculate stop orders once so they sort by ETA/time
    if (createdPickupsThisBatch.length > 0) {
      const driverId = formData.driver_id;
      const deliveryDate = formData.delivery_date;
      if (driverId && deliveryDate) {
        setTimeout(() => {
          recalculateAndUpdateStopOrders(driverId, deliveryDate, true);
        }, 500);
      }
    }
  }, [isPickupMode, selectedPickupStoreIds, selectedPickupOption, availableStores, formData, handleAddToStaging]);
  const shouldUseCompactPickupEditHeight = Boolean(delivery && isPickupMode && !useMobileLayout);
  const stagedCount = React.useMemo(() => ({
    new: sortedStagedDeliveries.filter((s) => !s.id).length,
    pending: sortedStagedDeliveries.filter((s) => s.id).length
  }), [sortedStagedDeliveries]);
  const [activeDeliveryAction, setActiveDeliveryAction] = React.useState(getActiveDeliveryAction());
  const effectiveDeliveryActionBusy = isDeliveryActionBusy || !!activeDeliveryAction && activeDeliveryAction !== 'update_delivery';
  const enterActionLockRef = React.useRef(false);

  React.useEffect(() => subscribeDeliveryActionLock(setActiveDeliveryAction), []);

  const runLockedAction = React.useCallback(async (actionName, action) => {
    const lock = acquireDeliveryActionLock(actionName);
    if (!lock) {
      toast.message('Please wait for the current delivery action to finish.');
      return;
    }

    try {
      return await action();
    } finally {
      releaseDeliveryActionLock(lock);
    }
  }, []);

  // Require driver selection when no regular pickup exists for the patient's store/date/slot
  const requiresDriverSelection = (() => {
    if (delivery || isPickupMode) return false; // only for new patient deliveries
    if (formData?.driver_id) return false; // driver already chosen
    const patientToCheck = selectedPatient || (formData?.patient_id && patients ? patients.find((p) => p && p.id === formData.patient_id) : null);
    const storeId = patientToCheck?.store_id || formData?.store_id;
    if (!storeId || !formData?.delivery_date) return false; // don't block when incomplete
    const storeObj = stores?.find((s) => s && s.id === storeId);
    const slot = determineDeliveryAMPM(patientToCheck) || getStoreAssignedTimeSlot(storeObj, formData.delivery_date, allDeliveries) || 'AM';
    const existsInStaged = (stagedDeliveries || []).some((d) => !d.patient_id && d.store_id === storeId && d.delivery_date === formData.delivery_date && (d.ampm_deliveries || 'AM') === slot);
    const existsInSaved = (allDeliveries || []).some((d) => d && !d.patient_id && d.store_id === storeId && d.delivery_date === formData.delivery_date && (d.ampm_deliveries || 'AM') === slot && !['completed', 'cancelled', 'returned'].includes(d.status));
    return !(existsInStaged || existsInSaved);
  })();

  const hasSelectedLocationAndDriver = Boolean(
    formData?.delivery_date && formData?.driver_id && (formData?.store_id || selectedPatient?.store_id || selectedPickupOption)
  );

  // Auto-open the driver dropdown when a driver must be selected
  const [forceOpenDriverSelect, setForceOpenDriverSelect] = React.useState(false);
  const prevRequiresDriverSelectionRef = React.useRef(false);
  React.useEffect(() => {
    const shouldOpen = requiresDriverSelection || forceOpenDriverOnLoad;
    // Only open programmatically when transitioning from not-required → required.
    // Never force-close via this effect — the Select's onValueChange handles that,
    // preventing the double-open caused by the effect firing after a driver is chosen.
    if (shouldOpen && !prevRequiresDriverSelectionRef.current) {
      setForceOpenDriverSelect(true);
    }
    prevRequiresDriverSelectionRef.current = requiresDriverSelection;
  }, [requiresDriverSelection, forceOpenDriverOnLoad]);

  React.useEffect(() => {
    const handleForceOpenDriverSelect = () => setForceOpenDriverSelect(true);
    window.addEventListener('forceOpenDeliveryDriverSelect', handleForceOpenDriverSelect);
    return () => window.removeEventListener('forceOpenDeliveryDriverSelect', handleForceOpenDriverSelect);
  }, []);

  // Helper: get default driver ID for a store based on date and time slot.
  // Checks DriverScheduleOverride (via scheduledDriverMap, which is already override-aware)
  // first, then falls back to the store's default driver fields.
  const getDefaultDriverForStoreSlot = (storeId, timeSlot, deliveryDate) => {
    const store = stores?.find((s) => s && s.id === storeId);
    if (!store || !deliveryDate) return { driverId: null, resolvedSlot: timeSlot || null, hasAnyAssignedSlot: false };

    // scheduledDriverMap is keyed by storeId and already resolves overrides → store default.
    // Use it when the date matches the form's current delivery_date (the common case).
    if (scheduledDriverMap && deliveryDate === formData.delivery_date) {
      const overrideDriverId = scheduledDriverMap[storeId] || null;
      if (overrideDriverId) {
        return { driverId: overrideDriverId, resolvedSlot: timeSlot || 'AM', hasAnyAssignedSlot: true };
      }
    }

    // Fallback: read directly from store fields (covers date mismatches or map not yet loaded)
    const dateObj = new Date(deliveryDate + 'T00:00:00');
    const day = dateObj.getDay();
    const prefix = day === 0 ? 'sunday' : day === 6 ? 'saturday' : 'weekday';
    const amDriverId = store[`${prefix}_am_driver_id`] || null;
    const pmDriverId = store[`${prefix}_pm_driver_id`] || null;

    if (timeSlot === 'PM') {
      if (pmDriverId) return { driverId: pmDriverId, resolvedSlot: 'PM', hasAnyAssignedSlot: true };
      if (amDriverId) return { driverId: amDriverId, resolvedSlot: 'AM', hasAnyAssignedSlot: true };
      return { driverId: null, resolvedSlot: 'PM', hasAnyAssignedSlot: false };
    }

    if (amDriverId) return { driverId: amDriverId, resolvedSlot: 'AM', hasAnyAssignedSlot: true };
    if (pmDriverId) return { driverId: pmDriverId, resolvedSlot: 'PM', hasAnyAssignedSlot: true };
    return { driverId: null, resolvedSlot: timeSlot || 'AM', hasAnyAssignedSlot: false };
  };

  // NOTE: Driver auto-set from patient selection is handled in DeliveryForm's handlePatientSelect
  // (which uses scheduledDriverMap with schedule overrides). This view-level effect is intentionally
  // removed to prevent it from overwriting the scheduled driver with the store default.

  const stagedPanelProps = buildDeliveryStagedPanelProps({
    sortedStagedDeliveries,
    sortedProjectedDeliveries,
    stores,
    patients,
    currentUser,
    editingStagedId,
    isMobileDevice,
    handleStagedDeliveryClick,
    handleClearForm,
    stagedDeliveries,
    fullPredictionListRef,
    setProjectedDeliveries,
    setStagedDeliveries,
    setEditingStagedId,
    patientSearchInputRef,
    confirmAddProjectedToStaged,
    setDeleteConfirmation,
    isLoadingPredictions,
    handleRefreshProjections,
    shouldAutoFocusFields,
    selectedDate: formData.delivery_date
  });

  const hasTimeWindowChanges = Boolean(
    delivery && (
    (delivery.delivery_time_start || '') !== (formData.delivery_time_start || '') ||
    (delivery.delivery_time_end || '') !== (formData.delivery_time_end || '') ||
    (delivery.time_window_start || '') !== (formData.time_window_start || '') ||
    (delivery.time_window_end || '') !== (formData.time_window_end || ''))

  );

  const mobileHeaderHeight = typeof document !== 'undefined' ? document.querySelector('[data-mobile-header]')?.offsetHeight || 0 : 0;
  const mobileBottomNavHeight = typeof document !== 'undefined' ? document.querySelector('[data-mobile-bottom-nav]')?.offsetHeight || 0 : 0;
  const mobileFormInsetStyle = useMobileLayout && isMobileDevice ? {
    top: `${mobileHeaderHeight}px`,
    bottom: `${mobileBottomNavHeight}px`,
    background: 'var(--bg-white)'
  } : undefined;

  // Auto-focus COD amount when a staged or pending item is selected (desktop only)
  React.useEffect(() => {
    if (editingStagedId && shouldAutoFocusFields) {
      setTimeout(() => {
        try {codAmountInputRef?.current?.focus?.();} catch {}
      }, 120);
    }
  }, [editingStagedId, shouldAutoFocusFields, codAmountInputRef]);

  React.useEffect(() => {
    if (!useMobileLayout) return;

    const ensureActiveFieldVisible = (target) => {
      const field = target instanceof HTMLElement ? target : null;
      if (!field) return;
      if (!field.matches('input, textarea, [contenteditable="true"]')) return;

      if (activeFieldScrollFrameRef.current) {
        cancelAnimationFrame(activeFieldScrollFrameRef.current);
      }

      activeFieldScrollFrameRef.current = requestAnimationFrame(() => {
        try {
          field.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        } catch {}
      });
    };

    const handleFocusIn = (event) => ensureActiveFieldVisible(event.target);
    const handleInput = (event) => ensureActiveFieldVisible(event.target);

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('input', handleInput, true);

    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('input', handleInput, true);
      if (activeFieldScrollFrameRef.current) {
        cancelAnimationFrame(activeFieldScrollFrameRef.current);
      }
    };
  }, [useMobileLayout]);

  const handleGlobalKeyDown = (e) => {
    if (e.key === 'Enter') {
      if (e.repeat || e.nativeEvent?.isComposing || e.defaultPrevented) return;
      // Skip if focused on textarea, button, footer actions, select-like controls, or the patient search input (handled elsewhere)
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON' || e.target.type === 'submit') {
        return;
      }
      if (e.target === patientSearchInputRef?.current || e.target.closest?.('button, footer, [role="combobox"], [data-radix-select-trigger], [data-hotkey-add="false"]')) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (enterActionLockRef.current || isSaving || effectiveDeliveryActionBusy) return;
      enterActionLockRef.current = true;
      setTimeout(() => {enterActionLockRef.current = false;}, 400);

      if (effectiveButtonState === 'done') {
        const isDisabled = isSaving || effectiveDeliveryActionBusy || !isInterStoreMode && !hasChanges;
        if (!isDisabled) {
          if (isInterStoreMode && interStoreReady) {
            runLockedAction('add_interstore_transfer', async () => {await handleAddInterStoreTransfer();});
          } else {
            runLockedAction('batch_save', handleBatchSave);
          }
        }
      } else if (effectiveButtonState === 'updateStaged') {
        const isDisabled = isSaving || effectiveDeliveryActionBusy || !isFormValid;
        if (!isDisabled) {
          runLockedAction('update_staged_delivery', handleUpdateStaged);
        }
      } else if (effectiveButtonState === 'add') {
        const isDisabled = isSaving || effectiveDeliveryActionBusy || !formData?.driver_id || !hasSelectedLocationAndDriver || !isFormValid && !hasSelectedLocationAndDriver || requiresDriverSelection && !hasSelectedLocationAndDriver;
        if (!isDisabled) {
          runLockedAction('add_staged_delivery', async () => {
            await handleAddToStaging();
            if (userHasRole(currentUser, 'admin')) {
              setFormData((prev) => ({ ...prev, driver_id: '', driver_name: '' }));
            }
          });
        }
      } else if (effectiveButtonState === 'update' || !effectiveButtonState) {
        const isDisabled = isSaving || effectiveDeliveryActionBusy || !isFormValid || isFormLockedByPayroll;
        if (!isDisabled) {
          // Snapshot all needed values before form closes
          const _driverId = formData?.driver_id;
          const _deliveryDate = formData?.delivery_date;
          const _previousDriverId = delivery?.driver_id;
          const _previousDeliveryDate = delivery?.delivery_date;
          const _shouldOptimizeInBackground = (delivery?.delivery_time_start || '') !== (formData?.delivery_time_start || '') || (delivery?.delivery_time_end || '') !== (formData?.delivery_time_end || '');
          const _travelModeOnly = !!delivery &&
          !_shouldOptimizeInBackground &&
          (formData?.transport_mode || formData?.finished_leg_transport_mode || '') !== (delivery?.transport_mode || delivery?.finished_leg_transport_mode || '') &&
          (formData?.driver_id || '') === (delivery?.driver_id || '') &&
          (formData?.delivery_date || '') === (delivery?.delivery_date || '');
          const _formDataSnapshot = { ...formData };
          const _deliverySnapshot = delivery ? { ...delivery } : null;
          const _allDeliveriesSnapshot = [...(allDeliveries || [])];
          const _submitEvent = { preventDefault: () => {}, stopPropagation: () => {} };

          // CLOSE IMMEDIATELY — same as button onClick
          handleCancelClick();
          window.dispatchEvent(new CustomEvent('collapseSelectedStopCard'));

          // Fire-and-forget: all saves happen after form is gone
          (async () => {
            try {
              const { smartRefreshManager } = await import('../utils/smartRefreshManager');
              smartRefreshManager.pause();
              try {
                await handleSubmit(_submitEvent);
              } finally {
                smartRefreshManager.resume();
              }

              // Sync Square catalog item if COD amount is set and payment type is Cash/Check
              if (_formDataSnapshot.patient_id && delivery?.id) {
                const codPayments = _formDataSnapshot.cod_payments || [];
                const codAmount = (_formDataSnapshot.cod_total_amount_required || 0) / 100;
                const hasCashCheck = codPayments.some((p) => p.type === 'Cash' || p.type === 'Check');
                const hasDebitCredit = codPayments.some((p) => p.type === 'Debit' || p.type === 'Credit');
                if (hasCashCheck && codAmount > 0) {
                  const { base44: b44 } = await import('@/api/base44Client');
                  const storeRes = _formDataSnapshot.store_id
                    ? await b44.entities.Store.filter({ id: _formDataSnapshot.store_id }).catch(() => [])
                    : [];
                  b44.functions.invoke('squareCreateCodItem', {
                    deliveryId: delivery.id,
                    patientName: _formDataSnapshot.patient_name || '',
                    storeAbbreviation: storeRes?.[0]?.abbreviation || '',
                    codAmount,
                    deliveryDate: _formDataSnapshot.delivery_date,
                    storeId: _formDataSnapshot.store_id || '',
                  }).catch(() => null);
                } else if (hasDebitCredit) {
                  const { base44: b44 } = await import('@/api/base44Client');
                  b44.functions.invoke('squareDeleteCodItem', { deliveryId: delivery.id }).catch(() => null);
                }
              }

              const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
              const routeDriverId = _formDataSnapshot.driver_id || _deliverySnapshot?.driver_id;
              const routeDate = _formDataSnapshot.delivery_date || _deliverySnapshot?.delivery_date;
              const routeDeliveries = _allDeliveriesSnapshot.filter(
                (d) => d && d.driver_id === routeDriverId && d.delivery_date === routeDate && !d.is_cycling_marker
              );
              if (routeDeliveries.length > 1) {
                const parseActualTime = (d) => {const t = new Date(d.actual_delivery_time || '');return Number.isNaN(t.getTime()) ? Infinity : t.getTime();};
                const parseEta = (d) => {if (!d.delivery_time_eta) return Infinity;const [h, m] = d.delivery_time_eta.split(':').map(Number);return Number.isNaN(h) ? Infinity : h * 60 + (m || 0);};
                const finished = routeDeliveries.filter((d) => FINISHED_STATUSES.includes(d.status)).sort((a, b) => parseActualTime(a) - parseActualTime(b));
                const incomplete = routeDeliveries.filter((d) => !FINISHED_STATUSES.includes(d.status)).sort((a, b) => {const diff = parseEta(a) - parseEta(b);return diff !== 0 ? diff : Number(a.stop_order || 0) - Number(b.stop_order || 0);});
                const reorderUpdates = [];
                [...finished, ...incomplete].forEach((d, idx) => {const newOrder = idx + 1;if (Number(d.stop_order || 0) !== newOrder) reorderUpdates.push({ ...d, stop_order: newOrder });});
                if (reorderUpdates.length > 0) {
                  import('../utils/offlineDatabase').then(({ offlineDB }) => offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, reorderUpdates).catch(() => null)).catch(() => null);
                  reorderUpdates.forEach(({ id, stop_order: so }) => import('@/api/base44Client').then(({ base44 }) => base44.entities.Delivery.update(id, { stop_order: so }).catch(() => null)).catch(() => null));
                  applyDeliveryChangesLocally?.({ upserts: reorderUpdates, deleteIds: [] });
                }
              }

              if (_travelModeOnly) {
                runPostDeliveryUpdateSync({ driverId: _driverId, deliveryDate: _deliveryDate, hasTimeWindowChanges: _shouldOptimizeInBackground, travelModeOnly: _travelModeOnly, currentUser });
                return;
              }

              const affectedRoutes = [[_driverId, _deliveryDate], [_previousDriverId, _previousDeliveryDate]].filter(([rid, rd]) => rid && rd);
              await Promise.all(
                Array.from(new Set(affectedRoutes.map(([rid, rd]) => `${rid}__${rd}`))).map((key) => {
                  const [rid, rd] = key.split('__');
                  return recalculateAndUpdateStopOrders(rid, rd);
                })
              );
              runPostDeliveryUpdateSync({ driverId: _driverId, deliveryDate: _deliveryDate, hasTimeWindowChanges: _shouldOptimizeInBackground, travelModeOnly: _travelModeOnly, currentUser });
            } catch (_) {}
          })();
        }
      }
    }
  };

  return (
    <div
      className={`fixed inset-0 z-[10020] overflow-hidden ${useMobileLayout && isMobileDevice ? '' : 'bg-black/60 flex items-center justify-center p-4'}`}
      style={mobileFormInsetStyle}>
      
      <motion.div
        ref={formRef}
        initial={{ opacity: 0, scale: useMobileLayout && isMobileDevice ? 1 : 0.95 }}
        animate={{ opacity: 1, y: 0 }}
        className={`w-full ${useMobileLayout && isMobileDevice ? 'h-full max-h-full overflow-hidden' : isInterStoreMode ? 'max-w-[620px] h-auto max-h-[95vh]' : shouldUseCompactPickupEditHeight ? 'max-w-[468px] h-auto max-h-[95vh]' : isCyclingMarkerMode && !delivery ? 'max-w-[480px] h-auto max-h-[95vh]' : isPickupMode ? 'max-w-[520px] h-auto max-h-[90vh]' : !delivery ? 'max-w-[65.625rem] h-[95vh] max-h-[95vh]' : 'max-w-[50rem] h-auto max-h-[95vh]'} flex`}
        style={useMobileLayout && isMobileDevice ? { height: '100%', maxHeight: '100%' } : undefined}>
        <Card
          onKeyDown={handleGlobalKeyDown}
          className={`border-0 flex flex-col w-full ${useMobileLayout && isMobileDevice ? 'h-full' : 'rounded-xl shadow-xl overflow-hidden'}`}
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
          
          {/* Header */}
          <CardHeader className="px-4 py-1 flex flex-col space-y-1.5 border-b flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)' }}>
            <div className="flex items-center justify-between gap-3">
              <div className={`flex ${useMobileLayout && isMobileDevice ? 'items-center gap-2 min-w-0' : 'items-center gap-3'}`}>
                <Package className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                <div className={`flex items-center gap-2 ${useMobileLayout && isMobileDevice ? 'min-w-0' : ''}`}>
                  <CardTitle className="text-xl font-bold truncate" style={{ color: 'var(--text-slate-900)' }}>
                   {delivery ? delivery.is_cycling_marker ? 'Edit Cycling Marker' : isInterStoreMode ? 'Edit InterStore' : isPickupMode ? 'Edit Pickup' : 'Edit Delivery' : isCyclingMarkerMode ? 'Add Cycling Marker' : 'Add To Route'}
                  </CardTitle>
                  {(() => {
                    let patientToCheck = selectedPatient;
                    if (!patientToCheck && formData.patient_id && patients) {
                      patientToCheck = patients.find((p) => p && p.id === formData.patient_id);
                    }
                    if (!patientToCheck?.last_delivery_date) return null;
                    try {
                      const date = new Date(patientToCheck.last_delivery_date + 'T00:00:00');
                      if (isNaN(date.getTime())) return null;
                      return <Badge variant="outline" className="text-xs font-normal ml-2">LD: {format(date, 'MMM d, yyyy')}</Badge>;
                    } catch {return null;}
                  })()}
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={handleCancelClick} disabled={isSaving}><X className="w-4 h-4" /></Button>
            </div>
            {!delivery &&
            <div className={`flex gap-2 ${useMobileLayout && isMobileDevice ? 'w-full flex-nowrap' : 'ml-7 flex-wrap'}`}>
                <Button type="button" size="sm" className={`${useMobileLayout && isMobileDevice ? 'flex-1 px-2 text-[11px]' : ''} ${!isPickupMode && !isInterStoreMode && !isCyclingMarkerMode ? "bg-emerald-600 hover:bg-emerald-700 !text-white" : ""}`} onClick={() => {setIsPickupMode(false);setIsInterStoreMode?.(false);setIsCyclingMarkerMode?.(false);}} style={isPickupMode || isInterStoreMode || isCyclingMarkerMode ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>
                  Add Delivery
                </Button>
                <Button type="button" size="sm" className={`${useMobileLayout && isMobileDevice ? 'flex-1 px-2 text-[11px]' : ''} ${isInterStoreMode ? "bg-emerald-600 hover:bg-emerald-700 !text-white" : ""}`} onClick={() => {setIsPickupMode(false);setIsInterStoreMode?.(true);setIsCyclingMarkerMode?.(false);}} style={!isInterStoreMode ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>
                  InterStores
                </Button>
                <Button type="button" size="sm" className={`${useMobileLayout && isMobileDevice ? 'flex-1 px-2 text-[11px]' : ''} ${isPickupMode && !isInterStoreMode ? "bg-emerald-600 hover:bg-emerald-700 !text-white" : ""}`} onClick={() => {setIsPickupMode(true);setIsInterStoreMode?.(false);setIsCyclingMarkerMode?.(false);}} style={!isPickupMode || isInterStoreMode ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>
                  Add Pickup
                </Button>
                {userHasRole(currentUser, 'driver') &&
              <Button type="button" size="sm" className={`${useMobileLayout && isMobileDevice ? 'flex-1 px-2 text-[11px]' : ''} ${isCyclingMarkerMode ? "bg-emerald-600 hover:bg-emerald-700 !text-white" : ""}`} onClick={() => {
                setIsPickupMode(false);
                setIsInterStoreMode?.(false);
                setIsCyclingMarkerMode?.(true);
                setFormData((prev) => {
                  // Generate a collision-free BIK id for this new cycling marker
                  const existingBikIds = (allDeliveries || [])
                    .filter((d) => d?.delivery_id?.startsWith('BIK-'))
                    .map((d) => d.delivery_id);
                  const bikId = prev.delivery_id?.startsWith('BIK-')
                    ? prev.delivery_id
                    : generateBikDeliveryId(existingBikIds);
                  // AM before 14:00, PM from 14:00 onwards
                  const ampmNow = new Date().getHours() < 14 ? 'AM' : 'PM';
                  // created_by_app_user_id = the AppUser record id for the current user
                  const driverAppUser = (appUsers || []).find((au) => au?.user_id === currentUser?.id);
                  const createdByAppUserId = driverAppUser?.id || null;
                  return {
                    ...prev,
                    driver_id: prev.driver_id || currentUser?.id || '',
                    driver_name: prev.driver_name || currentUser?.user_name || '',
                    delivery_notes: prev.delivery_notes || 'Cycling Route Start',
                    is_cycling_marker: true,
                    status: 'in_transit',
                    delivery_id: bikId,
                    ampm_deliveries: prev.ampm_deliveries || ampmNow,
                    created_by_app_user_id: prev.created_by_app_user_id || createdByAppUserId,
                  };
                });
                // Auto-populate GPS coords
                if (navigator.geolocation) {
                  navigator.geolocation.getCurrentPosition(
                    (pos) => {
                      setFormData((prev) => ({
                        ...prev,
                        cycling_latitude: parseFloat(pos.coords.latitude.toFixed(7)),
                        cycling_longitude: parseFloat(pos.coords.longitude.toFixed(7))
                      }));
                    },
                    () => {} // silently ignore if denied
                  );
                }
              }} style={!isCyclingMarkerMode ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>
                  Cycling Marker
                </Button>
              }
              </div>
            }
          </CardHeader>

          {error && <div className="p-3 text-sm text-center" style={{ background: '#fee2e2', color: '#991b1b' }}>Error: {error}</div>}
          {isPayrollLocked && payrollLockMessage &&
          <div className="p-3 text-sm text-center border-b flex items-center justify-center gap-2" style={{ background: '#fef3c7', color: '#78350f', borderColor: '#fcd34d' }}>
              <AlertCircle className="w-4 h-4" /><span>{payrollLockMessage}</span>
            </div>
          }

          <CardContent className={`p-3 relative ${useMobileLayout ? `flex-1 overflow-y-auto overflow-x-hidden min-h-0 flex flex-col` : shouldUseCompactPickupEditHeight ? 'overflow-visible' : isInterStoreMode ? 'overflow-y-auto overflow-x-hidden' : isCyclingMarkerMode && !delivery ? 'overflow-y-auto overflow-x-hidden' : isPickupMode && !delivery ? 'overflow-y-auto overflow-x-hidden' : delivery ? 'overflow-y-auto overflow-x-hidden' : 'flex-1 overflow-hidden'}`}>

            {/* ── InterStore tab body ───────────────────────────────────── */}
            {isInterStoreMode &&
            <div className="flex flex-col gap-3">
                {/* Date + Driver row (same as pickup mode) */}
                <div className="flex gap-3">
                  <div className="flex-1 space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Transfer Date *</Label>
                    <Input type="date" value={formData.delivery_date} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_date: e.target.value }))} disabled={isSaving} className="h-9" />
                  </div>
                  <div className={`flex-1 space-y-1 p-3 rounded-lg border transition-all ${interStoreReady && !formData.driver_id ? 'border-amber-400 ring-2 ring-amber-300' : ''}`} style={interStoreReady && !formData.driver_id ? { background: '#fffbeb', borderColor: '#fbbf24' } : { background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <Label className="text-sm font-semibold" style={{ color: interStoreReady && !formData.driver_id ? '#92400e' : 'var(--text-slate-900)' }}>Driver {interStoreReady && !formData.driver_id ? '⚠ Required' : ''}</Label>
                    <Select open={forceOpenInterStoreDriverSelect} onOpenChange={setForceOpenInterStoreDriverSelect} value={formData.driver_id || 'all'} onValueChange={(driverId) => {
                    const newDriverId = driverId === 'all' ? '' : driverId;
                    const driver = driverId === 'all' ? null : allDrivers.find((d) => d.id === driverId);
                    setFormData((prev) => ({ ...prev, driver_id: newDriverId, driver_name: driver ? getDriverNameForStorage(driver) : '' }));
                    setForceOpenInterStoreDriverSelect(false);
                  }} disabled={isSaving}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Select driver" /></SelectTrigger>
                      <SelectContent className="z-[999999]">
                        <SelectItem value="all">No Driver</SelectItem>
                        {allDrivers.map((d) => <SelectItem key={d.id} value={d.id}>{getDriverDisplayName(d)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {delivery && renderDeliveryIdentifiersSection({
                delivery,
                isAppOwner,
                currentUser,
                formData,
                setFormData,
                isSaving,
                isPickupMode: false,
                pidInputValue,
                setPidInputValue,
                pidLookupStatus,
                setPidLookupStatus,
                patients,
                updatePatientLocal,
                originalPidRef
              })}
                <InterStoreFormContent formData={formData} setFormData={setFormData} isSaving={isSaving} currentUser={currentUser} stores={stores} onReady={setInterStoreReady} delivery={delivery} isAddToRouteMode={!delivery} />
              </div>
            }

            {/* ── Add Cycling Marker form body ──────────────────────────── */}
            {isCyclingMarkerMode && !delivery &&
            <div className="flex flex-col gap-3">
                {/* Date + Driver row */}
                <div className="flex gap-3">
                  <div className="flex-1 space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Date *</Label>
                    <Input type="date" value={formData.delivery_date} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_date: e.target.value }))} disabled={isSaving} className="h-9" />
                  </div>
                  <div className="flex-1 space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Driver</Label>
                    <Select value={formData.driver_id || currentUser?.id || 'none'} onValueChange={(driverId) => {
                    const driver = allDrivers.find((d) => d.id === driverId);
                    setFormData((prev) => ({ ...prev, driver_id: driverId, driver_name: driver ? getDriverNameForStorage(driver) : '' }));
                  }} disabled={isSaving}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Select driver" /></SelectTrigger>
                      <SelectContent className="z-[999999]">
                        {allDrivers.map((d) => <SelectItem key={d.id} value={d.id}>{getDriverDisplayName(d)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {/* Cycling Point selector */}
                <div className="p-3 rounded-lg border space-y-2" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Cycling Point</Label>
                  <div className="flex gap-2">
                    {['Cycling Route Start', 'Cycling Route End'].map((label) => {
                    const isSelected = formData.delivery_notes === label;
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setFormData((prev) => ({ ...prev, delivery_notes: label, is_cycling_marker: true }))}
                        disabled={isSaving}
                        className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-all ${isSelected ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
                          {label}
                        </button>);

                  })}
                  </div>
                </div>
                {/* Status / Arrival / Completion */}
                <div className="p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                  <DeliveryStatusAndTiming
                  formData={formData} setFormData={setFormData}
                  delivery={null} isPickupMode={false} isSaving={isSaving}
                  isCompletionStatus={isCompletionStatus}
                  completionTime={completionTime} setCompletionTime={setCompletionTime}
                  availableStores={availableStores} allDeliveries={allDeliveries}
                  currentUser={currentUser} setSelectedPickupOption={setSelectedPickupOption}
                  isCyclingMarker={true} />
                </div>
                {/* Lat / Lng */}
                <div className="flex gap-3">
                  <div className="flex-1 space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Latitude</Label>
                    <Input type="number" step="any" value={formData.cycling_latitude ?? ''} onChange={(e) => setFormData((prev) => ({ ...prev, cycling_latitude: e.target.value === '' ? null : parseFloat(parseFloat(e.target.value).toFixed(7)) }))} placeholder="e.g. 53.5461" disabled={isSaving} className="h-9" />
                  </div>
                  <div className="flex-1 space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Longitude</Label>
                    <Input type="number" step="any" value={formData.cycling_longitude ?? ''} onChange={(e) => setFormData((prev) => ({ ...prev, cycling_longitude: e.target.value === '' ? null : parseFloat(parseFloat(e.target.value).toFixed(7)) }))} placeholder="e.g. -113.4938" disabled={isSaving} className="h-9" />
                  </div>
                </div>
              </div>
            }

            {!isInterStoreMode && !isCyclingMarkerMode && <div className={`${!delivery && !useMobileLayout && !isPickupMode ? 'h-full min-h-0 grid-cols-[minmax(0,1fr)_300px]' : 'grid-cols-1'} ${useMobileLayout && !delivery && !isPickupMode ? 'flex flex-col flex-1 min-h-0 overflow-hidden' : 'grid'} gap-3`}>
              <div className={`flex flex-col gap-3 ${useMobileLayout || delivery ? 'overflow-visible' : 'min-h-0 overflow-hidden'} ${useMobileLayout && !delivery && !isPickupMode ? 'flex-1 min-h-0 overflow-hidden' : ''}`}>

              {/* Pickup mode: Row 1 = Pickup Location (multi-select dropdown), Row 2 = Date + Driver */}
              {isPickupMode && !delivery &&
                <div className="flex flex-col gap-3">
                  {/* Row 1: Pickup Location multi-select dropdown */}
                  <PickupLocationMultiSelect
                    availableStores={availableStores}
                    selectedPickupStoreIds={selectedPickupStoreIds}
                    setSelectedPickupStoreIds={setSelectedPickupStoreIds}
                    selectedPickupOption={selectedPickupOption}
                    setSelectedPickupOption={setSelectedPickupOption}
                    formData={formData}
                    setFormData={setFormData}
                    allDeliveries={allDeliveries}
                    allDrivers={allDrivers}
                    getDefaultDriverForStoreSlot={getDefaultDriverForStoreSlot}
                    getDriverNameForStorage={getDriverNameForStorage}
                    setForceOpenDriverSelect={setForceOpenDriverSelect}
                    isSaving={isSaving} />
                  
                  {/* Row 2: Date + Driver */}
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Date *</Label>
                      <Input type="date" value={formData.delivery_date} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_date: e.target.value }))} disabled={isSaving} className="h-9" />
                    </div>
                    <div className="flex-1 space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Driver</Label>
                      <Select open={forceOpenDriverSelect} onOpenChange={setForceOpenDriverSelect} value={formData.driver_id || 'all'} onValueChange={(driverId) => {
                        const newDriverId = driverId === 'all' ? '' : driverId;
                        const driver = driverId === 'all' ? null : allDrivers.find((d) => d.id === driverId);
                        const newDriverName = driver ? getDriverNameForStorage(driver) : '';
                        onDriverManuallyChanged?.();
                        setFormData((prev) => ({ ...prev, driver_id: newDriverId, driver_name: newDriverName }));
                        setForceOpenDriverSelect(false);
                      }} disabled={isSaving}>
                        <SelectTrigger className="h-9"><SelectValue placeholder="Select driver" /></SelectTrigger>
                        <SelectContent className="z-[999999]">
                          <SelectItem value="all">All Drivers</SelectItem>
                          {allDrivers.map((driver) => <SelectItem key={driver.id} value={driver.id}>{getDriverDisplayName(driver)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
                }

              {/* Delivery mode: Patient Search / Date / Driver row */}
              {!(isPickupMode && !delivery) &&
                <div className={`${useMobileLayout ? 'flex flex-col gap-3' : 'flex gap-3 w-full'} flex-shrink-0`}>
                {!delivery && !isPickupMode ?
                  <div className={`${useMobileLayout ? 'flex flex-col gap-3 w-full' : 'min-w-0 grid grid-cols-[minmax(0,1.8fr)_minmax(11rem,1fr)_minmax(11rem,1fr)] gap-3 items-start w-full'}`}>
                    {useMobileLayout ?
                    <>
                        <div className="relative min-w-0 w-full">
                          <DeliveryPatientSearch
                          patientSearch={patientSearch} setPatientSearch={setPatientSearch}
                          selectedPatient={selectedPatient} filteredPatients={filteredPatients}
                          highlightedPatientIndex={highlightedPatientIndex} setHighlightedPatientIndex={setHighlightedPatientIndex}
                          selectedPatientIds={selectedPatientIds} setSelectedPatientIds={setSelectedPatientIds}
                          isMultiSelectMode={isMultiSelectMode} isSaving={isSaving} isScanning={isScanning}
                          formData={formData} stores={stores} currentUser={currentUser}
                          patientSearchInputRef={patientSearchInputRef} addPatientButtonRef={addPatientButtonRef}
                          onPatientSelect={handlePatientSelect} onAddSelectedPatients={handleAddSelectedPatients}
                          onStartCamera={() => {setShowCameraOverlay(true);startCamera();}}
                          onDuplicatePatient={handleDuplicatePatient} onNewAddressPatient={handleNewAddressPatient}
                          onCreatePatient={onCreatePatient} setIsPatientFormOpen={setIsPatientFormOpen}
                          handleSearchKeyDown={handleSearchKeyDown}
                          scheduledDriverMap={scheduledDriverMap}
                          onTabKey={() => codAmountInputRef?.current?.focus()} />
                        </div>

                        <div className="grid grid-cols-2 gap-3 w-full">
                          <div className="min-w-0 space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Date *</Label>
                            <Input type="date" value={formData.delivery_date} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_date: e.target.value }))} disabled={isSaving} className="h-9" />
                          </div>

                          <div className={`min-w-0 space-y-1 p-3 rounded-lg border ${requiresDriverSelection ? 'border-red-400 ring-2 ring-red-300 bg-red-50' : ''}`} style={requiresDriverSelection ? { background: '#fef2f2', borderColor: '#f87171' } : { background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Driver {delivery ? '*' : ''}</Label>
                            <Select open={forceOpenDriverSelect} onOpenChange={setForceOpenDriverSelect} value={formData.driver_id || 'all'} onValueChange={(driverId) => {
                            const newDriverId = driverId === 'all' ? '' : driverId;
                            const driver = driverId === 'all' ? null : allDrivers.find((d) => d.id === driverId);
                            const newDriverName = driver ? getDriverNameForStorage(driver) : '';
                            onDriverManuallyChanged?.();
                            setFormData((prev) => ({ ...prev, driver_id: newDriverId, driver_name: newDriverName }));
                            if (editingStagedId) {
                              setStagedDeliveries((prev) => prev.map((s) => s._tempId === editingStagedId ? { ...s, driver_id: newDriverId, driver_name: newDriverName } : s));
                              setHasChanges(true);
                            }
                            setForceOpenDriverSelect(false);
                            if (newDriverId && shouldAutoFocusFields) setTimeout(() => codAmountInputRef?.current?.focus(), 80);
                          }} disabled={isSaving}>
                              <SelectTrigger data-delivery-driver-select-trigger className="h-9"><SelectValue placeholder="Select driver" /></SelectTrigger>
                              <SelectContent className="z-[999999]">
                                {!delivery && <SelectItem value="all">All Drivers</SelectItem>}
                                {allDrivers.map((driver) => <SelectItem key={driver.id} value={driver.id}>{getDriverDisplayName(driver)}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      </> :

                    <>
                        <div className="relative min-w-0 self-stretch">
                          <DeliveryPatientSearch
                          patientSearch={patientSearch} setPatientSearch={setPatientSearch}
                          selectedPatient={selectedPatient} filteredPatients={filteredPatients}
                          highlightedPatientIndex={highlightedPatientIndex} setHighlightedPatientIndex={setHighlightedPatientIndex}
                          selectedPatientIds={selectedPatientIds} setSelectedPatientIds={setSelectedPatientIds}
                          isMultiSelectMode={isMultiSelectMode} isSaving={isSaving} isScanning={isScanning}
                          formData={formData} stores={stores} currentUser={currentUser}
                          patientSearchInputRef={patientSearchInputRef} addPatientButtonRef={addPatientButtonRef}
                          onPatientSelect={handlePatientSelect} onAddSelectedPatients={handleAddSelectedPatients}
                          onStartCamera={() => {setShowCameraOverlay(true);startCamera();}}
                          onDuplicatePatient={handleDuplicatePatient} onNewAddressPatient={handleNewAddressPatient}
                          onCreatePatient={onCreatePatient} setIsPatientFormOpen={setIsPatientFormOpen}
                          handleSearchKeyDown={handleSearchKeyDown}
                          scheduledDriverMap={scheduledDriverMap}
                          onTabKey={() => codAmountInputRef?.current?.focus()} />
                        </div>

                        <div className="min-w-0 h-[102px] flex flex-col justify-end space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Date *</Label>
                          <Input type="date" value={formData.delivery_date} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_date: e.target.value }))} disabled={isSaving} className="h-9" />
                        </div>

                        <div className={`min-w-0 h-[102px] flex flex-col justify-end space-y-1 p-3 rounded-lg border ${requiresDriverSelection ? 'border-red-400 ring-2 ring-red-300 bg-red-50' : ''}`} style={requiresDriverSelection ? { background: '#fef2f2', borderColor: '#f87171' } : { background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Driver {delivery ? '*' : ''}</Label>
                          <Select open={forceOpenDriverSelect} onOpenChange={setForceOpenDriverSelect} value={formData.driver_id || 'all'} onValueChange={(driverId) => {
                          const newDriverId = driverId === 'all' ? '' : driverId;
                          const driver = driverId === 'all' ? null : allDrivers.find((d) => d.id === driverId);
                          const newDriverName = driver ? getDriverNameForStorage(driver) : '';
                          onDriverManuallyChanged?.();
                          setFormData((prev) => ({ ...prev, driver_id: newDriverId, driver_name: newDriverName }));
                          if (editingStagedId) {
                            setStagedDeliveries((prev) => prev.map((s) => s._tempId === editingStagedId ? { ...s, driver_id: newDriverId, driver_name: newDriverName } : s));
                            setHasChanges(true);
                          }
                          setForceOpenDriverSelect(false);
                          if (newDriverId && shouldAutoFocusFields) setTimeout(() => codAmountInputRef?.current?.focus(), 80);
                        }} disabled={isSaving}>
                            <SelectTrigger data-delivery-driver-select-trigger className="h-9"><SelectValue placeholder="Select driver" /></SelectTrigger>
                            <SelectContent className="z-[999999]">
                              {!delivery && <SelectItem value="all">All Drivers</SelectItem>}
                              {allDrivers.map((driver) => <SelectItem key={driver.id} value={driver.id}>{getDriverDisplayName(driver)}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                      </>
                    }
                  </div> :

                  <div className={`${useMobileLayout ? 'flex flex-col gap-3 w-full' : 'flex gap-3 flex-row w-full'}`}>
                    <div className={`${useMobileLayout ? userHasRole(currentUser, 'driver') && (delivery || editingStagedId || isPickupMode || isInterStoreMode) ? 'grid grid-cols-[1.1fr_0.9fr_auto] gap-2 w-full items-stretch' : 'grid grid-cols-2 gap-2 w-full' : 'flex gap-3 flex-row w-full'}`}>
                      <div className="px-1 py-1 rounded-lg min-w-0 flex-1 space-y-1 border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                        <Label className="peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-sm font-semibold leading-tight" style={{ color: 'var(--text-slate-900)' }}>Delivery Date *</Label>
                        <Input type="date" value={formData.delivery_date} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_date: e.target.value }))} disabled={isSaving} className="px-3 py-1 text-base rounded-md flex w-full border shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm h-9 [&::-webkit-calendar-picker-indicator]:mr-1 [&::-webkit-calendar-picker-indicator]:scale-100" />
                      </div>

                      <div className="px-1 py-1 rounded-lg min-w-0 flex-1 space-y-1 border" style={requiresDriverSelection ? { background: '#fef2f2', borderColor: '#f87171' } : { background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                        <Label className="peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-sm font-semibold leading-tight" style={{ color: 'var(--text-slate-900)' }}>Driver {delivery ? '*' : ''}</Label>
                        <Select open={forceOpenDriverSelect} onOpenChange={setForceOpenDriverSelect} value={formData.driver_id || 'all'} onValueChange={(driverId) => {
                          const newDriverId = driverId === 'all' ? '' : driverId;
                          const driver = driverId === 'all' ? null : allDrivers.find((d) => d.id === driverId);
                          const newDriverName = driver ? getDriverNameForStorage(driver) : '';
                          onDriverManuallyChanged?.();
                          setFormData((prev) => ({ ...prev, driver_id: newDriverId, driver_name: newDriverName }));
                          if (editingStagedId) {
                            setStagedDeliveries((prev) => prev.map((s) => s._tempId === editingStagedId ? { ...s, driver_id: newDriverId, driver_name: newDriverName } : s));
                            setHasChanges(true);
                          }
                          setForceOpenDriverSelect(false);
                        }} disabled={isSaving}>
                          <SelectTrigger data-delivery-driver-select-trigger className={`${useMobileLayout ? 'h-8 text-xs px-2' : 'h-9'}`}><SelectValue placeholder="Select driver" /></SelectTrigger>
                          <SelectContent className="z-[999999]">
                            {!delivery && <SelectItem value="all">All Drivers</SelectItem>}
                            {allDrivers.map((driver) => <SelectItem key={driver.id} value={driver.id}>{getDriverDisplayName(driver)}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>

                      {userHasRole(currentUser, 'driver') && (delivery || editingStagedId || isPickupMode || isInterStoreMode) &&
                      <div className="px-1 py-1 rounded-lg w-fit border flex flex-col items-start justify-start gap-1" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                          {!useMobileLayout &&
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Travel Mode</Label>
                        }
                          <TravelModeButtons
                          value={formData.transport_mode || formData.finished_leg_transport_mode || delivery?.transport_mode || delivery?.finished_leg_transport_mode || 'driving'}
                          onChange={async (mode) => {
                            setFormData((prev) => {
                              const updates = { transport_mode: mode, finished_leg_transport_mode: mode };
                              if (prev.is_cycling_marker || delivery?.is_cycling_marker) {
                                if (mode === 'driving') updates.delivery_notes = 'Cycling Route Start';else
                                if (mode === 'cycling') updates.delivery_notes = 'Cycling Route End';
                              }
                              return { ...prev, ...updates };
                            });
                          }}
                          currentUser={currentUser}
                          appUsers={appUsers}
                          useMobileLayout={useMobileLayout}
                          disabled={isSaving} />
                        </div>
                      }
                    </div>
                  </div>
                  }

              </div>
                }

              {!(isPickupMode && !isAppOwner(currentUser)) && !delivery?.is_cycling_marker && renderDeliveryIdentifiersSection({
                  delivery,
                  isAppOwner,
                  currentUser,
                  formData,
                  setFormData,
                  isSaving,
                  isPickupMode,
                  pidInputValue,
                  setPidInputValue,
                  pidLookupStatus,
                  setPidLookupStatus,
                  patients,
                  updatePatientLocal,
                  originalPidRef
                })}

              {/* Main scrollable body */}
              <div className={`flex gap-3 w-full items-stretch ${!delivery && !useMobileLayout && !isPickupMode ? 'flex-1 min-h-0 overflow-hidden' : useMobileLayout && !delivery && !isPickupMode ? 'flex-1 min-h-0 overflow-hidden' : ''}`} style={!delivery && !useMobileLayout && !isPickupMode ? { height: '100%' } : undefined}>
                <div className={`flex flex-col gap-3 min-w-0 flex-1 min-h-0 overflow-y-auto pr-1 ${isFormDisabled ? 'opacity-40 pointer-events-none' : ''}`}>

                  {!isPickupMode ?
                    <div className={`${useMobileLayout && !delivery ? 'space-y-3' : useMobileLayout ? 'space-y-2' : 'grid grid-cols-[minmax(0,1.7fr)_minmax(16rem,0.7fr)] gap-3 min-h-0 items-start'}`}>
                      <div className="min-w-0 space-y-3">

                        {/* Notes */}
                        <div className="px-3 py-2 rounded-lg space-y-3 border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                          <div className="space-y-1">
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Notes</Label>
                            <Textarea value={formData.delivery_instructions || selectedPatient?.notes || ''} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_instructions: e.target.value }))} placeholder="Patient delivery instructions..." className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm text-sm resize-none" disabled={isSaving} />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Driver Notes</Label>
                            <Textarea value={formData.delivery_notes || ''} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_notes: e.target.value }))} placeholder="Driver notes for this delivery..." className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm text-sm resize-none" disabled={isSaving} />
                          </div>
                        </div>

                        {/* Delivery Options & COD */}
                        <div className="px-3 py-2 rounded-lg space-y-2 border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                          <div className="grid grid-cols-[minmax(0,1fr)_minmax(9rem,0.9fr)] gap-3 items-start">
                            <div className="space-y-2 min-w-0">
                              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Options</Label>
                              <div className="space-y-3">
                                <CheckboxField id="fridge_item" label="Fridge Item" checked={formData.fridge_item} onChange={(c) => setFormData((p) => ({ ...p, fridge_item: c }))} disabled={isSaving} />
                                <CheckboxField id="oversized" label="Oversized" checked={formData.oversized} onChange={(c) => setFormData((p) => ({ ...p, oversized: c }))} disabled={isSaving} />
                                <CheckboxField id="signature_needed" label="Signature Needed" checked={formData.signature_needed} onChange={(c) => setFormData((p) => ({ ...p, signature_needed: c }))} disabled={isSaving} />
                                <CheckboxField id="no_charge" label="No Charge Delivery" checked={formData.no_charge} onChange={(c) => setFormData((p) => ({ ...p, no_charge: c }))} disabled={isSaving} />
                              </div>
                            </div>
                            <div className="space-y-2 min-w-0">
                              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>COD</Label>
                              <div className="space-y-3">
                                <div className="flex items-center space-x-2">
                                  <Checkbox id="cod_enabled" checked={formData.cod_total_amount_required > 0} onCheckedChange={(checked) => {setFormData((p) => ({ ...p, cod_total_amount_required: 0 }));if (checked && shouldAutoFocusFields) setTimeout(() => codAmountInputRef.current?.focus(), 100);}} disabled={isSaving} />
                                  <Label htmlFor="cod_enabled" className="text-sm font-medium">COD Required</Label>
                                </div>
                                {formData.cod_total_amount_required >= 0 &&
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                                    <Input ref={codAmountInputRef} type="text" value={formData.cod_total_amount_required > 0 ? (formData.cod_total_amount_required / 100).toFixed(2) : ''} onChange={(e) => {const digits = e.target.value.replace(/[^\d]/g, '');if (digits.length > 5) {setFormData((p) => ({ ...p, cod_total_amount_required: 0, _barcode_entry_input: digits, _barcode_focus_token: (p._barcode_focus_token || 0) + 1 }));return;}const cents = parseInt(digits) || 0;setFormData((p) => ({ ...p, cod_total_amount_required: cents }));}} onKeyDown={(e) => {if (e.key === 'Tab') {e.preventDefault();barcodeInputRef.current?.focus();}}} placeholder="0.00" data-hotkey-add="true" className="w-full pl-6 h-9 text-sm" disabled={isSaving} />
                                  </div>
                                }
                              </div>
                            </div>
                          </div>
                        </div>

                        {!useMobileLayout &&
                        <>
                            <div className="pr-3 pb-2 pl-3 rounded-lg space-y-2 border"

                          style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                          
                              <DeliveryStatusAndTiming
                              formData={formData} setFormData={setFormData}
                              delivery={delivery} isPickupMode={isPickupMode} isSaving={isSaving}
                              isCompletionStatus={isCompletionStatus}
                              completionTime={completionTime} setCompletionTime={setCompletionTime}
                              availableStores={availableStores} allDeliveries={allDeliveries}
                              currentUser={currentUser} setSelectedPickupOption={setSelectedPickupOption}
                              isCyclingMarker={!!delivery?.is_cycling_marker} />
                          
                            </div>

                            <div className="px-3 py-2 rounded-lg space-y-2 border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                              <div className="space-y-1">
                                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Name *</Label>
                                <Input ref={patientNameInputRef} value={formData.patient_name || ''} onChange={(e) => setFormData((p) => ({ ...p, patient_name: e.target.value }))} placeholder="Patient name" data-hotkey-add="true" disabled={isSaving} className="h-9 text-sm" />
                              </div>
                              <div className="flex gap-3">
                                <div className="flex-1 space-y-1">
                                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Phone</Label>
                                  <PhoneInput value={formData.patient_phone || ''} onChange={(v) => setFormData((p) => ({ ...p, patient_phone: v }))} data-hotkey-add="true" disabled={isSaving} className="h-9 text-sm" />
                                </div>
                                <div className="flex-1 space-y-1">
                                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Alternate Phone</Label>
                                  <PhoneInput value={formData.patient_phone_secondary || ''} onChange={(v) => setFormData((p) => ({ ...p, patient_phone_secondary: v }))} data-hotkey-add="true" disabled={isSaving} className="h-9 text-sm" />
                                </div>
                              </div>
                              <div className="flex gap-3">
                                <div className="flex-[65] space-y-1">
                                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Address</Label>
                                  <Input value={selectedPatient?.address || ''} disabled placeholder="Address from patient record" className="bg-white h-9 text-sm" />
                                </div>

                                <div className="flex-[35] space-y-1">
                                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Unit #</Label>
                                  <Input value={formData.unit_number || ''} onChange={(e) => setFormData((p) => ({ ...p, unit_number: e.target.value }))} placeholder="Unit #" data-hotkey-add="true" disabled={isSaving} className="h-9 text-sm" />
                                </div>
                              </div>
                            </div>
                          </>
                        }
                      </div>

                      {!useMobileLayout &&
                      <div className="min-w-0 min-h-0 overflow-y-auto pr-1 space-y-3">
                          <div className="px-3 py-2 rounded-lg space-y-2 border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                            <SmartBarcodeScanner
                            receiptBarcodeValues={formData.receipt_barcode_values || []}
                            rxBarcodeValues={formData.barcode_values || []}
                            onReceiptChange={(vals) => setFormData((prev) => ({ ...prev, receipt_barcode_values: vals }))}
                            onRxChange={(vals) => setFormData((prev) => ({ ...prev, barcode_values: vals }))}
                            onSelectBarcode={(val) => setFormData((prev) => ({ ...prev, _preview_barcode: val }))}
                            manualInputOverride={formData._barcode_entry_input || ''}
                            focusTrigger={formData._barcode_focus_token || 0}
                            onManualInputOverrideApplied={() => setFormData((prev) => prev._barcode_entry_input ? { ...prev, _barcode_entry_input: '' } : prev)}
                            disabled={isSaving || !isMobileDevice && !delivery && !selectedPatient && !editingStagedId && !(formData?.patient_id || formData?.patient_name)}
                            barcodeInputRef={barcodeInputRef} />
                        

                          </div>

                          <div className="px-3 py-3 rounded-lg border min-h-[225px] flex flex-col" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                            {/* desktop SmartBarcodeScanner barcodeInputRef is wired via shared ref */}
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Preferences</Label>
                            <div className="flex-1 flex flex-col justify-around">
                              <CheckboxField id="mailbox_ok" label="MailBox OK" checked={formData.mailbox_ok} onChange={(c) => setFormData((p) => ({ ...p, mailbox_ok: c }))} disabled={isSaving} />
                              <CheckboxField id="ring_bell" label="Ring Bell" checked={formData.ring_bell} onChange={(c) => setFormData((p) => ({ ...p, ring_bell: c }))} disabled={isSaving} />
                              <CheckboxField id="call_upon_arrival" label="Call Upon Arrival" checked={formData.call_upon_arrival} onChange={(c) => setFormData((p) => ({ ...p, call_upon_arrival: c }))} disabled={isSaving} />
                              <CheckboxField id="dont_ring_bell" label="Don't Ring Bell" checked={formData.dont_ring_bell} onChange={(c) => setFormData((p) => ({ ...p, dont_ring_bell: c }))} disabled={isSaving} />
                              <CheckboxField id="back_door" label="Back Door" checked={formData.back_door} onChange={(c) => setFormData((p) => ({ ...p, back_door: c }))} disabled={isSaving} />
                            </div>
                          </div>

                          <div className="px-3 py-2 rounded-lg space-y-2 border min-h-[240px]" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Recurring</Label>
                            <DeliveryRecurringOptions
                            formData={formData} setFormData={setFormData} isSaving={isSaving}
                            currentFrequency={currentFrequency} weeklyLabel={weeklyLabel}
                            biWeeklyLabel={biWeeklyLabel} weeklyX4Label={weeklyX4Label}
                            showDayPopup={showDayPopup} setShowDayPopup={setShowDayPopup}
                            setActiveRecurringType={setActiveRecurringType}
                            handleRecurringChange={handleRecurringChange}
                            handleFrequencyChange={handleFrequencyChange}
                            handleWeeklyDaysDone={handleWeeklyDaysDone} />
                        
                          </div>
                        </div>
                      }
                    </div> :

                    <div className="px-3 py-2 rounded-lg space-y-2 border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      {delivery?.is_cycling_marker ?
                      <div className="space-y-3">
                          <div className="space-y-1">
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Cycling Point</Label>
                            <div className="flex gap-2">
                              {['Cycling Route Start', 'Cycling Route End'].map((label) => {
                              const isSelected = formData.delivery_notes === label;
                              return (
                                <button
                                  key={label}
                                  type="button"
                                  onClick={() => {
                                    const newNotes = isSelected ? '' : label;
                                    const autoMode = newNotes === 'Cycling Route Start' ? 'driving' : newNotes === 'Cycling Route End' ? 'cycling' : undefined;
                                    setFormData((prev) => ({ ...prev, delivery_notes: newNotes, ...(autoMode ? { transport_mode: autoMode, finished_leg_transport_mode: autoMode } : {}) }));
                                  }}
                                  disabled={isSaving}
                                  className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-all ${isSelected ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'}`}>
                                    {label}
                                  </button>);

                            })}
                            </div>
                          </div>
                          <div className="flex gap-3">
                            <div className="flex-1 space-y-1">
                              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Latitude</Label>
                              <Input type="number" step="any" value={formData.cycling_latitude ?? ''} onChange={(e) => setFormData((prev) => ({ ...prev, cycling_latitude: e.target.value === '' ? null : parseFloat(e.target.value) }))} placeholder="e.g. 53.5461" disabled={isSaving} className="h-9" />
                            </div>
                            <div className="flex-1 space-y-1">
                              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Longitude</Label>
                              <Input type="number" step="any" value={formData.cycling_longitude ?? ''} onChange={(e) => setFormData((prev) => ({ ...prev, cycling_longitude: e.target.value === '' ? null : parseFloat(e.target.value) }))} placeholder="e.g. -113.4938" disabled={isSaving} className="h-9" />
                            </div>
                          </div>
                        </div> :

                      <div className="space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup Notes</Label>
                          <Textarea value={formData.delivery_notes || ''} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_notes: e.target.value }))} placeholder="Notes for this pickup..." className="flex min-h-[85px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm text-sm resize-none" disabled={isSaving} />
                        </div>
                      }
                    </div>
                    }

                  {!isPickupMode ?
                    useMobileLayout ?
                    <>
                        {/* Barcode Scanner */}
                        <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                          <SmartBarcodeScanner
                          receiptBarcodeValues={formData.receipt_barcode_values || []}
                          rxBarcodeValues={formData.barcode_values || []}
                          onReceiptChange={(vals) => setFormData((prev) => ({ ...prev, receipt_barcode_values: vals }))}
                          onRxChange={(vals) => setFormData((prev) => ({ ...prev, barcode_values: vals }))}
                          onSelectBarcode={(val) => setFormData((prev) => ({ ...prev, _preview_barcode: val }))}
                          manualInputOverride={formData._barcode_entry_input || ''}
                          focusTrigger={formData._barcode_focus_token || 0}
                          onManualInputOverrideApplied={() => setFormData((prev) => prev._barcode_entry_input ? { ...prev, _barcode_entry_input: '' } : prev)}
                          disabled={isSaving || !isMobileDevice && !delivery && !selectedPatient && !editingStagedId && !(formData?.patient_id || formData?.patient_name)}
                          barcodeInputRef={barcodeInputRef} />


                          </div>

                          <div className="space-y-2">
                          {/* Store / Status / Time */}
                          <div className={`space-y-2 p-3 rounded-lg border ${delivery && !userHasRole(currentUser, 'admin') && ['completed', 'failed', 'returned', 'cancelled'].includes(formData.status) ? 'opacity-50 pointer-events-none' : ''}`}
                        style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                            <DeliveryStatusAndTiming
                            formData={formData} setFormData={setFormData}
                            delivery={delivery} isPickupMode={isPickupMode} isSaving={isSaving}
                            isCompletionStatus={isCompletionStatus}
                            completionTime={completionTime} setCompletionTime={setCompletionTime}
                            availableStores={availableStores} allDeliveries={allDeliveries}
                            currentUser={currentUser} setSelectedPickupOption={setSelectedPickupOption}
                            isCyclingMarker={!!delivery?.is_cycling_marker} />
                        
                          </div>

                          {/* Patient Name / Phone / Address / Unit */}
                          <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                            <div className="space-y-1">
                              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Name *</Label>
                              <Input ref={patientNameInputRef} value={formData.patient_name || ''} onChange={(e) => setFormData((p) => ({ ...p, patient_name: e.target.value }))} placeholder="Patient name" disabled={isSaving} className="h-9 text-sm" />
                            </div>
                            <div className="flex gap-3">
                              <div className="flex-1 space-y-1">
                                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Phone</Label>
                                <PhoneInput value={formData.patient_phone || ''} onChange={(v) => setFormData((p) => ({ ...p, patient_phone: v }))} disabled={isSaving} className="h-9 text-sm" />
                              </div>
                              <div className="flex-1 space-y-1">
                                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Alternate Phone</Label>
                                <PhoneInput value={formData.patient_phone_secondary || ''} onChange={(v) => setFormData((p) => ({ ...p, patient_phone_secondary: v }))} disabled={isSaving} className="h-9 text-sm" />
                              </div>
                            </div>
                            <div className="flex gap-3">
                              <div className="flex-[65] space-y-1">
                                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Address</Label>
                                <Input value={selectedPatient?.address || ''} disabled placeholder="Address from patient record" className="bg-white h-9 text-sm" />
                              </div>

                              <div className="flex-[35] space-y-1">
                                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Unit #</Label>
                                <Input value={formData.unit_number || ''} onChange={(e) => setFormData((p) => ({ ...p, unit_number: e.target.value }))} placeholder="Unit #" disabled={isSaving} className="h-9 text-sm" />
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-3 items-start">
                            <div className="space-y-2 p-3 rounded-lg border h-full" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Preferences</Label>
                              <div className={`${useMobileLayout ? 'space-y-5' : 'space-y-3'}`}>
                                <CheckboxField id="mailbox_ok" label="MailBox OK" checked={formData.mailbox_ok} onChange={(c) => setFormData((p) => ({ ...p, mailbox_ok: c }))} disabled={isSaving} />
                                <CheckboxField id="ring_bell" label="Ring Bell" checked={formData.ring_bell} onChange={(c) => setFormData((p) => ({ ...p, ring_bell: c }))} disabled={isSaving} />
                                <CheckboxField id="call_upon_arrival" label="Call Upon Arrival" checked={formData.call_upon_arrival} onChange={(c) => setFormData((p) => ({ ...p, call_upon_arrival: c }))} disabled={isSaving} />
                                <CheckboxField id="dont_ring_bell" label="Don't Ring Bell" checked={formData.dont_ring_bell} onChange={(c) => setFormData((p) => ({ ...p, dont_ring_bell: c }))} disabled={isSaving} />
                                <CheckboxField id="back_door" label="Back Door" checked={formData.back_door} onChange={(c) => setFormData((p) => ({ ...p, back_door: c }))} disabled={isSaving} />
                              </div>
                            </div>

                            <div className="space-y-2 p-3 rounded-lg border h-full" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Recurring</Label>
                              <DeliveryRecurringOptions
                              formData={formData} setFormData={setFormData} isSaving={isSaving}
                              currentFrequency={currentFrequency} weeklyLabel={weeklyLabel}
                              biWeeklyLabel={biWeeklyLabel} weeklyX4Label={weeklyX4Label}
                              showDayPopup={showDayPopup} setShowDayPopup={setShowDayPopup}
                              setActiveRecurringType={setActiveRecurringType}
                              handleRecurringChange={handleRecurringChange}
                              handleFrequencyChange={handleFrequencyChange}
                              handleWeeklyDaysDone={handleWeeklyDaysDone} />
                          
                            </div>
                          </div>
                        </div>
                      </> :
                    null :
                    !(isPickupMode && !delivery) ?
                    <div className="px-1 py-1 rounded-lg space-y-1 border"
                    style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <DeliveryStatusAndTiming
                        formData={formData} setFormData={setFormData}
                        delivery={delivery} isPickupMode={isPickupMode} isSaving={isSaving}
                        isCompletionStatus={isCompletionStatus}
                        completionTime={completionTime} setCompletionTime={setCompletionTime}
                        availableStores={availableStores} allDeliveries={allDeliveries}
                        currentUser={currentUser} setSelectedPickupOption={setSelectedPickupOption}
                        isCyclingMarker={!!delivery?.is_cycling_marker} />
                    
                    </div> :
                    null}


                </div>

              </div>

              </div>

              {/* Desktop Staged Panel - hidden in pickup mode */}
              {!delivery && !useMobileLayout && !isPickupMode &&
              <div className="w-[300px] min-w-[300px] h-full min-h-0 self-stretch flex overflow-hidden">
                  <div className="h-full min-h-0 w-full overflow-y-auto">
                    <DeliveryStagedPanelDesktop {...stagedPanelProps} />
                  </div>
                </div>
              }
            </div>}
            {/* end non-interstore/non-cycling content */}

            {/* Mobile Staged Panel - hidden in pickup mode */}
            {!delivery && useMobileLayout && !isPickupMode && !isInterStoreMode && !isCyclingMarkerMode && <DeliveryStagedPanelMobile {...stagedPanelProps} show={showStagedPanel} onClose={() => setShowStagedPanel(false)} />}
          </CardContent>

          {/* Footer */}
          <CardFooter className="px-3 py-1 flex items-center border-t flex-shrink-0" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
            <div className="flex items-center justify-between w-full gap-4">
              <div className="flex items-center gap-4">
                {!delivery && useMobileLayout && !isPickupMode &&
                <Button type="button" variant="outline" size="sm" onClick={() => setShowStagedPanel(!showStagedPanel)} className="gap-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                    <Package className="w-4 h-4" />
                    Deliveries: (S: {stagedCount.new} P: {stagedCount.pending})
                  </Button>
                }
                {isPickupMode && !isInterStoreMode && !userHasRole(currentUser, 'dispatcher') && !delivery?.is_cycling_marker &&
                <div className="flex items-center">
                    <CheckboxField
                    id="after_hours_pickup_footer"
                    label="After Hours Pickup"
                    checked={formData.after_hours_pickup}
                    onChange={(c) => {
                      if (!userHasRole(currentUser, 'admin')) return;
                      setFormData((p) => ({ ...p, after_hours_pickup: c }));
                    }}
                    disabled={isSaving || !userHasRole(currentUser, 'admin')} />
                  
                  </div>
                }
              </div>
              <div className="flex gap-2 ml-auto">
                <Button type="button" variant="outline" size="sm" onClick={() => {
                  const shouldClear = cancelButtonState === 'clear' || !!editingStagedId;
                  if (delivery) {handleCancelClick();return;}
                  if (isInterStoreMode) {
                    const hasAnyInterStoreInput = !!(formData._interstore_source_id || formData._interstore_dest_id || formData.driver_id || formData._interstore_notes);
                    if (hasAnyInterStoreInput) {
                      setFormData((prev) => ({ ...prev, _interstore_source_id: '', _interstore_source_name: '', _interstore_source_number: '', _interstore_dest_id: '', _interstore_dest_name: '', _interstore_dest_number: '', _interstore_notes: '', _interstore_distance_km: null, driver_id: '', driver_name: '' }));
                      return;
                    }
                  }
                  if (shouldClear) {
                    setFormData((prev) => ({ ...prev, barcode_values: [], receipt_barcode_values: [], _preview_barcode: null }));
                    handleClearForm();
                  } else {
                    handleCancelClick();
                  }
                }} disabled={isSaving || effectiveDeliveryActionBusy} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} className="inline-flex min-h-11 min-w-20 items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-8 rounded-md px-3 text-xs">
                 {(() => {
                    if (delivery) return 'Cancel';
                    if (isInterStoreMode) {
                      const hasAnyInterStoreInput = !!(formData._interstore_source_id || formData._interstore_dest_id || formData.driver_id || formData._interstore_notes);
                      if (hasAnyInterStoreInput) return 'Clear';
                    }
                    return cancelButtonState === 'clear' || editingStagedId ? 'Clear' : 'Cancel';
                  })()}
                </Button>

                {isCyclingMarkerMode && !delivery ?
                <Button type="button" size="sm" onClick={async (e) => {
                  e.preventDefault();e.stopPropagation();
                  if (isSaving || effectiveDeliveryActionBusy) return;
                  if (!formData.delivery_date || !formData.driver_id || !formData.delivery_notes) return;
                  await runLockedAction('add_cycling_marker', async () => {
                    const { base44 } = await import('@/api/base44Client');
                    const driver = allDrivers.find((d) => d.id === formData.driver_id);
                    const isStart = (formData.delivery_notes || '').toLowerCase().includes('start');
                    const startActualTime = completionTime && formData.status === 'completed' ?
                    `${formData.delivery_date}T${completionTime}:00` :
                    null;

                    // Compute End marker time: start actual_delivery_time + 1 hour
                    const endActualTime = (() => {
                      if (!startActualTime) return null;
                      const d = new Date(startActualTime);
                      d.setHours(d.getHours() + 1);
                      return d.toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
                    })();

                    const basePayload = {
                      delivery_date: formData.delivery_date,
                      driver_id: formData.driver_id,
                      driver_name: driver ? getDriverNameForStorage(driver) : formData.driver_name,
                      is_cycling_marker: true,
                      status: formData.status || 'in_transit',
                      ...(formData.arrival_time && { arrival_time: `${formData.delivery_date}T${formData.arrival_time}:00` }),
                      ...(formData.delivery_time_start && { delivery_time_start: formData.delivery_time_start }),
                      ...(formData.delivery_time_end && { delivery_time_end: formData.delivery_time_end }),
                      ...(formData.cycling_latitude != null && { cycling_latitude: formData.cycling_latitude }),
                      ...(formData.cycling_longitude != null && { cycling_longitude: formData.cycling_longitude })
                    };

                    const createPromises = [
                    base44.entities.Delivery.create({
                      ...basePayload,
                      delivery_notes: formData.delivery_notes,
                      ...(startActualTime && { actual_delivery_time: startActualTime }),
                      transport_mode: 'driving'
                    })];


                    // Auto-create a paired End marker when adding a Start marker
                    if (isStart) {
                      createPromises.push(
                        base44.entities.Delivery.create({
                          ...basePayload,
                          delivery_notes: 'Cycling Route End',
                          ...(endActualTime && { actual_delivery_time: endActualTime }),
                          transport_mode: 'cycling'
                        })
                      );
                    }

                    const savedRecords = await Promise.all(createPromises);

                    // ── Offline DB save (parallel with UI update) ────────────
                    const { offlineDB } = await import('@/components/utils/offlineDatabase');
                    offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, savedRecords.filter(Boolean)).catch(() => null);

                    // ── Immediate local UI update ─────────────────────────────
                    applyDeliveryChangesLocally?.({ upserts: savedRecords.filter(Boolean), deleteIds: [] });

                    // Sort stops: finished by actual_delivery_time, incomplete by ETA
                    recalculateAndUpdateStopOrders(formData.driver_id, formData.delivery_date);

                    // Close the form first, then open the cycling mode dialog
                    handleCancelClick();

                    // Open ModeSelectionDialog for stop selection if a Start marker was added.
                    // Skip entirely for historical dates — there are no future stops to tag.
                    if (isStart) {
                      const _today = new Date().toISOString().split('T')[0];
                      const _isHistorical = formData.delivery_date && formData.delivery_date < _today;
                      if (!_isHistorical) {
                        setTimeout(() => {
                          window.dispatchEvent(new CustomEvent('openCyclingModeDialog', {
                            detail: { driverId: formData.driver_id, deliveryDate: formData.delivery_date }
                          }));
                        }, 150);
                      }
                    }
                  });
                }} className="inline-flex min-h-11 min-w-20 items-center justify-center whitespace-nowrap font-medium h-8 rounded-md px-3 text-xs !text-white bg-emerald-600 hover:bg-emerald-700 gap-2" disabled={isSaving || effectiveDeliveryActionBusy || !formData.delivery_date || !formData.driver_id || !formData.delivery_notes || !formData.status || formData.cycling_latitude == null || formData.cycling_longitude == null}>
                  {isSaving ? <><div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Saving...</> : <><Plus className="w-4 h-4" />Add Marker</>}
                </Button> :
                effectiveButtonState === 'done' ?
                <Button type="button" size="sm" onClick={(e) => {
                  e.preventDefault();e.stopPropagation();
                  if (isInterStoreMode && interStoreReady) {
                    runLockedAction('add_interstore_transfer', async () => {await handleAddInterStoreTransfer();});
                  } else {
                    onCancel?.();
                    runLockedAction('batch_save', async () => {await handleBatchSave();fabControlEvents.resetToPhaseOneAfterDone(500);});
                  }
                }} className="inline-flex items-center justify-center whitespace-nowrap font-medium h-8 rounded-md px-3 text-xs !text-white bg-emerald-600 hover:bg-emerald-700 gap-2" disabled={isSaving || effectiveDeliveryActionBusy || isInterStoreMode && interStoreReady || !isInterStoreMode && openMode !== 'add_to_route' && !hasChanges && pickupsAddedCount === 0}>
                    {isSaving ? <><div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Saving...</> : <><CheckCircle className="w-4 h-4" />Done</>}
                  </Button> :
                effectiveButtonState === 'updateStaged' ?
                <Button type="button" size="sm" onClick={() => runLockedAction('update_staged_delivery', handleUpdateStaged)} className="inline-flex items-center justify-center whitespace-nowrap font-medium h-8 rounded-md px-3 text-xs !text-white bg-blue-600 hover:bg-blue-700 gap-2" disabled={isSaving || effectiveDeliveryActionBusy || !isFormValid}>
                    <Edit2 className="w-4 h-4" />Update
                  </Button> :
                effectiveButtonState === 'add' ?
                <Button type="button" size="sm" onClick={() => {
                 if (isInterStoreMode) {
                   runLockedAction('add_interstore_transfer', async () => {
                     await handleAddInterStoreTransfer();
                     // Reset InterStore fields so the form is ready for the next entry
                     setFormData((prev) => ({
                       ...prev,
                       _interstore_source_id: '', _interstore_source_name: '', _interstore_source_number: '',
                       _interstore_dest_id: '', _interstore_dest_name: '', _interstore_dest_number: '',
                       _interstore_stop_type: 'pickup',
                       _interstore_notes: '',
                       _interstore_distance_km: null,
                       driver_id: '', driver_name: '',
                       status: 'in_transit',
                       delivery_time_start: '', delivery_time_end: '',
                       arrival_time: '', actual_delivery_time: '',
                       fridge_item: false, oversized: false, signature_needed: false, no_charge: false,
                     }));
                   });
                 } else {
                    runLockedAction('add_staged_delivery', async () => {
                      await handleAddPickupsMulti();
                      if (userHasRole(currentUser, 'admin') && !isPickupMode) {
                        setFormData((prev) => ({ ...prev, driver_id: '', driver_name: '' }));
                      }
                    });
                  }
                }} className="inline-flex min-h-11 min-w-20 items-center justify-center whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary-foreground shadow h-8 rounded-md px-3 text-xs bg-blue-600 hover:bg-blue-700 gap-2"                  disabled={isSaving || effectiveDeliveryActionBusy || (isInterStoreMode ? !interStoreReady || !formData.driver_id : !formData.driver_id || !isFormValid && selectedPickupStoreIds.size === 0 || requiresDriverSelection)} title={isInterStoreMode && (!interStoreReady || !formData.driver_id) ? !formData.driver_id ? 'Select a driver to continue' : 'Select both From and To stores to continue' : !formData.driver_id ? 'Select a driver before adding' : !isFormValid && selectedPickupStoreIds.size === 0 ? 'Complete the required pickup fields before adding' : requiresDriverSelection ? 'Select a driver to create a pickup for this store/date' : undefined}>
                    <Plus className="w-4 h-4" />{isInterStoreMode ? 'InterStore' : isPickupMode && selectedPickupStoreIds.size > 1 ? `Add (${selectedPickupStoreIds.size})` : 'Add'}
                  </Button> :

                <Button type="button" size="sm" onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (isSaving || effectiveDeliveryActionBusy) return;

                  // Snapshot all needed values before form closes
                  const _driverId = formData?.driver_id;
                  const _deliveryDate = formData?.delivery_date;
                  const _previousDriverId = delivery?.driver_id;
                  const _previousDeliveryDate = delivery?.delivery_date;
                  const _shouldOptimizeInBackground = (delivery?.delivery_time_start || '') !== (formData?.delivery_time_start || '') || (delivery?.delivery_time_end || '') !== (formData?.delivery_time_end || '');
                  const _travelModeOnly = !!delivery &&
                  !_shouldOptimizeInBackground &&
                  (formData?.transport_mode || formData?.finished_leg_transport_mode || '') !== (delivery?.transport_mode || delivery?.finished_leg_transport_mode || '') &&
                  (formData?.driver_id || '') === (delivery?.driver_id || '') &&
                  (formData?.delivery_date || '') === (delivery?.delivery_date || '');
                  const _formDataSnapshot = { ...formData };
                  const _deliverySnapshot = delivery ? { ...delivery } : null;
                  const _allDeliveriesSnapshot = [...(allDeliveries || [])];
                  const _submitEvent = { preventDefault: () => {}, stopPropagation: () => {} };

                  // CLOSE IMMEDIATELY — synchronous, nothing can block this
                  handleCancelClick();
                  window.dispatchEvent(new CustomEvent('collapseSelectedStopCard'));

                  // Capture isInterStoreMode before form closes
                  const _isInterStore = isInterStoreMode;

                  // Fire-and-forget: all saves happen after form is gone
                  (async () => {
                    try {
                      const { smartRefreshManager } = await import('../utils/smartRefreshManager');
                      smartRefreshManager.pause();
                      try {
                        await handleSubmit(_submitEvent);
                      } finally {
                        smartRefreshManager.resume();
                      }

                      // Sync Square catalog item if COD amount is set and payment type is Cash/Check
                      if (_formDataSnapshot.patient_id && delivery?.id) {
                        const codPayments = _formDataSnapshot.cod_payments || [];
                        const codAmount = (_formDataSnapshot.cod_total_amount_required || 0) / 100;
                        const hasCashCheck = codPayments.some((p) => p.type === 'Cash' || p.type === 'Check');
                        const hasDebitCredit = codPayments.some((p) => p.type === 'Debit' || p.type === 'Credit');
                        if (hasCashCheck && codAmount > 0) {
                          const { base44: b44 } = await import('@/api/base44Client');
                          const storeRes = _formDataSnapshot.store_id
                            ? await b44.entities.Store.filter({ id: _formDataSnapshot.store_id }).catch(() => [])
                            : [];
                          b44.functions.invoke('squareCreateCodItem', {
                            deliveryId: delivery.id,
                            patientName: _formDataSnapshot.patient_name || '',
                            storeAbbreviation: storeRes?.[0]?.abbreviation || '',
                            codAmount,
                            deliveryDate: _formDataSnapshot.delivery_date,
                            storeId: _formDataSnapshot.store_id || '',
                          }).catch(() => null);
                        } else if (hasDebitCredit) {
                          const { base44: b44 } = await import('@/api/base44Client');
                          b44.functions.invoke('squareDeleteCodItem', { deliveryId: delivery.id }).catch(() => null);
                        }
                      }

                      // Full route resort: finished by actual_delivery_time, incomplete by ETA, resequence stop_order
                      // For InterStore updates, always fetch fresh data from DB to include the just-saved timestamps
                      const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];
                      const routeDriverId = _formDataSnapshot.driver_id || _deliverySnapshot?.driver_id;
                      const routeDate = _formDataSnapshot.delivery_date || _deliverySnapshot?.delivery_date;

                      let resortDeliveries = _allDeliveriesSnapshot;
                      if (_isInterStore && routeDriverId && routeDate) {
                        try {
                          const { base44: b44 } = await import('@/api/base44Client');
                          const fresh = await b44.entities.Delivery.filter({ driver_id: routeDriverId, delivery_date: routeDate });
                          if (fresh && fresh.length > 0) resortDeliveries = fresh;
                        } catch (_) {}
                      }

                      const routeDeliveries = resortDeliveries.filter(
                        (d) => d && d.driver_id === routeDriverId && d.delivery_date === routeDate && !d.is_cycling_marker
                      );
                      if (routeDeliveries.length > 0) {
                        const parseActualTime = (d) => {
                          const t = new Date(d.actual_delivery_time || '');
                          return Number.isNaN(t.getTime()) ? Infinity : t.getTime();
                        };
                        const parseEta = (d) => {
                          if (!d.delivery_time_eta) return Infinity;
                          const [h, m] = d.delivery_time_eta.split(':').map(Number);
                          return Number.isNaN(h) ? Infinity : h * 60 + (m || 0);
                        };
                        const finished = routeDeliveries.filter((d) => FINISHED_STATUSES.includes(d.status)).sort((a, b) => parseActualTime(a) - parseActualTime(b));
                        const incomplete = routeDeliveries.filter((d) => !FINISHED_STATUSES.includes(d.status)).sort((a, b) => {
                          const diff = parseEta(a) - parseEta(b);
                          return diff !== 0 ? diff : Number(a.stop_order || 0) - Number(b.stop_order || 0);
                        });
                        const reorderUpdates = [];
                        [...finished, ...incomplete].forEach((d, idx) => {
                          const newOrder = idx + 1;
                          if (Number(d.stop_order || 0) !== newOrder) reorderUpdates.push({ ...d, stop_order: newOrder });
                        });
                        if (reorderUpdates.length > 0) {
                          import('../utils/offlineDatabase').then(({ offlineDB }) => offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, reorderUpdates).catch(() => null)).catch(() => null);
                          reorderUpdates.forEach(({ id, stop_order: so }) => import('@/api/base44Client').then(({ base44: b44 }) => b44.entities.Delivery.update(id, { stop_order: so }).catch(() => null)).catch(() => null));
                          applyDeliveryChangesLocally?.({ upserts: reorderUpdates, deleteIds: [] });
                        }
                      }

                      if (_travelModeOnly) {
                        runPostDeliveryUpdateSync({ driverId: _driverId, deliveryDate: _deliveryDate, hasTimeWindowChanges: _shouldOptimizeInBackground, travelModeOnly: _travelModeOnly, currentUser });
                        return;
                      }

                      const affectedRoutes = [[_driverId, _deliveryDate], [_previousDriverId, _previousDeliveryDate]].filter(([rid, rd]) => rid && rd);
                      await Promise.all(
                        Array.from(new Set(affectedRoutes.map(([rid, rd]) => `${rid}__${rd}`))).map((key) => {
                          const [rid, rd] = key.split('__');
                          return recalculateAndUpdateStopOrders(rid, rd);
                        })
                      );
                      runPostDeliveryUpdateSync({ driverId: _driverId, deliveryDate: _deliveryDate, hasTimeWindowChanges: _shouldOptimizeInBackground, travelModeOnly: _travelModeOnly, currentUser });
                    } catch (_) {}
                  })();
                }} className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2" disabled={isSaving || effectiveDeliveryActionBusy || !isFormValid || isFormLockedByPayroll}>
                    {isSaving ? <><div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Saving...</> : <><Save className="w-4 h-4" />{delivery?.is_cycling_marker ? 'Update Cycle' : isInterStoreMode ? 'Update InterStore' : isPickupMode ? 'Update Pickup' : 'Update Delivery'}</>}
                  </Button>
                }
              </div>
            </div>
          </CardFooter>
        </Card>
      </motion.div>

      {/* Patient Match Popup */}
      {showMatchPopup &&
      <PatientMatchPopup isOpen={showMatchPopup} onClose={() => {setShowMatchPopup(false);setScanMatches([]);setExtractedData(null);}} matches={scanMatches} onSelectPatient={handleSelectMatchedPatient} extractedData={extractedData} stores={stores} />
      }

      {/* Camera Overlay */}
      <DeliveryCameraOverlay
        show={showCameraOverlay} videoRef={videoRef} canvasRef={canvasRef}
        isScanning={isScanning} error={error} onCapture={handleCameraCapture}
        onClose={() => {stopCamera();setShowCameraOverlay(false);setIsScanning(false);}} />
      

      {/* Delete Confirmation Dialog */}
      <DeliveryDeleteConfirmDialog
        deleteConfirmation={deleteConfirmation} setDeleteConfirmation={setDeleteConfirmation}
        isDeletingPending={isDeletingPending} sortedStagedDeliveries={sortedStagedDeliveries}
        stores={stores} stagedDeliveries={stagedDeliveries} allDeliveries={allDeliveries}
        onConfirmDelete={handleConfirmDelete} />
      
    </div>);

}