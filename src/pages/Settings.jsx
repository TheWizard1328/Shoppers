import { AnimatePresence, motion } from 'framer-motion';
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from 'react-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { isCapacitorNativeApp, getCapacitorPlatform } from '@/components/utils/locationProviders/capacitorRuntime';
import { isNativePushAvailable, checkNativePushPermission, initNativePushNotifications, forceReRegisterNativePush, runPushDiagnostics, getRegistrationDiagnostics } from "@/components/utils/nativePushNotifications";
import { useLatestApkBuildInfo } from '@/components/utils/useBuildInfo';
import { getUserAgentInfo } from '@/components/utils/deviceUtils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  User, Bell, Moon, Smartphone, Monitor, LogOut, ChevronRight,
  Sun, Check, Ruler, Save, Loader2, ShieldAlert, Download, RefreshCw, X,
} from 'lucide-react';
import { initPushNotifications, resetPushSubscription } from '@/components/utils/pushNotifications';
import { toast } from 'sonner';
import { useUser } from '@/components/utils/UserContext';
import AccountDeletionSection from '@/components/settings/AccountDeletionSection';
import { loadUserSettings, saveSetting } from '@/components/utils/userSettingsManager';
import DevicesPanel from '@/components/devices/DevicesPanel';

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';

// ── Profile Panel ─────────────────────────────────────────────────────────────
export function ProfilePanel({ currentUser, onClose }) {
  const [displayName, setDisplayName] = useState(currentUser?.user_name || currentUser?.full_name || '');
  const [phone, setPhone] = useState(currentUser?.phone || '');
  const [eTransEmail, setETransEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const isDispatcherOnly = Array.isArray(currentUser?.app_roles) &&
    currentUser.app_roles.includes('dispatcher') &&
    !currentUser.app_roles.includes('admin') &&
    !currentUser.app_roles.includes('driver');

  useEffect(() => {
    if (!currentUser?.id || isDispatcherOnly) return;
    base44.entities.AppUser.filter({ user_id: currentUser.id }, null, null, null, 'id,user_id,user_name,app_roles,status,driver_status,driver_id,driver_name,store_ids,city_id,city_ids,home_latitude,home_longitude,current_latitude,current_longitude,location_tracking_enabled,location_updated_at,preferred_travel_mode,sort_order,role,full_name,created_date,updated_date,ETrans_Email').then((appUsers) => {
      if (appUsers?.length > 0) setETransEmail(appUsers[0].ETrans_Email || '');
    }).catch(() => {});
  }, [currentUser?.id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id }, null, null, null, 'id,user_id,user_name,app_roles,status,driver_status,driver_id,driver_name,store_ids,city_id,city_ids,home_latitude,home_longitude,current_latitude,current_longitude,location_tracking_enabled,location_updated_at,preferred_travel_mode,sort_order,role,full_name,created_date,updated_date,ETrans_Email');
      if (appUsers?.length > 0) {
        const update = { user_name: displayName, phone };
        if (!isDispatcherOnly) update.ETrans_Email = eTransEmail;
        await base44.entities.AppUser.update(appUsers[0].id, update);
      }
      toast.success('Profile updated');
      if (onClose) onClose();
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
        <p className="text-xs text-slate-400 dark:text-slate-500 dark:text-slate-400">Email cannot be changed here.</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="phone">Phone Number</Label>
        <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 (555) 000-0000" type="tel" />
      </div>
      {!isDispatcherOnly && (
      <div className="space-y-1">
        <Label htmlFor="eTransEmail">e-Transfer Email</Label>
        <Input id="eTransEmail" value={eTransEmail} onChange={(e) => setETransEmail(e.target.value)} placeholder="your@email.com" type="email" />
        <p className="text-xs text-slate-400 dark:text-slate-500 dark:text-slate-400">Used for Interac e-Transfer payroll payments.</p>
      </div>
      )}
      <Button onClick={handleSave} disabled={saving} className="w-full gap-2 mt-2">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        {saving ? 'Saving…' : 'Save Changes'}
      </Button>
    </div>
  );
}

