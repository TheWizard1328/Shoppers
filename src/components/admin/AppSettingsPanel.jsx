import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Settings, Save, RefreshCw, Loader2, Clock, AlertCircle, RotateCcw, Power, MapPinned, KeyRound } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { smartRefreshManager } from '../utils/smartRefreshManager';

// Default refresh intervals (in milliseconds)
const DEFAULT_INTERVALS = {
  driverLocation: 30000,      // 30s
  activeDeliveries: 30000,    // 30s
  todayDeliveries: 45000,     // 45s
  appUsers: 60000,            // 60s
  todayPatients: 120000,      // 2min
  patients: 900000,           // 15min
  stores: 1800000,            // 30min
  unifiedRefreshTick: 45000,  // 45s - Layout unified refresh interval
  messageNotifications: 90000, // 90s
  unreadMessageCount: 600000  // 10min
};

// Human-readable labels for each interval
const INTERVAL_LABELS = {
  driverLocation: 'Driver GPS Locations',
  activeDeliveries: 'Active Delivery Statuses',
  todayDeliveries: "Today's Deliveries",
  appUsers: 'App Users (Driver Status)',
  todayPatients: "Today's Route Patients",
  patients: 'All Patients (Background)',
  stores: 'Stores (Background)',
  unifiedRefreshTick: 'Main Refresh Cycle',
  messageNotifications: 'Message Notifications',
  unreadMessageCount: 'Unread Message Badge'
};

// Priority levels for display
const PRIORITY_LEVELS = {
  driverLocation: 'high',
  activeDeliveries: 'high',
  todayDeliveries: 'high',
  appUsers: 'high',
  todayPatients: 'medium',
  patients: 'low',
  stores: 'low',
  unifiedRefreshTick: 'system',
  messageNotifications: 'medium',
  unreadMessageCount: 'low'
};

const formatInterval = (ms) => {
  if (ms >= 60000) {
    const mins = ms / 60000;
    return `${mins} min${mins !== 1 ? 's' : ''}`;
  }
  return `${ms / 1000}s`;
};

const IntervalSlider = ({ id, label, value, onChange, min, max, step, priority }) => {
  const priorityColors = {
    high: 'bg-red-100 text-red-800',
    medium: 'bg-yellow-100 text-yellow-800',
    low: 'bg-green-100 text-green-800',
    system: 'bg-blue-100 text-blue-800'
  };

  return (
    <div className="space-y-2 p-3 bg-slate-50 rounded-lg">
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="font-medium text-slate-700">{label}</Label>
        <div className="flex items-center gap-2">
          <Badge className={priorityColors[priority] || 'bg-slate-100 text-slate-800'}>
            {priority}
          </Badge>
          <Badge variant="outline" className="font-mono">
            {formatInterval(value)}
          </Badge>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Slider
          id={id}
          value={[value]}
          onValueChange={([v]) => onChange(v)}
          min={min}
          max={max}
          step={step}
          className="flex-1"
        />
        <Input
          type="number"
          value={value / 1000}
          onChange={(e) => onChange(parseInt(e.target.value) * 1000 || min)}
          className="w-20 text-right font-mono"
          min={min / 1000}
          max={max / 1000}
        />
        <span className="text-xs text-slate-500 w-4">sec</span>
      </div>
    </div>
  );
};

