// Cache for the polylines-slot provider + key (HERE or Google).
//
// Seeded at boot from getBootstrapManifest (polylineProvider / polylineApiKey).
// Falls back to getActiveHereApiKey({ feature: 'polylines' }) which returns the
// resolved secret name + value, letting us derive the provider here.
//
// For the HERE provider no key is shipped to the client here — the route engine
// reuses the map-tiles HERE key (hereApiKeyStore) for HERE polylines, matching
// the pre-Google behavior. The Google key is only held when polylines = Google.

let _provider = null; // 'here' | 'google'
let _apiKey = null;
let _loadPromise = null;

export const seedPolylineConfig = ({ provider, apiKey } = {}) => {
  if (provider === 'here' || provider === 'google') {
    _provider = provider;
    _apiKey = provider === 'google' && apiKey && typeof apiKey === 'string' ? apiKey : null;
    if (typeof window !== 'undefined') {
      window.__polylineProvider = _provider;
      window.__polylineApiKey = _apiKey;
    }
    console.log(`✅ [PolylineKeyStore] seeded provider=${_provider}, key=${_apiKey ? 'set' : 'null'}`);
  }
};

export const getPolylineConfig = () => ({ provider: _provider || 'here', apiKey: _apiKey || null });

export const clearPolylineConfigCache = () => {
  _provider = null;
  _apiKey = null;
  _loadPromise = null;
};

export const getOrFetchPolylineConfig = async () => {
  // Resolved + (for google) key present — done.
  if (_provider === 'google' && _apiKey) return { provider: _provider, apiKey: _apiKey };
  // HERE provider needs no shipped key (engine reuses map-tiles key).
  if (_provider === 'here') return { provider: 'here', apiKey: null };

  // Pick up globals set during bootstrap.
  if (typeof window !== 'undefined') {
    const wp = window.__polylineProvider;
    const wk = window.__polylineApiKey;
    if (wp === 'here' || wp === 'google') {
      seedPolylineConfig({ provider: wp, apiKey: wk });
      return { provider: _provider, apiKey: _apiKey };
    }
  }

  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const { base44 } = await import('@/api/base44Client');
      const res = await base44.functions.invoke('getActiveHereApiKey', { feature: 'polylines' });
      const secretName = res?.data?.secretName || res?.secretName;
      const apiKey = res?.data?.apiKey || res?.apiKey || null;
      const provider = secretName === 'GOOGLE_MAPS_API_KEY' ? 'google' : 'here';
      _provider = provider;
      _apiKey = provider === 'google' ? apiKey : null;
      if (typeof window !== 'undefined') {
        window.__polylineProvider = _provider;
        window.__polylineApiKey = _apiKey;
      }
      console.log(`✅ [PolylineKeyStore] fetched provider=${_provider}, key=${_apiKey ? 'set' : 'null'}`);
      return { provider: _provider, apiKey: _apiKey };
    } catch (e) {
      console.warn('⚠️ [PolylineKeyStore] fallback fetch failed:', e?.message);
      _provider = 'here';
      _apiKey = null;
      return { provider: 'here', apiKey: null };
    } finally {
      _loadPromise = null;
    }
  })();
  return _loadPromise;
};