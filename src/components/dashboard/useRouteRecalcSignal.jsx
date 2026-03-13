import { useEffect, useState } from "react";

const ROUTE_RECALC_DISTANCE_METERS = 150;
const ROUTE_RECALC_DEBOUNCE_MS = 10000;

const toRadians = (value) => (value * Math.PI) / 180;

const calculateDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const buildCandidateMap = ({ currentDriverLocation, realtimeAppUsers, currentUserId }) => {
  const candidates = new Map();

  if (currentUserId && currentDriverLocation?.latitude && currentDriverLocation?.longitude) {
    candidates.set(currentUserId, {
      latitude: Number(currentDriverLocation.latitude),
      longitude: Number(currentDriverLocation.longitude),
      location_updated_at: currentDriverLocation.timestamp || new Date().toISOString()
    });
  }

  (realtimeAppUsers || []).forEach((user) => {
    const driverId = user?.id || user?.user_id;
    const latitude = Number(user?.current_latitude);
    const longitude = Number(user?.current_longitude);
    if (!driverId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    candidates.set(driverId, {
      latitude,
      longitude,
      location_updated_at: user?.location_updated_at || user?.updated_date || new Date().toISOString()
    });
  });

  return candidates;
};

const snapshotsEqual = (a, b) => {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    return !!left && !!right &&
      left.latitude === right.latitude &&
      left.longitude === right.longitude &&
      left.location_updated_at === right.location_updated_at;
  });
};

export function useRouteRecalcSignal({ currentDriverLocation, realtimeAppUsers, currentUserId }) {
  const [routeLocationSnapshot, setRouteLocationSnapshot] = useState({});
  const [routeRecalcVersion, setRouteRecalcVersion] = useState(0);

  useEffect(() => {
    const now = Date.now();
    const candidates = buildCandidateMap({ currentDriverLocation, realtimeAppUsers, currentUserId });

    setRouteLocationSnapshot((previousSnapshot) => {
      const nextSnapshot = {};

      candidates.forEach((candidate, driverId) => {
        const previous = previousSnapshot[driverId];
        if (!previous) {
          nextSnapshot[driverId] = candidate;
          return;
        }

        const distance = calculateDistanceMeters(
          previous.latitude,
          previous.longitude,
          candidate.latitude,
          candidate.longitude
        );
        const lastAcceptedAt = new Date(previous.location_updated_at || 0).getTime() || 0;
        const shouldAccept = distance >= ROUTE_RECALC_DISTANCE_METERS || (now - lastAcceptedAt) >= ROUTE_RECALC_DEBOUNCE_MS;

        nextSnapshot[driverId] = shouldAccept ? candidate : previous;
      });

      if (snapshotsEqual(previousSnapshot, nextSnapshot)) {
        return previousSnapshot;
      }

      setRouteRecalcVersion((value) => value + 1);
      return nextSnapshot;
    });
  }, [currentDriverLocation, realtimeAppUsers, currentUserId]);

  return { routeLocationSnapshot, routeRecalcVersion };
}

export default useRouteRecalcSignal;