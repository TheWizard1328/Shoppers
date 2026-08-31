import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MapPinned, KeyRound } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { realtimeSync } from '../utils/realtimeSync';
import { classifyKeyProvider, keySupportsFeature, PROVIDER_LABEL } from '@/components/utils/apiKeyProviders';

// Feature slot definitions — order here is the order shown in the card.
// `providers` lists which providers the feature's implementation actually supports;
// the dropdown only offers keys whose classified provider is in this list.
// `defaultKey` is used during migration from the legacy single selected_api_key.
const FEATURE_SLOTS = [
  { key: 'route_optimization', label: 'Route optimization', providers: ['here'], defaultKey: 'HERE_API_KEY' },
  { key: 'polylines', label: 'Polylines', providers: ['here', 'google'], defaultKey: 'HERE_API_KEY' },
  { key: 'map_tiles', label: 'Map tiles', providers: ['here'], defaultKey: 'HERE_API_KEY' },
  { key: 'address_lookup', label: 'Address lookup', providers: ['here', 'google'], defaultKey: 'GOOGLE_MAPS_API_KEY' },
  { key: 'places_autocomplete', label: 'Places autocomplete', providers: ['google'], defaultKey: 'GOOGLE_MAPS_API_KEY' },
  { key: 'place_details', label: 'Place Details', providers: ['google'], defaultKey: 'GOOGLE_MAPS_API_KEY' },
  { key: 'eta_distance', label: 'ETA / distance', providers: ['here', 'google'], defaultKey: 'GOOGLE_MAPS_API_KEY' },
];

function migratePerFeatureKeys(raw) {
  const map = (raw && typeof raw === 'object') ? raw : {};
  // Detect a previously-saved per_feature_api_keys map
  const existing = map.per_feature_api_keys;
  if (existing && typeof existing === 'object') {
    const result = {};
    for (const slot of FEATURE_SLOTS) {
      const saved = existing[slot.key];
      // Keep the saved key if it still supports this slot; otherwise fall back to the default.
      result[slot.key] = saved && keySupportsFeature(saved, slot.key) ? saved : slot.defaultKey;
    }
    return result;
  }
  // Migration: read the legacy single selected_api_key/selected_here_api_key
  const legacySelected = map.selected_api_key || map.selected_here_api_key;
  const isHereLegacy = legacySelected && legacySelected !== 'GOOGLE_MAPS_API_KEY';
  const result = {};
  for (const slot of FEATURE_SLOTS) {
    if (slot.providers.includes('here') && isHereLegacy && legacySelected && keySupportsFeature(legacySelected, slot.key)) {
      result[slot.key] = legacySelected;
    } else {
      result[slot.key] = slot.defaultKey;
    }
  }
  return result;
}

export default function PerFeatureApiKeysCard({ availableApiKeys }) {
  const [perFeatureKeys, setPerFeatureKeys] = useState(() =>
    Object.fromEntries(FEATURE_SLOTS.map((s) => [s.key, s.defaultKey])),
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
    <Card
      className="rounded-[14px] border border-[#3a2e24] transition-all"
      style={{ backgroundColor: '#241c17', color: '#ffffff' }}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-bold tracking-tight" style={{ color: '#ffffff' }}>
          <MapPinned className="w-5 h-5 text-amber-500" />
          API Provider Keys
        </CardTitle>
        <CardDescription style={{ color: '#a89b8f' }}>
          Choose which API key each map feature uses. Each dropdown only lists keys whose provider that feature supports.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2.5">
          {isLoading ? (
            <div className="text-sm py-2" style={{ color: '#a89b8f' }}>Loading…</div>
          ) : (
            FEATURE_SLOTS.map((slot) => {
              const value = perFeatureKeys[slot.key] || slot.defaultKey;
              const isSaving = savingFeature === slot.key;
              const isSaved = savedFeature === slot.key;
              // Only offer keys whose provider this feature's implementation supports.
              const allowedKeys = (availableApiKeys || []).filter((k) => keySupportsFeature(k, slot.key));
              // If the currently-saved key is outside this slot's supported providers
              // (e.g. a legacy migration left a Google key on a HERE-only slot), surface it
              // as a disabled item with a hint rather than hiding it.
              const valueProviderOk = keySupportsFeature(value, slot.key);
              const showUnsupportedCurrent = !valueProviderOk && value && !allowedKeys.includes(value);
              return (
                <div
                  key={slot.key}
                  className={`flex items-center justify-between gap-3 rounded-[10px] border p-2.5 transition-all ${
                    isSaved
                      ? 'border-amber-500 bg-amber-500/10'
                      : isSaving
                        ? 'border-amber-400 bg-amber-500/5'
                        : 'border-[#3a2e24]'
                  }`}
                  style={!isSaved && !isSaving ? { backgroundColor: '#1a1410' } : undefined}
                >
                  <Label className="text-sm font-medium flex-1 truncate" style={{ color: '#d6cfc7' }}>
                    {slot.label}
                  </Label>
                  <Select
                    value={value}
                    onValueChange={(key) => handleFeatureChange(slot.key, key)}
                  >
                    <SelectTrigger
                      className="w-[220px] h-9 border-[#3a2e24] focus:border-amber-500"
                      style={{ backgroundColor: '#241c17', color: '#ffffff' }}
                    >
                      <SelectValue placeholder="Select key" />
                    </SelectTrigger>
                    <SelectContent
                      className="border-[#3a2e24]"
                      style={{ backgroundColor: '#241c17', color: '#ffffff' }}
                    >
                      {showUnsupportedCurrent && (
                        <SelectItem
                          key={`__unsupported_${value}`}
                          value={value}
                          disabled
                          className="opacity-50 data-[highlighted]:bg-transparent"
                        >
                          <span className="flex items-center gap-2">
                            <span className="text-amber-600/80">[{PROVIDER_LABEL[classifyKeyProvider(value)] || '?'}]</span>
                            <span>{value}</span>
                            <span className="text-xs italic" style={{ color: '#a89b8f' }}>— switch provider</span>
                          </span>
                        </SelectItem>
                      )}
                      {allowedKeys.map((apiKey) => (
                        <SelectItem
                          key={apiKey}
                          value={apiKey}
                          className="focus:bg-amber-500/20 focus:text-white data-[highlighted]:bg-amber-500/20 data-[highlighted]:text-white"
                        >
                          <span className="flex items-center gap-2">
                            <span className="text-amber-500/90">[{PROVIDER_LABEL[classifyKeyProvider(apiKey)] || '?'}]</span>
                            <span>{apiKey}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })
          )}
          <div
            className="rounded-[10px] border border-[#3a2e24] p-3 text-xs flex items-start gap-2"
            style={{ backgroundColor: '#1a1410', color: '#a89b8f' }}
          >
            <KeyRound className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" />
            <span>
              HERE keys power routing, polylines and map tiles (plus HERE geocoding/distance when chosen); the Google key powers address lookup, Places, distance — and now polylines when assigned. Each dropdown only shows keys usable for that feature. Changes take effect within ~5 minutes as backend caches refresh.
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}