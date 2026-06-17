import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

export const isCapacitorNativeApp = () => {
  return typeof Capacitor?.isNativePlatform === 'function' && Capacitor.isNativePlatform();
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
// NOTE: @capacitor-community/background-geolocation does NOT expose
// checkPermissions() or requestPermissions() — the plugin handles
// permission prompting internally inside addWatcher() when
// requestPermissions: true is set.
//
// On Android 10+ (API 29+) the OS enforces a two-step flow:
//   Step 1 — addWatcher() triggers "Allow while using the app"
//   Step 2 — To get "Allow all the time" (background), the user must
//             go to Settings > App > Permissions > Location > "Allow
//             all the time". This CANNOT be triggered by a runtime
//             dialog on Android 11+ — only openSettings() can direct
//             them there.
//
// We use the standard Geolocation API (navigator.permissions) to
// check whether background permission was already granted. If it
// hasn't been, we surface a UI prompt and call openSettings().
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
    // Fallback — assume granted if we can't check (addWatcher will error if not)
    return { granted: true, backgroundGranted: null, status: 'unknown' };
  }
};

// Opens the app's Android Settings page so the user can manually
// set Location permission to "Allow all the time".
export const openAndroidLocationSettings = async () => {
  const plugin = BackgroundGeolocation;
  if (isCapacitorNativeApp() && typeof plugin?.openSettings === 'function') {
    await plugin.openSettings();
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
