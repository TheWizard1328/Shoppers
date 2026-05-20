import { useEffect, useRef } from 'react';

/**
 * Watches the driver's live location vs their next stop.
 * - Within 2 km: switches map to Phase 2 + locked (if not already Phase 2+)
 * - Within 1 km: also switches mapStyle to 'satellite'
 *
 * Stores the pre-proximity phase/style so Dashboard can restore them after stop completion.
 *
 * Only active on the primary device for mobile drivers on today's date.
 */
export default function useProximityMapMode({
  isDriver,
  isMobile,
  isPrimaryDevice,
  isToday,
  driverLocation,
  nextStopCoordinates,
  mapViewPhase,
  isMapViewLocked,
  mapStyle,
  lastUserInteractionRef,
  setMapViewPhase,
  setIsMapViewLocked,
  setMapStyle,
  setMapViewTrigger,
  lastProgrammaticMapMoveRef,
  savedPreProximityStateRef, // passed-in ref so Dashboard can read/clear it
  calculateDistance,
}) {
  const proximityPhaseActiveRef = useRef(false); // true while we've auto-switched

  useEffect(() => {
    // Only run for mobile primary-device drivers on today's routes
    if (!isDriver || !isMobile || !isPrimaryDevice || !isToday) return;
    if (!driverLocation?.latitude || !driverLocation?.longitude) return;
    if (!nextStopCoordinates?.lat || !nextStopCoordinates?.lon) return;

    // Respect manual user interaction — don't override for 5 minutes after a tap
    if (Date.now() - (lastUserInteractionRef?.current || 0) < 300000) return;

    const distKm = calculateDistance(
      driverLocation.latitude,
      driverLocation.longitude,
      nextStopCoordinates.lat,
      nextStopCoordinates.lon
    );

    const within2km = distKm <= 2.0;
    const within1km = distKm <= 1.0;

    if (within2km) {
      // First time entering proximity zone — save current state
      if (!proximityPhaseActiveRef.current) {
        savedPreProximityStateRef.current = {
          phase: mapViewPhase,
          style: mapStyle,
        };
        proximityPhaseActiveRef.current = true;
      }

      // Switch to Phase 2 + lock if not already there
      if (mapViewPhase !== 2 || !isMapViewLocked) {
        setMapViewPhase(2);
        setIsMapViewLocked(true);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);
      }

      // Switch to satellite within 1 km
      if (within1km && mapStyle !== 'satellite') {
        setMapStyle('satellite');
      }
    } else {
      // Driver moved back beyond 2 km — clear proximity flag but don't restore
      // (restoration happens on stop completion via Dashboard)
      proximityPhaseActiveRef.current = false;
    }
  }, [
    isDriver,
    isMobile,
    isPrimaryDevice,
    isToday,
    driverLocation,
    nextStopCoordinates,
    mapViewPhase,
    isMapViewLocked,
    mapStyle,
  ]);

  return { proximityPhaseActiveRef };
}