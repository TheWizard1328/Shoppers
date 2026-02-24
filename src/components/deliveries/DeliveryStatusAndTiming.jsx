import React, { useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";
import { isAppOwner } from '../utils/userRoles';
import { getPickupStopIdForDelivery } from '../utils/ampmUtils';

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

    const changingToCompletion = completionStatuses.includes(value) && activeStatuses.includes(prevStatus);
    if (changingToCompletion) {
      setCompletionTime(format(new Date(), 'HH:mm'));
      // Auto-focus the completion time input after state update
      setTimeout(() => completionTimeRef.current?.focus(), 50);
    }
  };

  const storeSelectValue = (() => {
    if (formData.store_id && formData.ampm_deliveries) {
      const variantId = `${formData.store_id}_${formData.ampm_deliveries}`;
      if (availableStores.some(s => s && s.id === variantId)) return variantId;
    }
    return formData.store_id || "";
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

  return (
    <div className="space-y-2">
      {/* Row 1: Store + Status + (optional Pickup ID) */}
      <div className="flex gap-3">
        {storeSelect}
        {statusSelect}
      </div>

      {/* Row 2: Start/End Time — only for active statuses */}
      {isActive && (
        <div className="flex gap-3">
          <div className="flex-1 space-y-1">
            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
              {isPickupMode ? 'Start Time' : 'Time Window'}
            </Label>
            <div className="flex gap-1">
              <Input type="time" value={formData.delivery_time_start || ''} onChange={(e) => setFormData(prev => ({ ...prev, delivery_time_start: e.target.value }))} disabled={isSaving} placeholder="Start" className="h-9 text-sm flex-1" />
              <Input type="time" value={formData.delivery_time_end || ''} onChange={(e) => setFormData(prev => ({ ...prev, delivery_time_end: e.target.value }))} disabled={isSaving} placeholder="End" className="h-9 text-sm flex-1" />
            </div>
          </div>
          {!isPickupMode && (
            <div className="flex-1 space-y-1">
              <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Time Window (Patient)</Label>
              <div className="flex gap-1">
                <Input type="time" value={formData.time_window_start || ''} onChange={(e) => setFormData(prev => ({ ...prev, time_window_start: e.target.value }))} disabled={isSaving} placeholder="Start" className="h-9 text-sm flex-1" />
                <Input type="time" value={formData.time_window_end || ''} onChange={(e) => setFormData(prev => ({ ...prev, time_window_end: e.target.value }))} disabled={isSaving} placeholder="End" className="h-9 text-sm flex-1" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Row 2: Completion Time — only for completion statuses */}
      {isCompletion && (
        <div className="flex gap-3">
          <div className="flex-1 space-y-1">
            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
              Completion Time {delivery?.arrival_time && `[Arrived: ${format(new Date(delivery.arrival_time), 'HH:mm')}]`} *
            </Label>
            <Input ref={completionTimeRef} type="time" value={completionTime} onChange={(e) => setCompletionTime(e.target.value)} disabled={isSaving} className="h-9 text-sm" />
          </div>
        </div>
      )}
    </div>
  );
}