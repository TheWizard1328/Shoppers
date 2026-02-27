/**
 * Utility for updating patient GPS coordinates based on the driver's current device location.
 * Ensures we grab a fresh GPS fix (not stale cached coords) and updates Patient + distance_from_store.
 */

import { base44 } from "@/api/base44Client";
import { toast } from "sonner";

// Haversine distance in KM (rounded to 2 decimals)
const haversineKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return +(R * c).toFixed(2);
};

// Get a fresh device location using the Geolocation API (high accuracy, no cache)
const getFreshDeviceLocation = () => {
  return new Promise((resolve, reject) => {
    if (!navigator?.geolocation) {
      reject(new Error("Geolocation is not supported on this device/browser"));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        });
      },
      (err) => {
        reject(new Error(err?.message || "Failed to get device location"));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
};

/**
 * Update patient GPS using a fresh device location
 * @param {Object} params
 * @param {string} params.patientId
 * @param {string} params.storeId
 * @param {Array} params.stores - full stores list to look up coordinates
 * @returns {Promise<{success:boolean, message:string, distance?:number}>}
 */
export const updatePatientGPS = async ({ patientId, storeId, stores }) => {
  try {
    if (!patientId) throw new Error("Missing patientId");
    if (!storeId) throw new Error("Select a store before updating GPS");

    const store = Array.isArray(stores) ? stores.find((s) => s && s.id === storeId) : null;
    if (!store?.latitude || !store?.longitude) throw new Error("Selected store has no coordinates");

    // 1) Fresh location from device
    const fresh = await getFreshDeviceLocation();

    // 2) Compute distance from store
    const distanceKm = haversineKm(store.latitude, store.longitude, fresh.latitude, fresh.longitude);

    // 3) Update patient
    await base44.entities.Patient.update(patientId, {
      latitude: fresh.latitude,
      longitude: fresh.longitude,
      distance_from_store: distanceKm,
    });

    // 4) Notify UI
    toast.success("Patient GPS Updated", {
      description: `Location saved. Distance from store: ${distanceKm} km`,
    });

    return { success: true, message: "GPS updated", distance: distanceKm };
  } catch (error) {
    toast.error("Failed to Update GPS", { description: error.message || "Could not update location" });
    return { success: false, message: error.message || "Failed to update GPS" };
  }
};

export default updatePatientGPS;