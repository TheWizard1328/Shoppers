export function isDriverOffDuty(appUsers, userId, fallbackStatus = null) {
  const appUser = (appUsers || []).find((au) => au?.user_id === userId);
  return (appUser?.driver_status ?? fallbackStatus) === 'off_duty';
}

export function getSelfDriverLocationForBounds({ currentUser, appUsers, driverLocation, isMobile, selectedDriverId, isDriver, isDriverOffDuty: isOffDutyFn }) {
  if (!isDriver || !currentUser?.id) return null;
  const selfId = currentUser.id;
  const isOnDuty = !isOffDutyFn(appUsers, selfId, currentUser?.driver_status);
  if (!isOnDuty) return null;
  const isRelevant = selectedDriverId === selfId || selectedDriverId === 'all';
  if (!isRelevant) return null;
  // GPS blue dot
  if (driverLocation?.latitude && driverLocation?.longitude) return { latitude: driverLocation.latitude, longitude: driverLocation.longitude, source: 'gps' };
  // Shared location from AppUser
  const selfAppUser = (appUsers || []).find((au) => au?.user_id === selfId);
  if (selfAppUser?.driver_status === 'on_duty' && selfAppUser?.current_latitude && selfAppUser?.current_longitude) {
    return { latitude: selfAppUser.current_latitude, longitude: selfAppUser.current_longitude, source: 'shared' };
  }
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
  const isOnDuty = (targetAppUser?.driver_status ?? null) === 'on_duty';

  // Only use live GPS if this is the current user's own device AND they are on_duty
  if (isOwnDriver && isOnDuty && driverLocation?.latitude && driverLocation?.longitude) {
    return { latitude: driverLocation.latitude, longitude: driverLocation.longitude };
  }

  // For any driver (including self), only use shared/stored location if on_duty
  if (!isOnDuty) return null;

  const sharedLocation = (allDriverLocations || []).find((loc) => (
    loc?.driver_id === targetDriverId ||
    loc?.driverId === targetDriverId ||
    loc?.user_id === targetDriverId ||
    loc?.id === targetDriverId
  ));
  if (sharedLocation?.latitude && sharedLocation?.longitude) {
    return { latitude: sharedLocation.latitude, longitude: sharedLocation.longitude };
  }

  if (targetAppUser?.current_latitude && targetAppUser?.current_longitude) {
    return {
      latitude: targetAppUser.current_latitude,
      longitude: targetAppUser.current_longitude,
    };
  }

  return null;
}