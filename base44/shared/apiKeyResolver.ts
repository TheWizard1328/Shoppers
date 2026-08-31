// Shared per-feature API-key resolver for backend (Deno) functions.
//
// Each map feature (route optimization, polylines, map tiles, address lookup,
// places autocomplete, place details, eta/distance) can be assigned any of the
// available API keys stored as secrets. This module resolves the secret NAME
// for a given feature from AppSettings.setting_value.per_feature_api_keys,
// with a per-feature 5-minute in-process cache (so changing one slot does not
// reset the cache for the other features) and a legacy fallback to the old
// single selected_api_key / selected_here_api_key fields.
//
// Usage:
//   import { resolveFeatureApiKey, resolveFeatureSecretName, isGoogleKey } from '../../shared/apiKeyResolver.ts';
//   const apiKey = await resolveFeatureApiKey(base44, 'route_optimization');

const SECRET_NAME_MAP: Record<string, string> = {
  HERE_API_KEY: 'HERE_API_KEY',
  Here_API_Key_2: 'Here_API_Key_2',
  Here_API_Key_3: 'Here_API_Key_3',
  GOOGLE_MAPS_API_KEY: 'GOOGLE_MAPS_API_KEY',
};

// Sensible defaults per feature — HERE keys for routing/polyline/tile work,
// Google key for the geocoding/places/distance features (their original provider).
const DEFAULT_FEATURE_KEYS: Record<string, string> = {
  route_optimization: 'HERE_API_KEY',
  polylines: 'HERE_API_KEY',
  map_tiles: 'HERE_API_KEY',
  address_lookup: 'GOOGLE_MAPS_API_KEY',
  places_autocomplete: 'GOOGLE_MAPS_API_KEY',
  place_details: 'GOOGLE_MAPS_API_KEY',
  eta_distance: 'GOOGLE_MAPS_API_KEY',
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _cache = new Map<string, { secretName: string; expiresAt: number }>();

/**
 * Resolve the secret NAME (e.g. 'HERE_API_KEY') for a feature.
 * Pass `refreshConfig` (the full setting_value object) to skip the AppSettings
 * query when the caller already fetched it.
 */
export async function resolveFeatureSecretName(
  base44: any,
  feature: string,
  refreshConfig: Record<string, any> | null = null,
): Promise<string> {
  const now = Date.now();
  const cached = _cache.get(feature);
  if (cached && now < cached.expiresAt) {
    return cached.secretName;
  }

  let cfg = refreshConfig;
  if (!cfg) {
    const settings = await base44.asServiceRole.entities.AppSettings.filter(
      { setting_key: 'refresh_intervals' },
      '-updated_date',
      1,
    );
    cfg = settings?.[0]?.setting_value || {};
  }

  const map = cfg.per_feature_api_keys || {};
  let selected = map[feature];

  if (!selected || !SECRET_NAME_MAP[selected]) {
    // Legacy fallback: a single selected key used to drive everything.
    const legacy = cfg.selected_api_key || cfg.selected_here_api_key;
    if (legacy && SECRET_NAME_MAP[legacy]) {
      selected = legacy;
    } else {
      selected = DEFAULT_FEATURE_KEYS[feature] || 'HERE_API_KEY';
    }
  }

  const secretName = SECRET_NAME_MAP[selected] || DEFAULT_FEATURE_KEYS[feature] || 'HERE_API_KEY';
  _cache.set(feature, { secretName, expiresAt: now + CACHE_TTL_MS });
  return secretName;
}

/**
 * Resolve the actual API-key VALUE for a feature (reads the secret from Deno.env).
 */
export async function resolveFeatureApiKey(base44: any, feature: string): Promise<string | null> {
  const secretName = await resolveFeatureSecretName(base44, feature);
  return (Deno as any).env.get(secretName) || null;
}

/**
 * Clear the cache for one feature (or all features when omitted).
 */
export function clearFeatureApiKeyCache(feature?: string): void {
  if (feature) _cache.delete(feature);
  else _cache.clear();
}

/**
 * True when the resolved key is the Google Maps key (vs. a HERE key).
 */
export function isGoogleKey(secretNameOrKey: string): boolean {
  return secretNameOrKey === 'GOOGLE_MAPS_API_KEY';
}

// Provider matrix — which providers each feature's implementation supports.
// Used to filter the admin UI dropdown and to decide which keys to ship to the client.
export const FEATURE_PROVIDERS: Record<string, string[]> = {
  route_optimization: ['here'],
  polylines: ['here', 'google'],
  map_tiles: ['here'],
  address_lookup: ['here', 'google'],
  places_autocomplete: ['google'],
  place_details: ['google'],
  eta_distance: ['here', 'google'],
};

/**
 * Classify a resolved secret name as 'here' | 'google' | null.
 */
export function classifyProvider(secretName: string): string | null {
  if (!secretName) return null;
  if (secretName === 'GOOGLE_MAPS_API_KEY') return 'google';
  if (SECRET_NAME_MAP[secretName]) return 'here';
  return null;
}

/**
 * Resolve the provider ('here' | 'google' | null) for a feature.
 * Pass refreshConfig to skip the AppSettings query when the caller already has it.
 */
export async function resolveFeatureProvider(
  base44: any,
  feature: string,
  refreshConfig: Record<string, any> | null = null,
): Promise<string | null> {
  const secretName = await resolveFeatureSecretName(base44, feature, refreshConfig);
  return classifyProvider(secretName);
}