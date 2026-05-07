/**
 * Singleton store for the HERE API key.
 * Fetched once during app initialization (from getBootstrapManifest or AppSettings)
 * and reused by all functions that need to call the HERE API.
 */

const SECRET_NAME_MAP = {
  HERE_API_KEY: 'HERE_API_KEY',
  Here_API_Key_2: 'Here_API_Key_2',
  Here_API_Key_3: 'Here_API_Key_3'
};

let _cachedApiKey = null;
let _isLoading = false;
let _loadPromise = null;

/**
 * Seed the HERE API key directly from a known value (e.g. from bootstrap manifest).
 * Call this during app initialization before any HERE API calls.
 */
export const seedHereApiKey = (key) => {
  if (key && typeof key === 'string') {
    _cachedApiKey = key;
    _loadPromise = Promise.resolve(key);
    console.log('✅ [HereApiKeyStore] HERE API key seeded from bootstrap manifest');
  }
};

/**
 * Initialize the HERE API key from the backend (fallback if not seeded at boot).
 * Safe to call multiple times.
 */
export const initHereApiKey = async () => {
  if (_cachedApiKey) return _cachedApiKey;
  if (_loadPromise) return _loadPromise;

  _isLoading = true;
  _loadPromise = (async () => {
    try {
      const { base44 } = await import('@/api/base44Client');
      const response = await base44.functions.invoke('getActiveHereApiKey', {});
      const key = response?.data?.apiKey || response?.apiKey || null;
      if (key) {
        _cachedApiKey = key;
        console.log('✅ [HereApiKeyStore] HERE API key fetched and cached');
      }
      return key;
    } catch (error) {
      console.warn('⚠️ [HereApiKeyStore] Failed to fetch HERE API key:', error?.message);
      return null;
    } finally {
      _isLoading = false;
    }
  })();

  return _loadPromise;
};

/**
 * Get the cached HERE API key synchronously.
 * Returns null if not yet loaded.
 */
export const getHereApiKey = () => _cachedApiKey;

/**
 * Get the HERE API key, fetching it if not already cached.
 * Will auto-seed from window.__hereApiKey if available (set during bootstrap).
 */
export const getOrFetchHereApiKey = async () => {
  if (_cachedApiKey) return _cachedApiKey;
  // Check if the bootstrap manifest already set the key via window global
  const manifestKey = typeof window !== 'undefined' ? window.__hereApiKey : null;
  if (manifestKey) {
    seedHereApiKey(manifestKey);
    return _cachedApiKey;
  }
  return initHereApiKey();
};

/**
 * Clear the cached key (e.g. when AppSettings changes).
 */
export const clearHereApiKeyCache = () => {
  _cachedApiKey = null;
  _loadPromise = null;
  _isLoading = false;
};