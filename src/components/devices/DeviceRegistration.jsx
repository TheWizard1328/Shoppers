import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { Smartphone, Tablet, Monitor, CheckCircle } from 'lucide-react';
import { getUserAgentInfo } from '../utils/deviceUtils';
import { invalidateDeviceIdentifierCache } from '../utils/userSettingsManager';

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

  // Complete registration in-place (no page reload) so the boot resumes with the
  // newly-selected device identifier even in environments where a reload would
  // wipe ephemeral storage (e.g. the preview browser). Invalidates the
  // device-identifier cache so the resumed boot reads the new id, notifies the
  // parent to hide the modal, and dispatches an event useLayoutInit listens for
  // to re-run the bootstrap sequence.
  const completeRegistration = (device) => {
    invalidateDeviceIdentifierCache();
    setShowDialog(false);
    if (onDeviceRegistered) onDeviceRegistered(device);
    window.dispatchEvent(new CustomEvent('deviceRegistrationCompleted', {
      detail: { device_identifier: device?.device_identifier }
    }));
  };

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;

    const _withTimeout = (p, ms) =>
      Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

    // Safety net: if backend fetches hang on a degraded platform, force the
    // chooser dialog visible after 10s so the user is never trapped behind an
    // invisible modal (which previously let the 60s boot-reload loop).
    const safetyNet = setTimeout(() => {
      if (!cancelled) { setShowDialog(true); setIsLoading(false); }
    }, 10000);

    const finish = (devices) => {
      if (cancelled) return;
      clearTimeout(safetyNet);
      const sortedDevices = (devices || []).sort((a, b) => {
        if (a.is_primary_tracker && !b.is_primary_tracker) return -1;
        if (!a.is_primary_tracker && b.is_primary_tracker) return 1;
        return 0;
      });
      setExistingDevices(sortedDevices);
      try {
        const { deviceType, os } = getUserAgentInfo();
        setNewDeviceName(`${os} ${deviceType}`);
      } catch (e) {}
      if (!devices || devices.length === 0) {
        setIsCreatingNew(true);
        setIsPrimaryTracker(true);
      } else {
        setIsCreatingNew(false);
      }
      setShowDialog(true);
      setIsLoading(false);
    };

    const checkDevice = async () => {
      try {
        const storedDeviceId = localStorage.getItem(DEVICE_ID_KEY);
        // CRITICAL: Do NOT trust the localStorage `rxdeliver_device_registered_*` flag
        // alone — the backend UserDevice record is the source of truth (the manifest
        // gate in useLayoutInit checks it). A stale local flag that says "registered"
        // while the backend has no matching UserDevice record previously caused the
        // boot to enter a limbo: this early-return called onDeviceRegistered without
        // dispatching the resume event, so init never re-ran and the app sat on the
        // loading spinner forever. Always validate against the backend instead.

        // 1) Validate the stored identifier against the backend (bounded — 8s)
        if (storedDeviceId) {
          let matches = null;
          try {
            matches = await _withTimeout(base44.entities.UserDevice.filter({
              user_id: currentUser.id,
              device_identifier: storedDeviceId
            }), 8000);
          } catch (e) { matches = null; }
          if (cancelled) return;
          if (matches && matches.length > 0 && (matches[0].status === 'active' || !matches[0].status)) {
            localStorage.setItem(`rxdeliver_device_registered_${storedDeviceId}`, 'true');
            await base44.entities.UserDevice.update(matches[0].id, { last_active_at: new Date().toISOString() }).catch(() => {});
            clearTimeout(safetyNet);
            setIsLoading(false);
            if (onDeviceRegistered) onDeviceRegistered(matches[0]);
            return; // Already linked – no dialog needed
          }
        }

        // 3) Fetch the user's registered devices and show the chooser (bounded — 8s)
        let userDevices = [];
        try {
          userDevices = await _withTimeout(base44.entities.UserDevice.filter({ user_id: currentUser.id }), 8000);
        } catch (e) { userDevices = []; }
        if (cancelled) return;
        finish(userDevices);
      } catch (error) {
        console.error('Device check failed:', error);
        finish([]);
      }
    };

    checkDevice();
    return () => { cancelled = true; clearTimeout(safetyNet); };
  }, [currentUser?.id]);

  const handleSelectExistingDevice = async () => {
    if (!selectedDeviceId) return;

    setIsSaving(true);
    try {
      const device = existingDevices.find(d => d.id === selectedDeviceId);
      if (!device) return;

      // Save device identifier to localStorage
      localStorage.setItem(DEVICE_ID_KEY, device.device_identifier);
      localStorage.setItem(`rxdeliver_device_registered_${device.device_identifier}`, 'true');

      // Update last_active_at
      await base44.entities.UserDevice.update(device.id, {
        last_active_at: new Date().toISOString()
      });

      console.log('✅ Device selected:', device);
      completeRegistration(device);
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
      localStorage.setItem(`rxdeliver_device_registered_${deviceIdentifier}`, 'true');

      console.log('✅ Device created:', newDevice);
      completeRegistration(newDevice);
    } catch (error) {
      console.error('Failed to create device:', error);
      alert('Failed to create device. Please try again.');
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
      <DialogContent className="max-w-md" onPointerDownOutside={(e) => e.preventDefault()} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-slate-900)' }}>Device Registration</DialogTitle>
          <DialogDescription style={{ color: 'var(--text-slate-600)' }}>
            {existingDevices.length > 0 
              ? 'Select your device or register a new one'
              : 'Register this device to enable location tracking'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {existingDevices.length > 0 && !isCreatingNew && (
            <>
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-slate-700)' }}>Your Registered Devices</Label>
                <div className="space-y-2">
                  {existingDevices.map((device) => {
                    const displayOS = device.device_info?.os === 'Linux' ? 'Android' : device.device_info?.os;
                    const lastActive = device.last_active_at ? new Date(device.last_active_at).toLocaleString() : 'Never';
                    
                    return (
                      <div
                        key={device.id}
                        className="flex items-center space-x-3 border rounded-lg p-3 cursor-pointer transition-all hover:shadow-md"
                        style={{ 
                          background: 'var(--bg-slate-50)', 
                          borderColor: 'var(--border-slate-300)'
                        }}
                        onClick={async () => {
                          if (isSaving) return;
                          setIsSaving(true);
                          try {
                            localStorage.setItem(DEVICE_ID_KEY, device.device_identifier);
                            localStorage.setItem(`rxdeliver_device_registered_${device.device_identifier}`, 'true');
                            await base44.entities.UserDevice.update(device.id, {
                              last_active_at: new Date().toISOString()
                            });
                            console.log('✅ Device selected:', device);
                            completeRegistration(device);
                          } catch (error) {
                            console.error('Failed to select device:', error);
                            alert('Failed to select device. Please try again.');
                            setIsSaving(false);
                          }
                        }}
                      >
                        <div className="flex items-center gap-2 flex-1">
                          {getDeviceIcon(device.device_info?.device_type)}
                          <div className="flex-1">
                            <div className="font-medium" style={{ color: 'var(--text-slate-900)' }}>{device.device_name}</div>
                            <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                              {displayOS} • {lastActive}
                            </div>
                          </div>
                          {device.is_primary_tracker && (
                            <CheckCircle className="w-4 h-4 text-green-600" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <Button
                variant="outline"
                onClick={() => setIsCreatingNew(true)}
                className="w-full"
                disabled={isSaving}
                style={{ 
                  background: 'var(--bg-white)', 
                  borderColor: 'var(--border-slate-300)',
                  color: 'var(--text-slate-900)'
                }}
              >
                Register New Device
              </Button>
            </>
          )}

          {(isCreatingNew || existingDevices.length === 0) && (
            <>
              <div className="space-y-2">
                <Label htmlFor="deviceName" style={{ color: 'var(--text-slate-700)' }}>Device Name</Label>
                <Input
                  id="deviceName"
                  value={newDeviceName}
                  onChange={(e) => setNewDeviceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newDeviceName.trim() && !isSaving) {
                      e.preventDefault();
                      handleCreateNewDevice();
                    }
                  }}
                  placeholder="e.g., My iPhone 15 Pro"
                  className="placeholder:text-slate-500 dark:text-slate-400 dark:text-slate-500"
                  style={{ 
                    background: 'var(--bg-white)', 
                    borderColor: 'var(--border-slate-300)',
                    color: 'var(--text-slate-900)'
                  }}
                />
              </div>

              {/* Only show primary tracker option for drivers (not dispatchers) */}
              {currentUser?.app_roles?.includes('driver') && (
                <div className="flex items-center space-x-2 p-3 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                  <input
                    type="checkbox"
                    id="isPrimary"
                    checked={isPrimaryTracker}
                    onChange={(e) => setIsPrimaryTracker(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <Label htmlFor="isPrimary" className="text-sm cursor-pointer" style={{ color: 'var(--text-slate-700)' }}>
                    Set as primary tracker
                    <span className="block text-xs mt-1" style={{ color: 'var(--text-slate-500)' }}>
                      Only the primary device updates your location on the map
                    </span>
                  </Label>
                </div>
              )}

              {existingDevices.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setIsCreatingNew(false);
                    setSelectedDeviceId(null);
                  }}
                  className="w-full"
                  style={{ 
                    background: 'var(--bg-white)', 
                    borderColor: 'var(--border-slate-300)',
                    color: 'var(--text-slate-900)'
                  }}
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