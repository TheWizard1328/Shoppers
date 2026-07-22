const isValidCoord = (lat, lon) =>
  typeof lat === 'number' && typeof lon === 'number' &&
  isFinite(lat) && isFinite(lon) &&
  !(Math.abs(lat) < 0.0001 && Math.abs(lon) < 0.0001);

const normalizeWebPosition = (position) => ({
  coords: {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
  },
  timestamp: position.timestamp || Date.now(),
});

class WebLocationProvider {
  constructor() {
    this.name = 'web';
    this.backgroundCapable = false;
  }

  isAvailable() {
    return typeof navigator !== 'undefined' && !!navigator.geolocation;
  }

  async getCurrentPosition(options = {}) {
    if (!this.isAvailable()) {
      throw new Error('Geolocation is not supported by this browser');
    }

    return await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          if (!isValidCoord(latitude, longitude)) {
            reject(new Error(`Invalid GPS fix [${latitude}, ${longitude}] — not yet locked`));
            return;
          }
          resolve(normalizeWebPosition(position));
        },
        reject,
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
          ...options,
        }
      );
    });
  }

  watchPosition(onSuccess, onError, options = {}) {
    if (!this.isAvailable()) {
      throw new Error('Geolocation is not supported by this browser');
    }

    return navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        if (!isValidCoord(latitude, longitude)) {
          console.warn(`🌐 [WebProvider] Dropping invalid GPS fix [${latitude}, ${longitude}] — not yet locked`);
          return;
        }
        onSuccess?.(normalizeWebPosition(position));
      },
      (error) => onError?.(error),
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
        ...options,
      }
    );
  }

  clearWatch(watchId) {
    if (this.isAvailable() && watchId !== null && typeof watchId !== 'undefined') {
      navigator.geolocation.clearWatch(watchId);
    }
  }
}

export const webLocationProvider = new WebLocationProvider();