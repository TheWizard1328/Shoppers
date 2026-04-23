import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MOTION_DISTANCE_METERS = 25;
const MOTION_WINDOW_MS = 12000;
const MAP_TAP_OVERRIDE_MS = 30000;

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

export default function useImmersiveMode({ isDriver, isMobile, driverLocation, enabled = true }) {
  const [isDriverMoving, setIsDriverMoving] = useState(false);
  const [isOverrideActive, setIsOverrideActive] = useState(false);
  const overrideTimeoutRef = useRef(null);
  const locationHistoryRef = useRef([]);

  useEffect(() => {
    if (!enabled || !isDriver || !isMobile || !driverLocation?.latitude || !driverLocation?.longitude) {
      locationHistoryRef.current = [];
      setIsDriverMoving(false);
      return;
    }

    const now = Date.now();
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
      setIsDriverMoving(false);
      return;
    }

    const firstPoint = nextHistory[0];
    const lastPoint = nextHistory[nextHistory.length - 1];
    const movedDistance = getDistanceMeters(firstPoint, lastPoint);
    setIsDriverMoving(movedDistance >= MOTION_DISTANCE_METERS);
  }, [enabled, isDriver, isMobile, driverLocation?.latitude, driverLocation?.longitude]);

  useEffect(() => () => {
    if (overrideTimeoutRef.current) {
      clearTimeout(overrideTimeoutRef.current);
    }
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

  const immersiveHidden = useMemo(() => {
    if (!enabled || !isDriver || !isMobile) return false;
    if (isOverrideActive) return false;
    return isDriverMoving;
  }, [enabled, isDriver, isMobile, isOverrideActive, isDriverMoving]);

  return {
    immersiveHidden,
    isDriverMoving,
    isOverrideActive,
    forceShowUI,
    overrideMsRemaining: isOverrideActive ? MAP_TAP_OVERRIDE_MS : 0
  };
}