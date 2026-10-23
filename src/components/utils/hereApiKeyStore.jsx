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
let _serverVerified = false; // true once the key came from bootstrap/server THIS session
let _revalidatePromise = null;
let _isLoading = false;
let _loadPromise = null;

/**
 * Seed the HERE API key directly from a known value (e.g. from bootstrap manifest).
 * Call this during app initialization before any HERE API calls.
 */
export const seedHereApiKey = (key) => {
  if (key && typeof key === 'string') {
    _cachedApiKey = key;
    _serverVerified = true;
    _loadPromise = Promise.resolve(key);
    // Persist (owner directive Oct 15 2026): a fresh boot while the backend is
    // degraded (DB timeouts) can't fetch the key from the server — HERE calls
    // and polyline generation then fail. The last known key survives in
    // localStorage so routing works even when every server read times out.
    try { localStorage.setItem('rx_here_key_v1', key); } catch (_) {}
    console.log('✅ [HereApiKeyStore] HERE API key seeded from bootstrap manifest');
  }
};

/**
 * Initialize the HERE API key from the backend (fallback if not seeded at boot).
 * Fires at most ONE backend call per page session — the global promise is reused
 * by every subsequent caller so only a single getActiveHereApiKey invocation occurs.
 */
export const initHereApiKey = async () => {
  // Already available — no network call needed
  if (_cachedApiKey) return _cachedApiKey;
  // Last-known key from localStorage (backend may be unreachable)
  try {
    const _saved = localStorage.getItem('rx_here_key_v1');
    if (_saved) {
      _cachedApiKey = _saved;
      _loadPromise = Promise.resolve(_saved);
      if (typeof window !== 'undefined') window.__hereApiKey = _saved;
      console.log('✅ [HereApiKeyStore] HERE API key restored from localStorage (provisional — revalidating)');
      // Provisional only: confirm with the server in the background so a rotated
      // key can't strand the map on dead tiles (see revalidateFromServer).
      revalidateFromServer();
      return _saved;
    }
  } catch (_) {}
  // Re-use the in-flight (or already-resolved) promise so concurrent callers collapse
  if (_loadPromise) return _loadPromise;

  _isLoading = true;
  _loadPromise = (async () => {
    try {
      const { base44 } = await import('@/api/base44Client');
      const response = await base44.functions.invoke('getActiveHereApiKey', {});
      const key = response?.data?.apiKey || response?.apiKey || null;
      if (key) {
        _cachedApiKey = key;
        _serverVerified = true;
        try { localStorage.setItem('rx_here_key_v1', key); } catch (_) {}
        // Also expose via window so any late seedHereApiKey callers can pick it up
        if (typeof window !== 'undefined') window.__hereApiKey = key;
        console.log('✅ [HereApiKeyStore] HERE API key fetched and cached (fallback path)');
      }
      return key;
    } catch (error) {
      console.warn('⚠️ [HereApiKeyStore] Failed to fetch HERE API key:', error?.message);
      // Do NOT null out _loadPromise — prevents a retry storm on repeated failures.
      // The next page reload will try again fresh.
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
export const getHereApiKey = () => {
  if (_cachedApiKey) return _cachedApiKey;
  // BOOT PERF (Oct 22 2026, owner report: map tiles/markers/polylines render
  // ~10s AFTER the rest of the dashboard): the key was only seeded once the
  // bootstrap manifest returned, so the map's FIRST render (useState init
  // reads this getter synchronously) saw null -> no tile layer, no HERE-gated
  // children until an async dynamic import + manifest round trip finished.
  // The last known key is persisted in localStorage by every successful
  // seed/fetch; restore it synchronously so tiles start on the very first
  // render. Server value still wins later (seed/fetch/appSettingsUpdated
  // overwrite the cache + trigger a re-render only if the key changed).
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('rx_here_key_v1') : null;
    if (saved) {
      _cachedApiKey = saved;
      if (typeof window !== 'undefined' && !window.__hereApiKey) window.__hereApiKey = saved;
      return saved;
    }
  } catch (_) {}
  return null;
};

/**
 * Get the HERE API key, fetching it if not already cached.
 * Will auto-seed from window.__hereApiKey if available (set during bootstrap).
 */
// STALE-KEY GUARD (owner report Oct 22 evening: APK preview map stuck blank
// while everything else loaded). The Oct 22 boot change restores the last key
// from localStorage SYNCHRONOUSLY so tiles start on first render — but if that
// saved key was rotated/rejected, the cached value short-circuited every later
// fetch (`if (_cachedApiKey) return`), so the CORRECT key was never fetched and
// every tile request 401/403'd forever. Now a localStorage-restored key is
// treated as provisional: the first getOrFetchHereApiKey() per session
// revalidates against the server and swaps the key in if it differs.
const revalidateFromServer = () => {
  if (_revalidatePromise) return _revalidatePromise;
  _revalidatePromise = (async () => {
    try {
      const { base44 } = await import('@/api/base44Client');
      const response = await base44.functions.invoke('getActiveHereApiKey', {});
      const key = response?.data?.apiKey || response?.apiKey || null;
      if (key) {
        _serverVerified = true;
        if (key !== _cachedApiKey) {
          console.warn('🔑 [HereApiKeyStore] Saved HERE key was stale — replaced with server key');
          _cachedApiKey = key;
          _loadPromise = Promise.resolve(key);
          try { localStorage.setItem('rx_here_key_v1', key); } catch (_) {}
          if (typeof window !== 'undefined') window.__hereApiKey = key;
        }
        return key;
      }
    } catch (error) {
      console.warn('⚠️ [HereApiKeyStore] Key revalidation failed:', error?.message);
    }
    // Allow ONE later retry (e.g. next map mount) instead of locking out forever.
    _revalidatePromise = null;
    return _cachedApiKey;
  })();
  return _revalidatePromise;
};

export const getOrFetchHereApiKey = async () => {
  if (_cachedApiKey) {
    if (_serverVerified) return _cachedApiKey;
    // Provisional (localStorage) key: confirm with the server, return whichever wins.
    return revalidateFromServer();
  }
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
  _serverVerified = false;
  _revalidatePromise = null;
  _loadPromise = null;
  _isLoading = false;
};