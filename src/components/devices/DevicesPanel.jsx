/**
 * DevicesPanel — shared device management UI.
 * Used by both pages/DeviceSettings (fullscreen) and pages/Settings (dialog).
 */
import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Smartphone, Tablet, Monitor, CheckCircle, Trash2, Edit2,
  Plus, MapPin, ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { getLocationProvider } from '@/components/utils/locationProviders';
import DeviceForm from '@/components/devices/DeviceForm';
// InkbirdBleLog moved to Admin Utilities - BLE Diag tab

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';

export default function DevicesPanel({ currentUser }) {
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
  const isNativeBackgroundTrackingAvailable =
    locationProvider?.backgroundCapable === true && locationProvider?.isAvailable();

  useEffect(() => {
    if (!currentUser?.id) return;
    const DEVICES_CACHE_KEY = `rxdeliver_devices_${currentUser.id}`;

    const applyDevices = (userDevices) => {
      if (!userDevices?.length) return;
      setDevices(userDevices);
      const storedId = localStorage.getItem(DEVICE_ID_KEY);
      if (storedId) {
        const cur = userDevices.find((d) => d.device_identifier === storedId);
        if (cur) setCurrentDeviceId(cur.id);
      }
    };

    const load = async () => {
      try {
        const cached = localStorage.getItem(DEVICES_CACHE_KEY);
        if (cached) {
          const c = JSON.parse(cached);
          if (Array.isArray(c) && c.length) { applyDevices(c); setIsLoading(false); }
        }
      } catch {}
      try {
        const list = await base44.entities.UserDevice.filter({ user_id: currentUser.id });
        applyDevices(list || []);
        localStorage.setItem(DEVICES_CACHE_KEY, JSON.stringify(list || []));
      } catch { toast.error('Failed to load devices'); } finally { setIsLoading(false); }
    };
    load();
  }, [currentUser]);

  const handleDeleteDevice = async (device) => {
    if (!confirm(`Delete "${device.device_name}"?`)) return;
    try {
      await base44.entities.UserDevice.delete(device.id);
      setDevices((prev) => {
        const u = prev.filter((d) => d.id !== device.id);
        localStorage.setItem(`rxdeliver_devices_${currentUser.id}`, JSON.stringify(u));
        return u;
      });
      if (device.id === currentDeviceId) { localStorage.removeItem(DEVICE_ID_KEY); setCurrentDeviceId(null); }
      toast.success('Device deleted');
    } catch { toast.error('Failed to delete device'); }
  };

  const handleSetPrimary = async (device) => {
    try {
      await Promise.all(
        devices.filter((d) => d.is_primary_tracker && d.id !== device.id)
          .map((d) => base44.entities.UserDevice.update(d.id, { is_primary_tracker: false }))
      );
      await base44.entities.UserDevice.update(device.id, { is_primary_tracker: true, status: 'active' });
      setDevices((prev) => prev.map((d) => ({
        ...d,
        is_primary_tracker: d.id === device.id,
        status: d.id === device.id ? 'active' : d.status,
      })));
      toast.success('Primary tracker updated');
    } catch { toast.error('Failed to set primary tracker'); }
  };

  const handleClearPrimary = async (device) => {
    try {
      await base44.entities.UserDevice.update(device.id, { is_primary_tracker: false });
      setDevices((prev) => prev.map((d) => d.id === device.id ? { ...d, is_primary_tracker: false } : d));
      toast.success('Primary tracker removed');
    } catch { toast.error('Failed to remove primary tracker'); }
  };

  const handleToggleDeviceStatus = async (device) => {
    const nextStatus = device.status === 'inactive' ? 'active' : 'inactive';
    const updates = { status: nextStatus, ...(nextStatus === 'inactive' ? { is_primary_tracker: false } : {}) };
    try {
      await base44.entities.UserDevice.update(device.id, updates);
      setDevices((prev) => prev.map((d) => d.id === device.id ? { ...d, ...updates } : d));
      if (device.id === currentDeviceId && nextStatus === 'inactive') {
        localStorage.removeItem(DEVICE_ID_KEY); setCurrentDeviceId(null);
      }
      toast.success(nextStatus === 'active' ? 'Device enabled' : 'Device disabled');
    } catch { toast.error('Failed to update device status'); }
  };

  const handleApplySettings = async (device) => {
    try {
      const pending = deviceSettings[device.id] || {};
      if (!Object.keys(pending).length) { toast.info('No changes to save'); return; }
      const updates = { ...pending, ...(pending.status === 'inactive' ? { is_primary_tracker: false } : {}) };
      await base44.entities.UserDevice.update(device.id, updates);
      setDevices((prev) => prev.map((d) => d.id === device.id ? { ...d, ...updates } : d));
      if (device.id === currentDeviceId && updates.status === 'inactive') {
        localStorage.removeItem(DEVICE_ID_KEY); setCurrentDeviceId(null);
      }
      setEditingSettings((p) => ({ ...p, [device.id]: false }));
      setDeviceSettings((p) => ({ ...p, [device.id]: {} }));
      toast.success('Device settings saved');
    } catch { toast.error('Failed to save device settings'); }
  };

  const handleApplyDeviceSettings = async (sourceDevice) => {
    try {
      const cur = devices.find((d) => d.id === currentDeviceId);
      if (!cur) { toast.error('Current device not found'); return; }
      const updates = {
        device_identifier: cur.device_identifier,
        device_name: cur.device_name,
        device_type: sourceDevice.device_info?.device_type,
        device_info: sourceDevice.device_info,
      };
      await base44.entities.UserDevice.update(currentDeviceId, updates);
      setDevices((prev) => prev.map((d) => d.id === currentDeviceId ? { ...d, ...updates } : d));
      setShowChangeSettings(false);
      toast.success(`Applied settings from ${sourceDevice.device_name}`);
    } catch { toast.error('Failed to apply device settings'); }
  };

  const handleSwitchToDeviceProfile = async (device) => {
    try {
      localStorage.setItem(DEVICE_ID_KEY, device.device_identifier);
      localStorage.setItem(`rxdeliver_device_registered_${device.device_identifier}`, 'true');
      await base44.entities.UserDevice.update(device.id, { last_active_at: new Date().toISOString() });
      setCurrentDeviceId(device.id);
      toast.success(`Now using ${device.device_name}`);
      window.location.reload();
    } catch { toast.error('Failed to switch device profile'); }
  };

  const handleFormSubmit = async (deviceData, deviceId) => {
    try {
      if (deviceId) {
        await base44.entities.UserDevice.update(deviceId, deviceData);
        setDevices((prev) => prev.map((d) => d.id === deviceId ? { ...d, ...deviceData } : d));
        toast.success('Device updated');
      } else {
        const newDevice = await base44.entities.UserDevice.create({
          ...deviceData,
          user_id: currentUser.id,
          device_identifier: crypto.randomUUID(),
          last_active_at: new Date().toISOString(),
          status: 'active',
        });
        setDevices((prev) => [...prev, newDevice]);
        toast.success('Device created');
      }
      setShowForm(false); setEditingDevice(null);
    } catch { toast.error('Failed to save device'); }
  };

  const handleRequestLocationAccess = async () => {
    if (!isNativeBackgroundTrackingAvailable || isRequestingLocationAccess) return;
    setIsRequestingLocationAccess(true);
    try {
      await locationProvider.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0, requestPermissions: true });
      toast.success('Location access requested. Choose "Allow all the time / Always Allow".');
    } catch (error) {
      toast.error(error?.message || 'Location permission request was not completed');
    } finally { setIsRequestingLocationAccess(false); }
  };

  const getDeviceIcon = (type) => {
    if (type === 'Tablet') return <Tablet className="w-5 h-5" />;
    if (type === 'Desktop') return <Monitor className="w-5 h-5" />;
    return <Smartphone className="w-5 h-5" />;
  };

  const sortedDevices = [...devices].sort((a, b) => {
    if (a.id === currentDeviceId) return -1;
    if (b.id === currentDeviceId) return 1;
    if (a.is_primary_tracker && !b.is_primary_tracker) return -1;
    if (!a.is_primary_tracker && b.is_primary_tracker) return 1;
    return new Date(b.last_active_at || 0) - new Date(a.last_active_at || 0);
  });

  if (isLoading) return (
    <div className="animate-pulse space-y-3 p-1">
      <div className="h-20 bg-slate-100 rounded-xl" />
      <div className="h-20 bg-slate-100 rounded-xl" />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Add Device button */}
      <Button size="sm" className="gap-2 w-full" onClick={() => { setEditingDevice(null); setShowForm(true); }}>
        <Plus className="w-4 h-4" /> Add Device
      </Button>

      {/* Background GPS */}
      {isNativeBackgroundTrackingAvailable && (
        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
              <ShieldCheck className="w-4 h-4" /> Background GPS Setup
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>
              Tap below, then allow full background access when prompted.
            </p>
            <Button size="sm" className="gap-2" onClick={handleRequestLocationAccess} disabled={isRequestingLocationAccess}>
              <MapPin className="w-4 h-4" />
              {isRequestingLocationAccess ? 'Requesting...' : 'Request Background GPS Access'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Device Form */}
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
        const isCurrent = device.id === currentDeviceId;

        return (
          <Card key={device.id} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  {getDeviceIcon(device.device_info?.device_type)}
                  <div>
                    <p className="text-base font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                      {device.device_name}
                      {isCurrent && <Badge className="ml-2 bg-blue-500 text-white text-xs">Current</Badge>}
                    </p>
                    <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>{displayOS} · {lastActive}</p>
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
              {editingSettings[device.id] ? (
                <div className="flex items-center justify-between p-2 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                  <label className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Status</label>
                  <select
                    value={deviceSettings[device.id]?.status ?? device.status}
                    onChange={(e) => setDeviceSettings((p) => ({ ...p, [device.id]: { ...p[device.id], status: e.target.value } }))}
                    className="px-2 py-1 rounded text-sm border"
                    style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              ) : (
                <div className="text-sm px-2 py-1.5 rounded-lg" style={{ background: 'var(--bg-slate-50)', color: 'var(--text-slate-600)' }}>
                  Status: <span className="font-semibold">{device.status === 'active' ? 'Active' : 'Inactive'}</span>
                </div>
              )}

              <div className="flex gap-1.5 flex-wrap">
                {editingSettings[device.id] ? (
                  <>
                    <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 gap-1" onClick={() => handleApplySettings(device)}>
                      <CheckCircle className="w-3 h-3" /> Apply
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => {
                      setEditingSettings((p) => ({ ...p, [device.id]: false }));
                      setDeviceSettings((p) => ({ ...p, [device.id]: {} }));
                    }}>Cancel</Button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" size="sm" className="gap-1" onClick={() => setEditingSettings((p) => ({ ...p, [device.id]: true }))}>
                      <Edit2 className="w-3 h-3" /> Edit
                    </Button>
                    {!isCurrent && device.status !== 'inactive' && (
                      <Button variant="outline" size="sm" className="gap-1" onClick={() => handleSwitchToDeviceProfile(device)}>
                        <CheckCircle className="w-3 h-3" /> Use Here
                      </Button>
                    )}
                    {isCurrent && devices.length > 1 && (
                      <Button variant="outline" size="sm" className="gap-1" onClick={() => setShowChangeSettings(true)}>
                        <Edit2 className="w-3 h-3" /> Copy From...
                      </Button>
                    )}
                    {device.is_primary_tracker ? (
                      <Button variant="outline" size="sm" className="gap-1" onClick={() => handleClearPrimary(device)}>
                        Remove Primary
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" className="gap-1" onClick={() => handleSetPrimary(device)}>
                        Set Primary
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => handleToggleDeviceStatus(device)}>
                      {device.status === 'inactive' ? 'Enable' : 'Disable'}
                    </Button>
                    <Button variant="destructive" size="sm" className="gap-1 ml-auto" onClick={() => handleDeleteDevice(device)} disabled={devices.length === 1}>
                      <Trash2 className="w-3 h-3" /> Delete
                    </Button>
                  </>
                )}
              </div>

              {isCurrent && showChangeSettings && (
                <div className="rounded-lg border p-3 space-y-2" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>Apply settings from:</p>
                  {devices.filter((d) => d.id !== currentDeviceId).map((d) => (
                    <div key={d.id} className="flex items-center justify-between p-2 rounded border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                      <div>
                        <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{d.device_name}</p>
                        <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{d.device_info?.device_type || 'Unknown'}</p>
                      </div>
                      <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => handleApplyDeviceSettings(d)}>Apply</Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" className="w-full" onClick={() => setShowChangeSettings(false)}>Cancel</Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* Empty state */}
      {devices.length === 0 && !showForm && (
        <div className="text-center py-10 border-2 border-dashed rounded-xl" style={{ borderColor: 'var(--border-slate-300)' }}>
          <Smartphone className="w-10 h-10 mx-auto mb-2" style={{ color: 'var(--text-slate-400)' }} />
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-slate-900)' }}>No devices registered</p>
          <p className="text-xs mb-3" style={{ color: 'var(--text-slate-500)' }}>Add your first device to enable location tracking</p>
          <Button size="sm" onClick={() => setShowForm(true)}>Add Device</Button>
        </div>
      )}

      {/* BLE diagnostics log moved to Admin Utilities - BLE Diag tab */}
    </div>
  );
}