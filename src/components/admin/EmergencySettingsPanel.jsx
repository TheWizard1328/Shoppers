import React, { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Loader2, Save, ShieldAlert, Hand, Activity, Gauge } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL EMERGENCY ACTIVATION + SENSITIVITY (owner request Nov 14 2026)
//
// Tuning panel for the emergency system. Two activation switches and one hit
// sensitivity slider. Stored as `emergency_settings` inside the existing
// AppSettings record (setting_key 'refresh_intervals') so every device reads the
// same values — this is what gets flipped on globally when the pilot ends.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_EMERGENCY_SETTINGS = {
  manual_enabled: true,   // 5 second press-and-hold on the Dashboard map
  crash_enabled: true,    // impact detection prompt
  crash_threshold: 42     // accelerationIncludingGravity magnitude that counts as a hit (m/s²)
};

// Slider runs on "sensitivity" (1 = barely reacts, 100 = reacts to anything) and
// maps to a real acceleration threshold, because a m/s² number means nothing to
// a human but a slider does.
const MIN_THRESHOLD = 25;   // most sensitive
const MAX_THRESHOLD = 80;   // most forgiving
const thresholdToSensitivity = (threshold) => {
  const clamped = Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, Number(threshold) || DEFAULT_EMERGENCY_SETTINGS.crash_threshold));
  return Math.round(((MAX_THRESHOLD - clamped) / (MAX_THRESHOLD - MIN_THRESHOLD)) * 100);
};
const sensitivityToThreshold = (sensitivity) => {
  const pct = Math.max(0, Math.min(100, Number(sensitivity) || 0));
  const raw = MAX_THRESHOLD - (pct / 100) * (MAX_THRESHOLD - MIN_THRESHOLD);
  // Owner request Nov 14 2026: the control must move in clean 5 m/s² steps
  // instead of landing on odd numbers like 38 or 47.
  return Math.round(raw / 5) * 5;
};

