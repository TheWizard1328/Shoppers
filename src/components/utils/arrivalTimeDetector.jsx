import { base44 } from "@/api/base44Client";

/**
 * Detects when driver arrives at delivery/pickup locations (geofence detection)
 * Saves arrival_time when driver stays within 100m for 30+ seconds
 *
 * CRITICAL: All location lookups use offline DB only - NO live API calls on GPS pings.
 * The only API call is the final Delivery.update when an arrival is confirmed.
 */
class ArrivalTimeDetector {
  constructor() {
    this.locationTimeout = null;
    this.lastLocationCoords = null;
    this.stationaryStartTime = null;
    this.currentTargetId = null;
    this.minStationaryDuration = 30000; // 30 seconds in ms
    this.geofenceRadius = 100; // meters

    // Cached offline data - refreshed at most once per minute
    this._cachedDeliveries = null;
    this._cachedPatients = null;
    this._cachedStores = null;
    this._cachedAppUser = null;
    this._lastCacheTime = 0;
    this._cacheMaxAge = 60000; // 1 minute
    this._lastDriverId = null;
    this._lastDeliveryDate = null;
  }

  /**
   * Calculate distance between two coordinates using Haversine formula
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Refresh the offline data cache if stale or driver/date changed.
   * CRITICAL: Reads from IndexedDB only — zero live API calls.
   */
  async _refreshCacheIfNeeded(driverId, deliveryDate) {
    const now = Date.now();
    const driverOrDateChanged = driverId !== this._lastDriverId || deliveryDate !== this._lastDeliveryDate;
    const cacheExpired = (now - this._lastCacheTime) > this._cacheMaxAge;

    if (!driverOrDateChanged && !cacheExpired && this._cachedDeliveries) {
      return; // Cache still fresh
    }

    try {
      const { offlineDB } = await import('./offlineDatabase');

      // Load deliveries for this driver+date from offline DB
      const allDeliveriesForDate = await offlineDB.getByIndex(
        offlineDB.STORES.DELIVERIES,
        'delivery_date',
        deliveryDate
      );
      this._cachedDeliveries = (allDeliveriesForDate || []).filter(d => d && d.driver_id === driverId);

      // Load all patients and stores from offline DB
      this._cachedPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      this._cachedStores = await offlineDB.getAll(offlineDB.STORES.STORES);

      // Load AppUser for driver status check from offline DB
      const allAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      this._cachedAppUser = (allAppUsers || []).find(u => u && u.user_id === driverId) || null;

      this._lastCacheTime = now;
      this._lastDriverId = driverId;
      this._lastDeliveryDate = deliveryDate;
    } catch (error) {
      console.warn('⚠️ [ArrivalDetector] Failed to refresh offline cache:', error.message);
    }
  }

