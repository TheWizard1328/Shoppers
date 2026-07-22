import {
  BackgroundGeolocation,
  ensureBackgroundNotificationPermission,
  getNativeLocationAuthorization,
  isCapacitorNativeApp,
} from './capacitorRuntime';

const getBackgroundGeolocationPlugin = () => BackgroundGeolocation;

const isValidCoord = (lat, lon) =>
  typeof lat === 'number' && typeof lon === 'number' &&
  isFinite(lat) && isFinite(lon) &&
  !(Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001);

const normalizeNativePosition = (location) => ({
  coords: {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    accuracy: Number(location.accuracy ?? 0),
  },
  timestamp: Number(location.time ?? Date.now()),
});

const normalizeNativeError = (error) => {
  if (error?.code === 'NOT_AUTHORIZED') {
    return { code: 1, message: error.message || 'Location permission denied' };
  }
  if (error?.code === 'TIMEOUT') {
    return { code: 3, message: error.message || 'Location request timed out' };
  }
  return { code: 2, message: error?.message || 'Native location error' };
};

class NativeLocationProvider {
  constructor() {
    this.name = 'native';
    this.backgroundCapable = true;
  }

  isAvailable() {
    const plugin = getBackgroundGeolocationPlugin();
    return (
      isCapacitorNativeApp() &&
      !!plugin &&
      typeof plugin.addWatcher === 'function' &&
      typeof plugin.removeWatcher === 'function'
    );
  }

  async getCurrentPosition(options = {}) {
    if (!this.isAvailable()) {
      throw new Error('Native background geolocation is not available');
    }

    const plugin = getBackgroundGeolocationPlugin();
    await ensureBackgroundNotificationPermission();

    return await new Promise((resolve, reject) => {
      let watchId = null;
      let settled = false;
      const timeoutMs = options.timeout ?? 10000;

      const cleanup = async () => {
        if (!watchId) return;
        try { await plugin.removeWatcher({ id: watchId }); } catch (_) { /* no-op */ }
      };

      const finish = async (callback) => {
        if (settled) return;
        settled = true;
        await cleanup();
        callback();
      };

      const timeoutId = setTimeout(() => {
        finish(() => reject({ code: 3, message: 'Location request timed out' }));
      }, timeoutMs);

      // addWatcher with requestPermissions:true handles the OS permission dialog.
      // We do NOT pass backgroundMessage here — getCurrentPosition is foreground-only.
      plugin.addWatcher(
        {
          requestPermissions: options.requestPermissions ?? true,
          stale: false,
          distanceFilter: 0,
        },
        async (location, error) => {
          if (error) {
            clearTimeout(timeoutId);
            await finish(() => reject(normalizeNativeError(error)));
            return;
          }
          if (!location) return;
          const lat = Number(location.latitude);
          const lon = Number(location.longitude);
          if (!isValidCoord(lat, lon)) {
            console.warn(`📱 [NativeProvider] Dropping invalid GPS fix [${lat}, ${lon}] — not yet locked`);
            return; // Keep watcher alive — wait for a valid fix
          }
          clearTimeout(timeoutId);
          await finish(() => resolve(normalizeNativePosition(location)));
        }
      ).then((id) => {
        watchId = id;
      }).catch((error) => {
        clearTimeout(timeoutId);
        finish(() => reject(normalizeNativeError(error)));
      });
    });
  }

  async watchPosition(onSuccess, onError, options = {}) {
    if (!this.isAvailable()) {
      throw new Error('Native background geolocation is not available');
    }

    const plugin = getBackgroundGeolocationPlugin();

    // Ensure notification permission BEFORE starting the watcher.
    // Without this, the foreground service notification may be silently blocked
    // on Android 13+ (API 33+), which causes the OS to kill the service.
    await ensureBackgroundNotificationPermission();

    // addWatcher with backgroundMessage defined is what tells the plugin to
    // launch the ForegroundService and keep delivering updates in the background.
    // requestPermissions:true ensures it prompts for location if not already granted.
    return await plugin.addWatcher(
      {
        requestPermissions: options.requestPermissions ?? true,
        stale: false,
        distanceFilter: options.distanceFilter ?? 0,
        backgroundTitle: options.backgroundTitle || 'RxDeliver — Active Delivery',
        backgroundMessage: options.backgroundMessage || 'Location is being tracked for your active deliveries.',
      },
      (location, error) => {
        if (error) {
          onError?.(normalizeNativeError(error));
          return;
        }
        if (location) {
          const lat = Number(location.latitude);
          const lon = Number(location.longitude);
          if (!isValidCoord(lat, lon)) {
            console.warn(`📱 [NativeProvider] Dropping invalid GPS fix [${lat}, ${lon}] — not yet locked`);
            return; // Keep watcher alive — wait for a valid fix
          }
          onSuccess?.(normalizeNativePosition(location));
        }
      }
    );
  }

  async clearWatch(watchId) {
    if (!this.isAvailable() || !watchId) return;
    const plugin = getBackgroundGeolocationPlugin();
    await plugin.removeWatcher({ id: watchId });
  }
}

export const nativeLocationProvider = new NativeLocationProvider();