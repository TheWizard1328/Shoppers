import React, { useEffect, useMemo, useState, useRef } from "react";
import { Polyline } from "react-leaflet";
import { ensurePolylineSubscription } from "../utils/hereRouting";
import { getRouteOptimizationSettings } from "./RouteOptimizationSettings";
import { getTravelModeLineStyle, normalizeTravelMode } from "./travelModeHelpers";
import RouteDirectionDecorator from "./RouteDirectionDecorator";

const FINISHED = ["completed", "failed", "cancelled", "returned"];

// Helper: visible fallback even when stops share same coordinates or coords are strings
const samePoint = (a, b) => (
  Math.abs(Number(a?.latitude) - Number(b?.latitude)) < 1e-5 &&
  Math.abs(Number(a?.longitude) - Number(b?.longitude)) < 1e-5
);
const makeFallback = (a, b) => {
  if (!a || !b) return [];
  const A = [Number(a.latitude), Number(a.longitude)];
  const B = [Number(b.latitude), Number(b.longitude)];
  if (!isFinite(A[0]) || !isFinite(A[1]) || !isFinite(B[0]) || !isFinite(B[1])) return [];
  if (samePoint(a, b)) {
    return [A, [A[0] + 0.0003, A[1] + 0.0003]];
  }
  return [A, B];
};

const getSegmentKey = (driverId, from, to) => {
  if (!driverId || !from || !to) return null;
  return `${driverId}_${Number(from.latitude).toFixed(5)}_${Number(from.longitude).toFixed(5)}_${Number(to.latitude).toFixed(5)}_${Number(to.longitude).toFixed(5)}`;
};

const getHereCacheKey = (from, to, mode = 'driving') => {
  if (!from || !to) return null;
  return `here_${normalizeTravelMode(mode)}_${Number(from.latitude).toFixed(5)}_${Number(from.longitude).toFixed(5)}_${Number(to.latitude).toFixed(5)}_${Number(to.longitude).toFixed(5)}`;
};

const getCachedPolyline = (key, memoryCache) => {
  if (!key) return null;
  const inMemory = memoryCache[key];
  if (Array.isArray(inMemory) && inMemory.length > 1) return inMemory;
  try {
    const cached = localStorage.getItem(key);
    if (!cached) return null;
    const parsed = JSON.parse(cached);
    return Array.isArray(parsed) && parsed.length > 1 ? parsed : null;
  } catch (_) {
    return null;
  }
};

const getLiveDriverMarker = (driverId, currentDriverMarker, driverLocations) => {
  const currentId = currentDriverMarker?.driverId || currentDriverMarker?.driver_id;
  if (currentId === driverId) return currentDriverMarker;
  return (driverLocations || []).find((marker) => (marker?.driverId || marker?.driver_id) === driverId) || null;
};

const toMetersPoint = ({ lat, lng }, originLat) => {
  const latFactor = 111320;
  const lonFactor = 111320 * Math.cos((originLat * Math.PI) / 180);
  return { x: lng * lonFactor, y: lat * latFactor };
};

const pointToSegmentDistanceMeters = (point, start, end) => {
  const originLat = (point.lat + start.lat + end.lat) / 3;
  const p = toMetersPoint(point, originLat);
  const a = toMetersPoint(start, originLat);
  const b = toMetersPoint(end, originLat);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
};

const pointToPolylineDistanceMeters = (point, polyline) => {
  if (!point || !Array.isArray(polyline) || polyline.length < 2) return Infinity;
  let minDistance = Infinity;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const start = { lat: Number(polyline[i][0]), lng: Number(polyline[i][1]) };
    const end = { lat: Number(polyline[i + 1][0]), lng: Number(polyline[i + 1][1]) };
    if (![start.lat, start.lng, end.lat, end.lng].every(Number.isFinite)) continue;
    minDistance = Math.min(minDistance, pointToSegmentDistanceMeters(point, start, end));
  }
  return minDistance;
};

