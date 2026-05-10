import React, { useEffect, useMemo, useState } from "react";
import { Polyline } from "react-leaflet";
import { getTravelModeLineStyle, normalizeTravelMode } from "./travelModeHelpers";
import RouteDirectionDecorator from "./RouteDirectionDecorator";

const FINISHED = ["completed", "failed", "cancelled"];

// Helper: create a visible fallback line even when two consecutive stops share the same coordinates
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
    // Tiny jitter so a zero-length segment is still visible on the map
    return [A, [A[0] + 0.0003, A[1] + 0.0003]];
  }
  return [A, B];
};

export default function HereType2Polylines({
  isViewingCurrentDate,
  deliveryMarkers = [],
  pickupMarkers = [],
  driverRoutes = [],
  multiDriverMode = false,
  selectedDriverId = null,
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

    // Use the same color palette and hash as Type1 for consistency
    const TYPE2_COLORS = [
      '#E11D48', '#16A34A', '#EA580C', '#7C3AED', '#0F766E',
      '#DB2777', '#65A30D', '#9333EA', '#B45309', '#DC2626',
      '#059669', '#C2410C', '#6D28D9', '#047857', '#BE123C',
    ];
    const getType2PolylineColor = (driverId) => {
      if (!driverId) return TYPE2_COLORS[0];
      let hash = 0;
      const str = String(driverId);
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash = hash | 0;
      }
      return TYPE2_COLORS[Math.abs(hash) % TYPE2_COLORS.length];
    };
    const getDriverMode = (driverId) => normalizeTravelMode(localDriverTravelModes[driverId] ?? driverTravelModes[driverId]);
    const getDriverRouteStyle = (driverId, opacityOverride) => {
      const mode = getDriverMode(driverId);
      const isCycling = mode === 'cycling';
      const base = getTravelModeLineStyle(mode, getType2PolylineColor(driverId));
      return {
        ...base,
        color: isCycling ? '#16A34A' : base.color,
        opacity: opacityOverride ?? base.opacity,
        lineJoin: 'round',
        lineCap: 'round'
      };
    };

  // Build per-driver incomplete stop sequences starting from next stop
  const driverIncomplete = useMemo(() => {
    const map = new Map();
    const all = [...pickupMarkers, ...deliveryMarkers]
      .filter((s) => s && !Number.isNaN(Number(s.latitude)) && !Number.isNaN(Number(s.longitude)))
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    const scopedStops = (!multiDriverMode && selectedDriverId && selectedDriverId !== 'all')
      ? all.filter(s => s.driver_id === selectedDriverId)
      : all;

    const grouped = new Map();
    scopedStops.forEach((s) => {
      if (!grouped.has(s.driver_id)) grouped.set(s.driver_id, []);
      grouped.get(s.driver_id).push(s);
    });

    grouped.forEach((stops, driverId) => {
      const incomplete = stops.filter((s) => s.status === "in_transit" || s.status === "en_route");
      if (incomplete.length === 0) return;
      incomplete.sort((a, b) => {
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
      
      // Use all incomplete stops to draw the full remaining route
      map.set(driverId, incomplete);
    });

    return map;
  }, [deliveryMarkers, pickupMarkers, multiDriverMode, selectedDriverId]);

  useEffect(() => {
    const refreshAll = () => setRefreshToken((t) => t + 1);

    const onDriverTravelModeChanged = (event) => {
      const driverId = event?.detail?.driverId;
      const travelMode = event?.detail?.travelMode;
      if (!driverId || !travelMode) return;
      setLocalDriverTravelModes((prev) => ({ ...prev, [driverId]: travelMode }));
      refreshAll();
    };

    window.addEventListener('routeReordered', refreshAll);
    window.addEventListener('routeOptimizationComplete', refreshAll);
    window.addEventListener('deliveriesUpdated', refreshAll);
    window.addEventListener('deliveriesImported', refreshAll);
    window.addEventListener('driverTravelModeChanged', onDriverTravelModeChanged);
    window.addEventListener('polylineUpdated', refreshAll);
    window.addEventListener('polylineCacheCleared', refreshAll);
    window.addEventListener('deliveryStarted', refreshAll);
    window.addEventListener('deliveryCompleted', refreshAll);
    window.addEventListener('deliveryFailed', refreshAll);
    window.addEventListener('deliveryAction', refreshAll);

    return () => {
      window.removeEventListener('routeReordered', refreshAll);
      window.removeEventListener('routeOptimizationComplete', refreshAll);
      window.removeEventListener('deliveriesUpdated', refreshAll);
      window.removeEventListener('deliveriesImported', refreshAll);
      window.removeEventListener('driverTravelModeChanged', onDriverTravelModeChanged);
      window.removeEventListener('polylineUpdated', refreshAll);
      window.removeEventListener('polylineCacheCleared', refreshAll);
      window.removeEventListener('deliveryStarted', refreshAll);
      window.removeEventListener('deliveryCompleted', refreshAll);
      window.removeEventListener('deliveryFailed', refreshAll);
      window.removeEventListener('deliveryAction', refreshAll);
    };
  }, []);



  /* always render polylines on any date; previously gated by current date */

  const lines = [];

  // Safety: if HERE/entity/offline caches miss, still render dashed straight segments
  // NOTE: Type1 already draws the first active leg (current position → stops[0]) in blue.
  // Type2 draws the remaining legs starting from stops[1] → stops[2], etc.
  driverIncomplete.forEach((stops, driverId) => {
    const totalLegs = Math.max(0, stops.length - 1);
    for (let i = 1; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const coords = typeof b?.encoded_polyline === 'string' && b.encoded_polyline.trim()
        ? decodePolyline(b.encoded_polyline)
        : null;
      const segmentPositions = Array.isArray(coords) && coords.length > 1 ? coords : makeFallback(a, b);
      lines.push(
        <Polyline
          key={`type2-line-${driverId}-${i}-${getDriverMode(driverId)}`}
          positions={segmentPositions}
          pathOptions={{
            ...getDriverRouteStyle(driverId, coords ? (() => {
              if (totalLegs <= 1) return 0.85;
              const t = (i - 1) / Math.max(1, totalLegs - 2);
              const start = 0.85, end = 0.25;
              return Math.max(end, start + (end - start) * t);
            })() : 0.35),
            dashArray: coords ? getDriverRouteStyle(driverId).dashArray : '6,6'
          }}
          pane="routeBasePane"
        />,
        <RouteDirectionDecorator key={`type2-arrow-${driverId}-${i}-${getDriverMode(driverId)}`} positions={segmentPositions} color={getDriverRouteStyle(driverId).color} />
      );
    }
  });


  return lines.length ? <>{lines}</> : null;
}