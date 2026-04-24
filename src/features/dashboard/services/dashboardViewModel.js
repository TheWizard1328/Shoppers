import useImmersiveMode from '@/components/dashboard/useImmersiveMode';

export function useDashboardViewModel(props) {
  const immersive = useImmersiveMode({
    isDriver: props.isDriver,
    isMobile: props.isMobile,
    driverLocation: props.driverLocation,
    nextStopLocation: props.nextStopCoordinates,
    enabled: true
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