import { BackgroundGeolocation, ensureBackgroundNotificationPermission, getCapacitorPlatform, isCapacitorNativeApp } from './capacitorRuntime';

const getBackgroundGeolocationPlugin = () => BackgroundGeolocation;

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

  return {
    code: 2,
    message: error?.message || 'Native location error',
  };
};

class NativeLocationProvider {
  constructor() {
    this.name = 'native';
    this.backgroundCapable = true;
  }

  isAvailable() {
    const plugin = getBackgroundGeolocationPlugin();
    return isCapacitorNativeApp() && !!plugin && typeof plugin.addWatcher === 'function' && typeof plugin.removeWatcher === 'function';
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
        try {
          await plugin.removeWatcher({ id: watchId });
        } catch (_) {
          // no-op
        }
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
    await ensureBackgroundNotificationPermission();

    return await plugin.addWatcher(
      {
        requestPermissions: options.requestPermissions ?? true,
        stale: false,
        distanceFilter: options.distanceFilter ?? 0,
        backgroundTitle: options.backgroundTitle || 'RxDeliver location tracking',
        backgroundMessage: options.backgroundMessage || 'Tracking delivery location in the background.',
      },
      (location, error) => {
        if (error) {
          onError?.(normalizeNativeError(error));
          return;
        }

        if (location) {
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