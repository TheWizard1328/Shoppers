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

// Consolidated into geoUtils — identical math, single source of truth.
import { haversineMeters } from '@/components/utils/geoUtils';
import { locationTracker } from '@/components/utils/locationTracker';

/**
 * Returns true when the driver's current GPS coordinates are within geofence
 * range of the store associated with the cancelled pickup.
 *
 * GPS source priority (owner rule Sep 18 2026 — the "driver at the store but
 * flag not set" bug):
 *   1. locationTracker fresh hardware fix (getFreshPosition, 6s timeout) — on
 *      the driver's OWN device this is seconds old at most. The previous logic
 *      used `appUsers.current_latitude` — a SERVER-synced value that lags the
 *      real position by up to a heartbeat cycle (~60s). A driver who arrives
 *      at the store and cancels within that window measured as "outside
 *      geofence" and the after_hours flag was silently dropped (Sep 18 data:
 *      Sharuk 12:29 PASS at store A, 12:32 FAIL at store B 3 minutes later —
 *      his appUsers GPS was still parked at store A).
 *   2. locationTracker watchPosition cache (instant, no async).
 *   3. `appUsers` array (server heartbeat — for other devices / tracker off).
 *   4. `currentUser` (boot-cached AppUser merge — last resort).
 *
 * The caller's gate guarantees the cancelling driver is the signed-in user, so
 * on the driver's device the tracker position IS the driver's own position.
 *
 * Diagnostic logging: every false result is logged with the specific failing
 * condition so After-Hours flag misses can be root-caused from device logs.
 */
export async function isDriverWithinStoreRange({ currentUser, appUsers = [], store, stores = [], delivery }) {
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
  const isSelfDevice = !currentUser?.id || currentUser.id === targetDriverId;

  // ── Store geofence center (needed before evaluating any GPS candidate) ──
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
  const isWithinGeofence = (lat, lon) => haversineMeters(lat, lon, storeLat, storeLon) <= GEOFENCE_RADIUS_M;

  // ── GPS candidate ladder (fastest + freshest first) ──────────────────────────
  // 1. locationTracker watchPosition cache — INSTANT, and on the driver's own
  //    device (guaranteed by the caller's gate) it is seconds old at most.
  //    Standing at the store → immediate PASS, zero added latency.
  // 2. locationTracker fresh hardware fix (getFreshPosition, 6s) — used when
  //    the cache is outside the geofence: the cache may be a pre-arrival fix.
  // 3. `appUsers` server heartbeat position — for other devices / tracker off.
  // 4. `currentUser` boot-cached AppUser merge — last resort.
  const candidates = [];
  if (isSelfDevice) {
    const cached = locationTracker.getCachedPosition();
    if (cached && Number.isFinite(Number(cached.latitude)) && Number.isFinite(Number(cached.longitude)) && isWithinGeofence(Number(cached.latitude), Number(cached.longitude))) {
      log(true, 'driver within geofence', {
        distanceM: Math.round(haversineMeters(Number(cached.latitude), Number(cached.longitude), storeLat, storeLon)),
        gpsSource: 'locationTracker watchPosition cache',
      });
      return true;
    }
    try {
      const fresh = await locationTracker.getFreshPosition({ timeout: 6000 });
      if (fresh && Number.isFinite(Number(fresh.latitude)) && Number.isFinite(Number(fresh.longitude))) {
        candidates.push({ lat: Number(fresh.latitude), lon: Number(fresh.longitude), source: 'locationTracker fresh fix' });
      }
    } catch (_) { /* fall through to server-synced sources */ }
  }
  const driverAppUser = (appUsers || []).find(
    (u) => u && (u.user_id === targetDriverId || u.id === targetDriverId)
  ) || currentUser;
  const candidateLat = Number(driverAppUser?.current_latitude);
  const candidateLon = Number(driverAppUser?.current_longitude);
  if (Number.isFinite(candidateLat) && Number.isFinite(candidateLon)) {
    candidates.push({
      lat: candidateLat,
      lon: candidateLon,
      source: (appUsers || []).some((u) => u && (u.user_id === targetDriverId || u.id === targetDriverId)) ? 'appUsers heartbeat' : 'currentUser fallback',
    });
  }

  // ── Evaluate candidates freshest-first: first hit wins ──
  if (candidates.length === 0) {
    log(false, 'driver GPS missing/not finite', {
      isSelfDevice,
      appUsersCount: (appUsers || []).length,
    });
    return false;
  }
  let driverLat = null;
  let driverLon = null;
  let gpsSource = null;
  let distanceM = null;
  for (const candidate of candidates) {
    const d = haversineMeters(candidate.lat, candidate.lon, storeLat, storeLon);
    if (d <= GEOFENCE_RADIUS_M) {
      driverLat = candidate.lat;
      driverLon = candidate.lon;
      gpsSource = candidate.source;
      distanceM = d;
      break;
    }
    // Keep the freshest miss for diagnostics if nothing passes
    if (driverLat === null) {
      driverLat = candidate.lat;
      driverLon = candidate.lon;
      gpsSource = candidate.source;
      distanceM = d;
    }
  }
  if (distanceM !== null && distanceM <= GEOFENCE_RADIUS_M) {
    log(true, 'driver within geofence', { distanceM: Math.round(distanceM), gpsSource });
    return true;
  }

  // Every candidate missed the geofence — log the freshest miss for diagnostics
  log(false, 'driver outside geofence', {
    distanceM: Number.isFinite(distanceM) ? Math.round(distanceM) : null,
    geofenceRadiusM: GEOFENCE_RADIUS_M,
    driverLat, driverLon,
    storeLat, storeLon,
    gpsSource,
    candidatesChecked: candidates.length,
  });
  return false;
}
