import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Settings, Save, RefreshCw, Loader2, Clock, AlertCircle, RotateCcw, Power } from 'lucide-react';
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
  const [smartRefreshEnabled, setSmartRefreshEnabled] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [savedIntervals, setSavedIntervals] = useState(null);
  const [savedSmartRefreshEnabled, setSavedSmartRefreshEnabled] = useState(true);

  // Load settings from database
  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      if (settings && settings.length > 0 && settings[0].setting_value) {
        const loaded = { ...DEFAULT_INTERVALS, ...settings[0].setting_value };
        setIntervals(loaded);
        setSavedIntervals(loaded);
        // Load smart refresh enabled state
        const enabled = settings[0].setting_value.smartRefreshEnabled !== false;
        setSmartRefreshEnabled(enabled);
        setSavedSmartRefreshEnabled(enabled);
        smartRefreshManager.enabled = enabled;
      } else {
        setIntervals(DEFAULT_INTERVALS);
        setSavedIntervals(DEFAULT_INTERVALS);
        setSmartRefreshEnabled(true);
        setSavedSmartRefreshEnabled(true);
      }
    } catch (error) {
      console.error('Failed to load app settings:', error);
      setIntervals(DEFAULT_INTERVALS);
      setSavedIntervals(DEFAULT_INTERVALS);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Check for changes
  useEffect(() => {
    if (savedIntervals) {
      const intervalsChanged = Object.keys(intervals).some(key => intervals[key] !== savedIntervals[key]);
      const enabledChanged = smartRefreshEnabled !== savedSmartRefreshEnabled;
      setHasChanges(intervalsChanged || enabledChanged);
    }
  }, [intervals, savedIntervals, smartRefreshEnabled, savedSmartRefreshEnabled]);

  const handleIntervalChange = (key, value) => {
    setIntervals(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const settingsToSave = {
        ...intervals,
        smartRefreshEnabled: smartRefreshEnabled
      };

      // Check if setting exists
      const existing = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      
      if (existing && existing.length > 0) {
        await base44.entities.AppSettings.update(existing[0].id, {
          setting_value: settingsToSave,
          description: 'Smart refresh interval settings (in milliseconds)'
        });
      } else {
        await base44.entities.AppSettings.create({
          setting_key: 'refresh_intervals',
          setting_value: settingsToSave,
          description: 'Smart refresh interval settings (in milliseconds)'
        });
      }

      // Apply to smartRefreshManager immediately
      smartRefreshManager.enabled = smartRefreshEnabled;
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
      setHasChanges(false);
      alert('Settings saved! Changes will take effect on the next refresh cycle.');
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
      <Card>
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
          {/* Priority Legend */}
          <div className="flex items-center gap-4 text-sm">
            <span className="font-medium text-slate-700">Priority:</span>
            <Badge className="bg-red-100 text-red-800">high</Badge>
            <span className="text-slate-500">= Real-time critical</span>
            <Badge className="bg-yellow-100 text-yellow-800">medium</Badge>
            <span className="text-slate-500">= Important</span>
            <Badge className="bg-green-100 text-green-800">low</Badge>
            <span className="text-slate-500">= Background</span>
          </div>

          {/* High Priority Section */}
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

          {/* Medium Priority Section */}
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

          {/* Low Priority Section */}
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

          {/* System Section */}
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

          {/* Actions */}
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

      {/* Current Status Card */}
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
            {Object.keys(smartRefreshManager.lastRefreshTimes || {}).map(key => {
              const lastTime = smartRefreshManager.lastRefreshTimes[key];
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
  );
}