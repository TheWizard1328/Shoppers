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
 *
 * NOTE: This module uses console.warn (not console.log) so diagnostics survive
 * the production Terser pass (only console.log/debug are stripped).
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
 *
 * Diagnostic logging: every false result is logged with the specific failing
 * condition so After-Hours flag misses can be root-caused from device logs.
 */
export function isDriverWithinStoreRange({ currentUser, appUsers = [], store, stores = [], delivery }) {
  const log = (result, reason, extra = {}) => {
    console.warn('[AfterHoursProximity]', result ? 'PASS' : 'FAIL', reason, {
      deliveryId: delivery?.id,
      deliveryIdStr: delivery?.delivery_id,
      targetDriverId: delivery?.driver_id || currentUser?.id,
      ...extra,
    });
  };

  if (!delivery) {
    log(false, 'no delivery record');
    return false;
  }
  const targetDriverId = delivery.driver_id || currentUser?.id;

  const driverAppUser = (appUsers || []).find(
    (u) => u && (u.user_id === targetDriverId || u.id === targetDriverId)
  ) || currentUser;

  const driverLat = Number(driverAppUser?.current_latitude);
  const driverLon = Number(driverAppUser?.current_longitude);
  if (!Number.isFinite(driverLat) || !Number.isFinite(driverLon)) {
    log(false, 'driver GPS missing/not finite', {
      gpsSource: (appUsers || []).some((u) => u && (u.user_id === targetDriverId || u.id === targetDriverId)) ? 'appUsers' : 'currentUser fallback',
      rawLat: driverAppUser?.current_latitude,
      rawLon: driverAppUser?.current_longitude,
      appUsersCount: (appUsers || []).length,
    });
    return false;
  }

  const resolvedStore = store || (stores || []).find((s) => s && s.id === delivery.store_id);
  const storeLat = Number(resolvedStore?.latitude);
  const storeLon = Number(resolvedStore?.longitude);
  if (!Number.isFinite(storeLat) || !Number.isFinite(storeLon)) {
    log(false, 'store coordinates missing/not finite', {
      storeId: delivery.store_id,
      storeResolved: !!resolvedStore,
      storePropPassed: !!store,
      storesArraySize: (stores || []).length,
    });
    return false;
  }

  const distanceM = haversineMeters(driverLat, driverLon, storeLat, storeLon);
  const inRange = distanceM <= GEOFENCE_RADIUS_M;
  if (!inRange) {
    log(false, 'driver outside geofence', {
      distanceM: Math.round(distanceM),
      geofenceRadiusM: GEOFENCE_RADIUS_M,
      driverLat, driverLon,
      storeLat, storeLon,
      gpsAge: driverAppUser?.location_updated_at || null,
    });
  } else {
    log(true, 'driver within geofence', { distanceM: Math.round(distanceM), gpsAge: driverAppUser?.location_updated_at || null });
  }
  return inRange;
}
