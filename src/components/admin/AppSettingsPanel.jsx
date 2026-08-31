import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Settings, Save, Loader2, Thermometer } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { realtimeSync } from '../utils/realtimeSync';
import PerFeatureApiKeysCard from './PerFeatureApiKeysCard';

const DEFAULT_API_KEYS = ['HERE_API_KEY', 'Here_API_Key_2', 'Here_API_Key_3', 'GOOGLE_MAPS_API_KEY'];

export default function AppSettingsPanel() {
  const [isLoading, setIsLoading] = useState(true);
  const [appFeesPerDelivery, setAppFeesPerDelivery] = useState('0.00');
  const [savedAppFees, setSavedAppFees] = useState('0.00');
  const [squareAppId, setSquareAppId] = useState('');
  const [savedSquareAppId, setSavedSquareAppId] = useState('');
  const [availableApiKeys, setAvailableApiKeys] = useState(DEFAULT_API_KEYS);

  // Top-section (App Fees / Square App ID) auto-save indicator
  const [isTopSectionSaving, setIsTopSectionSaving] = useState(false);
  const [topSectionSaved, setTopSectionSaved] = useState(false);
  const [activeTopSection, setActiveTopSection] = useState(null);
  const topSectionAutoSaveTimeoutRef = useRef(null);

  // Fridge temperature range settings
  const [fridgeTempSettings, setFridgeTempSettings] = useState({ safe_min: 2, safe_max: 8, danger_buffer: 2 });
  const [savedFridgeTempSettings, setSavedFridgeTempSettings] = useState({ safe_min: 2, safe_max: 8, danger_buffer: 2 });
  const [isSavingFridgeTemp, setIsSavingFridgeTemp] = useState(false);
  const [fridgeTempSaved, setFridgeTempSaved] = useState(false);

  // Load settings from database
  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      if (settings && settings.length > 0 && settings[0].setting_value) {
        const v = settings[0].setting_value;

        if (v.app_fees_per_delivery !== undefined) {
          const fees = parseFloat(v.app_fees_per_delivery).toFixed(2);
          setAppFeesPerDelivery(fees);
          setSavedAppFees(fees);
        }

        const sqAppId = v.square_app_id || '';
        setSquareAppId(sqAppId);
        setSavedSquareAppId(sqAppId);

        if (v.fridge_temp_settings) {
          setFridgeTempSettings(v.fridge_temp_settings);
          setSavedFridgeTempSettings(v.fridge_temp_settings);
        }

        const configuredApiKeys = Array.isArray(v.available_api_keys) && v.available_api_keys.length > 0
          ? v.available_api_keys
          : DEFAULT_API_KEYS;
        setAvailableApiKeys(configuredApiKeys);
      } else {
        setAvailableApiKeys(DEFAULT_API_KEYS);
      }
    } catch (error) {
      console.error('Failed to load app settings:', error);
      setAvailableApiKeys(DEFAULT_API_KEYS);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const handleAppSettingsUpdated = async (event) => {
      const updatedSetting = event?.detail?.data;
      if (updatedSetting?.setting_key !== 'refresh_intervals') return;
      await loadSettings();
    };
    window.addEventListener('appSettingsUpdated', handleAppSettingsUpdated);
    return () => window.removeEventListener('appSettingsUpdated', handleAppSettingsUpdated);
  }, [loadSettings]);

  // Auto-save App Fees + Square App ID (debounced 3s)
  const saveTopSectionSettings = useCallback(async () => {
    setIsTopSectionSaving(true);
    setTopSectionSaved(false);
    try {
      const existing = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      const currentSettings = existing?.[0]?.setting_value || {};
      const updatedSettings = {
        ...currentSettings,
        app_fees_per_delivery: parseFloat(appFeesPerDelivery || 0),
        square_app_id: squareAppId.trim(),
        available_api_keys: availableApiKeys
      };

      let savedRecord;
      if (existing && existing.length > 0) {
        savedRecord = await base44.entities.AppSettings.update(existing[0].id, {
          setting_value: updatedSettings,
          description: 'App-wide administrative settings'
        });
      } else {
        savedRecord = await base44.entities.AppSettings.create({
          setting_key: 'refresh_intervals',
          setting_value: updatedSettings,
          description: 'App-wide administrative settings'
        });
      }

      realtimeSync.broadcast('AppSettings', existing?.[0] ? 'update' : 'create', savedRecord?.id, savedRecord);
      window.dispatchEvent(new CustomEvent('appSettingsUpdated', {
        detail: { data: savedRecord, source: 'AppSettingsPanel' }
      }));

      setSavedAppFees(appFeesPerDelivery);
      setSavedSquareAppId(squareAppId.trim());
      setTopSectionSaved(true);
    } catch (error) {
      console.error('Failed to auto-save top settings:', error);
      setTopSectionSaved(false);
    } finally {
      setIsTopSectionSaving(false);
    }
  }, [appFeesPerDelivery, squareAppId, availableApiKeys]);

  useEffect(() => {
    if (isLoading) return;
    if (appFeesPerDelivery === savedAppFees && squareAppId === savedSquareAppId) return;

    setActiveTopSection('adminSettings');
    setTopSectionSaved(false);
    if (topSectionAutoSaveTimeoutRef.current) {
      clearTimeout(topSectionAutoSaveTimeoutRef.current);
    }
    topSectionAutoSaveTimeoutRef.current = setTimeout(() => {
      saveTopSectionSettings();
    }, 3000);

    return () => {
      if (topSectionAutoSaveTimeoutRef.current) {
        clearTimeout(topSectionAutoSaveTimeoutRef.current);
      }
    };
  }, [isLoading, appFeesPerDelivery, savedAppFees, squareAppId, savedSquareAppId, saveTopSectionSettings]);

  const handleSaveFridgeTemp = async () => {
    setIsSavingFridgeTemp(true);
    setFridgeTempSaved(false);
    try {
      const existing = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      const currentSettings = existing?.[0]?.setting_value || {};
      const updatedSettings = { ...currentSettings, fridge_temp_settings: fridgeTempSettings };
      let savedRecord;
      if (existing && existing.length > 0) {
        savedRecord = await base44.entities.AppSettings.update(existing[0].id, { setting_value: updatedSettings });
      } else {
        savedRecord = await base44.entities.AppSettings.create({
          setting_key: 'refresh_intervals',
          setting_value: updatedSettings,
          description: 'App-wide administrative settings'
        });
      }
      realtimeSync.broadcast('AppSettings', existing?.[0] ? 'update' : 'create', savedRecord?.id, savedRecord);
      window.dispatchEvent(new CustomEvent('appSettingsUpdated', { detail: { data: savedRecord, source: 'AppSettingsPanel' } }));
      setSavedFridgeTempSettings({ ...fridgeTempSettings });
      setFridgeTempSaved(true);
      setTimeout(() => setFridgeTempSaved(false), 2500);
    } catch (error) {
      console.error('Failed to save fridge temp settings:', error);
      alert('Failed to save: ' + error.message);
    } finally {
      setIsSavingFridgeTemp(false);
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-500 mr-2" />
          <span className="text-slate-600 dark:text-slate-400">Loading settings...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6 h-full min-h-0 overflow-y-auto pb-2 md:pb-0">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        <PerFeatureApiKeysCard availableApiKeys={availableApiKeys} />

        <Card className={`transition-colors ${activeTopSection === 'adminSettings' && topSectionSaved ? 'border-green-500 bg-green-50 dark:bg-green-950/40' : activeTopSection === 'adminSettings' && isTopSectionSaving ? 'border-emerald-300' : ''}`}>
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
                  <span className="text-slate-700 dark:text-slate-300 font-medium">$</span>
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
                  <span className="text-sm text-slate-500 dark:text-slate-400">per finished delivery</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  This fee will be used to calculate monthly charges for stores that are marked as paying app fees.
                </p>
              </div>

              <div>
                <Label htmlFor="square_app_id" className="text-sm font-medium mb-1.5 block">
                  Square Application ID
                </Label>
                <Input
                  id="square_app_id"
                  type="text"
                  value={squareAppId}
                  onChange={(e) => setSquareAppId(e.target.value)}
                  placeholder="sq0idp-..."
                  className="font-mono text-sm"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Required for the Square POS button on stop cards. Find this in your Square Developer Dashboard.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Fridge Temperature Range Settings */}
        <Card className={`transition-colors ${fridgeTempSaved ? 'border-green-500 bg-green-50 dark:bg-green-950/40' : isSavingFridgeTemp ? 'border-emerald-300' : ''}`}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Thermometer className="w-5 h-5 text-cyan-600" />
              Fridge Temp Ranges
            </CardTitle>
            <CardDescription>
              Set the safe zone and warning buffer for cooler temperature monitoring.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-sm font-medium">Safe Zone (°C)</Label>
                  <span className="text-sm font-mono font-semibold text-cyan-700">
                    {fridgeTempSettings.safe_min}° – {fridgeTempSettings.safe_max}°
                  </span>
                </div>
                <Slider
                  value={[fridgeTempSettings.safe_min, fridgeTempSettings.safe_max]}
                  onValueChange={([min, max]) => setFridgeTempSettings(p => ({ ...p, safe_min: min, safe_max: max }))}
                  min={-10}
                  max={25}
                  step={0.5}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-slate-400 dark:text-slate-500 mt-1">
                  <span>-10°C</span>
                  <span>25°C</span>
                </div>
              </div>
              <div>
                <Label className="text-sm font-medium">Danger Buffer (±°C)</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    type="number"
                    step="0.5"
                    min="0"
                    value={fridgeTempSettings.danger_buffer}
                    onChange={(e) => setFridgeTempSettings(p => ({ ...p, danger_buffer: parseFloat(e.target.value) || 0 }))}
                    className="w-24 font-mono"
                  />
                  <span className="text-xs text-slate-500 dark:text-slate-400">warning ± safe zone</span>
                </div>
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 dark:bg-slate-800 border p-3 text-xs text-slate-600 dark:text-slate-400 space-y-1">
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-cyan-500 inline-block" /> Safe: {fridgeTempSettings.safe_min}°C – {fridgeTempSettings.safe_max}°C</div>
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block" /> Warning: {+(fridgeTempSettings.safe_min - fridgeTempSettings.danger_buffer).toFixed(1)}°C – {fridgeTempSettings.safe_min}°C & {fridgeTempSettings.safe_max}°C – {+(fridgeTempSettings.safe_max + fridgeTempSettings.danger_buffer).toFixed(1)}°C</div>
              <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> Out of range: below {+(fridgeTempSettings.safe_min - fridgeTempSettings.danger_buffer).toFixed(1)}°C or above {+(fridgeTempSettings.safe_max + fridgeTempSettings.danger_buffer).toFixed(1)}°C</div>
            </div>
            <Button
              onClick={handleSaveFridgeTemp}
              disabled={isSavingFridgeTemp}
              size="sm"
              className="w-full gap-2"
            >
              {isSavingFridgeTemp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {isSavingFridgeTemp ? 'Saving…' : fridgeTempSaved ? '✓ Saved' : 'Save Temp Ranges'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}