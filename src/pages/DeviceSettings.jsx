import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Smartphone, Tablet, Monitor, CheckCircle, Trash2, Edit2, Plus, AlertCircle } from 'lucide-react';
import { useUser } from '../components/utils/UserContext';
import DeviceForm from '../components/devices/DeviceForm';
import { toast } from 'sonner';

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';

export default function DeviceSettings() {
   const { currentUser } = useUser();
   const [devices, setDevices] = useState([]);
   const [isLoading, setIsLoading] = useState(true);
   const [showForm, setShowForm] = useState(false);
   const [editingDevice, setEditingDevice] = useState(null);
   const [currentDeviceId, setCurrentDeviceId] = useState(null);
   const [editingSettings, setEditingSettings] = useState({}); // Track editing mode per device ID
   const [deviceSettings, setDeviceSettings] = useState({}); // Temporary settings before apply
   const [showChangeSettings, setShowChangeSettings] = useState(false);
   const [selectedSourceDevice, setSelectedSourceDevice] = useState(null);
   const [showDeleteAccountDialog, setShowDeleteAccountDialog] = useState(false);

  useEffect(() => {
    if (!currentUser?.id) return;

    const loadDevices = async () => {
      try {
        const userDevices = await base44.entities.UserDevice.filter({ 
          user_id: currentUser.id 
        });
        setDevices(userDevices || []);

        // Get current device ID from localStorage
        const storedDeviceId = localStorage.getItem(DEVICE_ID_KEY);
        if (storedDeviceId) {
          const currentDevice = userDevices.find(d => d.device_identifier === storedDeviceId);
          if (currentDevice) {
            setCurrentDeviceId(currentDevice.id);
          }
        }
      } catch (error) {
        console.error('Failed to load devices:', error);
        toast.error('Failed to load devices');
      } finally {
        setIsLoading(false);
      }
    };

    loadDevices();
  }, [currentUser]);

  const handleDeleteDevice = async (device) => {
    if (!confirm(`Delete device "${device.device_name}"?`)) return;

    try {
      await base44.entities.UserDevice.delete(device.id);
      setDevices(prev => prev.filter(d => d.id !== device.id));
      
      // If deleting current device, clear localStorage
      if (device.id === currentDeviceId) {
        localStorage.removeItem(DEVICE_ID_KEY);
        setCurrentDeviceId(null);
      }

      toast.success('Device deleted');
    } catch (error) {
      console.error('Failed to delete device:', error);
      toast.error('Failed to delete device');
    }
  };

  const handleSetPrimary = async (device) => {
    try {
      // Unset all other primary devices
      const primaryDevices = devices.filter(d => d.is_primary_tracker && d.id !== device.id);
      await Promise.all(
        primaryDevices.map(d => 
          base44.entities.UserDevice.update(d.id, { is_primary_tracker: false })
        )
      );

      // Set this device as primary
      await base44.entities.UserDevice.update(device.id, {
        is_primary_tracker: true
      });

      // Update local state
      setDevices(prev => prev.map(d => ({
        ...d,
        is_primary_tracker: d.id === device.id
      })));

      toast.success('Primary tracker updated');
    } catch (error) {
      console.error('Failed to set primary:', error);
      toast.error('Failed to set primary tracker');
    }
  };

  const handleApplySettings = async (device) => {
    try {
      const updates = deviceSettings[device.id] || {};
      if (Object.keys(updates).length === 0) {
        toast.info('No changes to save');
        return;
      }

      await base44.entities.UserDevice.update(device.id, updates);
      setDevices(prev => prev.map(d => 
        d.id === device.id ? { ...d, ...updates } : d
      ));
      
      setEditingSettings(prev => ({ ...prev, [device.id]: false }));
      setDeviceSettings(prev => ({ ...prev, [device.id]: {} }));
      toast.success('Device settings saved');
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save device settings');
    }
  };

  const handleSettingChange = (deviceId, field, value) => {
    setDeviceSettings(prev => ({
      ...prev,
      [deviceId]: { ...prev[deviceId], [field]: value }
    }));
  };

  const handleApplyDeviceSettings = async (sourceDevice) => {
    try {
      const currentDevice = devices.find(d => d.id === currentDeviceId);
      if (!currentDevice) {
        toast.error('Current device not found');
        return;
      }

      // Copy settings from source device to current device
      const updates = {
        device_identifier: currentDevice.device_identifier,
        device_name: currentDevice.device_name,
        device_type: sourceDevice.device_info?.device_type,
        device_info: sourceDevice.device_info
      };

      await base44.entities.UserDevice.update(currentDeviceId, updates);
      setDevices(prev => prev.map(d => 
        d.id === currentDeviceId ? { ...d, ...updates } : d
      ));
      
      setShowChangeSettings(false);
      setSelectedSourceDevice(null);
      toast.success(`Applied settings from ${sourceDevice.device_name}`);
    } catch (error) {
      console.error('Failed to apply settings:', error);
      toast.error('Failed to apply device settings');
    }
  };

  const handleFormSubmit = async (deviceData, deviceId) => {
    try {
      if (deviceId) {
        // Update existing device
        await base44.entities.UserDevice.update(deviceId, deviceData);
        setDevices(prev => prev.map(d => 
          d.id === deviceId ? { ...d, ...deviceData } : d
        ));
        toast.success('Device updated');
      } else {
        // Create new device
        const newDevice = await base44.entities.UserDevice.create({
          ...deviceData,
          user_id: currentUser.id,
          device_identifier: crypto.randomUUID(),
          last_active_at: new Date().toISOString(),
          status: 'active'
        });
        setDevices(prev => [...prev, newDevice]);
        toast.success('Device created');
      }
      setShowForm(false);
      setEditingDevice(null);
    } catch (error) {
      console.error('Failed to save device:', error);
      toast.error('Failed to save device');
    }
  };

  const getDeviceIcon = (deviceType) => {
    switch (deviceType) {
      case 'Mobile': return <Smartphone className="w-5 h-5" />;
      case 'Tablet': return <Tablet className="w-5 h-5" />;
      case 'Desktop': return <Monitor className="w-5 h-5" />;
      default: return <Smartphone className="w-5 h-5" />;
    }
  };

  const handleDeleteAccount = async () => {
    try {
      await base44.integrations.Core.SendEmail({
        to: 'admin@rxdeliver.com',
        subject: `Account Deletion Request - ${currentUser?.full_name || currentUser?.user_name}`,
        body: `User ${currentUser?.full_name || currentUser?.user_name} (${currentUser?.email || currentUser?.id}) has requested account deletion.\n\nUser ID: ${currentUser?.id}\nRequested at: ${new Date().toISOString()}\n\nPlease review and process this request.`
      });
      toast.success('Deletion request sent. An administrator will contact you.');
      setTimeout(() => base44.auth.logout(), 2000);
    } catch (error) {
      toast.error('Failed to send request. Please try again.');
    }
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 rounded w-1/3"></div>
          <div className="h-32 bg-slate-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="sticky top-0 bg-white z-10 p-6 border-b" style={{ borderColor: 'var(--border-slate-200)' }}>
        <div className="flex justify-between items-center max-w-4xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Device Settings</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-slate-500)' }}>
            Manage your registered devices and location tracking
          </p>
        </div>
        <Button
          onClick={() => {
            setEditingDevice(null);
            setShowForm(true);
          }}
          className="gap-2"
        >
          <Plus className="w-4 h-4" />
          Add Device
        </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-4xl mx-auto">
          {showForm && (
            <DeviceForm
          device={editingDevice}
          existingDevices={devices}
          onSubmit={handleFormSubmit}
          onCancel={() => {
            setShowForm(false);
            setEditingDevice(null);
          }}
        />
      )}

      <div className="grid gap-4">
         {devices
           .sort((a, b) => {
             // Current device first
             if (a.id === currentDeviceId && b.id !== currentDeviceId) return -1;
             if (a.id !== currentDeviceId && b.id === currentDeviceId) return 1;

             // Primary device second
             if (a.is_primary_tracker && !b.is_primary_tracker) return -1;
             if (!a.is_primary_tracker && b.is_primary_tracker) return 1;

             // Rest by last active (most recent first)
             const timeA = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
             const timeB = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
             return timeB - timeA;
           })
           .map((device) => {
          const displayOS = device.device_info?.os === 'Linux' ? 'Android' : device.device_info?.os;
          const lastActive = device.last_active_at 
            ? new Date(device.last_active_at).toLocaleString() 
            : 'Never';
          const isCurrentDevice = device.id === currentDeviceId;

          return (
            <Card key={device.id} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    {getDeviceIcon(device.device_info?.device_type)}
                    <div>
                      <CardTitle className="text-lg" style={{ color: 'var(--text-slate-900)' }}>
                        {device.device_name}
                        {isCurrentDevice && (
                          <Badge className="ml-2 bg-blue-500 text-white">Current</Badge>
                        )}
                      </CardTitle>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-sm" style={{ color: 'var(--text-slate-500)' }}>
                          {displayOS} • {lastActive}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {device.is_primary_tracker && (
                      <Badge className="bg-green-100 text-green-800 gap-1">
                        <CheckCircle className="w-3 h-3" />
                        Primary
                      </Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {/* Status Toggle */}
                  {editingSettings[device.id] ? (
                    <div className="flex items-center justify-between p-3 rounded" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <label className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                        Device Status
                      </label>
                      <select
                        value={deviceSettings[device.id]?.status ?? device.status}
                        onChange={(e) => handleSettingChange(device.id, 'status', e.target.value)}
                        className="px-3 py-1 rounded text-sm border"
                        style={{ borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)', background: 'var(--bg-white)' }}
                      >
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    </div>
                  ) : (
                    <div className="text-sm p-3 rounded" style={{ background: 'var(--bg-slate-50)', color: 'var(--text-slate-700)' }}>
                      Status: <span className="font-semibold">{device.status === 'active' ? 'Active' : 'Inactive'}</span>
                    </div>
                  )}

                  {/* Buttons */}
                  <div className="flex gap-2 flex-wrap">
                    {editingSettings[device.id] ? (
                      <>
                        <Button
                          size="sm"
                          className="bg-emerald-600 hover:bg-emerald-700 gap-2"
                          onClick={() => handleApplySettings(device)}
                        >
                          <CheckCircle className="w-4 h-4" />
                          Apply
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditingSettings(prev => ({ ...prev, [device.id]: false }));
                            setDeviceSettings(prev => ({ ...prev, [device.id]: {} }));
                          }}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditingSettings(prev => ({ ...prev, [device.id]: true }))}
                          className="gap-2"
                        >
                          <Edit2 className="w-4 h-4" />
                          Edit Settings
                        </Button>

                        {isCurrentDevice && devices.length > 1 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setShowChangeSettings(true)}
                            className="gap-2"
                          >
                            <Edit2 className="w-4 h-4" />
                            Change Settings From...
                          </Button>
                        )}

                        {!device.is_primary_tracker && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleSetPrimary(device)}
                            className="gap-2"
                          >
                            <CheckCircle className="w-4 h-4" />
                            Set as Primary
                          </Button>
                        )}

                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDeleteDevice(device)}
                          className="gap-2 ml-auto"
                          disabled={devices.length === 1}
                        >
                          <Trash2 className="w-4 h-4" />
                          Delete
                        </Button>
                      </>
                    )}
                  </div>

                  {/* Change Settings Modal */}
                  {isCurrentDevice && showChangeSettings && (
                    <div className="mt-4 p-3 rounded border-2" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                      <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-slate-900)' }}>
                        Apply settings from another device:
                      </p>
                      <div className="space-y-2">
                        {devices.filter(d => d.id !== currentDeviceId).map(d => (
                          <div key={d.id} className="flex items-center justify-between p-2 rounded border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                            <div>
                              <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{d.device_name}</p>
                              <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{d.device_info?.device_type || 'Unknown'}</p>
                            </div>
                            <Button
                              size="sm"
                              className="bg-blue-600 hover:bg-blue-700"
                              onClick={() => handleApplyDeviceSettings(d)}
                            >
                              Apply
                            </Button>
                          </div>
                        ))}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full mt-2"
                        onClick={() => setShowChangeSettings(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}

        {devices.length === 0 && (
          <div className="text-center py-12 border-2 border-dashed rounded-lg" style={{ borderColor: 'var(--border-slate-300)' }}>
            <Smartphone className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--text-slate-400)' }} />
            <p className="font-medium mb-2" style={{ color: 'var(--text-slate-900)' }}>No devices registered</p>
            <p className="text-sm mb-4" style={{ color: 'var(--text-slate-500)' }}>
              Add your first device to enable location tracking
            </p>
            <Button onClick={() => setShowForm(true)}>
              Add Device
            </Button>
          </div>
        )}
        </div>

        {/* Delete Account Section */}
        <div className="mt-12 pt-8 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
        <Card className="border-red-200" style={{ background: 'var(--bg-red-50)', borderColor: 'var(--border-red-200)' }}>
          <CardHeader>
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-red-600" />
              <div>
                <CardTitle style={{ color: 'var(--text-red-900)' }}>Delete Account</CardTitle>
                <p className="text-sm mt-1" style={{ color: 'var(--text-red-700)' }}>
                  Permanently delete your account and all associated data
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm mb-4" style={{ color: 'var(--text-red-800)' }}>
              This action is irreversible. An administrator will review your request and permanently delete your account.
            </p>
            <Button
              className="bg-red-600 hover:bg-red-700"
              onClick={() => setShowDeleteAccountDialog(true)}
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Request Account Deletion
            </Button>
          </CardContent>
        </Card>
        </div>
        </div>
        </div>

        {/* Delete Account Confirmation Dialog */}
        {showDeleteAccountDialog && (
          <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] p-4"
          onClick={() => setShowDeleteAccountDialog(false)}
        >
          <Card
            className="w-full max-w-md border-red-300"
            style={{ background: 'var(--bg-white)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <CardHeader>
              <CardTitle style={{ color: 'var(--text-red-900)' }} className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5" />
                Confirm Account Deletion
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p style={{ color: 'var(--text-slate-700)' }}>
                Are you sure you want to request account deletion? This action cannot be undone. An administrator will review and process your request.
              </p>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setShowDeleteAccountDialog(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1 bg-red-600 hover:bg-red-700"
                  onClick={() => {
                    handleDeleteAccount();
                    setShowDeleteAccountDialog(false);
                  }}
                >
                  Delete Account
                </Button>
              </div>
            </CardContent>
          </Card>
          </div>
          )}
          </div>
          );
        }