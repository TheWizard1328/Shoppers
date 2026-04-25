import React, { useEffect, useMemo, useState, useRef } from "react";
import { Polyline } from "react-leaflet";
import { getHerePolyline } from "../utils/hereRouting";
import { generateDriverColor } from "../utils/colorGenerator";
import { getTravelModeLineStyle, normalizeTravelMode } from "./travelModeHelpers";

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
  const [cache, setCache] = useState({});
  const [refreshToken, setRefreshToken] = useState(0);
  const [optimizing, setOptimizing] = useState(false);
  const [localDriverTravelModes, setLocalDriverTravelModes] = useState({});
  const [lastNonEmptyLines, setLastNonEmptyLines] = useState([]);
  const requestTimesRef = useRef({});

  useEffect(() => {
    const handleDriverRoutePolylinesUpdated = () => {
      setRefreshToken((token) => token + 1);
    };
    window.addEventListener('driverRoutePolylinesUpdated', handleDriverRoutePolylinesUpdated);
    return () => window.removeEventListener('driverRoutePolylinesUpdated', handleDriverRoutePolylinesUpdated);
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
      const fLat = round5(from.latitude), fLon = round5(from.longitude);
      const tLat = round5(to.latitude), tLon = round5(to.longitude);
      const match = rows.find(r => r.driver_id === driverId && round5(r.segment_origin_lat) === fLat && round5(r.segment_origin_lon) === fLon && round5(r.segment_dest_lat) === tLat && round5(r.segment_dest_lon) === tLon && normalizeTravelMode(r.transport_mode) === normalizeTravelMode(getDriverMode(driverId)) && r.encoded_polyline);
      if (match) {
        const coords = decodePolyline(match.encoded_polyline);
        if (Array.isArray(coords) && coords.length > 1) {
          setCache((p) => ({ ...p, [key]: coords }));
          try { localStorage.setItem(key, JSON.stringify(coords)); } catch (_) {}
          return true;
        }
      }
    } catch (_) {}
    return false;
    };

    const getType2PolylineColor = (driverId) => {
      const driverColor = generateDriverColor(String(driverId || 'driver')).toLowerCase();
      const nonBlueFallbacks = ['#7c3aed', '#9333ea', '#a16207', '#dc2626', '#16a34a'];
      const isBlueShade = driverColor.includes('2563eb') || driverColor.includes('1e90ff') || driverColor.includes('3b82f6') || driverColor.includes('60a5fa') || driverColor.includes('0ea5e9') || driverColor.includes('06b6d4');
      if (isBlueShade) {
        const hashSeed = String(driverId || 'driver').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
        return nonBlueFallbacks[hashSeed % nonBlueFallbacks.length];
      }
      return driverColor;
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

  // Listen for route reorder events to refresh polylines
  useEffect(() => {
    const refreshAll = () => {
      // Keep existing caches to avoid flicker; just trigger re-evaluation
      setRefreshToken((t) => t + 1);
    };

    const onReorder = refreshAll;
    const onOptimizationComplete = () => { setOptimizing(false); refreshAll(); };
    const onDeliveriesUpdated = () => setRefreshToken((t)=>t+1);
    const onDeliveriesImported = refreshAll;

    const onOptimizationStarted = () => { setOptimizing(true); };

    const onDriverTravelModeChanged = (event) => {
      const driverId = event?.detail?.driverId;
      const travelMode = event?.detail?.travelMode;
      if (!driverId || !travelMode) return;
      setLocalDriverTravelModes((prev) => ({ ...prev, [driverId]: travelMode }));
      setCache({});
      setLastNonEmptyLines([]);
      setRefreshToken((t) => t + 1);
    };

    const onPolyline = (e) => {
      const key = e?.detail?.key;
      if (!key) return;
      try {
        const cached = localStorage.getItem(key);
        if (cached) {
          const coords = JSON.parse(cached);
          if (Array.isArray(coords) && coords.length > 1) {
            setCache((p) => ({ ...p, [key]: coords }));
          }
        }
      } catch (_) {}
    };
    const onDriverStatusChanged = (e) => {
      try { if (e?.detail?.newStatus === 'on_duty') setRefreshToken((t)=>t+1); } catch (_) { setRefreshToken((t)=>t+1); }
    };
    const onDeliveryStarted = () => setRefreshToken((t)=>t+1);
    const onDeliveryCompleted = () => setRefreshToken((t)=>t+1);
    const onDeliveryFailed = () => setRefreshToken((t)=>t+1);
    const onDeliveryAction = () => setRefreshToken((t)=>t+1);
    const onPolylineCacheCleared = () => {
      setCache({});
      setLastNonEmptyLines([]);
      setRefreshToken((t) => t + 1);
    };

    window.addEventListener('routeReordered', onReorder);
    window.addEventListener('driverTravelModeChanged', onDriverTravelModeChanged);
    window.addEventListener('polylineUpdated', onPolyline);
    window.addEventListener('routeOptimizationComplete', onOptimizationComplete);
    window.addEventListener('routeOptimizationStarted', onOptimizationStarted);
    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    window.addEventListener('polylineCacheCleared', onPolylineCacheCleared);
    window.addEventListener('deliveriesImported', onDeliveriesImported);
    // New triggers for HERE refresh
    window.addEventListener('driverStatusChanged', onDriverStatusChanged);
    window.addEventListener('deliveryStarted', onDeliveryStarted);
    window.addEventListener('deliveryCompleted', onDeliveryCompleted);
    window.addEventListener('deliveryFailed', onDeliveryFailed);
    window.addEventListener('deliveryAction', onDeliveryAction);

    return () => {
      window.removeEventListener('routeReordered', onReorder);
      window.removeEventListener('driverTravelModeChanged', onDriverTravelModeChanged);
      window.removeEventListener('polylineUpdated', onPolyline);
      window.removeEventListener('routeOptimizationComplete', onOptimizationComplete);
      window.removeEventListener('routeOptimizationStarted', onOptimizationStarted);
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
      window.removeEventListener('deliveriesImported', onDeliveriesImported);
      window.removeEventListener('polylineCacheCleared', onPolylineCacheCleared);
      window.removeEventListener('driverStatusChanged', onDriverStatusChanged);
      window.removeEventListener('deliveryStarted', onDeliveryStarted);
      window.removeEventListener('deliveryCompleted', onDeliveryCompleted);
      window.removeEventListener('deliveryFailed', onDeliveryFailed);
      window.removeEventListener('deliveryAction', onDeliveryAction);
    };
  }, []);

  // Prefetch HERE polylines for all segments
  useEffect(() => {
    if (optimizing) return;
    driverIncomplete.forEach((stops, driverId) => {
      if (!multiDriverMode && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
      if (!multiDriverMode && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
      const totalLegs = Math.max(0, stops.length - 1);
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        const key = `here_${getDriverMode(driverId)}_${Number(a.latitude).toFixed(5)}_${Number(a.longitude).toFixed(5)}_${Number(b.latitude).toFixed(5)}_${Number(b.longitude).toFixed(5)}`;
        if (cache[key]) continue;
        const jitter = Math.min(800, i * 75 + Math.floor(Math.random() * 120));
        (async () => {
          const ok = await hydrateFromOffline(key, driverId, { latitude: Number(a.latitude), longitude: Number(a.longitude) }, { latitude: Number(b.latitude), longitude: Number(b.longitude) }, a.delivery_date);
          if (ok) return;
          setTimeout(() => {
            getHerePolyline(driverId, { latitude: Number(a.latitude), longitude: Number(a.longitude) }, { latitude: Number(b.latitude), longitude: Number(b.longitude) }, a.delivery_date, getDriverMode(driverId)).then((coords) => {
              if (Array.isArray(coords) && coords.length > 1) setCache((p) => ({ ...p, [key]: coords }));
            });
          }, jitter);
        })();
      }
    });
  }, [isViewingCurrentDate, driverIncomplete, refreshToken]);



  /* always render polylines on any date; previously gated by current date */

  const lines = [];

  // Safety: if HERE/entity/offline caches miss, still render dashed straight segments
  driverIncomplete.forEach((stops, driverId) => {
    const totalLegs = Math.max(0, stops.length - 1);
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const key = `here_${getDriverMode(driverId)}_${Number(a.latitude).toFixed(5)}_${Number(a.longitude).toFixed(5)}_${Number(b.latitude).toFixed(5)}_${Number(b.longitude).toFixed(5)}`;
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
      lines.push(
        <Polyline
          key={`type2-here-${driverId}-${i}-${getDriverMode(driverId)}`}
          positions={coords || makeFallback(a, b)}
          pathOptions={{
            ...getDriverRouteStyle(driverId, coords ? (() => {
              if (totalLegs <= 1) return 0.85;
              const t = i / (totalLegs - 1);
              const start = 0.95, end = 0.25;
              return Math.max(end, start + (end - start) * t);
            })() : 0.35),
            dashArray: coords ? getDriverRouteStyle(driverId).dashArray : '6,6'
          }}
          pane="routeBasePane"
        />
      );
    }
  });


  // Preserve last non-empty set only in multi-driver mode to avoid ghost lines when switching drivers
  useEffect(() => { if (lines.length && multiDriverMode) setLastNonEmptyLines(lines); }, [lines.length, multiDriverMode, refreshToken, deliveryMarkers.length, pickupMarkers.length]);
  return lines.length ? <>{lines}</> : (lastNonEmptyLines.length ? <>{lastNonEmptyLines}</> : null);
}