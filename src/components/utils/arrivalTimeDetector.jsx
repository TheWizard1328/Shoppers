import { base44 } from "@/api/base44Client";

/**
 * Detects when driver arrives at delivery/pickup locations (geofence detection)
 * Saves arrival_time when driver stays within 100m for 30+ seconds
 */
class ArrivalTimeDetector {
  constructor() {
    this.locationTimeout = null;
    this.lastLocationCoords = null;
    this.stationaryStartTime = null;
    this.minStationaryDuration = 30000; // 30 seconds in ms
    this.geofenceRadius = 100; // meters
    this.arrivalTimesRecorded = new Set(); // Track recorded arrivals to avoid duplicates
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
   * Process location update and detect arrivals
   */
  async processLocationUpdate(latitude, longitude, driverId, deliveryDate) {
    if (!latitude || !longitude || !driverId || !deliveryDate) {
      return;
    }

    try {
      // Fetch driver's deliveries for the day
      const deliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      if (!deliveries || deliveries.length === 0) {
        this.resetStationary();
        return;
      }

      // Get patients and stores for location lookup
      const patients = await base44.entities.Patient.list();
      const stores = await base44.entities.Store.list();

      // 1) PICKUPS-ONLY RULE
      // Eligible pickups: store pickups (no patient_id), non-finished, and both arrival_time & actual_delivery_time empty
      const eligiblePickups = deliveries.filter(d =>
        !d.patient_id && d.store_id &&
        !['completed', 'failed', 'cancelled'].includes(d.status) &&
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
        if (!this.lastLocationCoords ||
            this.calculateDistance(latitude, longitude, this.lastLocationCoords.lat, this.lastLocationCoords.lon) > 20) {
          // New spot: start timer
          this.stationaryStartTime = Date.now();
          this.lastLocationCoords = { lat: latitude, lon: longitude };
        } else if (this.stationaryStartTime) {
          const stationaryDuration = Date.now() - this.stationaryStartTime;
          if (stationaryDuration >= this.minStationaryDuration && !this.arrivalTimesRecorded.has(target.id)) {
            const arrivalTime = new Date().toISOString();
            console.log(`✅ [ARRIVAL] Picked target pickup ${target.id} (rule applied) after ${(stationaryDuration / 1000).toFixed(1)}s`);
            try {
              await base44.entities.Delivery.update(target.id, { arrival_time: arrivalTime });
              this.arrivalTimesRecorded.add(target.id);
              console.log(`💾 [ARRIVAL] Saved arrival_time for pickup ${target.id}`);
            } catch (error) {
              console.error('❌ [ARRIVAL] Failed to save pickup arrival_time:', error);
            }
          }
        }
        return; // Done processing (pickups rule takes precedence)
      }

      // 2) FALLBACK: Original behavior (for deliveries or single, non-eligible pickups)
      // Find incomplete (non-finished, arrival_time empty) stops of any type
      const incompleteDeliveries = deliveries.filter(d => !['completed','failed','cancelled'].includes(d.status) && !d.arrival_time);

      let driverAtLocation = false;
      for (const delivery of incompleteDeliveries) {
        let targetLat, targetLon;
        if (delivery.patient_id) {
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
          if (!this.lastLocationCoords ||
              this.calculateDistance(latitude, longitude, this.lastLocationCoords.lat, this.lastLocationCoords.lon) > 20) {
            this.stationaryStartTime = Date.now();
            this.lastLocationCoords = { lat: latitude, lon: longitude };
          } else if (this.stationaryStartTime) {
            const stationaryDuration = Date.now() - this.stationaryStartTime;
            if (stationaryDuration >= this.minStationaryDuration && !this.arrivalTimesRecorded.has(delivery.id)) {
              const now = new Date().toISOString();
              console.log(`✅ [ARRIVAL] Detected at ${delivery.patient_id ? 'delivery' : 'pickup'} (${delivery.id}) after ${(stationaryDuration / 1000).toFixed(1)}s`);
              try {
                await base44.entities.Delivery.update(delivery.id, { arrival_time: now });
                this.arrivalTimesRecorded.add(delivery.id);
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
  }

  /**
   * Clear recorded arrivals for the day (call on driver logout or day change)
   */
  clearRecordedArrivals() {
    this.arrivalTimesRecorded.clear();
    this.resetStationary();
  }
}

export const arrivalTimeDetector = new ArrivalTimeDetector();