const EmergencySettingsPanel = () => {
  const [settings, setSettings] = useState({ ...DEFAULT_EMERGENCY_SETTINGS });
  const [savedSettings, setSavedSettings] = useState({ ...DEFAULT_EMERGENCY_SETTINGS });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const rows = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      let raw = rows?.[0]?.setting_value;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = null; } }
      let stored = raw?.emergency_settings;
      if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch { stored = null; } }
      const merged = { ...DEFAULT_EMERGENCY_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
      setSettings(merged);
      setSavedSettings(merged);
    } catch (err) {
      console.warn('[EmergencySettings] load failed:', err?.message || err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    setIsSaving(true);
    setJustSaved(false);
    try {
      const rows = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      const current = rows?.[0]?.setting_value || {};
      const payload = {
        ...current,
        emergency_settings: {
          manual_enabled: !!settings.manual_enabled,
          crash_enabled: !!settings.crash_enabled,
          crash_threshold: Math.round(Number(settings.crash_threshold) || DEFAULT_EMERGENCY_SETTINGS.crash_threshold)
        }
      };
      if (rows && rows.length > 0) {
        await base44.entities.AppSettings.update(rows[0].id, {
          setting_value: payload,
          description: 'App-wide administrative settings'
        });
      } else {
        await base44.entities.AppSettings.create({
          setting_key: 'refresh_intervals',
          setting_value: payload,
          description: 'App-wide administrative settings'
        });
      }
      setSavedSettings({ ...settings });
      setJustSaved(true);
      // Live devices pick the change up immediately.
      window.dispatchEvent(new CustomEvent('emergencySettingsUpdated', {
        detail: { data: { setting_key: 'refresh_intervals', setting_value: payload } }
      }));
    } catch (err) {
      console.error('[EmergencySettings] save failed:', err);
    } finally {
      setIsSaving(false);
    }
  }, [settings]);

  const dirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);
  const sensitivity = thresholdToSensitivity(settings.crash_threshold);

  return (
    <Card
      className={`rounded-[14px] border transition-all ${justSaved && !dirty ? 'border-red-500' : 'border-red-500/60'}`}
      style={{ boxShadow: '0 0 0 1px rgba(239,68,68,0.25), 0 10px 36px -10px rgba(239,68,68,0.35)' }}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-bold tracking-tight text-slate-900 dark:text-white">
          <ShieldAlert className="w-5 h-5 text-red-500" />
          Emergency System
        </CardTitle>
        <CardDescription className="text-slate-500 dark:text-[#a89b8f]">
          Global activation and hit sensitivity. Applies to every device once the system is released beyond App Owner accounts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-slate-500 dark:text-[#a89b8f]">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
          </div>
        ) : (
          <>
            {/* Toggle 1 — manual map hold */}
            <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-300 bg-slate-50 p-3 dark:border-[#3a2e24] dark:bg-[#1a1410]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                  <Hand className="w-4 h-4 text-amber-500" />
                  Map hold activation
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-[#a89b8f]">
                  5 second press and hold on the Dashboard map opens the emergency screen.
                </p>
              </div>
              <Switch
                checked={!!settings.manual_enabled}
                onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, manual_enabled: !!checked }))}
              />
            </div>

            {/* Toggle 2 — impact detection */}
            <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-300 bg-slate-50 p-3 dark:border-[#3a2e24] dark:bg-[#1a1410]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                  <Activity className="w-4 h-4 text-red-500" />
                  Impact detection
                </div>
                <p className="mt-1 text-xs text-slate-600 dark:text-[#a89b8f]">
                  Watches the phone's motion sensor for a hard hit and prompts the driver.
                </p>
              </div>
              <Switch
                checked={!!settings.crash_enabled}
                onCheckedChange={(checked) => setSettings((prev) => ({ ...prev, crash_enabled: !!checked }))}
              />
            </div>

            {/* Slider — sensitivity */}
            <div className={`rounded-lg border p-3 transition-opacity ${settings.crash_enabled ? 'border-slate-300 bg-slate-50 dark:border-[#3a2e24] dark:bg-[#1a1410]' : 'border-slate-200 bg-slate-50/40 opacity-50 dark:border-[#3a2e24] dark:bg-[#1a1410]'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-white">
                  <Gauge className="w-4 h-4 text-orange-500" />
                  Hit sensitivity
                </div>
                <span className="font-mono text-xs text-slate-700 dark:text-[#d6c9ba]">
                  {sensitivity}% · {Math.round(settings.crash_threshold)} m/s²
                </span>
              </div>
              <Slider
                className="mt-3"
                value={[sensitivity]}
                min={0}
                max={100}
                step={5}
                disabled={!settings.crash_enabled}
                onValueChange={(value) => {
                  const next = sensitivityToThreshold(Array.isArray(value) ? value[0] : value);
                  setSettings((prev) => ({ ...prev, crash_threshold: next }));
                }}
              />
              <div className="mt-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:text-[#a89b8f]">
                <span>Reacts to everything</span>
                <span>Only a hard crash</span>
              </div>
              <p className="mt-2 text-xs text-slate-600 dark:text-[#a89b8f]">
                {sensitivity >= 70
                  ? 'Very easy to trigger. Charging the phone or setting it on a table can set it off.'
                  : sensitivity >= 40
                    ? 'Balanced. A knocked phone or a pothole should not trip it.'
                    : 'Forgiving. Only a genuinely violent impact will trip it.'}
              </p>
            </div>

            <div className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-xs text-slate-600 space-y-1 dark:border-[#3a2e24] dark:bg-[#1a1410] dark:text-[#a89b8f]">
              <div>Pilot scope: App Owner devices only, regardless of these switches.</div>
              <div>A real hit must also be followed by ~15s of stillness before anything is sent.</div>
            </div>

            <Button
              onClick={save}
              disabled={isSaving || !dirty}
              size="sm"
              className="w-full gap-2 border-0 font-semibold bg-red-100 text-red-900 hover:bg-red-200 dark:bg-[#f3c9c9] dark:text-[#1a1410] focus-visible:ring-red-500/40"
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {isSaving ? 'Saving…' : justSaved && !dirty ? '✓ Saved' : 'Save Emergency Settings'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
};

export default EmergencySettingsPanel;
