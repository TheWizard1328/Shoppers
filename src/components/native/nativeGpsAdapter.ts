/**
 * Native GPS adapter — abstracts the difference between:
 *   - Capacitor BackgroundGeolocation plugin (native APK: always-on, foreground service)
 *   - navigator.geolocation (web/PWA: existing behavior, suspended when backgrounded)
 *
 * The existing locationTracker.jsx calls startTracking/watchPosition.
 * On native, we swap that for the background geolocation plugin which runs
 * a native foreground service — GPS stays active with screen off, app backgrounded,
 * and device locked. No code changes needed in locationTracker.jsx beyond
 * importing this adapter and calling start()/stop() instead of the raw API.
 *
 * Battery profile: 10s interval, 10m displacement filter, high accuracy mode.
 * The foreground notification ("RxDeliver GPS Active") prevents Android from
 * killing the service and keeps the user informed that tracking is running.
 */

import { isNative } from './nativePlatform';

export interface GpsPosition {
  lat: number;
  lng: number;
  accuracy: number;
  speed: number | null;
  heading: number | null;
  timestamp: number;
}

type PositionCallback = (pos: GpsPosition) => void;
type ErrorCallback = (err: Error) => void;

export class NativeGpsAdapter {
  private watchId: string | null = null;
  private listener: PositionCallback | null = null;
  private errorListener: ErrorCallback | null = null;
  private nativePlugin: any = null;

  async loadPlugin() {
    if (this.nativePlugin) return this.nativePlugin;
    try {
      const mod = await import('@capacitor-community/background-geolocation');
      this.nativePlugin = mod.BackgroundGeolocation;
    } catch {
      this.nativePlugin = null;
    }
    return this.nativePlugin;
  }

  /**
   * Start GPS tracking.
   * On native: starts the foreground service with background geolocation.
   * On web: falls back to navigator.geolocation.watchPosition.
   */
  async start(onPosition: PositionCallback, onError?: ErrorCallback): Promise<void> {
    this.listener = onPosition;
    this.errorListener = onError || null;

    if (!isNative()) {
      // ── Web/PWA fallback: existing behavior ──
      this.startWebWatch();
      return;
    }

    // ── Native: Capacitor BackgroundGeolocation ──
    const plugin = await this.loadPlugin();
    if (!plugin) {
      console.warn('[NativeGpsAdapter] Plugin not available, falling back to web GPS');
      this.startWebWatch();
      return;
    }

    try {
      // Request permissions (Android 12+ needs foreground service + location)
      const permResult = await plugin.requestPermissions();
      if (permResult?.location !== 'granted') {
        console.warn('[NativeGpsAdapter] Location permission denied, falling back to web');
        this.startWebWatch();
        return;
      }

      // Listen for location updates
      await plugin.addListener('onLocation', (result: any) => {
        if (result?.location) {
          this.listener?.({
            lat: result.location.latitude,
            lng: result.location.longitude,
            accuracy: result.location.accuracy || 0,
            speed: result.location.speed ?? null,
            heading: result.location.bearing ?? null,
            timestamp: result.location.time || Date.now(),
          });
        }
      });

      // Listen for errors
      await plugin.addListener('onError', (error: any) => {
        this.errorListener?.(new Error(error?.message || 'Background geolocation error'));
      });

      // Configure and start
      await plugin.configure({
        // High accuracy for delivery routing
        locationAccuracy: 100, // PRIORITY_HIGH_ACCURACY
        interval: 10000,       // 10 seconds
        fastestInterval: 5000, // 5 seconds (if another app requests faster updates)
        smallestDisplacement: 10, // 10 meters
        startForeground: true,
        notificationTitle: 'RxDeliver GPS Active',
        notificationText: 'Location tracking is running',
      });

      await plugin.start();
      console.log('[NativeGpsAdapter] Background geolocation started (foreground service active)');
    } catch (err: any) {
      console.error('[NativeGpsAdapter] Failed to start native GPS:', err?.message);
      this.startWebWatch();
    }
  }

  /**
   * Web/PWA fallback — uses navigator.geolocation.watchPosition.
   * This is the existing behavior, preserved for browser/PWA users.
   */
  private startWebWatch() {
    if (!navigator?.geolocation) {
      this.errorListener?.(new Error('Geolocation not supported'));
      return;
    }

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.listener?.({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          speed: pos.coords.speed,
          heading: pos.coords.heading,
          timestamp: pos.timestamp,
        });
      },
      (err) => {
        this.errorListener?.(new Error(err.message));
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000,
      }
    );
  }

  /**
   * Stop GPS tracking.
   * On native: stops the foreground service.
   * On web: clears the watchPosition.
   */
  async stop(): Promise<void> {
    if (!isNative()) {
      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(Number(this.watchId));
        this.watchId = null;
      }
      return;
    }

    const plugin = await this.loadPlugin();
    if (plugin) {
      try {
        await plugin.stop();
        await plugin.removeAllListeners();
        console.log('[NativeGpsAdapter] Background geolocation stopped');
      } catch (err: any) {
        console.error('[NativeGpsAdapter] Error stopping:', err?.message);
      }
    }
  }

  /**
   * Check if GPS is currently tracking.
   */
  isTracking(): boolean {
    return this.watchId !== null || isNative();
  }
}
