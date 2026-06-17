import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { base44 } from '@/api/base44Client';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from
'@/components/ui/dialog';
import {
  User, Bell, Moon, Smartphone, Tablet, Monitor, LogOut, ChevronRight,
  Sun, Check, Ruler, Save, Loader2, Plus, MapPin, ShieldCheck,
  CheckCircle, Trash2, Edit2, X } from
'lucide-react';
import { toast } from 'sonner';
import { useUser } from '@/components/utils/UserContext';
import AccountDeletionSection from '@/components/settings/AccountDeletionSection';
import { loadUserSettings, saveSetting } from '@/components/utils/userSettingsManager';
import DeviceForm from '@/components/devices/DeviceForm';
import { getLocationProvider } from '@/components/utils/locationProviders';

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';

// ── Profile Panel ─────────────────────────────────────────────────────────────
function ProfilePanel({ currentUser }) {
  const [displayName, setDisplayName] = useState(currentUser?.user_name || currentUser?.full_name || '');
  const [phone, setPhone] = useState(currentUser?.phone || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
      if (appUsers?.length > 0) {
        await base44.entities.AppUser.update(appUsers[0].id, { user_name: displayName, phone });
      }
      toast.success('Profile updated');
    } catch {
      toast.error('Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 p-1">
      <div className="space-y-1">
        <Label htmlFor="displayName">Display Name</Label>
        <Input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={currentUser?.email || ''} disabled className="opacity-60 cursor-not-allowed" />
        <p className="text-xs text-slate-400">Email cannot be changed here.</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="phone">Phone Number</Label>
        <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 (555) 000-0000" type="tel" />
      </div>
      <Button onClick={handleSave} disabled={saving} className="w-full gap-2 mt-2">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        {saving ? 'Saving…' : 'Save Changes'}
      </Button>
    </div>);

}

// ── Notifications Panel ───────────────────────────────────────────────────────
function NotificationsPanel({ currentUser, settings }) {
  const [notificationsEnabled, setNotificationsEnabled] = useState(settings.notifications_enabled ?? true);
  const [sound, setSound] = useState(settings.notifications_sound ?? true);
  const [vibration, setVibration] = useState(settings.notifications_vibration ?? true);

  const handleToggle = async (key, value, setter) => {
    setter(value);
    await saveSetting(currentUser.id, key, value);
    toast.success('Preference saved');
  };

  const rows = [
  { key: 'notifications_enabled', label: 'Enable Notifications', description: 'Receive in-app alerts and updates', value: notificationsEnabled, setter: setNotificationsEnabled },
  { key: 'notifications_sound', label: 'Sound', description: 'Play a sound with notifications', value: sound, setter: setSound },
  { key: 'notifications_vibration', label: 'Vibration', description: 'Vibrate device with notifications', value: vibration, setter: setVibration }];


  return (
    <div className="divide-y divide-slate-100 p-1">
      {rows.map((row) =>
      <div key={row.key} className="flex items-center justify-between py-4">
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{row.label}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-500)' }}>{row.description}</p>
          </div>
          <Switch checked={row.value} onCheckedChange={(val) => handleToggle(row.key, val, row.setter)} />
        </div>
      )}
    </div>);

}

