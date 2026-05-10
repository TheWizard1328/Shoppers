import React, { useEffect, useMemo, useState } from "react";
import { Polyline } from "react-leaflet";
import { getTravelModeLineStyle, normalizeTravelMode } from "./travelModeHelpers";
import RouteDirectionDecorator from "./RouteDirectionDecorator";

// High-visibility, contrasting polyline colors — no shades of blue
const POLYLINE_COLORS = [
  '#E11D48', // Rose
  '#16A34A', // Green
  '#EA580C', // Orange
  '#7C3AED', // Violet
  '#0F766E', // Teal
  '#DB2777', // Pink
  '#65A30D', // Lime
  '#9333EA', // Purple
  '#B45309', // Amber Brown
  '#DC2626', // Red
  '#059669', // Emerald
  '#C2410C', // Burnt Orange
  '#6D28D9', // Deep Violet
  '#047857', // Dark Emerald
  '#BE123C', // Crimson
];

const driverColorCache = new Map();
const getPolylineColorForDriver = (driverId) => {
  if (!driverId) return POLYLINE_COLORS[0];
  if (driverColorCache.has(driverId)) return driverColorCache.get(driverId);
  // Stable hash so same driver always gets same color
  let hash = 0;
  for (let i = 0; i < driverId.length; i++) {
    hash = ((hash << 5) - hash) + driverId.charCodeAt(i);
    hash = hash | 0;
  }
  const color = POLYLINE_COLORS[Math.abs(hash) % POLYLINE_COLORS.length];
  driverColorCache.set(driverId, color);
  return color;
};

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
  const [refreshToken, setRefreshToken] = useState(0);
  const [localDriverTravelModes, setLocalDriverTravelModes] = useState({});

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

  useEffect(() => {
    const invalidate = () => setRefreshToken((t) => t + 1);
    const onDriverTravelModeChanged = (event) => {
      const driverId = event?.detail?.driverId;
      const travelMode = event?.detail?.travelMode;
      if (!driverId || !travelMode) return;
      setLocalDriverTravelModes((prev) => ({ ...prev, [driverId]: travelMode }));
      invalidate();
    };

    window.addEventListener('routeReordered', invalidate);
    window.addEventListener('routeOptimizationComplete', invalidate);
    window.addEventListener('driverTravelModeChanged', onDriverTravelModeChanged);
    window.addEventListener('polylineUpdated', invalidate);
    window.addEventListener('polylineCacheCleared', invalidate);
    window.addEventListener('deliveryCompleted', invalidate);
    window.addEventListener('deliveryFailed', invalidate);

    return () => {
      window.removeEventListener('routeReordered', invalidate);
      window.removeEventListener('routeOptimizationComplete', invalidate);
      window.removeEventListener('driverTravelModeChanged', onDriverTravelModeChanged);
      window.removeEventListener('polylineUpdated', invalidate);
      window.removeEventListener('polylineCacheCleared', invalidate);
      window.removeEventListener('deliveryCompleted', invalidate);
      window.removeEventListener('deliveryFailed', invalidate);
    };
  }, []);

  /* always render polylines on any date; previously gated by current date */

  const lines = [];
  const getType1PolylineColor = (driverId) => getPolylineColorForDriver(driverId);
  const getDriverMode = (driverId) => normalizeTravelMode(localDriverTravelModes[driverId] ?? driverTravelModes[driverId]);
  const isCurrentLeg = (stop) => stop?.isNextDelivery === true;
  const getDriverRouteStyle = (driverId, opacityOverride) => {
    const mode = getDriverMode(driverId);
    const color = getType1PolylineColor(driverId);
    const base = getTravelModeLineStyle(mode, color);
    return {
      ...base,
      color,
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
        const coords = typeof next?.encoded_polyline === 'string' && next.encoded_polyline.trim()
          ? decodePolyline(next.encoded_polyline)
          : null;
        const key = `prehome-${driverId}-${next.id}`;

        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          const segmentPositions = Array.isArray(coords) && coords.length > 1 ? coords : makeFallback({ latitude: originLat, longitude: originLon }, next);
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
            <RouteDirectionDecorator key={`type1-pre-home-arrow-${driverId}-${getDriverMode(driverId)}`} positions={segmentPositions} color={getType1PolylineColor(driverId)} />
          );
        }
      }
    }
  });

  // Render the first active leg in blue using the stored polyline on the next stop
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;

    const currentStop = [...stops.incomplete]
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0))
      .find((stop) => stop?.isNextDelivery === true) || [...stops.incomplete]
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0))[0];

    if (!currentStop) return;

    const orderedStops = [...stops.incomplete]
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));
    const currentIndex = orderedStops.findIndex((stop) => stop?.id === currentStop?.id);
    const previousCompleted = [...stops.complete].sort((a, b) => {
      const at = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : (a.updated_date ? new Date(a.updated_date).getTime() : 0);
      const bt = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : (b.updated_date ? new Date(b.updated_date).getTime() : 0);
      return bt - at;
    })[0];
    const previousStop = currentIndex > 0 ? orderedStops[currentIndex - 1] : previousCompleted;
    const home = driverHomeMarkers.find((h) => h && h.driverId === driverId);
    const origin = previousStop
      ? { latitude: Number(previousStop.latitude), longitude: Number(previousStop.longitude) }
      : home
        ? { latitude: Number(home.latitude), longitude: Number(home.longitude) }
        : null;
    const destination = { latitude: Number(currentStop.latitude), longitude: Number(currentStop.longitude) };
    const key = `active-${driverId}-${currentStop.id}`;

    let coords = null;
    let shouldUseFallback = false;
    if (typeof currentStop?.encoded_polyline === 'string' && currentStop.encoded_polyline.trim()) {
      try {
        coords = decodePolyline(currentStop.encoded_polyline);
      } catch (_) {}
    }

    const hasStoredRoute = typeof currentStop?.encoded_polyline === 'string' && currentStop.encoded_polyline.trim().length > 0;
    const hasRouteMetrics = Number(currentStop?.estimated_distance_km || 0) > 0 || Number(currentStop?.estimated_duration_minutes || 0) > 0;

    if ((!coords || coords.length < 2) && !hasStoredRoute && !hasRouteMetrics && origin && Number.isFinite(origin.latitude) && Number.isFinite(origin.longitude) && Number.isFinite(destination.latitude) && Number.isFinite(destination.longitude)) {
      coords = makeFallback(origin, destination);
      shouldUseFallback = true;
    }

    if (!coords || coords.length < 2 || seenKeys.has(key)) return;
    seenKeys.add(key);

    lines.push(
      <Polyline
        key={`type1-active-line-${driverId}-${currentStop.id}`}
        positions={coords}
        pathOptions={{
          ...getDriverRouteStyle(driverId, shouldUseFallback ? 0.75 : 0.95),
          dashArray: shouldUseFallback ? '8,8' : getDriverRouteStyle(driverId).dashArray
        }}
        pane="routeBasePane"
      />,
      <RouteDirectionDecorator
        key={`type1-active-arrow-${driverId}-${currentStop.id}`}
        positions={coords}
        color={getType1PolylineColor(driverId)}
      />
    );
  });

  // Completed-route return-home leg stays hidden from current type 1 view

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


  return uniqueLines.length ? <>{uniqueLines}</> : null;
}