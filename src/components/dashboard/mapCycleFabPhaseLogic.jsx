export function getNextMapCyclePhase({
  mapViewPhase,
  isMapViewLocked,
  phase2Unavailable
}) {
  if (mapViewPhase === 1 && !isMapViewLocked) return { phase: 1, unlockMs: 3000 };
  if (mapViewPhase === 1 && isMapViewLocked) return { phase: phase2Unavailable ? 3 : 2, unlockMs: null };
  if (mapViewPhase === 2 && !isMapViewLocked) return { phase: 2, unlockMs: null };
  if (mapViewPhase === 2 && isMapViewLocked) return { phase: 3, unlockMs: null };
  if (mapViewPhase === 3 && !isMapViewLocked) return { phase: 3, unlockMs: null };
  if (mapViewPhase === 3 && isMapViewLocked) return { phase: 1, unlockMs: 3000 };
  return { phase: 1, unlockMs: 3000 };
}

export function getPhase2Unavailable({
  isDriver,
  isAdmin,
  selectedDriverId,
  currentUser,
  deliveriesWithStopOrder,
  getFabTargetDriverMapLocation,
  appUsers,
  driverLocation,
  allDriverLocations,
  isPrimaryDevice,
  nextStopCoordinates
}) {
  return (isDriver || (isAdmin && selectedDriverId !== 'all')) && (
    !deliveriesWithStopOrder.some((d) =>
      d &&
      d.driver_id === (selectedDriverId !== 'all' ? selectedDriverId : currentUser?.id) &&
      !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(d.status)
    ) ||
    !(selectedDriverId !== 'all'
      ? getFabTargetDriverMapLocation({
          selectedDriverId,
          currentUser,
          isDriver,
          appUsers,
          driverLocation,
          allDriverLocations,
          isPrimaryDevice
        })
      : nextStopCoordinates)
  );
}

export function runMapCycleTransition({
  mapViewPhase,
  isMapViewLocked,
  phase2Unavailable,
  triggerPhase
}) {
  const nextState = getNextMapCyclePhase({
    mapViewPhase,
    isMapViewLocked,
    phase2Unavailable
  });

  triggerPhase(nextState.phase, nextState.unlockMs);
  return nextState;
}