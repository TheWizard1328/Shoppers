import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Smartphone, Tablet, Monitor, CheckCircle, Trash2, Edit2,
  Plus, MapPin, ShieldCheck, ChevronLeft
} from 'lucide-react';
import { useUser } from '../components/utils/UserContext';
import DeviceForm from '../components/devices/DeviceForm';
import { toast } from 'sonner';
import { getLocationProvider } from '../components/utils/locationProviders';

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';

export default function DeviceSettings() {
  const navigate = useNavigate();
  const { currentUser } = useUser();
  const [devices, setDevices] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingDevice, setEditingDevice] = useState(null);
  const [currentDeviceId, setCurrentDeviceId] = useState(null);
  const [editingSettings, setEditingSettings] = useState({});
  const [deviceSettings, setDeviceSettings] = useState({});
  const [showChangeSettings, setShowChangeSettings] = useState(false);
  const [isRequestingLocationAccess, setIsRequestingLocationAccess] = useState(false);
  const locationProvider = getLocationProvider();
  const isNativeBackgroundTrackingAvailable = locationProvider?.backgroundCapable === true && locationProvider?.isAvailable();

  useEffect(() => {
    if (!currentUser?.id) return;
    const DEVICES_CACHE_KEY = `rxdeliver_devices_${currentUser.id}`;

    const applyDevices = (userDevices) => {
      if (!userDevices || userDevices.length === 0) return;
      setDevices(userDevices);
      const storedDeviceId = localStorage.getItem(DEVICE_ID_KEY);
      if (storedDeviceId) {
        const currentDevice = userDevices.find(d => d.device_identifier === storedDeviceId);
        if (currentDevice) setCurrentDeviceId(currentDevice.id);
      }
    };

    const loadDevices = async () => {
      try {
        const cached = localStorage.getItem(DEVICES_CACHE_KEY);
        if (cached) {
          const cachedDevices = JSON.parse(cached);
          if (Array.isArray(cachedDevices) && cachedDevices.length > 0) {
            applyDevices(cachedDevices);
            setIsLoading(false);
          }
        }
      } catch {}

      try {
        const userDevices = await base44.entities.UserDevice.filter({ user_id: currentUser.id });
        applyDevices(userDevices || []);
        localStorage.setItem(DEVICES_CACHE_KEY, JSON.stringify(userDevices || []));
      } catch (error) {
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
      setDevices(prev => {
        const updated = prev.filter(d => d.id !== device.id);
        localStorage.setItem(`rxdeliver_devices_${currentUser.id}`, JSON.stringify(updated));
        return updated;
      });
      if (device.id === currentDeviceId) {
        localStorage.removeItem(DEVICE_ID_KEY);
        setCurrentDeviceId(null);
      }
      toast.success('Device deleted');
    } catch {
      toast.error('Failed to delete device');
    }
  };

  const handleSetPrimary = async (device) => {
    try {
      const primaryDevices = devices.filter(d => d.is_primary_tracker && d.id !== device.id);
      await Promise.all(primaryDevices.map(d => base44.entities.UserDevice.update(d.id, { is_primary_tracker: false })));
      await base44.entities.UserDevice.update(device.id, { is_primary_tracker: true, status: 'active' });
      setDevices(prev => prev.map(d => ({
        ...d,
        is_primary_tracker: d.id === device.id,
        status: d.id === device.id ? 'active' : d.status
      })));
      toast.success('Primary tracker updated');
    } catch {
      toast.error('Failed to set primary tracker');
    }
  };

  const handleClearPrimary = async (device) => {
    try {
      await base44.entities.UserDevice.update(device.id, { is_primary_tracker: false });
      setDevices(prev => prev.map(d => d.id === device.id ? { ...d, is_primary_tracker: false } : d));
      toast.success('Primary tracker removed');
    } catch {
      toast.error('Failed to remove primary tracker');
    }
  };

  const handleToggleDeviceStatus = async (device) => {
    const nextStatus = device.status === 'inactive' ? 'active' : 'inactive';
    const updates = { status: nextStatus, ...(nextStatus === 'inactive' ? { is_primary_tracker: false } : {}) };
    try {
      await base44.entities.UserDevice.update(device.id, updates);
      setDevices(prev => prev.map(d => d.id === device.id ? { ...d, ...updates } : d));
      if (device.id === currentDeviceId && nextStatus === 'inactive') {
        localStorage.removeItem(DEVICE_ID_KEY);
        setCurrentDeviceId(null);
      }
      toast.success(nextStatus === 'active' ? 'Device enabled' : 'Device disabled');
    } catch {
      toast.error('Failed to update device status');
    }
  };

  const handleApplySettings = async (device) => {
    try {
      const pendingUpdates = deviceSettings[device.id] || {};
      if (Object.keys(pendingUpdates).length === 0) { toast.info('No changes to save'); return; }
      const updates = { ...pendingUpdates, ...(pendingUpdates.status === 'inactive' ? { is_primary_tracker: false } : {}) };
      await base44.entities.UserDevice.update(device.id, updates);
      setDevices(prev => prev.map(d => d.id === device.id ? { ...d, ...updates } : d));
      if (device.id === currentDeviceId && updates.status === 'inactive') {
        localStorage.removeItem(DEVICE_ID_KEY);
        setCurrentDeviceId(null);
      }
      setEditingSettings(prev => ({ ...prev, [device.id]: false }));
      setDeviceSettings(prev => ({ ...prev, [device.id]: {} }));
      toast.success('Device settings saved');
    } catch {
      toast.error('Failed to save device settings');
    }
  };

  const handleSettingChange = (deviceId, field, value) => {
    setDeviceSettings(prev => ({ ...prev, [deviceId]: { ...prev[deviceId], [field]: value } }));
  };

  const handleApplyDeviceSettings = async (sourceDevice) => {
    try {
      const currentDevice = devices.find(d => d.id === currentDeviceId);
      if (!currentDevice) { toast.error('Current device not found'); return; }
      const updates = {
        device_identifier: currentDevice.device_identifier,
        device_name: currentDevice.device_name,
        device_type: sourceDevice.device_info?.device_type,
        device_info: sourceDevice.device_info
      };
      await base44.entities.UserDevice.update(currentDeviceId, updates);
      setDevices(prev => prev.map(d => d.id === currentDeviceId ? { ...d, ...updates } : d));
      setShowChangeSettings(false);
      toast.success(`Applied settings from ${sourceDevice.device_name}`);
    } catch {
      toast.error('Failed to apply device settings');
    }
  };

  const handleSwitchToDeviceProfile = async (device) => {
    try {
      localStorage.setItem(DEVICE_ID_KEY, device.device_identifier);
      localStorage.setItem(`rxdeliver_device_registered_${device.device_identifier}`, 'true');
      await base44.entities.UserDevice.update(device.id, { last_active_at: new Date().toISOString() });
      setCurrentDeviceId(device.id);
      toast.success(`Now using ${device.device_name} on this device`);
      window.location.reload();
    } catch {
      toast.error('Failed to switch device profile');
    }
  };

  const handleFormSubmit = async (deviceData, deviceId) => {
    try {
      if (deviceId) {
        await base44.entities.UserDevice.update(deviceId, deviceData);
        setDevices(prev => prev.map(d => d.id === deviceId ? { ...d, ...deviceData } : d));
        toast.success('Device updated');
      } else {
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
    } catch {
      toast.error('Failed to save device');
    }
  };

  const handleRequestBackgroundLocationAccess = async () => {
    if (!isNativeBackgroundTrackingAvailable || isRequestingLocationAccess) return;
    setIsRequestingLocationAccess(true);
    try {
      await locationProvider.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0, requestPermissions: true });
      toast.success('Location access requested. If prompted, choose Allow all the time / Always Allow.');
    } catch (error) {
      toast.error(error?.message || 'Location permission request was not completed');
    } finally {
      setIsRequestingLocationAccess(false);
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
      <div className="h-full overflow-y-auto pb-20" style={{ background: 'var(--bg-slate-50)' }}>
        <div className="max-w-2xl mx-auto p-4">
          <div className="animate-pulse space-y-4">
            <div className="h-6 bg-slate-200 rounded w-1/3" />
            <div className="h-32 bg-slate-200 rounded" />
          </div>
        </div>
      </div>
    );
  }

  const sortedDevices = [...devices].sort((a, b) => {
    if (a.id === currentDeviceId) return -1;
    if (b.id === currentDeviceId) return 1;
    if (a.is_primary_tracker && !b.is_primary_tracker) return -1;
    if (!a.is_primary_tracker && b.is_primary_tracker) return 1;
    const timeA = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
    const timeB = b.last_active_at ? new Date(b.last_active_at).getTime() : 0;
    return timeB - timeA;
  });

  return (
    <div className="h-full overflow-y-auto pb-20" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-2xl mx-auto p-4 space-y-4">

        {/* Back + inline header */}
        <div>
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-3"
          >
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Devices</h1>
              <p className="text-sm mt-0.5" style={{ color: 'var(--text-slate-500)' }}>
                Manage your registered devices and location tracking.
              </p>
            </div>
            <Button size="sm" className="gap-2" onClick={() => { setEditingDevice(null); setShowForm(true); }}>
              <Plus className="w-4 h-4" /> Add Device
            </Button>
          </div>
        </div>

        {/* Background GPS setup */}
        {isNativeBackgroundTrackingAvailable && (
          <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
                <ShieldCheck className="w-4 h-4" /> Background GPS Setup
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
                <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                  This device supports native background location tracking.
                </p>
                <p className="text-sm mt-1" style={{ color: 'var(--text-slate-500)' }}>
                  Tap below, then allow full background access when your phone asks.
                </p>
              </div>
              <Button onClick={handleRequestBackgroundLocationAccess} disabled={isRequestingLocationAccess} className="gap-2" size="sm">
                <MapPin className="w-4 h-4" />
                {isRequestingLocationAccess ? 'Requesting Access...' : 'Request Background GPS Access'}
              </Button>
              <ul className="text-sm space-y-1 list-disc pl-5" style={{ color: 'var(--text-slate-500)' }}>
                <li>Android: choose "Allow all the time".</li>
                <li>iPhone: choose "Always Allow" and keep Precise Location on.</li>
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Add/Edit Device Form */}
        {showForm && (
          <DeviceForm
            device={editingDevice}
            existingDevices={devices}
            onSubmit={handleFormSubmit}
            onCancel={() => { setShowForm(false); setEditingDevice(null); }}
          />
        )}

        {/* Device cards */}
        {sortedDevices.map((device) => {
          const displayOS = device.device_info?.os === 'Linux' ? 'Android' : device.device_info?.os;
          const lastActive = device.last_active_at ? new Date(device.last_active_at).toLocaleString() : 'Never';
          const isCurrentDevice = device.id === currentDeviceId;

          return (
            <Card key={device.id} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    {getDeviceIcon(device.device_info?.device_type)}
                    <div>
                      <CardTitle className="text-base" style={{ color: 'var(--text-slate-900)' }}>
                        {device.device_name}
                        {isCurrentDevice && <Badge className="ml-2 bg-blue-500 text-white text-xs">Current</Badge>}
                      </CardTitle>
                      <span className="text-sm" style={{ color: 'var(--text-slate-500)' }}>
                        {displayOS} · {lastActive}
                      </span>
                    </div>
                  </div>
                  {device.is_primary_tracker && (
                    <Badge className="bg-green-100 text-green-800 gap-1 text-xs">
                      <CheckCircle className="w-3 h-3" /> Primary
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Status row */}
                {editingSettings[device.id] ? (
                  <div className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                    <label className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Device Status</label>
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
                  <div className="text-sm px-3 py-2 rounded-lg" style={{ background: 'var(--bg-slate-50)', color: 'var(--text-slate-700)' }}>
                    Status: <span className="font-semibold">{device.status === 'active' ? 'Active' : 'Inactive'}</span>
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-2 flex-wrap">
                  {editingSettings[device.id] ? (
                    <>
                      <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 gap-1" onClick={() => handleApplySettings(device)}>
                        <CheckCircle className="w-3 h-3" /> Apply
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => {
                        setEditingSettings(prev => ({ ...prev, [device.id]: false }));
                        setDeviceSettings(prev => ({ ...prev, [device.id]: {} }));
                      }}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="outline" size="sm" className="gap-1"
                        onClick={() => setEditingSettings(prev => ({ ...prev, [device.id]: true }))}>
                        <Edit2 className="w-3 h-3" /> Edit
                      </Button>
                      {!isCurrentDevice && device.status !== 'inactive' && (
                        <Button variant="outline" size="sm" className="gap-1" onClick={() => handleSwitchToDeviceProfile(device)}>
                          <CheckCircle className="w-3 h-3" /> Use Here
                        </Button>
                      )}
                      {isCurrentDevice && devices.length > 1 && (
                        <Button variant="outline" size="sm" className="gap-1" onClick={() => setShowChangeSettings(true)}>
                          <Edit2 className="w-3 h-3" /> Copy From...
                        </Button>
                      )}
                      {device.is_primary_tracker ? (
                        <Button variant="outline" size="sm" className="gap-1" onClick={() => handleClearPrimary(device)}>
                          <CheckCircle className="w-3 h-3" /> Remove Primary
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" className="gap-1" onClick={() => handleSetPrimary(device)}>
                          <CheckCircle className="w-3 h-3" /> Set Primary
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => handleToggleDeviceStatus(device)}>
                        {device.status === 'inactive' ? 'Enable' : 'Disable'}
                      </Button>
                      <Button variant="destructive" size="sm" className="gap-1 ml-auto"
                        onClick={() => handleDeleteDevice(device)} disabled={devices.length === 1}>
                        <Trash2 className="w-3 h-3" /> Delete
                      </Button>
                    </>
                  )}
                </div>

                {/* Copy-from picker */}
                {isCurrentDevice && showChangeSettings && (
                  <div className="p-3 rounded-lg border" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                    <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-slate-900)' }}>
                      Apply settings from another device:
                    </p>
                    <div className="space-y-2">
                      {devices.filter(d => d.id !== currentDeviceId).map(d => (
                        <div key={d.id} className="flex items-center justify-between p-2 rounded border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                          <div>
                            <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{d.device_name}</p>
                            <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{d.device_info?.device_type || 'Unknown'}</p>
                          </div>
                          <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => handleApplyDeviceSettings(d)}>
                            Apply
                          </Button>
                        </div>
                      ))}
                    </div>
                    <Button variant="outline" size="sm" className="w-full mt-2" onClick={() => setShowChangeSettings(false)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}

        {/* Empty state */}
        {devices.length === 0 && (
          <div className="text-center py-12 border-2 border-dashed rounded-lg" style={{ borderColor: 'var(--border-slate-300)' }}>
            <Smartphone className="w-12 h-12 mx-auto mb-3" style={{ color: 'var(--text-slate-400)' }} />
            <p className="font-medium mb-2" style={{ color: 'var(--text-slate-900)' }}>No devices registered</p>
            <p className="text-sm mb-4" style={{ color: 'var(--text-slate-500)' }}>Add your first device to enable location tracking</p>
            <Button onClick={() => setShowForm(true)}>Add Device</Button>
          </div>
        )}

      </div>
    </div>
  );
}