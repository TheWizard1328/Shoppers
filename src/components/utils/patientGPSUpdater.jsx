/**
 * Utility for updating patient GPS coordinates based on either the map crosshair or device location.
 * Ensures we use the preferred source and updates Patient + distance_from_store.
 */

import { base44 } from "@/api/base44Client";
import { toast } from "sonner";
import { locationTracker } from "@/components/utils/locationTracker";

// Simple in-module throttle to prevent rapid repeated GPS updates
let _gpsUpdateInFlight = false;
let _gpsUpdateLastAt = 0;

// Haversine distance in KM — used only as fallback when HERE routing fails
// Consolidated into geoUtils — same math; toFixed(2) rounding preserved
// from the original local implementation.
import { haversineKm as geoHaversineKm } from '@/components/utils/geoUtils';
const haversineKm = (lat1, lon1, lat2, lon2) => +(geoHaversineKm(lat1, lon1, lat2, lon2)).toFixed(2);

// Get driving distance via the dedicated getPatientDistanceFromStore backend function (HERE Router API)
const getHereRoutingDistanceKm = async (storeLat, storeLon, patientLat, patientLon) => {
  try {
    const response = await base44.functions.invoke('getPatientDistanceFromStore', {
      originLat: storeLat,
      originLng: storeLon,
      destLat: patientLat,
      destLng: patientLon,
    });
    const data = response?.data || response;
    const distKm = Number(data?.distance_km);
    if (Number.isFinite(distKm) && distKm > 0) {
      console.log(`[patientGPSUpdater] HERE distance: ${distKm} km (source: ${data?.source})`);
      return distKm;
    }
  } catch (err) {
    console.warn('[patientGPSUpdater] getPatientDistanceFromStore failed, falling back to haversine:', err?.message);
  }
  return haversineKm(storeLat, storeLon, patientLat, patientLon);
};

// Get a fresh device location via the locationTracker — it has a cached
// fallback (lastPosition) so it still returns coordinates after backgrounding
// when a bare getCurrentPosition would time out while GPS re-acquires.
const getFreshDeviceLocation = async () => {
  const pos = await locationTracker.getFreshPosition({ timeout: 10000, maximumAge: 0, enableHighAccuracy: true });
  if (pos) {
    return {
      latitude: pos.latitude,
      longitude: pos.longitude,
      accuracy: pos.accuracy,
      timestamp: Date.now(),
    };
  }
  throw new Error("Failed to get device location — GPS not available");
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

    // 3) Compute driving distance from store via HERE API (falls back to haversine if unavailable)
    const distanceKm = await getHereRoutingDistanceKm(store.latitude, store.longitude, nextLatitude, nextLongitude);

    // 4) Update ONLY the selected patient directly
    const existingPatient = await base44.entities.Patient.get(patientId);
    await base44.entities.Patient.update(patientId, {
      latitude: nextLatitude,
      longitude: nextLongitude,
      distance_from_store: distanceKm,
    });

    // 4b) CRITICAL (Sep 6 2026): Register the self-write for WS echo suppression
    // (same pattern as broadcastMutation / __localDeliveryWrites). Without this, the
    // server's WS echo of this 3-field partial update arrives unsuppressed and the
    // realtime handlers save it over the local record. They now merge defensively,
    // but suppression avoids the redundant processing entirely.
    try {
      if (typeof window !== 'undefined') {
        if (!window.__localPatientWrites || !(window.__localPatientWrites instanceof Map)) {
          window.__localPatientWrites = new Map();
        }
        window.__localPatientWrites.set(patientId, Date.now());
      }
    } catch {}

    // 4c) CRITICAL (Sep 6 2026): Write the MERGED record to local IDB and upsert it
    // into the UI immediately. The server update above only carries 3 fields — if the
    // UI relied on the WS echo, the patient's local record previously got REPLACED by
    // the partial payload (name/address/phone wiped → stop card rendered 'Unknown').
    // Writing existingPatient + the 3 new fields keeps the local record whole.
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const mergedPatient = {
        ...(existingPatient || {}),
        id: patientId,
        latitude: nextLatitude,
        longitude: nextLongitude,
        distance_from_store: distanceKm,
        updated_date: new Date().toISOString(),
      };
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [mergedPatient]);
      window.dispatchEvent(new CustomEvent('patientsUpdated', {
        detail: { patients: [mergedPatient], deletedIds: [], fromPullToSync: false, fullReplacement: false }
      }));
    } catch (localErr) {
      console.warn('[patientGPSUpdater] Local merged patient write failed (non-fatal):', localErr?.message);
    }

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