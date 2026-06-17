/**
 * Syncs FAB refs after a status update completes (non-last stop, phase > 1).
 * Called in handleStatusUpdate to prevent phase-bounce caused by ref/state desync.
 */
export function syncFabRefsForPhase(phase, refs) {
  const { isMapViewLockedRef, mapViewPhaseRef, pendingPhaseRef, mapLockTimeoutRef, mapLockExpiresAtRef, setIsMapViewLocked, setMapViewPhase } = refs;
  // CRITICAL: Sync refs BEFORE setting state — the map trigger effect reads refs synchronously
  isMapViewLockedRef.current = true;
  mapViewPhaseRef.current = phase;
  pendingPhaseRef.current = phase;
  setIsMapViewLocked(true);
  // CRITICAL: Also sync React state so FAB visual matches the refs — without this, the FAB
  // can show a stale phase (e.g. 1 or 3) while the map repositions as phase 2.
  if (setMapViewPhase) setMapViewPhase(phase);
  if (mapLockTimeoutRef.current) {
    clearTimeout(mapLockTimeoutRef.current);
    mapLockTimeoutRef.current = null;
  }
  mapLockExpiresAtRef.current = null;
}