// ── Notifications Panel ───────────────────────────────────────────────────────
function NotificationsPanel({ currentUser, settings }) {
  const [notificationsEnabled, setNotificationsEnabled] = useState(settings.notifications_enabled ?? true);
  const [sound, setSound] = useState(settings.notifications_sound ?? true);
  const [vibration, setVibration] = useState(settings.notifications_vibration ?? true);
  const isNativePush = isNativePushAvailable();
  const [browserPermission, setBrowserPermission] = useState(
    isNativePush ? 'prompt' : (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported')
  );
  const [subscribing, setSubscribing] = useState(false);

  // Check native push permission on mount
  useEffect(() => {
    if (!isNativePush) return;
    let cancelled = false;
    (async () => {
      const perm = await checkNativePushPermission();
      if (!cancelled) setBrowserPermission(perm);
    })();
    return () => { cancelled = true; };
  }, [isNativePush]);

  const handleToggle = async (key, value, setter) => {
    setter(value);
    await saveSetting(currentUser.id, key, value);
    toast.success('Preference saved');
  };

  const handleEnableToggle = async (val) => {
    if (val && browserPermission !== 'granted') {
      // Ask for permission and subscribe
      setSubscribing(true);
      try {
        const result = await initPushNotifications(currentUser.id);
        // Check new permission
        let newPermission;
        if (isNativePush) {
          newPermission = await checkNativePushPermission();
        } else {
          newPermission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
        }
        setBrowserPermission(newPermission);
        if (newPermission === 'granted' || result?.ok) {
          setNotificationsEnabled(true);
          await saveSetting(currentUser.id, 'notifications_enabled', true);
          toast.success('Push notifications enabled');
        } else {
          toast.error(isNativePush
            ? 'Permission not granted — please allow notifications in Android Settings → Apps → RxDeliver'
            : 'Permission not granted — please allow notifications in your browser settings');
        }
      } catch {
        toast.error('Could not enable notifications');
      } finally {
        setSubscribing(false);
      }
    } else {
      handleToggle('notifications_enabled', val, setNotificationsEnabled);
    }
  };

  const handleResubscribe = async () => {
    setSubscribing(true);
    try {
      await resetPushSubscription(currentUser.id);
      const newPermission = isNativePush ? await checkNativePushPermission() : (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
      setBrowserPermission(newPermission);
      toast.success('Push subscription refreshed');
    } catch {
      toast.error('Could not re-subscribe');
    } finally {
      setSubscribing(false);
    }
  };

  const rows = [
    { key: 'notifications_sound', label: 'Sound', description: 'Play a sound with notifications', value: sound, setter: setSound },
    { key: 'notifications_vibration', label: 'Vibration', description: 'Vibrate device with notifications', value: vibration, setter: setVibration },
  ];

  const permissionDenied = browserPermission === 'denied';

  return (
    <div className="divide-y divide-slate-100 p-1">
      {/* Browser permission status banner */}
      {permissionDenied && (
        <div className="flex items-start gap-2 py-3 px-3 mb-1 bg-red-50 dark:bg-red-950 rounded-lg border border-red-200">
          <ShieldAlert className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-red-700">
            {isNativePush
              ? 'Notifications are blocked. Go to Android Settings → Apps → RxDeliver → Notifications and enable them, then reopen this panel.'
              : 'Notifications are blocked by your browser. Go to your browser\'s site settings and allow notifications for this site, then re-open this panel.'}
          </p>
        </div>
      )}

      {/* Enable push notifications toggle */}
      <div className="flex items-center justify-between py-4">
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Enable Push Notifications</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-500)' }}>
            {browserPermission === 'granted' ? 'Permission granted ✓' : 'Receive alerts even when the app is in the background'}
          </p>
        </div>
        {subscribing
          ? <Loader2 className="w-4 h-4 animate-spin text-slate-400 dark:text-slate-500 dark:text-slate-400" />
          : <Switch
              checked={notificationsEnabled && browserPermission === 'granted'}
              disabled={permissionDenied}
              onCheckedChange={handleEnableToggle}
            />
        }
      </div>

      {/* Re-subscribe button — shown when granted but user wants to refresh */}
      {browserPermission === 'granted' && (
        <div className="flex items-center justify-between py-4">
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Re-register Device</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-500)' }}>Force a fresh push subscription for this device</p>
          </div>
          <Button variant="outline" size="sm" onClick={handleResubscribe} disabled={subscribing}>
            {subscribing ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Refresh'}
          </Button>
        </div>
      )}

      {/* Sound & Vibration */}
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between py-4">
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{row.label}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-500)' }}>{row.description}</p>
          </div>
          <Switch checked={row.value} onCheckedChange={(val) => handleToggle(row.key, val, row.setter)} />
        </div>
      ))}

      {/* ── Push Diagnostics (native only) ───────────────────────────── */}
      {isNativePush && <PushDiagnosticsPanel userId={currentUser.id} />}

      {/* ── Send Test Push ───────────────────────────────────────────── */}
      {browserPermission === 'granted' && <SendTestPush userId={currentUser.id} />}
    </div>
  );
}

