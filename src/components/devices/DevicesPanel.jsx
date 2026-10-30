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
  Plus, MapPin, ShieldCheck, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { getLocationProvider } from '@/components/utils/locationProviders';
import DeviceForm from '@/components/devices/DeviceForm';
// InkbirdBleLog moved to Admin Utilities - BLE Diag tab

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';

// Owner spec Oct 29 2026: a preview/sandbox host is shown simply as "Preview" —
// the full base44 sandbox URL is noise in the Devices panel.
export const formatDeviceHost = (host) => {
  const h = String(host || '').trim();
  if (!h) return '';
  if (/preview|sandbox/i.test(h)) return 'Preview';
  return h;
};

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

  // ── Admin "manage another user's devices" (owner request Oct 29 2026) ──
  // An admin can pick any user and view/edit THAT user's devices without
  // logging in as them. Device rows key on UserDevice.user_id, which is the
  // auth user id, and AppUser.user_id carries the same value.
  const [targetUserId, setTargetUserId] = useState(null);
  const [users, setUsers] = useState([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const isAdminViewer = !!currentUser &&
    (currentUser.app_roles?.includes?.('admin') || currentUser.role === 'admin');

  const viewUserId = targetUserId || currentUser?.id || null;
  const isOwnDevices = !currentUser?.id || viewUserId === currentUser.id;
  const viewUser = !isOwnDevices ? users.find((u) => u.user_id === viewUserId) : null;
  const viewUserName = viewUser
    ? (viewUser.user_name || viewUser.full_name || viewUser.ETrans_Email || 'this user')
    : null;
  const devicesCacheKey = viewUserId ? `rxdeliver_devices_${viewUserId}` : null;

  // ── Data layer (owner report Oct 29 2026) ────────────────────────────────────
  // The UserDevice entity is RLS-scoped to created_by === {{user.email}}, so a
  // plain client read as an admin returns ONLY the rows that admin created —
  // which is why another user's device list came back empty. Viewing someone
  // else's devices therefore goes through the admin-only userDevicesAdmin
  // backend function (service role after an explicit app_roles check). Your own
  // devices keep the direct entity path they always had.
  const callAdminDevices = async (payload) => {
    const res = await base44.functions.invoke('userDevicesAdmin', payload);
    const data = res?.data ?? res;
    if (data?.error) throw new Error(data.error);
    return data;
  };
  const updateDeviceRecord = async (id, updates) => {
    if (isOwnDevices) return base44.entities.UserDevice.update(id, updates);
    const res = await callAdminDevices({ action: 'update', id, updates });
    return res?.device || null;
  };
  const deleteDeviceRecord = async (id) => {
    if (isOwnDevices) return base44.entities.UserDevice.delete(id);
    return callAdminDevices({ action: 'delete', id });
  };
  const createDeviceRecord = async (record) => {
    if (isOwnDevices) return base44.entities.UserDevice.create(record);
    const res = await callAdminDevices({ action: 'create', record });
    return res?.device || null;
  };

  const locationProvider = getLocationProvider();
  const isNativeBackgroundTrackingAvailable =
    locationProvider?.backgroundCapable === true && locationProvider?.isAvailable();

  // Admin: user picker data (only fetched when an admin opens this panel)
  useEffect(() => {
    if (!isAdminViewer) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const list = await base44.entities.AppUser.list('user_name', 200);
        if (cancelled) return;
        // Same ordering as the rest of the app's user lists: AppUser.sort_order
        // ascending (unset sorts last), name as a stable tie-break.
        setUsers((list || [])
          .filter((u) => u?.user_id)
          .sort((a, b) => {
            const ao = typeof a.sort_order === 'number' && Number.isFinite(a.sort_order) ? a.sort_order : Infinity;
            const bo = typeof b.sort_order === 'number' && Number.isFinite(b.sort_order) ? b.sort_order : Infinity;
            if (ao !== bo) return ao - bo;
            return String(a.user_name || a.full_name || '').localeCompare(String(b.user_name || b.full_name || ''));
          }));
      } catch { /* picker stays limited to "me" */ }
    })();
    return () => { cancelled = true; };
  }, [isAdminViewer]);

  // Live updates (owner request Oct 29 2026): any UserDevice change for the
  // viewed user re-runs the load — new registrations, domain stamps, primary
  // flags, disables and deletes appear without reopening the panel.
  useEffect(() => {
    if (!viewUserId) return undefined;
    let unsubscribe = null;
    let timer = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRefreshTick((t) => t + 1), 700);
    };
    try {
      unsubscribe = base44.entities.UserDevice.subscribe((event) => {
        const row = event?.data || event;
        const rowUserId = row?.user_id;
        if (!rowUserId || String(rowUserId) === String(viewUserId)) bump();
      });
    } catch (_) { /* WS unavailable → manual Refresh still works */ }
    return () => {
      if (timer) clearTimeout(timer);
      try { unsubscribe?.(); } catch (_) {}
    };
  }, [viewUserId]);

  useEffect(() => {
    if (!viewUserId) return;
    const cacheKey = `rxdeliver_devices_${viewUserId}`;
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setDevices([]);            // never show the previous user's devices
      setCurrentDeviceId(null);
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const c = JSON.parse(cached);
          if (Array.isArray(c) && c.length) setDevices(c);
        }
      } catch {}
      try {
        const list = isOwnDevices
          ? await base44.entities.UserDevice.filter({ user_id: viewUserId })
          : ((await callAdminDevices({ action: 'list', userId: viewUserId }))?.devices || []);
        if (cancelled) return;
        setDevices(list || []);
        localStorage.setItem(cacheKey, JSON.stringify(list || []));
        // Own devices: the "Current" badge + Use Here depend on the local id.
        const storedId = localStorage.getItem(DEVICE_ID_KEY);
        if (storedId) {
          const cur = (list || []).find((d) => d.device_identifier === storedId);
          if (cur) setCurrentDeviceId(cur.id);
        }
        // Domain self-stamp: if THIS device's record has no host yet, write it
        // now instead of waiting for the 5-minute up-sync, so the panel shows
        // the domain immediately.
        if (storedId) {
          let host = null;
          try { host = window.location.hostname || null; } catch (_) {}
          const own = (list || []).find((d) => d.device_identifier === storedId);
          if (own?.id && host && own.device_info?.host !== host) {
            // Backend stamp: works even when the device's record was created by
            // another account (RLS would silently reject a direct update).
            base44.functions.invoke('stampDeviceHost', { deviceIdentifier: storedId, host }).then(() => {
              setDevices((prev) => prev.map((d) => d.id === own.id
                ? { ...d, device_info: { ...(d.device_info || {}), host } }
                : d));
            }).catch(() => {});
          }
        }
      } catch { toast.error('Failed to load devices'); } finally { if (!cancelled) setIsLoading(false); }
    };
    load();
    return () => { cancelled = true; };
  }, [viewUserId, refreshTick]);

  const handleDeleteDevice = async (device) => {
    if (!confirm(`Delete "${device.device_name}"?`)) return;
    try {
      await deleteDeviceRecord(device.id);
      setDevices((prev) => {
        const u = prev.filter((d) => d.id !== device.id);
        if (devicesCacheKey) localStorage.setItem(devicesCacheKey, JSON.stringify(u));
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
          .map((d) => updateDeviceRecord(d.id, { is_primary_tracker: false }))
      );
      await updateDeviceRecord(device.id, { is_primary_tracker: true, status: 'active' });
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
      await updateDeviceRecord(device.id, { is_primary_tracker: false });
      setDevices((prev) => prev.map((d) => d.id === device.id ? { ...d, is_primary_tracker: false } : d));
      toast.success('Primary tracker removed');
    } catch { toast.error('Failed to remove primary tracker'); }
  };

  const handleToggleDeviceStatus = async (device) => {
    const nextStatus = device.status === 'inactive' ? 'active' : 'inactive';
    const updates = { status: nextStatus, ...(nextStatus === 'inactive' ? { is_primary_tracker: false } : {}) };
    try {
      await updateDeviceRecord(device.id, updates);
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
      if (pending.device_name !== undefined && !pending.device_name.trim()) {
        toast.error('Device name cannot be empty'); return;
      }
      const updates = { ...pending, ...(pending.status === 'inactive' ? { is_primary_tracker: false } : {}) };
      await updateDeviceRecord(device.id, updates);
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
      await updateDeviceRecord(currentDeviceId, updates);
      setDevices((prev) => prev.map((d) => d.id === currentDeviceId ? { ...d, ...updates } : d));
      setShowChangeSettings(false);
      toast.success(`Applied settings from ${sourceDevice.device_name}`);
    } catch { toast.error('Failed to apply device settings'); }
  };

  const handleSwitchToDeviceProfile = async (device) => {
    try {
      localStorage.setItem(DEVICE_ID_KEY, device.device_identifier);
      localStorage.setItem(`rxdeliver_device_registered_${device.device_identifier}`, 'true');
      await updateDeviceRecord(device.id, { last_active_at: new Date().toISOString() });
      setCurrentDeviceId(device.id);
      toast.success(`Now using ${device.device_name}`);
      window.location.reload();
    } catch { toast.error('Failed to switch device profile'); }
  };

  const handleFormSubmit = async (deviceData, deviceId) => {
    try {
      // BUGFIX (2026-08-17): DeviceForm sets `unset_other_primary: true` when
      // the user checks "Primary" on a device that wasn't already primary —
      // but this handler previously ignored that flag entirely, so the OLD
      // primary device's is_primary_tracker flag was NEVER cleared. Result:
      // multiple devices could simultaneously be flagged primary, each one
      // independently passing the isPrimaryDevice check in locationTracker.jsx
      // and firing GPS/heartbeat writes — exactly the "phantom location
      // update from a device that shouldn't be tracking" symptom.
      const { unset_other_primary, ...cleanDeviceData } = deviceData;

      if (unset_other_primary) {
        const othersToDemote = devices.filter((d) => d.is_primary_tracker && d.id !== deviceId);
        if (othersToDemote.length > 0) {
          await Promise.all(
            othersToDemote.map((d) => updateDeviceRecord(d.id, { is_primary_tracker: false }))
          );
        }
      }

      if (deviceId) {
        await updateDeviceRecord(deviceId, cleanDeviceData);
        setDevices((prev) => prev.map((d) => {
          if (d.id === deviceId) return { ...d, ...cleanDeviceData };
          if (unset_other_primary && d.is_primary_tracker) return { ...d, is_primary_tracker: false };
          return d;
        }));
        toast.success('Device updated');
      } else {
        const newDevice = await createDeviceRecord({
          ...cleanDeviceData,
          // Admin managing someone else's devices → the record belongs to THEM.
          user_id: viewUserId,
          user_name: isOwnDevices ? (currentUser?.user_name || currentUser?.full_name || '') : (viewUser?.user_name || viewUser?.full_name || ''),
          device_identifier: crypto.randomUUID(),
          last_active_at: new Date().toISOString(),
          status: 'active',
        });
        setDevices((prev) => {
          const next = unset_other_primary
            ? prev.map((d) => d.is_primary_tracker ? { ...d, is_primary_tracker: false } : d)
            : prev;
          return [...next, newDevice];
        });
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
      <div className="h-20 bg-slate-100 dark:bg-slate-800 rounded-xl" />
      <div className="h-20 bg-slate-100 dark:bg-slate-800 rounded-xl" />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Toolbar: user picker (admin only) + Add Device + Refresh share one row
          (owner request Oct 29 2026 — the picker no longer spans the panel). */}
      <div className="flex items-center gap-2">
        {isAdminViewer && (
          <select
            aria-label="View devices for"
            value={viewUserId || ''}
            onChange={(e) => {
              const next = e.target.value === currentUser?.id ? null : e.target.value;
              setTargetUserId(next);
              setEditingSettings({});
              setDeviceSettings({});
              setShowForm(false);
              setEditingDevice(null);
            }}
            className="flex-1 min-w-0 px-2 py-1.5 rounded text-sm border bg-surface border-surface text-body"
          >
            <option value={currentUser?.id || ''}>Me{currentUser?.user_name ? ` (${currentUser.user_name})` : ''}</option>
            {users
              .filter((u) => u.user_id !== currentUser?.id)
              .map((u) => (
                <option key={u.id || u.user_id} value={u.user_id}>
                  {u.user_name || u.full_name || u.ETrans_Email || 'Unnamed user'}
                  {u.app_roles?.length ? ` — ${u.app_roles.join(', ')}` : ''}
                </option>
              ))}
          </select>
        )}
        <Button size="sm" className={`gap-2 shrink-0 ${isAdminViewer ? '' : 'flex-1'}`} onClick={() => { setEditingDevice(null); setShowForm(true); }}>
          <Plus className="w-4 h-4" /> Add Device{!isOwnDevices ? ` for ${viewUserName}` : ''}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-2 shrink-0"
          title="Refresh devices"
          aria-label="Refresh devices"
          disabled={isRefreshing}
          onClick={() => { setIsRefreshing(true); setRefreshTick((t) => t + 1); setTimeout(() => setIsRefreshing(false), 1200); }}
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {!isOwnDevices && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          Showing {viewUserName}'s devices. Edits, primary flags, disables and deletes apply to their account.
        </p>
      )}

      {/* Background GPS */}
      {isNativeBackgroundTrackingAvailable && (
        <Card className="bg-surface border-surface">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2 text-body-2">
              <ShieldCheck className="w-4 h-4" /> Background GPS Setup
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-soft">
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

      {/* Device cards — multi-column on wider screens (owner request Oct 29 2026) */}
      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3 items-start">
      {sortedDevices.map((device) => {
        const displayOS = device.device_info?.os === 'Linux' ? 'Android' : device.device_info?.os;
        const lastActive = device.last_active_at ? new Date(device.last_active_at).toLocaleString() : 'Never';
        // "Current" only means something on your OWN device list.
        const isCurrent = isOwnDevices && device.id === currentDeviceId;
        const deviceHost = device.device_info?.host
          || (isCurrent ? (() => { try { return window.location.hostname; } catch (_) { return ''; } })() : '')
          || '';

        return (
          <Card key={device.id} className="bg-surface border-surface">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  {getDeviceIcon(device.device_info?.device_type)}
                  <div>
                    <p className="text-base font-semibold text-body">
                      {device.device_name}
                      {isCurrent && <Badge className="ml-2 bg-blue-500 text-white text-xs">Current</Badge>}
                    </p>
                    <p className="text-sm text-soft">{displayOS} · {lastActive}</p>
                    <p className="text-xs text-soft break-all">
                      Domain: {formatDeviceHost(deviceHost) || <span className="italic opacity-70">not recorded yet</span>}
                    </p>
                  </div>
                </div>
                {device.is_primary_tracker && (
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200 dark:border dark:border-green-700/60 gap-1 text-xs">
                    <CheckCircle className="w-3 h-3" /> Primary
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {editingSettings[device.id] ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 p-2 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                    <label className="text-sm font-medium flex-shrink-0 text-body">Name</label>
                    <input
                      type="text"
                      value={deviceSettings[device.id]?.device_name ?? device.device_name}
                      onChange={(e) => setDeviceSettings((p) => ({ ...p, [device.id]: { ...p[device.id], device_name: e.target.value } }))}
                      placeholder={device.device_name}
                      className="flex-1 px-2 py-1 rounded text-sm border min-w-0 text-body bg-surface border-surface"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 p-2 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                    <label className="text-sm font-medium flex-shrink-0 text-body">Domain</label>
                    <span className="text-sm text-soft break-all text-right">{formatDeviceHost(deviceHost) || 'not recorded yet'}</span>
                  </div>
                  <div className="flex items-center justify-between p-2 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
                    <label className="text-sm font-medium text-body">Status</label>
                    <select
                      value={deviceSettings[device.id]?.status ?? device.status}
                      onChange={(e) => setDeviceSettings((p) => ({ ...p, [device.id]: { ...p[device.id], status: e.target.value } }))}
                      className="px-2 py-1 rounded text-sm border bg-surface border-surface"
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                </div>
              ) : (
                <div className="text-sm px-2 py-1.5 rounded-lg text-label" style={{ background: 'var(--bg-slate-50)' }}>
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
                    {/* Owner spec Oct 29 2026: the four action buttons share ONE row
                        and stretch evenly to fill the card; Delete keeps its own
                        row, aligned bottom-right. */}
                    <div className="flex items-stretch gap-1.5 w-full">
                      <Button variant="outline" size="sm" className="gap-1 flex-1 min-w-0 px-2" onClick={() => setEditingSettings((p) => ({ ...p, [device.id]: true }))}>
                        <Edit2 className="w-3 h-3 shrink-0" /> <span className="truncate">Edit</span>
                      </Button>
                      {isOwnDevices && !isCurrent && device.status !== 'inactive' && (
                        <Button variant="outline" size="sm" className="gap-1 flex-1 min-w-0 px-2" onClick={() => handleSwitchToDeviceProfile(device)}>
                          <CheckCircle className="w-3 h-3 shrink-0" /> <span className="truncate">Use Here</span>
                        </Button>
                      )}
                      {isOwnDevices && isCurrent && devices.length > 1 && (
                        <Button variant="outline" size="sm" className="gap-1 flex-1 min-w-0 px-2" onClick={() => setShowChangeSettings(true)}>
                          <Edit2 className="w-3 h-3 shrink-0" /> <span className="truncate">Copy From...</span>
                        </Button>
                      )}
                      {device.is_primary_tracker ? (
                        <Button variant="outline" size="sm" className="gap-1 flex-1 min-w-0 px-2" onClick={() => handleClearPrimary(device)}>
                          <span className="truncate">Remove Primary</span>
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" className="gap-1 flex-1 min-w-0 px-2" onClick={() => handleSetPrimary(device)}>
                          <span className="truncate">Set Primary</span>
                        </Button>
                      )}
                      <Button variant="outline" size="sm" className="gap-1 flex-1 min-w-0 px-2" onClick={() => handleToggleDeviceStatus(device)}>
                        <span className="truncate">{device.status === 'inactive' ? 'Enable' : 'Disable'}</span>
                      </Button>
                    </div>
                    <div className="flex justify-end w-full">
                      <Button variant="destructive" size="sm" className="gap-1 shrink-0" onClick={() => handleDeleteDevice(device)} disabled={devices.length === 1}>
                        <Trash2 className="w-3 h-3" /> Delete
                      </Button>
                    </div>
                  </>
                )}
              </div>

              {isCurrent && showChangeSettings && (
                <div className="rounded-lg border p-3 space-y-2 border-surface" style={{ background: 'var(--bg-slate-50)' }}>
                  <p className="text-sm font-semibold text-body">Apply settings from:</p>
                  {devices.filter((d) => d.id !== currentDeviceId).map((d) => (
                    <div key={d.id} className="flex items-center justify-between p-2 rounded border bg-surface border-surface">
                      <div>
                        <p className="text-sm font-medium text-body">{d.device_name}</p>
                        <p className="text-xs text-soft">{d.device_info?.device_type || 'Unknown'}</p>
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
      </div>

      {/* Empty state */}
      {devices.length === 0 && !showForm && (
        <div className="text-center py-10 border-2 border-dashed rounded-xl" style={{ borderColor: 'var(--border-slate-300)' }}>
          <Smartphone className="w-10 h-10 mx-auto mb-2" style={{ color: 'var(--text-slate-400)' }} />
          <p className="text-sm font-medium mb-1 text-body">No devices registered</p>
          <p className="text-xs mb-3 text-soft">Add your first device to enable location tracking</p>
          <Button size="sm" onClick={() => setShowForm(true)}>Add Device</Button>
        </div>
      )}

      {/* BLE diagnostics log moved to Admin Utilities - BLE Diag tab */}
    </div>
  );
}