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
