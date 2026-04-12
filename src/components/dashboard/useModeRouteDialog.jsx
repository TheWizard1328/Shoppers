import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { getCurrentDriverLocation, getNearbyModeStops } from '@/components/dashboard/modeButtonHelpers';
import { updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';

export default function useModeRouteDialog({
  currentUser,
  appUsers,
  driverLocation,
  deliveriesWithStopOrder,
  patients,
  stores,
  setPreferredTravelMode,
}) {
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [selectedModeStopIds, setSelectedModeStopIds] = useState([]);
  const [returnToCurrentLocation, setReturnToCurrentLocation] = useState(false);
  const [isOptimizingModeRoute, setIsOptimizingModeRoute] = useState(false);

  const currentModeLocation = useMemo(() => getCurrentDriverLocation({
    currentUser,
    appUsers,
    driverLocation,
  }), [currentUser, appUsers, driverLocation]);

  const nearbyModeStops = useMemo(() => getNearbyModeStops({
    deliveries: deliveriesWithStopOrder,
    patients,
    stores,
    currentLocation: currentModeLocation,
    radiusKm: 5,
  }), [deliveriesWithStopOrder, patients, stores, currentModeLocation]);

  const toggleModeStop = useCallback((stopId) => {
    setSelectedModeStopIds((prev) => prev.includes(stopId) ? prev.filter((id) => id !== stopId) : [...prev, stopId]);
  }, []);

  const toggleReturnToCurrentLocation = useCallback(() => {
    setReturnToCurrentLocation((prev) => !prev);
  }, []);

  const handleModeOptimize = useCallback(async () => {
    if (selectedModeStopIds.length === 0 || !currentUser?.id) return;
    setIsOptimizingModeRoute(true);
    try {
      await updatePreferredTravelMode(appUsers, currentUser.id, 'cycling');
      setPreferredTravelMode('cycling');
      setModeDialogOpen(false);
      toast.success('Cycling mode saved.');
    } finally {
      setIsOptimizingModeRoute(false);
    }
  }, [selectedModeStopIds, currentUser?.id, appUsers, setPreferredTravelMode]);

  return {
    modeDialogOpen,
    setModeDialogOpen,
    nearbyModeStops,
    selectedModeStopIds,
    toggleModeStop,
    returnToCurrentLocation,
    toggleReturnToCurrentLocation,
    handleModeOptimize,
    isOptimizingModeRoute,
  };
}