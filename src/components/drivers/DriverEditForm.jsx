import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, Save, Calendar } from 'lucide-react';
import { format } from 'date-fns';

export default function DriverEditForm({ driver, onSave, onCancel }) {
  const [formData, setFormData] = useState({
    driver_status: driver.driver_status || 'off_duty',
    pay_rate_per_delivery: driver.pay_rate_per_delivery || 0,
    extra_km_rate: driver.extra_km_rate || 0,
    extra_km_limit: driver.extra_km_limit || 0,
    oversized_item_rate: driver.oversized_item_rate || 0
  });
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Prepare update payload
      const updates = {
        driver_status: formData.driver_status
      };

      // Check if pay rates changed
      const payRateChanged = formData.pay_rate_per_delivery !== (driver.pay_rate_per_delivery || 0);
      const kmRateChanged = formData.extra_km_rate !== (driver.extra_km_rate || 0);
      const kmLimitChanged = formData.extra_km_limit !== (driver.extra_km_limit || 0);
      const oversizedRateChanged = formData.oversized_item_rate !== (driver.oversized_item_rate || 0);

      if (payRateChanged || kmRateChanged || kmLimitChanged || oversizedRateChanged) {
        // Archive the OLD rates to history before updating with new values
        const today = format(new Date(), 'yyyy-MM-dd');
        const existingHistory = driver.pay_rate_history || [];
        
        // Create history entry with the CURRENT (old) values before they get overwritten
        const historyEntry = {
          effective_date: today,
          pay_rate_per_delivery: driver.pay_rate_per_delivery || 0,
          extra_km_rate: driver.extra_km_rate || 0,
          extra_km_limit: driver.extra_km_limit || 0,
          oversized_item_rate: driver.oversized_item_rate || 0
        };

        // Update with NEW values from form
        updates.pay_rate_per_delivery = formData.pay_rate_per_delivery;
        updates.extra_km_rate = formData.extra_km_rate;
        updates.extra_km_limit = formData.extra_km_limit;
        updates.oversized_item_rate = formData.oversized_item_rate;
        updates.pay_rate_history = [...existingHistory, historyEntry];
      }

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
          {/* Driver Status - Full Width */}
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
                <SelectItem value="on_duty">On Duty</SelectItem>
                <SelectItem value="off_duty">Off Duty</SelectItem>
                <SelectItem value="on_break">On Break</SelectItem>
                <SelectItem value="online">Online</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Pay Rates - 2 Column Grid */}
          <div className="grid grid-cols-2 gap-3">
            {/* Pay Rate per Delivery */}
            <div>
              <Label htmlFor="pay_rate" className="text-sm font-medium mb-1.5 block">
                Per Delivery ($)
              </Label>
              <Input
                id="pay_rate"
                type="number"
                step="0.01"
                min="0"
                value={formData.pay_rate_per_delivery}
                onChange={(e) => setFormData(prev => ({ ...prev, pay_rate_per_delivery: parseFloat(e.target.value) || 0 }))}
                placeholder="0.00"
              />
            </div>

            {/* Oversized Item Rate */}
            <div>
              <Label htmlFor="oversized_rate" className="text-sm font-medium mb-1.5 block">
                Oversized Item ($)
              </Label>
              <Input
                id="oversized_rate"
                type="number"
                step="0.01"
                min="0"
                value={formData.oversized_item_rate}
                onChange={(e) => setFormData(prev => ({ ...prev, oversized_item_rate: parseFloat(e.target.value) || 0 }))}
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
                type="number"
                step="0.01"
                min="0"
                value={formData.extra_km_rate}
                onChange={(e) => setFormData(prev => ({ ...prev, extra_km_rate: parseFloat(e.target.value) || 0 }))}
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
                type="number"
                step="0.1"
                min="0"
                value={formData.extra_km_limit}
                onChange={(e) => setFormData(prev => ({ ...prev, extra_km_limit: parseFloat(e.target.value) || 0 }))}
                placeholder="0.0"
              />
            </div>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
            KM Limit: Minimum km before extra pay starts
          </p>

          {/* Pay Rate History */}
          {driver.pay_rate_history && driver.pay_rate_history.length > 0 && (
            <div className="pt-2 border-t">
              <Label className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 block flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Rate History
              </Label>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {driver.pay_rate_history
                  .sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date))
                  .map((entry, idx) => (
                    <div key={idx} className="text-xs p-2 bg-slate-50 rounded flex justify-between">
                      <span className="font-medium text-slate-700">
                        {format(new Date(entry.effective_date), 'MMM dd, yyyy')}
                      </span>
                      <div className="text-slate-600">
                        ${entry.pay_rate_per_delivery || 0} / ${entry.extra_km_rate || 0}/km / {entry.extra_km_limit || 0}km limit
                      </div>
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