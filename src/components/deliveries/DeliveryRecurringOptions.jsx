import React from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

const CheckboxField = ({ id, label, checked, onChange, disabled }) => (
  <div className="flex items-center space-x-2">
    <Checkbox id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    <Label htmlFor={id} className={`text-sm font-medium leading-none ${disabled ? 'text-slate-400' : ''}`}>{label}</Label>
  </div>
);

export default function DeliveryRecurringOptions({
  formData,
  setFormData,
  isSaving,
  currentFrequency,
  weeklyLabel,
  biWeeklyLabel,
  weeklyX4Label,
  showDayPopup,
  setShowDayPopup,
  setActiveRecurringType,
  handleRecurringChange,
  handleFrequencyChange,
  handleWeeklyDaysDone,
}) {
  return (
    <div className="flex-1 space-y-2 relative" id="recurring-section">
      <div className="py-1 flex items-center space-x-2">
        <Checkbox id="recurring" checked={formData.recurring} onCheckedChange={handleRecurringChange} disabled={isSaving} />
        <Label htmlFor="recurring" className="text-sm font-medium">Recurring</Label>
      </div>

      {showDayPopup && (
        <div className="absolute bottom-0 left-0 right-0 z-[100] rounded-lg shadow-xl p-3 border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-slate-900)' }}>Select Days</h3>
          <div className="space-y-2 mb-3">
            {[
              { id: 'recurring_weekly_mon', label: 'Monday' },
              { id: 'recurring_weekly_tue', label: 'Tuesday' },
              { id: 'recurring_weekly_wed', label: 'Wednesday' },
              { id: 'recurring_weekly_thu', label: 'Thursday' },
              { id: 'recurring_weekly_fri', label: 'Friday' },
              { id: 'recurring_weekly_sat', label: 'Saturday' },
              { id: 'recurring_weekly_sun', label: 'Sunday' },
            ].map(({ id, label }) => (
              <CheckboxField
                key={id}
                id={id}
                label={label}
                checked={formData[id]}
                onChange={(checked) => setFormData(prev => ({ ...prev, [id]: checked }))}
                disabled={isSaving}
              />
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={() => { setShowDayPopup(false); setActiveRecurringType(null); }}>Cancel</Button>
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={handleWeeklyDaysDone}>Done</Button>
          </div>
        </div>
      )}

      <RadioGroup value={currentFrequency} onValueChange={handleFrequencyChange} disabled={!formData.recurring || isSaving} className="grid gap-2">
        {[
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: weeklyLabel },
          { value: 'bi-weekly', label: biWeeklyLabel },
          { value: 'weekly-x4', label: weeklyX4Label },
          { value: 'monthly', label: 'Monthly' },
          { value: 'bi-monthly', label: 'Bi-Monthly' },
        ].map(({ value, label }) => (
          <div key={value} className="flex items-center space-x-2">
            <RadioGroupItem value={value} id={value} disabled={!formData.recurring || isSaving} />
            <Label htmlFor={value} className={`text-sm cursor-pointer ${!formData.recurring ? 'text-slate-400' : ''}`}>{label}</Label>
          </div>
        ))}
      </RadioGroup>
    </div>
  );
}