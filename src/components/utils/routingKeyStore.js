// Cache for the route_optimization slot's HERE API key.
//
// The client route engine (clientRouteEngine.js) calls HERE findsequence2 to
// sequence stops. That call must use the key assigned to the 'route_optimization'
// feature slot — NOT the 'map_tiles' key (which the tile layer uses and which
// hereApiKeyStore holds). The two slots can point at different HERE secrets, and
// a dead map_tiles key must not poison route sequencing.
//
// Seeded at boot from getBootstrapManifest (routeOptimizationKey). Falls back to
// getActiveHereApiKey({ feature: 'route_optimization' }), then to the map-tiles
// key as a last resort.

import { getOrFetchHereApiKey } from '@/components/utils/hereApiKeyStore';

let _routingKey = null;
let _loadPromise = null;

export const seedRoutingKey = (key) => {
  if (key && typeof key === 'string') {
    _routingKey = key;
    if (typeof window !== 'undefined') window.__routingApiKey = key;
    console.log('✅ [RoutingKeyStore] route-optimization key seeded');
  }
};

export const clearRoutingKeyCache = () => {
  _routingKey = null;
  _loadPromise = null;
};

export const getRoutingKey = () => _routingKey;

export const getOrFetchRoutingKey = async () => {
  if (_routingKey) return _routingKey;
  if (typeof window !== 'undefined' && window.__routingApiKey) {
    _routingKey = window.__routingApiKey;
    return _routingKey;
  }
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const { base44 } = await import('@/api/base44Client');
      const res = await base44.functions.invoke('getActiveHereApiKey', { feature: 'route_optimization' });
      const key = res?.data?.apiKey || res?.apiKey || null;
      if (key) {
        _routingKey = key;
        if (typeof window !== 'undefined') window.__routingApiKey = key;
        console.log('✅ [RoutingKeyStore] route-optimization key fetched');
        return key;
      }
      // No key resolved — fall back to the map-tiles key so routing still works
      // when the admin hasn't configured a separate route_optimization slot.
      return await getOrFetchHereApiKey();
    } catch (e) {
      console.warn('⚠️ [RoutingKeyStore] fetch failed, falling back to map-tiles key:', e?.message);
      return await getOrFetchHereApiKey();
    } finally {
      _loadPromise = null;
    }
  })();
  return _loadPromise;
};

// Bust the cache when API key settings change so the next optimization re-resolves.
if (typeof window !== 'undefined') {
  window.addEventListener('appSettingsUpdated', () => clearRoutingKeyCache());
}