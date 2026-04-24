import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MOTION_DISTANCE_METERS = 25;
const MOTION_WINDOW_MS = 12000;
const STOPPED_IDLE_MS = 5000;
const MAP_TAP_OVERRIDE_MS = 30000;
const NEXT_STOP_DISABLE_DISTANCE_METERS = 250;
const POST_STOP_ACTION_COOLDOWN_MS = 30000;

const toRad = (value) => (value * Math.PI) / 180;

const getDistanceMeters = (from, to) => {
  if (!from || !to) return 0;
  const lat1 = Number(from.latitude);
  const lon1 = Number(from.longitude);
  const lat2 = Number(to.latitude);
  const lon2 = Number(to.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;

  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
};

export default function useImmersiveMode({ isDriver, isMobile, driverLocation, nextStopLocation = null, enabled = true }) {
  const [isDriverMoving, setIsDriverMoving] = useState(false);
  const [isOverrideActive, setIsOverrideActive] = useState(false);
  const overrideTimeoutRef = useRef(null);
  const stoppedTimeoutRef = useRef(null);
  const postActionCooldownUntilRef = useRef(0);
  const locationHistoryRef = useRef([]);

  useEffect(() => {
    if (!enabled || !isDriver || !isMobile || !driverLocation?.latitude || !driverLocation?.longitude) {
      locationHistoryRef.current = [];
      if (stoppedTimeoutRef.current) {
        clearTimeout(stoppedTimeoutRef.current);
        stoppedTimeoutRef.current = null;
      }
      setIsDriverMoving(false);
      return;
    }

    const now = Date.now();
    if (now < postActionCooldownUntilRef.current) {
      locationHistoryRef.current = [];
      if (stoppedTimeoutRef.current) {
        clearTimeout(stoppedTimeoutRef.current);
        stoppedTimeoutRef.current = null;
      }
      setIsDriverMoving(false);
      return;
    }

    const nextPoint = {
      latitude: Number(driverLocation.latitude),
      longitude: Number(driverLocation.longitude),
      timestamp: now
    };

    const nextHistory = [...locationHistoryRef.current, nextPoint].filter(
      (point) => now - point.timestamp <= MOTION_WINDOW_MS
    );

    locationHistoryRef.current = nextHistory;

    if (nextHistory.length < 2) {
      if (stoppedTimeoutRef.current) clearTimeout(stoppedTimeoutRef.current);
      stoppedTimeoutRef.current = setTimeout(() => {
        locationHistoryRef.current = locationHistoryRef.current.slice(-1);
        setIsDriverMoving(false);
        stoppedTimeoutRef.current = null;
      }, STOPPED_IDLE_MS);
      setIsDriverMoving(false);
      return;
    }

    const firstPoint = nextHistory[0];
    const lastPoint = nextHistory[nextHistory.length - 1];
    const movedDistance = getDistanceMeters(firstPoint, lastPoint);
    const moving = movedDistance >= MOTION_DISTANCE_METERS;

    if (stoppedTimeoutRef.current) {
      clearTimeout(stoppedTimeoutRef.current);
      stoppedTimeoutRef.current = null;
    }

    if (moving) {
      setIsDriverMoving(true);
      return;
    }

    stoppedTimeoutRef.current = setTimeout(() => {
      locationHistoryRef.current = locationHistoryRef.current.slice(-1);
      setIsDriverMoving(false);
      stoppedTimeoutRef.current = null;
    }, STOPPED_IDLE_MS);
  }, [enabled, isDriver, isMobile, driverLocation?.latitude, driverLocation?.longitude]);

  useEffect(() => () => {
    if (overrideTimeoutRef.current) {
      clearTimeout(overrideTimeoutRef.current);
    }
    if (stoppedTimeoutRef.current) {
      clearTimeout(stoppedTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    const handlePostStopAction = () => {
      postActionCooldownUntilRef.current = Date.now() + POST_STOP_ACTION_COOLDOWN_MS;
      setIsDriverMoving(false);
      locationHistoryRef.current = [];
      if (stoppedTimeoutRef.current) {
        clearTimeout(stoppedTimeoutRef.current);
        stoppedTimeoutRef.current = null;
      }
    };

    const handleDeliveriesUpdated = (event) => {
      const trigger = event?.detail?.triggeredBy;
      if (trigger === 'statusUpdate') {
        handlePostStopAction();
      }
    };

    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdated);
    return () => window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdated);
  }, []);

  const forceShowUI = useCallback(() => {
    setIsOverrideActive(true);
    if (overrideTimeoutRef.current) {
      clearTimeout(overrideTimeoutRef.current);
    }
    overrideTimeoutRef.current = setTimeout(() => {
      setIsOverrideActive(false);
      overrideTimeoutRef.current = null;
    }, MAP_TAP_OVERRIDE_MS);
  }, []);

  const isNearNextStop = useMemo(() => {
    if (!driverLocation?.latitude || !driverLocation?.longitude || !nextStopLocation?.latitude || !nextStopLocation?.longitude) {
      return false;
    }
    return getDistanceMeters(driverLocation, nextStopLocation) <= NEXT_STOP_DISABLE_DISTANCE_METERS;
  }, [driverLocation?.latitude, driverLocation?.longitude, nextStopLocation?.latitude, nextStopLocation?.longitude]);

  const immersiveHidden = useMemo(() => {
    if (!enabled || !isDriver || !isMobile) return false;
    if (isOverrideActive) return false;
    if (isNearNextStop) return false;
    return isDriverMoving;
  }, [enabled, isDriver, isMobile, isOverrideActive, isNearNextStop, isDriverMoving]);

  const previousImmersiveHiddenRef = useRef(immersiveHidden);

  useEffect(() => {
    if (previousImmersiveHiddenRef.current !== immersiveHidden) {
      import('@/components/utils/fabControlEvents').then(({ fabControlEvents }) => {
        fabControlEvents.notifyImmersiveModeToggled();
      });
    }
    previousImmersiveHiddenRef.current = immersiveHidden;
  }, [immersiveHidden]);

  return {
    immersiveHidden,
    isDriverMoving,
    isOverrideActive,
    forceShowUI,
    overrideMsRemaining: isOverrideActive ? MAP_TAP_OVERRIDE_MS : 0
  };
}