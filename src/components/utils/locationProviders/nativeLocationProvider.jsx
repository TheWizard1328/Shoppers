import { BackgroundGeolocation as CapGoGeolocation } from '@capgo/background-geolocation';
import {
  isCapacitorNativeApp,
  ensureBackgroundNotificationPermission,
  getCapacitorPlatform,
} from './capacitorRuntime';

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
  if (error?.code === 'NOT_AUTHORIZED' || error?.code === 'PERMISSION_DENIED') {
    return { code: 1, message: error.message || 'Location permission denied' };
  }
  if (error?.code === 'TIMEOUT') {
    return { code: 3, message: error.message || 'Location request timed out' };
  }
  return { code: 2, message: error?.message || 'Native location error' };
};

/**
 * NativeLocationProvider — wraps @capgo/background-geolocation (Capacitor 8).
 *
 * CapGo uses a singleton start()/stop() API (no watchIds). This provider
 * normalizes the interface to match the web Geolocation API shape so the
 * LocationTracker can use it as a drop-in replacement.
 *
 * IMPORTANT: Because CapGo is singleton, only ONE tracking session can be
 * active at a time. The provider tracks an internal _active flag. Call
 * stop() before start() to switch between off-duty and on-duty tracking.
 */
class NativeLocationProvider {
  constructor() {
    this.name = 'native';
    this.backgroundCapable = true;
    this._active = false;
    this._callback = null;
  }

  isAvailable() {
    return (
      isCapacitorNativeApp() &&
      !!CapGoGeolocation &&
      typeof CapGoGeolocation.start === 'function' &&
      typeof CapGoGeolocation.stop === 'function'
    );
  }

  /**
   * Check and request background location permissions using CapGo's built-in API.
   */
  async checkPermissions() {
    if (!this.isAvailable()) return { location: 'unknown' };
    try {
      return await CapGoGeolocation.checkPermissions();
    } catch (e) {
      console.warn('📱 [NativeProvider] checkPermissions failed:', e?.message);
      return { location: 'unknown' };
    }
  }

  async requestPermissions() {
    if (!this.isAvailable()) return { location: 'unknown' };
    try {
      return await CapGoGeolocation.requestPermissions();
    } catch (e) {
      console.warn('📱 [NativeProvider] requestPermissions failed:', e?.message);
      return { location: 'unknown' };
    }
  }

  /**
   * One-shot position request. Uses start() → wait for first callback → stop().
   * If a watcher is already active, returns the last known position instead
   * of disrupting the active session.
   */
  async getCurrentPosition(options = {}) {
    if (!this.isAvailable()) {
      throw new Error('Native background geolocation is not available');
    }

    // If a watcher is already active, we can't start a new one (singleton).
    // Return the last known position if available, or start a one-shot.
    if (this._active) {
      if (this._lastPosition) {
        return normalizeNativePosition(this._lastPosition);
      }
      // No cached position — start a temporary one-shot
      // This will stop the active watcher temporarily... not ideal.
      // Better to just wait for the next callback.
      throw new Error('Native watcher already active but no cached position available');
    }

    await ensureBackgroundNotificationPermission();

    return await new Promise((resolve, reject) => {
      let settled = false;
      const timeoutMs = options.timeout ?? 10000;

      const cleanup = async () => {
        try {
          await CapGoGeolocation.stop();
          this._active = false;
        } catch (_) { /* no-op */ }
      };

      const finish = async (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        await cleanup();
        callback();
      };

      const timeoutId = setTimeout(() => {
        finish(() => reject({ code: 3, message: 'Location request timed out' }));
      }, timeoutMs);

      CapGoGeolocation.start(
        {
          requestPermissions: options.requestPermissions ?? true,
          stale: true, // Allow stale for one-shot — faster than waiting for fresh
          distanceFilter: 0,
        },
        async (location, error) => {
          if (error) {
            await finish(() => reject(normalizeNativeError(error)));
            return;
          }
          if (!location) return;
          const lat = Number(location.latitude);
          const lon = Number(location.longitude);
          if (!isValidCoord(lat, lon)) {
            console.warn(`📱 [NativeProvider] Dropping invalid GPS fix [${lat}, ${lon}] — not yet locked`);
            return;
          }
          await finish(() => resolve(normalizeNativePosition(location)));
        }
      ).then(() => {
        this._active = true;
      }).catch(async (error) => {
        clearTimeout(timeoutId);
        await finish(() => reject(normalizeNativeError(error)));
      });
    });
  }

