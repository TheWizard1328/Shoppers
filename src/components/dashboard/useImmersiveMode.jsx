import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── Tuning constants ────────────────────────────────────────────────────────
// How far the driver must travel within MOTION_WINDOW_MS to be "moving"
const MOTION_DISTANCE_METERS = 50;   // was 120 — lowered; 50m in 30s ≈ 6 km/h
// Sliding window used to evaluate motion
const MOTION_WINDOW_MS = 30000;      // was 20s — widened to accumulate more GPS points
// How long with no movement before isDriverMoving resets to false
const STOPPED_IDLE_MS = 15000;       // was 10s
// How long a double-tap override suppresses immersive mode
const MAP_TAP_OVERRIDE_MS = 30000;
// Within this range of the next stop → disable immersive mode
const NEXT_STOP_DISABLE_DISTANCE_METERS = 250;   // Exit immersive when within this distance
const NEXT_STOP_REENABLE_DISTANCE_METERS = 350;  // Must move BEYOND this to re-enter immersive
// Minimum time between immersiveHidden state changes. GPS jitter at the proximity
// boundary can cause isNearNextStop to flip on every tick, producing rapid padding
// oscillation and the "double-jump" effect on the map.
const IMMERSIVE_TOGGLE_DEBOUNCE_MS = 3000;
// After completing/failing/cancelling a stop: block immersive re-activation
// for this long so the driver isn't immediately re-immersed while still parked
const POST_STOP_COOLDOWN_MS = 45000;
// GPS accuracy noise buffer subtracted from measured movement
const LOCATION_ACCURACY_BUFFER_METERS = 15;  // was 35 — too aggressive; phone GPS ~10-20m

// ─── Helpers ─────────────────────────────────────────────────────────────────
const toRad = (v) => (v * Math.PI) / 180;

