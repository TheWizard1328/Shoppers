import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Smartphone, Tablet, Monitor, CheckCircle } from 'lucide-react';
import { getUserAgentInfo } from '../utils/deviceUtils';

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';

export default function DeviceRegistration({ currentUser, onDeviceRegistered }) {
  const [showDialog, setShowDialog] = useState(false);
  const [existingDevices, setExistingDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');
  const [isPrimaryTracker, setIsPrimaryTracker] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!currentUser) return;

    const checkDevice = async () => {
      try {
        // Check if device identifier exists in localStorage
        const storedDeviceId = localStorage.getItem(DEVICE_ID_KEY);

        if (storedDeviceId) {
          // Verify this device still exists in backend
          const devices = await base44.entities.UserDevice.filter({ 
            user_id: currentUser.id,
            device_identifier: storedDeviceId,
            status: 'active'
          });

          if (devices && devices.length > 0) {
            // Device found, update last_active_at
            await base44.entities.UserDevice.update(devices[0].id, {
              last_active_at: new Date().toISOString()
            });
            setIsLoading(false);
            if (onDeviceRegistered) onDeviceRegistered(devices[0]);
            return;
          }
        }

        // No valid device found - fetch all user's devices
        const userDevices = await base44.entities.UserDevice.filter({ 
          user_id: currentUser.id,
          status: 'active'
        });

        setExistingDevices(userDevices || []);

        // Suggest default device name based on device info
        const { deviceType, os } = getUserAgentInfo();
        const defaultName = `${os} ${deviceType}`;
        setNewDeviceName(defaultName);

        // If user has no devices yet, default to creating new and being primary
        if (!userDevices || userDevices.length === 0) {
          setIsCreatingNew(true);
          setIsPrimaryTracker(true);
        }

        setShowDialog(true);
        setIsLoading(false);
      } catch (error) {
        console.error('Device check failed:', error);
        setIsLoading(false);
      }
    };

    checkDevice();
  }, [currentUser, onDeviceRegistered]);

  const handleSelectExistingDevice = async () => {
    if (!selectedDeviceId) return;

    setIsSaving(true);
    try {
      const device = existingDevices.find(d => d.id === selectedDeviceId);
      if (!device) return;

      // Save device identifier to localStorage
      localStorage.setItem(DEVICE_ID_KEY, device.device_identifier);

      // Update last_active_at
      await base44.entities.UserDevice.update(device.id, {
        last_active_at: new Date().toISOString()
      });

      setShowDialog(false);
      if (onDeviceRegistered) onDeviceRegistered(device);
    } catch (error) {
      console.error('Failed to select device:', error);
      alert('Failed to select device. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateNewDevice = async () => {
    if (!newDeviceName.trim()) {
      alert('Please enter a device name');
      return;
    }

    setIsSaving(true);
    try {
      // Generate new UUID
      const deviceIdentifier = crypto.randomUUID();
      
      // Get device info
      const { deviceType, os, browser } = getUserAgentInfo();

      // If this will be primary, unset any existing primary devices
      if (isPrimaryTracker) {
        const primaryDevices = existingDevices.filter(d => d.is_primary_tracker);
        await Promise.all(
          primaryDevices.map(d => 
            base44.entities.UserDevice.update(d.id, { is_primary_tracker: false })
          )
        );
      }

      // Create new device
      const newDevice = await base44.entities.UserDevice.create({
        user_id: currentUser.id,
        device_identifier: deviceIdentifier,
        device_name: newDeviceName.trim(),
        is_primary_tracker: isPrimaryTracker,
        last_active_at: new Date().toISOString(),
        device_info: {
          os,
          browser,
          device_type: deviceType
        },
        status: 'active'
      });

      // Save to localStorage
      localStorage.setItem(DEVICE_ID_KEY, deviceIdentifier);

      setShowDialog(false);
      if (onDeviceRegistered) onDeviceRegistered(newDevice);
    } catch (error) {
      console.error('Failed to create device:', error);
      alert('Failed to create device. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !showDialog) return null;

  const getDeviceIcon = (deviceType) => {
    switch (deviceType) {
      case 'Mobile':
        return <Smartphone className="w-5 h-5" />;
      case 'Tablet':
        return <Tablet className="w-5 h-5" />;
      case 'Desktop':
        return <Monitor className="w-5 h-5" />;
      default:
        return <Smartphone className="w-5 h-5" />;
    }
  };

  return (
    <Dialog open={showDialog} onOpenChange={() => {}}>
      <DialogContent className="max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Device Registration</DialogTitle>
          <DialogDescription>
            {existingDevices.length > 0 
              ? 'Select your device or register a new one'
              : 'Register this device to enable location tracking'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {existingDevices.length > 0 && !isCreatingNew && (
            <>
              <div className="space-y-2">
                <Label>Your Registered Devices</Label>
                <RadioGroup value={selectedDeviceId} onValueChange={setSelectedDeviceId}>
                  {existingDevices.map((device) => (
                    <div
                      key={device.id}
                      className="flex items-center space-x-3 border rounded-lg p-3 hover:bg-slate-50 cursor-pointer"
                      onClick={() => setSelectedDeviceId(device.id)}
                    >
                      <RadioGroupItem value={device.id} id={device.id} />
                      <Label htmlFor={device.id} className="flex items-center gap-2 flex-1 cursor-pointer">
                        {getDeviceIcon(device.device_info?.device_type)}
                        <div className="flex-1">
                          <div className="font-medium">{device.device_name}</div>
                          <div className="text-xs text-slate-500">
                            {device.device_info?.os} • {device.device_info?.browser}
                          </div>
                        </div>
                        {device.is_primary_tracker && (
                          <CheckCircle className="w-4 h-4 text-green-600" />
                        )}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>

              <Button
                variant="outline"
                onClick={() => setIsCreatingNew(true)}
                className="w-full"
              >
                Register New Device
              </Button>

              <Button
                onClick={handleSelectExistingDevice}
                disabled={!selectedDeviceId || isSaving}
                className="w-full"
              >
                {isSaving ? 'Selecting...' : 'Continue with Selected Device'}
              </Button>
            </>
          )}

          {(isCreatingNew || existingDevices.length === 0) && (
            <>
              <div className="space-y-2">
                <Label htmlFor="deviceName">Device Name</Label>
                <Input
                  id="deviceName"
                  value={newDeviceName}
                  onChange={(e) => setNewDeviceName(e.target.value)}
                  placeholder="e.g., My iPhone 15 Pro"
                />
              </div>

              <div className="flex items-center space-x-2 bg-slate-50 p-3 rounded-lg">
                <input
                  type="checkbox"
                  id="isPrimary"
                  checked={isPrimaryTracker}
                  onChange={(e) => setIsPrimaryTracker(e.target.checked)}
                  className="h-4 w-4"
                />
                <Label htmlFor="isPrimary" className="text-sm cursor-pointer">
                  Set as primary tracker
                  <span className="block text-xs text-slate-500 mt-1">
                    Only the primary device updates your location on the map
                  </span>
                </Label>
              </div>

              {existingDevices.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsCreatingNew(false);
                    setSelectedDeviceId(null);
                  }}
                  className="w-full"
                >
                  Back to Device List
                </Button>
              )}

              <Button
                onClick={handleCreateNewDevice}
                disabled={!newDeviceName.trim() || isSaving}
                className="w-full"
              >
                {isSaving ? 'Creating...' : 'Register Device'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}