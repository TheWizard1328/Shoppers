// Shared client-side provider matrix + key classification.
// Mirrors base44/shared/apiKeyResolver.ts (FEATURE_PROVIDERS / classifyProvider).
// Used by PerFeatureApiKeysCard (dropdown filtering) and the polyline key store.

export const KEY_PROVIDER = {
  HERE_API_KEY: 'here',
  Here_API_Key_2: 'here',
  Here_API_Key_3: 'here',
  GOOGLE_MAPS_API_KEY: 'google',
};

// feature -> list of providers its implementation actually supports.
export const FEATURE_PROVIDERS = {
  route_optimization: ['here'],
  polylines: ['here', 'google'],
  map_tiles: ['here'],
  address_lookup: ['here', 'google'],
  places_autocomplete: ['google'],
  place_details: ['google'],
  eta_distance: ['here', 'google'],
};

export const PROVIDER_LABEL = { here: 'HERE', google: 'Google' };

export function classifyKeyProvider(secretName) {
  if (!secretName) return null;
  return KEY_PROVIDER[secretName] || null;
}

export function keySupportsFeature(secretName, feature) {
  const providers = FEATURE_PROVIDERS[feature];
  if (!providers) return true;
  const provider = classifyKeyProvider(secretName);
  return provider ? providers.includes(provider) : false;
}