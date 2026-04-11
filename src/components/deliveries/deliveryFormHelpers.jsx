import React from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function renderDeliveryIdentifiersSection({
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
}) {
  if (!isAppOwner(currentUser) || !delivery) return null;

  return (
    <div className="space-y-1 p-3 rounded-lg border" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
      <Label className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Delivery Identifiers</Label>
      <div className="flex gap-3">
        <div className="flex-1 space-y-1">
          <Label className="text-xs">TR#</Label>
          <Input value={formData.tracking_number || ''} onChange={(e) => setFormData((prev) => ({ ...prev, tracking_number: e.target.value }))} className="h-9 text-sm" disabled={isSaving} />
        </div>
        <div className="flex-1 space-y-1">
          <Label className="text-xs">SID</Label>
          <Input value={formData.stop_id || ''} onChange={(e) => setFormData((prev) => ({ ...prev, stop_id: e.target.value }))} className="h-9 text-sm" disabled={isSaving} />
        </div>
        {!isPickupMode && formData.patient_id && (
          <div className="flex-1 space-y-1">
            <Label className="text-xs">PID</Label>
            <div className="relative">
              <Input
                value={pidInputValue || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setPidInputValue(val);
                  setPidLookupStatus(null);
                  if (val.length === 5) {
                    const match = patients?.find((p) => p && p.patient_id === val);
                    setPidLookupStatus(match ? 'found' : 'not_found');
                  }
                }}
                onBlur={async (e) => {
                  const newPid = e.target.value;
                  const currentPatient = patients?.find((p) => p && p.id === formData.patient_id);
                  if (!currentPatient || !formData.patient_id) return;
                  if (newPid !== currentPatient.patient_id && newPid.length > 0 && pidLookupStatus !== 'not_found') {
                    await updatePatientLocal(formData.patient_id, { patient_id: newPid });
                  }
                }}
                className="h-9 text-sm pr-6"
                style={{
                  background: pidLookupStatus === 'found' ? '#ecfdf5' : pidLookupStatus === 'not_found' ? '#fef2f2' : undefined,
                  borderColor: pidLookupStatus === 'found' ? '#34d399' : pidLookupStatus === 'not_found' ? '#f87171' : undefined,
                  borderWidth: pidLookupStatus ? '2px' : undefined
                }}
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
          <Input value={formData.puid || ''} onChange={(e) => setFormData((prev) => ({ ...prev, puid: e.target.value }))} className="h-9 text-sm" disabled={isSaving} />
        </div>
        <div className="flex-1 space-y-1">
          <Label className="text-xs">AM/PM</Label>
          <Select value={formData.ampm_deliveries || ''} onValueChange={(value) => setFormData((prev) => ({ ...prev, ampm_deliveries: value }))} disabled={isSaving}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent className="z-[999999]">
              <SelectItem value="AM">AM</SelectItem>
              <SelectItem value="PM">PM</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {!isPickupMode && (
          <div className="flex-1 space-y-1">
            <Label className="text-xs">X-KM</Label>
            <Input
              type="text"
              value={formData.paid_km_override !== null && formData.paid_km_override !== undefined ? String(formData.paid_km_override) : ''}
              onChange={(e) => {
                const val = e.target.value;
                setFormData((prev) => ({ ...prev, paid_km_override: val === '' ? null : val }));
              }}
              onBlur={(e) => {
                const val = e.target.value;
                if (val !== '' && !isNaN(parseFloat(val))) {
                  setFormData((prev) => ({ ...prev, paid_km_override: parseFloat(parseFloat(val).toFixed(2)) }));
                }
              }}
              className="h-9 text-sm"
              disabled={isSaving}
            />
          </div>
        )}
      </div>
    </div>
  );
}