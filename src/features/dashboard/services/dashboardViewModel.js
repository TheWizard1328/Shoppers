import useImmersiveMode from '@/components/dashboard/useImmersiveMode';
import { useDevice } from '@/components/utils/DeviceContext';

export function useDashboardViewModel(props) {
  const { deviceType } = useDevice();
  // Immersive mode: phones only (not tablets), and only the primary device driver
  const isPhysicalPhone = deviceType === 'Mobile';
  // isPrimaryDevice defaults to false (safe) — never undefined — so tablets without primary status don't enter immersive mode
  const isPrimary = props.isPrimaryDevice === true;
  const immersive = useImmersiveMode({
    isDriver: props.isDriver,
    isMobile: isPhysicalPhone && isPrimary,
    driverLocation: props.driverLocation,
    nextStopLocation: props.nextStopCoordinates,
    enabled: true,
  });

  return {
    ...props,
    selectedDateStr: props.selectedDateStr || (props.selectedDate ? new Date(props.selectedDate).toISOString().slice(0, 10) : ''),
    isAllDriversMode: props.isAllDriversMode ?? props.selectedDriverId === 'all',
    immersiveHidden: immersive.immersiveHidden,
    isDriverMoving: immersive.isDriverMoving,
    immersiveOverrideActive: immersive.isOverrideActive,
    onImmersiveMapTap: immersive.forceShowUI
  };
}