import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getUserAgentInfo } from '../utils/deviceUtils';

export default function DeviceForm({ device, existingDevices, onSubmit, onCancel }) {
  const [deviceName, setDeviceName] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [status, setStatus] = useState('active');
  const [deviceType, setDeviceType] = useState('Mobile');

  useEffect(() => {
    if (device) {
      setDeviceName(device.device_name || '');
      setIsPrimary(device.is_primary_tracker || false);
      setStatus(device.status || 'active');
      setDeviceType(device.device_info?.device_type || 'Mobile');
    } else {
      // New device - suggest default name
      const { deviceType: detectedType, os } = getUserAgentInfo();
      setDeviceName(`${os} ${detectedType}`);
      setDeviceType(detectedType);
      
      // If no existing devices, make this primary by default
      if (!existingDevices || existingDevices.length === 0) {
        setIsPrimary(true);
      }
    }
  }, [device, existingDevices]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!deviceName.trim()) {
      alert('Please enter a device name');
      return;
    }

    const deviceData = {
      device_name: deviceName.trim(),
      is_primary_tracker: isPrimary,
      status,
      device_info: {
        ...device?.device_info,
        device_type: deviceType
      }
    };

    // If setting as primary, include flag to unset others
    if (isPrimary && !device?.is_primary_tracker) {
      deviceData.unset_other_primary = true;
    }

    await onSubmit(deviceData, device?.id);
  };

  return (
    <Dialog open={true} onOpenChange={onCancel}>
      <DialogContent className="max-w-md" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-slate-900)' }}>
            {device ? 'Edit Device' : 'Add New Device'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="deviceName" style={{ color: 'var(--text-slate-700)' }}>Device Name</Label>
            <Input
              id="deviceName"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="e.g., My iPhone 15 Pro"
              style={{ 
                background: 'var(--bg-white)', 
                borderColor: 'var(--border-slate-300)',
                color: 'var(--text-slate-900)'
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="deviceType" style={{ color: 'var(--text-slate-700)' }}>Device Type</Label>
            <Select value={deviceType} onValueChange={setDeviceType}>
              <SelectTrigger id="deviceType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Mobile">Mobile</SelectItem>
                <SelectItem value="Tablet">Tablet</SelectItem>
                <SelectItem value="Desktop">Desktop</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="status" style={{ color: 'var(--text-slate-700)' }}>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center space-x-2 p-3 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
            <input
              type="checkbox"
              id="isPrimary"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
              className="h-4 w-4"
            />
            <Label htmlFor="isPrimary" className="text-sm cursor-pointer" style={{ color: 'var(--text-slate-700)' }}>
              Set as primary tracker
              <span className="block text-xs mt-1" style={{ color: 'var(--text-slate-500)' }}>
                Only the primary device updates your location on the map
              </span>
            </Label>
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onCancel} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" className="flex-1">
              {device ? 'Update' : 'Create'} Device
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}