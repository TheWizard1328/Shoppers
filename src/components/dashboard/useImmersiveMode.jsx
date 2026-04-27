import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MOTION_DISTANCE_METERS = 120;
const MOTION_WINDOW_MS = 20000;
const STOPPED_IDLE_MS = 10000;
const MAP_TAP_OVERRIDE_MS = 30000;
const NEXT_STOP_DISABLE_DISTANCE_METERS = 250;
const POST_STOP_ACTION_COOLDOWN_MS = 30000;
const LOCATION_ACCURACY_BUFFER_METERS = 35;

const toRad = (value) => (value * Math.PI) / 180;

const getCoordinate = (point, latKey, lonKey) => {
  if (!point) return { latitude: NaN, longitude: NaN };
  return {
    latitude: Number(point.latitude ?? point.lat ?? latKey),
    longitude: Number(point.longitude ?? point.lon ?? lonKey)
  };
};

const getDistanceMeters = (from, to) => {
  if (!from || !to) return 0;
  const fromCoords = getCoordinate(from);
  const toCoords = getCoordinate(to);
  const lat1 = fromCoords.latitude;
  const lon1 = fromCoords.longitude;
  const lat2 = toCoords.latitude;
  const lon2 = toCoords.longitude;
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
      latitude: Number(driverLocation.latitude ?? driverLocation.lat),
      longitude: Number(driverLocation.longitude ?? driverLocation.lon),
      accuracy: Number(driverLocation.accuracy || 0),
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
    const worstAccuracy = Math.max(firstPoint?.accuracy || 0, lastPoint?.accuracy || 0);
    const effectiveMovedDistance = Math.max(0, movedDistance - Math.min(worstAccuracy, LOCATION_ACCURACY_BUFFER_METERS));
    const moving = effectiveMovedDistance >= MOTION_DISTANCE_METERS;

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
      if (overrideTimeoutRef.current) {
        clearTimeout(overrideTimeoutRef.current);
        overrideTimeoutRef.current = null;
      }
      setIsOverrideActive(false);
    };

    const handleDeliveriesUpdated = (event) => {
      const trigger = event?.detail?.triggeredBy;
      if (['statusUpdate', 'complete', 'completed', 'failed', 'cancelled', 'return', 'retry', 'restart', 'start', 'acceptAll', 'acceptAllOptimized', 'deliveryStatusChanged'].includes(trigger)) {
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
    const driverLat = Number(driverLocation?.latitude ?? driverLocation?.lat);
    const driverLon = Number(driverLocation?.longitude ?? driverLocation?.lon);
    const stopLat = Number(nextStopLocation?.latitude ?? nextStopLocation?.lat);
    const stopLon = Number(nextStopLocation?.longitude ?? nextStopLocation?.lon);

    if (![driverLat, driverLon, stopLat, stopLon].every(Number.isFinite)) {
      return false;
    }

    return getDistanceMeters(
      { latitude: driverLat, longitude: driverLon },
      { latitude: stopLat, longitude: stopLon }
    ) <= NEXT_STOP_DISABLE_DISTANCE_METERS;
  }, [driverLocation?.latitude, driverLocation?.longitude, driverLocation?.lat, driverLocation?.lon, nextStopLocation?.latitude, nextStopLocation?.longitude, nextStopLocation?.lat, nextStopLocation?.lon]);

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