// ── Push Diagnostics Panel (native APK only) ──────────────────────────────────
function PushDiagnosticsPanel({ userId }) {
  const [show, setShow] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(null);
  const [reRegistering, setReRegistering] = useState(false);

  const handleRun = async () => {
    setRunning(true);
    try {
      const r = await runPushDiagnostics(userId);
      setReport(r);
      setShow(true);
    } catch (e) {
      toast.error('Diagnostics failed: ' + (e?.message || e));
    } finally {
      setRunning(false);
    }
  };

  const handleForceReRegister = async () => {
    setReRegistering(true);
    try {
      const result = await forceReRegisterNativePush(userId);
      if (result?.ok) {
        toast.success('Re-registration requested. Tap "Run Diagnostics" in ~10s to see results.');
        // Wait a moment then auto-run diagnostics
        setTimeout(() => handleRun(), 10000);
      } else {
        toast.error('Re-register failed: ' + (result?.reason || 'unknown') + (result?.error ? ' — ' + result.error : ''));
        setReport({ registrationResult: result, ...report });
        setShow(true);
      }
    } catch (e) {
      toast.error('Re-register error: ' + (e?.message || e));
    } finally {
      setReRegistering(false);
    }
  };

  return (
    <div className="py-4 border-t border-slate-100 dark:border-slate-800 mt-2">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Push Diagnostics</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-500)' }}>
            Check FCM registration, token status, and subscriptions
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRun} disabled={running}>
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Run'}
          </Button>
          <Button variant="outline" size="sm" onClick={handleForceReRegister} disabled={reRegistering}>
            {reRegistering ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Force Re-register'}
          </Button>
        </div>
      </div>

      {show && report && (
        <div className="mt-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-mono space-y-1">
          <div>Platform: <span className="font-bold">{report.platform || 'unknown'}</span></div>
          <div>Native push available: <span className={report.isNative ? 'text-green-600' : 'text-red-600'}>{String(report.isNative)}</span></div>
          <div>Permission: <span className={report.permission === 'granted' ? 'text-green-600' : 'text-red-600'}>{report.permission}</span></div>
          <div>Plugin loaded: <span className={report.pluginLoaded ? 'text-green-600' : 'text-red-600'}>{String(report.pluginLoaded)}</span></div>
          {report.hasRegisterMethod !== undefined && (
            <div>Has register(): <span className={report.hasRegisterMethod ? 'text-green-600' : 'text-red-600'}>{String(report.hasRegisterMethod)}</span></div>
          )}
          <div>Subscriptions: {report.subscriptions.total} total ({report.subscriptions.fcm} FCM, {report.subscriptions.web} Web Push)</div>
          {report.registrationResult && (
            <div className="pt-1 border-t border-slate-200 dark:border-slate-700 mt-1">
              <div>Last registration: <span className={report.registrationResult.ok === true ? 'text-green-600' : report.registrationResult.ok === null ? 'text-amber-600' : 'text-red-600'}>
                {report.registrationResult.reason || 'unknown'}
              </span></div>
              {report.registrationResult.error && (
                <div className="text-red-600">Error: {report.registrationResult.error}</div>
              )}
              {report.registrationResult.token && (
                <div>Token: {report.registrationResult.token}…</div>
              )}
            </div>
          )}
          {report.errors?.length > 0 && (
            <div className="pt-1 border-t border-slate-200 dark:border-slate-700 mt-1 text-red-600">
              {report.errors.map((e, i) => <div key={i}>⚠ {e}</div>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Send Test Push ────────────────────────────────────────────────────────────
function SendTestPush({ userId }) {
  const [sending, setSending] = useState(false);

  const handleTest = async () => {
    setSending(true);
    try {
      const result = await base44.functions.invoke('sendPushNotification', {
        user_id: userId,
        title: '🧪 RxDeliver Test Push',
        body: 'If you can see this, push notifications are working!',
        url: '/',
        force: true,
      });
      if (result?.sent > 0) {
        toast.success(`✅ ${result.sent} notification(s) sent (${result.fcmSent || 0} FCM, ${result.webSent || 0} Web Push)`);
      } else if (result?.errors?.length > 0) {
        toast.error('❌ No notifications sent. Errors: ' + result.errors.map(e => e.error).join('; '));
      } else {
        toast.warning('⚠️ No subscriptions found — ensure you have registered and logged in.');
      }
    } catch (e) {
      toast.error('Test push failed: ' + (e?.message || e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex items-center justify-between py-4 border-t border-slate-100 dark:border-slate-800">
      <div>
        <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Send Test Push</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-500)' }}>
          Send a test notification to this device
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={handleTest} disabled={sending}>
        {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Test'}
      </Button>
    </div>
  );
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
            className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all text-sm font-medium ${theme === 'light' ? 'border-blue-500' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:border-slate-600'}`}
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
            className={`relative flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all text-sm font-medium overflow-hidden ${theme === 'auto' ? 'border-blue-500' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:border-slate-600'}`}
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
          {['kilometers', 'miles'].map((val) => (
            <button key={val} onClick={() => handleUnits(val)}
              className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 transition-all text-sm font-medium capitalize ${units === val ? 'border-slate-900 bg-slate-50 dark:bg-slate-800' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:border-slate-600'}`}>
              <Ruler className="w-4 h-4" style={{ color: 'var(--text-slate-700)' }} />
              <span style={{ color: 'var(--text-slate-700)' }}>{val}</span>
              {units === val && <Check className="w-3 h-3 text-green-600" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Settings Dialog wrapper ───────────────────────────────────────────────────
export function SettingsDialog({ open, onOpenChange, title, description, icon: Icon, children }) {
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
    </Dialog>
  );
}

// ── Android App Update Check ──────────────────────────────────────────────
// Compares the installed native app's build date (embedded in versionName by
// capacitor/android/app/build.gradle as "1.0 (yyyy-MM-dd HH:mm)") against the
// latest GitHub release's published_at timestamp. Only meaningful inside the
// native Android APK — web/iOS never show an "update" state.
function useAndroidAppUpdateCheck() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [installedVersion, setInstalledVersion] = useState(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!isCapacitorNativeApp() || getCapacitorPlatform() !== 'android') {
        setChecked(true);
        return;
      }
      try {
        const { App } = await import('@capacitor/app');
        const info = await App.getInfo();
        // versionName format: "1.0.N (yyyy-MM-dd HH:mm)" — extract build date AND build number
        const versionStr = info?.version || '';
        const dateMatch = /\((\d{4}-\d{2}-\d{2} \d{2}:\d{2})\)/.exec(versionStr);
        // Extract build number from "1.0.N" pattern (fallback: extract from versionCode)
        const buildMatch = /1\.0\.(\d+)/.exec(versionStr);
        const buildNumber = buildMatch ? buildMatch[1] : null;
        // CRITICAL: The build.gradle date is UTC (GitHub Actions runs in UTC).
        // Without 'Z', JavaScript parses it as LOCAL time, shifting it by the
        // timezone offset and making the installed build appear NEWER than
        // the GitHub release — so "update available" never triggers.
        const installedBuildDate = dateMatch ? new Date(dateMatch[1].replace(' ', 'T') + 'Z') : null;

        if (!cancelled) setInstalledVersion({ buildNumber, buildDate: dateMatch ? dateMatch[1] : null, versionStr });

        const res = await fetch('https://api.github.com/repos/TheWizard1328/Shoppers/releases/tags/apk-latest');
        if (!res.ok) throw new Error('Release not found');
        const data = await res.json();
        const releaseDate = data.published_at ? new Date(data.published_at) : null;

        if (!cancelled && installedBuildDate && releaseDate && releaseDate > installedBuildDate) {
          setUpdateAvailable(true);
        }
      } catch (e) {
        // Silently skip — no update badge shown, not a critical feature
      } finally {
        if (!cancelled) setChecked(true);
      }
    };
    run();
    return () => { cancelled = true; };
  }, []);

  return { updateAvailable, installedVersion, checked };
}

// ── APK Download — state hook ───────────────────────────────────────────────
// Lives outside the SettingsDialog's transformed containing block so the
// status banner (rendered via portal below) survives the dialog closing and
// is never trapped by the dialog's CSS transform (translate-x/y creates a new
// containing block for `position: fixed` descendants — that's what caused the
// old banner to render pinned to a corner of the dialog instead of the
// viewport's top-center).
function useApkDownloadState(apkUrl) {
  const [downloadState, setDownloadState] = useState('idle'); // idle | starting | running | success | failed
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState('');
  const [downloadedUri, setDownloadedUri] = useState('');
  const pollRef = useRef(null);
  const downloadingRef = useRef(false);
  const pendingSinceRef = useRef(null); // timestamp when we first saw 'pending' status
  const [, forceTick] = useState(0); // forces re-render for showBrowserFallback computation

  // Register native callbacks (called from MainActivity.java via evaluateJavascript)
  useEffect(() => {
    window.__apkDownloadComplete = (uri) => {
      downloadingRef.current = false;
      setDownloadState('success');
      setDownloadedUri(uri);
      setDownloadProgress(100);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
    window.__apkDownloadFailed = (reason) => {
      downloadingRef.current = false;
      setDownloadState('failed');
      setDownloadError(reason);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
    return () => {
      delete window.__apkDownloadComplete;
      delete window.__apkDownloadFailed;
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, []);

  // Poll native download status as a backup to the BroadcastReceiver
  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      try {
        if (window.AndroidNative && typeof window.AndroidNative.getDownloadStatus === 'function') {
          const result = JSON.parse(window.AndroidNative.getDownloadStatus());
          if (result.status === 'success') {
            downloadingRef.current = false;
            setDownloadState('success');
            setDownloadedUri(result.uri);
            setDownloadProgress(100);
            pendingSinceRef.current = null;
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          } else if (result.status === 'failed') {
            downloadingRef.current = false;
            setDownloadState('failed');
            setDownloadError(result.reason || 'Unknown error');
            pendingSinceRef.current = null;
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          } else if (result.status === 'running') {
            setDownloadState('running');
            setDownloadProgress(result.progress || 0);
            pendingSinceRef.current = null; // download started — clear pending
          } else if (result.status === 'pending') {
            // DownloadManager queued but not yet started — track how long
            if (!pendingSinceRef.current) pendingSinceRef.current = Date.now();
            setDownloadState('running');
            setDownloadProgress(0);
            forceTick(t => t + 1); // re-render to update showBrowserFallback
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    }, 2000);
  };

  const handleNativeDownload = async (e) => {
    e?.preventDefault?.();
    if (downloadingRef.current || downloadState === 'starting' || downloadState === 'running') return;
    downloadingRef.current = true;
    setDownloadState('starting');
    setDownloadProgress(0);
    setDownloadError('');
    setDownloadedUri('');
    try {
      if (window.AndroidNative && typeof window.AndroidNative.downloadApk === 'function') {
        console.log('[APK Download] Using native JS interface (AndroidNative.downloadApk)');
        window.AndroidNative.downloadApk(apkUrl);
        setDownloadState('running');
        startPolling();
      } else {
        console.log('[APK Download] Falling back to WebView navigation — DownloadListener will intercept');
        toast.success('Starting download…');
        window.location.href = apkUrl;
        setDownloadState('running');
      }
    } catch (err) {
      console.error('[APK Download] Failed:', err);
      downloadingRef.current = false;
      setDownloadState('failed');
      setDownloadError(err.message || 'Unknown error');
      toast.error('Could not start download. Try visiting the link in your browser.');
    }
  };

  const handleOpenDownloadedApk = () => {
    if (downloadedUri && window.AndroidNative && typeof window.AndroidNative.openDownloadedApk === 'function') {
      window.AndroidNative.openDownloadedApk(downloadedUri);
    }
  };

  const handleDismissBanner = () => {
    downloadingRef.current = false;
    setDownloadState('idle');
    setDownloadProgress(0);
    setDownloadError('');
    setDownloadedUri('');
  };

  const showBrowserFallback = downloadState === 'running' && downloadProgress === 0
    && pendingSinceRef.current && (Date.now() - pendingSinceRef.current) > 15000;

  const isDownloading = downloadState === 'starting' || downloadState === 'running';

  return {
    downloadState, downloadProgress, downloadError, downloadedUri,
    pendingSinceRef, showBrowserFallback, isDownloading,
    handleNativeDownload, handleOpenDownloadedApk, handleDismissBanner,
  };
}

// ── APK Download Status Banner ──────────────────────────────────────────────
// Portaled directly to document.body so it always renders relative to the true
// viewport — never trapped inside a transformed ancestor (e.g. the Settings
// dialog's `translate-x/y` centering, which creates a new containing block for
// `position: fixed` descendants). This also means the banner survives the
// dialog being closed, since it's mounted at the Settings page level, not
// inside the (unmounting) dialog content.
function ApkDownloadBanner({ apkUrl, download }) {
  const { downloadState, downloadProgress, downloadError, pendingSinceRef, showBrowserFallback, handleOpenDownloadedApk, handleDismissBanner } = download;

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {downloadState !== 'idle' && (
        <motion.div
          initial={{ opacity: 0, y: -50, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          className="fixed top-[calc(env(safe-area-inset-top,0px)+1rem)] left-1/2 -translate-x-1/2 z-[10002] max-w-md w-[calc(100%-2rem)] rounded-xl border shadow-lg"
          style={{
            background: downloadState === 'success' ? '#f0fdf4'
              : downloadState === 'failed' ? '#fef2f2'
              : '#eff6ff',
            borderColor: downloadState === 'success' ? '#bbf7d0'
              : downloadState === 'failed' ? '#fecaca'
              : '#bfdbfe',
          }}
        >
          <div className="p-4">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 mt-0.5">
                {downloadState === 'success' ? (
                  <Check className="w-5 h-5" style={{ color: '#16a34a' }} />
                ) : downloadState === 'failed' ? (
                  <ShieldAlert className="w-5 h-5" style={{ color: '#dc2626' }} />
                ) : (
                  <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#2563eb' }} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm" style={{ color: downloadState === 'success' ? '#15803d' : downloadState === 'failed' ? '#b91c1c' : '#1e40af' }}>
                  {downloadState === 'success' ? 'Download Complete'
                    : downloadState === 'failed' ? 'Download Failed'
                    : downloadState === 'starting' ? 'Starting Download…'
                    : 'Downloading Update…'}
                </h4>
                <p className="text-sm mt-0.5" style={{ color: downloadState === 'success' ? '#16a34a' : downloadState === 'failed' ? '#dc2626' : '#2563eb' }}>
                  {downloadState === 'success' ? 'RxDeliver APK downloaded successfully. Tap "Open" to install.'
                    : downloadState === 'failed' ? `Error: ${downloadError}. Try downloading from your browser.`
                    : downloadState === 'starting' ? 'Contacting download server…'
                    : downloadProgress > 0 ? `${downloadProgress}% complete`
                  : (pendingSinceRef.current && (Date.now() - pendingSinceRef.current) > 5000) ? 'Queued by system — waiting…'
                  : 'Starting download…'}
                </p>
                {downloadState === 'running' && downloadProgress > 0 && (
                  <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: '#dbeafe' }}>
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${downloadProgress}%`, background: '#2563eb' }} />
                  </div>
                )}
              </div>
              <button onClick={handleDismissBanner} className="flex-shrink-0 p-1 rounded-lg hover:bg-black/5" style={{ color: 'var(--text-slate-400)' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            {showBrowserFallback && (
              <div className="mt-2 flex items-center gap-2 px-1">
                <p className="text-xs flex-1" style={{ color: '#92400e' }}>
                  Download seems stuck. Try opening the link directly:
                </p>
                <a href={apkUrl} target="_blank" rel="noopener" className="text-xs font-medium px-2 py-1 rounded-lg" style={{ background: '#fef3c7', color: '#92400e' }}>
                  Open in browser
                </a>
              </div>
            )}
            {downloadState === 'success' && (
              <div className="mt-3 flex gap-2">
                <Button onClick={handleOpenDownloadedApk} className="flex-1 gap-2" style={{ background: '#16a34a', borderColor: '#16a34a' }}>
                  <Check className="w-4 h-4" /> Open & Install
                </Button>
                <Button onClick={handleDismissBanner} variant="outline" className="px-4">
                  Later
                </Button>
              </div>
            )}
            {downloadState === 'failed' && (
              <div className="mt-3 flex gap-2">
                <a href={apkUrl} className="flex-1">
                  <Button className="w-full gap-2" style={{ background: '#2563eb', borderColor: '#2563eb' }}>
                    <Download className="w-4 h-4" /> Open in Browser
                  </Button>
                </a>
                <Button onClick={handleDismissBanner} variant="outline" className="px-4">
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

// ── APK Download Panel ────────────────────────────────────────────────────────
// Presentational only — the actual download state lives in useApkDownloadState()
// at the Settings page level (see ApkDownloadBanner above) so it survives this
// panel's dialog being closed immediately when the download starts.
function ApkDownloadPanel({ updateAvailable = false, buildInfo = {}, onClose, download } = {}) {
  const { apkUrl, buildText, loaded } = buildInfo;
  const { isDownloading, handleNativeDownload } = download;

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--text-slate-400)' }} />
      </div>
    );
  }

  if (!apkUrl) {
    return (
      <div className="py-4 text-center">
        <ShieldAlert className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--text-slate-400)' }} />
        <p className="text-sm" style={{ color: 'var(--text-slate-500)' }}>No APK build available yet. The build runs automatically on code updates.</p>
      </div>
    );
  }

  const handleClick = (e) => {
    // Close the dialog immediately — the download status banner lives at the
    // Settings page level (portaled to document.body), so it stays visible
    // and keeps tracking progress independent of this dialog's open state.
    onClose?.();
    handleNativeDownload(e);
  };

  return (
    <div className="py-4 space-y-4">
      <div className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-slate-10)' }}>
        <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ background: 'rgba(0, 0, 0, 0.08)' }}>
          <img
            src="https://media.base44.com/images/public/68570f3cd01bfa2d2408a9d6/0aeae1e24_renametoicon-192.png"
            alt="RxDeliver app icon"
            className="w-full h-full object-cover"
            style={{ filter: 'grayscale(1) brightness(0.95)' }}
          />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>RxDeliver Android App</p>
          <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
            {updateAvailable ? 'Update available' : 'Grey icon · Background GPS'}
          </p>
          {buildText && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-400)' }}>{buildText}</p>
          )}
        </div>
      </div>
      {isCapacitorNativeApp() ? (
        <button
          onClick={handleClick}
          disabled={isDownloading}
          className="w-full"
          style={{ background: 'transparent', border: 'none', padding: 0, margin: 0, cursor: isDownloading ? 'wait' : 'pointer' }}
        >
          <Button className="w-full gap-2" style={{ background: '#2563EB', borderColor: '#2563EB' }} disabled={isDownloading}>
            {isDownloading ? <Loader2 className="w-4 h-4 animate-spin" /> : updateAvailable ? <RefreshCw className="w-4 h-4" /> : <Download className="w-4 h-4" />}
            {isDownloading ? 'Downloading…' : updateAvailable ? 'Update APK' : 'Download APK'}
          </Button>
        </button>
      ) : (
        <a href={apkUrl} className="block">
          <Button className="w-full gap-2" style={{ background: '#2563EB', borderColor: '#2563EB' }}>
            {updateAvailable ? <RefreshCw className="w-4 h-4" /> : <Download className="w-4 h-4" />}
            {updateAvailable ? 'Update APK' : 'Download APK'}
          </Button>
        </a>
      )}
      <p className="text-xs text-center" style={{ color: 'var(--text-slate-400)' }}>
        {updateAvailable
          ? 'After download, tap "Open & Install" to update. You may need to allow installs from unknown sources.'
          : 'After download, tap "Open & Install" to install. You may need to allow installs from unknown sources.'}
      </p>
    </div>
  );
}

// ── Build Info Section ───────────────────────────────────────────────────────
// Renders the same shared buildText (from useLatestApkBuildInfo, fetched once
// in the main Settings component) at the bottom of the page.
function BuildInfoSection({ buildText }) {
  if (!buildText) return null;

  return (
    <div className="text-center pt-2 pb-4">
      <p className="text-xs" style={{ color: 'var(--text-slate-400)' }}>{buildText}</p>
    </div>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────────
export default function Settings() {
  const { logout: authLogout } = useAuth();
  const { currentUser } = useUser();
  const [openPanel, setOpenPanel] = useState(null);
  const [userSettings, setUserSettings] = useState(null);
  const [eTransEmail, setETransEmail] = useState('');

  // Detect iOS (iPhone/iPad) to grey out the Native App section.
  // Windows, macOS, Android — all stay fully interactive.
  const { os: deviceOS } = getUserAgentInfo();
  const isIOSDevice = deviceOS === 'iOS';

  // Check if a newer APK build is available on GitHub (only meaningful
  // when running inside the native Android app).
  const { updateAvailable } = useAndroidAppUpdateCheck();
  // Single shared fetch for build number (GitHub Actions run_number) + build
  // date, used by the Native App row, the download dialog, and the bottom
  // build info line — so we don't triple-fetch the same GitHub API calls.
  const apkBuildInfo = useLatestApkBuildInfo();
  // Download state lives here (Settings page level) — NOT inside the dialog —
  // so the status banner survives the dialog being closed immediately when
  // the download starts, and so the banner portal always renders relative to
  // the true viewport (never trapped by the dialog's transform).
  const apkDownload = useApkDownloadState(apkBuildInfo?.apkUrl);

  useEffect(() => {
    if (currentUser?.id) loadUserSettings(currentUser.id).then(setUserSettings);
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser?.id) return;
    base44.entities.AppUser.filter({ user_id: currentUser.id }, null, null, null, 'id,user_id,user_name,app_roles,status,driver_status,driver_id,driver_name,store_ids,city_id,city_ids,home_latitude,home_longitude,current_latitude,current_longitude,location_tracking_enabled,location_updated_at,preferred_travel_mode,sort_order,role,full_name,created_date,updated_date,ETrans_Email').then((appUsers) => {
      if (appUsers?.length > 0) {
        const email = appUsers[0].ETrans_Email || '';
        setETransEmail(email);
        // Drivers without an e-Transfer email: auto-open profile to prompt them to add it
        const isDriverOnly = Array.isArray(appUsers[0].app_roles) &&
          appUsers[0].app_roles.includes('driver') &&
          !appUsers[0].app_roles.includes('admin');
        if (isDriverOnly && !email) {
          setOpenPanel('profile');
        }
      }
    }).catch(() => {});
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
        { label: 'Email', description: currentUser?.email || 'Not available', eTransEmail: eTransEmail || 'Not set', disabled: true, isEmailRow: true, hideETransfer: Array.isArray(currentUser?.app_roles) && currentUser.app_roles.includes('dispatcher') && !currentUser.app_roles.includes('admin') && !currentUser.app_roles.includes('driver') },
      ],
    },
    {
      key: 'notifications',
      title: 'Notifications',
      icon: Bell,
      items: [
        { label: 'Push Notifications', description: 'Manage notification preferences', onClick: () => setOpenPanel('notifications') },
      ],
    },
    {
      key: 'appearance',
      title: 'Appearance',
      icon: Moon,
      items: [
        {
          label: 'Theme & Units',
          description: userSettings
            ? `${userSettings.theme_preference || 'auto'} · ${userSettings.units_of_measurement || 'kilometers'}`
            : 'Light, Dark, or System',
          onClick: () => setOpenPanel('appearance'),
        },
      ],
    },
    {
      key: 'devices',
      title: 'Devices',
      icon: Smartphone,
      items: [
        { label: 'Manage Devices', description: 'View and manage connected devices', onClick: () => setOpenPanel('devices') },
      ],
    },
    {
      key: 'app',
      title: 'Native App',
      icon: Download,
      disabled: isIOSDevice,
      items: [
        {
          label: updateAvailable ? 'Update Android App' : 'Download Android App',
          description: isIOSDevice
            ? 'Not available on iOS'
            : updateAvailable
              ? 'A newer build is available — tap to update'
              : 'Install the native APK (Grey Icon)',
          subDescription: isIOSDevice ? undefined : apkBuildInfo.buildText,
          onClick: isIOSDevice ? undefined : () => setOpenPanel('apk'),
          disabled: isIOSDevice,
          showUpdateBadge: updateAvailable,
        },
      ],
    },
  ];

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
            <Card key={section.key} className={section.disabled ? 'opacity-50' : ''} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
                  <SectionIcon className="w-4 h-4" />
                  {section.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {section.items.map((item, i) => {
                  if (item.isEmailRow) {
                    return (
                      <div key={i} className="flex items-center gap-2 px-3 py-3 opacity-60">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium" style={{ color: 'var(--text-slate-500)' }}>Email</p>
                          <p className="text-sm truncate" style={{ color: 'var(--text-slate-900)' }}>{item.description}</p>
                        </div>
                        {!item.hideETransfer && (
                          <>
                            <div className="w-px self-stretch" style={{ background: 'var(--border-slate-200)' }} />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-medium" style={{ color: 'var(--text-slate-500)' }}>e-Transfer Email</p>
                              <p className="text-sm truncate" style={{ color: 'var(--text-slate-900)' }}>{item.eTransEmail}</p>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  }
                  return (
                    <button
                      key={i}
                      onClick={item.onClick}
                      disabled={item.disabled}
                      className={`w-full flex items-center justify-between px-3 py-3 rounded-lg transition-colors text-left select-none ${item.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-800 active:bg-slate-100'}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{item.label}</p>
                          {item.showUpdateBadge && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold text-white" style={{ background: '#2563EB' }}>
                              <RefreshCw className="w-2.5 h-2.5" />
                              New
                            </span>
                          )}
                        </div>
                        {item.description && <p className="text-sm truncate" style={{ color: 'var(--text-slate-500)' }}>{item.description}</p>}
                        {item.subDescription && <p className="text-xs truncate" style={{ color: 'var(--text-slate-400)' }}>{item.subDescription}</p>}
                      </div>
                      {!item.disabled && <ChevronRight className="w-4 h-4 text-slate-400 dark:text-slate-500 dark:text-slate-400 flex-shrink-0 ml-2" />}
                    </button>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}

        {/* Sign Out */}
        <Card style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <CardContent className="p-4">
            <Button onClick={() => authLogout(true)} variant="outline" className="w-full justify-start gap-2 select-none">
              <LogOut className="w-4 h-4" /> Sign Out
            </Button>
          </CardContent>
        </Card>

        <AccountDeletionSection />

        {/* Build Info */}
        <BuildInfoSection buildText={apkBuildInfo.buildText} />
      </div>

      {/* ── Dialogs ── */}
      <SettingsDialog open={openPanel === 'profile'} onOpenChange={(o) => !o && setOpenPanel(null)} title="Account" description="Update your display name and phone number." icon={User}>
        <ProfilePanel currentUser={currentUser} onClose={() => { setOpenPanel(null); base44.entities.AppUser.filter({ user_id: currentUser.id }).then((au) => { if (au?.length > 0) setETransEmail(au[0].ETrans_Email || ''); }).catch(() => {}); }} />
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
      <SettingsDialog open={openPanel === 'apk'} onOpenChange={(o) => !o && setOpenPanel(null)} title={updateAvailable ? 'Update Android App' : 'Native App'} description={updateAvailable ? 'A newer build is available.' : 'Download the Android APK.'} icon={updateAvailable ? RefreshCw : Download}>
        <ApkDownloadPanel updateAvailable={updateAvailable} buildInfo={apkBuildInfo} onClose={() => setOpenPanel(null)} download={apkDownload} />
      </SettingsDialog>
      {/* Portaled to document.body — renders at true viewport top-center regardless
          of dialog open/closed state or any transformed ancestor. */}
      <ApkDownloadBanner apkUrl={apkBuildInfo?.apkUrl} download={apkDownload} />
    </div>
  );
}