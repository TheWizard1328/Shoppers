export function getNextMapCyclePhase({
  mapViewPhase,
  isMapViewLocked,
  phase2Unavailable
}) {
  if (mapViewPhase === 1 && !isMapViewLocked) {
    return { phase: 1, unlockMs: 3000 };
  }

  if (mapViewPhase === 1 && isMapViewLocked) {
    return { phase: phase2Unavailable ? 3 : 2, unlockMs: null };
  }

  if (mapViewPhase === 2 && !isMapViewLocked) {
    return { phase: 2, unlockMs: null };
  }

  if (mapViewPhase === 2 && isMapViewLocked) {
    return { phase: 3, unlockMs: null };
  }

  if (mapViewPhase === 3 && !isMapViewLocked) {
    return { phase: 3, unlockMs: null };
  }

  if (mapViewPhase === 3 && isMapViewLocked) {
    return { phase: 1, unlockMs: 3000 };
  }

  return { phase: 1, unlockMs: 3000 };
}