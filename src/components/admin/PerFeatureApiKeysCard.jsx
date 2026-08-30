import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MapPinned, KeyRound } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { realtimeSync } from '../utils/realtimeSync';

// Feature slot definitions — order here is the order shown in the card.
// `defaultKey` is used during migration from the legacy single selected_api_key
// (HERE features inherit the legacy key when it is a HERE key; Google-default
// features fall back to GOOGLE_MAPS_API_KEY).
const FEATURE_SLOTS = [
  { key: 'route_optimization', label: 'Route optimization', provider: 'here' },
  { key: 'polylines', label: 'Polylines', provider: 'here' },
  { key: 'map_tiles', label: 'Map tiles', provider: 'here' },
  { key: 'address_lookup', label: 'Address lookup', provider: 'google' },
  { key: 'places_autocomplete', label: 'Places autocomplete', provider: 'google' },
  { key: 'place_details', label: 'Place Details', provider: 'google' },
  { key: 'eta_distance', label: 'ETA / distance', provider: 'google' },
];

const DEFAULT_KEY_BY_PROVIDER = { here: 'HERE_API_KEY', google: 'GOOGLE_MAPS_API_KEY' };

function migratePerFeatureKeys(raw) {
  const map = (raw && typeof raw === 'object') ? raw : {};
  const legacyKey = map.__legacy || null; // placeholder, unused
  // Detect a previously-saved per_feature_api_keys map
  const existing = map.per_feature_api_keys;
  if (existing && typeof existing === 'object') {
    const result = {};
    for (const slot of FEATURE_SLOTS) {
      result[slot.key] = existing[slot.key] || DEFAULT_KEY_BY_PROVIDER[slot.provider];
    }
    return result;
  }
  // Migration: read the legacy single selected_api_key/selected_here_api_key
  const legacySelected = map.selected_api_key || map.selected_here_api_key;
  const isHereLegacy = legacySelected && legacySelected !== 'GOOGLE_MAPS_API_KEY';
  const result = {};
  for (const slot of FEATURE_SLOTS) {
    if (slot.provider === 'here' && isHereLegacy && legacySelected) {
      result[slot.key] = legacySelected;
    } else {
      result[slot.key] = DEFAULT_KEY_BY_PROVIDER[slot.provider];
    }
  }
  return result;
}