// ── Appearance Panel ──────────────────────────────────────────────────────────
function AppearancePanel({ currentUser, settings, onThemeChange }) {
  const [theme, setTheme] = useState(settings.theme_preference || 'auto');
  const [units, setUnits] = useState(settings.units_of_measurement || 'kilometers');

  const handleTheme = async (val) => {
    setTheme(val);
    await saveSetting(currentUser.id, 'theme_preference', val);
    if (onThemeChange) onThemeChange(val);
    toast.success('Theme updated');
  };

  const handleUnits = async (val) => {
    setUnits(val);
    await saveSetting(currentUser.id, 'units_of_measurement', val);
    toast.success('Units updated');
  };

  return (
    <div className="space-y-6 p-1">
      <div>
        <p className="text-sm font-medium mb-3" style={{ color: 'var(--text-slate-900)' }}>Theme</p>
        <div className="grid grid-cols-3 gap-2">
          <button onClick={() => handleTheme('light')}
          className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all text-sm font-medium ${theme === 'light' ? 'border-blue-500' : 'border-slate-200 hover:border-slate-300'}`}
          style={{ background: '#ffffff' }}>
            <Sun className="w-5 h-5" style={{ color: '#374151' }} />
            <span style={{ color: '#374151' }}>Light</span>
            {theme === 'light' && <Check className="w-3 h-3" style={{ color: '#16a34a' }} />}
          </button>
          <button onClick={() => handleTheme('dark')}
          className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all text-sm font-medium ${theme === 'dark' ? 'border-blue-400' : 'border-slate-700 hover:border-slate-500'}`}
          style={{ background: '#0f172a' }}>
            <Moon className="w-5 h-5" style={{ color: '#e2e8f0' }} />
            <span style={{ color: '#e2e8f0' }}>Dark</span>
            {theme === 'dark' && <Check className="w-3 h-3" style={{ color: '#4ade80' }} />}
          </button>
          <button onClick={() => handleTheme('auto')}
          className={`relative flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all text-sm font-medium overflow-hidden ${theme === 'auto' ? 'border-blue-500' : 'border-slate-200 hover:border-slate-300'}`}
          style={{ background: 'transparent' }}>
            <div className="absolute inset-0 left-0 w-1/2" style={{ background: '#ffffff' }} />
            <div className="absolute inset-0 left-1/2 w-1/2" style={{ background: '#0f172a' }} />
            <div className="relative z-10 flex flex-col items-center gap-2">
              <Monitor className="w-5 h-5" style={{ color: '#6b7280', filter: 'drop-shadow(0 0 1px rgba(255,255,255,0.8))' }} />
              <span className="font-medium" style={{ color: '#374151', textShadow: '0 0 4px #fff, 0 0 4px #fff' }}>System</span>
              {theme === 'auto' && <Check className="w-3 h-3" style={{ color: '#16a34a', filter: 'drop-shadow(0 0 2px white)' }} />}
            </div>
          </button>
        </div>
      </div>
      <div className="pb-4">
        <p className="text-sm font-medium mb-3" style={{ color: 'var(--text-slate-900)' }}>Distance Units</p>
        <div className="grid grid-cols-2 gap-2">
          {['kilometers', 'miles'].map((val) =>
          <button key={val} onClick={() => handleUnits(val)}
          className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 transition-all text-sm font-medium capitalize ${units === val ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:border-slate-300'}`}>
              <Ruler className="w-4 h-4" style={{ color: 'var(--text-slate-700)' }} />
              <span style={{ color: 'var(--text-slate-700)' }}>{val}</span>
              {units === val && <Check className="w-3 h-3 text-green-600" />}
            </button>
          )}
        </div>
      </div>
    </div>);

}

