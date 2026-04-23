export default function getImmersiveModeProps({
  isDriver,
  isMobile,
  isPrimaryDevice,
  driverLocation,
  nextStopCoordinates,
  selectedDriverId,
}) {
  const enabled = Boolean(isMobile && isPrimaryDevice && selectedDriverId && selectedDriverId !== 'all');

  return {
    enabled,
    isDriver: Boolean(isDriver || enabled),
    isMobile,
    driverLocation,
    nextStopCoordinates,
  };
}