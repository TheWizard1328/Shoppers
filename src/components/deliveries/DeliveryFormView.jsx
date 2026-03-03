/**
 * DeliveryFormView - The pure render/JSX layer for DeliveryForm.
 * All logic remains in DeliveryForm.jsx; this file just renders it.
 */
import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { X, Save, Package, Plus, CheckCircle, Edit2, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PhoneInput } from "@/components/ui/phone-input";
import { getPickupStopIdForDelivery, determineDeliveryAMPM, getStoreAssignedTimeSlot } from '../utils/ampmUtils';
import { isAppOwner } from '../utils/userRoles';
import BarcodeScanner from './BarcodeScanner';
import PatientMatchPopup from './PatientMatchPopup';
import DeliveryPatientSearch from './DeliveryPatientSearch';
import DeliveryRecurringOptions from './DeliveryRecurringOptions';
import DeliveryStatusAndTiming from './DeliveryStatusAndTiming';
import DeliveryCameraOverlay from './DeliveryCameraOverlay';
import { DeliveryStagedPanelDesktop, DeliveryStagedPanelMobile, DeliveryDeleteConfirmDialog } from './DeliveryStagedPanel';
import { recalculateAndUpdateStopOrders } from '../utils/stopOrderManager';
import { calculateRealTimeETA } from '@/functions/calculateRealTimeETA';