  /**
   * Process location update and detect arrivals.
   * Uses only offline DB for coordinate lookups — the only network call is
   * Delivery.update when an arrival is confirmed after 30+ seconds stationary.
   */
  async processLocationUpdate(latitude, longitude, driverId, deliveryDate) {
    if (!latitude || !longitude || !driverId || !deliveryDate) {
      return;
    }

    try {
      // CRITICAL: Refresh cache from offline DB only (no live API calls)
      await this._refreshCacheIfNeeded(driverId, deliveryDate);

      const allowedStatuses = ['en_route', 'in_transit'];

      // Check driver status from cached offline data
      const appUser = this._cachedAppUser;
      const activeDriverStates = ['on_duty', 'on_break', 'online'];
      if (appUser && !activeDriverStates.includes(appUser.driver_status)) {
        this.resetStationary();
        return;
      }

      const deliveries = this._cachedDeliveries || [];
      if (deliveries.length === 0) {
        this.resetStationary();
        return;
      }

      const patients = this._cachedPatients || [];
      const stores = this._cachedStores || [];

      // 1) PICKUPS-ONLY RULE
      // Eligible pickups: store pickups (no patient_id), non-finished, and both arrival_time & actual_delivery_time empty
      const eligiblePickups = deliveries.filter(d =>
        !d.patient_id && d.store_id &&
        allowedStatuses.includes(String(d.status)) &&
        !d.arrival_time && !d.actual_delivery_time
      ).map(d => {
        const store = stores.find(s => s?.id === d.store_id);
        return { d, store };
      }).filter(x => x.store?.latitude && x.store?.longitude);

      // Filter to pickups within geofence
      const pickupsInRange = eligiblePickups.filter(({ d, store }) => {
        const dist = this.calculateDistance(latitude, longitude, store.latitude, store.longitude);
        return dist <= this.geofenceRadius;
      });

      // Helper to convert HH:mm to minutes since midnight; fallback to large number
      const toMinutes = (t) => {
        if (!t || typeof t !== 'string' || !t.includes(':')) return Number.MAX_SAFE_INTEGER;
        const [h, m] = t.split(':').map(n => parseInt(n, 10));
        if (isNaN(h) || isNaN(m)) return Number.MAX_SAFE_INTEGER;
        return h * 60 + m;
      };

      // If we are at one-or-more pickup locations, pick exactly ONE using the given priority:
      // isNextDelivery → earliest Start (delivery_time_start) → earliest ETA → lowest stop_order
      if (pickupsInRange.length > 0) {
        const sorted = pickupsInRange.sort((a, b) => {
          const ad = a.d; const bd = b.d;
          // Priority 1: isNextDelivery (true first)
          if ((bd.isNextDelivery === true) - (ad.isNextDelivery === true) !== 0) {
            return (bd.isNextDelivery === true) - (ad.isNextDelivery === true);
          }
          // Priority 2: earliest delivery_time_start
          const aStart = toMinutes(ad.delivery_time_start);
          const bStart = toMinutes(bd.delivery_time_start);
          if (aStart !== bStart) return aStart - bStart;
          // Priority 3: earliest ETA (delivery_time_eta)
          const aEta = toMinutes(ad.delivery_time_eta);
          const bEta = toMinutes(bd.delivery_time_eta);
          if (aEta !== bEta) return aEta - bEta;
          // Priority 4: lowest stop_order
          const aOrder = typeof ad.stop_order === 'number' ? ad.stop_order : Number.MAX_SAFE_INTEGER;
          const bOrder = typeof bd.stop_order === 'number' ? bd.stop_order : Number.MAX_SAFE_INTEGER;
          return aOrder - bOrder;
        });

        const target = sorted[0].d;

        // We are at target pickup location
        const targetChanged = this.currentTargetId !== target.id;
        const movedTooFar = !this.lastLocationCoords ||
          this.calculateDistance(latitude, longitude, this.lastLocationCoords.lat, this.lastLocationCoords.lon) > 20;

        if (targetChanged || movedTooFar) {
          this.stationaryStartTime = Date.now();
          this.lastLocationCoords = { lat: latitude, lon: longitude };
          this.currentTargetId = target.id;
        } else if (this.stationaryStartTime) {
          const stationaryDuration = Date.now() - this.stationaryStartTime;
          if (stationaryDuration >= this.minStationaryDuration) {
            const now = new Date();
            const arrivalTime = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}T${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
            console.log(`✅ [ARRIVAL] Picked target pickup ${target.id} (rule applied) after ${(stationaryDuration / 1000).toFixed(1)}s`);
            try {
              await base44.entities.Delivery.update(target.id, { arrival_time: arrivalTime });

              // ── Write arrival_time into IDB so local state reflects it immediately ──
              try {
                const { offlineDB } = await import('./offlineDatabase');
                const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
                const existing = allDeliveries.find(d => d && d.id === target.id);
                if (existing) {
                  await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [{ ...existing, arrival_time: arrivalTime }]);
                }
              } catch (idbErr) {
                console.warn('[ARRIVAL] IDB update failed (non-critical):', idbErr.message);
              }

              // ── Push updated delivery into React local state so StopCard re-renders immediately ──
              // Use pullToSyncDataReady — AppDataContext merges deliveries array via applyDeliveryChangesLocally
              const updatedDelivery = { ...target, arrival_time: arrivalTime };
              window.dispatchEvent(new CustomEvent('pullToSyncDataReady', {
                detail: {
                  deliveries: [updatedDelivery],
                  appUsers: [],
                  patients: [],
                  deliveryDate: target.delivery_date,
                  preserveLocalState: true,
                  triggeredBy: 'arrivalDetected'
                }
              }));

              this.stationaryStartTime = Date.now();
              console.log(`💾 [ARRIVAL] Saved arrival_time for pickup ${target.id} — UI notified`);
            } catch (error) {
              console.error('❌ [ARRIVAL] Failed to save pickup arrival_time:', error);
            }
          }
        }
        return; // Done processing (pickups rule takes precedence)
      }

      // 2) FALLBACK: Original behavior (for deliveries or single, non-eligible pickups)
      // Find incomplete (non-finished, arrival_time empty) stops of any type
      const incompleteDeliveries = deliveries.filter(d => allowedStatuses.includes(String(d.status)) && !d.arrival_time);

      let driverAtLocation = false;
      for (const delivery of incompleteDeliveries) {
        let targetLat, targetLon;
        if (delivery.is_cycling_marker) {
          // Cycling markers use dedicated GPS fields
          if (!delivery.cycling_latitude || !delivery.cycling_longitude) continue;
          targetLat = delivery.cycling_latitude;
          targetLon = delivery.cycling_longitude;
        } else if (delivery.patient_id) {
          const patient = patients.find(p => p?.id === delivery.patient_id);
          if (!patient?.latitude || !patient?.longitude) continue;
          targetLat = patient.latitude;
          targetLon = patient.longitude;
        } else if (delivery.store_id) {
          const store = stores.find(s => s?.id === delivery.store_id);
          if (!store?.latitude || !store?.longitude) continue;
          targetLat = store.latitude;
          targetLon = store.longitude;
        }
        if (!targetLat || !targetLon) continue;

        const distance = this.calculateDistance(latitude, longitude, targetLat, targetLon);
        if (distance <= this.geofenceRadius) {
        driverAtLocation = true;
        const targetChanged = this.currentTargetId !== delivery.id;
        const movedTooFar = !this.lastLocationCoords ||
            this.calculateDistance(latitude, longitude, this.lastLocationCoords.lat, this.lastLocationCoords.lon) > 20;
        if (targetChanged || movedTooFar) {
          this.stationaryStartTime = Date.now();
          this.lastLocationCoords = { lat: latitude, lon: longitude };
          this.currentTargetId = delivery.id;
        } else if (this.stationaryStartTime) {
          const stationaryDuration = Date.now() - this.stationaryStartTime;
          if (stationaryDuration >= this.minStationaryDuration) {
            const _now = new Date();
            const _arrivalTime = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}T${String(_now.getHours()).padStart(2,'0')}:${String(_now.getMinutes()).padStart(2,'0')}:${String(_now.getSeconds()).padStart(2,'0')}`;
            console.log(`✅ [ARRIVAL] Detected at ${delivery.patient_id ? 'delivery' : 'pickup'} (${delivery.id}) after ${(stationaryDuration / 1000).toFixed(1)}s`);
            try {
              await base44.entities.Delivery.update(delivery.id, { arrival_time: _arrivalTime });
              this.stationaryStartTime = Date.now();
              console.log(`💾 [ARRIVAL] Saved arrival_time for ${delivery.id}`);
            } catch (error) {
              console.error('❌ [ARRIVAL] Failed to save arrival_time:', error);
            }
          }
        }
        break; // only process the first matching stop
        }
      }

      if (!driverAtLocation) {
        this.resetStationary();
      }
    } catch (error) {
      console.error('❌ [ARRIVAL] Error processing location:', error);
    }
  }

  /**
   * Reset stationary tracking
   */
  resetStationary() {
    this.stationaryStartTime = null;
    this.lastLocationCoords = null;
    this.currentTargetId = null;
  }

  /**
   * Clear recorded arrivals for the day (call on driver logout or day change)
   */
  clearRecordedArrivals() {
    this.resetStationary();
  }
}

export const arrivalTimeDetector = new ArrivalTimeDetector();