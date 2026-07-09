import { useEffect, useRef } from 'react';
import { fabControlEvents } from '@/components/utils/fabControlEvents';
import { saveSetting } from '@/components/utils/userSettingsManager';

/**
 * Handles all FAB control events (break, reactivate, done, user map interaction, etc.)
 * Extracted from Dashboard to keep that file within size limits.
 */
export function useFabControlEventHandler({
  mapViewPhaseRef,
  isMapViewLockedRef,
  pendingPhaseRef,
  mapLockTimeoutRef,
  mapLockExpiresAtRef,
  lastProgrammaticMapMoveRef,
  phaseBeforeBreakRef,
  setMapViewPhase,
  setIsMapViewLocked,
  setMapViewTrigger,
  // Optional: called when ON_DUTY_FROM_TOGGLE fires so the manual reoptimize runs
  onOnDutyFromToggle,
  // Ref set to true when user manually pans/zooms — suppresses auto re-lock in handleMapViewCycle
  mapUserUnlockedRef,
  // Ref updated so proximity snap suppression (300s) kicks in after manual unlock
  lastUserInteractionRef,
}) {
  // Keep a ref so the stable useEffect([]) closure always calls the latest callback
  const onOnDutyFromToggleRef = useRef(onOnDutyFromToggle);
  useEffect(() => { onOnDutyFromToggleRef.current = onOnDutyFromToggle; });

  useEffect(() => {
    const setFabPhase = (phase, locked, triggerMap = true) => {
      mapViewPhaseRef.current = phase;
      isMapViewLockedRef.current = locked;
      pendingPhaseRef.current = phase;
      setMapViewPhase(phase);
      setIsMapViewLocked(locked);
      if (triggerMap) {
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((p) => p + 1);
      }
    };

    const armTimer = (ms) => {
      if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
      const exp = Date.now() + ms;
      mapLockExpiresAtRef.current = exp;
      mapLockTimeoutRef.current = setTimeout(() => {
        if (mapLockExpiresAtRef.current === exp) {
          isMapViewLockedRef.current = false;
          setIsMapViewLocked(false);
          mapLockExpiresAtRef.current = null;
          mapLockTimeoutRef.current = null;
        }
      }, ms);
    };

    const clearTimer = () => {
      if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
      mapLockExpiresAtRef.current = null;
    };

    // Re-engage FAB lock in phases 2/3 when isNextDelivery flag is set on the new stop
    // (arrives via WebSocket after handleStartDelivery or optimizeRemainingStops completes)
    // THROTTLED: max once every 8 seconds AND only if driver or next stop has actually changed.
    let lastIsNextDeliveryTriggerAt = 0;
    const lastTriggeredNextStopIdRef = { current: null };
    const lastTriggeredDriverLocRef = { current: null };

    const getDistApprox = (a, b) => {
      if (!a || !b) return Infinity;
      const dlat = (a.latitude - b.latitude) * 111000;
      const dlng = (a.longitude - b.longitude) * 111000 * Math.cos((a.latitude * Math.PI) / 180);
      return Math.sqrt(dlat * dlat + dlng * dlng);
    };

    const onIsNextDeliveryFlagUpdated = (event) => {
      const phase = mapViewPhaseRef.current;
      if (phase !== 2 && phase !== 3) return;
      const now = Date.now();
      if (now - lastIsNextDeliveryTriggerAt < 8000) return;

      const { driverLocation, nextStopId, nextStopLocation } = event?.detail || {};

      // Skip map update if neither the next stop nor the driver has changed meaningfully
      const stopChanged = nextStopId && nextStopId !== lastTriggeredNextStopIdRef.current;
      const driverMoved = getDistApprox(lastTriggeredDriverLocRef.current, driverLocation) > 20;
      const stopMoved = getDistApprox(lastTriggeredNextStopIdRef.current === nextStopId ? null : nextStopLocation, nextStopLocation) > 20;

      lastIsNextDeliveryTriggerAt = now;

      if (!stopChanged && !driverMoved && !stopMoved) return;

      lastTriggeredNextStopIdRef.current = nextStopId || null;
      lastTriggeredDriverLocRef.current = driverLocation || null;

      // Don't re-lock if the user is in free-pan mode
      if (mapUserUnlockedRef?.current) return;
      // Re-lock and reposition the map to the new next stop
      clearTimer();
      isMapViewLockedRef.current = true;
      setIsMapViewLocked(true);
      pendingPhaseRef.current = phase;
      lastProgrammaticMapMoveRef.current = Date.now();
      window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger((p) => p + 1);
    };
    window.addEventListener('isNextDeliveryFlagUpdated', onIsNextDeliveryFlagUpdated);

    // Proximity-activated phase 2: driver is within 100m of next stop.
    // Lock FAB into phase 2 and trigger a map reposition to show driver + next stop.
    const onProximityActivatedPhase2 = () => {
      // Don't re-lock if the user is in free-pan mode (they manually panned/zoomed)
      if (mapUserUnlockedRef?.current) return;
      if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
      mapLockExpiresAtRef.current = null;
      mapViewPhaseRef.current = 2;
      isMapViewLockedRef.current = true;
      pendingPhaseRef.current = 2;
      // CRITICAL: Call React state setters so the FAB UI updates visually
      setMapViewPhase(2);
      setIsMapViewLocked(true);
      lastProgrammaticMapMoveRef.current = Date.now();
      window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger((p) => p + 1);
    };
    window.addEventListener('proximityActivatedPhase2', onProximityActivatedPhase2);

    const unsubscribe = fabControlEvents.subscribe((event) => {
      switch (event.type) {
        case 'REACTIVATE_FAB': {
          const ph = mapViewPhaseRef.current;
          if (ph < 2 && event.reason !== 'map_double_tap') break;
          if (ph === 1) {
            isMapViewLockedRef.current = true; setIsMapViewLocked(true);
            if (mapLockTimeoutRef.current) clearTimeout(mapLockTimeoutRef.current);
            const exp1 = Date.now() + 250; mapLockExpiresAtRef.current = exp1;
            mapLockTimeoutRef.current = setTimeout(() => { if (mapLockExpiresAtRef.current === exp1) { isMapViewLockedRef.current = false; setIsMapViewLocked(false); mapLockExpiresAtRef.current = null; mapLockTimeoutRef.current = null; } }, 250);
          } else {
            clearTimer(); isMapViewLockedRef.current = true; setIsMapViewLocked(true);
          }
          pendingPhaseRef.current = ph; lastProgrammaticMapMoveRef.current = Date.now(); window._lastProgrammaticMapMove = Date.now(); setMapViewTrigger((p) => p + 1);
          break;
        }
        case 'USER_MAP_INTERACTION': {
          // User manually panned/zoomed while in phase 2/3 — unlock FAB and enter free-pan mode.
          clearTimer();
          isMapViewLockedRef.current = false;
          setIsMapViewLocked(false);
          // CRITICAL: Set the free-pan flag so handleMapViewCycle's state machine does NOT
          // immediately re-lock phase 2/3 on the next setMapViewTrigger tick.
          if (mapUserUnlockedRef) mapUserUnlockedRef.current = true;
          // CRITICAL: Update lastUserInteractionRef so the proximity snap 5-min suppression
          // engages — prevents the proximity snap from re-locking phase 2 while driver is
          // still within 100m of the stop they just freed from.
          if (lastUserInteractionRef) lastUserInteractionRef.current = Date.now();
          // Signal to the FAB to also update its visual "locked" appearance immediately
          fabControlEvents.publish({ type: 'FAB_MAP_UNLOCKED_BY_USER_INTERACTION' });
          break;
        }
        case 'BREAK_START': {
          phaseBeforeBreakRef.current = event.previousPhase || mapViewPhaseRef.current;
          clearTimer();
          setFabPhase(1, false);
          break;
        }
        case 'BREAK_END': {
          const restore = event.phaseToRestore || 1;
          clearTimer();
          phaseBeforeBreakRef.current = null;
          setFabPhase(restore, restore > 1);
          break;
        }
        case 'DONE_BUTTON_CLICKED':
        case 'DONE_RESET_TO_PHASE_ONE': {
          clearTimer();
          setFabPhase(1, true);
          armTimer(event.duration || 3000);
          break;
        }
        case 'ACCEPT_ALL_CLICKED': {
          // If FAB is in Phase 1, do NOT change anything — leave it in Phase 1.
          // Only unlock if currently locked in Phase 2 or Phase 3.
          if (mapViewPhaseRef.current === 1) break;
          clearTimer();
          isMapViewLockedRef.current = false;
          setIsMapViewLocked(false);
          break;
        }
        case 'DRIVER_SELECTION_CHANGED': {
          clearTimer();
          setFabPhase(1, true);
          armTimer(2000);
          break;
        }
        case 'NAVIGATE_BUTTON_TAPPED': {
          // Navigate button tapped: if currently in phase 2, re-lock it and force map reposition
          if (mapViewPhaseRef.current === 2) {
            clearTimer();
            isMapViewLockedRef.current = true;
            setIsMapViewLocked(true);
            pendingPhaseRef.current = 2;
            lastProgrammaticMapMoveRef.current = Date.now();
            window._lastProgrammaticMapMove = Date.now();
            setMapViewTrigger((p) => p + 1);
          }
          break;
        }
        case 'PHASE2_TEMP_UNLOCK': {
          // Unlock FAB temporarily (called when navigate button is tapped)
          clearTimer();
          isMapViewLockedRef.current = false;
          setIsMapViewLocked(false);
          // CRITICAL: Also update FAB visual state so it shows as unlocked (gray) immediately
          fabControlEvents.publish({ type: 'FAB_MAP_UNLOCKED_BY_USER_INTERACTION' });
          break;
        }
        case 'REACTIVATE_PHASE_TWO_IF_AVAILABLE': {
          // Re-lock FAB into phase 2 (called after navigate button tap)
          if (mapViewPhaseRef.current === 2) {
            clearTimer();
            isMapViewLockedRef.current = true;
            setIsMapViewLocked(true);
            lastProgrammaticMapMoveRef.current = Date.now();
            window._lastProgrammaticMapMove = Date.now();
            setMapViewTrigger((p) => p + 1);
          }
          break;
        }
        case 'IMMERSIVE_MODE_TOGGLED': {
          // When immersive mode turns OFF, re-lock the FAB at the current phase
          // so the button snaps back to its colored/active state.
          // Only act if we're in phase 2 or 3 — phase 1 is always unlocked anyway.
          const phaseOnExit = mapViewPhaseRef.current;
          if (phaseOnExit === 2 || phaseOnExit === 3) {
            clearTimer();
            isMapViewLockedRef.current = true;
            setIsMapViewLocked(true);
            pendingPhaseRef.current = phaseOnExit;
            lastProgrammaticMapMoveRef.current = Date.now();
            window._lastProgrammaticMapMove = Date.now();
            setMapViewTrigger((p) => p + 1);
          }
          break;
        }
        case 'ON_DUTY_FROM_TOGGLE': {
          // Driver went on_duty via the toggle (not the Start button).
          // Use the ref so the stable closure always calls the latest callback.
          setTimeout(() => onOnDutyFromToggleRef.current?.(), 800);
          break;
        }
        case 'DELIVERY_REALTIME_CREATE_DELETE_PULSE': {
          if (mapViewPhaseRef.current === 1 && typeof window.__fabFlashUpdate === 'function') {
            window.__fabFlashUpdate('route_change', { driverId: event.driverId });
          }
          break;
        }
        default:
          break;
      }
    });

    return () => {
      unsubscribe();
      window.removeEventListener('isNextDeliveryFlagUpdated', onIsNextDeliveryFlagUpdated);
      window.removeEventListener('proximityActivatedPhase2', onProximityActivatedPhase2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}