/**
 * ProximityForegroundTrigger — auto-foreground the native APK when the driver
 * enters the approach radius of their isNextDelivery stop.
 *
 * How it works:
 *   • The native APK keeps GPS alive in the background via the CapGo foreground
 *     service, so this module keeps receiving position updates while the app is
 *     backgrounded (same pipeline that feeds arrivalTimeDetector).
 *   • On every position update (only while the app is HIDDEN and the driver is
 *     on duty), we look up the current isNextDelivery stop from IndexedDB
 *     (zero network calls), resolve its coordinates (cycling marker → patient →
 *     store), and check the haversine distance.
 *   • Within TRIGGER_RADIUS_M (150m) we call window.AndroidNative.bringToFront(),
 *     a JS-bridge method implemented in MainActivity.java. The native side:
 *       1. No-ops if the app is already in the foreground.
 *       2. Directly relaunches MainActivity if "Display over other apps"
 *          (SYSTEM_ALERT_WINDOW) is granted — true auto-foreground, screen on.
 *       3. Otherwise posts a full-screen-intent notification (auto-opens the app
 *          when the screen is off / over the lock screen; heads-up banner when
 *          the screen is on).
 *   • One trigger per stop approach: after firing, the trigger disarms until the
 *     driver leaves REARM_RADIUS_M (400m) or the isNextDelivery stop changes.
 *     A global cooldown also prevents notification spam.
 *
 * PHI note: the notification title/body intentionally contain NO patient data —
 * HIA-safe on the lock screen.
 *
 * Platform notes:
 *   • Android native APK (com.rxdeliver.driver): full support (bridge above).
 *   • iOS: the native trigger is gated to the Android platform. There is
 *     currently no native iOS shell in the repo, and iOS does not permit an app
 *     to bring itself to the foreground under any circumstance — the best any
 *     future iOS shell can do is a region-monitoring local notification.
 */

import { isCapacitorNativeApp, getCapacitorPlatform } from './locationProviders/capacitorRuntime';

const TRIGGER_RADIUS_M = 150;
const REARM_RADIUS_M = 400;
const GLOBAL_COOLDOWN_MS = 60 * 1000;
const ENABLED_KEY = 'rxdeliver_auto_foreground_enabled'; // localStorage ('1' = on, default on)
const CACHE_TTL_MS = 10 * 1000; // matches arrivalTimeDetector cache cadence

const ALLOWED_STATUSES = ['en_route', 'in_transit'];

class ProximityForegroundTrigger {
  constructor() {
    // Offline cache (same pattern as arrivalTimeDetector — refreshed at most every 10s)
    this._cachedDeliveries = null;
    this._cachedPatients = null;
    this._cachedStores = null;
    this._lastCacheTime = 0;
    this._lastDriverId = null;
    this._lastDeliveryDate = null;

    // Trigger state
    this._armedStopId = null; // stop id the trigger has fired for (disarmed until re-arm)
    this._lastTriggerAt = 0;
    this._lastLoggedStatus = '';
  }

  _isNativeAndroidApk() {
    try {
      if (typeof window === 'undefined' || !window.AndroidNative) return false;
      if (!isCapacitorNativeApp() || getCapacitorPlatform() !== 'android') return false;
      return typeof window.AndroidNative.bringToFront === 'function';
    } catch (e) {
      return false;
    }
  }

  isEnabled() {
    try {
      return localStorage.getItem(ENABLED_KEY) !== '0';
    } catch (e) {
      return true;
    }
  }

  setEnabled(enabled) {
    try {
      localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
    } catch (e) { /* ignore */ }
  }

