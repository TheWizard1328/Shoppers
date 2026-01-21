import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, Save, Calendar, Plus, Trash2, DollarSign } from 'lucide-react';
import { Checkbox } from "@/components/ui/checkbox";
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';

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
    pay_rate_history: driver.pay_rate_history || []
  });
  const [isSaving, setIsSaving] = useState(false);
  const [newDeductionName, setNewDeductionName] = useState('');
  const [newDeductionAmount, setNewDeductionAmount] = useState('');

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

      // Include deductions in updates
      updates.deductions = formData.deductions;

      // CRITICAL: Include edited pay_rate_history in updates (allows manual deletion)
      updates.pay_rate_history = formData.pay_rate_history;

      // Check if pay rates changed (compare as numbers)
      const newPayRate = parseFloat(formData.pay_rate_per_delivery) || 0;
      const newKmRate = parseFloat(formData.extra_km_rate) || 0;
      const newKmLimit = parseFloat(formData.extra_km_limit) || 0;
      const newOversizedRate = parseFloat(formData.oversized_item_rate) || 0;
      
      const payRateChanged = newPayRate !== (parseFloat(driver.pay_rate_per_delivery) || 0);
      const kmRateChanged = newKmRate !== (parseFloat(driver.extra_km_rate) || 0);
      const kmLimitChanged = newKmLimit !== (parseFloat(driver.extra_km_limit) || 0);
      const oversizedRateChanged = newOversizedRate !== (parseFloat(driver.oversized_item_rate) || 0);

      if (payRateChanged || kmRateChanged || kmLimitChanged || oversizedRateChanged) {
        // Archive the OLD rates to history before updating with new values
        const today = format(new Date(), 'yyyy-MM-dd');
        
        // Create history entry with the CURRENT (old) values before they get overwritten
        const historyEntry = {
          effective_date: today,
          pay_rate_per_delivery: driver.pay_rate_per_delivery || 0,
          extra_km_rate: driver.extra_km_rate || 0,
          extra_km_limit: driver.extra_km_limit || 0,
          oversized_item_rate: driver.oversized_item_rate || 0
        };

        // Update with NEW values from form (as numbers)
        updates.pay_rate_per_delivery = newPayRate;
        updates.extra_km_rate = newKmRate;
        updates.extra_km_limit = newKmLimit;
        updates.oversized_item_rate = newOversizedRate;
        updates.pay_rate_history = [...formData.pay_rate_history, historyEntry];
      } else {
        // Always include pay rates in updates to ensure they're saved
        updates.pay_rate_per_delivery = newPayRate;
        updates.extra_km_rate = newKmRate;
        updates.extra_km_limit = newKmLimit;
        updates.oversized_item_rate = newOversizedRate;
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

          {/* Deductions Section */}
          <div className="pt-2 border-t">
            <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 block flex items-center gap-1">
              <DollarSign className="w-3 h-3" />
              Recurring Deductions
            </Label>
            
            {/* Existing Deductions */}
            {formData.deductions.length > 0 && (
              <div className="space-y-1 mb-3">
                {formData.deductions.map((deduction, idx) => (
                  <div key={idx} className="flex items-center gap-2 p-2 bg-slate-50 rounded">
                    <span className="flex-1 text-sm text-slate-700">{deduction.name}</span>
                    <span className="text-sm font-medium text-slate-900">${deduction.amount.toFixed(2)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
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
                ))}
              </div>
            )}
            
            {/* Add New Deduction */}
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
                        { name: newDeductionName.trim(), amount: parseFloat(newDeductionAmount) }
                      ]
                    }));
                    setNewDeductionName('');
                    setNewDeductionAmount('');
                  }
                }}
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--text-slate-500)' }}>
              These deductions will be applied to each payroll period
            </p>
          </div>

          {/* Pay Rate History */}
          {formData.pay_rate_history && formData.pay_rate_history.length > 0 && (
            <div className="pt-2 border-t">
              <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 block flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Rate History
              </Label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {formData.pay_rate_history
                  .sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date))
                  .map((entry, idx) => (
                    <div key={idx} className="text-xs p-2 bg-slate-50 rounded flex justify-between items-center">
                      <span className="font-medium text-slate-700">
                        {format(new Date(entry.effective_date), 'MMM dd, yyyy')}
                      </span>
                      <div className="text-slate-600 text-[10px]">
                        ${formatRate(entry.pay_rate_per_delivery)} / ${formatRate(entry.extra_km_rate)}/km / {formatRate(entry.extra_km_limit)}km
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
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