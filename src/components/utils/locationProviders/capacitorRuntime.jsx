import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { BackgroundGeolocation as CapGoGeolocation } from '@capgo/background-geolocation';

// CapGo's background-geolocation plugin (v8) — singleton start()/stop() API.
// Re-exported as BackgroundGeolocation for compatibility with existing code.
export const BackgroundGeolocation = CapGoGeolocation;

export const isCapacitorNativeApp = () => {
  try {
    const hasCapacitor = typeof Capacitor !== 'undefined';
    const hasMethod = hasCapacitor && typeof Capacitor?.isNativePlatform === 'function';
    const isNative = hasMethod && Capacitor.isNativePlatform();
    // Log once per page load for diagnostics
    if (hasCapacitor && !window.__capacitorChecked) {
      window.__capacitorChecked = true;
      console.log(`📱 [Capacitor] Detected: hasCapacitor=${hasCapacitor}, hasMethod=${hasMethod}, isNative=${isNative}, platform=${hasCapacitor ? Capacitor.getPlatform?.() : 'N/A'}`);
      // Log app identity (bundle ID, version, build) to help diagnose which APK is installed
      // com.rxdeliver.driver = GitHub Actions build (correct), com.rxdeliver.app = stale Base44 builder
      if (isNative && !window.__appIdentityLogged) {
        window.__appIdentityLogged = true;
        import('@capacitor/app').then(({ App }) => {
          App.getInfo().then((info) => {
            console.log(`📱 [Capacitor] App Identity: id=${info.id}, version=${info.version}, build=${info.build}, name=${info.name}`);
            console.log(`📱 [Capacitor] Native download interface: ${typeof window.AndroidNative !== 'undefined' ? 'present (com.rxdeliver.driver)' : 'absent (com.rxdeliver.app?)'}`);
          }).catch((e) => console.warn('📱 [Capacitor] App.getInfo() failed:', e?.message));
        }).catch((e) => console.warn('📱 [Capacitor] @capacitor/app not available:', e?.message));
      }
    }
    return isNative;
  } catch (e) {
    console.warn('📱 [Capacitor] Detection failed:', e?.message);
    return false;
  }
};

export const getCapacitorPlatform = () => {
  if (typeof Capacitor?.getPlatform === 'function') {
    return Capacitor.getPlatform();
  }
  return 'web';
};

export const ensureBackgroundNotificationPermission = async () => {
  if (!isCapacitorNativeApp() || getCapacitorPlatform() !== 'android') {
    return true;
  }

  try {
    const permissionStatus = await LocalNotifications.checkPermissions();
    if (permissionStatus.display === 'granted') {
      return true;
    }
    const requested = await LocalNotifications.requestPermissions();
    return requested.display === 'granted';
  } catch (e) {
    console.warn('[capacitorRuntime] Could not check/request notification permissions:', e?.message);
    return false;
  }
};

// -----------------------------------------------------------------
// CapGo @capgo/background-geolocation (v8) exposes checkPermissions()
// and requestPermissions() — use the new passthrough functions above.
//
// On Android 10+ (API 29+) the OS enforces a two-step flow:
//   Step 1 — start(requestPermissions: true) triggers "Allow while using the app"
//   Step 2 — To get "Allow all the time" (background), the user must
//             go to Settings > App > Permissions > Location > "Allow
//             all the time". This CANNOT be triggered by a runtime
//             dialog on Android 11+ — only openSettings() can direct
//             them there.
//
// We use the standard Geolocation API (navigator.permissions) to
// check whether foreground permission was granted. For background
// permission, use checkNativeGeolocationPermissions() above.
// -----------------------------------------------------------------

