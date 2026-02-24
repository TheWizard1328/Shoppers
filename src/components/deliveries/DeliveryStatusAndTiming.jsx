import React from "react";
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
    const activeStatuses = ['in_transit', 'en_route', 'pending'];
    const completionStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    if (delivery && completionStatuses.includes(value) && activeStatuses.includes(prevStatus)) {
      setCompletionTime(format(new Date(), 'HH:mm'));
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

  if (isCompletionStatus && delivery) {
    return (
      <div className="space-y-2">
        <div className="flex gap-3">
          <div className="flex-1 space-y-1">
            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{isPickupMode ? 'Pickup Store *' : 'Store *'}</Label>
            <Select value={storeSelectValue} onValueChange={handleStoreChange} disabled={isSaving || (isPickupMode && !!delivery)}>
              <SelectTrigger className="h-9"><SelectValue placeholder="Select store" /></SelectTrigger>
              <SelectContent className="z-[10030]">{storeOptions}</SelectContent>
            </Select>
          </div>
          <div className="flex-1 space-y-1">
            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{isPickupMode ? 'Pickup Status' : 'Status'}</Label>
            <Select value={formData.status} onValueChange={handleStatusChange} disabled={isSaving}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent className="z-[10030]">
                {isPickupMode ? (
                  <><SelectItem value="en_route">En Route</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem></>
                ) : (
                  <><SelectItem value="pending">Pending</SelectItem><SelectItem value="in_transit">In Transit</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="failed">Failed</SelectItem></>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex gap-3">
          <div className="flex-1 space-y-1">
            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Completion Time *</Label>
            <Input type="time" value={completionTime} onChange={(e) => setCompletionTime(e.target.value)} disabled={isSaving} className="h-9 text-sm" />
          </div>
          {isPickupMode && (
            <>
              <div className="flex-1 space-y-1">
                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Start Time</Label>
                <Input type="time" value={formData.delivery_time_start} onChange={(e) => setFormData(prev => ({ ...prev, delivery_time_start: e.target.value }))} disabled={isSaving} placeholder="Start" className="h-9 text-sm" />
              </div>
              <div className="flex-1 space-y-1">
                <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>End Time</Label>
                <Input type="time" value={formData.delivery_time_end} onChange={(e) => setFormData(prev => ({ ...prev, delivery_time_end: e.target.value }))} disabled={isSaving} placeholder="End" className="h-9 text-sm" />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-3">
        <div className="flex-1 space-y-1">
          <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>{isPickupMode ? 'Pickup Store *' : 'Store *'}</Label>
          <Select value={storeSelectValue} onValueChange={handleStoreChange} disabled={isSaving || (isPickupMode && !!delivery)}>
            <SelectTrigger className="h-9"><SelectValue placeholder="Select store" /></SelectTrigger>
            <SelectContent className="z-[10030]">{storeOptions}</SelectContent>
          </Select>
        </div>
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
        {isPickupMode && (
          <div className="flex-1 space-y-1">
            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup ID</Label>
            <Input value={formData.puid || formData.stop_id || ''} disabled placeholder="Auto-generated" className="h-9 text-sm bg-slate-100" />
          </div>
        )}
      </div>
      {!['completed', 'failed', 'cancelled', 'returned'].includes(formData.status) && (
        <div className="flex gap-3">
          <div className="flex-1 space-y-1">
            <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Time Window</Label>
            <div className="flex gap-1">
              <Input type="time" value={formData.time_window_start} onChange={(e) => setFormData(prev => ({ ...prev, time_window_start: e.target.value }))} disabled={isSaving} placeholder="Start" className="h-9 text-sm flex-1" />
              <Input type="time" value={formData.time_window_end} onChange={(e) => setFormData(prev => ({ ...prev, time_window_end: e.target.value }))} disabled={isSaving} placeholder="End" className="h-9 text-sm flex-1" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}