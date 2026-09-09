import React, { useState, useRef, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { ChevronDown, Check } from 'lucide-react';
import { getPickupStopIdForDelivery } from '../utils/ampmUtils';
import { userHasRole } from '../utils/userRoles';

export default function PickupLocationMultiSelect({
  currentUser,
  availableStores,
  selectedPickupStoreIds,
  setSelectedPickupStoreIds,
  selectedPickupOption,
  setSelectedPickupOption,
  formData,
  setFormData,
  allDeliveries,
  allDrivers,
  getDefaultDriverForStoreSlot,
  getDriverNameForStorage,
  setForceOpenDriverSelect,
  scheduledDriverMap = {},
  defaultSlotDrivers = null,
  isSaving,
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const toggleStore = (store) => {
    const storeId = store._originalStoreId || store.id;
    const requestedSlot = store._timeSlot || 'AM';
    const { driverId: defaultDriverId, resolvedSlot, hasAnyAssignedSlot, hasSlotDriver } = getDefaultDriverForStoreSlot(storeId, requestedSlot, formData.delivery_date);
    const effectiveSlot = resolvedSlot || requestedSlot;
    const newPuid = getPickupStopIdForDelivery(storeId, formData.delivery_date, effectiveSlot, allDeliveries, formData.driver_id);

    // Driver auto-selection when the requested slot has NO scheduled default driver:
    //   1. Admin/dispatcher → the other slot's default is used (resolved by
    //      getDefaultDriverForStoreSlot's fallback, hasSlotDriver: false).
    //   2. Driver user → the active driver is automatically the assigned driver.
    //   3. No defaults for ANY slot on this date + admin/dispatcher → prompt by
    //      opening (and highlighting) the driver select.
    const isDriverUser = !!(currentUser && userHasRole(currentUser, 'driver'));
    let autoDriverId = defaultDriverId || null;
    let forceDriverPrompt = false;
    if (!hasSlotDriver) {
      if (isDriverUser) {
        autoDriverId = currentUser.id || null;
      } else if (!hasAnyAssignedSlot) {
        forceDriverPrompt = true;
        autoDriverId = null;
      }
    }

    const defaultDriver = autoDriverId
      ? allDrivers.find((d) => String(d.id) === String(autoDriverId) || String(d.user_id) === String(autoDriverId))
      : null;
    // Driver users may not appear in allDrivers — fall back to their own identity.
    const effectiveDriver = defaultDriver || (isDriverUser && autoDriverId ? currentUser : null);

    setSelectedPickupOption(store.id);
    setFormData((prev) => ({
      ...prev,
      store_id: storeId,
      ampm_deliveries: effectiveSlot,
      puid: newPuid || '',
      driver_id: effectiveDriver ? autoDriverId : prev.driver_id,
      driver_name: effectiveDriver ? (getDriverNameForStorage(effectiveDriver) || prev.driver_name) : prev.driver_name,
    }));
    setSelectedPickupStoreIds((prev) => {
      const next = new Set(prev);
      if (next.has(store.id)) { next.delete(store.id); } else { next.add(store.id); }
      return next;
    });
    if (forceDriverPrompt && !formData.driver_id) {
      setTimeout(() => setForceOpenDriverSelect(true), 150);
    } else {
      setForceOpenDriverSelect(false);
    }
  };

  const selectAll = () => {
    const allIds = new Set(availableStores.map((s) => s.id));
    setSelectedPickupStoreIds(allIds);
    const first = availableStores[0];
    if (first) {
      const baseId = first._originalStoreId || first.id;
      const slot = first._timeSlot || 'AM';
      setSelectedPickupOption(first.id);
      setFormData((prev) => ({ ...prev, store_id: baseId, ampm_deliveries: slot }));
    }
  };

  const deselectAll = () => {
    setSelectedPickupStoreIds(new Set());
    setSelectedPickupOption('');
    setFormData((prev) => ({ ...prev, store_id: '', ampm_deliveries: '' }));
  };

  const selectedCount = selectedPickupStoreIds.size || (selectedPickupOption ? 1 : 0);

  // Build display label for the trigger
  const getLabel = () => {
    if (selectedCount === 0) return 'Select store(s)';
    const selectedIds = selectedPickupStoreIds.size > 0 ? selectedPickupStoreIds : new Set([selectedPickupOption]);
    const names = availableStores
      .filter((s) => selectedIds.has(s.id))
      .map((s) => {
        const baseName = s._originalStoreId ? s.name.replace(/ \[AM\]| \[PM\]/, '') : s.name;
        return `${baseName}${s._timeSlot ? ` [${s._timeSlot}]` : ''}`;
      });
    if (names.length === 0) return 'Select store(s)';
    if (names.length <= 2) return names.join(', ');
    return `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
  };

  return (
    <div className="space-y-1 p-3 rounded-lg border border-surface" style={{ background: 'var(--bg-slate-50)' }}>
      <Label className="text-sm font-semibold text-body">Pickup Location *</Label>
      <div className="relative" ref={containerRef}>
        {/* Trigger */}
        <button
          type="button"
          disabled={isSaving}
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 bg-surface" style={{ borderColor: 'var(--border-slate-300)', color: selectedCount === 0 ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}
        >
          <span className="truncate">{getLabel()}</span>
          <ChevronDown className={`ml-2 h-4 w-4 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''} text-soft`} />
        </button>

        {/* Dropdown */}
        {open && (
          <div
            className="absolute z-[999999] mt-1 w-full rounded-md border shadow-lg bg-surface border-surface"
          >
            {/* Select All / Deselect All */}
            {availableStores.length > 1 && (
              <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'var(--border-slate-100)' }}>
                <button
                  type="button"
                  onClick={selectedPickupStoreIds.size === availableStores.length ? deselectAll : selectAll}
                  className="text-xs font-medium text-blue-600 hover:underline"
                >
                  {selectedPickupStoreIds.size === availableStores.length ? 'Deselect All' : 'Select All'}
                </button>
                {selectedCount > 0 && (
                  <span className="ml-auto text-xs text-soft">
                    {selectedCount} selected
                  </span>
                )}
              </div>
            )}

            {/* Options */}
            <div className="max-h-48 overflow-y-auto py-1">
              {availableStores.length === 0 && (
                <div className="px-3 py-2 text-sm" style={{ color: 'var(--text-slate-400)' }}>No stores available</div>
              )}
              {availableStores.map((store) => {
                const isChecked = selectedPickupStoreIds.has(store.id) || (!selectedPickupStoreIds.size && selectedPickupOption === store.id);
                const baseName = store._originalStoreId ? store.name.replace(/ \[AM\]| \[PM\]/, '') : store.name;
                const label = `${baseName}${store._timeSlot ? ` [${store._timeSlot}]` : ''}`;
                // A store+slot is a "default time slot" for the selected date only when THAT
                // specific slot has a scheduled driver — a per-slot override (real driver) or
                // the store's enabled day-of-week default for that slot. A reschedule for one
                // slot does NOT flag the other slot. Scoped to the selected city via the
                // stores shown in this list; not tied to the selected driver.
                const defaultKey = store._originalStoreId && store._timeSlot ? `${store._originalStoreId}_${store._timeSlot}` : null;
                const defaultDriverMap = defaultSlotDrivers instanceof Map ? defaultSlotDrivers : (defaultSlotDrivers && typeof defaultSlotDrivers.entries === 'function' ? new Map(defaultSlotDrivers) : new Map());
                const defaultDriverName = defaultKey ? defaultDriverMap.get(defaultKey) : null;
                const isDefaultForDate = !!defaultDriverName;
                return (
                  <button
                    key={store.id}
                    type="button"
                    onClick={() => toggleStore(store)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors text-left text-body ${isDefaultForDate ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-800'}`}
                    style={isDefaultForDate ? { background: 'var(--bg-slate-50)' } : undefined}
                  >
                    <div className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors ${isChecked ? 'bg-emerald-600 border-emerald-600' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900'}`}>
                      {isChecked && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                    </div>
                    <span className="flex-1">{label}</span>
                    {isDefaultForDate && (
                      <span
                        className="ml-auto flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap"
                        style={{ background: 'var(--accent-amber, #f59e0b)', color: '#1a1410' }}
                        title={`Scheduled default driver: ${defaultDriverName}`}
                      >
                        {defaultDriverName}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}