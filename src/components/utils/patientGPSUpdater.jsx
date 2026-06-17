/**
 * Utility for updating patient GPS coordinates based on either the map crosshair or device location.
 * Ensures we use the preferred source and updates Patient + distance_from_store.
 */

import { base44 } from "@/api/base44Client";
import { toast } from "sonner";

// Simple in-module throttle to prevent rapid repeated GPS updates
let _gpsUpdateInFlight = false;
let _gpsUpdateLastAt = 0;

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
 * Update patient GPS using either the map crosshair or a fresh device location.
 * @param {Object} params
 * @param {string} params.patientId
 * @param {string} params.storeId
 * @param {Array} params.stores - full stores list to look up coordinates
 * @param {{latitude:number, longitude:number}|null} [params.mapCrosshairCoords]
 * @param {boolean} [params.preferCrosshair=false]
 * @param {{latitude?:number, longitude?:number}|null} [params.currentPatientCoords]
 * @returns {Promise<{success:boolean, message:string, distance?:number}>}
 */
export const updatePatientGPS = async ({ patientId, storeId, stores, mapCrosshairCoords = null, preferCrosshair = false, currentPatientCoords = null }) => {
  const now = Date.now();
  if (_gpsUpdateInFlight || now - _gpsUpdateLastAt < 4000) {
    toast("Please wait... GPS update in progress");
    return { success: false, message: "GPS update already in progress" };
  }
  _gpsUpdateInFlight = true;
  _gpsUpdateLastAt = now;
  try {
    if (!patientId) throw new Error("Missing patientId");
    if (!storeId) throw new Error("Select a store before updating GPS");

    const store = Array.isArray(stores) ? stores.find((s) => s && s.id === storeId) : null;
    if (!store?.latitude || !store?.longitude) throw new Error("Selected store has no coordinates");

    const hasCrosshairCoords = Number.isFinite(mapCrosshairCoords?.latitude) && Number.isFinite(mapCrosshairCoords?.longitude);

    const fresh = preferCrosshair && hasCrosshairCoords ? null : await getFreshDeviceLocation();

    // 2) Choose best coordinates
    let nextLatitude = fresh?.latitude;
    let nextLongitude = fresh?.longitude;
    let updateSource = 'device';

    if (hasCrosshairCoords && preferCrosshair) {
      nextLatitude = mapCrosshairCoords.latitude;
      nextLongitude = mapCrosshairCoords.longitude;
      updateSource = 'crosshair';
    } else if (
      hasCrosshairCoords &&
      fresh &&
      Number.isFinite(currentPatientCoords?.latitude) &&
      Number.isFinite(currentPatientCoords?.longitude) &&
      haversineKm(fresh.latitude, fresh.longitude, currentPatientCoords.latitude, currentPatientCoords.longitude) > 0.1
    ) {
      nextLatitude = mapCrosshairCoords.latitude;
      nextLongitude = mapCrosshairCoords.longitude;
      updateSource = 'crosshair';
    }

    if (!Number.isFinite(nextLatitude) || !Number.isFinite(nextLongitude)) {
      throw new Error('No valid coordinates available for GPS update');
    }

    // 3) Compute distance from store
    const distanceKm = haversineKm(store.latitude, store.longitude, nextLatitude, nextLongitude);

    // 4) Update ONLY the selected patient directly
    const existingPatient = await base44.entities.Patient.get(patientId);
    await base44.entities.Patient.update(patientId, {
      latitude: nextLatitude,
      longitude: nextLongitude,
      distance_from_store: distanceKm,
    });

    // 5) Log this as a "Direct Change" pending admin review for bulk propagation —
    //    but ONLY if there are other patients sharing the same address (otherwise no bulk update is needed).
    try {
      const currentUser = await base44.auth.me();

      // Check if any other patients share the same address in the same store
      const storePatients = await base44.entities.Patient.filter({ store_id: storeId });
      const sourceAddress = (existingPatient?.address || '').toLowerCase().trim();
      const hasMatchingPatients = (storePatients || []).some(
        (p) => p && p.id !== patientId && (p.address || '').toLowerCase().trim() === sourceAddress
      );

      if (hasMatchingPatients) {
        await base44.entities.PatientGPSLog.create({
          source_patient_id: patientId,
          patient_id: patientId,
          patient_name: existingPatient?.full_name || '',
          patient_address: existingPatient?.address || '',
          store_id: storeId,
          is_source_patient: true,
          old_latitude: existingPatient?.latitude ?? null,
          old_longitude: existingPatient?.longitude ?? null,
          new_latitude: nextLatitude,
          new_longitude: nextLongitude,
          updated_by_user_id: currentUser?.id || '',
          updated_by_user_name: currentUser?.full_name || currentUser?.email || 'Unknown',
          normalized_address: existingPatient?.address || '',
          related_patients_updated_count: 0,
          matched_patient_ids: [],
        });
      }
    } catch (logErr) {
      console.warn('[patientGPSUpdater] Failed to write GPS log:', logErr.message);
    }

    try {
      window.dispatchEvent(new CustomEvent('patientGpsUpdated', {
        detail: {
          patientId,
          latitude: nextLatitude,
          longitude: nextLongitude,
          distance_from_store: distanceKm,
          source: updateSource,
          updatedCount: 1,
          patients: [],
        }
      }));
    } catch {}

    // 6) Notify UI
    toast.success("Patient GPS Updated", {
      description: `Location saved from ${updateSource === 'crosshair' ? 'map crosshair' : 'device GPS'}. Distance from store: ${distanceKm} km.`,
    });

    _gpsUpdateInFlight = false;
    return {
      success: true,
      message: "GPS updated",
      distance: distanceKm,
      latitude: nextLatitude,
      longitude: nextLongitude,
      source: updateSource,
      updatedCount: 1,
      patients: [],
    };
  } catch (error) {
    if (error?.response?.status === 429 || (error?.message && /429|rate limit/i.test(error.message))) {
      try { window._setRateLimitError?.(true); } catch {}
    }
    toast.error("Failed to Update GPS", { description: error.message || "Could not update location" });
    _gpsUpdateInFlight = false;
    return { success: false, message: error.message || "Failed to update GPS" };
  }
};

export default updatePatientGPS;