export default function PerFeatureApiKeysCard({ availableApiKeys }) {
  const [perFeatureKeys, setPerFeatureKeys] = useState(() =>
    Object.fromEntries(FEATURE_SLOTS.map((s) => [s.key, DEFAULT_KEY_BY_PROVIDER[s.provider]])),
  );
  const [savedPerFeatureKeys, setSavedPerFeatureKeys] = useState(null);
  const [savingFeature, setSavingFeature] = useState(null);
  const [savedFeature, setSavedFeature] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const saveTimersRef = useRef({});
  const savedHighlightTimersRef = useRef({});
  const migrationPersistedRef = useRef(false);

  const loadKeys = useCallback(async () => {
    try {
      const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      const existing = settings?.[0];
      const value = existing?.setting_value || {};
      const migrated = migratePerFeatureKeys(value);

      // First-load migration: persist the migrated per-feature map so the backend
      // stops falling back to the legacy single selected_api_key (which could be a
      // Google key assigned to HERE-only features like map tiles). Runs once.
      if (!value.per_feature_api_keys && !migrationPersistedRef.current) {
        migrationPersistedRef.current = true;
        const updatedSettings = { ...value, per_feature_api_keys: migrated };
        let savedRecord;
        if (existing) {
          savedRecord = await base44.entities.AppSettings.update(existing.id, { setting_value: updatedSettings });
        } else {
          savedRecord = await base44.entities.AppSettings.create({
            setting_key: 'refresh_intervals',
            setting_value: updatedSettings,
            description: 'Smart refresh interval and app version settings',
          });
        }
        realtimeSync.broadcast('AppSettings', existing ? 'update' : 'create', savedRecord?.id, savedRecord);
        window.dispatchEvent(new CustomEvent('appSettingsUpdated', {
          detail: { data: savedRecord, source: 'PerFeatureApiKeysCard' },
        }));
      }

      setPerFeatureKeys(migrated);
      setSavedPerFeatureKeys(migrated);
    } catch (error) {
      console.error('Failed to load per-feature API keys:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
    const handler = (event) => {
      const updated = event?.detail?.data;
      if (updated?.setting_key !== 'refresh_intervals') return;
      if (event?.detail?.source === 'PerFeatureApiKeysCard') return; // ignore our own broadcasts
      loadKeys();
    };
    window.addEventListener('appSettingsUpdated', handler);
    return () => window.removeEventListener('appSettingsUpdated', handler);
  }, [loadKeys]);

  const saveFeature = useCallback(async (feature, key) => {
    setSavingFeature(feature);
    setSavedFeature(null);
    try {
      const existing = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      const currentSettings = existing?.[0]?.setting_value || {};
      const currentMap = migratePerFeatureKeys(currentSettings);
      const updatedMap = { ...currentMap, [feature]: key };
      const updatedSettings = { ...currentSettings, per_feature_api_keys: updatedMap };

      let savedRecord;
      if (existing && existing.length > 0) {
        savedRecord = await base44.entities.AppSettings.update(existing[0].id, {
          setting_value: updatedSettings,
        });
      } else {
        savedRecord = await base44.entities.AppSettings.create({
          setting_key: 'refresh_intervals',
          setting_value: updatedSettings,
          description: 'Smart refresh interval and app version settings',
        });
      }

      realtimeSync.broadcast('AppSettings', existing?.[0] ? 'update' : 'create', savedRecord?.id, savedRecord);
      window.dispatchEvent(new CustomEvent('appSettingsUpdated', {
        detail: { data: savedRecord, source: 'PerFeatureApiKeysCard' },
      }));

      setSavedPerFeatureKeys((prev) => ({ ...(prev || updatedMap), [feature]: key }));
      setSavedFeature(feature);
      if (savedHighlightTimersRef.current[feature]) clearTimeout(savedHighlightTimersRef.current[feature]);
      savedHighlightTimersRef.current[feature] = setTimeout(() => setSavedFeature((cur) => (cur === feature ? null : cur)), 2500);
    } catch (error) {
      console.error('Failed to save per-feature API key:', error);
    } finally {
      setSavingFeature(null);
    }
  }, []);

  const handleFeatureChange = useCallback((feature, key) => {
    setPerFeatureKeys((prev) => ({ ...prev, [feature]: key }));
    if (saveTimersRef.current[feature]) clearTimeout(saveTimersRef.current[feature]);
    saveTimersRef.current[feature] = setTimeout(() => {
      saveFeature(feature, key);
    }, 600);
  }, [saveFeature]);

  return (
    <Card className="transition-colors">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPinned className="w-5 h-5" />
          API Provider Keys
        </CardTitle>
        <CardDescription>
          Choose which API key each map feature uses. Distribute quota across HERE and Google keys per feature.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2.5">
          {isLoading ? (
            <div className="text-sm text-slate-500 dark:text-slate-400 py-2">Loading…</div>
          ) : (
            FEATURE_SLOTS.map((slot) => {
              const value = perFeatureKeys[slot.key] || DEFAULT_KEY_BY_PROVIDER[slot.provider];
              const isSaving = savingFeature === slot.key;
              const isSaved = savedFeature === slot.key;
              return (
                <div
                  key={slot.key}
                  className={`flex items-center justify-between gap-3 rounded-lg border p-2.5 transition-colors ${
                    isSaved
                      ? 'border-green-500 bg-green-50 dark:bg-green-950/40'
                      : isSaving
                        ? 'border-emerald-300'
                        : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800'
                  }`}
                >
                  <Label className="text-sm font-medium text-slate-700 dark:text-slate-200 flex-1 truncate">
                    {slot.label}
                  </Label>
                  <Select
                    value={value}
                    onValueChange={(key) => handleFeatureChange(slot.key, key)}
                  >
                    <SelectTrigger className="w-[200px] h-9 dark:bg-slate-900 dark:border-slate-700">
                      <SelectValue placeholder="Select key" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableApiKeys.map((apiKey) => (
                        <SelectItem key={apiKey} value={apiKey}>{apiKey}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })
          )}
          <div className="rounded-lg border bg-slate-50 dark:bg-slate-800 p-3 text-xs text-slate-600 dark:text-slate-400 flex items-start gap-2">
            <KeyRound className="w-4 h-4 mt-0.5 text-slate-500 dark:text-slate-400 shrink-0" />
            <span>
              Each feature can use any saved key. HERE keys power routing, polylines and map tiles (plus HERE geocoding when chosen); the Google key powers address lookup, Places and distance (plus Google routing when chosen). Changes take effect within ~5 minutes as backend caches refresh.
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}