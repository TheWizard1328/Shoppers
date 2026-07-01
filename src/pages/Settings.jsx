import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { base44 } from '@/api/base44Client';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  User, Bell, Moon, Smartphone, Monitor, LogOut, ChevronRight,
  Sun, Check, Ruler, Save, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useUser } from '@/components/utils/UserContext';
import AccountDeletionSection from '@/components/settings/AccountDeletionSection';
import { loadUserSettings, saveSetting } from '@/components/utils/userSettingsManager';
import DevicesPanel from '@/components/devices/DevicesPanel';

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';

// ── Profile Panel ─────────────────────────────────────────────────────────────
function ProfilePanel({ currentUser, onClose }) {
  const [displayName, setDisplayName] = useState(currentUser?.user_name || currentUser?.full_name || '');
  const [phone, setPhone] = useState(currentUser?.phone || '');
  const [eTransEmail, setETransEmail] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!currentUser?.id) return;
    base44.entities.AppUser.filter({ user_id: currentUser.id }).then((appUsers) => {
      if (appUsers?.length > 0) setETransEmail(appUsers[0].ETrans_Email || '');
    }).catch(() => {});
  }, [currentUser?.id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
      if (appUsers?.length > 0) {
        await base44.entities.AppUser.update(appUsers[0].id, { user_name: displayName, phone, ETrans_Email: eTransEmail });
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
        <p className="text-xs text-slate-400">Email cannot be changed here.</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="phone">Phone Number</Label>
        <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 (555) 000-0000" type="tel" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="eTransEmail">e-Transfer Email</Label>
        <Input id="eTransEmail" value={eTransEmail} onChange={(e) => setETransEmail(e.target.value)} placeholder="your@email.com" type="email" />
        <p className="text-xs text-slate-400">Used for Interac e-Transfer payroll payments.</p>
      </div>
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

  const handleToggle = async (key, value, setter) => {
    setter(value);
    await saveSetting(currentUser.id, key, value);
    toast.success('Preference saved');
  };

  const rows = [
    { key: 'notifications_enabled', label: 'Enable Notifications', description: 'Receive in-app alerts and updates', value: notificationsEnabled, setter: setNotificationsEnabled },
    { key: 'notifications_sound', label: 'Sound', description: 'Play a sound with notifications', value: sound, setter: setSound },
    { key: 'notifications_vibration', label: 'Vibration', description: 'Vibrate device with notifications', value: vibration, setter: setVibration },
  ];

  return (
    <div className="divide-y divide-slate-100 p-1">
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
          {['kilometers', 'miles'].map((val) => (
            <button key={val} onClick={() => handleUnits(val)}
              className={`flex items-center justify-center gap-2 p-3 rounded-xl border-2 transition-all text-sm font-medium capitalize ${units === val ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:border-slate-300'}`}>
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
    </Dialog>
  );
}

// ── Main Settings Page ────────────────────────────────────────────────────────
export default function Settings() {
  const { currentUser } = useUser();
  const [openPanel, setOpenPanel] = useState(null);
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
        { label: 'Email', description: currentUser?.email || 'Not available', disabled: true },
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
            <Card key={section.key} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-700)' }}>
                  <SectionIcon className="w-4 h-4" />
                  {section.title}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {section.items.map((item, i) => (
                  <button
                    key={i}
                    onClick={item.onClick}
                    disabled={item.disabled}
                    className={`w-full flex items-center justify-between px-3 py-3 rounded-lg transition-colors text-left select-none ${item.disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-50 active:bg-slate-100'}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>{item.label}</p>
                      {item.description && <p className="text-sm truncate" style={{ color: 'var(--text-slate-500)' }}>{item.description}</p>}
                    </div>
                    {!item.disabled && <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0 ml-2" />}
                  </button>
                ))}
              </CardContent>
            </Card>
          );
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

      {/* ── Dialogs ── */}
      <SettingsDialog open={openPanel === 'profile'} onOpenChange={(o) => !o && setOpenPanel(null)} title="Account" description="Update your display name and phone number." icon={User}>
        <ProfilePanel currentUser={currentUser} onClose={() => setOpenPanel(null)} />
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
    </div>
  );
}