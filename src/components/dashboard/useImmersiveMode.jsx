import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── Tuning constants ────────────────────────────────────────────────────────
// How far the driver must travel within MOTION_WINDOW_MS to be "moving"
const MOTION_DISTANCE_METERS = 120;
// Sliding window used to evaluate motion
const MOTION_WINDOW_MS = 20000;
// How long with no movement before isDriverMoving resets to false
const STOPPED_IDLE_MS = 10000;
// How long a double-tap override suppresses immersive mode
const MAP_TAP_OVERRIDE_MS = 30000;
// Within this range of the next stop → disable immersive mode
const NEXT_STOP_DISABLE_DISTANCE_METERS = 250;
// After completing/failing/cancelling a stop: block immersive re-activation
// for this long so the driver isn't immediately re-immersed while still parked
const POST_STOP_COOLDOWN_MS = 45000;
// GPS accuracy noise buffer subtracted from measured movement
const LOCATION_ACCURACY_BUFFER_METERS = 35;

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

  const locationHistoryRef = useRef([]);
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

    if (stoppedTimeoutRef.current) { clearTimeout(stoppedTimeoutRef.current); stoppedTimeoutRef.current = null; }

    if (moving) {
      setIsDriverMoving(true);
      return;
    }

    // Not moving yet — schedule a reset after idle threshold
    stoppedTimeoutRef.current = setTimeout(() => {
      locationHistoryRef.current = locationHistoryRef.current.slice(-1);
      setIsDriverMoving(false);
      stoppedTimeoutRef.current = null;
    }, STOPPED_IDLE_MS);
  }, [enabled, isDriver, isMobile, driverLocation?.latitude, driverLocation?.longitude]);

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

    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    return () => window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
  }, []);

  // ── Cleanup on unmount ──────────────────────────────────────────────────────
  useEffect(() => () => {
    if (overrideTimeoutRef.current) clearTimeout(overrideTimeoutRef.current);
    if (stoppedTimeoutRef.current) clearTimeout(stoppedTimeoutRef.current);
    if (cooldownTimeoutRef.current) clearTimeout(cooldownTimeoutRef.current);
  }, []);

  // ── Deactivation condition 2: double-tap override ───────────────────────────
  const forceShowUI = useCallback(() => {
    setIsOverrideActive(true);
    if (overrideTimeoutRef.current) clearTimeout(overrideTimeoutRef.current);
    overrideTimeoutRef.current = setTimeout(() => {
      setIsOverrideActive(false);
      overrideTimeoutRef.current = null;
    }, MAP_TAP_OVERRIDE_MS);
  }, []);

  // ── Deactivation condition 1: proximity to next stop ────────────────────────
  const isNearNextStop = useMemo(() => {
    if (!nextStopLocation) return false;
    const dLat = Number(driverLocation?.latitude ?? driverLocation?.lat);
    const dLon = Number(driverLocation?.longitude ?? driverLocation?.lon);
    const sLat = Number(nextStopLocation?.latitude ?? nextStopLocation?.lat);
    const sLon = Number(nextStopLocation?.longitude ?? nextStopLocation?.lon);
    if (![dLat, dLon, sLat, sLon].every(Number.isFinite)) return false;
    return getDistanceMeters({ latitude: dLat, longitude: dLon }, { latitude: sLat, longitude: sLon }) <= NEXT_STOP_DISABLE_DISTANCE_METERS;
  }, [
    driverLocation?.latitude, driverLocation?.longitude,
    driverLocation?.lat, driverLocation?.lon,
    nextStopLocation?.latitude, nextStopLocation?.longitude,
    nextStopLocation?.lat, nextStopLocation?.lon,
    nextStopLocation,
  ]);

  // ── Final immersive state ───────────────────────────────────────────────────
  // ACTIVATE when: driver is moving AND a next stop exists
  // DEACTIVATE when: near next stop OR manual override OR stopped OR cooldown OR no next stop
  const immersiveHidden = useMemo(() => {
    if (!enabled || !isDriver || !isMobile) return false;
    if (isCooldownActive) return false;    // post-stop cooldown — force UI visible (reactive, not stale ref)
    if (!nextStopLocation) return false;   // no next stop → never immersive
    if (isOverrideActive) return false;    // deactivation #2: double-tap
    if (isNearNextStop) return false;      // deactivation #1: proximity
    return isDriverMoving;                 // activate only if moving; deactivation #3: stopped
  }, [enabled, isDriver, isMobile, isCooldownActive, nextStopLocation, isOverrideActive, isNearNextStop, isDriverMoving]);

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
    }
    previousImmersiveHiddenRef.current = immersiveHidden;
  }, [immersiveHidden]);

  return {
    immersiveHidden,
    isDriverMoving,
    isOverrideActive,
    forceShowUI,
    overrideMsRemaining: isOverrideActive ? MAP_TAP_OVERRIDE_MS : 0,
  };
}