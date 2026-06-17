import React, { useState, useRef, useEffect } from 'react';
import { Label } from '@/components/ui/label';
import { ChevronDown, Check } from 'lucide-react';
import { getPickupStopIdForDelivery } from '../utils/ampmUtils';

export default function PickupLocationMultiSelect({
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
    const { driverId: defaultDriverId, resolvedSlot, hasAnyAssignedSlot } = getDefaultDriverForStoreSlot(storeId, requestedSlot, formData.delivery_date);
    const effectiveSlot = resolvedSlot || requestedSlot;
    const newPuid = getPickupStopIdForDelivery(storeId, formData.delivery_date, effectiveSlot, allDeliveries);
    const defaultDriver = defaultDriverId ? allDrivers.find((d) => d.id === defaultDriverId) : null;

    setSelectedPickupOption(store.id);
    setFormData((prev) => ({
      ...prev,
      store_id: storeId,
      ampm_deliveries: effectiveSlot,
      puid: newPuid || '',
      driver_id: defaultDriver ? defaultDriverId : prev.driver_id,
      driver_name: defaultDriver ? getDriverNameForStorage(defaultDriver) : prev.driver_name,
    }));
    setSelectedPickupStoreIds((prev) => {
      const next = new Set(prev);
      if (next.has(store.id)) { next.delete(store.id); } else { next.add(store.id); }
      return next;
    });
    if (!hasAnyAssignedSlot && !formData.driver_id) {
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
    <div className="space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Pickup Location *</Label>
      <div className="relative" ref={containerRef}>
        {/* Trigger */}
        <button
          type="button"
          disabled={isSaving}
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: selectedCount === 0 ? 'var(--text-slate-400)' : 'var(--text-slate-900)' }}
        >
          <span className="truncate">{getLabel()}</span>
          <ChevronDown className={`ml-2 h-4 w-4 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} style={{ color: 'var(--text-slate-500)' }} />
        </button>

        {/* Dropdown */}
        {open && (
          <div
            className="absolute z-[999999] mt-1 w-full rounded-md border shadow-lg"
            style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
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
                  <span className="ml-auto text-xs" style={{ color: 'var(--text-slate-500)' }}>
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
                return (
                  <button
                    key={store.id}
                    type="button"
                    onClick={() => toggleStore(store)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 transition-colors text-left"
                    style={{ color: 'var(--text-slate-900)' }}
                  >
                    <div className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors ${isChecked ? 'bg-emerald-600 border-emerald-600' : 'border-slate-300 bg-white'}`}>
                      {isChecked && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                    </div>
                    <span>{label}</span>
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