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

    // Get current deliveries for this driver
    try {
      const deliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      if (!deliveries || deliveries.length === 0) {
        this.resetStationary();
        return;
      }

      // Get patients and stores for location data
      const patients = await base44.entities.Patient.list();
      const stores = await base44.entities.Store.list();

      // Find deliveries/pickups without arrival times
      const incompleteDeliveries = deliveries.filter(d => {
        // Skip if already completed or no arrival_time recorded
        if (d.arrival_time) return false;
        // Skip finished deliveries
        if (['completed', 'failed', 'cancelled'].includes(d.status)) return false;
        return true;
      });

      let driverAtLocation = false;

      // Check distance to each incomplete delivery
      for (const delivery of incompleteDeliveries) {
        let targetLat, targetLon;

        if (delivery.patient_id) {
          // Regular delivery - use patient location
          const patient = patients.find(p => p?.id === delivery.patient_id);
          if (!patient?.latitude || !patient?.longitude) continue;
          targetLat = patient.latitude;
          targetLon = patient.longitude;
        } else if (delivery.store_id) {
          // Pickup - use store location
          const store = stores.find(s => s?.id === delivery.store_id);
          if (!store?.latitude || !store?.longitude) continue;
          targetLat = store.latitude;
          targetLon = store.longitude;
        }

        if (!targetLat || !targetLon) continue;

        // Calculate distance
        const distance = this.calculateDistance(latitude, longitude, targetLat, targetLon);

        if (distance <= this.geofenceRadius) {
          driverAtLocation = true;

          // Check if this is a new location or same location as before
          if (!this.lastLocationCoords ||
              this.calculateDistance(latitude, longitude, this.lastLocationCoords.lat, this.lastLocationCoords.lon) > 20) {
            // New location detected - reset timer
            this.stationaryStartTime = Date.now();
            this.lastLocationCoords = { lat: latitude, lon: longitude };
          } else if (this.stationaryStartTime) {
            // Same location - check if 30+ seconds elapsed
            const stationaryDuration = Date.now() - this.stationaryStartTime;
            
            if (stationaryDuration >= this.minStationaryDuration && !this.arrivalTimesRecorded.has(delivery.id)) {
              // Record arrival time
              const now = new Date();
              const arrivalTime = now.toISOString();

              console.log(`✅ [ARRIVAL] Detected at ${delivery.patient_id ? 'delivery' : 'pickup'} (${delivery.id}) after ${(stationaryDuration / 1000).toFixed(1)}s`);

              try {
                await base44.entities.Delivery.update(delivery.id, {
                  arrival_time: arrivalTime
                });
                
                this.arrivalTimesRecorded.add(delivery.id);
                console.log(`💾 [ARRIVAL] Saved arrival_time for delivery ${delivery.id}`);
              } catch (error) {
                console.error('❌ [ARRIVAL] Failed to save arrival_time:', error);
              }
            }
          }

          break; // Only process closest delivery
        }
      }

      // Reset if not at any location
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