import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { base44 } from '@/api/base44Client';
import { useAuth } from '@/lib/AuthContext';
import { isCapacitorNativeApp, getCapacitorPlatform } from '@/components/utils/locationProviders/capacitorRuntime';
import { getUserAgentInfo } from '@/components/utils/deviceUtils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  User, Bell, Moon, Smartphone, Monitor, LogOut, ChevronRight,
  Sun, Check, Ruler, Save, Loader2, ShieldAlert, Download, RefreshCw,
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
  const [browserPermission, setBrowserPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const [subscribing, setSubscribing] = useState(false);

  const handleToggle = async (key, value, setter) => {
    setter(value);
    await saveSetting(currentUser.id, key, value);
    toast.success('Preference saved');
  };

  const handleEnableToggle = async (val) => {
    if (val && browserPermission !== 'granted') {
      // Ask browser for permission and subscribe
      setSubscribing(true);
      try {
        await initPushNotifications(currentUser.id);
        const newPermission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
        setBrowserPermission(newPermission);
        if (newPermission === 'granted') {
          setNotificationsEnabled(true);
          await saveSetting(currentUser.id, 'notifications_enabled', true);
          toast.success('Push notifications enabled');
        } else {
          toast.error('Permission not granted — please allow notifications in your browser settings');
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
      const newPermission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
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
            Notifications are blocked by your browser. Go to your browser's site settings and allow notifications for this site, then re-open this panel.
          </p>
        </div>
      )}

      {/* Enable push notifications toggle */}
      <div className="flex items-center justify-between py-4">
        <div>
          <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>Enable Push Notifications</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-slate-500)' }}>
            {browserPermission === 'granted' ? 'Browser permission granted ✓' : 'Receive alerts even when the app is in the background'}
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

// ── Shared Build Info (release date + Actions run number) ─────────────────
// Build number comes from the GitHub Actions API (latest successful
// "Build Android APK" run's run_number) rather than the release body, so it
// works without needing to edit the workflow file (blocked — PAT lacks the
// `workflow` scope needed to push changes to .github/workflows/*).
function useLatestApkBuildInfo() {
  const [buildInfo, setBuildInfo] = useState(null); // { dateStr, buildNumber, apkUrl, rawDate }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch('https://api.github.com/repos/TheWizard1328/Shoppers/releases/tags/apk-latest').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('https://api.github.com/repos/TheWizard1328/Shoppers/actions/workflows/build-apk.yml/runs?status=success&per_page=1').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([releaseData, runsData]) => {
      if (cancelled) return;
      const rawDate = releaseData?.published_at || releaseData?.created_at || null;
      const dateStr = rawDate
        ? new Date(rawDate).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      const buildNumber = runsData?.workflow_runs?.[0]?.run_number || null;
      const apkAsset = (releaseData?.assets || []).find((a) => a.name && a.name.endsWith('.apk'));
      setBuildInfo({
        dateStr,
        rawDate,
        buildNumber,
        apkUrl: apkAsset?.browser_download_url || null,
      });
    });
    return () => { cancelled = true; };
  }, []);

  const buildText = buildInfo
    ? buildInfo.buildNumber
      ? `Built: v1.0.${buildInfo.buildNumber} · ${buildInfo.dateStr}`
      : buildInfo.dateStr
        ? `Built: ${buildInfo.dateStr}`
        : ''
    : '';

  return { ...buildInfo, buildText, loaded: !!buildInfo };
}

// ── APK Download Panel ────────────────────────────────────────────────────────
function ApkDownloadPanel({ updateAvailable = false, buildInfo = {} } = {}) {
  const { apkUrl, buildText, loaded } = buildInfo;

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

  return (
    <div className="py-4 space-y-4">
      <div className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-slate-50)' }}>
        <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ background: '#6B7280' }}>
          <img
            src="https://base44.app/api/apps/69f0c6983e41b169cdc3be5b/files/mp/public/69f0c6983e41b169cdc3be5b/ac8712c0b_rxdeliver_icon.png"
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
      <a
        href={apkUrl}
        download={isCapacitorNativeApp() ? undefined : 'RxDeliver.apk'}
        className="block"
      >
        <Button className="w-full gap-2" style={{ background: '#2563EB', borderColor: '#2563EB' }}>
          {updateAvailable ? <RefreshCw className="w-4 h-4" /> : <Download className="w-4 h-4" />}
          {updateAvailable ? 'Update APK' : 'Download APK'}
        </Button>
      </a>
      <p className="text-xs text-center" style={{ color: 'var(--text-slate-400)' }}>
        {updateAvailable
          ? 'After download, open the file to install the update. You may need to allow installs from unknown sources.'
          : 'After download, open the file to install. You may need to allow installs from unknown sources.'}
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
        <ApkDownloadPanel updateAvailable={updateAvailable} buildInfo={apkBuildInfo} />
      </SettingsDialog>
    </div>
  );
}