export const getNativeLocationAuthorization = async () => {
  if (!isCapacitorNativeApp()) {
    return { granted: false, status: 'web' };
  }

  // Use the Web Permissions API to check location status — this works
  // inside Capacitor's WebView and returns 'granted', 'denied', or 'prompt'.
  try {
    const result = await navigator.permissions.query({ name: 'geolocation' });
    const status = result.state; // 'granted' | 'denied' | 'prompt'
    const granted = status === 'granted';

    // Android does not expose whether background was granted via the
    // Permissions API — we flag it as unknown so callers can handle it.
    return { granted, backgroundGranted: null, status, permissions: result };
  } catch (e) {
    console.warn('[capacitorRuntime] navigator.permissions.query failed:', e?.message);
    // Fallback — assume granted if we can't check (start() will error if not)
    return { granted: true, backgroundGranted: null, status: 'unknown' };
  }
};

// Opens the app's Android Settings page so the user can manually
// set Location permission to "Allow all the time".
export const openAndroidLocationSettings = async () => {
  if (isCapacitorNativeApp() && typeof BackgroundGeolocation?.openSettings === 'function') {
    await BackgroundGeolocation.openSettings();
  }
};

// CapGo v8 exposes checkPermissions()/requestPermissions() — use these for
// proper background location permission handling on Android 10+.
export const checkNativeGeolocationPermissions = async () => {
  if (!isCapacitorNativeApp() || typeof BackgroundGeolocation?.checkPermissions !== 'function') {
    return { location: 'unknown', backgroundLocation: 'unknown', notification: 'unknown' };
  }
  try {
    return await BackgroundGeolocation.checkPermissions();
  } catch (e) {
    console.warn('[capacitorRuntime] checkPermissions failed:', e?.message);
    return { location: 'unknown', backgroundLocation: 'unknown', notification: 'unknown' };
  }
};

export const requestNativeGeolocationPermissions = async (permissions) => {
  if (!isCapacitorNativeApp() || typeof BackgroundGeolocation?.requestPermissions !== 'function') {
    return { location: 'unknown', backgroundLocation: 'unknown', notification: 'unknown' };
  }
  try {
    return await BackgroundGeolocation.requestPermissions(permissions ? { permissions } : undefined);
  } catch (e) {
    console.warn('[capacitorRuntime] requestPermissions failed:', e?.message);
    return { location: 'unknown', backgroundLocation: 'unknown', notification: 'unknown' };
  }
};

export const requestNativeLocationAuthorization = async () => {
  if (!isCapacitorNativeApp()) {
    return { granted: false, backgroundGranted: false, status: 'web' };
  }

  // The plugin requests permissions itself via addWatcher(requestPermissions: true).
  // We just check whether foreground location is available.
  const current = await getNativeLocationAuthorization();
  return current;
};

/**
 * Request "Allow all the time" background location permission.
 *
 * On Android 10+ (API 29+), this triggers the system background location
 * dialog ONLY if foreground location is already granted. If foreground
 * is not yet granted, it falls back to requesting foreground first, then
 * background on a subsequent call.
 *
 * This is the key function for enabling always-on GPS — it lets the app
 * programmatically prompt for "Allow all the time" instead of forcing the
 * user to dig through Settings.
 */
export const requestBackgroundLocationPermission = async () => {
  if (!isCapacitorNativeApp() || typeof BackgroundGeolocation?.requestPermissions !== 'function') {
    return { location: 'unknown', backgroundLocation: 'unknown' };
  }
  try {
    // First check current state
    const current = await BackgroundGeolocation.checkPermissions();
    const fgGranted = current?.location === 'granted';
    const bgGranted = current?.backgroundLocation === 'granted';

    if (bgGranted) {
      return { location: 'granted', backgroundLocation: 'granted', alreadyGranted: true };
    }

    // Request background location — the plugin handles the "foreground must be
    // granted first" check internally. If foreground isn't granted yet, it
    // requests that first, then background.
    const result = await BackgroundGeolocation.requestPermissions({
      permissions: ['backgroundLocation']
    });
    return result || { location: 'unknown', backgroundLocation: 'unknown' };
  } catch (e) {
    console.warn('[capacitorRuntime] requestBackgroundLocationPermission failed:', e?.message);
    return { location: 'unknown', backgroundLocation: 'unknown', error: e?.message };
  }
};
