import { useEffect, useRef } from 'react';

/**
 * Watches the driver's live location vs their next stop.
 * - Within 2 km: switches map to Phase 2 + locked (fires ONCE per stop)
 * - Within 1 km: also switches mapStyle to 'satellite' (fires ONCE per stop)
 *
 * Each threshold triggers at most once per next-stop. They only re-trigger on:
 *   1. A new next stop (nextStopCoordinates changes)
 *   2. A map double-tap (call resetProximityTriggers())
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
  const proximityPhaseActiveRef = useRef(false);
  // Track whether each threshold has already been triggered for the current stop
  const phase2TriggeredRef = useRef(false);
  const satelliteTriggeredRef = useRef(false);
  // Track which stop these triggers belong to so we reset on stop change
  const lastStopKeyRef = useRef(null);

  // Expose a reset function so double-tap can re-arm both triggers
  const resetProximityTriggers = () => {
    phase2TriggeredRef.current = false;
    satelliteTriggeredRef.current = false;
    proximityPhaseActiveRef.current = false;
  };

  // Make reset accessible globally so MapSection's double-tap handler can call it
  // without needing to thread it through 4 layers of props
  useEffect(() => {
    if (!isDriver || !isMobile || !isPrimaryDevice) return;
    window.__resetProximityTriggers = resetProximityTriggers;
    return () => { delete window.__resetProximityTriggers; };
  }, [isDriver, isMobile, isPrimaryDevice]);

  // When the FAB cycles phases, reset the triggers so the normal location-update
  // effect can re-evaluate and re-apply proximity state on the next GPS tick.
  useEffect(() => {
    if (!isDriver || !isMobile || !isPrimaryDevice || !isToday) return;
    const handleRecheck = () => resetProximityTriggers();
    window.addEventListener('proximityRecheck', handleRecheck);
    return () => window.removeEventListener('proximityRecheck', handleRecheck);
  }, [isDriver, isMobile, isPrimaryDevice, isToday]);

  useEffect(() => {
    // Only run for mobile primary-device drivers on today's routes
    if (!isDriver || !isMobile || !isPrimaryDevice || !isToday) return;
    if (!driverLocation?.latitude || !driverLocation?.longitude) return;
    if (!nextStopCoordinates?.lat || !nextStopCoordinates?.lon) return;

    // Respect manual user interaction — don't override for 5 minutes after a tap
    if (Date.now() - (lastUserInteractionRef?.current || 0) < 300000) return;

    // Reset triggers when the target stop changes
    const stopKey = `${nextStopCoordinates.lat},${nextStopCoordinates.lon}`;
    if (stopKey !== lastStopKeyRef.current) {
      lastStopKeyRef.current = stopKey;
      phase2TriggeredRef.current = false;
      satelliteTriggeredRef.current = false;
      proximityPhaseActiveRef.current = false;
    }

    const distKm = calculateDistance(
      driverLocation.latitude,
      driverLocation.longitude,
      nextStopCoordinates.lat,
      nextStopCoordinates.lon
    );

    const within2km = distKm <= 2.0;
    const within1km = distKm <= 1.0;

    if (within2km) {
      // Save pre-proximity state once
      if (!proximityPhaseActiveRef.current) {
        savedPreProximityStateRef.current = {
          phase: mapViewPhase,
          style: mapStyle,
        };
        proximityPhaseActiveRef.current = true;
      }

      // Switch to Phase 2 + lock — only if not already triggered for this stop
      if (!phase2TriggeredRef.current) {
        phase2TriggeredRef.current = true;
        setMapViewPhase(2);
        setIsMapViewLocked(true);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);
      }

      // Switch to satellite within 1 km — only if not already triggered for this stop
      if (within1km && !satelliteTriggeredRef.current) {
        satelliteTriggeredRef.current = true;
        setMapStyle('satellite');
      }
    } else {
      // Driver moved back beyond 2 km — clear proximity flag but don't restore
      // (restoration happens on stop completion via Dashboard)
      proximityPhaseActiveRef.current = false;
      // Do NOT reset phase2TriggeredRef / satelliteTriggeredRef here —
      // if the driver re-enters the zone we still don't want to re-trigger
      // until a new stop or a double-tap reset.
    }
  }, [
    isDriver,
    isMobile,
    isPrimaryDevice,
    isToday,
    driverLocation,   // runs on each location update but guards prevent re-firing
    nextStopCoordinates,
  ]);

  return { proximityPhaseActiveRef, resetProximityTriggers };
}