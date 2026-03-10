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
        (position) => resolve(normalizeWebPosition(position)),
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
      (position) => onSuccess?.(normalizeWebPosition(position)),
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