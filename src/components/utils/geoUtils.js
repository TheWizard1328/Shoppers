/**
 * geoUtils — single source of truth for great-circle (haversine) distance math.
 *
 * Consolidated Sep 6, 2026: 15 files previously defined their own copy of the
 * same haversine formula with drifting units (km vs meters) and inconsistent
 * null-guards. All previous call sites now delegate here. Keep guard semantics
 * (null vs 0 vs Infinity) in the thin per-file wrappers — this module only
 * provides the raw math.
 */

const EARTH_RADIUS_KM = 6371;

/**
 * Haversine great-circle distance in kilometers.
 * Raw math — no input guards. Wrap at call sites if guards are needed.
 */
export const haversineKm = (lat1, lon1, lat2, lon2) => {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
};

/**
 * Haversine great-circle distance in meters.
 * Used by proximity/trigger paths (locationTrackerMath, dispatcher pickup
 * notifications) that compare against meter thresholds (e.g. 150m).
 */
export const haversineMeters = (lat1, lon1, lat2, lon2) =>
  haversineKm(lat1, lon1, lat2, lon2) * 1000;