const getDistanceMeters = (from, to) => {
  const lat1 = Number(from?.latitude ?? from?.lat);
  const lon1 = Number(from?.longitude ?? from?.lon);
  const lat2 = Number(to?.latitude ?? to?.lat);
  const lon2 = Number(to?.longitude ?? to?.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ─── Hook ─────────────────────────────────────────────────────────────────────
/**
 * Immersive mode rules:
 *
 * ACTIVATION (immersiveHidden = true — UI slides away):
 *   • Driver is moving (moved ≥ MOTION_DISTANCE_METERS within MOTION_WINDOW_MS)
 *   • AND a next-delivery stop exists (nextStopLocation is provided)
 *   • AND none of the three deactivation conditions are true
 *
 * DEACTIVATION (immersiveHidden = false — UI shown):
 *   1. Driver is within NEXT_STOP_DISABLE_DISTANCE_METERS of the next stop
 *   2. Driver double-tapped the map (forceShowUI called) → override for MAP_TAP_OVERRIDE_MS
 *   3. Driver has stopped moving (no MOTION_DISTANCE_METERS within MOTION_WINDOW_MS
 *      for STOPPED_IDLE_MS)
 *
 * Additionally: after any stop status change (complete/fail/cancel) a POST_STOP_COOLDOWN_MS
 * lock prevents re-activation even if GPS still shows historic movement.
 */
export default function useImmersiveMode({
  isDriver,
  isMobile,
  driverLocation,
  nextStopLocation = null,
  enabled = true,
}) {
  const [isDriverMoving, setIsDriverMoving] = useState(false);
  const [isOverrideActive, setIsOverrideActive] = useState(false);
  // Reactive cooldown state — drives immersiveHidden directly so the useMemo
  // doesn't have to rely on a stale Date.now() ref check.
  const [isCooldownActive, setIsCooldownActive] = useState(false);

  // ── App-owner TEST MODE ──────────────────────────────────────────────────────
  // Tapping the user badge on the mobile header forces immersiveHidden=true,
  // bypassing motion/proximity/role checks. ANY action that would normally
  // disable regular immersive mode clears the flag, leaving immersiveHidden
  // under normal logic until the badge is tapped again.
  const [testImmersiveActive, setTestImmersiveActive] = useState(false);

  const locationHistoryRef = useRef([]);
  // Track the previous values of deactivation conditions so we only clear test
  // mode when a transition happens (e.g. proximity false→true, motion true→false),
  // not on every render where the condition is simply true from the start.
  const prevIsNearStopForTestRef = useRef(false);
  const prevIsMovingForTestRef = useRef(false);
  const stoppedTimeoutRef = useRef(null);
  const overrideTimeoutRef = useRef(null);
  const cooldownTimeoutRef = useRef(null);
  // Timestamp until which post-stop cooldown is active
  const cooldownUntilRef = useRef(0);

  // ── Motion detection ────────────────────────────────────────────────────────
  useEffect(() => {
    // Prerequisites: enabled, driver role, mobile device, valid location
    if (!enabled || !isDriver || !isMobile || !driverLocation?.latitude || !driverLocation?.longitude) {
      locationHistoryRef.current = [];
      if (stoppedTimeoutRef.current) { clearTimeout(stoppedTimeoutRef.current); stoppedTimeoutRef.current = null; }
      setIsDriverMoving(false);
      return;
    }

    const now = Date.now();

    // POST-STOP COOLDOWN: discard incoming GPS points entirely so the location
    // history cannot rebuild and re-detect motion while the driver is still parked
    // after completing / failing / cancelling a stop.
    if (now < cooldownUntilRef.current) {
      locationHistoryRef.current = [];
      if (stoppedTimeoutRef.current) { clearTimeout(stoppedTimeoutRef.current); stoppedTimeoutRef.current = null; }
      setIsDriverMoving(false);
      return;
    }

    const point = {
      latitude: Number(driverLocation.latitude ?? driverLocation.lat),
      longitude: Number(driverLocation.longitude ?? driverLocation.lon),
      accuracy: Number(driverLocation.accuracy || 0),
      timestamp: now,
    };

    // Trim history to the sliding window and append the new point
    const history = [...locationHistoryRef.current.filter((p) => now - p.timestamp <= MOTION_WINDOW_MS), point];
    locationHistoryRef.current = history;

    // Need at least 2 points to compute displacement
    if (history.length < 2) {
      if (stoppedTimeoutRef.current) clearTimeout(stoppedTimeoutRef.current);
      stoppedTimeoutRef.current = setTimeout(() => {
        locationHistoryRef.current = locationHistoryRef.current.slice(-1);
        setIsDriverMoving(false);
        stoppedTimeoutRef.current = null;
      }, STOPPED_IDLE_MS);
      setIsDriverMoving(false);
      return;
    }

    const first = history[0];
    const last = history[history.length - 1];
    const rawDistance = getDistanceMeters(first, last);
    const worstAccuracy = Math.max(first.accuracy || 0, last.accuracy || 0);
    const effectiveDistance = Math.max(0, rawDistance - Math.min(worstAccuracy, LOCATION_ACCURACY_BUFFER_METERS));
    const moving = effectiveDistance >= MOTION_DISTANCE_METERS;

    if (moving) {
      // Driver is moving — clear any pending stopped timeout and mark as moving
      if (stoppedTimeoutRef.current) { clearTimeout(stoppedTimeoutRef.current); stoppedTimeoutRef.current = null; }
      setIsDriverMoving(true);
      return;
    }

    // Not moving — only schedule a stopped timeout if one isn't already running.
    // CRITICAL: Previously the timeout was cleared and re-set on EVERY GPS tick,
    // so it never fired as long as ticks kept arriving every <15s. This meant
    // isDriverMoving stayed true indefinitely when the driver was stopped,
    // keeping immersiveHidden=true and using immersive-mode padding even though
    // the UI showed the stats/stop cards (via isNearNextStop or override).
    if (!stoppedTimeoutRef.current) {
      stoppedTimeoutRef.current = setTimeout(() => {
        locationHistoryRef.current = locationHistoryRef.current.slice(-1);
        setIsDriverMoving(false);
        stoppedTimeoutRef.current = null;
      }, STOPPED_IDLE_MS);
    }
  // Also depend on driverLocation?.timestamp so the effect fires on every GPS tick,
  // not just when lat/lon digit values change (GPS can repeat coords with new timestamps).
  }, [enabled, isDriver, isMobile, driverLocation?.latitude, driverLocation?.longitude, driverLocation?.timestamp]);

  // ── Post-stop action cooldown ───────────────────────────────────────────────
  useEffect(() => {
    const engage = () => {
      cooldownUntilRef.current = Date.now() + POST_STOP_COOLDOWN_MS;
      locationHistoryRef.current = [];
      if (stoppedTimeoutRef.current) { clearTimeout(stoppedTimeoutRef.current); stoppedTimeoutRef.current = null; }
      if (overrideTimeoutRef.current) { clearTimeout(overrideTimeoutRef.current); overrideTimeoutRef.current = null; }
      if (cooldownTimeoutRef.current) { clearTimeout(cooldownTimeoutRef.current); cooldownTimeoutRef.current = null; }
      setIsDriverMoving(false);
      setIsOverrideActive(false);
      setTestImmersiveActive(false);
      // Reactively set cooldown active so immersiveHidden updates immediately
      setIsCooldownActive(true);
      cooldownTimeoutRef.current = setTimeout(() => {
        setIsCooldownActive(false);
        cooldownTimeoutRef.current = null;
      }, POST_STOP_COOLDOWN_MS);
    };

    const onDeliveriesUpdated = (e) => {
      const trigger = e?.detail?.triggeredBy;
      if ([
        'statusUpdate', 'complete', 'completed', 'failed', 'cancelled',
        'return', 'retry', 'restart', 'start', 'acceptAll', 'acceptAllOptimized',
        'deliveryStatusChanged',
      ].includes(trigger)) {
        engage();
      }
    };

    // Listen to both events: deliveriesUpdated (used by handleStatusUpdate, acceptAll, start, etc.)
    // AND deliveryStatusChanged (used by useStopCardActions for complete/fail/cancel flows).
    // Previously only deliveriesUpdated was monitored, so the post-stop cooldown never engaged
    // when a driver completed/failed/cancelled via the stop card action buttons — causing
    // immersive mode to immediately re-activate while the driver was still parked at the stop.
    const onDeliveryStatusChanged = (e) => {
      const trigger = e?.detail?.triggeredBy;
      if (['completed', 'complete', 'failed', 'retry', 'restart'].includes(trigger)) { //'cancelled', 'canceled', 'returned', 'return', 
        engage();
      }
    };

    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    window.addEventListener('deliveryStatusChanged', onDeliveryStatusChanged);
    return () => {
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
      window.removeEventListener('deliveryStatusChanged', onDeliveryStatusChanged);
    };
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────────────────────────
  useEffect(() => () => {
    if (overrideTimeoutRef.current) clearTimeout(overrideTimeoutRef.current);
    if (stoppedTimeoutRef.current) clearTimeout(stoppedTimeoutRef.current);
    if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
  }, []);

  // ── App-owner TEST MODE: toggle listener + state broadcast ──────────────────
  useEffect(() => {
    const onToggle = () => setTestImmersiveActive((prev) => !prev);
    window.addEventListener('app-owner-immersive-test-toggle', onToggle);
    return () => window.removeEventListener('app-owner-immersive-test-toggle', onToggle);
  }, []);

  // Broadcast the test-mode flag so the mobile-header avatar can reflect it.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('app-owner-immersive-test-state', {
      detail: { active: testImmersiveActive }
    }));
  }, [testImmersiveActive]);

  // ── Deactivation condition 2: double-tap override ───────────────────────────
  const forceShowUI = useCallback(() => {
    // App-owner test mode is cleared by this explicit user gesture.
    setTestImmersiveActive(false);
    setIsOverrideActive(true);
    // CRITICAL: User-initiated tap must exit immersive mode INSTANTLY. The 3-second
    // IMMERSIVE_TOGGLE_DEBOUNCE_MS is meant for GPS-jitter proximity flips, not for
    // an explicit gesture — but it currently gates this flip too, causing the
    // "very long delay / doesn't deactivate / need 2-3 taps" symptom. Bypass the
    // debounce here: cancel any pending toggle, clear the pending ref, and commit
    // immersiveHidden=false synchronously so the UI reappears immediately.
    if (immersiveToggleTimerRef.current) {
      clearTimeout(immersiveToggleTimerRef.current);
      immersiveToggleTimerRef.current = null;
    }
    pendingImmersiveRef.current = null;
    setImmersiveHidden(false);
    if (overrideTimeoutRef.current) clearTimeout(overrideTimeoutRef.current);
    overrideTimeoutRef.current = setTimeout(() => {
      setIsOverrideActive(false);
      overrideTimeoutRef.current = null;
    }, MAP_TAP_OVERRIDE_MS);
  }, []);

  // ── Deactivation condition 1: proximity to next stop (with hysteresis) ──────
  // Uses two thresholds to prevent oscillation at the boundary:
  //   ≤250m → isNearNextStop = true  (immersive OFF)
  //   ≥350m → isNearNextStop = false (immersive can turn ON)
  // Between 250-350m, the previous state is retained (hysteresis band).
  const isNearNextStopRef = useRef(false);
  const isNearNextStop = useMemo(() => {
    if (!nextStopLocation) return false;
    const dLat = Number(driverLocation?.latitude ?? driverLocation?.lat);
    const dLon = Number(driverLocation?.longitude ?? driverLocation?.lon);
    const sLat = Number(nextStopLocation?.latitude ?? nextStopLocation?.lat);
    const sLon = Number(nextStopLocation?.longitude ?? nextStopLocation?.lon);
    if (![dLat, dLon, sLat, sLon].every(Number.isFinite)) return false;
    const dist = getDistanceMeters({ latitude: dLat, longitude: dLon }, { latitude: sLat, longitude: sLon });
    if (dist <= NEXT_STOP_DISABLE_DISTANCE_METERS) {
      isNearNextStopRef.current = true;
    } else if (dist >= NEXT_STOP_REENABLE_DISTANCE_METERS) {
      isNearNextStopRef.current = false;
    }
    // In the hysteresis band (250-350m), retain previous state
    return isNearNextStopRef.current;
  }, [
    driverLocation?.latitude, driverLocation?.longitude,
    driverLocation?.lat, driverLocation?.lon,
    nextStopLocation?.latitude, nextStopLocation?.longitude,
    nextStopLocation?.lat, nextStopLocation?.lon,
    nextStopLocation,
  ]);

  // ── App-owner TEST MODE: clear on normal deactivation transitions ────────────
  // Any of these "I would normally disable immersive" transitions (entering the
  // proximity radius, coming to a stop after moving) clears test mode so the
  // UI reappears and stays disabled until the badge is tapped again.
  useEffect(() => {
    if (testImmersiveActive && isNearNextStop && !prevIsNearStopForTestRef.current) {
      setTestImmersiveActive(false);
    }
    prevIsNearStopForTestRef.current = isNearNextStop;
  }, [testImmersiveActive, isNearNextStop]);

  useEffect(() => {
    if (testImmersiveActive && prevIsMovingForTestRef.current && !isDriverMoving) {
      setTestImmersiveActive(false);
    }
    prevIsMovingForTestRef.current = isDriverMoving;
  }, [testImmersiveActive, isDriverMoving]);

  // ── Debounce immersiveHidden state changes ──────────────────────────────────
  // Prevents rapid toggling caused by GPS jitter at the proximity boundary.
  // When the computed value flips, we wait IMMERSIVE_TOGGLE_DEBOUNCE_MS before
  // committing the change. If it flips back within that window, the change is
  // cancelled — the driver never sees the oscillation.
  const rawImmersiveHidden = useMemo(() => {
    // TEST MODE forces immersiveHidden on, bypassing role/motion/proximity gates.
    if (testImmersiveActive) return true;
    if (!enabled || !isDriver || !isMobile) return false;
    if (isCooldownActive) return false;
    if (!nextStopLocation) return false;
    if (isOverrideActive) return false;
    if (isNearNextStop) return false;
    return isDriverMoving;
  }, [testImmersiveActive, enabled, isDriver, isMobile, isCooldownActive, nextStopLocation, isOverrideActive, isNearNextStop, isDriverMoving]);

  const pendingImmersiveRef = useRef(null);
  const immersiveToggleTimerRef = useRef(null);
  const [immersiveHidden, setImmersiveHidden] = useState(false);
  useEffect(() => {
    // If the raw value matches the current committed value, nothing to do.
    if (rawImmersiveHidden === immersiveHidden) {
      if (immersiveToggleTimerRef.current) {
        clearTimeout(immersiveToggleTimerRef.current);
        immersiveToggleTimerRef.current = null;
        pendingImmersiveRef.current = null;
      }
      return;
    }
    // If we already have a pending change to this same value, do nothing.
    if (pendingImmersiveRef.current === rawImmersiveHidden) return;
    // Cancel any previous pending change and schedule the new one.
    if (immersiveToggleTimerRef.current) {
      clearTimeout(immersiveToggleTimerRef.current);
    }
    pendingImmersiveRef.current = rawImmersiveHidden;
    immersiveToggleTimerRef.current = setTimeout(() => {
      setImmersiveHidden(rawImmersiveHidden);
      immersiveToggleTimerRef.current = null;
      pendingImmersiveRef.current = null;
    }, IMMERSIVE_TOGGLE_DEBOUNCE_MS);
  }, [rawImmersiveHidden, immersiveHidden]);

  // ── App-owner TEST MODE: commit immediately, bypassing the 3s debounce ──────
  // Tapping the badge (or being cleared by a deactivation transition) should
  // show/hide the UI instantly — the debounce exists for GPS jitter, not user
  // gestures.
  useEffect(() => {
    if (testImmersiveActive !== immersiveHidden) {
      if (immersiveToggleTimerRef.current) {
        clearTimeout(immersiveToggleTimerRef.current);
        immersiveToggleTimerRef.current = null;
      }
      pendingImmersiveRef.current = null;
      setImmersiveHidden(testImmersiveActive);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testImmersiveActive]);

  // ── Notify FAB on immersive toggle ─────────────────────────────────────────
  const previousImmersiveHiddenRef = useRef(immersiveHidden);
  useEffect(() => {
    if (previousImmersiveHiddenRef.current !== immersiveHidden) {
      // When exiting immersive mode (hidden → visible), stamp a global timestamp so
      // proximity-snap and GPS map repositioning are suppressed for 5 seconds.
      // This prevents the map from jumping to Phase 2 on the first GPS tick after exit.
      if (previousImmersiveHiddenRef.current && !immersiveHidden) {
        window._lastImmersiveExitAt = Date.now();
      }
      // When ENTERING immersive mode (visible → hidden), stamp a global timestamp so
      // the watchdog and GPS map repositioning are suppressed for a grace period.
      // This prevents the double-zoom: immersive refit fires with immersive padding,
      // then the first GPS tick (or watchdog) fires a second animation that puts
      // markers behind partially-visible UI elements.
      if (!previousImmersiveHiddenRef.current && immersiveHidden) {
        window._lastImmersiveEntryAt = Date.now();
      }
    }
    previousImmersiveHiddenRef.current = immersiveHidden;
  }, [immersiveHidden]);

  // Cleanup debounce timer on unmount
  useEffect(() => () => {
    if (immersiveToggleTimerRef.current) clearTimeout(immersiveToggleTimerRef.current);
  }, []);

  return {
    immersiveHidden,
    isDriverMoving,
    isOverrideActive,
    forceShowUI,
    overrideMsRemaining: isOverrideActive ? MAP_TAP_OVERRIDE_MS : 0,
  };
}