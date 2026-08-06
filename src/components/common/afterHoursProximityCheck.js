/**
 * After-Hours Pickup proximity check.
 *
 * Used when a DRIVER cancels a pickup from the stop card. If the driver is
 * physically located within the store geofence (same 100m threshold as
 * ArrivalTimeDetector), the cancelled pickup is flagged as `after_hours_pickup`
 * so it shows up on the After Hours reports signaling the store had no
 * deliveries available for collection.
 *
 * Dispatchers are handled by a separate `cancelPickupForDispatcher` flow that
 * deletes the pickup entirely — this check is intentionally driver-only.
 */

const GEOFENCE_RADIUS_M = 100; // matches arrivalTimeDetector.geofenceRadius

const toRad = (value) => (value * Math.PI) / 180;

const haversineMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000; // Earth's radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/**
 * Returns true when the driver's current GPS coordinates are within geofence
 * range of the store associated with the cancelled pickup.
 *
 * Looks up the driver's live GPS from the `appUsers` array first (always
 * freshest from the heartbeat), then falls back to `currentUser` (the signed-in
 * driver's cached location).
 */
export function isDriverWithinStoreRange({ currentUser, appUsers = [], store, stores = [], delivery }) {
  if (!delivery) return false;
  const targetDriverId = delivery.driver_id || currentUser?.id;

  const driverAppUser = (appUsers || []).find(
    (u) => u && (u.user_id === targetDriverId || u.id === targetDriverId)
  ) || currentUser;

  const driverLat = Number(driverAppUser?.current_latitude);
  const driverLon = Number(driverAppUser?.current_longitude);
  if (!Number.isFinite(driverLat) || !Number.isFinite(driverLon)) return false;

  const resolvedStore = store || (stores || []).find((s) => s && s.id === delivery.store_id);
  const storeLat = Number(resolvedStore?.latitude);
  const storeLon = Number(resolvedStore?.longitude);
  if (!Number.isFinite(storeLat) || !Number.isFinite(storeLon)) return false;

  return haversineMeters(driverLat, driverLon, storeLat, storeLon) <= GEOFENCE_RADIUS_M;
}