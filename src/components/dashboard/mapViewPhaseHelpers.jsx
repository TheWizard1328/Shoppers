export function isDriverOffDuty(appUsers, userId, fallbackStatus = null) {
  const appUser = (appUsers || []).find((au) => au?.user_id === userId);
  return (appUser?.driver_status ?? fallbackStatus) === 'off_duty';
}

export function getSelfDriverLocationForBounds({ currentUser, appUsers, driverLocation, isMobile, isPrimaryDevice, selectedDriverId, isDriver, isDriverOffDuty: isOffDutyFn }) {
  if (!isDriver || !currentUser?.id) return null;
  const selfId = currentUser.id;
  const isOnDuty = !isOffDutyFn(appUsers, selfId, currentUser?.driver_status);
  if (!isOnDuty) return null;
  const isRelevant = selectedDriverId === selfId || selectedDriverId === 'all';
  if (!isRelevant) return null;
  // GPS blue dot — only on primary device
  if (isPrimaryDevice && driverLocation?.latitude && driverLocation?.longitude) return { latitude: driverLocation.latitude, longitude: driverLocation.longitude, source: 'gps' };
  // Shared location from AppUser — covers non-primary tablets/phones
  const selfAppUser = (appUsers || []).find((au) => au?.user_id === selfId);
  if (selfAppUser?.driver_status === 'on_duty' && selfAppUser?.current_latitude && selfAppUser?.current_longitude) {
    return { latitude: selfAppUser.current_latitude, longitude: selfAppUser.current_longitude, source: 'shared' };
  }
  // Non-primary device GPS fallback (secondary device with GPS active)
  if (driverLocation?.latitude && driverLocation?.longitude) return { latitude: driverLocation.latitude, longitude: driverLocation.longitude, source: 'gps_secondary' };
  return null;
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

  // 1. Live GPS — primary device always wins regardless of async isPrimaryDevice resolution.
  //    locationTracker only runs on confirmed primary devices, so if driverLocation is set
  //    and this is the driver's own route, trust it unconditionally.
  if (isOwnDriver && driverLocation?.latitude && driverLocation?.longitude) {
    return { latitude: driverLocation.latitude, longitude: driverLocation.longitude };
  }

  // For any driver (including self), only use shared/stored location if active
  if (!isOnDuty) return null;

  // 2. allDriverLocations (excludes self on mobile/tablet — see driverLocationPoller filter)
  const sharedLocation = (allDriverLocations || []).find((loc) => (
    loc?.driver_id === targetDriverId ||
    loc?.driverId === targetDriverId ||
    loc?.user_id === targetDriverId ||
    loc?.id === targetDriverId
  ));
  if (sharedLocation?.latitude && sharedLocation?.longitude) {
    return { latitude: sharedLocation.latitude, longitude: sharedLocation.longitude };
  }

  // 3. AppUser stored location — covers non-primary devices (tablets) where self is filtered
  //    from allDriverLocations and live GPS may not be running
  if (targetAppUser?.current_latitude && targetAppUser?.current_longitude) {
    return {
      latitude: targetAppUser.current_latitude,
      longitude: targetAppUser.current_longitude,
    };
  }

  // 4. Live GPS fallback for non-primary devices (e.g. secondary phone/tablet with GPS active)
  if (isOwnDriver && driverLocation?.latitude && driverLocation?.longitude) {
    return { latitude: driverLocation.latitude, longitude: driverLocation.longitude };
  }

  return null;
}