import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Smartphone, Tablet, Monitor, CheckCircle, Trash2, Edit2, Plus } from 'lucide-react';
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
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex justify-between items-center mb-6">
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
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingDevice(device);
                      setShowForm(true);
                    }}
                    className="gap-2"
                  >
                    <Edit2 className="w-4 h-4" />
                    Edit
                  </Button>
                  
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
                </div>

                {device.status === 'inactive' && (
                  <div className="mt-3 text-sm p-2 rounded" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-600)' }}>
                    This device is inactive and won't track location
                  </div>
                )}
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
    </div>
  );
}