const CheckboxField = ({ id, label, checked, onChange, disabled }) => (
  <div className="flex items-center space-x-2">
    <Checkbox id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    <Label htmlFor={id} className={`text-sm font-medium leading-none ${disabled ? 'text-slate-400' : ''}`}>{label}</Label>
  </div>
);

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
  delivery, formData, setFormData, isPickupMode, setIsPickupMode,
  isSaving, error, isPayrollLocked, payrollLockMessage, isFormLockedByPayroll,
  isFormDisabled, isCompletionStatus,
  // Patient search
  patientSearch, setPatientSearch, selectedPatient, filteredPatients,
  highlightedPatientIndex, setHighlightedPatientIndex,
  selectedPatientIds, setSelectedPatientIds, isMultiSelectMode,
  patientSearchInputRef, addPatientButtonRef, patientNameInputRef,
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
  allDeliveries, selectedPickupOption, setSelectedPickupOption,
  getDriverDisplayName, getDriverNameForStorage,
  editingStagedId, setStagedDeliveries, setHasChanges,
  // Completion time
  completionTime, setCompletionTime,
  // Staged panel
  sortedStagedDeliveries, sortedProjectedDeliveries, stagedDeliveries,
  projectedDeliveries, setProjectedDeliveries, fullPredictionListRef,
  setEditingStagedId, handleStagedDeliveryClick, handleClearForm,
  confirmAddProjectedToStaged, isLoadingPredictions,
  setPredictionTrigger, showStagedPanel, setShowStagedPanel,
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
  closeOnSave, onCancel,
}) {
  const stagedCount = {
    new: sortedStagedDeliveries.filter(s => !s.id).length,
    pending: sortedStagedDeliveries.filter(s => s.id).length,
  };

  // Require driver selection when no regular pickup exists for the patient's store/date/slot
  const requiresDriverSelection = (() => {
    if (delivery || isPickupMode) return false; // only for new patient deliveries
    if (formData?.driver_id) return false; // driver already chosen
    const patientToCheck = selectedPatient || (formData?.patient_id && patients ? patients.find(p => p && p.id === formData.patient_id) : null);
    const storeId = patientToCheck?.store_id || formData?.store_id;
    if (!storeId || !formData?.delivery_date) return false; // don't block when incomplete
    const storeObj = stores?.find(s => s && s.id === storeId);
    const slot = (determineDeliveryAMPM(patientToCheck) || getStoreAssignedTimeSlot(storeObj, formData.delivery_date, allDeliveries) || 'AM');
    const existsInStaged = (stagedDeliveries || []).some(d => !d.patient_id && d.store_id === storeId && d.delivery_date === formData.delivery_date && (d.ampm_deliveries || 'AM') === slot);
    const existsInSaved = (allDeliveries || []).some(d => d && !d.patient_id && d.store_id === storeId && d.delivery_date === formData.delivery_date && (d.ampm_deliveries || 'AM') === slot && !['completed','cancelled','returned'].includes(d.status));
    return !(existsInStaged || existsInSaved);
  })();

  // Auto-open the driver dropdown when a driver must be selected
  const [forceOpenDriverSelect, setForceOpenDriverSelect] = React.useState(false);
  React.useEffect(() => {
    setForceOpenDriverSelect(requiresDriverSelection);
  }, [requiresDriverSelection]);

  const stagedPanelProps = {
    sortedStagedDeliveries, sortedProjectedDeliveries, stores, patients,
    currentUser, editingStagedId, isMobileDevice, handleStagedDeliveryClick,
    handleClearForm, stagedDeliveries, fullPredictionListRef,
    setProjectedDeliveries, setStagedDeliveries, setEditingStagedId,
    patientSearchInputRef, confirmAddProjectedToStaged, setDeleteConfirmation,
    isLoadingPredictions, onRefreshProjections: () => setPredictionTrigger(prev => prev + 1),
  };

  // Auto-focus COD amount when a staged or pending item is selected (desktop only)
  React.useEffect(() => {
    if (editingStagedId && !isMobileDevice) {
      setTimeout(() => {
        try { codAmountInputRef?.current?.focus?.(); } catch {}
      }, 120);
    }
  }, [editingStagedId, isMobileDevice, codAmountInputRef]);

  return (
    <div
      className={`fixed inset-0 z-[10020] overflow-hidden ${useMobileLayout && isMobileDevice ? '' : 'bg-black/60 flex items-center justify-center p-4'}`}
      style={useMobileLayout && isMobileDevice ? { background: 'var(--bg-white)' } : {}}
    >
      <motion.div
        ref={formRef}
        initial={{ opacity: 0, scale: useMobileLayout && isMobileDevice ? 1 : 0.95 }}
        animate={{ opacity: 1, y: 0 }}
        className={`w-full ${useMobileLayout && isMobileDevice ? 'h-[calc(100%-4rem)]' : !delivery ? 'max-w-4xl max-h-[90vh]' : 'max-w-lg max-h-[90vh]'} flex`}
      >
        <Card
          className={`border-0 flex flex-col w-full ${useMobileLayout && isMobileDevice ? 'h-full' : 'rounded-xl shadow-xl'}`}
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}
        >
          {/* Header */}
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
                      patientToCheck = patients.find(p => p && p.id === formData.patient_id);
                    }
                    if (!patientToCheck?.last_delivery_date) return null;
                    try {
                      const date = new Date(patientToCheck.last_delivery_date + 'T00:00:00');
                      if (isNaN(date.getTime())) return null;
                      return <Badge variant="outline" className="text-xs font-normal ml-2">LD: {format(date, 'MMM d, yyyy')}</Badge>;
                    } catch { return null; }
                  })()}
                </div>
                {!delivery && (
                  <div className="flex gap-2 ml-4">
                    <Button type="button" size="sm" onClick={() => setIsPickupMode(false)} className="disabled:opacity-50 bg-emerald-600 text-white px-3 text-xs !text-white font-medium rounded-md inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors h-8 hover:bg-emerald-700">
                      Add Delivery
                    </Button>
                    <Button type="button" size="sm" onClick={() => setIsPickupMode(true)} className={isPickupMode ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""} style={!isPickupMode ? { background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' } : {}}>
                      Add Pickup
                    </Button>
                  </div>
                )}
              </div>
              <Button variant="ghost" size="icon" onClick={handleCancelClick} disabled={isSaving}><X className="w-4 h-4" /></Button>
            </div>
          </CardHeader>

          {error && <div className="p-3 text-sm text-center" style={{ background: '#fee2e2', color: '#991b1b' }}>Error: {error}</div>}
          {isPayrollLocked && payrollLockMessage && (
            <div className="p-3 text-sm text-center border-b flex items-center justify-center gap-2" style={{ background: '#fef3c7', color: '#78350f', borderColor: '#fcd34d' }}>
              <AlertCircle className="w-4 h-4" /><span>{payrollLockMessage}</span>
            </div>
          )}

          <CardContent className={`p-4 flex-1 relative overflow-hidden ${isFormLockedByPayroll ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="space-y-3 h-full flex flex-col">

              {/* Row 1: Patient Search / Pickup Location / Date / Driver */}
              <div className={`flex gap-3 ${useMobileLayout ? 'flex-col' : ''} ${!delivery && !useMobileLayout ? 'flex-shrink-0' : ''}`}>
                {!delivery && !isPickupMode && (
                  <div className={`relative ${useMobileLayout ? 'w-full' : 'flex-[2]'}`}>
                    <DeliveryPatientSearch
                      patientSearch={patientSearch} setPatientSearch={setPatientSearch}
                      selectedPatient={selectedPatient} filteredPatients={filteredPatients}
                      highlightedPatientIndex={highlightedPatientIndex} setHighlightedPatientIndex={setHighlightedPatientIndex}
                      selectedPatientIds={selectedPatientIds} setSelectedPatientIds={setSelectedPatientIds}
                      isMultiSelectMode={isMultiSelectMode} isSaving={isSaving} isScanning={isScanning}
                      formData={formData} stores={stores} currentUser={currentUser}
                      patientSearchInputRef={patientSearchInputRef} addPatientButtonRef={addPatientButtonRef}
                      onPatientSelect={handlePatientSelect} onAddSelectedPatients={handleAddSelectedPatients}
                      onStartCamera={() => { setShowCameraOverlay(true); startCamera(); }}
                      onDuplicatePatient={handleDuplicatePatient} onNewAddressPatient={handleNewAddressPatient}
                      onCreatePatient={onCreatePatient} setIsPatientFormOpen={setIsPatientFormOpen}
                      handleSearchKeyDown={handleSearchKeyDown}
                    />
                  </div>
                )}

                <div className={`flex gap-3 ${useMobileLayout ? 'flex-row' : 'contents'}`}>
                  {isPickupMode && !delivery && (
                    <div className={`${useMobileLayout ? 'w-full' : 'flex-[2]'} space-y-1 p-3 rounded-lg border`} style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup Location *</Label>
                      <Select value={selectedPickupOption} onValueChange={(value) => {
                        setSelectedPickupOption(value);
                        const sel = availableStores.find(s => s.id === value);
                        const storeId = sel?._originalStoreId || value;
                        const timeSlot = sel?._timeSlot || null;
                        const newPuid = getPickupStopIdForDelivery(storeId, formData.delivery_date, timeSlot || 'AM', allDeliveries);
                        setFormData(prev => ({ ...prev, store_id: storeId, ampm_deliveries: timeSlot, puid: newPuid || '' }));
                      }} disabled={isSaving}>
                        <SelectTrigger className="h-9"><SelectValue placeholder="Select store" /></SelectTrigger>
                        <SelectContent className="z-[999999]">
                          {availableStores.map(store => {
                            const baseId = store._originalStoreId || store.id;
                            const ts = store._timeSlot || null;
                            const puid = getPickupStopIdForDelivery(baseId, formData.delivery_date, ts || 'AM', allDeliveries);
                            const baseName = store._originalStoreId ? store.name.replace(/ \[AM\]| \[PM\]/, '') : store.name;
                            return <SelectItem key={store.id} value={store.id}>{`${baseName}${store._timeSlot ? ` [${store._timeSlot}]` : ''}${isAppOwner(currentUser) && puid ? ` {${puid}}` : ''}`}</SelectItem>;
                          })}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className={`${useMobileLayout ? 'w-[calc(50%-0.375rem)]' : 'flex-1'} space-y-1 p-3 rounded-lg border`} style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Date *</Label>
                    <Input type="date" value={formData.delivery_date} onChange={e => setFormData(prev => ({ ...prev, delivery_date: e.target.value }))} disabled={isSaving} className="h-9" />
                  </div>

                  <div className={`${useMobileLayout ? 'flex-1' : 'flex-1'} space-y-1 p-3 rounded-lg border ${requiresDriverSelection ? 'border-red-400 ring-2 ring-red-300 bg-red-50' : ''}`} style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Driver {delivery ? '*' : ''}</Label>
                    <Select open={forceOpenDriverSelect} onOpenChange={setForceOpenDriverSelect} value={formData.driver_id || 'all'} onValueChange={(driverId) => {
                      const newDriverId = driverId === 'all' ? '' : driverId;
                      const driver = driverId === 'all' ? null : allDrivers.find(d => d.id === driverId);
                      const newDriverName = driver ? getDriverNameForStorage(driver) : '';
                      setFormData(prev => ({ ...prev, driver_id: newDriverId, driver_name: newDriverName }));
                      if (editingStagedId) {
                        setStagedDeliveries(prev => prev.map(s => s._tempId === editingStagedId ? { ...s, driver_id: newDriverId, driver_name: newDriverName } : s));
                        setHasChanges(true);
                      }
                      setForceOpenDriverSelect(false);
                    }} disabled={isSaving}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Select driver" /></SelectTrigger>
                      <SelectContent className="z-[999999]">
                        {!delivery && <SelectItem value="all">All Drivers</SelectItem>}
                        {allDrivers.map(driver => <SelectItem key={driver.id} value={driver.id}>{getDriverDisplayName(driver)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Delivery Identifiers (AppOwner only) */}
              {isAppOwner(currentUser) && delivery && (
                <div className="space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Identifiers</Label>
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-1">
                      <Label className="text-xs">TR#</Label>
                      <Input value={formData.tracking_number} onChange={e => setFormData(prev => ({ ...prev, tracking_number: e.target.value }))} className="h-9 text-sm" disabled={isSaving} />
                    </div>
                    <div className="flex-1 space-y-1">
                      <Label className="text-xs">SID</Label>
                      <Input value={formData.stop_id} onChange={e => setFormData(prev => ({ ...prev, stop_id: e.target.value }))} className="h-9 text-sm" disabled={isSaving} />
                    </div>
                    {!isPickupMode && formData.patient_id && (
                      <div className="flex-1 space-y-1">
                        <Label className="text-xs">PID</Label>
                        <div className="relative">
                          <Input
                            value={pidInputValue}
                            onChange={e => {
                              const val = e.target.value;
                              setPidInputValue(val);
                              setPidLookupStatus(null);
                              if (val.length === 5) {
                                const match = patients?.find(p => p && p.patient_id === val);
                                if (match) { setPidLookupStatus('found'); } else { setPidLookupStatus('not_found'); }
                              }
                            }}
                            onBlur={async e => {
                              const newPid = e.target.value;
                              const currentPatient = patients?.find(p => p && p.id === formData.patient_id);
                              if (newPid !== currentPatient?.patient_id && formData.patient_id && newPid.length > 0 && pidLookupStatus !== 'not_found') {
                                await updatePatientLocal(formData.patient_id, { patient_id: newPid });
                              }
                            }}
                            className="h-9 text-sm pr-6"
                            style={{ background: pidLookupStatus === 'found' ? '#ecfdf5' : pidLookupStatus === 'not_found' ? '#fef2f2' : undefined, borderColor: pidLookupStatus === 'found' ? '#34d399' : pidLookupStatus === 'not_found' ? '#f87171' : undefined, borderWidth: pidLookupStatus ? '2px' : undefined }}
                            disabled={isSaving}
                          />
                          {pidInputValue !== originalPidRef.current && (
                            <button type="button" onClick={() => { setPidInputValue(originalPidRef.current); setPidLookupStatus(null); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="flex-1 space-y-1">
                      <Label className="text-xs">PUID</Label>
                      <Input value={formData.puid || ''} onChange={e => setFormData(prev => ({ ...prev, puid: e.target.value }))} className="h-9 text-sm" disabled={isSaving} />
                    </div>
                    <div className="flex-1 space-y-1">
                      <Label className="text-xs">X-KM</Label>
                      <Input
                        type="text"
                        value={formData.paid_km_override !== null && formData.paid_km_override !== undefined ? String(formData.paid_km_override) : ''}
                        onChange={e => { const val = e.target.value; setFormData(prev => ({ ...prev, paid_km_override: val === '' ? null : val })); }}
                        onBlur={e => { const val = e.target.value; if (val !== '' && !isNaN(parseFloat(val))) setFormData(prev => ({ ...prev, paid_km_override: parseFloat(parseFloat(val).toFixed(2)) })); }}
                        className="h-9 text-sm" disabled={isSaving}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Main scrollable body */}
              <div className={`flex gap-3 w-full ${delivery || useMobileLayout ? 'overflow-y-auto flex-1' : 'flex-1 min-h-0 overflow-hidden'}`}>
                <div className={`flex flex-col gap-3 min-w-0 ${delivery || useMobileLayout ? 'flex-1' : 'flex-1 overflow-y-auto'} ${isFormDisabled ? 'opacity-40 pointer-events-none' : ''}`}>

                  {/* Notes */}
                  <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    {!isPickupMode ? (
                      <div className="flex gap-3">
                        <div className="flex-1 min-w-0 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Notes</Label>
                          <Textarea value={formData.delivery_instructions || selectedPatient?.notes || ''} onChange={e => setFormData(prev => ({ ...prev, delivery_instructions: e.target.value }))} placeholder="Patient delivery instructions..." className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm text-sm resize-none" disabled={isSaving} />
                        </div>
                        <div className="flex-1 min-w-0 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Driver Notes</Label>
                          <Textarea value={formData.delivery_notes} onChange={e => setFormData(prev => ({ ...prev, delivery_notes: e.target.value }))} placeholder="Driver notes for this delivery..." className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm text-sm resize-none" disabled={isSaving} />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup Notes</Label>
                        <Textarea value={formData.delivery_notes} onChange={e => setFormData(prev => ({ ...prev, delivery_notes: e.target.value }))} placeholder="Notes for this pickup..." className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm text-sm resize-none" disabled={isSaving} />
                      </div>
                    )}
                  </div>

                  {/* Barcode Scanner (AppOwner + editing) */}
                  {delivery && isAppOwner(currentUser) && (
                    <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <BarcodeScanner barcodeValues={formData.barcode_values || []} onChange={vals => setFormData(prev => ({ ...prev, barcode_values: vals }))} disabled={isSaving} />
                    </div>
                  )}

                  {/* Delivery Options & COD */}
                  {!isPickupMode && (
                    <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <div className="flex gap-3">
                        <div className="flex-1 space-y-2">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Options</Label>
                          <div className="space-y-3">
                            <CheckboxField id="fridge_item" label="Fridge Item" checked={formData.fridge_item} onChange={c => setFormData(p => ({ ...p, fridge_item: c }))} disabled={isSaving} />
                            <CheckboxField id="oversized" label="Oversized" checked={formData.oversized} onChange={c => setFormData(p => ({ ...p, oversized: c }))} disabled={isSaving} />
                            <CheckboxField id="signature_needed" label="Signature Needed" checked={formData.signature_needed} onChange={c => setFormData(p => ({ ...p, signature_needed: c }))} disabled={isSaving} />
                            <CheckboxField id="no_charge" label="No Charge Delivery" checked={formData.no_charge} onChange={c => setFormData(p => ({ ...p, no_charge: c }))} disabled={isSaving} />
                          </div>
                        </div>
                        <div className="flex-1 space-y-2">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>COD</Label>
                          <div className="space-y-3">
                            <div className="flex items-center space-x-2">
                              <Checkbox id="cod_enabled" checked={formData.cod_total_amount_required > 0} onCheckedChange={checked => { setFormData(p => ({ ...p, cod_total_amount_required: 0 })); if (checked) setTimeout(() => codAmountInputRef.current?.focus(), 100); }} disabled={isSaving} />
                              <Label htmlFor="cod_enabled" className="text-sm font-medium">COD Required</Label>
                            </div>
                            {formData.cod_total_amount_required >= 0 && (
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                                <Input ref={codAmountInputRef} type="text" value={formData.cod_total_amount_required > 0 ? (formData.cod_total_amount_required / 100).toFixed(2) : ''} onChange={e => { const cents = parseInt(e.target.value.replace(/[^\d]/g, '')) || 0; setFormData(p => ({ ...p, cod_total_amount_required: cents })); }} placeholder="0.00" className="w-full pl-6 h-9 text-sm" disabled={isSaving} />
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Store / Status / Time - using extracted component */}
                  <div className={`space-y-2 p-3 rounded-lg border ${delivery && !userHasRole(currentUser, 'admin') && ['completed', 'failed', 'returned', 'cancelled'].includes(formData.status) ? 'opacity-50 pointer-events-none' : ''}`} style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <DeliveryStatusAndTiming
                      formData={formData} setFormData={setFormData}
                      delivery={delivery} isPickupMode={isPickupMode} isSaving={isSaving}
                      isCompletionStatus={isCompletionStatus}
                      completionTime={completionTime} setCompletionTime={setCompletionTime}
                      availableStores={availableStores} allDeliveries={allDeliveries}
                      currentUser={currentUser} setSelectedPickupOption={setSelectedPickupOption}
                    />
                  </div>

                  {/* Patient Name / Phone / Address / Unit */}
                  {!isPickupMode && (
                    <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <div className="flex gap-3">
                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Name *</Label>
                          <Input ref={patientNameInputRef} value={formData.patient_name} onChange={e => setFormData(p => ({ ...p, patient_name: e.target.value }))} placeholder="Patient name" disabled={isSaving} className="h-9 text-sm" />
                        </div>
                        <div className="flex-1 space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Phone</Label>
                          <PhoneInput value={formData.patient_phone} onChange={v => setFormData(p => ({ ...p, patient_phone: v }))} disabled={isSaving} className="h-9 text-sm" />
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <div className="flex-[65] space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Address</Label>
                          <Input value={selectedPatient?.address || ''} disabled placeholder="Address from patient record" className="bg-white h-9 text-sm" />
                        </div>

                        <div className="flex-[35] space-y-1">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Unit #</Label>
                          <Input value={formData.unit_number} onChange={e => setFormData(p => ({ ...p, unit_number: e.target.value }))} placeholder="Unit #" disabled={isSaving} className="h-9 text-sm" />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Patient Preferences & Recurring */}
                  {!isPickupMode && (
                    <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <div className="flex gap-3">
                        <div className="flex-1 space-y-2">
                          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Preferences</Label>
                          <div className="space-y-3">
                            <CheckboxField id="mailbox_ok" label="MailBox OK" checked={formData.mailbox_ok} onChange={c => setFormData(p => ({ ...p, mailbox_ok: c }))} disabled={isSaving} />
                            <CheckboxField id="ring_bell" label="Ring Bell" checked={formData.ring_bell} onChange={c => setFormData(p => ({ ...p, ring_bell: c }))} disabled={isSaving} />
                            <CheckboxField id="call_upon_arrival" label="Call Upon Arrival" checked={formData.call_upon_arrival} onChange={c => setFormData(p => ({ ...p, call_upon_arrival: c }))} disabled={isSaving} />
                            <CheckboxField id="dont_ring_bell" label="Don't Ring Bell" checked={formData.dont_ring_bell} onChange={c => setFormData(p => ({ ...p, dont_ring_bell: c }))} disabled={isSaving} />
                            <CheckboxField id="back_door" label="Back Door" checked={formData.back_door} onChange={c => setFormData(p => ({ ...p, back_door: c }))} disabled={isSaving} />
                          </div>
                        </div>
                        <DeliveryRecurringOptions
                          formData={formData} setFormData={setFormData} isSaving={isSaving}
                          currentFrequency={currentFrequency} weeklyLabel={weeklyLabel}
                          biWeeklyLabel={biWeeklyLabel} weeklyX4Label={weeklyX4Label}
                          showDayPopup={showDayPopup} setShowDayPopup={setShowDayPopup}
                          setActiveRecurringType={setActiveRecurringType}
                          handleRecurringChange={handleRecurringChange}
                          handleFrequencyChange={handleFrequencyChange}
                          handleWeeklyDaysDone={handleWeeklyDaysDone}
                        />
                      </div>
                    </div>
                  )}

                  {/* Pickup Options */}
                  {isPickupMode && (
                    <div className="space-y-2 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup Options</Label>
                      <div className="space-y-3">
                        <CheckboxField id="after_hours_pickup" label="After Hours Pickup" checked={formData.after_hours_pickup} onChange={c => setFormData(p => ({ ...p, after_hours_pickup: c }))} disabled={isSaving} />
                      </div>
                    </div>
                  )}
                </div>

                {/* Desktop Staged Panel */}
                {!delivery && !useMobileLayout && <DeliveryStagedPanelDesktop {...stagedPanelProps} />}
              </div>
            </div>

            {/* Mobile Staged Panel */}
            {!delivery && useMobileLayout && <DeliveryStagedPanelMobile {...stagedPanelProps} show={showStagedPanel} onClose={() => setShowStagedPanel(false)} />}
          </CardContent>

          {/* Footer */}
          <CardFooter className="border-t p-3 flex-shrink-0" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
            <div className="flex items-center justify-between w-full gap-4">
              {!delivery && useMobileLayout && (
                <Button type="button" variant="outline" size="sm" onClick={() => setShowStagedPanel(!showStagedPanel)} className="gap-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  <Package className="w-4 h-4" />
                  Deliveries: (S: {stagedCount.new} P: {stagedCount.pending})
                </Button>
              )}
              <div className="flex gap-2 ml-auto">
                <Button type="button" variant="outline" size="sm" onClick={delivery ? handleCancelClick : cancelButtonState === 'clear' ? handleClearForm : handleCancelClick} disabled={isSaving || isPatientFormOpen} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                  {delivery ? 'Cancel' : cancelButtonState === 'clear' ? 'Clear' : 'Cancel'}
                </Button>

                {buttonState === 'done' ? (
                  <Button type="button" size="sm" onClick={() => handleBatchSave()} className="inline-flex items-center justify-center whitespace-nowrap font-medium h-8 rounded-md px-3 text-xs !text-white bg-emerald-600 hover:bg-emerald-700 gap-2" disabled={isSaving || !hasChanges || isPatientFormOpen}>
                    {isSaving ? <><div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Saving...</> : <><CheckCircle className="w-4 h-4" />Done</>}
                  </Button>
                ) : buttonState === 'updateStaged' ? (
                  <Button type="button" size="sm" onClick={handleUpdateStaged} className="inline-flex items-center justify-center whitespace-nowrap font-medium h-8 rounded-md px-3 text-xs !text-white bg-blue-600 hover:bg-blue-700 gap-2" disabled={isSaving || !isFormValid || isPatientFormOpen}>
                    <Edit2 className="w-4 h-4" />Update
                  </Button>
                ) : buttonState === 'add' ? (
                  <Button type="button" size="sm" onClick={handleAddToStaging} className="bg-blue-600 hover:bg-blue-700 gap-2" disabled={isSaving || !isFormValid || isPatientFormOpen || requiresDriverSelection} title={requiresDriverSelection ? 'Select a driver to create a pickup for this store/date' : undefined}>
                    <Plus className="w-4 h-4" />Add
                  </Button>
                ) : (
                  <Button type="submit" size="sm" onClick={async e => { e.preventDefault(); await handleSubmit(e); if (formData?.driver_id && formData?.delivery_date) { try { await recalculateAndUpdateStopOrders(formData.driver_id, formData.delivery_date); } catch (err) { console.warn('Stop order resequence skipped:', err?.response?.status || err?.message || err); }
// Force UI to reflect new stop numbers on cards and markers immediately
window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'stopOrderResequence', driverId: formData.driver_id, deliveryDate: formData.delivery_date } })); const now = new Date(); const hh = String(now.getHours()).padStart(2, '0'); const mm = String(now.getMinutes()).padStart(2, '0'); const currentLocalTime = `${hh}:${mm}`; try {
  await calculateRealTimeETA({ driverId: formData.driver_id, deliveryDate: formData.delivery_date, currentLocalTime, deviceTime: currentLocalTime });
} catch (err) {
  console.warn('ETA calculation skipped:', err?.response?.status || err?.message || err);
} } window.dispatchEvent(new CustomEvent('collapseSelectedStopCard')); window.dispatchEvent(new CustomEvent('deliveriesUpdated')); if (closeOnSave) onCancel(); setTimeout(() => window.dispatchEvent(new CustomEvent('refreshDeliveryStats')), 300); }} className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2" disabled={isSaving || !isFormValid || isPatientFormOpen || isFormLockedByPayroll}>
                    {isSaving ? <><div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />Saving...</> : <><Save className="w-4 h-4" />{isPickupMode ? 'Update Pickup' : 'Update Delivery'}</>}
                  </Button>
                )}
              </div>
            </div>
          </CardFooter>
        </Card>
      </motion.div>

      {/* Patient Match Popup */}
      {showMatchPopup && (
        <PatientMatchPopup isOpen={showMatchPopup} onClose={() => { setShowMatchPopup(false); setScanMatches([]); setExtractedData(null); }} matches={scanMatches} onSelectPatient={handleSelectMatchedPatient} extractedData={extractedData} stores={stores} />
      )}

      {/* Camera Overlay */}
      <DeliveryCameraOverlay
        show={showCameraOverlay} videoRef={videoRef} canvasRef={canvasRef}
        isScanning={isScanning} error={error} onCapture={handleCameraCapture}
        onClose={() => { stopCamera(); setShowCameraOverlay(false); setIsScanning(false); }}
      />

      {/* Delete Confirmation Dialog */}
      <DeliveryDeleteConfirmDialog
        deleteConfirmation={deleteConfirmation} setDeleteConfirmation={setDeleteConfirmation}
        isDeletingPending={isDeletingPending} sortedStagedDeliveries={sortedStagedDeliveries}
        stores={stores} stagedDeliveries={stagedDeliveries} allDeliveries={allDeliveries}
        onConfirmDelete={handleConfirmDelete}
      />
    </div>
  );
}