import { useEffect, useMemo, useRef, useState } from "react";

const MOVING_HIDE_DELAY_MS = 10000;
const NEXT_STOP_RESTORE_DISTANCE_KM = 0.5;

const calculateDistanceKm = (lat1, lon1, lat2, lon2) => {
  if (![lat1, lon1, lat2, lon2].every((value) => Number.isFinite(Number(value)))) return Infinity;
  const toRadians = (value) => Number(value) * Math.PI / 180;
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const hasIncompleteNextStop = (nextStopCoordinates) => {
  if (!nextStopCoordinates) return false;
  const status = String(nextStopCoordinates.status || '').toLowerCase();
  return !['completed', 'failed', 'cancelled', 'returned'].includes(status);
};

export default function useImmersiveNavigationMode({
  enabled,
  isDriver,
  isMobile,
  driverLocation,
  nextStopCoordinates,
}) {
  const [isImmersiveHidden, setIsImmersiveHidden] = useState(false);
  const hideTimerRef = useRef(null);
  const isMovingRef = useRef(false);

  const isNearNextStop = useMemo(() => {
    if (
      !hasIncompleteNextStop(nextStopCoordinates) ||
      !driverLocation?.latitude ||
      !driverLocation?.longitude ||
      !nextStopCoordinates?.lat ||
      !nextStopCoordinates?.lon
    ) {
      return false;
    }
    return calculateDistanceKm(
      driverLocation.latitude,
      driverLocation.longitude,
      nextStopCoordinates.lat,
      nextStopCoordinates.lon
    ) <= NEXT_STOP_RESTORE_DISTANCE_KM;
  }, [driverLocation?.latitude, driverLocation?.longitude, nextStopCoordinates]);

  useEffect(() => {
    if (!enabled || !isDriver || !isMobile) {
      setIsImmersiveHidden(false);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      return;
    }

    const restoreUi = () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setIsImmersiveHidden(false);
    };

    const scheduleHide = () => {
      if (hideTimerRef.current || isNearNextStop) return;
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        if (isMovingRef.current && !isNearNextStop) {
          setIsImmersiveHidden(true);
        }
      }, MOVING_HIDE_DELAY_MS);
    };

    const handleMotionChanged = (event) => {
      const moving = event.detail?.isMoving === true;
      isMovingRef.current = moving;

      if (!moving) {
        restoreUi();
        return;
      }

      if (isNearNextStop) {
        restoreUi();
        return;
      }

      scheduleHide();
    };

    const handleMapRestore = () => {
      restoreUi();
    };

    window.addEventListener("driverMotionChanged", handleMotionChanged);
    window.addEventListener("dashboardMapTapped", handleMapRestore);

    if (isNearNextStop) {
      restoreUi();
    }

    return () => {
      window.removeEventListener("driverMotionChanged", handleMotionChanged);
      window.removeEventListener("dashboardMapTapped", handleMapRestore);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [enabled, isDriver, isMobile, isNearNextStop]);

  useEffect(() => {
    if (isNearNextStop) {
      setIsImmersiveHidden(false);
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    }
  }, [isNearNextStop]);

  return {
    isImmersiveHidden,
    isNearNextStop,
  };
}