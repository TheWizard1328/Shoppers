import React, { useEffect, useMemo, useState, useRef } from "react";
import { Polyline } from "react-leaflet";
import { getHerePolyline, ensurePolylineSubscription } from "../utils/hereRouting";
import useDriverRoutePolylineBackgroundSync from "../utils/useDriverRoutePolylineBackgroundSync";
import { getRouteOptimizationSettings } from "./RouteOptimizationSettings";
import { generateDriverColor } from "../utils/colorGenerator";
import { getTravelModeLineStyle, normalizeTravelMode } from "./travelModeHelpers";

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

const getHereCacheKey = (from, to) => {
  if (!from || !to) return null;
  return `here_${Number(from.latitude).toFixed(5)}_${Number(from.longitude).toFixed(5)}_${Number(to.latitude).toFixed(5)}_${Number(to.longitude).toFixed(5)}`;
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
  const [deviationSegments, setDeviationSegments] = useState({});
  const deviationMetaRef = useRef({});

  // Ensure DriverRoutePolyline subscription is active to hydrate offline DB immediately
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
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' });
      const parts = formatter.formatToParts(new Date());
      const todayStr = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
      const rows = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', date || todayStr);
      console.log(`[Type1] Hydrating from offline DB for ${driverId} on ${date || todayStr}: found ${rows?.length || 0} polylines`);
      const fLat = round5(from.latitude), fLon = round5(from.longitude);
      const tLat = round5(to.latitude), tLon = round5(to.longitude);
      const match = rows.find(r => r.driver_id === driverId && round5(r.segment_origin_lat) === fLat && round5(r.segment_origin_lon) === fLon && round5(r.segment_dest_lat) === tLat && round5(r.segment_dest_lon) === tLon && r.encoded_polyline);
      if (match) {
        console.log(`[Type1] Found matching polyline in offline DB for segment ${from.latitude},${from.longitude} -> ${to.latitude},${to.longitude}`);
        const coords = decodePolyline(match.encoded_polyline);
        if (Array.isArray(coords) && coords.length > 1) {
          setCache((p) => ({ ...p, [key]: coords }));
          try { localStorage.setItem(key, JSON.stringify(coords)); } catch (_) {}
          return true;
        }
      } else {
        console.log(`[Type1] No matching polyline found in offline DB for segment ${from.latitude},${from.longitude} -> ${to.latitude},${to.longitude}`);
      }
    } catch (err) {
      console.error(`[Type1] Error hydrating from offline DB:`, err);
    }
    return false;
  };
  const [optimizing, setOptimizing] = useState(false);
  const [lastNonEmptyLines, setLastNonEmptyLines] = useState([]);
  useEffect(() => {
    setLastNonEmptyLines([]);
    setDeviationSegments({});
    deviationMetaRef.current = {};
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

  const polylineSyncTargets = useMemo(() => {
    const targets = [];
    driverStops.forEach((stops, driverId) => {
      const dateSet = new Set();
      [...(stops.complete || []), ...(stops.incomplete || []), ...(stops.pending || [])].forEach((stop) => {
        if (stop?.delivery_date) dateSet.add(stop.delivery_date);
      });
      dateSet.forEach((deliveryDate) => targets.push({ driverId, deliveryDate }));
    });
    return targets;
  }, [driverStops]);

  useDriverRoutePolylineBackgroundSync({
    targets: polylineSyncTargets,
    enabled: polylineSyncTargets.length > 0,
    intervalMs: 30000,
    onSync: () => setRefreshToken((token) => token + 1)
  });

  // Listen for route reorder/optimization events to refresh polylines
  useEffect(() => {
    const invalidate = () => { setRefreshToken((t) => t + 1); };
    const onReorder = invalidate;
    const onOptimizationStarted = () => { setOptimizing(true); };
    const onOptimizationComplete = () => { setOptimizing(false); invalidate(); };
    const onPolyline = (e) => {
      const key = e?.detail?.key;
      if (!key) return;
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
    window.addEventListener('polylineUpdated', onPolyline);
    window.addEventListener('routeOptimizationComplete', onOptimizationComplete);
    window.addEventListener('routeOptimizationStarted', onOptimizationStarted);
    window.addEventListener('polylineCacheCleared', onPolylineCacheCleared);
    window.addEventListener('deliveryCompleted', onDeliveryCompleted);
    window.addEventListener('deliveryFailed', onDeliveryFailed);
    return () => {
      window.removeEventListener('routeReordered', onReorder);
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
      const nextStop = stops.incomplete.find((s) => s.isNextDelivery === true) || stops.incomplete[0];
      if (!lastCompleted || !nextStop) return;

      const originLat = Number(lastCompleted.latitude);
      const originLon = Number(lastCompleted.longitude);

      const key = `here_${Number(originLat).toFixed(5)}_${Number(originLon).toFixed(5)}_${Number(nextStop.latitude).toFixed(5)}_${Number(nextStop.longitude).toFixed(5)}`;
      if (cache[key]) return;
      // ONLY hydrate from offline DB - no backend calls
      hydrateFromOffline(key, driverId, { latitude: Number(originLat), longitude: Number(originLon) }, { latitude: Number(nextStop.latitude), longitude: Number(nextStop.longitude) }, lastCompleted.delivery_date);
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
      const key = `here_${Number(lastCompleted.latitude).toFixed(5)}_${Number(lastCompleted.longitude).toFixed(5)}_${Number(home.latitude).toFixed(5)}_${Number(home.longitude).toFixed(5)}`;
      if (cache[key]) return;
      // ONLY hydrate from offline DB - no backend calls
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

      const key = `here_${originLat.toFixed(5)}_${originLon.toFixed(5)}_${next.latitude.toFixed(5)}_${next.longitude.toFixed(5)}`;
      if (cache[key]) return;
      // ONLY hydrate from offline DB - no backend calls
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
              const remainingKey = getHereCacheKey(current, destination);
              let remainingCoords = getCachedPolyline(remainingKey, cache);
              if (!remainingCoords) {
                remainingCoords = await hydrateFromOffline(remainingKey, driverId, current, destination, nextStop.delivery_date)
                  .then((hydrated) => hydrated ? getCachedPolyline(remainingKey, cache) : null);
              }
              if (!remainingCoords) {
                remainingCoords = await getHerePolyline(driverId, current, destination, nextStop.delivery_date);
              }
              if (cancelled) return;
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
              nextDeviationSegments[segmentId] = {
                segmentId,
                driverId,
                origin,
                destination,
                currentPoint: current,
                breadcrumbCoords: buildBreadcrumbLine(nextStop.delivery_route_breadcrumbs, origin, current),
                remainingCoords: makeFallback(current, destination),
                remainingPoint: current,
                deviationDistance,
                lastFetchedAt: Date.now()
              };
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
  const getDriverPolylineColor = (driverId) => generateDriverColor(String(driverId || 'driver'));
  const getType1PolylineColor = (driverId) => {
    const baseColor = getDriverPolylineColor(driverId);
    return `${baseColor}80`;
  };
  const getDriverRouteStyle = (driverId, opacityOverride) => {
    const mode = normalizeTravelMode(driverTravelModes[driverId]);
    const base = getTravelModeLineStyle(mode, getType1PolylineColor(driverId));
    return {
      ...base,
      opacity: opacityOverride ?? base.opacity,
      lineJoin: 'round',
      lineCap: 'round'
    };
  };
  const seenKeys = new Set();

  // Pre-route: home -> first stop (only when NO completed stops yet)
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
    const hasCompleted = (stops?.complete?.length || 0) > 0;
    const hasIncomplete = (stops?.incomplete?.length || 0) > 0;
    
    // Only show home->first when there are NO completed stops yet
    if (!hasCompleted && hasIncomplete) {
      const next = stops.incomplete.find((s) => s.isNextDelivery === true) || stops.incomplete[0];
      
      const home = driverHomeMarkers.find((h) => h && h.driverId === driverId);
      const originLat = home && !Number.isNaN(Number(home.latitude)) ? Number(home.latitude) : undefined;
      const originLon = home && !Number.isNaN(Number(home.longitude)) ? Number(home.longitude) : undefined;

      if (next && originLat !== undefined && originLon !== undefined) {
        const key = `here_${Number(originLat).toFixed(5)}_${Number(originLon).toFixed(5)}_${Number(next.latitude).toFixed(5)}_${Number(next.longitude).toFixed(5)}`;
        let coords = cache[key];
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
          lines.push(
            <Polyline
              key={`type1-pre-home-${driverId}`}
              positions={coords || makeFallback({ latitude: originLat, longitude: originLon }, next)}
              pathOptions={{
                ...getDriverRouteStyle(driverId, coords ? 0.95 : 0.75),
                dashArray: coords ? getDriverRouteStyle(driverId).dashArray : '8,8'
              }}
              pane="routeBasePane"
            />
          );
        }
      }
    }
  });

  // Render last-completed -> next-stop using HERE, or hybrid breadcrumb + remaining leg when deviated
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
    if (stops.incomplete.length === 0 || stops.complete.length === 0) return;
    
    // CRITICAL: Match backend logic - find next stop first, then find last completed by stop_order
    const nextStop = stops.incomplete.find((s) => s.isNextDelivery === true) || stops.incomplete[0];
    if (!nextStop) return;
    
    const nextStopOrder = Number(nextStop.stop_order || 0);
    // Find completed stops with stop_order < nextStopOrder, then take the highest one
    const completedBeforeNext = stops.complete.filter((s) => Number(s?.stop_order || 0) < nextStopOrder);
    const lastCompleted = completedBeforeNext.sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0];
    
    if (!lastCompleted) return;

    const origin = { latitude: Number(lastCompleted.latitude), longitude: Number(lastCompleted.longitude) };
    const destination = { latitude: Number(nextStop.latitude), longitude: Number(nextStop.longitude) };
    const key = getHereCacheKey(origin, destination);
    const segmentId = getSegmentKey(driverId, origin, destination);
    const hybrid = segmentId ? deviationSegments[segmentId] : null;


    if (hybrid?.remainingCoords?.length > 1 && !seenKeys.has(`${key}_deviation_remaining`)) {
      seenKeys.add(`${key}_deviation_remaining`);
      lines.push(
        <Polyline
          key={`type1-next-remaining-${driverId}`}
          positions={hybrid.remainingCoords}
          pathOptions={getDriverRouteStyle(driverId, 0.95)}
          pane="routeBasePane"
        />
      );
      return;
    }

    let coords = getCachedPolyline(key, cache);

    if (!coords && !optimizing) {
      if (Date.now() - mountTimeRef.current < 1200) return;
      const lastReq = requestTimesRef.current[key] || 0;
      const now = Date.now();
      if (now - lastReq > 4000) {
        requestTimesRef.current[key] = now;
        getHerePolyline(driverId, origin, destination, nextStop.delivery_date).then((fetched) => {
          if (Array.isArray(fetched) && fetched.length > 1) {
            setCache((p) => ({ ...p, [key]: fetched }));
          }
        }).catch(() => {});
      }
    }

    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      lines.push(
        <Polyline
          key={`type1-next-${driverId}`}
          positions={coords || makeFallback(origin, destination)}
          pathOptions={{
            ...getDriverRouteStyle(driverId, coords ? 0.9 : 0.7),
            dashArray: coords ? getDriverRouteStyle(driverId).dashArray : '8,8'
          }}
          pane="routeBasePane"
        />
      );
    }
  });

  // Render last-completed -> home for completed routes
  driversWithCompleteRoute.forEach((driverId) => {
    const all = driverStops.get(driverId) || { complete: [] };
    const lastCompleted = [...(all.complete || [])]
      .filter((s) => s.actual_delivery_time)
      .sort((a, b) => new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time))[all.complete.length - 1];
    const home = driverHomeMarkers.find((h) => h.driverId === driverId);
    if (!lastCompleted || !home) return;
    const key = `here_${Number(lastCompleted.latitude).toFixed(5)}_${Number(lastCompleted.longitude).toFixed(5)}_${Number(home.latitude).toFixed(5)}_${Number(home.longitude).toFixed(5)}`;
    let coords = cache[key];
    if (!coords) {
      try {
        const cached = localStorage.getItem(key);
        if (cached) {
          const c = JSON.parse(cached);
          if (Array.isArray(c) && c.length > 1) coords = c;
        }
      } catch (_) {}
    }
    // Show dashed fallback immediately; HERE polyline will hydrate when ready
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      lines.push(
        <Polyline
          key={`type1-home-${driverId}`}
          positions={coords || makeFallback(lastCompleted, home)}
          pathOptions={{
            ...getDriverRouteStyle(driverId, coords ? 0.9 : 0.7),
            dashArray: coords ? getDriverRouteStyle(driverId).dashArray : '8,8'
          }}
          pane="routeBasePane"
        />
      );
    }
  });

  // Preserve last non-empty set only in multi-driver showAll mode to prevent ghost lines on driver switch
  useEffect(() => { if (lines.length && showAll) setLastNonEmptyLines(lines); }, [lines.length, showAll, refreshToken, deliveryMarkers.length, pickupMarkers.length]);

  // Safety: dedupe by key at the very end to ensure no accidental duplicates sneak in
  const uniqueLines = React.useMemo(() => {
    const used = new Set();
    return React.Children.toArray(lines).filter((child) => {
      const k = child?.key;
      if (!k) return true;
      if (used.has(k)) return false;
      used.add(k);
      return true;
    });
  }, [lines]);


  return isGrace ? null : (uniqueLines.length ? <>{uniqueLines}</> : ((showAll && lastNonEmptyLines.length) ? <>{lastNonEmptyLines}</> : null));
}