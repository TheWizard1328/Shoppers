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

// ─── Canonical distance wrappers (daily scan #3, Oct 21 2026) ───────────────
// Ten+ files previously defined their own local `calculateDistance` /
// `calculateDistanceKm` wrappers around haversineKm/haversineMeters. These are
// the single shared names now — import and alias locally if a different local
// name is needed. NEVER re-define haversine math locally.

/** Raw km wrapper — NO input guards (NaN propagates, same as old raw copies). */
export const calculateDistanceKm = (lat1, lon1, lat2, lon2) =>
  haversineKm(lat1, lon1, lat2, lon2);

/** Raw meters wrapper — NO input guards. */
export const calculateDistanceMeters = (lat1, lon1, lat2, lon2) =>
  haversineMeters(lat1, lon1, lat2, lon2);

/** Guarded km wrapper — null when ANY coordinate is null/undefined/NaN
 *  (the old handleBatchSaveDelivery / DeliveryForm semantics). */
export const calculateDistanceKmSafe = (lat1, lon1, lat2, lon2) => {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
  const km = haversineKm(lat1, lon1, lat2, lon2);
  return Number.isFinite(km) ? km : null;
};
