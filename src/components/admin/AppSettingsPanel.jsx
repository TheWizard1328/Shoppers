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
    <div className="warm-console h-full min-h-0 overflow-y-auto pb-4">
      <style>{`
        .warm-console { color-scheme: dark; }
        .warm-console .bg-primary { background-color: #f59e0b !important; }
        .warm-console .bg-primary\\/20 { background-color: rgba(245,158,11,0.28) !important; }
        .warm-console .border-primary\\/50 { border-color: #f59e0b !important; }
        .warm-console .bg-background { background-color: #ffffff !important; }
      `}</style>
      <div className="rounded-2xl bg-[#1a1410] p-4 md:p-6 shadow-xl">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          <PerFeatureApiKeysCard availableApiKeys={availableApiKeys} />

          {/* Other Admin Settings */}
          <Card
            className={`rounded-[14px] border transition-all ${
              activeTopSection === 'adminSettings' && topSectionSaved
                ? 'border-amber-500'
                : activeTopSection === 'adminSettings' && isTopSectionSaving
                  ? 'border-amber-400'
                  : 'border-[#3a2e24]'
            }`}
            style={{
              backgroundColor: '#241c17',
              color: '#ffffff',
              boxShadow:
                activeTopSection === 'adminSettings' && (topSectionSaved || isTopSectionSaving)
                  ? '0 0 0 1px rgba(245,158,11,0.35), 0 10px 30px -10px rgba(245,158,11,0.35)'
                  : 'none',
            }}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-bold tracking-tight" style={{ color: '#ffffff' }}>
                <Settings className="w-5 h-5 text-amber-500" />
                Other Admin Settings
              </CardTitle>
              <CardDescription style={{ color: '#a89b8f' }}>
                Configure app-wide administrative settings.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="app_fees" className="text-sm font-medium mb-1.5 block" style={{ color: '#d6cfc7' }}>
                    App Fees (Cost per Delivery)
                  </Label>
                  <div className="flex items-center gap-2">
                    <span className="text-amber-500 font-semibold">$</span>
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
                      className="w-32 border-[#3a2e24] focus-visible:border-amber-500 focus-visible:ring-amber-500/30"
                      style={{ backgroundColor: '#1a1410', color: '#ffffff' }}
                    />
                    <span className="text-sm" style={{ color: '#a89b8f' }}>per finished delivery</span>
                  </div>
                  <p className="text-xs mt-1" style={{ color: '#8a7e72' }}>
                    This fee will be used to calculate monthly charges for stores that are marked as paying app fees.
                  </p>
                </div>

                <div>
                  <Label htmlFor="square_app_id" className="text-sm font-medium mb-1.5 block" style={{ color: '#d6cfc7' }}>
                    Square Application ID
                  </Label>
                  <Input
                    id="square_app_id"
                    type="text"
                    value={squareAppId}
                    onChange={(e) => setSquareAppId(e.target.value)}
                    placeholder="sq0idp-..."
                    className="font-mono text-sm border-[#3a2e24] focus-visible:border-amber-500 focus-visible:ring-amber-500/30"
                    style={{ backgroundColor: '#1a1410', color: '#f59e0b' }}
                  />
                  <p className="text-xs mt-1" style={{ color: '#8a7e72' }}>
                    Required for the Square POS button on stop cards. Find this in your Square Developer Dashboard.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Fridge Temperature Range Settings — featured with amber glow */}
          <Card
            className={`rounded-[14px] border transition-all ${
              fridgeTempSaved ? 'border-amber-500' : isSavingFridgeTemp ? 'border-amber-400' : 'border-amber-500/60'
            }`}
            style={{
              backgroundColor: '#241c17',
              color: '#ffffff',
              boxShadow: '0 0 0 1px rgba(245,158,11,0.25), 0 10px 36px -10px rgba(245,158,11,0.35)',
            }}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-bold tracking-tight" style={{ color: '#ffffff' }}>
                <Thermometer className="w-5 h-5 text-amber-500" />
                Fridge Temp Ranges
              </CardTitle>
              <CardDescription style={{ color: '#a89b8f' }}>
                Set the safe zone and warning buffer for cooler temperature monitoring.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label className="text-sm font-medium" style={{ color: '#d6cfc7' }}>Safe Zone (°C)</Label>
                    <span className="text-sm font-mono font-semibold text-amber-400">
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
                  <div className="flex justify-between text-xs mt-1" style={{ color: '#8a7e72' }}>
                    <span>-10°C</span>
                    <span>25°C</span>
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium" style={{ color: '#d6cfc7' }}>Danger Buffer (±°C)</Label>
                  <div className="flex items-center gap-2 mt-1">
                    <Input
                      type="number"
                      step="0.5"
                      min="0"
                      value={fridgeTempSettings.danger_buffer}
                      onChange={(e) => setFridgeTempSettings(p => ({ ...p, danger_buffer: parseFloat(e.target.value) || 0 }))}
                      className="w-24 font-mono border-[#3a2e24] focus-visible:border-amber-500 focus-visible:ring-amber-500/30"
                      style={{ backgroundColor: '#1a1410', color: '#ffffff' }}
                    />
                    <span className="text-xs" style={{ color: '#a89b8f' }}>warning ± safe zone</span>
                  </div>
                </div>
              </div>
              <div className="rounded-lg border border-[#3a2e24] p-3 text-xs space-y-1" style={{ backgroundColor: '#1a1410', color: '#a89b8f' }}>
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" /> Safe: {fridgeTempSettings.safe_min}°C – {fridgeTempSettings.safe_max}°C</div>
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block" /> Warning: {+(fridgeTempSettings.safe_min - fridgeTempSettings.danger_buffer).toFixed(1)}°C – {fridgeTempSettings.safe_min}°C & {fridgeTempSettings.safe_max}°C – {+(fridgeTempSettings.safe_max + fridgeTempSettings.danger_buffer).toFixed(1)}°C</div>
                <div className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> Out of range: below {+(fridgeTempSettings.safe_min - fridgeTempSettings.danger_buffer).toFixed(1)}°C or above {+(fridgeTempSettings.safe_max + fridgeTempSettings.danger_buffer).toFixed(1)}°C</div>
              </div>
              <Button
                onClick={handleSaveFridgeTemp}
                disabled={isSavingFridgeTemp}
                size="sm"
                className="w-full gap-2 border-0 font-semibold focus-visible:ring-amber-500/40"
                style={{ backgroundColor: '#eecfa8', color: '#1a1410' }}
              >
                {isSavingFridgeTemp ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {isSavingFridgeTemp ? 'Saving…' : fridgeTempSaved ? '✓ Saved' : 'Save Temp Ranges'}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}