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
  isLoadingPredictions
}) {
  return (
    <div className="space-y-1 flex-1 overflow-y-auto min-h-0 custom-scrollbar">
      {/* Staged Deliveries Section (new, not yet saved) */}
      {sortedStagedDeliveries.filter(s => !s.id).length > 0 && (
        <>
          <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-emerald-600">
            Staged ({sortedStagedDeliveries.filter(s => !s.id).length})
          </div>
          {sortedStagedDeliveries.filter(s => !s.id).map((staged) => {
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
                        size="sm"
                      />
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
                      stagedDeliveries
                        .filter((item) => item._tempId !== staged._tempId)
                        .map(d => d.patient_id)
                        .filter(Boolean)
                    );
                    const filteredPredictions = fullPredictionListRef.current.filter(pred => !remainingStagedIds.has(pred.patient_id));
                    setProjectedDeliveries(filteredPredictions);
                    
                    if (editingStagedId === staged._tempId) {
                      setEditingStagedId(null);
                      handleClearForm();
                    }
                    
                    if (!isMobileDevice) {
                      setTimeout(() => patientSearchInputRef.current?.focus(), 100);
                    }
                  }}>
                  <Trash2 className="w-5 h-5" />
                </Button>
              </div>
            );
          })}
          <div className="border-t-2 border-emerald-200 my-2" />
        </>
      )}

      {/* Pending Deliveries Section */}
      {sortedStagedDeliveries.filter(s => s.id).length > 0 && (
        <>
          <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-orange-600">
            Pending ({sortedStagedDeliveries.filter(s => s.id).length})
          </div>
          {sortedStagedDeliveries.filter(s => s.id).map((staged) => {
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
                        size="sm"
                      />
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
                         stagedDeliveries
                           .filter((item) => item._tempId !== staged._tempId)
                           .map(d => d.patient_id)
                           .filter(Boolean)
                       );
                       const filteredPredictions = fullPredictionListRef.current.filter(pred => !remainingStagedIds.has(pred.patient_id));
                       setProjectedDeliveries(filteredPredictions);

                       if (editingStagedId === staged._tempId) {
                         setEditingStagedId(null);
                         handleClearForm();
                       }

                       if (!isMobileDevice) {
                         setTimeout(() => patientSearchInputRef.current?.focus(), 100);
                       }
                     }
                   }}>
                  <Trash2 className="w-5 h-5" />
                </Button>
              </div>
            );
          })}
          <div className="border-t-2 border-orange-200 my-2" />
        </>
      )}

      {/* Projected Deliveries Section */}
      {sortedProjectedDeliveries.length > 0 && (
        <div className="text-[10px] font-semibold uppercase tracking-wider px-1 py-1 text-yellow-600">
          Projected ({sortedProjectedDeliveries.length})
        </div>
      )}
      {sortedProjectedDeliveries.map((projected) => {
        const projectedStore = stores?.find((s) => s && s.id === projected.store_id);
        const storeColor = projectedStore ? getStoreColor(projectedStore) : '#64748b';
        const projectedPatient = patients?.find((p) => p && p.id === projected.patient_id);

        return (
          <div
            key={`proj-${projected.patient_id}`}
            className="flex p-2 rounded border-2 border-yellow-400 bg-yellow-50 text-xs transition-colors">

            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                <span className="font-medium truncate flex-1 min-w-0 text-slate-900">{projected.patient_name}</span>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {projectedStore?.abbreviation && shouldShowStoreBadges(currentUser) &&
                    <Badge className="text-white text-[10px] px-1.5 py-0 h-4" style={{ backgroundColor: storeColor }}>
                      {projectedStore.abbreviation}
                    </Badge>
                  }
                  <Badge className="bg-yellow-500 text-white text-[10px] px-1.5 py-0 h-4">PROJ</Badge>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <div className="truncate flex-1 min-w-0 text-slate-600 text-[10px]">{projected.frequency || projected.reason}</div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <SpecialSymbolsBadges
                    delivery={projected}
                    patient={projectedPatient}
                    isPickup={false}
                    size="sm"
                  />
                </div>
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
                if (!isMobileDevice) {
                  setTimeout(() => patientSearchInputRef.current?.focus(), 100);
                }
              }}
              title="Add to route">
              <Plus className="w-5 h-5" />
            </Button>
          </div>
        );
      })}

      {isLoadingPredictions && (
        <div className="p-4 text-center text-slate-500 text-xs flex items-center justify-center gap-2">
          <div className="animate-spin w-3 h-3 border-2 border-white border-t-transparent rounded-full"></div>
          Analyzing patterns...
        </div>
      )}

      {!isLoadingPredictions && sortedStagedDeliveries.length === 0 && sortedProjectedDeliveries.length === 0 && (
        <div className="p-4 text-center text-slate-400 text-xs">
          No deliveries staged yet
        </div>
      )}
    </div>
  );
}