// ── Devices Panel ─────────────────────────────────────────────────────────────
function DevicesPanel({ currentUser }) {
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
        if (cached) {const c = JSON.parse(cached);if (Array.isArray(c) && c.length) {applyDevices(c);setIsLoading(false);}}
      } catch {}
      try {
        const list = await base44.entities.UserDevice.filter({ user_id: currentUser.id });
        applyDevices(list || []);
        localStorage.setItem(DEVICES_CACHE_KEY, JSON.stringify(list || []));
      } catch {toast.error('Failed to load devices');} finally
      {setIsLoading(false);}
    };
    load();
  }, [currentUser]);

  const handleDeleteDevice = async (device) => {
    if (!confirm(`Delete "${device.device_name}"?`)) return;
    try {
      await base44.entities.UserDevice.delete(device.id);
      setDevices((prev) => {const u = prev.filter((d) => d.id !== device.id);localStorage.setItem(`rxdeliver_devices_${currentUser.id}`, JSON.stringify(u));return u;});
      if (device.id === currentDeviceId) {localStorage.removeItem(DEVICE_ID_KEY);setCurrentDeviceId(null);}
      toast.success('Device deleted');
    } catch {toast.error('Failed to delete device');}
  };

  const handleSetPrimary = async (device) => {
    try {
      await Promise.all(devices.filter((d) => d.is_primary_tracker && d.id !== device.id).map((d) => base44.entities.UserDevice.update(d.id, { is_primary_tracker: false })));
      await base44.entities.UserDevice.update(device.id, { is_primary_tracker: true, status: 'active' });
      setDevices((prev) => prev.map((d) => ({ ...d, is_primary_tracker: d.id === device.id, status: d.id === device.id ? 'active' : d.status })));
      toast.success('Primary tracker updated');
    } catch {toast.error('Failed to set primary tracker');}
  };

  const handleClearPrimary = async (device) => {
    try {
      await base44.entities.UserDevice.update(device.id, { is_primary_tracker: false });
      setDevices((prev) => prev.map((d) => d.id === device.id ? { ...d, is_primary_tracker: false } : d));
      toast.success('Primary tracker removed');
    } catch {toast.error('Failed to remove primary tracker');}
  };

  const handleToggleDeviceStatus = async (device) => {
    const nextStatus = device.status === 'inactive' ? 'active' : 'inactive';
    const updates = { status: nextStatus, ...(nextStatus === 'inactive' ? { is_primary_tracker: false } : {}) };
    try {
      await base44.entities.UserDevice.update(device.id, updates);
      setDevices((prev) => prev.map((d) => d.id === device.id ? { ...d, ...updates } : d));
      if (device.id === currentDeviceId && nextStatus === 'inactive') {localStorage.removeItem(DEVICE_ID_KEY);setCurrentDeviceId(null);}
      toast.success(nextStatus === 'active' ? 'Device enabled' : 'Device disabled');
    } catch {toast.error('Failed to update device status');}
  };

  const handleApplySettings = async (device) => {
    try {
      const pending = deviceSettings[device.id] || {};
      if (!Object.keys(pending).length) {toast.info('No changes to save');return;}
      const updates = { ...pending, ...(pending.status === 'inactive' ? { is_primary_tracker: false } : {}) };
      await base44.entities.UserDevice.update(device.id, updates);
      setDevices((prev) => prev.map((d) => d.id === device.id ? { ...d, ...updates } : d));
      if (device.id === currentDeviceId && updates.status === 'inactive') {localStorage.removeItem(DEVICE_ID_KEY);setCurrentDeviceId(null);}
      setEditingSettings((prev) => ({ ...prev, [device.id]: false }));
      setDeviceSettings((prev) => ({ ...prev, [device.id]: {} }));
      toast.success('Device settings saved');
    } catch {toast.error('Failed to save device settings');}
  };

  const handleApplyDeviceSettings = async (sourceDevice) => {
    try {
      const cur = devices.find((d) => d.id === currentDeviceId);
      if (!cur) {toast.error('Current device not found');return;}
      const updates = { device_identifier: cur.device_identifier, device_name: cur.device_name, device_type: sourceDevice.device_info?.device_type, device_info: sourceDevice.device_info };
      await base44.entities.UserDevice.update(currentDeviceId, updates);
      setDevices((prev) => prev.map((d) => d.id === currentDeviceId ? { ...d, ...updates } : d));
      setShowChangeSettings(false);
      toast.success(`Applied settings from ${sourceDevice.device_name}`);
    } catch {toast.error('Failed to apply device settings');}
  };

  const handleSwitchToDeviceProfile = async (device) => {
    try {
      localStorage.setItem(DEVICE_ID_KEY, device.device_identifier);
      localStorage.setItem(`rxdeliver_device_registered_${device.device_identifier}`, 'true');
      await base44.entities.UserDevice.update(device.id, { last_active_at: new Date().toISOString() });
      setCurrentDeviceId(device.id);
      toast.success(`Now using ${device.device_name}`);
      window.location.reload();
    } catch {toast.error('Failed to switch device profile');}
  };

  const handleFormSubmit = async (deviceData, deviceId) => {
    try {
      if (deviceId) {
        await base44.entities.UserDevice.update(deviceId, deviceData);
        setDevices((prev) => prev.map((d) => d.id === deviceId ? { ...d, ...deviceData } : d));
        toast.success('Device updated');
      } else {
        const newDevice = await base44.entities.UserDevice.create({ ...deviceData, user_id: currentUser.id, device_identifier: crypto.randomUUID(), last_active_at: new Date().toISOString(), status: 'active' });
        setDevices((prev) => [...prev, newDevice]);
        toast.success('Device created');
      }
      setShowForm(false);setEditingDevice(null);
    } catch {toast.error('Failed to save device');}
  };

  const handleRequestLocationAccess = async () => {
    if (!isNativeBackgroundTrackingAvailable || isRequestingLocationAccess) return;
    setIsRequestingLocationAccess(true);
    try {
      await locationProvider.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0, requestPermissions: true });
      toast.success('Location access requested. Choose "Allow all the time / Always Allow".');
    } catch (error) {
      toast.error(error?.message || 'Location permission request was not completed');
    } finally {setIsRequestingLocationAccess(false);}
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
    </div>);


  return (
    <div className="space-y-4 py-4 px-1">
      {/* Add Device button */}
      <Button size="sm" className="gap-2 w-full" onClick={() => {setEditingDevice(null);setShowForm(true);}}>
        <Plus className="w-4 h-4" /> Add Device
      </Button>

      {/* Background GPS */}
      {isNativeBackgroundTrackingAvailable &&
      <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}>
          <p className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
            <ShieldCheck className="w-4 h-4" /> Background GPS Setup
          </p>
          <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
            Tap below, then allow full background access when prompted.
          </p>
          <Button size="sm" className="gap-2" onClick={handleRequestLocationAccess} disabled={isRequestingLocationAccess}>
            <MapPin className="w-4 h-4" />
            {isRequestingLocationAccess ? 'Requesting...' : 'Request Background GPS Access'}
          </Button>
        </div>
      }

      {/* Device Form */}
      {showForm &&
      <DeviceForm
        device={editingDevice}
        existingDevices={devices}
        onSubmit={handleFormSubmit}
        onCancel={() => {setShowForm(false);setEditingDevice(null);}} />

      }

      {/* Device cards */}
      {sortedDevices.map((device) => {
        const displayOS = device.device_info?.os === 'Linux' ? 'Android' : device.device_info?.os;
        const lastActive = device.last_active_at ? new Date(device.last_active_at).toLocaleString() : 'Never';
        const isCurrent = device.id === currentDeviceId;
        return (
          <div key={device.id} className="rounded-xl border p-4 space-y-3" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                {getDeviceIcon(device.device_info?.device_type)}
                <div>
                  <p className="text-sm font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                    {device.device_name}
                    {isCurrent && <Badge className="ml-2 bg-blue-500 text-white text-xs">Current</Badge>}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{displayOS} · {lastActive}</p>
                </div>
              </div>
              {device.is_primary_tracker &&
              <Badge className="bg-green-100 text-green-800 gap-1 text-xs"><CheckCircle className="w-3 h-3" /> Primary</Badge>
              }
            </div>

            {editingSettings[device.id] ?
            <div className="flex items-center justify-between p-2 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                <label className="text-xs font-medium" style={{ color: 'var(--text-slate-900)' }}>Status</label>
                <select
                value={deviceSettings[device.id]?.status ?? device.status}
                onChange={(e) => setDeviceSettings((prev) => ({ ...prev, [device.id]: { ...prev[device.id], status: e.target.value } }))}
                className="px-2 py-1 rounded text-xs border"
                style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
                
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div> :

            <div className="text-xs px-2 py-1.5 rounded-lg" style={{ background: 'var(--bg-slate-50)', color: 'var(--text-slate-600)' }}>
                Status: <span className="font-semibold">{device.status === 'active' ? 'Active' : 'Inactive'}</span>
              </div>
            }

            <div className="flex gap-1.5 flex-wrap">
              {editingSettings[device.id] ?
              <>
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 gap-1 h-7 text-xs" onClick={() => handleApplySettings(device)}>
                    <CheckCircle className="w-3 h-3" /> Apply
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => {setEditingSettings((p) => ({ ...p, [device.id]: false }));setDeviceSettings((p) => ({ ...p, [device.id]: {} }));}}>
                    Cancel
                  </Button>
                </> :

              <>
                  <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={() => setEditingSettings((p) => ({ ...p, [device.id]: true }))}>
                    <Edit2 className="w-3 h-3" /> Edit
                  </Button>
                  {!isCurrent && device.status !== 'inactive' &&
                <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={() => handleSwitchToDeviceProfile(device)}>
                      <CheckCircle className="w-3 h-3" /> Use Here
                    </Button>
                }
                  {isCurrent && devices.length > 1 &&
                <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={() => setShowChangeSettings(true)}>
                      <Edit2 className="w-3 h-3" /> Copy From...
                    </Button>
                }
                  {device.is_primary_tracker ?
                <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={() => handleClearPrimary(device)}>
                      Remove Primary
                    </Button> :

                <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={() => handleSetPrimary(device)}>
                      Set Primary
                    </Button>
                }
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleToggleDeviceStatus(device)}>
                    {device.status === 'inactive' ? 'Enable' : 'Disable'}
                  </Button>
                  <Button variant="destructive" size="sm" className="gap-1 h-7 text-xs ml-auto" onClick={() => handleDeleteDevice(device)} disabled={devices.length === 1}>
                    <Trash2 className="w-3 h-3" /> Delete
                  </Button>
                </>
              }
            </div>

            {isCurrent && showChangeSettings &&
            <div className="rounded-lg border p-3 space-y-2" style={{ background: 'var(--bg-slate-50)', borderColor: 'var(--border-slate-200)' }}>
                <p className="text-xs font-semibold" style={{ color: 'var(--text-slate-900)' }}>Apply settings from:</p>
                {devices.filter((d) => d.id !== currentDeviceId).map((d) =>
              <div key={d.id} className="flex items-center justify-between p-2 rounded border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                    <div>
                      <p className="text-xs font-medium" style={{ color: 'var(--text-slate-900)' }}>{d.device_name}</p>
                      <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{d.device_info?.device_type || 'Unknown'}</p>
                    </div>
                    <Button size="sm" className="bg-blue-600 hover:bg-blue-700 h-7 text-xs" onClick={() => handleApplyDeviceSettings(d)}>Apply</Button>
                  </div>
              )}
                <Button variant="outline" size="sm" className="w-full h-7 text-xs" onClick={() => setShowChangeSettings(false)}>Cancel</Button>
              </div>
            }
          </div>);

      })}

      {devices.length === 0 && !showForm &&
      <div className="text-center py-10 border-2 border-dashed rounded-xl" style={{ borderColor: 'var(--border-slate-300)' }}>
          <Smartphone className="w-10 h-10 mx-auto mb-2" style={{ color: 'var(--text-slate-400)' }} />
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-slate-900)' }}>No devices registered</p>
          <p className="text-xs mb-3" style={{ color: 'var(--text-slate-500)' }}>Add your first device to enable location tracking</p>
          <Button size="sm" onClick={() => setShowForm(true)}>Add Device</Button>
        </div>
      }
    </div>);

}

