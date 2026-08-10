import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, Save, Calendar, Plus, Trash2, DollarSign, CreditCard } from 'lucide-react';
import { Checkbox } from "@/components/ui/checkbox";
import { MultiSelect } from "@/components/ui/multi-select";
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { normalizeDate } from '@/components/utils/deductionHelpers';

// Helper to format number with min 2 decimals, preserving extra precision
const formatRate = (value) => {
  const num = parseFloat(value || 0);
  const str = num.toString();
  const decimals = str.includes('.') ? str.split('.')[1]?.length || 0 : 0;
  return num.toFixed(Math.max(2, decimals));
};

export default function DriverEditForm({ driver, onSave, onCancel }) {
  const [formData, setFormData] = useState({
    status: driver.status || 'active',
    driver_status: driver.driver_status || 'off_duty',
    location_tracking_enabled: driver.location_tracking_enabled !== false,
    pay_rate_per_delivery: formatRate(driver.pay_rate_per_delivery),
    extra_km_rate: formatRate(driver.extra_km_rate),
    extra_km_limit: formatRate(driver.extra_km_limit),
    oversized_item_rate: formatRate(driver.oversized_item_rate),
    gst_hst_enabled: driver.gst_hst_enabled || false,
    pay_cycle_type: driver.pay_cycle_type || 'monthly',
    deductions: driver.deductions || [],
    pay_rate_history: driver.pay_rate_history || [],
    square_location_ids: driver.square_location_ids || [],
    effective_date: format(new Date(), 'yyyy-MM-dd')  // default to today, editable
  });
  const [isSaving, setIsSaving] = useState(false);
  const [newDeductionName, setNewDeductionName] = useState('');
  const [newDeductionAmount, setNewDeductionAmount] = useState('');
  const [newDeductionStartDate, setNewDeductionStartDate] = useState('');
  const [newDeductionEndDate, setNewDeductionEndDate] = useState('');
  const [squareLocations, setSquareLocations] = useState([]);

  // Load Square locations on mount
  useEffect(() => {
    const loadSquareLocations = async () => {
      try {
        const locations = await base44.entities.SquareLocationConfig.list();
        setSquareLocations(locations || []);
      } catch (error) {
        console.error('Failed to load Square locations:', error);
      }
    };
    loadSquareLocations();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Prepare update payload
      const updates = {
        status: formData.status,
        driver_status: formData.driver_status,
        location_tracking_enabled: formData.location_tracking_enabled,
        gst_hst_enabled: formData.gst_hst_enabled,
        pay_cycle_type: formData.pay_cycle_type
      };

      // Include deductions in updates — normalize empty date strings to undefined
      updates.deductions = (formData.deductions || []).map((d) => {
        const s = normalizeDate(d?.start_date) || undefined;
        const e = normalizeDate(d?.end_date) || undefined;
        return { ...d, start_date: s, end_date: e };
      });

      // CRITICAL: Include edited pay_rate_history in updates (allows manual deletion)
      updates.pay_rate_history = formData.pay_rate_history;

      // Include Square location assignments
      updates.square_location_ids = formData.square_location_ids;

      // Always update main pay rate fields on the AppUser
      const newPayRate = parseFloat(formData.pay_rate_per_delivery) || 0;
      const newKmRate = parseFloat(formData.extra_km_rate) || 0;
      const newKmLimit = parseFloat(formData.extra_km_limit) || 0;
      const newOversizedRate = parseFloat(formData.oversized_item_rate) || 0;

      updates.pay_rate_per_delivery = newPayRate;
      updates.extra_km_rate = newKmRate;
      updates.extra_km_limit = newKmLimit;
      updates.oversized_item_rate = newOversizedRate;
      updates.gst_hst_enabled = formData.gst_hst_enabled;
      updates.pay_cycle_type = formData.pay_cycle_type;

      // Check if pay rates or pay cycle changed — if so, add a new history entry
      const payRateChanged = newPayRate !== (parseFloat(driver.pay_rate_per_delivery) || 0);
      const kmRateChanged = newKmRate !== (parseFloat(driver.extra_km_rate) || 0);
      const kmLimitChanged = newKmLimit !== (parseFloat(driver.extra_km_limit) || 0);
      const oversizedRateChanged = newOversizedRate !== (parseFloat(driver.oversized_item_rate) || 0);
      const payCycleChanged = formData.pay_cycle_type !== (driver.pay_cycle_type || 'monthly');

      // Backfill pay_cycle_type on legacy history entries missing it.
      // Use the driver's ORIGINAL pay_cycle_type (before this edit) as the default —
      // NOT the new formData value, and NOT a hardcoded 'monthly'.
      const originalCycleType = driver.pay_cycle_type || 'monthly';
      const normalizedHistory = formData.pay_rate_history.map(entry => ({
        ...entry,
        pay_cycle_type: entry.pay_cycle_type || originalCycleType,
        gst_hst_enabled: entry.gst_hst_enabled ?? false
      }));
      updates.pay_rate_history = normalizedHistory;

      const gstChanged = formData.gst_hst_enabled !== (driver.gst_hst_enabled || false);

      if (payRateChanged || kmRateChanged || kmLimitChanged || oversizedRateChanged || payCycleChanged || gstChanged) {
        const historyEntry = {
          effective_date: formData.effective_date,
          pay_rate_per_delivery: newPayRate,
          extra_km_rate: newKmRate,
          extra_km_limit: newKmLimit,
          oversized_item_rate: newOversizedRate,
          pay_cycle_type: formData.pay_cycle_type || 'monthly',
          gst_hst_enabled: formData.gst_hst_enabled || false
        };
        updates.pay_rate_history = [...normalizedHistory, historyEntry];
      }

      // Call parent onSave which handles the AppUser update
      await onSave(updates);
    } catch (error) {
      console.error('Error saving driver settings:', error);
      alert('Failed to save driver settings: ' + (error.message || 'Please try again'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md z-[10001]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Edit Driver Settings
            <Badge variant="outline">{driver.user_name || driver.full_name}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Status Row - 3 columns */}
          <div className="grid grid-cols-3 gap-3">
            {/* User Status (Active/Inactive) */}
            <div>
              <Label htmlFor="status" className="text-sm font-medium mb-1.5 block">
                User Status
              </Label>
              <Select
                value={formData.status}
                onValueChange={(value) => setFormData(prev => ({ ...prev, status: value }))}
              >
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10002]">
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Driver Status */}
            <div>
              <Label htmlFor="driver_status" className="text-sm font-medium mb-1.5 block">
                Driver Status
              </Label>
              <Select
                value={formData.driver_status}
                onValueChange={(value) => setFormData(prev => ({ ...prev, driver_status: value }))}
              >
                <SelectTrigger id="driver_status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10002]">
                  <SelectItem value="off_duty">Off Duty</SelectItem>
                  <SelectItem value="on_duty">On Duty</SelectItem>
                  <SelectItem value="on_break">On Break</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Location Sharing */}
            <div>
              <Label htmlFor="location_sharing" className="text-sm font-medium mb-1.5 block">
                Location Sharing
              </Label>
              <Select
                value={formData.location_tracking_enabled ? 'on' : 'off'}
                onValueChange={(value) => setFormData(prev => ({ ...prev, location_tracking_enabled: value === 'on' }))}
              >
                <SelectTrigger id="location_sharing">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10002]">
                  <SelectItem value="on">On</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Pay Cycle, Pay Rate & Tax - Row 1 */}
          <div className="grid grid-cols-3 gap-3">
            {/* Pay Cycle Type */}
            <div>
              <Label htmlFor="pay_cycle_type" className="text-sm font-medium mb-1.5 block">
                Pay Cycle
              </Label>
              <Select
                value={formData.pay_cycle_type}
                onValueChange={(value) => setFormData(prev => ({ ...prev, pay_cycle_type: value }))}
              >
                <SelectTrigger id="pay_cycle_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="z-[10002]">
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="biweekly">Bi-Weekly</SelectItem>
                  <SelectItem value="semimonthly">Semi-Monthly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Pay Rate per Delivery */}
            <div>
              <Label htmlFor="pay_rate" className="text-sm font-medium mb-1.5 block">
                Per Delivery ($)
              </Label>
              <Input
                id="pay_rate"
                type="text"
                inputMode="decimal"
                value={formData.pay_rate_per_delivery}
                onChange={(e) => setFormData(prev => ({ ...prev, pay_rate_per_delivery: e.target.value }))}
                placeholder="0.00"
              />
            </div>

            {/* GST/HST Tax */}
            <div>
              <Label className="text-sm font-medium mb-1.5 block">
                Tax
              </Label>
              <div className="flex items-center gap-2 h-9 px-3 border rounded-md bg-background">
                <Checkbox
                  id="gst_hst"
                  checked={formData.gst_hst_enabled}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, gst_hst_enabled: checked }))}
                />
                <Label htmlFor="gst_hst" className="text-sm font-medium cursor-pointer">
                  GST/HST
                </Label>
              </div>
            </div>
          </div>

          {/* Effective Date for Rate/Cycle Changes */}
          {(formData.pay_cycle_type !== (driver.pay_cycle_type || 'monthly') ||
            parseFloat(formData.pay_rate_per_delivery) !== (parseFloat(driver.pay_rate_per_delivery) || 0) ||
            parseFloat(formData.extra_km_rate) !== (parseFloat(driver.extra_km_rate) || 0) ||
            parseFloat(formData.extra_km_limit) !== (parseFloat(driver.extra_km_limit) || 0) ||
            parseFloat(formData.oversized_item_rate) !== (parseFloat(driver.oversized_item_rate) || 0) ||
            formData.gst_hst_enabled !== (driver.gst_hst_enabled || false)) && (
            <div>
              <Label htmlFor="effective_date" className="text-sm font-medium mb-1.5 block flex items-center gap-1">
                <Calendar className="w-3.5 h-3.5" />
                Effective Date for Changes
              </Label>
              <Input
                id="effective_date"
                type="date"
                value={formData.effective_date}
                onChange={(e) => setFormData(prev => ({ ...prev, effective_date: e.target.value }))}
                className="w-full"
              />
              <p className="text-[11px] text-slate-500 dark:text-slate-400 dark:text-slate-500 mt-1">Deliveries on or after this date use the new rates/cycle. Earlier deliveries keep the previous rates.</p>
            </div>
          )}

          {/* Oversized, Extra KM & KM Limit - Row 2 */}
          <div className="grid grid-cols-3 gap-3">
            {/* Oversized Item Rate */}
            <div>
              <Label htmlFor="oversized_rate" className="text-sm font-medium mb-1.5 block">
                Oversized ($)
              </Label>
              <Input
                id="oversized_rate"
                type="text"
                inputMode="decimal"
                value={formData.oversized_item_rate}
                onChange={(e) => setFormData(prev => ({ ...prev, oversized_item_rate: e.target.value }))}
                placeholder="0.00"
              />
            </div>

            {/* Extra KM Rate */}
            <div>
              <Label htmlFor="km_rate" className="text-sm font-medium mb-1.5 block">
                Extra KM ($/km)
              </Label>
              <Input
                id="km_rate"
                type="text"
                inputMode="decimal"
                value={formData.extra_km_rate}
                onChange={(e) => setFormData(prev => ({ ...prev, extra_km_rate: e.target.value }))}
                placeholder="0.00"
              />
            </div>

            {/* Extra KM Limit */}
            <div>
              <Label htmlFor="km_limit" className="text-sm font-medium mb-1.5 block">
                KM Limit (km)
              </Label>
              <Input
                id="km_limit"
                type="text"
                inputMode="decimal"
                value={formData.extra_km_limit}
                onChange={(e) => setFormData(prev => ({ ...prev, extra_km_limit: e.target.value }))}
                placeholder="0.00"
              />
            </div>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
            KM Limit: Minimum km before extra pay starts
          </p>

          {/* Square Card Locations */}
          {squareLocations.length > 0 && (
            <div className="pt-2 border-t">
              <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 dark:text-slate-500 mb-2 block flex items-center gap-1">
                <CreditCard className="w-3 h-3" />
                Square Card Locations
              </Label>
              <MultiSelect
                options={squareLocations.map((loc) => ({
                  label: loc.name,
                  value: loc.id
                }))}
                value={formData.square_location_ids}
                onChange={(values) => setFormData((prev) => ({ ...prev, square_location_ids: values }))}
                placeholder="Select Square card locations..."
              />
              <p className="text-xs mt-1" style={{ color: 'var(--text-slate-500)' }}>
                Assign Square terminals/cards for COD processing
              </p>
            </div>
          )}

          {/* Deductions Section */}
          <div className="pt-2 border-t">
            <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2 block flex items-center gap-1">
              <DollarSign className="w-3 h-3" />
              Recurring Deductions
            </Label>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-2">Set a Start/End date to control which pay periods each deduction applies to. Blank means no bound.</p>

            {/* Existing Deductions */}
            {formData.deductions.length > 0 && (
              <div className="space-y-1.5 mb-3">
                {formData.deductions.map((deduction, idx) => {
                  const dateRange = (() => {
                    const s = normalizeDate(deduction.start_date);
                    const e = normalizeDate(deduction.end_date);
                    if (!s && !e) return null;
                    return { s, e };
                  })();
                  return (
                    <div key={idx} className="p-2 bg-slate-50 dark:bg-slate-800 rounded text-sm">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 font-medium text-slate-700 dark:text-slate-200 truncate">{deduction.name}</span>
                        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">${Number(deduction.amount || 0).toFixed(2)}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
                          onClick={() => {
                            setFormData(prev => ({
                              ...prev,
                              deductions: prev.deductions.filter((_, i) => i !== idx)
                            }));
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                        <div>
                          <Label className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1 block">Start</Label>
                          <Input
                            type="date"
                            value={normalizeDate(deduction.start_date)}
                            onChange={(e) => {
                              const value = e.target.value || '';
                              setFormData(prev => ({
                                ...prev,
                                deductions: prev.deductions.map((d, i) => i === idx ? { ...d, start_date: value } : d)
                              }));
                            }}
                            className="h-7 text-xs"
                          />
                        </div>
                        <div>
                          <Label className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1 block">End</Label>
                          <Input
                            type="date"
                            value={normalizeDate(deduction.end_date)}
                            onChange={(e) => {
                              const value = e.target.value || '';
                              setFormData(prev => ({
                                ...prev,
                                deductions: prev.deductions.map((d, i) => i === idx ? { ...d, end_date: value } : d)
                              }));
                            }}
                            className="h-7 text-xs"
                          />
                        </div>
                      </div>
                      {dateRange && (
                        <p className="text-[10px] mt-1 text-slate-400 dark:text-slate-500">
                          Active: {dateRange.s || 'open'} → {dateRange.e || 'ongoing'}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add New Deduction */}
            <div className="space-y-1.5">
              <div className="flex gap-2">
                <Input
                  placeholder="Deduction name"
                  value={newDeductionName}
                  onChange={(e) => setNewDeductionName(e.target.value)}
                  className="flex-1 h-8 text-sm"
                />
                <Input
                  type="number"
                  placeholder="Amount"
                  value={newDeductionAmount}
                  onChange={(e) => setNewDeductionAmount(e.target.value)}
                  className="w-24 h-8 text-sm"
                  step="0.01"
                  min="0"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2"
                  disabled={!newDeductionName.trim() || !newDeductionAmount || parseFloat(newDeductionAmount) <= 0}
                  onClick={() => {
                    if (newDeductionName.trim() && parseFloat(newDeductionAmount) > 0) {
                      setFormData(prev => ({
                        ...prev,
                        deductions: [
                          ...prev.deductions,
                          {
                            name: newDeductionName.trim(),
                            amount: parseFloat(newDeductionAmount),
                            start_date: normalizeDate(newDeductionStartDate) || undefined,
                            end_date: normalizeDate(newDeductionEndDate) || undefined
                          }
                        ]
                      }));
                      setNewDeductionName('');
                      setNewDeductionAmount('');
                      setNewDeductionStartDate('');
                      setNewDeductionEndDate('');
                    }
                  }}
                >
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-0.5 block">Start Date (optional)</Label>
                  <Input
                    type="date"
                    value={newDeductionStartDate}
                    onChange={(e) => setNewDeductionStartDate(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-0.5 block">End Date (optional)</Label>
                  <Input
                    type="date"
                    value={newDeductionEndDate}
                    onChange={(e) => setNewDeductionEndDate(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            </div>
            <p className="text-xs mt-1.5" style={{ color: 'var(--text-slate-500)' }}>
              These deductions will be applied to each payroll period that starts within the date range.
            </p>
          </div>

          {/* Pay Rate History */}
          {formData.pay_rate_history && formData.pay_rate_history.length > 0 && (
            <div className="pt-2 border-t">
              <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 dark:text-slate-500 mb-2 block flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Rate History
              </Label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {formData.pay_rate_history
                  .sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date))
                  .map((entry, idx) => (
                    <div key={idx} className="text-xs p-2 bg-slate-50 dark:bg-slate-800 rounded flex justify-between items-center gap-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap">
                          {format(new Date(entry.effective_date), 'MMM dd, yyyy')}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap" style={{ backgroundColor: '#e2e8f0', color: '#475569' }}>
                          {(() => {
                            const c = entry.pay_cycle_type || 'monthly';
                            return c === 'semimonthly' ? 'Semi-Mo' : c === 'biweekly' ? 'Bi-Wk' : c === 'weekly' ? 'Wkly' : c.charAt(0).toUpperCase() + c.slice(1);
                          })()}
                        </span>
                      </div>
                      <div className="text-slate-600 dark:text-slate-400 dark:text-slate-500 text-[10px]">
                        ${formatRate(entry.pay_rate_per_delivery)} / ${formatRate(entry.extra_km_rate)}/km / {formatRate(entry.extra_km_limit)}km / OS: ${formatRate(entry.oversized_item_rate)}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0 text-red-500 hover:text-red-700 hover:bg-red-50 dark:bg-red-950 dark:hover:bg-red-950"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setFormData(prev => ({
                            ...prev,
                            pay_rate_history: prev.pay_rate_history.filter((_, i) => i !== idx)
                          }));
                        }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-4 border-t">
          <Button variant="outline" onClick={onCancel} disabled={isSaving}>
            <X className="w-4 h-4 mr-1" />
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving} className="bg-emerald-600 hover:bg-emerald-700">
            <Save className="w-4 h-4 mr-1" />
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}