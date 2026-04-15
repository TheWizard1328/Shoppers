import React, { useRef, useEffect } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { isAppOwner } from '../utils/userRoles';
import { getPickupStopIdForDelivery } from '../utils/ampmUtils';
import { clearDeliveryActionLock } from '../utils/deliveryActionLock';

export default function DeliveryStatusAndTiming({
  formData,
  setFormData,
  delivery,
  isPickupMode,
  isSaving,
  isCompletionStatus,
  completionTime,
  setCompletionTime,
  availableStores,
  allDeliveries,
  currentUser,
  setSelectedPickupOption,
}) {
  const completionTimeRef = useRef(null);

  const activeStatuses = ['Staged', 'pending', 'in_transit', 'en_route'];
  const completionStatuses = ['completed', 'failed', 'cancelled', 'returned'];

  const isActive = activeStatuses.includes(formData.status);
  const isCompletion = completionStatuses.includes(formData.status);

  const handleStoreChange = (value) => {
    const selectedStore = availableStores.find(s => s.id === value);
    const storeId = selectedStore?._originalStoreId || value;
    const timeSlot = selectedStore?._timeSlot || null;
    const newPuid = getPickupStopIdForDelivery(storeId, formData.delivery_date, timeSlot || 'AM', allDeliveries);
    setFormData(prev => ({
      ...prev,
      store_id: storeId,
      ampm_deliveries: timeSlot,
      puid: newPuid || '',
      stop_id: isPickupMode && !delivery ? newPuid || '' : prev.stop_id,
    }));
    if (isPickupMode) setSelectedPickupOption(value);
  };

  const handleStatusChange = (value) => {
    const prevStatus = formData.status;
    setFormData(prev => ({ ...prev, status: value }));

    const changingFromCompletionToActive = completionStatuses.includes(prevStatus) && activeStatuses.includes(value);
    if (changingFromCompletionToActive) {
      clearDeliveryActionLock();
    }

    const changingToCompletion = completionStatuses.includes(value) && activeStatuses.includes(prevStatus);
    if (changingToCompletion) {
      const defaultCompletionTime = delivery?.delivery_date && delivery.delivery_date < format(new Date(), 'yyyy-MM-dd')
        ? (completionTime || '')
        : format(new Date(), 'HH:mm');
      setCompletionTime(defaultCompletionTime);
      // Auto-focus the completion time input after state update
      setTimeout(() => completionTimeRef.current?.focus(), 50);
    }
  };

  const storeSelectValue = (() => {
    if (formData.store_id) {
      if (formData.ampm_deliveries) {
        const variantId = `${formData.store_id}_${formData.ampm_deliveries}`;
        if (availableStores.some(s => s && s.id === variantId)) return variantId;
      }
      // Fallback: if variants exist but AM/PM not set yet, prefer AM, else PM, else base
      const amVariant = `${formData.store_id}_AM`;
      const pmVariant = `${formData.store_id}_PM`;
      if (availableStores.some(s => s && s.id === amVariant)) return amVariant;
      if (availableStores.some(s => s && s.id === pmVariant)) return pmVariant;
      return formData.store_id;
    }
    return "";
  })();

  const storeOptions = availableStores.map(store => {
    const baseStoreId = store._originalStoreId || store.id;
    const timeSlot = store._timeSlot || null;
    const puid = getPickupStopIdForDelivery(baseStoreId, formData.delivery_date, timeSlot || 'AM', allDeliveries);
    const baseStoreName = store._originalStoreId ? store.name.replace(/ \[AM\]| \[PM\]/, '') : store.name;
    const displayName = `${baseStoreName}${store._timeSlot ? ` [${store._timeSlot}]` : ''}${isAppOwner(currentUser) && puid ? ` {${puid}}` : ''}`;
    return <SelectItem key={store.id} value={store.id}>{displayName}</SelectItem>;
  });

  const statusSelect = (
    <div className="flex-1 space-y-1">
      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{isPickupMode ? 'Pickup Status' : 'Status'}</Label>
      <Select value={formData.status} onValueChange={handleStatusChange} disabled={isSaving}>
        <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
        <SelectContent className="z-[10030]">
          {delivery ? (
            isPickupMode ? (
              <><SelectItem value="en_route">En Route</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem></>
            ) : (
              <><SelectItem value="pending">Pending</SelectItem><SelectItem value="in_transit">In Transit</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="failed">Failed</SelectItem></>
            )
          ) : (
            <><SelectItem value="Staged">Staged</SelectItem><SelectItem value="pending">Pending</SelectItem><SelectItem value="in_transit">In Transit</SelectItem></>
          )}
        </SelectContent>
      </Select>
    </div>
  );

  const storeSelect = (
    <div className="flex-1 space-y-1">
      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{isPickupMode ? 'Pickup Store *' : 'Store *'}</Label>
      <Select value={storeSelectValue} onValueChange={handleStoreChange} disabled={isSaving || (isPickupMode && !!delivery)}>
        <SelectTrigger className="h-9"><SelectValue placeholder="Select store" /></SelectTrigger>
        <SelectContent className="z-[10030]">{storeOptions}</SelectContent>
      </Select>
    </div>
  );

  const renderTimeInput = (value, onChange, onClear, ref = null) => (
    <div className="relative">
      <Input
        ref={ref}
        type="text"
        inputMode="numeric"
        pattern="^([01]\d|2[0-3]):([0-5]\d)$"
        placeholder="HH:mm"
        value={value || ''}
        onChange={onChange}
        disabled={isSaving}
        data-hotkey-add="true"
        className="compact-time-input h-9 w-full px-2 pr-8 text-sm"
      />
      {value && !isSaving && (
        <button
          type="button"
          onClick={onClear}
          className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
          aria-label="Clear time"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <>
      <style>{`
        .compact-time-input::-webkit-calendar-picker-indicator {
          display: none;
          -webkit-appearance: none;
        }
        .compact-time-input::-webkit-clear-button,
        .compact-time-input::-webkit-inner-spin-button {
          display: none;
        }
      `}</style>

      <div className="space-y-2">
        {/* Row 1: Store + Status + (optional Pickup ID) */}
        <div className="flex gap-3">
          {storeSelect}
          {statusSelect}
        </div>

        {/* Row 2: Start/End Time — only for active statuses */}
        {isActive && (
          <div className={`grid gap-3 ${isPickupMode ? 'grid-cols-2' : 'grid-cols-2 lg:grid-cols-4'}`}>
            <div className="space-y-1">
              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                {isPickupMode ? 'Start Time' : 'Delivery Start'}
              </Label>
              {renderTimeInput(
                formData.delivery_time_start,
                (e) => setFormData(prev => ({ ...prev, delivery_time_start: e.target.value })),
                () => setFormData(prev => ({ ...prev, delivery_time_start: '' }))
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                {isPickupMode ? 'End Time' : 'Delivery End'}
              </Label>
              {renderTimeInput(
                formData.delivery_time_end,
                (e) => setFormData(prev => ({ ...prev, delivery_time_end: e.target.value })),
                () => setFormData(prev => ({ ...prev, delivery_time_end: '' }))
              )}
            </div>

            {!isPickupMode && (
              <>
                <div className="space-y-1">
                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Start</Label>
                  {renderTimeInput(
                    formData.time_window_start,
                    (e) => setFormData(prev => ({ ...prev, time_window_start: e.target.value })),
                    () => setFormData(prev => ({ ...prev, time_window_start: '' }))
                  )}
                </div>

                <div className="space-y-1">
                  <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient End</Label>
                  {renderTimeInput(
                    formData.time_window_end,
                    (e) => setFormData(prev => ({ ...prev, time_window_end: e.target.value })),
                    () => setFormData(prev => ({ ...prev, time_window_end: '' }))
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Row 2: Completion Time — only for completion statuses */}
        {isCompletion && (
          <div className="flex gap-3">
            {isAppOwner(currentUser) && (
              <div className="flex-1 space-y-1">
                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                  Arrival Time
                </Label>
                {renderTimeInput(
                  formData.arrival_time !== undefined ? formData.arrival_time : (delivery?.arrival_time ? format(new Date(delivery.arrival_time), 'HH:mm') : ''),
                  (e) => setFormData(prev => ({ ...prev, arrival_time: e.target.value })),
                  () => setFormData(prev => ({ ...prev, arrival_time: '' }))
                )}
              </div>
            )}
            <div className="flex-1 space-y-1">
              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                Completion Time *
              </Label>
              {renderTimeInput(
                completionTime,
                (e) => setCompletionTime(e.target.value),
                () => setCompletionTime(''),
                completionTimeRef
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}