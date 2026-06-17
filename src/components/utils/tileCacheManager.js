/**
 * tileCacheManager.js
 *
 * Bridge between the RxDeliver app and the map-tile-sw.js Service Worker.
 *
 * Responsibilities:
 *   1. Register the SW (or reuse the existing registration)
 *   2. Tell the SW which city is active (on startup + city changes)
 *   3. Run a 30-day stale-city cleanup sweep once per session
 *   4. Expose getCacheStats() for admin dashboards
 *   5. Track whether the SW is ready (for graceful degradation)
 *
 * This module is intentionally framework-agnostic — import it anywhere.
 * It uses the globalFilters selectedCityId as the source of truth for
 * the active city, and listens to 'globalFiltersChanged' for city switches.
 */

// ─── Lazy imports ────────────────────────────────────────────────────────────
// tileCoverageManager is imported lazily to avoid circular deps at module init
let _tileCoverageManager = null;
async function getCoverageManager() {
  if (_tileCoverageManager) return _tileCoverageManager;
  _tileCoverageManager = await import('./tileCoverageManager');
  return _tileCoverageManager;
}

// ─── State ────────────────────────────────────────────────────────────────────

let _swRegistration = null;
let _swReady = false;
let _activeCityId = null;
let _initPromise = null;
const STALE_CLEANUP_KEY = 'rxdeliver_tile_sw_last_cleanup';
const STALE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _postMessage(msg) {
  if (!_swReady || !_swRegistration?.active) return false;
  try {
    _swRegistration.active.postMessage(msg);
    return true;
  } catch (e) {
    console.warn('[TileCacheMgr] postMessage failed:', e.message);
    return false;
  }
}

function _runStaleCleanupIfNeeded() {
  try {
    const last = Number(localStorage.getItem(STALE_CLEANUP_KEY) || 0);
    if (Date.now() - last < STALE_CLEANUP_INTERVAL_MS) return;
    localStorage.setItem(STALE_CLEANUP_KEY, String(Date.now()));
    _postMessage({ type: 'CLEAR_STALE_CITIES' });
    console.log('[TileCacheMgr] Triggered stale-city cache sweep');
  } catch (_) {}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the Service Worker and set the active city.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * @param {string|null} cityId  - The currently selected city ID
 * @returns {Promise<boolean>}   - true if SW is active and ready
 */
export async function initTileCacheManager(cityId) {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    if (!('serviceWorker' in navigator)) {
      console.warn('[TileCacheMgr] Service Workers not supported');
      return false;
    }

    try {
      // Register (or get existing) SW registration
      _swRegistration = await navigator.serviceWorker.register('/map-tile-sw.js', { scope: '/' });

      // Wait for the SW to become active
      await new Promise((resolve) => {
        const sw = _swRegistration.installing || _swRegistration.waiting || _swRegistration.active;
        if (_swRegistration.active) return resolve();
        if (sw) {
          sw.addEventListener('statechange', function handler() {
            if (sw.state === 'activated') {
              sw.removeEventListener('statechange', handler);
              resolve();
            }
          });
        } else {
          // Already active via navigator.serviceWorker.ready
          navigator.serviceWorker.ready.then(() => resolve());
        }
      });

      _swReady = true;
      console.log('[TileCacheMgr] SW ready');

      // Request persistent storage — prevents OS from reclaiming the tile cache
      if (navigator.storage?.persist) {
        const persisted = await navigator.storage.persist();
        console.log(`[TileCacheMgr] Persistent storage: ${persisted ? 'granted ✅' : 'not granted'}`);
      }

      // Set active city immediately
      if (cityId) {
        setActiveCityId(cityId);
      }

      // Init collective tile coverage manager
      if (cityId) {
        getCoverageManager().then(async (mgr) => {
          const { setTileCoverageCity } = await import('./hereTileCache');
          setTileCoverageCity(cityId);
          mgr.initTileCoverageManager(cityId);
        }).catch(() => {});
      }

      // Run stale-city cleanup once per day
      _runStaleCleanupIfNeeded();

      // Listen for city changes from globalFilters
      window.addEventListener('globalFiltersChanged', (e) => {
        const newCityId = e?.detail?.selectedCityId;
        if (newCityId && newCityId !== 'all' && newCityId !== _activeCityId) {
          setActiveCityId(newCityId);
          // Switch coverage manager to new city
          getCoverageManager().then(async (mgr) => {
            const htc = await import('./hereTileCache');
            htc.setTileCoverageCity(newCityId);
            mgr.initTileCoverageManager(newCityId);
          }).catch(() => {});
        }
      });

      return true;
    } catch (err) {
      console.warn('[TileCacheMgr] SW registration failed:', err.message);
      _swReady = false;
      return false;
    }
  })();

  return _initPromise;
}

/**
 * Tell the SW which city is now active.
 * Safe to call at any time — queues if SW isn't ready yet.
 */
export function setActiveCityId(cityId) {
  if (!cityId || cityId === 'all') return;
  _activeCityId = cityId;
  if (_swReady) {
    _postMessage({ type: 'SET_ACTIVE_CITY', cityId });
    console.log(`[TileCacheMgr] Active city → ${cityId}`);
  } else {
    // SW not ready yet — it will be set in initTileCacheManager when it resolves
    console.log(`[TileCacheMgr] Queued active city → ${cityId} (SW not ready)`);
  }
}

/**
 * Force-clear the tile cache for a specific city.
 * Used when admin changes city bounds or a manual cache-wipe is needed.
 */
export function clearCityCache(cityId) {
  if (!cityId) return;
  _postMessage({ type: 'CLEAR_CITY_CACHE', cityId });
}

/**
 * Get cache statistics from the SW.
 * Returns a Promise that resolves with stats, or null if SW isn't available.
 */
export function getCacheStats() {
  if (!_swReady) return Promise.resolve(null);
  return new Promise((resolve) => {
    const handler = (e) => {
      if (e.data?.type === 'CACHE_STATS') {
        navigator.serviceWorker.removeEventListener('message', handler);
        resolve(e.data);
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    _postMessage({ type: 'GET_CACHE_STATS' });
    // Timeout after 3s
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener('message', handler);
      resolve(null);
    }, 3000);
  });
}

/** @returns {boolean} Whether the SW is active and serving tiles */
export function isTileSWReady() {
  return _swReady;
}

/** @returns {string|null} The currently active city ID */
export function getActiveCityId() {
  return _activeCityId;
}
