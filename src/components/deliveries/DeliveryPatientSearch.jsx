import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, X, Camera, Plus, Copy, MapPin } from "lucide-react";
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { getStoreColor } from '../utils/colorGenerator';
import { shouldShowStoreBadges } from '../utils/userRoles';
import { determineDeliveryAMPM } from '../utils/ampmUtils';

const userHasRole = (user, role) => {
  if (!user || !role) return false;
  if (Array.isArray(user.app_roles)) return user.app_roles.includes(role);
  if (user.app_role === role) return true;
  return false;
};

export default function DeliveryPatientSearch({
  patientSearch,
  setPatientSearch,
  selectedPatient,
  filteredPatients,
  highlightedPatientIndex,
  setHighlightedPatientIndex,
  selectedPatientIds,
  setSelectedPatientIds,
  isMultiSelectMode,
  isSaving,
  isScanning,
  formData,
  stores,
  currentUser,
  patientSearchInputRef,
  addPatientButtonRef,
  onPatientSelect,
  onAddSelectedPatients,
  onStartCamera,
  onDuplicatePatient,
  onNewAddressPatient,
  onCreatePatient,
  setIsPatientFormOpen,
  handleSearchKeyDown,
}) {
  return (
    <div className="relative flex-[2] space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
      <div className="flex items-center justify-between mb-1">
        <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Patient Search</Label>
        {selectedPatient && (
          <div className="p-1.5 px-2.5 bg-emerald-50 border border-emerald-200 rounded text-xs flex items-center gap-1.5 max-w-[200px]">
            <span className="text-emerald-700 font-medium truncate">✓ {selectedPatient.full_name}</span>
            {stores && selectedPatient.store_id && (() => {
              const patientStore = stores.find(s => s && s.id === selectedPatient.store_id);
              const storeAbbr = patientStore?.abbreviation;
              const storeColor = patientStore ? getStoreColor(patientStore) : '#64748b';
              const ampm = determineDeliveryAMPM(selectedPatient);
              const showBadge = shouldShowStoreBadges(currentUser);
              return (
                <>
                  {storeAbbr && showBadge && (
                    <Badge className="text-white text-[10px] px-1.5 py-0 h-4" style={{ backgroundColor: storeColor }}>{storeAbbr}</Badge>
                  )}
                  {ampm && <Badge className="bg-slate-200 text-slate-700 text-[10px] px-1.5 py-0 h-4">{ampm.toUpperCase()}</Badge>}
                </>
              );
            })()}
          </div>
        )}
      </div>

      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 z-10" />
          <Input
            ref={patientSearchInputRef}
            type="text"
            placeholder="Search by name, address, phone..."
            value={patientSearch}
            onChange={(e) => { setPatientSearch(e.target.value); setHighlightedPatientIndex(-1); }}
            onKeyDown={handleSearchKeyDown}
            className="pl-10 h-9"
            disabled={isSaving}
          />
          {patientSearch && (
            <button type="button" onClick={() => { setPatientSearch(''); setHighlightedPatientIndex(-1); }} className="absolute right-2 top-1/2 -translate-y-1/2 z-10">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <input type="file" accept="image/*" capture="environment" className="hidden" />
        <Button type="button" size="sm" variant="outline" className="h-9 w-9 p-0 flex-shrink-0" onClick={onStartCamera} disabled={isSaving || isScanning} title="Scan prescription label">
          {isScanning ? <div className="animate-spin w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full" /> : <Camera className="w-4 h-4" />}
        </Button>
      </div>

      {patientSearch && !formData.patient_id && (
        <div className="absolute top-full left-0 right-0 mt-1 max-h-64 overflow-y-auto border rounded-lg shadow-lg z-[100]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          {selectedPatientIds.size > 1 && (
            <div className="sticky top-0 bg-emerald-50 border-b border-emerald-200 p-2 flex items-center justify-between z-10">
              <span className="text-sm font-medium text-emerald-700">{selectedPatientIds.size} selected</span>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSelectedPatientIds(new Set())}>Clear</Button>
                <Button type="button" size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700" onClick={onAddSelectedPatients}>Add Selected</Button>
              </div>
            </div>
          )}

          {filteredPatients.length === 0 ? (
            <div className="p-4 text-center text-slate-500 text-sm">
              No patients found
              {onCreatePatient && (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) && (
                <Button
                  ref={addPatientButtonRef}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full mt-3 gap-2"
                  onClick={async () => {
                    const isDispatcher = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
                    const dispatcherStoreIds = isDispatcher ? (currentUser.store_ids || []) : [];
                    const defaultStoreId = dispatcherStoreIds.length === 1 ? dispatcherStoreIds[0] : '';

                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                    let newPID = '';
                    for (let i = 0; i < 5; i++) newPID += chars.charAt(Math.floor(Math.random() * chars.length));

                    setIsPatientFormOpen(true);
                    onCreatePatient((newPatient) => {
                      setIsPatientFormOpen(false);
                      onPatientSelect(newPatient, true);
                    }, { patient_id: newPID, full_name: '', phone: '', store_id: defaultStoreId, address: '', unit_number: '', notes: '', _isNew: true });
                  }}
                >
                  <Plus className="w-4 h-4" /> Add New Patient
                </Button>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {filteredPatients.map((patient, index) => {
                const patientStore = stores?.find(s => s && s.id === patient.store_id);
                const storeAbbr = patientStore?.abbreviation || '';
                const isHighlighted = index === highlightedPatientIndex;
                const isSelected = selectedPatientIds.has(patient.id);
                const isAlreadyStaged = patient._isAlreadyStaged;
                return (
                  <div
                    key={patient.id}
                    id={`patient-item-${index}`}
                    className={`w-full text-left p-2 transition-colors text-sm flex items-start gap-2 ${isHighlighted ? 'bg-emerald-50 border-l-4 border-emerald-500' : 'hover:bg-slate-50'} ${isSelected ? 'bg-blue-50' : ''} ${isAlreadyStaged ? 'bg-amber-50 opacity-70' : ''}`}
                  >
                    {(isMultiSelectMode || selectedPatientIds.size > 0) && (
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(checked) => {
                          setSelectedPatientIds(prev => {
                            const newSet = new Set(prev);
                            if (checked) newSet.add(patient.id); else newSet.delete(patient.id);
                            return newSet;
                          });
                        }}
                        className="mt-0.5"
                      />
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        if (isAlreadyStaged) { setPatientSearch(''); setHighlightedPatientIndex(-1); return; }
                        if (e.shiftKey || e.ctrlKey || e.metaKey) {
                          setSelectedPatientIds(prev => {
                            const newSet = new Set(prev);
                            if (newSet.has(patient.id)) newSet.delete(patient.id); else newSet.add(patient.id);
                            return newSet;
                          });
                        } else {
                          onPatientSelect(patient, false);
                          setPatientSearch('');
                          setHighlightedPatientIndex(-1);
                        }
                      }}
                      className={`flex-1 text-left ${isAlreadyStaged ? 'cursor-not-allowed' : ''}`}
                    >
                      <div className="font-medium truncate flex items-center gap-1.5">
                        {patient.full_name}
                        {isAlreadyStaged && <Badge className="bg-amber-200 text-amber-800 text-[10px] px-1.5 py-0 h-4">STAGED</Badge>}
                        {storeAbbr && shouldShowStoreBadges(currentUser) && (() => {
                          const color = patientStore ? getStoreColor(patientStore) : '#64748b';
                          return <Badge className="text-white text-[10px] px-1.5 py-0 h-4" style={{ backgroundColor: color }}>{storeAbbr}</Badge>;
                        })()}
                      </div>
                      <div className="text-xs text-slate-600 truncate">{patient.address}</div>
                      {patient.phone && (
                        <div className="text-xs text-slate-500 truncate">
                          {formatPhoneNumber(patient.phone)}{patient.unit_number && <> • #{patient.unit_number}</>}
                        </div>
                      )}
                    </button>
                    <div className="flex flex-col gap-1 ml-1">
                      <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0 hover:bg-blue-100" onClick={(e) => { e.stopPropagation(); onDuplicatePatient(patient); }} title="Duplicate Patient">
                        <Copy className="w-3 h-3 text-blue-600" />
                      </Button>
                      <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0 hover:bg-purple-100" onClick={(e) => { e.stopPropagation(); onNewAddressPatient(patient); }} title="New Address">
                        <MapPin className="w-3 h-3 text-purple-600" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}