// ── SettingsSheet wrapper ─────────────────────────────────────────────────────
function SettingsDialog({ open, onOpenChange, title, description, icon: Icon, children }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-md max-h-[85vh] overflow-y-auto px-4 py-4">
        <DialogHeader className="pb-4 border-b border-slate-100 mb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            {Icon && <Icon className="w-4 h-4" />}
            {title}
          </DialogTitle>
          {description && <DialogDescription className="text-xs">{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>);

}

// ── Main Settings Page ────────────────────────────────────────────────────────
export default function Settings() {
  const { currentUser } = useUser();
  const [openPanel, setOpenPanel] = useState(null); // 'profile' | 'notifications' | 'appearance' | 'devices'
  const [userSettings, setUserSettings] = useState(null);

  useEffect(() => {
    if (currentUser?.id) loadUserSettings(currentUser.id).then(setUserSettings);
  }, [currentUser?.id]);

  const handleThemeChange = (newTheme) => {
    window.dispatchEvent(new CustomEvent('themePreferenceChanged', { detail: { theme: newTheme } }));
  };

  const sections = [
  {
    key: 'account',
    title: 'Account',
    icon: User,
    items: [
    { label: 'Profile', description: currentUser?.user_name || currentUser?.full_name || 'Tap to edit', onClick: () => setOpenPanel('profile') },
    { label: 'Email', description: currentUser?.email || 'Not available', disabled: true }]

  },
  {
    key: 'notifications',
    title: 'Notifications',
    icon: Bell,
    items: [
    { label: 'Push Notifications', description: 'Manage notification preferences', onClick: () => setOpenPanel('notifications') }]

  },
  {
    key: 'appearance',
    title: 'Appearance',
    icon: Moon,
    items: [
    {
      label: 'Theme & Units',
      description: userSettings ?
      `${userSettings.theme_preference || 'auto'} · ${userSettings.units_of_measurement || 'kilometers'}` :
      'Light, Dark, or System',
      onClick: () => setOpenPanel('appearance')
    }]

  },
  {
    key: 'devices',
    title: 'Devices',
    icon: Smartphone,
    items: [
    { label: 'Manage Devices', description: 'View and manage connected devices', onClick: () => setOpenPanel('devices') }]

  }];


  return (
    <div className="h-full overflow-y-auto pb-20" style={{ background: 'var(--bg-slate-50)' }}>
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-slate-900)' }}>Settings</h1>
          <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>Manage your account, devices, and preferences.</p>
        </div>

        {sections.map((section) => {
          const SectionIcon = section.icon;
          return (
            <Card key={section.key} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
                  <SectionIcon className="w-4 h-4" />
                  {section.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {section.items.map((item, i) =>
                <button
                  key={i}
                  onClick={item.onClick}
                  disabled={item.disabled}
                  className={`w-full flex items-center justify-between px-3 py-3 rounded-lg transition-colors text-left select-none ${item.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-50 active:bg-slate-100'}`}>
                  
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{item.label}</p>
                      {item.description && <p className="text-sm truncate" style={{ color: 'var(--text-slate-500)' }}>{item.description}</p>}
                    </div>
                    {!item.disabled && <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0 ml-2" />}
                  </button>
                )}
              </CardContent>
            </Card>);

        })}

        {/* Sign Out */}
        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardContent className="p-4">
            <Button onClick={() => base44.auth.logout()} variant="outline" className="w-full justify-start gap-2 select-none">
              <LogOut className="w-4 h-4" /> Sign Out
            </Button>
          </CardContent>
        </Card>

        <AccountDeletionSection />
      </div>

      {/* ── Slide-in Sheets ── */}
      <SettingsDialog open={openPanel === 'profile'} onOpenChange={(o) => !o && setOpenPanel(null)} title="Account" description="Update your display name and phone number." icon={User}>
        <ProfilePanel currentUser={currentUser} />
      </SettingsDialog>

      <SettingsDialog open={openPanel === 'notifications'} onOpenChange={(o) => !o && setOpenPanel(null)} title="Notifications" description="Control how and when you receive alerts." icon={Bell}>
        {userSettings && <NotificationsPanel currentUser={currentUser} settings={userSettings} />}
      </SettingsDialog>

      <SettingsDialog open={openPanel === 'appearance'} onOpenChange={(o) => !o && setOpenPanel(null)} title="Appearance" description="Choose your theme and measurement units." icon={Moon}>
        {userSettings && <AppearancePanel currentUser={currentUser} settings={userSettings} onThemeChange={handleThemeChange} />}
      </SettingsDialog>

      <SettingsDialog open={openPanel === 'devices'} onOpenChange={(o) => !o && setOpenPanel(null)} title="Devices" description="View and manage your registered devices." icon={Smartphone}>
        {currentUser && <DevicesPanel currentUser={currentUser} />}
      </SettingsDialog>
    </div>);

}