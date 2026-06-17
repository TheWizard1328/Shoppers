import React from 'react';
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
import { getStoreColor, hexToRgba } from '../utils/colorGenerator';
import { shouldShowStoreBadges } from '../utils/userRoles';

export default function DeliveryFormStaged({
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
  shouldAutoFocusFields,
  selectedDate
}) {
  const getDaysSinceLastDelivery = (lastDeliveryDate) => {
    if (!lastDeliveryDate) return null;

    const rawValue = String(lastDeliveryDate).trim();
    const normalizedDate = rawValue.includes('T') ? rawValue.split('T')[0] : rawValue;
    const [year, month, day] = normalizedDate.split('-').map(Number);
    if (!year || !month || !day) return null;

    const deliveredAt = new Date(year, month - 1, day);
    if (Number.isNaN(deliveredAt.getTime())) return null;

    // Use the form's selected date as reference, falling back to today.
    // IMPORTANT: parse as local date (not UTC) to avoid timezone off-by-one errors.
    let refStart;
    if (selectedDate) {
      const [ry, rm, rd] = String(selectedDate).split('T')[0].split('-').map(Number);
      refStart = new Date(ry, rm - 1, rd);
    } else {
      const now = new Date();
      refStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    const diffMs = refStart.getTime() - deliveredAt.getTime();
    const diffDays = Math.floor(diffMs / 86400000);

    return diffDays >= 0 ? diffDays : null;
  };

  const parseFrequencyDays = (frequency) => {
    if (!frequency) return null;

    const normalized = String(frequency).toLowerCase();
    const match = normalized.match(/(\d+)\s*(day|days|wk|wks|week|weeks|mon|mons|month|months)/);
    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2];
    if (unit.startsWith('day')) return amount;
    if (unit.startsWith('wk') || unit.startsWith('week')) return amount * 7;
    if (unit.startsWith('mon') || unit.startsWith('month')) return amount * 30;
    return null;
  };

  // Returns { expected, low, high, label } for known recurrence types, null otherwise
  const getRecurrenceWindow = (frequency) => {
    if (!frequency) return null;
    const f = String(frequency).toLowerCase();
    if (f.includes('bi-month') || f.includes('bimonth')) return { expected: 60, low: 57, high: 63, label: '2Mon' };
    if (f.includes('month'))                               return { expected: 30, low: 27, high: 33, label: '1Mon' };
    if (f.includes('x4') || f.includes('4 week'))         return { expected: 28, low: 25, high: 31, label: '4Wks' };
    if (f.includes('bi-week') || f.includes('biweek'))    return { expected: 14, low: 12, high: 16, label: '2Wks' };
    return null;
  };

  const formatLastDelivered = (lastDeliveryDate, frequency) => {
    const diffDays = getDaysSinceLastDelivery(lastDeliveryDate);
    if (diffDays === null) return null;

    const window = getRecurrenceWindow(frequency);

    if (window) {
      const { expected, low, high, label } = window;
      if (diffDays >= low && diffDays <= high) {
        if (diffDays === expected) return `LD: ${label}`;
        if (diffDays < expected)  return `LD: ~${label}`;
        return `LD: >${label}`;
      }
      // Outside window — overdue
      if (diffDays > high) return `LD: >${label}`;
      // Under window — not yet due, show approximate
      return `LD: ~${label}`;
    }

    // No known window — show raw elapsed time
    if (diffDays < 7)  return `LD: ${diffDays}d`;
    if (diffDays < 30) return `LD: ${Math.floor(diffDays / 7)}Wks`;
    return `LD: ${Math.floor(diffDays / 30)}Mon`;
  };

  return (
    <div className="space-y-1 flex-1 min-h-0 h-full overflow-y-auto overscroll-contain custom-scrollbar">
      {/* Staged Deliveries Section (new, not yet saved) */}
      {sortedStagedDeliveries.filter((s) => !s.id).length > 0 &&
      <>
          <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-emerald-600">
            Staged ({sortedStagedDeliveries.filter((s) => !s.id).length})
          </div>
          {sortedStagedDeliveries.filter((s) => !s.id).map((staged) => {
          const stagedStore = stores?.find((s) => s && s.id === staged.store_id);
          const storeColor = stagedStore ? getStoreColor(stagedStore) : '#64748b';
          const fadedBgColor = hexToRgba(storeColor, 0.1);

          return (
            <div
              key={staged._tempId}
              className={`flex p-2 rounded border-2 border-emerald-300 text-xs cursor-pointer transition-colors ${editingStagedId === staged._tempId ? 'border-blue-300' : 'hover:bg-slate-50'}`}
              style={{
                backgroundColor: editingStagedId === staged._tempId ? hexToRgba(storeColor, 0.2) : fadedBgColor
              }}
              onClick={() => handleStagedDeliveryClick(staged)}>

                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate flex-1 min-w-0">{staged.patient_name}</span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {staged.store_abbreviation && shouldShowStoreBadges(currentUser) &&
                    <Badge className="text-white text-[10px] px-1.5 py-0 h-4" style={{ backgroundColor: storeColor }}>
                         {staged.store_abbreviation}
                       </Badge>
                    }
                      {staged.distanceFromStore !== null && staged.distanceFromStore !== undefined && typeof staged.distanceFromStore === 'number' &&
                    <Badge
                      className="text-white text-[10px] px-1.5 py-0 h-4"
                      style={{
                        backgroundColor: staged.distanceFromStore <= 10 ? '#10b981' :
                        staged.distanceFromStore <= 15 ? '#f59e0b' : '#ef4444'
                      }}>
                         {staged.distanceFromStore.toFixed(1)} km
                       </Badge>
                    }
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="truncate flex-1 min-w-0" style={{ color: 'var(--text-slate-500)' }}>{staged.delivery_address}</div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <SpecialSymbolsBadges
                      delivery={staged}
                      patient={null}
                      isPickup={false}
                      size="sm" />
                    
                      {Array.isArray(staged.barcode_values) && staged.barcode_values.length > 0 &&
                    <Badge className="text-[10px] px-1.5 py-0 h-4 bg-emerald-100 text-emerald-700 flex items-center gap-1">
                          <svg className="h-3 w-4" viewBox="0 0 40 12" aria-hidden="true">
                            <rect x="1" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="6" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="9" y="1" width="3" height="10" fill="currentColor" />
                            <rect x="14" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="17" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="21" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="24" y="1" width="3" height="10" fill="currentColor" />
                            <rect x="29" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="32" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="36" y="1" width="1" height="10" fill="currentColor" />
                          </svg>
                          x{staged.barcode_values.length}
                        </Badge>
                    }
                      {staged.ampm_deliveries &&
                    <Badge className={`text-[10px] px-1.5 py-0 h-4 ${staged.ampm_deliveries === 'AM' ? 'bg-sky-100 text-sky-700 rounded-full' : 'bg-indigo-100 text-indigo-700 rounded-lg'}`}>
                          {staged.ampm_deliveries}
                        </Badge>
                    }
                    </div>
                  </div>
                </div>

                <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 flex-shrink-0 bg-red-600 hover:bg-red-700 text-white rounded ml-1"
                onClick={(e) => {
                  e.stopPropagation();
                  setStagedDeliveries((prev) => prev.filter((item) => item._tempId !== staged._tempId));

                  const remainingStagedIds = new Set(
                    stagedDeliveries.
                    filter((item) => item._tempId !== staged._tempId).
                    map((d) => d.patient_id).
                    filter(Boolean)
                  );
                  const filteredPredictions = fullPredictionListRef.current.filter((pred) => !remainingStagedIds.has(pred.patient_id));
                  setProjectedDeliveries(filteredPredictions);

                  if (editingStagedId === staged._tempId) {
                    setEditingStagedId(null);
                    handleClearForm();
                  }

                  if (shouldAutoFocusFields) {
                    setTimeout(() => patientSearchInputRef.current?.focus(), 100);
                  }
                }}>
                  <Trash2 className="w-5 h-5" />
                </Button>
              </div>);

        })}
          <div className="border-t-2 border-emerald-200 my-2" />
        </>
      }

      {/* Pending Deliveries Section */}
      {sortedStagedDeliveries.filter((s) => s.id).length > 0 &&
      <>
          <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-orange-600">
            Pending ({sortedStagedDeliveries.filter((s) => s.id).length})
          </div>
          {sortedStagedDeliveries.filter((s) => s.id).map((staged) => {
          const stagedStore = stores?.find((s) => s && s.id === staged.store_id);
          const storeColor = stagedStore ? getStoreColor(stagedStore) : '#64748b';
          const fadedBgColor = hexToRgba(storeColor, 0.1);

          return (
            <div
              key={staged._tempId}
              className={`flex p-2 rounded border text-xs cursor-pointer transition-colors ${editingStagedId === staged._tempId ? 'border-blue-300' : 'hover:bg-slate-50'}`}
              style={{
                backgroundColor: editingStagedId === staged._tempId ? hexToRgba(storeColor, 0.2) : fadedBgColor
              }}
              onClick={() => handleStagedDeliveryClick(staged)}>

                <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate flex-1 min-w-0">{staged.patient_name}</span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {staged.store_abbreviation && shouldShowStoreBadges(currentUser) &&
                    <Badge className="text-white text-[10px] px-1.5 py-0 h-4" style={{ backgroundColor: storeColor }}>
                         {staged.store_abbreviation}
                       </Badge>
                    }
                      {staged.distanceFromStore !== null && staged.distanceFromStore !== undefined && typeof staged.distanceFromStore === 'number' &&
                    <Badge
                      className="text-white text-[10px] px-1.5 py-0 h-4"
                      style={{
                        backgroundColor: staged.distanceFromStore <= 10 ? '#10b981' :
                        staged.distanceFromStore <= 15 ? '#f59e0b' : '#ef4444'
                      }}>
                         {staged.distanceFromStore.toFixed(1)} km
                       </Badge>
                    }
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="truncate flex-1 min-w-0" style={{ color: 'var(--text-slate-500)' }}>{staged.delivery_address}</div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <SpecialSymbolsBadges
                      delivery={staged}
                      patient={null}
                      isPickup={false}
                      size="sm" />
                    
                      {Array.isArray(staged.barcode_values) && staged.barcode_values.length > 0 &&
                    <Badge className="text-[10px] px-1.5 py-0 h-4 bg-emerald-100 text-emerald-700 flex items-center gap-1">
                          <svg className="h-3 w-4" viewBox="0 0 40 12" aria-hidden="true">
                            <rect x="1" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="6" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="9" y="1" width="3" height="10" fill="currentColor" />
                            <rect x="14" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="17" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="21" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="24" y="1" width="3" height="10" fill="currentColor" />
                            <rect x="29" y="1" width="1" height="10" fill="currentColor" />
                            <rect x="32" y="1" width="2" height="10" fill="currentColor" />
                            <rect x="36" y="1" width="1" height="10" fill="currentColor" />
                          </svg>
                          x{staged.barcode_values.length}
                        </Badge>
                    }
                      {staged.ampm_deliveries &&
                    <Badge className={`text-[10px] px-1.5 py-0 h-4 ${staged.ampm_deliveries === 'AM' ? 'bg-sky-100 text-sky-700 rounded-full' : 'bg-indigo-100 text-indigo-700 rounded-lg'}`}>
                          {staged.ampm_deliveries}
                        </Badge>
                    }
                    </div>
                  </div>
                </div>

                <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 flex-shrink-0 bg-red-600 hover:bg-red-700 text-white rounded ml-1"
                onClick={(e) => {
                  e.stopPropagation();
                  if (staged.id) {
                    setDeleteConfirmation({ show: true, staged });
                  } else {
                    setStagedDeliveries((prev) => prev.filter((item) => item._tempId !== staged._tempId));

                    const remainingStagedIds = new Set(
                      stagedDeliveries.
                      filter((item) => item._tempId !== staged._tempId).
                      map((d) => d.patient_id).
                      filter(Boolean)
                    );
                    const filteredPredictions = fullPredictionListRef.current.filter((pred) => !remainingStagedIds.has(pred.patient_id));
                    setProjectedDeliveries(filteredPredictions);

                    if (editingStagedId === staged._tempId) {
                      setEditingStagedId(null);
                      handleClearForm();
                    }

                    if (shouldAutoFocusFields) {
                      setTimeout(() => patientSearchInputRef.current?.focus(), 100);
                    }
                  }
                }}>
                  <Trash2 className="w-5 h-5" />
                </Button>
              </div>);

        })}
          <div className="border-t-2 border-orange-200 my-2" />
        </>
      }

      {/* Projected Deliveries Section */}
      {sortedProjectedDeliveries.length > 0 &&
      <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-yellow-600">
          Projected ({sortedProjectedDeliveries.length})
        </div>
      }
      {sortedProjectedDeliveries.map((projected) => {
        const projectedStore = stores?.find((s) => s && s.id === projected.store_id);
        const storeColor = projectedStore ? getStoreColor(projectedStore) : '#64748b';
        const projectedPatient = patients?.find((p) => p && p.id === projected.patient_id);
        const projectedAddress = projected.delivery_address || projectedPatient?.address || '';
        const projectedUnitNumber = projected.unit_number || projectedPatient?.unit_number || '';
        const projectedRecurrence = [
        projected.frequency || projected.reason,
        formatLastDelivered(projectedPatient?.last_delivery_date || projected.last_delivery_date, projected.frequency)].
        filter(Boolean).join(' • ');

        // Border/fill color: green = on/exact due date, red = overdue, bright yellow = early/upcoming
        const ldText = formatLastDelivered(projectedPatient?.last_delivery_date || projected.last_delivery_date, projected.frequency);
        const isOverdue = ldText?.includes('>');
        const isExact = ldText && !ldText.includes('~') && !ldText.includes('>') && getRecurrenceWindow(projected.frequency);
        const projBorderColor = isOverdue ? '#dc2626' : isExact ? '#16a34a' : '#eab308';
        const projBgColor    = isOverdue ? '#fef2f2' : isExact ? '#f0fdf4' : '#fefce8';

        return (
          <div
            key={`proj-${projected.patient_id}`} className="px-2 py-2 text-xs rounded flex border-2 transition-colors"
            style={{ borderColor: projBorderColor, backgroundColor: projBgColor }}>
            

            <div className="flex-1 min-w-0 flex flex-col gap-[1px] leading-none">
              <div className="flex items-center gap-1.5 min-h-0">
                <span className="font-medium truncate flex-1 min-w-0 text-slate-900 leading-none">{projected.patient_name}</span>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {projectedStore?.abbreviation && shouldShowStoreBadges(currentUser) &&
                  <Badge className="text-white text-[10px] px-1.5 py-0 h-4" style={{ backgroundColor: storeColor }}>
                      {projectedStore.abbreviation}
                    </Badge>
                  }
                  <Badge className="bg-yellow-500 text-white text-[10px] px-1.5 py-0 h-4">PROJ</Badge>
                </div>
              </div>
              <div className="flex items-center gap-1 min-h-0">
                <div className="truncate flex-1 min-w-0 text-slate-600 text-[10px] leading-none">
                  {projectedAddress}
                  {projectedUnitNumber ? ` #${projectedUnitNumber}` : ''}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <SpecialSymbolsBadges
                    delivery={projected}
                    patient={projectedPatient}
                    isPickup={false}
                    size="sm" />
                  
                </div>
              </div>
              <div className="text-slate-600 text-[10px] truncate pr-1 leading-none min-h-0">
                {projectedRecurrence}
              </div>
            </div>

            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 flex-shrink-0 rounded ml-1"
              style={{ backgroundColor: '#059669', color: '#ffffff' }}
              onClick={() => {
                confirmAddProjectedToStaged(projected);
                if (shouldAutoFocusFields) {
                  setTimeout(() => patientSearchInputRef.current?.focus(), 100);
                }
              }}
              title="Add to route">
              <Plus className="w-5 h-5" />
            </Button>
          </div>);

      })}

      {isLoadingPredictions &&
      <div className="p-4 text-center text-slate-500 text-xs flex items-center justify-center gap-2">
          <div className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full"></div>
          Refreshing projections...
        </div>
      }

      {!isLoadingPredictions && sortedStagedDeliveries.length === 0 && sortedProjectedDeliveries.length === 0 &&
      <div className="p-4 text-center text-slate-400 text-xs">
          No deliveries staged yet
        </div>
      }
    </div>);

}