  /**
   * Start continuous location tracking with Foreground Service.
   * Returns a sentinel (true) since CapGo is singleton — no watchId.
   * If a watcher is already active, stop it first.
   */
  async watchPosition(onSuccess, onError, options = {}) {
    if (!this.isAvailable()) {
      console.warn('📱 [NativeProvider] Not available — isCapacitorNativeApp or start/stop missing');
      throw new Error('Native background geolocation is not available');
    }

    // Singleton: stop any existing watcher before starting a new one
    if (this._active) {
      console.log('📱 [NativeProvider] Stopping existing watcher before starting new one');
      try {
        await CapGoGeolocation.stop();
      } catch (e) {
        console.warn('📱 [NativeProvider] Stop before re-start failed (non-fatal):', e?.message);
      }
      this._active = false;
    }

    console.log('📱 [NativeProvider] watchPosition called — starting Foreground Service GPS', {
      backgroundTitle: options.backgroundTitle,
      backgroundMessage: options.backgroundMessage,
      distanceFilter: options.distanceFilter,
    });

    // Ensure notification permission BEFORE starting the watcher.
    // Without this, the foreground service notification may be silently blocked
    // on Android 13+ (API 33+), which causes the OS to kill the service.
    const notifPermitted = await ensureBackgroundNotificationPermission();
    console.log('📱 [NativeProvider] Notification permission:', notifPermitted ? 'granted' : 'DENIED');

    // start() with backgroundMessage defined is what tells the plugin to
    // launch the ForegroundService and keep delivering updates in the background.
    console.log('📱 [NativeProvider] Calling CapGoGeolocation.start()...');
    this._callback = (location, error) => {
      if (error) {
        console.error('📱 [NativeProvider] watchPosition error:', error?.code, error?.message);
        onError?.(normalizeNativeError(error));
        return;
      }
      if (location) {
        const lat = Number(location.latitude);
        const lon = Number(location.longitude);
        if (!isValidCoord(lat, lon)) {
          console.warn(`📱 [NativeProvider] Dropping invalid GPS fix [${lat}, ${lon}] — not yet locked`);
          return;
        }
        this._lastPosition = location;
        onSuccess?.(normalizeNativePosition(location));
      }
    };

    await CapGoGeolocation.start(
      {
        requestPermissions: options.requestPermissions ?? true,
        stale: false,
        distanceFilter: options.distanceFilter ?? 0,
        backgroundTitle: options.backgroundTitle || 'RxDeliver — Active Delivery',
        backgroundMessage: options.backgroundMessage || 'Location is being tracked for your active deliveries.',
      },
      this._callback
    );

    this._active = true;
    console.log('✅ [NativeProvider] Foreground Service GPS started (CapGo singleton)');
    return true; // Sentinel — CapGo has no watchId
  }

  /**
   * Stop the Foreground Service and all location updates.
   * The watchId parameter is ignored (CapGo singleton).
   */
  async clearWatch(_watchId) {
    if (!this.isAvailable() || !this._active) return;
    try {
      await CapGoGeolocation.stop();
      console.log('📱 [NativeProvider] Foreground Service GPS stopped');
    } catch (e) {
      console.warn('📱 [NativeProvider] stop() failed:', e?.message);
    }
    this._active = false;
    this._callback = null;
    this._lastPosition = null;
  }
}

export const nativeLocationProvider = new NativeLocationProvider();
