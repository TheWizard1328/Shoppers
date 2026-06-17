import { getFabTargetDriverMapLocation } from '@/components/dashboard/mapViewPhaseHelpers';
import { saveSetting } from '@/components/utils/userSettingsManager';

/**
 * Creates the handleMapViewCycle callback for Dashboard.
 * Phase rules:
 *   Phase 1 — locks for 3s then unlocks (250ms lock when phases 2 & 3 are both unavailable)
 *   Phase 2 — skipped if no stop has isNextDelivery=true OR no driver location available
 *   Phase 3 — skipped if ALL stops are finished (completed/failed/cancelled)
 */

export function createHandleMapViewCycle({
  isDriver, isDispatcher, isAdmin, currentUser,
  deliveriesWithStopOrder, selectedDriverId,
  appUsers, driverLocation, allDriverLocations, isPrimaryDevice,
  mapViewPhaseRef, isMapViewLockedRef, pendingPhaseRef,
  mapLockTimeoutRef, mapLockExpiresAtRef, lastProgrammaticMapMoveRef,
  setMapViewPhase, setIsMapViewLocked, setMapViewTrigger,
  setIsExpanded, setSelectedCardId, setAreCardsVisible,
  cardExpandedAtRef,
}) {
  return function handleMapViewCycle() {
    if (!isDriver && !isDispatcher && !isAdmin) return;

    setIsExpanded(false);
    setSelectedCardId(null);
    cardExpandedAtRef.current = null;
    setAreCardsVisible(false);

    const phase = mapViewPhaseRef.current;
    const lockExpired = !mapLockExpiresAtRef.current || mapLockExpiresAtRef.current <= Date.now();

    const goPhase = (nextPhase, shouldLock, unlockMs = null, skipMapTrigger = false) => {
      if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
      mapLockExpiresAtRef.current = null;
      mapViewPhaseRef.current = nextPhase;
      isMapViewLockedRef.current = shouldLock;
      pendingPhaseRef.current = nextPhase;
      setMapViewPhase(nextPhase);
      setIsMapViewLocked(shouldLock);
      lastProgrammaticMapMoveRef.current = Date.now();
      window._lastProgrammaticMapMove = Date.now();
      if (!skipMapTrigger) setMapViewTrigger((p) => p + 1);
      if (currentUser?.id) saveSetting(currentUser.id, 'fab_map_cycle_phase', nextPhase);
      setTimeout(() => {
        setAreCardsVisible(true);
        window.dispatchEvent(new CustomEvent('centerNextDeliveryCard'));
      }, 500);
      if (unlockMs != null) {
        const exp = Date.now() + unlockMs;
        mapLockExpiresAtRef.current = exp;
        mapLockTimeoutRef.current = setTimeout(() => {
          if (mapLockExpiresAtRef.current === exp) {
            isMapViewLockedRef.current = false; setIsMapViewLocked(false);
            mapLockExpiresAtRef.current = null; mapLockTimeoutRef.current = null;
          }
        }, unlockMs);
      }
    };

    // Phase availability checks
    const tgtId = selectedDriverId !== 'all' ? selectedDriverId : (isDriver ? currentUser?.id : null);

    // Phase 2: skip if driver is off_duty OR no isNextDelivery stop

    const tgtAppUser = tgtId ? appUsers.find((au) => au?.user_id === tgtId) : null;
    const tgtOffDuty = tgtAppUser ? tgtAppUser.driver_status === 'off_duty' : false;
    const p2HasStop = !tgtOffDuty && (tgtId
      ? deliveriesWithStopOrder.some((d) => d && d.driver_id === tgtId && d.isNextDelivery && !['completed', 'failed', 'cancelled'].includes(d.status))
      : false);
    const p2Available = p2HasStop && getFabTargetDriverMapLocation({ selectedDriverId, currentUser, isDriver, appUsers, driverLocation, allDriverLocations, isPrimaryDevice });

    // Phase 3: skip if no in_transit or en_route stops



    const _rd = tgtId
      ? deliveriesWithStopOrder.filter((d) => d && d.driver_id === tgtId)
      : deliveriesWithStopOrder;

    const p3Available = _rd.some((d) => d && (d.status === 'in_transit' || d.status === 'en_route'));


    // Phase 1 lock: 3s when p2 or p3 exist, 250ms when no stops at all (fast unlock, city-center view)
    const hasAnyPhase = p2Available || p3Available;
    const hasAnyStops = _rd.length > 0;
    const p1LockMs = (hasAnyPhase || hasAnyStops) ? 3000 : 250;

    // State machine:
    if (phase === 1 && lockExpired)  { goPhase(1, true, p1LockMs); return; }
    if (phase === 1 && !lockExpired) { goPhase(p2Available ? 2 : p3Available ? 3 : 1, true, hasAnyPhase ? null : p1LockMs); return; }
    if (phase === 2)                 { goPhase(p3Available ? 3 : 1, true, p3Available ? null : p1LockMs); return; }
    goPhase(1, true, p1LockMs);
  };
}