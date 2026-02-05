import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Settings, MapPin, Clock, Truck, Target, Save, RotateCcw, Navigation, AlertTriangle } from "lucide-react";
import { userHasRole } from "../utils/userRoles";
import { locationTracker } from "../utils/locationTracker";
import { base44 } from "@/api/base44Client";
import { loadUserSettings, saveSetting } from "../utils/userSettingsManager";

const DEFAULT_SETTINGS = {
  defaultTravelTimeMinutes: 5,
  defaultStopTimeMinutes: 5,
  useDriverHome: true,
  autoDetectHomeLocation: false,
  driverHomeLatitude: null,
  driverHomeLongitude: null,
  prioritizePickups: true,
  maxRouteDistanceKm: null,
  maxRouteTimeMinutes: null,
  respectTimeWindows: true,
  minimizeBacktracking: true,
  // Real-time tracking settings (admin only)
  enableRouteDeviationDetection: false,
  routeDeviationThresholdMeters: 200,
  routeDeviationCooldownMinutes: 5,
  locationUpdateIntervalSeconds: 30,
  minMovementDistanceMeters: 50
};

const getStoredSettings = () => {
  try {
    const stored = localStorage.getItem('rxdeliver_route_optimization_settings');
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (error) {
    console.error('Error loading route optimization settings:', error);
  }
  return DEFAULT_SETTINGS;
};

const saveSettings = (settings) => {
  try {
    localStorage.setItem('rxdeliver_route_optimization_settings', JSON.stringify(settings));
  } catch (error) {
    console.error('Error saving route optimization settings:', error);
  }
};

export const getRouteOptimizationSettings = () => {
  return getStoredSettings();
};

export default function RouteOptimizationSettings({ onClose, currentUser }) {
  const [settings, setSettings] = useState(getStoredSettings());
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [breadcrumbsEnabled, setBreadcrumbsEnabled] = useState(false);
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(false);
  const [isLoadingBreadcrumbsSettings, setIsLoadingBreadcrumbsSettings] = useState(true);

  const handleSettingChange = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setHasUnsavedChanges(true);
  };

  const handleSave = () => {
    saveSettings(settings);
    setHasUnsavedChanges(false);
    if (onClose) onClose();
  };

  const handleReset = () => {
    if (confirm('Reset all optimization settings to defaults?')) {
      setSettings(DEFAULT_SETTINGS);
      saveSettings(DEFAULT_SETTINGS);
      setHasUnsavedChanges(false);
    }
  };

  const handleAutoDetectLocation = async () => {
    setIsDetectingLocation(true);
    try {
      if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser');
        return;
      }

      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        });
      });

      handleSettingChange('driverHomeLatitude', position.coords.latitude);
      handleSettingChange('driverHomeLongitude', position.coords.longitude);
      handleSettingChange('autoDetectHomeLocation', false);

      alert(`Location detected: ${position.coords.latitude.toFixed(6)}, ${position.coords.longitude.toFixed(6)}`);
    } catch (error) {
      console.error('Error detecting location:', error);
      alert('Failed to detect location. Please enter coordinates manually or enable location access.');
    } finally {
      setIsDetectingLocation(false);
    }
  };

  // Load home coordinates from currentUser if available
  useEffect(() => {
    if (currentUser?.home_latitude && currentUser?.home_longitude &&
    !settings.driverHomeLatitude && !settings.driverHomeLongitude) {
      setSettings((prev) => ({
        ...prev,
        driverHomeLatitude: currentUser.home_latitude,
        driverHomeLongitude: currentUser.home_longitude
      }));
    }
  }, [currentUser]);

  // Load breadcrumbs settings from UserSettings and check if primary device
  useEffect(() => {
    if (!currentUser?.id) return;

    const loadBreadcrumbsSettings = async () => {
      try {
        setIsLoadingBreadcrumbsSettings(true);
        
        // Get device identifier
        const deviceIdentifier = localStorage.getItem('rxdeliver_device_identifier');
        console.log('📱 [Breadcrumbs] Device identifier:', deviceIdentifier);
        
        // Load raw UserSettings record (not merged)
        const userSettingsRecords = await base44.entities.UserSettings.filter({ user_id: currentUser.id }, '-updated', 1);
        const userSettingsRecord = userSettingsRecords?.[0];
        console.log('⚙️ [Breadcrumbs] UserSettings record:', userSettingsRecord);
        
        // Get device-specific profile
        const deviceProfile = userSettingsRecord?.device_settings_profiles?.[deviceIdentifier];
        console.log('📱 [Breadcrumbs] Device profile:', deviceProfile);
        setBreadcrumbsEnabled(deviceProfile?.breadcrumbs_enabled || false);
        
        // Check if this device is the primary tracker
        const userDevices = await base44.entities.UserDevice.filter({ user_id: currentUser.id });
        console.log('📱 [Breadcrumbs] All user devices:', userDevices);
        
        const currentDevice = userDevices?.find(d => d.device_identifier === deviceIdentifier);
        console.log('📱 [Breadcrumbs] Current device:', currentDevice);
        console.log('📱 [Breadcrumbs] is_primary_tracker:', currentDevice?.is_primary_tracker);
        
        const isPrimary = currentDevice?.is_primary_tracker || false;
        setIsPrimaryDevice(isPrimary);
        console.log(`📱 [Breadcrumbs] Setting isPrimaryDevice to: ${isPrimary}`);
        
      } catch (error) {
        console.error('❌ [Breadcrumbs] Error loading settings:', error);
      } finally {
        setIsLoadingBreadcrumbsSettings(false);
      }
    };

    loadBreadcrumbsSettings();
  }, [currentUser?.id]);

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader className="border-b border-slate-200">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-emerald-600" />
            Route Optimization Settings
          </CardTitle>
          <div className="px-3 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleReset}
              className="gap-2">
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!hasUnsavedChanges}
              className="bg-emerald-600 hover:bg-emerald-700 gap-2">
              <Save className="w-3.5 h-3.5" />
              Save
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
        {/* Timing Settings */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Timing Parameters
          </h3>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="travelTime" className="text-sm">
                Default Travel Time (minutes)
              </Label>
              <Input
                id="travelTime"
                type="number"
                min="1"
                max="30"
                value={settings.defaultTravelTimeMinutes}
                onChange={(e) => handleSettingChange('defaultTravelTimeMinutes', parseInt(e.target.value) || 5)}
                className="h-9" />

              <p className="text-xs text-slate-500">Time between each stop</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="stopTime" className="text-sm">
                Default Stop Time (minutes)
              </Label>
              <Input
                id="stopTime"
                type="number"
                min="1"
                max="30"
                value={settings.defaultStopTimeMinutes}
                onChange={(e) => handleSettingChange('defaultStopTimeMinutes', parseInt(e.target.value) || 5)}
                className="h-9" />

              <p className="text-xs text-slate-500">Time spent at each delivery</p>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200"></div>

        {/* Driver Home Location */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <MapPin className="w-4 h-4" />
            Driver Home Location
          </h3>

          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="useDriverHome" className="text-sm">
                Include home in route calculation
              </Label>
              <p className="text-xs text-slate-500">
                Route will start/end at driver home if set
              </p>
            </div>
            <Switch
              id="useDriverHome"
              checked={settings.useDriverHome}
              onCheckedChange={(checked) => handleSettingChange('useDriverHome', checked)} />

          </div>

          {settings.useDriverHome &&
          <div className="space-y-3 pl-4 border-l-2 border-emerald-200">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="homeLatitude" className="text-sm">
                    Home Latitude
                  </Label>
                  <Input
                  id="homeLatitude"
                  type="number"
                  step="0.000001"
                  value={settings.driverHomeLatitude || ''}
                  onChange={(e) => handleSettingChange('driverHomeLatitude', parseFloat(e.target.value) || null)}
                  placeholder="e.g., 53.5461"
                  className="h-9" />

                </div>

                <div className="space-y-2">
                  <Label htmlFor="homeLongitude" className="text-sm">
                    Home Longitude
                  </Label>
                  <Input
                  id="homeLongitude"
                  type="number"
                  step="0.000001"
                  value={settings.driverHomeLongitude || ''}
                  onChange={(e) => handleSettingChange('driverHomeLongitude', parseFloat(e.target.value) || null)}
                  placeholder="e.g., -113.4938"
                  className="h-9" />

                </div>
              </div>

              <Button
              variant="outline"
              size="sm"
              onClick={handleAutoDetectLocation}
              disabled={isDetectingLocation}
              className="w-full gap-2">
                <MapPin className="w-3.5 h-3.5" />
                {isDetectingLocation ? 'Detecting...' : 'Auto-Detect Current Location'}
              </Button>

              {currentUser?.home_latitude && currentUser?.home_longitude &&
            <div className="bg-blue-50 border border-blue-200 rounded-md p-2">
                  <p className="text-xs text-blue-700">
                    <strong>Saved in Profile:</strong> {currentUser.home_latitude.toFixed(6)}, {currentUser.home_longitude.toFixed(6)}
                  </p>
                </div>
            }
            </div>
          }
        </div>

        <div className="border-t border-slate-200"></div>

        {/* Optimization Preferences */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Truck className="w-4 h-4" />
            Optimization Preferences
          </h3>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label htmlFor="prioritizePickups" className="text-sm">
                  Always prioritize store pickups first
                </Label>
                <p className="text-xs text-slate-500">
                  Pickups scheduled before deliveries
                </p>
              </div>
              <Switch
                id="prioritizePickups"
                checked={settings.prioritizePickups}
                onCheckedChange={(checked) => handleSettingChange('prioritizePickups', checked)} />

            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label htmlFor="respectTimeWindows" className="text-sm">
                  Respect delivery time windows
                </Label>
                <p className="text-xs text-slate-500">
                  Schedule within patient time windows
                </p>
              </div>
              <Switch
                id="respectTimeWindows"
                checked={settings.respectTimeWindows}
                onCheckedChange={(checked) => handleSettingChange('respectTimeWindows', checked)} />

            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label htmlFor="minimizeBacktracking" className="text-sm">
                  Minimize backtracking
                </Label>
                <p className="text-xs text-slate-500">
                  Optimize for shortest total distance
                </p>
              </div>
              <Switch
                id="minimizeBacktracking"
                checked={settings.minimizeBacktracking}
                onCheckedChange={(checked) => handleSettingChange('minimizeBacktracking', checked)} />

            </div>
          </div>
        </div>

        <div className="border-t border-slate-200"></div>

        {/* GPS Breadcrumbs Tracking */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <MapPin className="w-4 h-4" />
            GPS Breadcrumbs Tracking
          </h3>

          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label htmlFor="breadcrumbsEnabled" className="text-sm">
                Enable GPS breadcrumb tracking
              </Label>
              <p className="text-xs text-slate-500">
                {isPrimaryDevice ? 
                  'Record GPS location every 15 seconds during deliveries' :
                  'Only available on primary tracking device'
                }
              </p>
            </div>
            <Switch
              id="breadcrumbsEnabled"
              checked={breadcrumbsEnabled}
              disabled={!isPrimaryDevice || isLoadingBreadcrumbsSettings}
              onCheckedChange={async (checked) => {
                setBreadcrumbsEnabled(checked);
                try {
                  await saveSetting(currentUser.id, 'breadcrumbs_enabled', checked);
                  console.log(`✅ Breadcrumbs tracking ${checked ? 'enabled' : 'disabled'}`);
                } catch (error) {
                  console.error('Failed to save breadcrumbs setting:', error);
                  setBreadcrumbsEnabled(!checked); // Revert on error
                }
              }} />

          </div>
          
          {!isPrimaryDevice && !isLoadingBreadcrumbsSettings &&
            <div className="bg-blue-50 border border-blue-200 rounded-md p-2">
              <p className="text-xs text-blue-700">
                This device is not set as the primary tracker. Set it as primary in Device Settings to enable breadcrumb tracking.
              </p>
            </div>
          }
        </div>

        {/* Real-Time Tracking Settings - Admin Only */}
        {currentUser && userHasRole(currentUser, 'admin') &&
        <>
            <div className="border-t border-slate-200"></div>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Navigation className="w-4 h-4" />
                Real-Time Tracking Settings
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Admin Only</span>
              </h3>

              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label htmlFor="enableRouteDeviationDetection" className="text-sm">
                    Enable route deviation detection
                  </Label>
                  <p className="text-xs text-slate-500">
                    Auto-recalculate route when driver strays too far
                  </p>
                </div>
                <Switch
                id="enableRouteDeviationDetection"
                checked={settings.enableRouteDeviationDetection}
                onCheckedChange={(checked) => handleSettingChange('enableRouteDeviationDetection', checked)} />

              </div>

              {settings.enableRouteDeviationDetection &&
            <div className="space-y-4 pl-4 border-l-2 border-blue-200">
                  <div className="bg-amber-50 border border-amber-200 rounded-md p-2 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800">
                      Route recalculation uses Google Maps API and incurs costs. Cooldown period prevents excessive API calls.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="deviationThreshold" className="text-sm">
                        Deviation Threshold (meters)
                      </Label>
                      <Input
                    id="deviationThreshold"
                    type="number"
                    min="50"
                    max="1000"
                    step="50"
                    value={settings.routeDeviationThresholdMeters}
                    onChange={(e) => handleSettingChange('routeDeviationThresholdMeters', parseInt(e.target.value) || 200)}
                    className="h-9" />

                      <p className="text-xs text-slate-500">Distance before re-routing</p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="deviationCooldown" className="text-sm">
                        Re-route Cooldown (minutes)
                      </Label>
                      <Input
                    id="deviationCooldown"
                    type="number"
                    min="1"
                    max="30"
                    value={settings.routeDeviationCooldownMinutes}
                    onChange={(e) => handleSettingChange('routeDeviationCooldownMinutes', parseInt(e.target.value) || 5)}
                    className="h-9" />

                      <p className="text-xs text-slate-500">Min time between re-routes</p>
                    </div>
                  </div>
                </div>
            }

              <div className="border-t border-slate-100 pt-4"></div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="locationUpdateInterval" className="text-sm">
                    Location Update Interval (seconds)
                  </Label>
                  <Input
                  id="locationUpdateInterval"
                  type="number"
                  min="15"
                  max="120"
                  step="5"
                  value={settings.locationUpdateIntervalSeconds}
                  onChange={(e) => handleSettingChange('locationUpdateIntervalSeconds', parseInt(e.target.value) || 30)}
                  className="h-9" />

                  <p className="text-xs text-slate-500">How often to update location</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="minMovementDistance" className="text-sm">
                    Min Movement Distance (meters)
                  </Label>
                  <Input
                  id="minMovementDistance"
                  type="number"
                  min="10"
                  max="200"
                  step="10"
                  value={settings.minMovementDistanceMeters}
                  onChange={(e) => handleSettingChange('minMovementDistanceMeters', parseInt(e.target.value) || 50)}
                  className="h-9" />

                  <p className="text-xs text-slate-500">Min distance to trigger update</p>
                </div>
              </div>
            </div>
          </>
        }

        {hasUnsavedChanges &&
        <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
            <p className="text-sm text-amber-800">
              You have unsaved changes. Click Save to apply these settings to future route optimizations.
            </p>
          </div>
        }
      </CardContent>
    </Card>);

}