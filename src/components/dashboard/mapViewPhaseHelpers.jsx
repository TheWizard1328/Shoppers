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
  isPrimaryDevice,
}) {
  const targetDriverId = selectedDriverId && selectedDriverId !== 'all'
    ? selectedDriverId
    : isDriver
      ? currentUser?.id
      : null;

  if (!targetDriverId) return null;

  const targetAppUser = (appUsers || []).find((au) => au?.user_id === targetDriverId);
  const isOwnDriver = targetDriverId === currentUser?.id;
  const isOffDuty = (targetAppUser?.driver_status ?? null) === 'off_duty';
  if (isOffDuty && !isOwnDriver) return null;
  if (isOwnDriver && driverLocation?.latitude && driverLocation?.longitude && (!isOffDuty || isPrimaryDevice)) return { latitude: driverLocation.latitude, longitude: driverLocation.longitude };
  if (targetAppUser?.current_latitude && targetAppUser?.current_longitude && (!isOffDuty || !isOwnDriver || !isPrimaryDevice)) {
    return {
      latitude: targetAppUser.current_latitude,
      longitude: targetAppUser.current_longitude,
    };
  }

  const sharedLocation = (allDriverLocations || []).find((loc) => loc?.driver_id === targetDriverId);
  if (sharedLocation?.latitude && sharedLocation?.longitude && (!isOffDuty || !isOwnDriver || !isPrimaryDevice)) {
    return { latitude: sharedLocation.latitude, longitude: sharedLocation.longitude };
  }

  return null;
}