import {
  isCapacitorNativeApp,
  getCapacitorPlatform,
  getNativeLocationAuthorization,
  requestNativeLocationAuthorization,
  openAndroidLocationSettings,
} from './locationProviders/capacitorRuntime';

/**
 * LOCATION PERMISSION GATE — single source of truth
 * ────────────────────────────────────────────────────────────────────────────
 * OWNER REQUEST (Nov 20 2026): "Is there any way we can check for location
 * permissions before trying to pull the GPS so that if the device's location
 * services have not been granted then we just either cancel the location updates
 * or we notify the user... and give them an option that automatically allows
 * them to reapprove location services."
 *
 * WHY: on iOS web/PWA the location grant is effectively per-session, so a
 * swipe-away relaunch re-asks. The app used to pull a fix on boot no matter what
 * (dispatcher map watch, duty auto-resume), so every cold start re-triggered the
 * OS prompt, and on a denied device every attempt burned a full timeout and
 * logged a failure row (Erin's iPhone, 37 rows in one hour).
 *
 * RULES:
 *  1. NEVER pull a fix before asking this module whether we are allowed.
 *  2. 'granted'  → behave exactly as before, no extra UI.
 *  3. 'denied'   → cancel location updates, show the modal once with a Settings path.
 *  4. 'prompt'   → cancel the AUTOMATIC boot pull and wait for a real user action
 *                  (going on duty, or the modal's Enable button) to trigger the OS
 *                  prompt, because browsers only show it from a gesture.
 *  5. 'unknown'  → iOS Safari does not expose geolocation in the Permissions API.
 *                  Fall back to the cached result of the last real attempt; with
 *                  no cache, treat as 'prompt' (defer, never spam).
 *
 * States: 'granted' | 'denied' | 'prompt' | 'unknown'
 */

const CACHE_KEY = 'rxdeliver_location_permission_v1';
export const LOCATION_PERMISSION_EVENT = 'rxdeliver:location-permission';
export const LOCATION_PERMISSION_NEEDED_EVENT = 'rxdeliver:location-permission-needed';

const _readCache = () => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.state) return null;
    return parsed;
  } catch {
    return null;
  }
};

const _writeCache = (state, extra = {}) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      state,
      backgroundGranted: extra.backgroundGranted ?? null,
      platform: extra.platform || (isCapacitorNativeApp() ? getCapacitorPlatform() : 'web'),
      checkedAt: Date.now(),
    }));
  } catch { /* storage full / private mode — the in-memory result still applies */ }
};

const _emit = (detail) => {
  try {
    window.dispatchEvent(new CustomEvent(LOCATION_PERMISSION_EVENT, { detail }));
  } catch { /* no window (shouldn't happen in the app) */ }
};

export const isLocationGranted = (state) => state === 'granted';

/**
 * Ask the OS what our location permission is. Never prompts.
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{state: string, backgroundGranted: (boolean|null), platform: string, source: string}>}
 */
export const getLocationPermission = async (opts = {}) => {
  const cached = _readCache();

  // Native APK: the CapGo plugin reports the REAL OS permission, which the
  // WebView's Permissions API does not mirror reliably.
  if (isCapacitorNativeApp()) {
    try {
      const auth = await getNativeLocationAuthorization();
      const state = auth?.granted ? 'granted' : (auth?.status === 'denied' ? 'denied' : 'prompt');
      const result = {
        state,
        backgroundGranted: auth?.backgroundGranted ?? null,
        platform: getCapacitorPlatform(),
        source: 'native',
      };
      _writeCache(state, result);
      return result;
    } catch {
      // fall through to web check
    }
  }

  // Web / PWA. iOS Safari rejects 'geolocation' here, hence the cache fallback.
  try {
    if (navigator?.permissions?.query) {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      const state = status?.state === 'granted'
        ? 'granted'
        : (status?.state === 'denied' ? 'denied' : 'prompt');
      const result = { state, backgroundGranted: null, platform: 'web', source: 'permissions-api' };
      _writeCache(state, result);
      return result;
    }
  } catch { /* iOS Safari / older browsers */ }

  if (cached?.state) {
    return {
      state: cached.state,
      backgroundGranted: cached.backgroundGranted ?? null,
      platform: cached.platform || 'web',
      source: 'cache',
    };
  }

  // No API, no history. Defer rather than spam the OS prompt.
  return { state: 'prompt', backgroundGranted: null, platform: 'web', source: 'default' };
};

/**
 * Trigger the real OS prompt. MUST be called from a user gesture (tap) or the
 * browser silently refuses to show it.
 * @returns {Promise<{state: string, backgroundGranted: (boolean|null), platform: string}>}
 */
export const requestLocationPermission = async () => {
  if (isCapacitorNativeApp()) {
    try {
      const auth = await requestNativeLocationAuthorization();
      const state = auth?.granted ? 'granted' : (auth?.status === 'denied' ? 'denied' : 'prompt');
      const result = {
        state,
        backgroundGranted: auth?.backgroundGranted ?? null,
        platform: getCapacitorPlatform(),
      };
      _writeCache(state, result);
      _emit(result);
      return result;
    } catch {
      /* fall through to web attempt */
    }
  }

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    const result = { state: 'denied', backgroundGranted: null, platform: 'web' };
    _writeCache(result.state, result);
    _emit(result);
    return result;
  }

  const result = await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve({ state: 'granted', backgroundGranted: null, platform: 'web' }),
      (err) => resolve({
        // code 1 = PERMISSION_DENIED. Anything else (timeout / unavailable) means
        // we are still allowed to try again later, so the grant stands.
        state: err?.code === 1 ? 'denied' : 'prompt',
        backgroundGranted: null,
        platform: 'web',
      }),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  });

  _writeCache(result.state, result);
  _emit(result);
  return result;
};

/**
 * Open the OS settings page so the user can flip location back on. Only Android
 * APK can be deep-linked; iOS web can only be told what to tap.
 */
export const openLocationSettings = async () => {
  try {
    if (isCapacitorNativeApp()) {
      await openAndroidLocationSettings();
      return true;
    }
  } catch { /* ignore */ }
  return false;
};

/** Tell the modal to open (used when an action is blocked by a missing grant). */
export const notifyLocationPermissionNeeded = (reason = 'blocked_action') => {
  try {
    window.dispatchEvent(new CustomEvent(LOCATION_PERMISSION_NEEDED_EVENT, { detail: { reason } }));
  } catch { /* ignore */ }
};

/**
 * Boot-time convenience: may we pull a fix without a user gesture?
 * Anything other than a confirmed grant says no.
 */
export const canAutoPullLocation = async () => {
  const { state } = await getLocationPermission();
  return isLocationGranted(state);
};
