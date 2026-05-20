import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { getCurrentDriverLocation, getNearbyModeStops } from '@/components/dashboard/modeButtonHelpers';
import { updatePreferredTravelMode } from '@/components/dashboard/travelModeHelpers';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

export default function useModeRouteDialog({
  currentUser,
  appUsers,
  driverLocation,
  deliveriesWithStopOrder,
  patients,
  stores,
  setPreferredTravelMode,
  selectedDate,
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
    radiusKm: 50, // Show all active stops on the route regardless of distance
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
      // 1. Save cycling mode preference
      await updatePreferredTravelMode(appUsers, currentUser.id, 'cycling');
      setPreferredTravelMode('cycling');

      // 2. Create a "Cycling Route Start" visual marker at the driver's current location
      const loc = currentModeLocation;
      if (loc?.latitude && loc?.longitude) {
        const deliveryDateStr = selectedDate
          ? (typeof selectedDate === 'string' ? selectedDate : format(selectedDate, 'yyyy-MM-dd'))
          : format(new Date(), 'yyyy-MM-dd');

        // Find the stop_order just before the first selected stop so the marker slots in correctly
        const selectedDeliveries = deliveriesWithStopOrder.filter(d => selectedModeStopIds.includes(d.id));
        const minStopOrder = selectedDeliveries.reduce((min, d) => Math.min(min, d.stop_order || 999), 999);
        const insertStopOrder = Math.max(0, minStopOrder - 0.5);

        const nowStr = new Date().toLocaleString('sv-SE', { timeZone: 'America/Edmonton' }).replace(' ', 'T');

        try {
          const now = new Date();
          const nowHour = now.getHours();
          const ampmDesignation = nowHour < 14 ? 'AM' : 'PM';
          const deliveryId = `DID-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

          const newMarker = await base44.entities.Delivery.create({
            delivery_id: deliveryId,
            driver_id: currentUser.id,
            driver_name: currentUser.user_name || currentUser.full_name || '',
            delivery_date: deliveryDateStr,
            status: 'completed',
            no_charge: true,
            is_cycling_start_marker: true,
            cycling_start_latitude: loc.latitude,
            cycling_start_longitude: loc.longitude,
            stop_order: insertStopOrder,
            actual_delivery_time: nowStr,
            arrival_time: nowStr,
            delivery_notes: 'Cycling Route Start',
            transport_mode: 'cycling',
            ampm_deliveries: ampmDesignation,
          });

          // Trigger polyline refresh for this driver/date after inserting the new marker
          try {
            await base44.functions.invoke('regenerateType1Polyline', {
              driverId: currentUser.id,
              deliveryDate: deliveryDateStr,
              currentLocation: { lat: loc.latitude, lon: loc.longitude },
            });
          } catch (_) { /* non-critical */ }

          // Broadcast so the map refreshes
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: {
              triggeredBy: 'cyclingModeStart',
              freshDeliveries: [newMarker],
              preserveLocalState: false,
            }
          }));
        } catch (e) {
          console.warn('Could not create cycling start marker:', e.message);
        }
      }

      setModeDialogOpen(false);
      toast.success('Cycling mode saved.');
    } finally {
      setIsOptimizingModeRoute(false);
    }
  }, [selectedModeStopIds, currentUser, appUsers, setPreferredTravelMode, currentModeLocation, deliveriesWithStopOrder, selectedDate]);

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