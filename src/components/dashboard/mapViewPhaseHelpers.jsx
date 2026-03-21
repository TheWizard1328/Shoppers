export function isDriverOffDuty(appUsers, userId, fallbackStatus = null) {
  const appUser = (appUsers || []).find((au) => au?.user_id === userId);
  return (appUser?.driver_status ?? fallbackStatus) === 'off_duty';
}

export function getFabTargetDriverMapLocation({
  selectedDriverId,
  currentUser,
  isDriver,
  appUsers,
  driverLocation,
  allDriverLocations,
}) {
  const targetDriverId = selectedDriverId && selectedDriverId !== 'all'
    ? selectedDriverId
    : isDriver
      ? currentUser?.id
      : null;

  if (!targetDriverId) return null;

  const targetAppUser = (appUsers || []).find((au) => au?.user_id === targetDriverId);
  if ((targetAppUser?.driver_status ?? null) === 'off_duty') return null;

  if (targetDriverId === currentUser?.id && driverLocation?.latitude && driverLocation?.longitude) {
    return { latitude: driverLocation.latitude, longitude: driverLocation.longitude };
  }

  if (targetAppUser?.current_latitude && targetAppUser?.current_longitude) {
    return {
      latitude: targetAppUser.current_latitude,
      longitude: targetAppUser.current_longitude,
    };
  }

  const sharedLocation = (allDriverLocations || []).find((loc) => loc?.driver_id === targetDriverId);
  if (sharedLocation?.latitude && sharedLocation?.longitude) {
    return { latitude: sharedLocation.latitude, longitude: sharedLocation.longitude };
  }

  return null;
}