const buildBreadcrumbLine = (breadcrumbsValue, origin, current, sampleEvery = 5) => {
  const originPoint = [Number(origin?.latitude), Number(origin?.longitude)];
  const currentPoint = [Number(current?.latitude), Number(current?.longitude)];
  if (!originPoint.every(Number.isFinite) || !currentPoint.every(Number.isFinite)) return [];

  let breadcrumbs = [];
  try {
    const parsed = typeof breadcrumbsValue === 'string' ? JSON.parse(breadcrumbsValue) : breadcrumbsValue;
    breadcrumbs = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    breadcrumbs = [];
  }

  const sampled = breadcrumbs
    .filter((_, index) => index % sampleEvery === 0)
    .map((point) => [Number(point?.[0]), Number(point?.[1])])
    .filter((point) => point.every(Number.isFinite));

  const combined = [originPoint, ...sampled, currentPoint];
  return combined.filter((point, index) => {
    if (index === 0) return true;
    const previous = combined[index - 1];
    return Math.abs(previous[0] - point[0]) > 0.00001 || Math.abs(previous[1] - point[1]) > 0.00001;
  });
};

export default function HereType1Polylines({
  isViewingCurrentDate,
  deliveryMarkers = [],
  pickupMarkers = [],
  driverHomeMarkers = [],
  currentDriverMarker = null,
  selectedDriverId = null,
  showAll = false,
  driverLocations = [],
  driverTravelModes = {},
}) {
  const [cache, setCache] = useState({});
  const [refreshToken, setRefreshToken] = useState(0);
  const [localDriverTravelModes, setLocalDriverTravelModes] = useState({});
  const [deviationSegments, setDeviationSegments] = useState({});
  const deviationMetaRef = useRef({});

  useEffect(() => {
    ensurePolylineSubscription();
  }, []);

  // Offline polyline hydration helper
  const round5 = (n) => Number(n.toFixed(5));
  const decodePolyline = (str) => {
    let index = 0, lat = 0, lng = 0, coordinates = [];
    while (index < str.length) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
      lat += dlat;
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
      lng += dlng;
      coordinates.push([lat / 1e5, lng / 1e5]);
    }
    return coordinates;
  };
  const hydrateFromOffline = async (key, driverId, from, to, date) => {
    try {
      const { offlineDB } = await import('../utils/offlineDatabase');
      const targetDate = date || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const rows = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, targetDate).catch(() => []);
      console.log(`[Type1] Hydrating delivery polyline from offline DB for ${driverId} on ${targetDate}: found ${rows?.length || 0} deliveries`);
      const fLat = round5(from.latitude), fLon = round5(from.longitude);
      const tLat = round5(to.latitude), tLon = round5(to.longitude);
      const preferredMode = normalizeTravelMode(getDriverMode(driverId));
      const exactMatch = rows.find((row) =>
        row?.driver_id === driverId &&
        round5(Number(row?.segment_origin_lat)) === fLat &&
        round5(Number(row?.segment_origin_lon)) === fLon &&
        round5(Number(row?.segment_dest_lat)) === tLat &&
        round5(Number(row?.segment_dest_lon)) === tLon &&
        normalizeTravelMode(row?.transport_mode) === preferredMode &&
        typeof row?.encoded_polyline === 'string' &&
        row.encoded_polyline.trim().length > 0
      );
      const fallbackMatch = exactMatch || rows.find((row) =>
        row?.driver_id === driverId &&
        round5(Number(row?.segment_origin_lat)) === fLat &&
        round5(Number(row?.segment_origin_lon)) === fLon &&
        round5(Number(row?.segment_dest_lat)) === tLat &&
        round5(Number(row?.segment_dest_lon)) === tLon &&
        typeof row?.encoded_polyline === 'string' &&
        row.encoded_polyline.trim().length > 0
      );
      if (fallbackMatch) {
        console.log(`[Type1] Found matching delivery polyline in offline DB for segment ${from.latitude},${from.longitude} -> ${to.latitude},${to.longitude}`);
        const coords = decodePolyline(fallbackMatch.encoded_polyline);
        if (Array.isArray(coords) && coords.length > 1) {
          setCache((p) => ({ ...p, [key]: coords }));
          try { localStorage.setItem(key, JSON.stringify(coords)); } catch (_) {}
          return true;
        }
      } else {
        console.log(`[Type1] No matching delivery polyline found in offline DB for segment ${from.latitude},${from.longitude} -> ${to.latitude},${to.longitude}`);
      }
    } catch (err) {
      console.error(`[Type1] Error hydrating from offline DB:`, err);
    }
    return false;
  };
  const [optimizing, setOptimizing] = useState(false);
  const [lastNonEmptyLines, setLastNonEmptyLines] = useState([]);
  const lastHydratedSegmentKeysRef = useRef({});
  useEffect(() => {
    setLastNonEmptyLines([]);
    setDeviationSegments({});
    deviationMetaRef.current = {};
    lastHydratedSegmentKeysRef.current = {};
  }, [selectedDriverId, showAll]);
  const requestTimesRef = useRef({});
  const mountTimeRef = useRef(Date.now());

  const driverStops = useMemo(() => {
    const map = new Map();
    const allStops = [...deliveryMarkers, ...pickupMarkers];
    const scopedStops = (!showAll && selectedDriverId && selectedDriverId !== 'all')
      ? allStops.filter(m => m && m.driver_id === selectedDriverId)
      : allStops;

    scopedStops.forEach((m) => {
      if (!m || !m.driver_id || Number.isNaN(Number(m.latitude)) || Number.isNaN(Number(m.longitude))) return;
      if (!map.has(m.driver_id)) map.set(m.driver_id, { complete: [], incomplete: [], pending: [] });
      if (FINISHED.includes(m.status)) map.get(m.driver_id).complete.push(m);
      else if (m.status === "in_transit" || m.status === "en_route") map.get(m.driver_id).incomplete.push(m);
      else if (m.status === "pending") map.get(m.driver_id).pending.push(m);
    });
    
    // Sort incomplete stops by stop_order to ensure we find the true "next" stop
    map.forEach((stops) => {
      stops.incomplete.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
    });
    
    return map;
  }, [deliveryMarkers, pickupMarkers, selectedDriverId, showAll]);

  const driversWithCompleteRoute = useMemo(() => {
    const out = new Set();
    driverStops.forEach((stops, driverId) => {
      const pendingCount = (stops.pending?.length || 0);
      if (stops.incomplete.length === 0 && pendingCount === 0 && stops.complete.length > 0) out.add(driverId);
    });
    return out;
  }, [driverStops]);

  // Listen only to route-shape-changing events so location pings don't redraw type-1 lines
  useEffect(() => {
    const invalidate = () => { setRefreshToken((t) => t + 1); };
    const onReorder = invalidate;
    const onDriverTravelModeChanged = (event) => {
      const driverId = event?.detail?.driverId;
      const travelMode = event?.detail?.travelMode;
      if (!driverId || !travelMode) return;
      setLocalDriverTravelModes((prev) => ({ ...prev, [driverId]: travelMode }));
      setCache({});
      setLastNonEmptyLines([]);
      invalidate();
    };
    const onOptimizationStarted = () => { setOptimizing(true); };
    const onOptimizationComplete = () => { setOptimizing(false); invalidate(); };
    const onPolyline = (e) => {
      const key = e?.detail?.key;
      const coordsFromEvent = e?.detail?.coords;
      if (!key) return;

      if (Array.isArray(coordsFromEvent) && coordsFromEvent.length > 1) {
        try { localStorage.setItem(key, JSON.stringify(coordsFromEvent)); } catch (_) {}
        setCache((p) => ({ ...p, [key]: coordsFromEvent }));
        return;
      }

      try {
        const cached = localStorage.getItem(key);
        if (cached) {
          const coords = JSON.parse(cached);
          if (Array.isArray(coords) && coords.length > 1) {
            setCache((p) => ({ ...p, [key]: coords }));
            return;
          }
        }
      } catch (_) {}
      // Fallback: light refresh without nuking everything
      setRefreshToken((t) => t + 1);
    };
    const onDeliveryCompleted = invalidate;
    const onDeliveryFailed = invalidate;
    const onPolylineCacheCleared = () => {
      setCache({});
      setLastNonEmptyLines([]);
      invalidate();
    };
    window.addEventListener('routeReordered', onReorder);
    window.addEventListener('driverTravelModeChanged', onDriverTravelModeChanged);
    window.addEventListener('polylineUpdated', onPolyline);
    window.addEventListener('routeOptimizationComplete', onOptimizationComplete);
    window.addEventListener('routeOptimizationStarted', onOptimizationStarted);
    window.addEventListener('polylineCacheCleared', onPolylineCacheCleared);
    window.addEventListener('deliveryCompleted', onDeliveryCompleted);
    window.addEventListener('deliveryFailed', onDeliveryFailed);
    return () => {
      window.removeEventListener('routeReordered', onReorder);
      window.removeEventListener('driverTravelModeChanged', onDriverTravelModeChanged);
      window.removeEventListener('polylineUpdated', onPolyline);
      window.removeEventListener('routeOptimizationComplete', onOptimizationComplete);
      window.removeEventListener('routeOptimizationStarted', onOptimizationStarted);
      window.removeEventListener('polylineCacheCleared', onPolylineCacheCleared);
      window.removeEventListener('deliveryCompleted', onDeliveryCompleted);
      window.removeEventListener('deliveryFailed', onDeliveryFailed);
    };
  }, []);

  // Hydrate last-completed -> next-stop from offline DB ONLY (no backend calls)
  useEffect(() => {
    if (optimizing || (Date.now() - mountTimeRef.current < 1200)) return;
    driverStops.forEach((stops, driverId) => {
      if (stops.incomplete.length === 0 || stops.complete.length === 0) return;
      const completedSorted = [...stops.complete].sort((a, b) => {
        const at = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : (a.updated_date ? new Date(a.updated_date).getTime() : 0);
        const bt = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : (b.updated_date ? new Date(b.updated_date).getTime() : 0);
        return bt - at;
      });
      const lastCompleted = completedSorted[0];
      const orderedIncompleteStops = [...stops.incomplete].sort((a, b) => {
        const stopOrderA = Number(a?.stop_order);
        const stopOrderB = Number(b?.stop_order);
        const hasAOrder = Number.isFinite(stopOrderA) && stopOrderA > 0;
        const hasBOrder = Number.isFinite(stopOrderB) && stopOrderB > 0;
        if (hasAOrder && hasBOrder && stopOrderA !== stopOrderB) return stopOrderA - stopOrderB;
        if (hasAOrder && !hasBOrder) return -1;
        if (!hasAOrder && hasBOrder) return 1;
        const etaA = a?.delivery_time_eta || a?.delivery_time_start || '';
        const etaB = b?.delivery_time_eta || b?.delivery_time_start || '';
        return etaA.localeCompare(etaB);
      });
      const nextStop = orderedIncompleteStops.find((s) => s.isNextDelivery === true) || orderedIncompleteStops[0];
      if (!lastCompleted || !nextStop) return;

      const originLat = Number(lastCompleted.latitude);
      const originLon = Number(lastCompleted.longitude);

      const originPoint = { latitude: Number(originLat), longitude: Number(originLon) };
      const destinationPoint = { latitude: Number(nextStop.latitude), longitude: Number(nextStop.longitude) };
      const driverMode = getDriverMode(driverId);
      const key = getHereCacheKey(originPoint, destinationPoint, driverMode);
      if (cache[key]) {
        lastHydratedSegmentKeysRef.current[driverId] = key;
        return;
      }
      if (lastHydratedSegmentKeysRef.current[driverId] === key) return;
      lastHydratedSegmentKeysRef.current[driverId] = key;
      hydrateFromOffline(key, driverId, originPoint, destinationPoint, lastCompleted.delivery_date);
    });
  }, [isViewingCurrentDate, driverStops, refreshToken]);

  // Hydrate last-completed -> home from offline DB ONLY (no backend calls)
  useEffect(() => {
     if ((Date.now() - mountTimeRef.current < 1200)) return;
     driversWithCompleteRoute.forEach((driverId) => {
      const all = driverStops.get(driverId) || { complete: [] };
      const completedSorted = [...(all.complete || [])].sort((a, b) => {
        const at = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : (a.updated_date ? new Date(a.updated_date).getTime() : 0);
        const bt = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : (b.updated_date ? new Date(b.updated_date).getTime() : 0);
        return bt - at;
      });
      const lastCompleted = completedSorted[0];
      const home = driverHomeMarkers.find((h) => h.driverId === driverId);
      if (!lastCompleted || !home) return;
      const key = getHereCacheKey(lastCompleted, home, getDriverMode(driverId));
      if (cache[key]) {
        lastHydratedSegmentKeysRef.current[driverId] = key;
        return;
      }
      if (lastHydratedSegmentKeysRef.current[driverId] === key) return;
      lastHydratedSegmentKeysRef.current[driverId] = key;
      hydrateFromOffline(key, driverId, { latitude: Number(lastCompleted.latitude), longitude: Number(lastCompleted.longitude) }, { latitude: Number(home.latitude), longitude: Number(home.longitude) }, lastCompleted.delivery_date);
    });
  }, [isViewingCurrentDate, driversWithCompleteRoute, driverStops, driverHomeMarkers, refreshToken]);

  // Hydrate home -> first stop from offline DB ONLY (no backend calls)
  useEffect(() => {
    if (optimizing || (Date.now() - mountTimeRef.current < 1200)) return;
    driverStops.forEach((stops, driverId) => {
      const hasCompleted = (stops?.complete?.length || 0) > 0;
      const hasIncomplete = ((stops?.incomplete?.length || 0) > 0);
      if (hasCompleted || !hasIncomplete) return;
      const next = stops.incomplete.find((s) => s.isNextDelivery === true) || stops.incomplete[0];

      const home = driverHomeMarkers.find((h) => h && h.driverId === driverId);
      const originLat = home && !Number.isNaN(Number(home.latitude)) ? Number(home.latitude) : undefined;
      const originLon = home && !Number.isNaN(Number(home.longitude)) ? Number(home.longitude) : undefined;

      if (!next || originLat === undefined || originLon === undefined) return;

      const key = getHereCacheKey({ latitude: originLat, longitude: originLon }, next, getDriverMode(driverId));
      if (cache[key]) {
        lastHydratedSegmentKeysRef.current[driverId] = key;
        return;
      }
      if (lastHydratedSegmentKeysRef.current[driverId] === key) return;
      lastHydratedSegmentKeysRef.current[driverId] = key;
      hydrateFromOffline(key, driverId, { latitude: originLat, longitude: originLon }, next, next.delivery_date);
    });
  }, [isViewingCurrentDate, driverStops, driverHomeMarkers, optimizing, refreshToken]);

  useEffect(() => {
    const settings = getRouteOptimizationSettings();
    if (!isViewingCurrentDate || optimizing) {
      setDeviationSegments({});
      deviationMetaRef.current = {};
      return;
    }

    const thresholdMeters = settings.enableRouteDeviationDetection
      ? Math.max(50, Number(settings.routeDeviationThresholdMeters) || 200)
      : 250;
    const cooldownMs = (settings.enableRouteDeviationDetection
      ? Math.max(1, Number(settings.routeDeviationCooldownMinutes) || 5)
      : 2) * 60 * 1000;
    let cancelled = false;

    const run = async () => {
      const nextDeviationSegments = {};
      const activeSegmentIds = new Set();
      const jobs = [];

      driverStops.forEach((stops, driverId) => {
        if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
        if (stops.incomplete.length === 0 || stops.complete.length === 0) return;

        const completedSorted = [...stops.complete].sort((a, b) => {
            const at = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : (a.updated_date ? new Date(a.updated_date).getTime() : 0);
            const bt = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : (b.updated_date ? new Date(b.updated_date).getTime() : 0);
            return at - bt;
          });
          const lastCompleted = completedSorted[completedSorted.length - 1];
        const nextStop = stops.incomplete.find((stop) => stop.isNextDelivery === true) || stops.incomplete[0];
        const liveMarker = getLiveDriverMarker(driverId, currentDriverMarker, driverLocations);
        if (!lastCompleted || !nextStop || !liveMarker) return;

        const origin = { latitude: Number(lastCompleted.latitude), longitude: Number(lastCompleted.longitude) };
        const destination = { latitude: Number(nextStop.latitude), longitude: Number(nextStop.longitude) };
        const current = { latitude: Number(liveMarker.latitude), longitude: Number(liveMarker.longitude) };
        if (![origin.latitude, origin.longitude, destination.latitude, destination.longitude, current.latitude, current.longitude].every(Number.isFinite)) return;

        const segmentId = getSegmentKey(driverId, origin, destination);
        const plannedKey = getHereCacheKey(origin, destination);
        const plannedCoords = getCachedPolyline(plannedKey, cache);
        if (!segmentId || !plannedCoords) return;

        activeSegmentIds.add(segmentId);
        const deviationDistance = pointToPolylineDistanceMeters({ lat: current.latitude, lng: current.longitude }, plannedCoords);
        const existing = deviationMetaRef.current[segmentId];

        if (Number.isFinite(deviationDistance) && deviationDistance <= thresholdMeters * 0.6) {
          delete deviationMetaRef.current[segmentId];
          return;
        }

        if (!Number.isFinite(deviationDistance) || deviationDistance < thresholdMeters) {
          if (existing) nextDeviationSegments[segmentId] = existing;
          return;
        }

        if (existing?.remainingCoords && existing?.remainingPoint && (Date.now() - (existing.lastFetchedAt || 0) < cooldownMs)) {
          nextDeviationSegments[segmentId] = {
            ...existing,
            breadcrumbCoords: buildBreadcrumbLine(nextStop.delivery_route_breadcrumbs, origin, current),
            currentPoint: current,
            deviationDistance
          };
          return;
        }

        jobs.push(
          (async () => {
            try {
              const remainingKey = getHereCacheKey(current, destination, getDriverMode(driverId));
              let remainingCoords = getCachedPolyline(remainingKey, cache);
              if (!remainingCoords) {
                remainingCoords = await hydrateFromOffline(remainingKey, driverId, current, destination, nextStop.delivery_date)
                  .then((hydrated) => hydrated ? getCachedPolyline(remainingKey, cache) : null);
              }
              if (cancelled) return;
              if (!remainingCoords || remainingCoords.length <= 1) {
                return;
              }
              nextDeviationSegments[segmentId] = {
                segmentId,
                driverId,
                origin,
                destination,
                currentPoint: current,
                breadcrumbCoords: buildBreadcrumbLine(nextStop.delivery_route_breadcrumbs, origin, current),
                remainingCoords: Array.isArray(remainingCoords) && remainingCoords.length > 1 ? remainingCoords : makeFallback(current, destination),
                remainingPoint: current,
                deviationDistance,
                lastFetchedAt: Date.now()
              };
            } catch (_) {
              if (cancelled) return;
            }
          })()
        );
      });

      await Promise.all(jobs);
      if (cancelled) return;

      deviationMetaRef.current = Object.fromEntries(
        Object.entries({ ...deviationMetaRef.current, ...nextDeviationSegments }).filter(([segmentId]) => activeSegmentIds.has(segmentId))
      );
      setDeviationSegments(nextDeviationSegments);
    };

    run();
    return () => { cancelled = true; };
  }, [isViewingCurrentDate, optimizing, driverStops, currentDriverMarker, driverLocations, selectedDriverId, showAll, cache, refreshToken]);

  /* always render polylines on any date; previously gated by current date */

  const isGrace = Date.now() - mountTimeRef.current < 600;
  const lines = [];
  const getType1PolylineColor = () => '#2563EB';
  const getDriverMode = (driverId) => normalizeTravelMode(localDriverTravelModes[driverId] ?? driverTravelModes[driverId]);
  const isCurrentLeg = (stop) => stop?.isNextDelivery === true;
  const getDriverRouteStyle = (driverId, opacityOverride) => {
    const mode = getDriverMode(driverId);
    const base = getTravelModeLineStyle(mode, getType1PolylineColor(driverId));
    return {
      ...base,
      color: getType1PolylineColor(),
      opacity: opacityOverride ?? 0.95,
      lineJoin: 'round',
      lineCap: 'round'
    };
  };
  const seenKeys = new Set();

  // Pre-route: home -> first stop (visibility follows home marker visibility)
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
    const hasCompleted = (stops?.complete?.length || 0) > 0;
    const hasIncomplete = (stops?.incomplete?.length || 0) > 0;
    const homeVisible = driverHomeMarkers.some((h) => h && h.driverId === driverId);
    
    if (!homeVisible) return;
    if (!hasCompleted && hasIncomplete) {
      const next = stops.incomplete.find((s) => isCurrentLeg(s));
      
      const home = driverHomeMarkers.find((h) => h && h.driverId === driverId);
      const originLat = home && !Number.isNaN(Number(home.latitude)) ? Number(home.latitude) : undefined;
      const originLon = home && !Number.isNaN(Number(home.longitude)) ? Number(home.longitude) : undefined;

      if (next && originLat !== undefined && originLon !== undefined) {
        const key = getHereCacheKey({ latitude: originLat, longitude: originLon }, next, getDriverMode(driverId));
        let coords = getCachedPolyline(key, cache);
        if (!coords) {
          try {
            const cached = localStorage.getItem(key);
            if (cached) {
              const c = JSON.parse(cached);
              if (Array.isArray(c) && c.length > 1) coords = c;
            }
          } catch (_) {}
        }
        
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          const segmentPositions = coords || makeFallback({ latitude: originLat, longitude: originLon }, next);
          lines.push(
            <Polyline
              key={`type1-pre-home-line-${driverId}-${getDriverMode(driverId)}`}
              positions={segmentPositions}
              pathOptions={{
                ...getDriverRouteStyle(driverId, coords ? 0.95 : 0.75),
                dashArray: coords ? getDriverRouteStyle(driverId).dashArray : '8,8'
              }}
              pane="routeBasePane"
            />,
            <RouteDirectionDecorator key={`type1-pre-home-arrow-${driverId}-${getDriverMode(driverId)}`} positions={segmentPositions} color={getType1PolylineColor()} />
          );
        }
      }
    }
  });

  // Render only the current leg in blue for in-progress routes
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;

    const currentStop = [...stops.incomplete]
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0))
      .find((stop) => stop?.isNextDelivery === true);

    if (!currentStop) return;

    const currentStopOrder = Number(currentStop?.stop_order || 0);
    const lastFinishedStop = [...stops.complete]
      .filter((stop) => Number(stop?.stop_order || 0) < currentStopOrder)
      .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0];

    const origin = lastFinishedStop
      ? { latitude: Number(lastFinishedStop.latitude), longitude: Number(lastFinishedStop.longitude) }
      : { latitude: Number(currentStop?.segment_origin_lat), longitude: Number(currentStop?.segment_origin_lon) };

    const destination = { latitude: Number(currentStop?.segment_dest_lat), longitude: Number(currentStop?.segment_dest_lon) };
    const key = getHereCacheKey(origin, destination, currentStop?.transport_mode || getDriverMode(driverId));

    let coords = getCachedPolyline(key, cache);
    if (!coords && typeof currentStop?.encoded_polyline === 'string' && currentStop.encoded_polyline.trim()) {
      try {
        coords = decodePolyline(currentStop.encoded_polyline);
        if (Array.isArray(coords) && coords.length > 1) {
          setCache((prev) => ({ ...prev, [key]: coords }));
          try { localStorage.setItem(key, JSON.stringify(coords)); } catch (_) {}
        }
      } catch (_) {}
    }

    if ((!coords || coords.length < 2) && origin.latitude === Number(currentStop?.segment_origin_lat) && origin.longitude === Number(currentStop?.segment_origin_lon) && typeof currentStop?.encoded_polyline === 'string' && currentStop.encoded_polyline.trim()) {
      try {
        coords = decodePolyline(currentStop.encoded_polyline);
      } catch (_) {}
    }

    if (!coords || coords.length < 2 || seenKeys.has(key)) return;
    seenKeys.add(key);

    lines.push(
      <Polyline
        key={`type1-active-line-${driverId}-${currentStop.id}`}
        positions={coords}
        pathOptions={getDriverRouteStyle(driverId, 0.95)}
        pane="routeBasePane"
      />,
      <RouteDirectionDecorator
        key={`type1-active-arrow-${driverId}-${currentStop.id}`}
        positions={coords}
        color={getType1PolylineColor()}
      />
    );
  });

  // Completed-route return-home leg stays hidden from current type 1 view

  // Preserve last non-empty set only in multi-driver showAll mode to prevent ghost lines on driver switch
  useEffect(() => {
    if (lines.length && showAll) setLastNonEmptyLines(lines);
    if (!showAll) setLastNonEmptyLines([]);
  }, [lines.length, showAll, refreshToken, deliveryMarkers.length, pickupMarkers.length]);

  // Safety: dedupe by key at the very end to ensure no accidental duplicates sneak in
  const uniqueLines = React.useMemo(() => {
    const used = new Set();
    return lines.filter((child) => {
      const k = child?.key;
      if (!k) return true;
      if (used.has(k)) return false;
      used.add(k);
      return true;
    });
  }, [lines]);


  return isGrace ? null : (uniqueLines.length ? <>{uniqueLines}</> : null);
}