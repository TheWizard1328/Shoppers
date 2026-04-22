/**
 * DeliveryFormView - The pure render/JSX layer for DeliveryForm.
 * All logic remains in DeliveryForm.jsx; this file just renders it.
 */
import React, { useEffect, useMemo, useRef } from "react";
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
import { acquireDeliveryActionLock, releaseDeliveryActionLock, getActiveDeliveryAction, subscribeDeliveryActionLock } from '../utils/deliveryActionLock';
import { renderDeliveryIdentifiersSection } from './deliveryFormHelpers';
import { buildDeliveryStagedPanelProps } from './deliveryStagedPanelPropsHelper';

const CheckboxField = ({ id, label, checked, onChange, disabled }) =>
<div className="flex items-center space-x-2">
    <Checkbox id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    <Label htmlFor={id} className={`text-sm font-medium leading-none ${disabled ? 'text-slate-400' : ''}`}>{label}</Label>
  </div>;

const TravelModeButtons = ({ value, onChange, disabled, currentUser, appUsers = [] }) => {
  const options = [
  { value: 'driving', label: 'Driving', icon: Car },
  { value: 'cycling', label: 'Cycling', icon: Bike }];


  return (
    <div className="flex flex-row gap-2 shrink-0">
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
            className={`h-9 w-9 rounded-full border transition-all flex items-center justify-center ${isActive ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white text-slate-700'}`}>
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
  handleCancelClick, handleBatchSave, handleUpdateStaged, handleAddToStaging,
  handleSubmit, handleClearForm: _handleClearForm,
  buttonState, cancelButtonState, isFormValid, hasChanges, isPatientFormOpen,
  closeOnSave, onCancel, openMode, forceOpenDriverOnLoad = false
}) {
  const activeFieldScrollFrameRef = useRef(null);
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
      await action();
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
  React.useEffect(() => {
    setForceOpenDriverSelect(requiresDriverSelection || forceOpenDriverOnLoad);
  }, [requiresDriverSelection, forceOpenDriverOnLoad]);

  React.useEffect(() => {
    const handleForceOpenDriverSelect = () => setForceOpenDriverSelect(true);
    window.addEventListener('forceOpenDeliveryDriverSelect', handleForceOpenDriverSelect);
    return () => window.removeEventListener('forceOpenDeliveryDriverSelect', handleForceOpenDriverSelect);
  }, []);

  // Helper: get default driver ID for a store based on date and time slot
  const getDefaultDriverForStoreSlot = (storeId, timeSlot, deliveryDate) => {
    const store = stores?.find((s) => s && s.id === storeId);
    if (!store || !deliveryDate) return { driverId: null, resolvedSlot: timeSlot || null, hasAnyAssignedSlot: false };
    const dateObj = new Date(deliveryDate + 'T00:00:00');
    const day = dateObj.getDay(); // 0=Sun, 6=Sat
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

  useEffect(() => {
    if (delivery || editingStagedId || isPickupMode || isInterStoreMode) return;

    const storeId = selectedPatient?.store_id || formData?.store_id;
    const deliveryDate = formData?.delivery_date;
    if (!storeId || !deliveryDate) return;

    const requestedSlot = determineDeliveryAMPM(selectedPatient) || 'AM';
    const { driverId: defaultDriverId } = getDefaultDriverForStoreSlot(storeId, requestedSlot, deliveryDate);
    const defaultDriver = defaultDriverId ? allDrivers.find((d) => d.id === defaultDriverId) : null;
    const nextDriverId = defaultDriver ? defaultDriverId : '';
    const nextDriverName = defaultDriver ? getDriverNameForStorage(defaultDriver) : '';

    if ((formData?.driver_id || '') === nextDriverId && (formData?.driver_name || '') === nextDriverName) return;

    setFormData((prev) => ({
      ...prev,
      store_id: storeId,
      driver_id: nextDriverId,
      driver_name: nextDriverName
    }));
  }, [
  delivery,
  editingStagedId,
  isPickupMode,
  isInterStoreMode,
  selectedPatient?.id,
  selectedPatient?.store_id,
  selectedPatient?.time_window_start,
  selectedPatient?.time_window_end,
  formData?.delivery_date,
  stores,
  allDrivers]
  );

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
    shouldAutoFocusFields
  });

  const hasTimeWindowChanges = Boolean(
    delivery && (
    (delivery.delivery_time_start || '') !== (formData.delivery_time_start || '') ||
    (delivery.delivery_time_end || '') !== (formData.delivery_time_end || '') ||
    (delivery.time_window_start || '') !== (formData.time_window_start || '') ||
    (delivery.time_window_end || '') !== (formData.time_window_end || ''))

  );

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

      if (buttonState === 'done') {
        const isDisabled = isSaving || effectiveDeliveryActionBusy || !hasChanges;
        if (!isDisabled) {
          runLockedAction('batch_save', handleBatchSave);
        }
      } else if (buttonState === 'updateStaged') {
        const isDisabled = isSaving || effectiveDeliveryActionBusy || !isFormValid;
        if (!isDisabled) {
          runLockedAction('update_staged_delivery', handleUpdateStaged);
        }
      } else if (buttonState === 'add') {
        const isDisabled = isSaving || effectiveDeliveryActionBusy || !hasSelectedLocationAndDriver || !isFormValid && !hasSelectedLocationAndDriver || requiresDriverSelection && !hasSelectedLocationAndDriver;
        if (!isDisabled) {
          runLockedAction('add_staged_delivery', async () => {
            await handleAddToStaging();
            if (userHasRole(currentUser, 'admin')) {
              setFormData((prev) => ({ ...prev, driver_id: '', driver_name: '' }));
            }
          });
        }
      } else if (buttonState === 'update' || !buttonState) {
        const isDisabled = isSaving || effectiveDeliveryActionBusy || !isFormValid || isFormLockedByPayroll;
        if (!isDisabled) {
          runLockedAction('update_delivery', async () => {
            const driverId = formData?.driver_id;
            const deliveryDate = formData?.delivery_date;
            const previousDriverId = delivery?.driver_id;
            const previousDeliveryDate = delivery?.delivery_date;
            const shouldOptimizeInBackground = hasTimeWindowChanges;

            await handleSubmit(e);

            const affectedRoutes = [
            [driverId, deliveryDate],
            [previousDriverId, previousDeliveryDate]].
            filter(([routeDriverId, routeDeliveryDate]) => routeDriverId && routeDeliveryDate);

            await Promise.all(
              Array.from(new Set(affectedRoutes.map(([routeDriverId, routeDeliveryDate]) => `${routeDriverId}__${routeDeliveryDate}`))).
              map((key) => {
                const [routeDriverId, routeDeliveryDate] = key.split('__');
                return recalculateAndUpdateStopOrders(routeDriverId, routeDeliveryDate);
              })
            );

            setFormData((prev) => ({ ...prev, barcode_values: [], receipt_barcode_values: [], _preview_barcode: null }));

            runPostDeliveryUpdateSync({
              driverId,
              deliveryDate,
              hasTimeWindowChanges: shouldOptimizeInBackground,
              currentUser
            });

            window.dispatchEvent(new CustomEvent('collapseSelectedStopCard'));
          });
        }
      }
    }
  };

  return (
    <div
      className={`fixed inset-0 z-[10020] overflow-hidden ${useMobileLayout && isMobileDevice ? '' : 'bg-black/60 flex items-center justify-center p-4'}`}
      style={useMobileLayout && isMobileDevice ? { background: 'var(--bg-white)' } : undefined}>
      
      <motion.div
        ref={formRef}
        initial={{ opacity: 0, scale: useMobileLayout && isMobileDevice ? 1 : 0.95 }}
        animate={{ opacity: 1, y: 0 }}
        className={`w-full ${useMobileLayout && isMobileDevice ? 'h-[calc(100%-4rem)]' : isPickupMode ? 'max-w-[780px] h-[715px] max-h-[715px]' : !delivery ? 'max-w-[87.5rem] h-[90vh] max-h-[90vh]' : 'max-w-[50rem] h-[90vh] max-h-[90vh]'} flex`}>
        <Card
          onKeyDown={handleGlobalKeyDown}
          className={`border-0 flex flex-col w-full ${useMobileLayout && isMobileDevice ? 'h-full' : 'rounded-xl shadow-xl'}`}
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
          
          {/* Header */}
          <CardHeader className="border-b p-4 flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)' }}>
            <div className="flex items-center justify-between gap-3">
              <div className={`flex ${useMobileLayout && isMobileDevice ? 'items-center gap-2 min-w-0' : 'items-center gap-3'}`}>
                <Package className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                <div className={`flex items-center gap-2 ${useMobileLayout && isMobileDevice ? 'min-w-0' : ''}`}>
                  <CardTitle className="text-xl font-bold truncate" style={{ color: 'var(--text-slate-900)' }}>
                    {delivery ? isPickupMode ? 'Edit Pickup' : 'Edit Delivery' : 'Add To Route'}
                  </CardTitle>
                  {(() => {
                    let patientToCheck = selectedPatient;
                    if (!patientToCheck && formData.patient_id && patients) {
                      patientToCheck = patients.find((p) => p && p.id === formData.patient_id);
                    }
                    if (!patientToCheck?.last_delivery_date || (useMobileLayout && isMobileDevice)) return null;
                    try {
                      const date = new Date(patientToCheck.last_delivery_date + 'T00:00:00');
                      if (isNaN(date.getTime())) return null;
                      return <Badge variant="outline" className="text-xs font-normal ml-2">LD: {format(date, 'MMM d, yyyy')}</Badge>;
                    } catch {return null;}
                  })()}
                </div>
                {!delivery &&
                <div className={`flex gap-2 ${useMobileLayout && isMobileDevice ? 'ml-4 flex-wrap' : 'ml-4'}`}>
                    <Button type="button" size="sm" onClick={() => {setIsPickupMode(false);setIsInterStoreMode?.(false);}} className={!isPickupMode && !isInterStoreMode ? "bg-emerald-600 hover:bg-emerald-700 !text-white" : ""} style={isPickupMode || isInterStoreMode ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>
                      Add Delivery
                    </Button>
                    <Button type="button" size="sm" onClick={() => {setIsPickupMode(false);setIsInterStoreMode?.(true);}} className={isInterStoreMode ? "bg-emerald-600 hover:bg-emerald-700 !text-white" : ""} style={!isInterStoreMode ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>
                      InterStores
                    </Button>
                    <Button type="button" size="sm" onClick={() => {setIsPickupMode(true);setIsInterStoreMode?.(false);}} className={isPickupMode && !isInterStoreMode ? "bg-emerald-600 hover:bg-emerald-700 !text-white" : ""} style={!isPickupMode || isInterStoreMode ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>
                      Add Pickup
                    </Button>
                  </div>
                }
              </div>
              <Button variant="ghost" size="icon" onClick={handleCancelClick} disabled={isSaving}><X className="w-4 h-4" /></Button>
            </div>
          </CardHeader>

          {error && <div className="p-3 text-sm text-center" style={{ background: '#fee2e2', color: '#991b1b' }}>Error: {error}</div>}
          {isPayrollLocked && payrollLockMessage &&
          <div className="p-3 text-sm text-center border-b flex items-center justify-center gap-2" style={{ background: '#fef3c7', color: '#78350f', borderColor: '#fcd34d' }}>
              <AlertCircle className="w-4 h-4" /><span>{payrollLockMessage}</span>
            </div>
          }

          <CardContent className="p-3 flex-1 relative overflow-hidden">
            <div className={`h-full min-h-0 ${!delivery && !useMobileLayout && !isPickupMode ? 'grid grid-cols-[minmax(0,1fr)_300px] gap-3' : 'flex flex-col gap-3'}`}>
              <div className="min-h-0 flex flex-col gap-3 overflow-hidden">

              {/* Pickup mode: Row 1 = Location + Date + Driver */}
              {isPickupMode && !delivery &&
                <div className={`flex ${useMobileLayout ? 'flex-col gap-3' : 'gap-3'}`}>
                <div className="flex-1 space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup Location *</Label>
                  <Select value={selectedPickupOption} onValueChange={(value) => {
                      setSelectedPickupOption(value);
                      const sel = availableStores.find((s) => s.id === value);
                      const storeId = sel?._originalStoreId || value;
                      const requestedSlot = sel?._timeSlot || 'AM';
                      const { driverId: defaultDriverId, resolvedSlot, hasAnyAssignedSlot } = getDefaultDriverForStoreSlot(storeId, requestedSlot, formData.delivery_date);
                      const effectiveSlot = resolvedSlot || requestedSlot;
                      const newPuid = getPickupStopIdForDelivery(storeId, formData.delivery_date, effectiveSlot, allDeliveries);
                      const defaultDriver = defaultDriverId ? allDrivers.find((d) => d.id === defaultDriverId) : null;
                      setFormData((prev) => ({
                        ...prev,
                        store_id: storeId,
                        ampm_deliveries: effectiveSlot,
                        puid: newPuid || '',
                        driver_id: defaultDriver ? defaultDriverId : '',
                        driver_name: defaultDriver ? getDriverNameForStorage(defaultDriver) : ''
                      }));
                      if (!hasAnyAssignedSlot) {
                        setTimeout(() => setForceOpenDriverSelect(true), 150);
                      } else {
                        setForceOpenDriverSelect(false);
                      }
                    }} disabled={isSaving}>
                    <SelectTrigger className="h-9"><SelectValue placeholder="Select store" /></SelectTrigger>
                    <SelectContent className="z-[999999]">
                      {availableStores.map((store) => {
                          const baseId = store._originalStoreId || store.id;
                          const ts = store._timeSlot || null;
                          const puid = getPickupStopIdForDelivery(baseId, formData.delivery_date, ts || 'AM', allDeliveries);
                          const baseName = store._originalStoreId ? store.name.replace(/ \[AM\]| \[PM\]/, '') : store.name;
                          return <SelectItem key={store.id} value={store.id}>{`${baseName}${store._timeSlot ? ` [${store._timeSlot}]` : ''}`}</SelectItem>;
                        })}
                    </SelectContent>
                  </Select>
                </div>
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
                          handleSearchKeyDown={handleSearchKeyDown} />
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
                            setFormData((prev) => ({ ...prev, driver_id: newDriverId, driver_name: newDriverName }));
                            if (editingStagedId) {
                              setStagedDeliveries((prev) => prev.map((s) => s._tempId === editingStagedId ? { ...s, driver_id: newDriverId, driver_name: newDriverName } : s));
                              setHasChanges(true);
                            }
                            setForceOpenDriverSelect(false);
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
                          handleSearchKeyDown={handleSearchKeyDown} />
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
                          setFormData((prev) => ({ ...prev, driver_id: newDriverId, driver_name: newDriverName }));
                          if (editingStagedId) {
                            setStagedDeliveries((prev) => prev.map((s) => s._tempId === editingStagedId ? { ...s, driver_id: newDriverId, driver_name: newDriverName } : s));
                            setHasChanges(true);
                          }
                          setForceOpenDriverSelect(false);
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
                    <div className={`${useMobileLayout ? userHasRole(currentUser, 'driver') && (delivery || editingStagedId || isPickupMode || isInterStoreMode) ? 'grid grid-cols-3 gap-3 w-full max-[430px]:grid-cols-1' : 'grid grid-cols-2 gap-3 w-full max-[430px]:grid-cols-1' : 'flex gap-3 flex-row w-full'}`}>
                      <div className={`${useMobileLayout ? 'min-w-0' : 'min-w-0 flex-1'} space-y-1 p-3 rounded-lg border`} style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Date *</Label>
                        <Input type="date" value={formData.delivery_date} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_date: e.target.value }))} disabled={isSaving} className="h-9" />
                      </div>

                      <div className={`${useMobileLayout ? 'min-w-0' : 'min-w-0 flex-1'} space-y-1 p-3 rounded-lg border ${requiresDriverSelection ? 'border-red-400 ring-2 ring-red-300 bg-red-50' : ''}`} style={requiresDriverSelection ? { background: '#fef2f2', borderColor: '#f87171' } : { background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Driver {delivery ? '*' : ''}</Label>
                        <Select open={forceOpenDriverSelect} onOpenChange={setForceOpenDriverSelect} value={formData.driver_id || 'all'} onValueChange={(driverId) => {
                          const newDriverId = driverId === 'all' ? '' : driverId;
                          const driver = driverId === 'all' ? null : allDrivers.find((d) => d.id === driverId);
                          const newDriverName = driver ? getDriverNameForStorage(driver) : '';
                          setFormData((prev) => ({ ...prev, driver_id: newDriverId, driver_name: newDriverName }));
                          if (editingStagedId) {
                            setStagedDeliveries((prev) => prev.map((s) => s._tempId === editingStagedId ? { ...s, driver_id: newDriverId, driver_name: newDriverName } : s));
                            setHasChanges(true);
                          }
                          setForceOpenDriverSelect(false);
                        }} disabled={isSaving}>
                          <SelectTrigger data-delivery-driver-select-trigger className="h-9"><SelectValue placeholder="Select driver" /></SelectTrigger>
                          <SelectContent className="z-[999999]">
                            {!delivery && <SelectItem value="all">All Drivers</SelectItem>}
                            {allDrivers.map((driver) => <SelectItem key={driver.id} value={driver.id}>{getDriverDisplayName(driver)}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>

                      {userHasRole(currentUser, 'driver') && (delivery || editingStagedId || isPickupMode || isInterStoreMode) &&
                      <div className={`${useMobileLayout ? 'min-w-0 p-3' : 'w-fit p-3'} rounded-lg border flex ${useMobileLayout ? 'flex-col items-stretch justify-end' : 'flex-col items-start justify-start'} gap-2`} style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Travel Mode</Label>
                          <TravelModeButtons
                          value={formData.finished_leg_transport_mode || delivery?.finished_leg_transport_mode || 'driving'}
                          onChange={async (mode) => {
                            setFormData((prev) => ({ ...prev, finished_leg_transport_mode: mode }));
                          }}
                          currentUser={currentUser}
                          appUsers={appUsers}
                          disabled={isSaving} />
                        </div>
                      }
                    </div>
                  </div>
                  }

              </div>
                }

              {renderDeliveryIdentifiersSection({
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
              <div className="flex gap-3 w-full flex-1 min-h-0 overflow-hidden items-stretch " style={!delivery && !useMobileLayout && !isPickupMode ? { height: '100%' } : undefined}>
                <div className={`flex flex-col gap-3 min-w-0 ${delivery || useMobileLayout ? 'flex-1' : 'flex-1 overflow-y-auto min-h-0'} ${isFormDisabled ? 'opacity-40 pointer-events-none' : ''}`}>

                  {!isPickupMode ?
                    <div className={`${useMobileLayout ? 'space-y-2' : 'grid grid-cols-[minmax(0,1.7fr)_minmax(16rem,0.7fr)] gap-3 min-h-0 items-start'}`}>
                      <div className="space-y-3 min-w-0">

                        {/* Notes */}
                        <div className="space-y-3 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
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
                        <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
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
                                    <Input ref={codAmountInputRef} type="text" value={formData.cod_total_amount_required > 0 ? (formData.cod_total_amount_required / 100).toFixed(2) : ''} onChange={(e) => {const digits = e.target.value.replace(/[^\d]/g, '');if (digits.length > 5) {setFormData((p) => ({ ...p, cod_total_amount_required: 0, _barcode_entry_input: digits, _barcode_focus_token: (p._barcode_focus_token || 0) + 1 }));return;}const cents = parseInt(digits) || 0;setFormData((p) => ({ ...p, cod_total_amount_required: cents }));}} placeholder="0.00" data-hotkey-add="true" className="w-full pl-6 h-9 text-sm" disabled={isSaving} />
                                  </div>
                                }
                              </div>
                            </div>
                          </div>
                        </div>

                        {!useMobileLayout &&
                        <>
                            <div className="pr-3 pb-3 pl-3 rounded-lg space-y-2 border"

                          style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                          
                              <DeliveryStatusAndTiming
                              formData={formData} setFormData={setFormData}
                              delivery={delivery} isPickupMode={isPickupMode} isSaving={isSaving}
                              isCompletionStatus={isCompletionStatus}
                              completionTime={completionTime} setCompletionTime={setCompletionTime}
                              availableStores={availableStores} allDeliveries={allDeliveries}
                              currentUser={currentUser} setSelectedPickupOption={setSelectedPickupOption} />
                          
                            </div>

                            <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                              <div className="flex gap-3">
                                <div className="flex-1 space-y-1">
                                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Name *</Label>
                                  <Input ref={patientNameInputRef} value={formData.patient_name || ''} onChange={(e) => setFormData((p) => ({ ...p, patient_name: e.target.value }))} placeholder="Patient name" data-hotkey-add="true" disabled={isSaving} className="h-9 text-sm" />
                                </div>
                                <div className="flex-1 space-y-1">
                                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Phone</Label>
                                  <PhoneInput value={formData.patient_phone || ''} onChange={(v) => setFormData((p) => ({ ...p, patient_phone: v }))} data-hotkey-add="true" disabled={isSaving} className="h-9 text-sm" />
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
                      <div className="space-y-2 min-w-0 min-h-0 overflow-y-auto pr-1">
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
                            disabled={isSaving || !isMobileDevice && !delivery && !selectedPatient && !editingStagedId && !(formData?.patient_id || formData?.patient_name)} />
                        

                          </div>

                          <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Preferences</Label>
                            <div className="space-y-3.5">
                              <CheckboxField id="mailbox_ok" label="MailBox OK" checked={formData.mailbox_ok} onChange={(c) => setFormData((p) => ({ ...p, mailbox_ok: c }))} disabled={isSaving} />
                              <CheckboxField id="ring_bell" label="Ring Bell" checked={formData.ring_bell} onChange={(c) => setFormData((p) => ({ ...p, ring_bell: c }))} disabled={isSaving} />
                              <CheckboxField id="call_upon_arrival" label="Call Upon Arrival" checked={formData.call_upon_arrival} onChange={(c) => setFormData((p) => ({ ...p, call_upon_arrival: c }))} disabled={isSaving} />
                              <CheckboxField id="dont_ring_bell" label="Don't Ring Bell" checked={formData.dont_ring_bell} onChange={(c) => setFormData((p) => ({ ...p, dont_ring_bell: c }))} disabled={isSaving} />
                              <CheckboxField id="back_door" label="Back Door" checked={formData.back_door} onChange={(c) => setFormData((p) => ({ ...p, back_door: c }))} disabled={isSaving} />
                            </div>
                          </div>

                          <div className="px-3 py-2 rounded-lg space-y-2 border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
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

                    <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <div className="space-y-1">
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup Notes</Label>
                        <Textarea value={formData.delivery_notes || ''} onChange={(e) => setFormData((prev) => ({ ...prev, delivery_notes: e.target.value }))} placeholder="Notes for this pickup..." className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm text-sm resize-none" disabled={isSaving} />
                      </div>
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
                          disabled={isSaving || !isMobileDevice && !delivery && !selectedPatient && !editingStagedId && !(formData?.patient_id || formData?.patient_name)} />
                      

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
                            currentUser={currentUser} setSelectedPickupOption={setSelectedPickupOption} />
                        
                          </div>

                          {/* Patient Name / Phone / Address / Unit */}
                          <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                            <div className="flex gap-3">
                              <div className="flex-1 space-y-1">
                                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Name *</Label>
                                <Input ref={patientNameInputRef} value={formData.patient_name || ''} onChange={(e) => setFormData((p) => ({ ...p, patient_name: e.target.value }))} placeholder="Patient name" disabled={isSaving} className="h-9 text-sm" />
                              </div>
                              <div className="flex-1 space-y-1">
                                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Phone</Label>
                                <PhoneInput value={formData.patient_phone || ''} onChange={(v) => setFormData((p) => ({ ...p, patient_phone: v }))} disabled={isSaving} className="h-9 text-sm" />
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

                          <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Preferences</Label>
                            <div className="space-y-3">
                              <CheckboxField id="mailbox_ok" label="MailBox OK" checked={formData.mailbox_ok} onChange={(c) => setFormData((p) => ({ ...p, mailbox_ok: c }))} disabled={isSaving} />
                              <CheckboxField id="ring_bell" label="Ring Bell" checked={formData.ring_bell} onChange={(c) => setFormData((p) => ({ ...p, ring_bell: c }))} disabled={isSaving} />
                              <CheckboxField id="call_upon_arrival" label="Call Upon Arrival" checked={formData.call_upon_arrival} onChange={(c) => setFormData((p) => ({ ...p, call_upon_arrival: c }))} disabled={isSaving} />
                              <CheckboxField id="dont_ring_bell" label="Don't Ring Bell" checked={formData.dont_ring_bell} onChange={(c) => setFormData((p) => ({ ...p, dont_ring_bell: c }))} disabled={isSaving} />
                              <CheckboxField id="back_door" label="Back Door" checked={formData.back_door} onChange={(c) => setFormData((p) => ({ ...p, back_door: c }))} disabled={isSaving} />
                            </div>
                          </div>

                          <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
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
                      </> :
                    null :
                    !(isPickupMode && !delivery) ?
                    <div className={`space-y-2 p-3 rounded-lg border ${delivery && !userHasRole(currentUser, 'admin') && ['completed', 'failed', 'returned', 'cancelled'].includes(formData.status) ? 'opacity-50 pointer-events-none' : ''}`}
                    style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <DeliveryStatusAndTiming
                        formData={formData} setFormData={setFormData}
                        delivery={delivery} isPickupMode={isPickupMode} isSaving={isSaving}
                        isCompletionStatus={isCompletionStatus}
                        completionTime={completionTime} setCompletionTime={setCompletionTime}
                        availableStores={availableStores} allDeliveries={allDeliveries}
                        currentUser={currentUser} setSelectedPickupOption={setSelectedPickupOption} />
                    
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
            </div>

            {/* Mobile Staged Panel - hidden in pickup mode */}
            {!delivery && useMobileLayout && !isPickupMode && <DeliveryStagedPanelMobile {...stagedPanelProps} show={showStagedPanel} onClose={() => setShowStagedPanel(false)} />}
          </CardContent>

          {/* Footer */}
          <CardFooter className="border-t p-3 flex-shrink-0" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
            <div className="flex items-center justify-between w-full gap-4">
              <div className="flex items-center gap-4">
                {!delivery && useMobileLayout && !isPickupMode &&
                <Button type="button" variant="outline" size="sm" onClick={() => setShowStagedPanel(!showStagedPanel)} className="gap-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                    <Package className="w-4 h-4" />
                    Deliveries: (S: {stagedCount.new} P: {stagedCount.pending})
                  </Button>
                }
                {isPickupMode && !userHasRole(currentUser, 'dispatcher') &&
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
                  if (shouldClear) {
                    setFormData((prev) => ({ ...prev, barcode_values: [], receipt_barcode_values: [], _preview_barcode: null }));
                    globalFilters.setSelectedDriverId('all');
                    handleClearForm();
                  } else {
                    handleCancelClick();
                  }
                }} disabled={isSaving || effectiveDeliveryActionBusy} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} className="inline-flex min-h-11 min-w-20 items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-8 rounded-md px-3 text-xs">
                  {delivery ? 'Cancel' : cancelButtonState === 'clear' || editingStagedId ? 'Clear' : 'Cancel'}
                </Button>

                {buttonState === 'done' ?
                <Button type="button" size="sm" onClick={(e) => {e.preventDefault();e.stopPropagation();runLockedAction('batch_save', handleBatchSave);}} className="inline-flex items-center justify-center whitespace-nowrap font-medium h-8 rounded-md px-3 text-xs !text-white bg-emerald-600 hover:bg-emerald-700 gap-2" disabled={isSaving || effectiveDeliveryActionBusy || openMode !== 'add_to_route' && !hasChanges}>
                    {isSaving ? <><div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Saving...</> : <><CheckCircle className="w-4 h-4" />Done</>}
                  </Button> :
                buttonState === 'updateStaged' ?
                <Button type="button" size="sm" onClick={() => runLockedAction('update_staged_delivery', handleUpdateStaged)} className="inline-flex items-center justify-center whitespace-nowrap font-medium h-8 rounded-md px-3 text-xs !text-white bg-blue-600 hover:bg-blue-700 gap-2" disabled={isSaving || effectiveDeliveryActionBusy || !isFormValid}>
                    <Edit2 className="w-4 h-4" />Update
                  </Button> :
                buttonState === 'add' ?
                <Button type="button" size="sm" onClick={() => {
                  runLockedAction('add_staged_delivery', async () => {
                    await handleAddToStaging();
                    if (userHasRole(currentUser, 'admin')) {
                      setFormData((prev) => ({ ...prev, driver_id: '', driver_name: '' }));
                    }
                  });
                }} className="inline-flex min-h-11 min-w-20 items-center justify-center whitespace-nowrap font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 text-primary-foreground shadow h-8 rounded-md px-3 text-xs bg-blue-600 hover:bg-blue-700 gap-2" disabled={isSaving || effectiveDeliveryActionBusy || !isFormValid || requiresDriverSelection} title={!isFormValid ? 'Complete the required pickup fields before adding' : requiresDriverSelection ? 'Select a driver to create a pickup for this store/date' : undefined}>
                    <Plus className="w-4 h-4" />{getAddButtonStatus({ formData }) === 'in_transit' ? 'Add' : 'Add'}
                  </Button> :

                <Button type="button" size="sm" onClick={async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (isSaving || effectiveDeliveryActionBusy) return;
                  const driverId = formData?.driver_id;
                  const deliveryDate = formData?.delivery_date;
                  const previousDriverId = delivery?.driver_id;
                  const previousDeliveryDate = delivery?.delivery_date;
                  const shouldOptimizeInBackground = hasTimeWindowChanges;
                  let didSave = false;
                  const submitEvent = { preventDefault: () => {}, stopPropagation: () => {} };

                  await runLockedAction('update_delivery', async () => {
                    const { smartRefreshManager } = await import('../utils/smartRefreshManager');
                    smartRefreshManager.pause();
                    try {
                      const result = await handleSubmit(submitEvent);
                      didSave = result === true;
                    } finally {
                      smartRefreshManager.resume();
                    }
                  });

                  if (!didSave) return;

                  import('../utils/deliveryFormActionHelpers').
                  then(({ closeDeliveryFormAfterSave }) => closeDeliveryFormAfterSave({ handleClearForm, onCancel })).
                  catch(() => handleCancelClick());
                  window.dispatchEvent(new CustomEvent('collapseSelectedStopCard'));

                  const affectedRoutes = [
                  [driverId, deliveryDate],
                  [previousDriverId, previousDeliveryDate]].
                  filter(([routeDriverId, routeDeliveryDate]) => routeDriverId && routeDeliveryDate);

                  Promise.all(
                    Array.from(new Set(affectedRoutes.map(([routeDriverId, routeDeliveryDate]) => `${routeDriverId}__${routeDeliveryDate}`))).
                    map((key) => {
                      const [routeDriverId, routeDeliveryDate] = key.split('__');
                      return recalculateAndUpdateStopOrders(routeDriverId, routeDeliveryDate);
                    })
                  ).then(() => {
                    runPostDeliveryUpdateSync({
                      driverId,
                      deliveryDate,
                      hasTimeWindowChanges: shouldOptimizeInBackground,
                      currentUser
                    });
                  });
                }} className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2" disabled={isSaving || effectiveDeliveryActionBusy || !isFormValid || isFormLockedByPayroll}>
                    {isSaving ? <><div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Saving...</> : <><Save className="w-4 h-4" />{isPickupMode ? 'Update Pickup' : 'Update Delivery'}</>}
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