export default function AppSettingsPanel() {
  const [intervals, setIntervals] = useState(DEFAULT_INTERVALS);
  const [smartRefreshEnabled, setSmartRefreshEnabled] = useState(() => smartRefreshManager._enabled);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [savedIntervals, setSavedIntervals] = useState(null);
  const [savedSmartRefreshEnabled, setSavedSmartRefreshEnabled] = useState(() => smartRefreshManager._enabled);
  const [lastRefreshTimes, setLastRefreshTimes] = useState({});
  const [appVersion, setAppVersion] = useState({ major: 1, minor: 0, build: 0 });
  const [savedAppVersion, setSavedAppVersion] = useState({ major: 1, minor: 0, build: 0 });
  const [appFeesPerDelivery, setAppFeesPerDelivery] = useState('0.00');
  const [savedAppFees, setSavedAppFees] = useState('0.00');
  const [selectedApiKey, setSelectedApiKey] = useState('HERE_API_KEY');
  const [savedSelectedApiKey, setSavedSelectedApiKey] = useState('HERE_API_KEY');

  // Load settings from database
  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      if (smartRefreshManager._initialized) {
        setSmartRefreshEnabled(smartRefreshManager._enabled);
        setSavedSmartRefreshEnabled(smartRefreshManager._enabled);
      }
      
      const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      if (settings && settings.length > 0 && settings[0].setting_value) {
        const loaded = { ...DEFAULT_INTERVALS, ...settings[0].setting_value };
        setIntervals(loaded);
        setSavedIntervals(loaded);
        
        // Load version from settings
        if (settings[0].setting_value.appVersion) {
          setAppVersion(settings[0].setting_value.appVersion);
          setSavedAppVersion(settings[0].setting_value.appVersion);
        }
        
        // Load app fees from settings
        if (settings[0].setting_value.app_fees_per_delivery !== undefined) {
          const fees = parseFloat(settings[0].setting_value.app_fees_per_delivery).toFixed(2);
          setAppFeesPerDelivery(fees);
          setSavedAppFees(fees);
        }

        const activeApiKey = settings[0].setting_value.selected_api_key
          || settings[0].setting_value.selected_here_api_key
          || settings[0].setting_value.selected_google_maps_api_key
          || 'HERE_API_KEY';
        setSelectedApiKey(activeApiKey);
        setSavedSelectedApiKey(activeApiKey);
        
        if (!smartRefreshManager._initialized) {
          const enabled = settings[0].setting_value.smartRefreshEnabled !== false;
          setSmartRefreshEnabled(enabled);
          setSavedSmartRefreshEnabled(enabled);
          smartRefreshManager._enabled = enabled;
          smartRefreshManager._initialized = true;
        }
      } else {
        setIntervals(DEFAULT_INTERVALS);
        setSavedIntervals(DEFAULT_INTERVALS);
        setSelectedApiKey('HERE_API_KEY');
        setSavedSelectedApiKey('HERE_API_KEY');
        if (!smartRefreshManager._initialized) {
          setSmartRefreshEnabled(true);
          setSavedSmartRefreshEnabled(true);
        }
      }
    } catch (error) {
      console.error('Failed to load app settings:', error);
      setIntervals(DEFAULT_INTERVALS);
      setSavedIntervals(DEFAULT_INTERVALS);
      setSelectedHereApiKey('HERE_API_KEY');
      setSavedSelectedHereApiKey('HERE_API_KEY');
      setSelectedGoogleMapsApiKey('GOOGLE_MAPS_API_KEY');
      setSavedSelectedGoogleMapsApiKey('GOOGLE_MAPS_API_KEY');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const updateRefreshTimes = () => {
      setLastRefreshTimes({ ...smartRefreshManager.lastRefreshTimes });
    };
    updateRefreshTimes();
    const interval = setInterval(updateRefreshTimes, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (savedIntervals) {
      const intervalsChanged = Object.keys(intervals).some(key => intervals[key] !== savedIntervals[key]);
      const enabledChanged = smartRefreshEnabled !== savedSmartRefreshEnabled;
      const versionChanged = appVersion.major !== savedAppVersion.major || 
                            appVersion.minor !== savedAppVersion.minor || 
                            appVersion.build !== savedAppVersion.build;
      const feesChanged = appFeesPerDelivery !== savedAppFees;
      const apiKeyChanged = selectedApiKey !== savedSelectedApiKey;
      setHasChanges(intervalsChanged || enabledChanged || versionChanged || feesChanged || apiKeyChanged);
    }
  }, [intervals, savedIntervals, smartRefreshEnabled, savedSmartRefreshEnabled, appVersion, savedAppVersion, appFeesPerDelivery, savedAppFees, selectedApiKey, savedSelectedApiKey]);

  const handleIntervalChange = (key, value) => {
    setIntervals(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const settingsToSave = {
        ...intervals,
        smartRefreshEnabled: smartRefreshEnabled,
        appVersion: appVersion,
        app_fees_per_delivery: parseFloat(appFeesPerDelivery),
        selected_api_key: selectedApiKey
      };

      const existing = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      
      if (existing && existing.length > 0) {
        await base44.entities.AppSettings.update(existing[0].id, {
          setting_value: settingsToSave,
          description: 'Smart refresh interval and app version settings'
        });
      } else {
        await base44.entities.AppSettings.create({
          setting_key: 'refresh_intervals',
          setting_value: settingsToSave,
          description: 'Smart refresh interval and app version settings'
        });
      }

      smartRefreshManager._enabled = smartRefreshEnabled;
      smartRefreshManager._initialized = true;
      smartRefreshManager.intervals = {
        driverLocation: intervals.driverLocation,
        activeDeliveries: intervals.activeDeliveries,
        todayDeliveries: intervals.todayDeliveries,
        appUsers: intervals.appUsers,
        todayPatients: intervals.todayPatients,
        patients: intervals.patients,
        stores: intervals.stores
      };

      setSavedIntervals({ ...intervals });
      setSavedSmartRefreshEnabled(smartRefreshEnabled);
      setSavedAppVersion({ ...appVersion });
      setSavedAppFees(appFeesPerDelivery);
      setSavedSelectedApiKey(selectedApiKey);
      setHasChanges(false);
      alert('Settings saved successfully! Other users will see the new version on their next refresh.');
    } catch (error) {
      console.error('Failed to save app settings:', error);
      alert('Failed to save settings: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetToDefaults = () => {
    if (window.confirm('Reset all intervals to default values?')) {
      setIntervals(DEFAULT_INTERVALS);
    }
  };

  const handleIncrementBuild = async () => {
    const newVersion = { ...appVersion, build: appVersion.build + 1 };
    setAppVersion(newVersion);
    
    // Auto-save to database immediately
    try {
      const existing = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      const currentSettings = existing?.[0]?.setting_value || {};
      const updatedSettings = { ...currentSettings, appVersion: newVersion };
      
      if (existing && existing.length > 0) {
        await base44.entities.AppSettings.update(existing[0].id, {
          setting_value: updatedSettings
        });
      } else {
        await base44.entities.AppSettings.create({
          setting_key: 'refresh_intervals',
          setting_value: updatedSettings,
          description: 'Smart refresh interval and app version settings'
        });
      }
      setSavedAppVersion(newVersion);
      alert(`Build incremented to v${newVersion.major}.${newVersion.minor}.${newVersion.build}`);
    } catch (error) {
      console.error('Failed to save version:', error);
      alert('Failed to save version: ' + error.message);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-500 mr-2" />
          <span className="text-slate-600">Loading settings...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="w-5 h-5" />
              App Version
            </CardTitle>
            <CardDescription>
              Manage application version (Major.Minor.Build) - all users will see this after they refresh
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div>
                <Label htmlFor="major" className="text-sm font-medium">Major</Label>
                <Input
                  id="major"
                  type="number"
                  min="0"
                  value={appVersion.major}
                  onChange={(e) => setAppVersion(prev => ({ ...prev, major: parseInt(e.target.value) || 0 }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="minor" className="text-sm font-medium">Minor</Label>
                <Input
                  id="minor"
                  type="number"
                  min="0"
                  value={appVersion.minor}
                  onChange={(e) => setAppVersion(prev => ({ ...prev, minor: parseInt(e.target.value) || 0 }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="build" className="text-sm font-medium">Build</Label>
                <Input
                  id="build"
                  type="number"
                  min="0"
                  value={appVersion.build}
                  onChange={(e) => setAppVersion(prev => ({ ...prev, build: parseInt(e.target.value) || 0 }))}
                  className="mt-1"
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-2xl font-mono font-bold text-slate-900">
                v{appVersion.major}.{appVersion.minor}.{appVersion.build}
              </div>
              <Button 
                variant="outline" 
                onClick={handleIncrementBuild}
                className="gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Increment Build
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className={!smartRefreshEnabled ? 'border-red-300 bg-red-50' : ''}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Power className={`w-5 h-5 ${smartRefreshEnabled ? 'text-emerald-500' : 'text-red-500'}`} />
            Smart Refresh
          </CardTitle>
          <CardDescription>
            Master toggle to enable or disable all automatic data refreshing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between p-4 bg-white rounded-lg border">
            <div>
              <Label className="font-medium text-slate-900">Enable Smart Refresh</Label>
              <p className="text-sm text-slate-500">
                {smartRefreshEnabled 
                  ? 'Data will automatically refresh in the background' 
                  : 'All automatic refreshing is disabled - data will only update on page reload'}
              </p>
            </div>
            <Switch
              checked={smartRefreshEnabled}
              onCheckedChange={async (checked) => {
                setSmartRefreshEnabled(checked);
                smartRefreshManager._enabled = checked;
                smartRefreshManager._initialized = true;
                
                try {
                  const existing = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
                  const currentSettings = existing?.[0]?.setting_value || {};
                  const updatedSettings = { ...currentSettings, smartRefreshEnabled: checked, appVersion: appVersion };
                  
                  if (existing && existing.length > 0) {
                    await base44.entities.AppSettings.update(existing[0].id, {
                      setting_value: updatedSettings
                    });
                  } else {
                    await base44.entities.AppSettings.create({
                      setting_key: 'refresh_intervals',
                      setting_value: updatedSettings,
                      description: 'Smart refresh interval and app version settings'
                    });
                  }
                  setSavedSmartRefreshEnabled(checked);
                } catch (error) {
                  console.error('Failed to save smart refresh toggle:', error);
                }
              }}
            />
          </div>
          {!smartRefreshEnabled && (
            <div className="mt-3 p-3 bg-red-100 text-red-800 rounded-lg text-sm font-medium">
              ⚠️ Smart Refresh is DISABLED. The app will not automatically update data.
            </div>
          )}
        </CardContent>
      </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPinned className="w-5 h-5" />
              API Provider Keys
            </CardTitle>
            <CardDescription>
              Choose the single active API key from all saved mapping API keys.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <Label className="text-sm font-medium mb-1.5 block">Active Maps API Key</Label>
                <Select value={selectedApiKey} onValueChange={setSelectedApiKey}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select active API key" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="HERE_API_KEY">HERE_API_KEY</SelectItem>
                    <SelectItem value="Here_API_Key_2">Here_API_Key_2</SelectItem>
                    <SelectItem value="GOOGLE_MAPS_API_KEY">GOOGLE_MAPS_API_KEY</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="rounded-lg border bg-slate-50 p-3 text-xs text-slate-600 flex items-start gap-2">
                <KeyRound className="w-4 h-4 mt-0.5 text-slate-500" />
                <span>The dropdown always shows the API key currently saved as active.</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="w-5 h-5" />
              Other Admin Settings
            </CardTitle>
            <CardDescription>
              Configure app-wide administrative settings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <Label htmlFor="app_fees" className="text-sm font-medium mb-1.5 block">
                  App Fees (Cost per Delivery)
                </Label>
                <div className="flex items-center gap-2">
                  <span className="text-slate-700 font-medium">$</span>
                  <Input
                    id="app_fees"
                    type="number"
                    step="0.01"
                    min="0"
                    value={appFeesPerDelivery}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '' || /^\d*\.?\d{0,2}$/.test(val)) {
                        setAppFeesPerDelivery(val);
                      }
                    }}
                    onBlur={(e) => {
                      const parsed = parseFloat(e.target.value) || 0;
                      setAppFeesPerDelivery(parsed.toFixed(2));
                    }}
                    placeholder="0.00"
                    className="w-32"
                  />
                  <span className="text-sm text-slate-500">per finished delivery</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  This fee will be used to calculate monthly charges for stores that are marked as paying app fees.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="max-h-[60vh] overflow-y-auto pr-2 space-y-6">
      <Card className={!smartRefreshEnabled ? 'opacity-50 pointer-events-none' : ''}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5" />
            Refresh Interval Settings
          </CardTitle>
          <CardDescription>
            Configure how often different types of data are refreshed. Lower values = more real-time but higher API usage.
            <br />
            <span className="text-amber-600 font-medium">⚠️ Warning: Setting intervals too low may cause rate limiting (429 errors).</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-4 text-sm">
            <span className="font-medium text-slate-700">Priority:</span>
            <Badge className="bg-red-100 text-red-800">high</Badge>
            <span className="text-slate-500">= Real-time critical</span>
            <Badge className="bg-yellow-100 text-yellow-800">medium</Badge>
            <span className="text-slate-500">= Important</span>
            <Badge className="bg-green-100 text-green-800">low</Badge>
            <span className="text-slate-500">= Background</span>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold text-slate-900 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-500" />
              High Priority (Real-time Map Updates)
            </h3>
            <div className="grid gap-3">
              <IntervalSlider
                id="driverLocation"
                label={INTERVAL_LABELS.driverLocation}
                value={intervals.driverLocation}
                onChange={(v) => handleIntervalChange('driverLocation', v)}
                min={10000}
                max={120000}
                step={5000}
                priority="high"
              />
              <IntervalSlider
                id="activeDeliveries"
                label={INTERVAL_LABELS.activeDeliveries}
                value={intervals.activeDeliveries}
                onChange={(v) => handleIntervalChange('activeDeliveries', v)}
                min={10000}
                max={120000}
                step={5000}
                priority="high"
              />
              <IntervalSlider
                id="todayDeliveries"
                label={INTERVAL_LABELS.todayDeliveries}
                value={intervals.todayDeliveries}
                onChange={(v) => handleIntervalChange('todayDeliveries', v)}
                min={15000}
                max={180000}
                step={5000}
                priority="high"
              />
              <IntervalSlider
                id="appUsers"
                label={INTERVAL_LABELS.appUsers}
                value={intervals.appUsers}
                onChange={(v) => handleIntervalChange('appUsers', v)}
                min={15000}
                max={180000}
                step={5000}
                priority="high"
              />
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold text-slate-900">Medium Priority</h3>
            <div className="grid gap-3">
              <IntervalSlider
                id="todayPatients"
                label={INTERVAL_LABELS.todayPatients}
                value={intervals.todayPatients}
                onChange={(v) => handleIntervalChange('todayPatients', v)}
                min={30000}
                max={300000}
                step={10000}
                priority="medium"
              />
              <IntervalSlider
                id="messageNotifications"
                label={INTERVAL_LABELS.messageNotifications}
                value={intervals.messageNotifications}
                onChange={(v) => handleIntervalChange('messageNotifications', v)}
                min={30000}
                max={300000}
                step={10000}
                priority="medium"
              />
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold text-slate-900">Low Priority (Background)</h3>
            <div className="grid gap-3">
              <IntervalSlider
                id="patients"
                label={INTERVAL_LABELS.patients}
                value={intervals.patients}
                onChange={(v) => handleIntervalChange('patients', v)}
                min={60000}
                max={1800000}
                step={60000}
                priority="low"
              />
              <IntervalSlider
                id="stores"
                label={INTERVAL_LABELS.stores}
                value={intervals.stores}
                onChange={(v) => handleIntervalChange('stores', v)}
                min={60000}
                max={3600000}
                step={60000}
                priority="low"
              />
              <IntervalSlider
                id="unreadMessageCount"
                label={INTERVAL_LABELS.unreadMessageCount}
                value={intervals.unreadMessageCount}
                onChange={(v) => handleIntervalChange('unreadMessageCount', v)}
                min={60000}
                max={1800000}
                step={60000}
                priority="low"
              />
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-semibold text-slate-900">System (Layout)</h3>
            <div className="grid gap-3">
              <IntervalSlider
                id="unifiedRefreshTick"
                label={INTERVAL_LABELS.unifiedRefreshTick}
                value={intervals.unifiedRefreshTick}
                onChange={(v) => handleIntervalChange('unifiedRefreshTick', v)}
                min={15000}
                max={120000}
                step={5000}
                priority="system"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-4 border-t">
            <Button 
              variant="outline" 
              onClick={handleResetToDefaults}
              className="gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Reset to Defaults
            </Button>
            <div className="flex items-center gap-3">
              {hasChanges && (
                <span className="text-sm text-amber-600 font-medium">Unsaved changes</span>
              )}
              <Button 
                onClick={handleSave} 
                disabled={isSaving || !hasChanges}
                className="gap-2"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {isSaving ? 'Saving...' : 'Save Settings'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="w-5 h-5" />
            Current Refresh Status
          </CardTitle>
          <CardDescription>
            Live view of when each entity type was last refreshed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.keys(lastRefreshTimes).map(key => {
              const lastTime = lastRefreshTimes[key];
              const timeSince = lastTime ? Math.round((Date.now() - lastTime) / 1000) : null;
              
              return (
                <div key={key} className="p-3 bg-slate-50 rounded-lg">
                  <div className="text-xs text-slate-500 mb-1">{INTERVAL_LABELS[key] || key}</div>
                  <div className="font-mono text-sm">
                    {timeSince !== null ? `${timeSince}s ago` : 'Never'}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}