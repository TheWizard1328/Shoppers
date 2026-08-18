export function isDriverOffDuty(appUsers, userId, fallbackStatus = null) {
  const appUser = (appUsers || []).find((au) => au?.user_id === userId);
  return (appUser?.driver_status ?? fallbackStatus) === 'off_duty';
}

export function getSelfDriverLocationForBounds({ currentUser, appUsers, driverLocation, isMobile, isPrimaryDevice, selectedDriverId, isDriver, isDriverOffDuty: isOffDutyFn }) {
  if (!isDriver || !currentUser?.id) return null;
  const selfId = currentUser.id;
  const isRelevant = selectedDriverId === selfId || selectedDriverId === 'all';
  if (!isRelevant) return null;
  // GPS blue dot — only on primary device (works regardless of duty status)
  if (isPrimaryDevice && driverLocation?.latitude && driverLocation?.longitude) return { latitude: driverLocation.latitude, longitude: driverLocation.longitude, source: 'gps' };
  // Shared location from AppUser — covers non-primary tablets/phones
  // Show regardless of duty status so drivers can see their own location when off duty
  const selfAppUser = (appUsers || []).find((au) => au?.user_id === selfId);
  if (selfAppUser?.current_latitude && selfAppUser?.current_longitude) {
    return { latitude: selfAppUser.current_latitude, longitude: selfAppUser.current_longitude, source: 'shared' };
  }
  // Non-primary device GPS fallback (secondary device with GPS active)
  if (driverLocation?.latitude && driverLocation?.longitude) return { latitude: driverLocation.latitude, longitude: driverLocation.longitude, source: 'gps_secondary' };
  return null;
}

/**
 * Extract a timestamp (ms since epoch) from a location-like object.
 * Handles allDriverLocations entries (from poller) and AppUser records.
 */
function getLocationTimestamp(loc) {
  if (!loc) return 0;
  const ts = loc.location_updated_at || loc.updated_date || loc.timestamp || loc.created_date;
  if (!ts) return 0;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function getFabTargetDriverMapLocation({
  selectedDriverId,
  currentUser,
  isDriver,
  appUsers,
  driverLocation,
  allDriverLocations,
  isPrimaryDevice,
}) {
  const targetDriverId = selectedDriverId && selectedDriverId !== 'all'
    ? selectedDriverId
    : null;

  if (!targetDriverId) return null;

  const targetAppUser = (appUsers || []).find((au) => au?.user_id === targetDriverId);
  const isOwnDriver = targetDriverId === currentUser?.id;
  const activeStatus = targetAppUser?.driver_status ?? null;
  // Accept on_duty AND on_break — driver on break is still physically present
  // and Phase 2/3 map follow should continue during breaks.
  const isOnDuty = activeStatus === 'on_duty' || activeStatus === 'on_break';

  // 1. Live GPS — ONLY on primary device. Non-primary devices (tablets, secondary
  //    phones, dispatcher screens) must use the shared location from the AppUser record
  //    (updated via WebSocket from the primary device). Using local GPS on a non-primary
  //    device causes the map to center on the tablet's own position instead of following
  //    the driver's moving shared marker.
  if (isOwnDriver && isPrimaryDevice && driverLocation?.latitude && driverLocation?.longitude) {
    return { latitude: driverLocation.latitude, longitude: driverLocation.longitude };
  }

  // For any driver (including self), only use shared/stored location if active
  if (!isOnDuty) return null;

  // 2+3. Compare allDriverLocations (poller) vs AppUser record (WebSocket-fresh).
  // The poller is async and may lag behind WebSocket appUser updates. The driver
  // marker in DeliveryMap uses routeLocationSnapshot built from realtimeAppUsers
  // (WebSocket), so it shows the freshest position. Phase 2 bounds must use the
  // same freshest source — compare timestamps and prefer the more recent one.
  const sharedLocation = (allDriverLocations || []).find((loc) => (
    loc?.driver_id === targetDriverId ||
    loc?.driverId === targetDriverId ||
    loc?.user_id === targetDriverId ||
    loc?.id === targetDriverId
  ));
  const appUserHasCoords = !!(targetAppUser?.current_latitude && targetAppUser?.current_longitude);
  const sharedHasCoords = !!(sharedLocation?.latitude && sharedLocation?.longitude);

  if (sharedHasCoords && appUserHasCoords) {
    // Both sources available — prefer the freshest by timestamp
    const sharedTs = getLocationTimestamp(sharedLocation);
    const appUserTs = getLocationTimestamp(targetAppUser);
    if (appUserTs > sharedTs) {
      return {
        latitude: Number(targetAppUser.current_latitude),
        longitude: Number(targetAppUser.current_longitude),
      };
    }
    return { latitude: sharedLocation.latitude, longitude: sharedLocation.longitude };
  }

  if (sharedHasCoords) {
    return { latitude: sharedLocation.latitude, longitude: sharedLocation.longitude };
  }

  if (appUserHasCoords) {
    return {
      latitude: Number(targetAppUser.current_latitude),
      longitude: Number(targetAppUser.current_longitude),
    };
  }

  // 4. Live GPS fallback — primary device only (non-primary already tried shared above).
  //    Non-primary devices should NOT use their local GPS for Phase 2/3 bounds because
  //    the shared marker (from WS) represents the primary device's actual position.
  if (isOwnDriver && isPrimaryDevice && driverLocation?.latitude && driverLocation?.longitude) {
    return { latitude: driverLocation.latitude, longitude: driverLocation.longitude };
  }

  return null;
}
