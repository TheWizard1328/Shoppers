import { useMemo } from 'react';
import useImmersiveNavigationMode from '@/components/dashboard/useImmersiveNavigationMode';

export default function useDashboardImmersiveMode({
  isDriver,
  isMobile,
  isPrimaryDevice,
  driverLocation,
  nextStopCoordinates,
  selectedDriverId,
}) {
  const immersiveProps = useMemo(() => ({
    enabled: Boolean(isMobile && isPrimaryDevice && selectedDriverId && selectedDriverId !== 'all'),
    isDriver: Boolean(isDriver || (isMobile && isPrimaryDevice && selectedDriverId && selectedDriverId !== 'all')),
    isMobile,
    driverLocation,
    nextStopCoordinates,
  }), [isDriver, isMobile, isPrimaryDevice, driverLocation, nextStopCoordinates, selectedDriverId]);

  return useImmersiveNavigationMode(immersiveProps);
}