  /**
   * Haversine distance in meters (same formula as arrivalTimeDetector).
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  async _refreshCacheIfNeeded(driverId, deliveryDate) {
    const now = Date.now();
    const driverOrDateChanged = driverId !== this._lastDriverId || deliveryDate !== this._lastDeliveryDate;
    const cacheExpired = (now - this._lastCacheTime) > CACHE_TTL_MS;

    if (!driverOrDateChanged && !cacheExpired && this._cachedDeliveries) {
      return;
    }

    try {
      const { offlineDB } = await import('./offlineDatabase');
      const allDeliveriesForDate = await offlineDB.getByIndex(
        offlineDB.STORES.DELIVERIES,
        'delivery_date',
        deliveryDate
      );
      this._cachedDeliveries = (allDeliveriesForDate || []).filter((d) => d && d.driver_id === driverId);
      this._cachedPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      this._cachedStores = await offlineDB.getAll(offlineDB.STORES.STORES);
      this._lastCacheTime = now;
      this._lastDriverId = driverId;
      this._lastDeliveryDate = deliveryDate;
    } catch (error) {
      console.warn('⚠️ [ProximityForeground] Failed to refresh offline cache:', error?.message || error);
    }
  }

  /**
   * Resolve the target coordinates for the flagged next stop.
   * Same resolution order as arrivalTimeDetector: cycling marker → patient → store.
   */
  _resolveTargetCoords(nextDelivery) {
    if (!nextDelivery) return null;
    if (nextDelivery.is_cycling_marker) {
      if (nextDelivery.cycling_latitude && nextDelivery.cycling_longitude) {
        return { lat: nextDelivery.cycling_latitude, lon: nextDelivery.cycling_longitude };
      }
      return null;
    }
    if (nextDelivery.patient_id) {
      const patient = (this._cachedPatients || []).find((p) => p && p.id === nextDelivery.patient_id);
      if (patient?.latitude && patient?.longitude) {
        return { lat: patient.latitude, lon: patient.longitude };
      }
      return null;
    }
    if (nextDelivery.store_id) {
      const store = (this._cachedStores || []).find((s) => s && s.id === nextDelivery.store_id);
      if (store?.latitude && store?.longitude) {
        return { lat: store.latitude, lon: store.longitude };
      }
    }
    return null;
  }

  /**
   * Main entry — called from locationTracker on every on-duty GPS update.
   * All gating happens here; caller does not need to check anything.
   */
  async processLocationUpdate(latitude, longitude, driverId, deliveryDate) {
    if (typeof latitude !== 'number' || typeof longitude !== 'number' || !driverId || !deliveryDate) {
      return;
    }

    // Native Android APK only — the bridge method must exist
    if (!this._isNativeAndroidApk()) return;

    // Kill switch (default ON)
    if (!this.isEnabled()) return;

    // Only when the app is actually backgrounded — no point "foregrounding"
    // the app when it's already on screen.
    if (typeof document !== 'undefined' && !document.hidden) return;

    try {
      await this._refreshCacheIfNeeded(driverId, deliveryDate);

      const deliveries = this._cachedDeliveries || [];
      if (deliveries.length === 0) return;

      // The flagged next stop — same gate as arrival detection
      const nextDelivery = deliveries.find(
        (d) =>
          d &&
          d.isNextDelivery === true &&
          ALLOWED_STATUSES.includes(String(d.status)) &&
          !d.arrival_time // don't re-trigger once arrival has been recorded
      );
      if (!nextDelivery) return;

      const target = this._resolveTargetCoords(nextDelivery);
      if (!target) return;

      const distance = this.calculateDistance(latitude, longitude, target.lat, target.lon);

      // Re-arm: driver left the approach radius → allow a future trigger for this stop
      if (distance > REARM_RADIUS_M && this._armedStopId === nextDelivery.id) {
        this._armedStopId = null;
      }

      // New flagged stop → re-arm (route moved on after completing a stop)
      if (this._armedStopId && this._armedStopId !== nextDelivery.id) {
        this._armedStopId = null;
      }

      if (distance > TRIGGER_RADIUS_M) return;
      if (this._armedStopId === nextDelivery.id) return;
      if (Date.now() - this._lastTriggerAt < GLOBAL_COOLDOWN_MS) return;

      // ── Fire ──
      this._armedStopId = nextDelivery.id;
      this._lastTriggerAt = Date.now();

      const status = window.AndroidNative.bringToFront(
        'Approaching your next stop',
        'You are close to your next delivery — tap to open RxDeliver'
      );

      if (status !== this._lastLoggedStatus) {
        this._lastLoggedStatus = status;
        console.log(`📲 [ProximityForeground] Trigger fired for stop ${nextDelivery.id} @ ${Math.round(distance)}m → native status: ${status}`);
      }

      // Fire-and-forget diagnostic (non-blocking, best-effort)
      try {
        import('./locationTracker').then(({ locationTracker: _tracker }) => {
          if (typeof _tracker?._logLocationRemote === 'function') {
            _tracker._logLocationRemote('info', 'PROXIMITY_FOREGROUND', {
              stop_id: nextDelivery.id,
              distance_m: Math.round(distance),
              native_status: status,
            });
          }
        });
      } catch (_) { /* non-critical */ }
    } catch (error) {
      console.warn('⚠️ [ProximityForeground] processLocationUpdate failed:', error?.message || error);
    }
  }

  /**
   * Clear trigger state (e.g. on off-duty toggle / route deletion).
   */
  reset() {
    this._armedStopId = null;
    this._lastTriggerAt = 0;
  }
}

export const proximityForegroundTrigger = new ProximityForegroundTrigger();
export default proximityForegroundTrigger;
