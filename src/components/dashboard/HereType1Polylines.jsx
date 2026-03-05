import React, { useEffect, useMemo, useState, useRef } from "react";
import { Polyline } from "react-leaflet";
import { getHerePolyline } from "../utils/hereRouting";

const FINISHED = ["completed", "failed", "cancelled", "returned"];

export default function HereType1Polylines({
  isViewingCurrentDate,
  deliveryMarkers = [],
  pickupMarkers = [],
  driverHomeMarkers = [],
}) {
  const [cache, setCache] = useState({});
  const [refreshToken, setRefreshToken] = useState(0);

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
      const rows = await offlineDB.getByIndex(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, 'delivery_date', date || new Date().toISOString().slice(0,10));
      const fLat = round5(from.latitude), fLon = round5(from.longitude);
      const tLat = round5(to.latitude), tLon = round5(to.longitude);
      const match = rows.find(r => r.driver_id === driverId && round5(r.segment_origin_lat) === fLat && round5(r.segment_origin_lon) === fLon && round5(r.segment_dest_lat) === tLat && round5(r.segment_dest_lon) === tLon && r.encoded_polyline);
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
  const [optimizing, setOptimizing] = useState(false);
  const [lastNonEmptyLines, setLastNonEmptyLines] = useState([]);
  const requestTimesRef = useRef({});

  const driverStops = useMemo(() => {
    const map = new Map();
    [...deliveryMarkers, ...pickupMarkers].forEach((m) => {
      if (!m || !m.driver_id || typeof m.latitude !== "number" || typeof m.longitude !== "number") return;
      if (!map.has(m.driver_id)) map.set(m.driver_id, { complete: [], incomplete: [] });
      if (FINISHED.includes(m.status)) map.get(m.driver_id).complete.push(m);
      else if (m.status !== "pending") map.get(m.driver_id).incomplete.push(m);
    });
    return map;
  }, [deliveryMarkers, pickupMarkers]);

  const driversWithCompleteRoute = useMemo(() => {
    const out = new Set();
    driverStops.forEach((stops, driverId) => {
      if (stops.incomplete.length === 0 && stops.complete.length > 0) out.add(driverId);
    });
    return out;
  }, [driverStops]);

  // Listen for route reorder/optimization events to refresh polylines
  useEffect(() => {
    const invalidate = () => { setRefreshToken((t) => t + 1); };
    const onReorder = invalidate;
    const onDeliveriesUpdated = invalidate;
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
    const onDriverStatusChanged = (e) => {
      try { if (e?.detail?.newStatus === 'on_duty') invalidate(); } catch (_) { invalidate(); }
    };
    const onDeliveryStarted = invalidate;
    const onDeliveryCompleted = invalidate;
    const onDeliveryFailed = invalidate;
    const onDeliveryAction = invalidate;
    window.addEventListener('routeReordered', onReorder);
    window.addEventListener('polylineUpdated', onPolyline);
    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    window.addEventListener('routeOptimizationComplete', onOptimizationComplete);
    window.addEventListener('routeOptimizationStarted', onOptimizationStarted);
    // New triggers for HERE refresh
    window.addEventListener('driverStatusChanged', onDriverStatusChanged);
    window.addEventListener('deliveryStarted', onDeliveryStarted);
    window.addEventListener('deliveryCompleted', onDeliveryCompleted);
    window.addEventListener('deliveryFailed', onDeliveryFailed);
    window.addEventListener('deliveryAction', onDeliveryAction);
    return () => {
      window.removeEventListener('routeReordered', onReorder);
      window.removeEventListener('polylineUpdated', onPolyline);
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
      window.removeEventListener('routeOptimizationComplete', onOptimizationComplete);
      window.removeEventListener('routeOptimizationStarted', onOptimizationStarted);
      window.removeEventListener('driverStatusChanged', onDriverStatusChanged);
      window.removeEventListener('deliveryStarted', onDeliveryStarted);
      window.removeEventListener('deliveryCompleted', onDeliveryCompleted);
      window.removeEventListener('deliveryFailed', onDeliveryFailed);
      window.removeEventListener('deliveryAction', onDeliveryAction);
    };
  }, []);

  // Prefetch last-completed -> next-stop
  useEffect(() => {
    if (!isViewingCurrentDate || optimizing) return;
    driverStops.forEach((stops, driverId) => {
      if (stops.incomplete.length === 0 || stops.complete.length === 0) return;
      const completedSorted = [...stops.complete].sort((a, b) => {
        const at = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : (a.updated_date ? new Date(a.updated_date).getTime() : 0);
        const bt = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : (b.updated_date ? new Date(b.updated_date).getTime() : 0);
        return bt - at;
      });
      const lastCompleted = completedSorted[0];
      const nextStop =
        stops.incomplete.find((s) => s.isNextDelivery === true) ||
        [...stops.incomplete].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
      if (!lastCompleted || !nextStop) return;
      const key = `here_${lastCompleted.latitude.toFixed(5)}_${lastCompleted.longitude.toFixed(5)}_${nextStop.latitude.toFixed(5)}_${nextStop.longitude.toFixed(5)}`;
      if (cache[key]) return;
      (async () => {
        const ok = await hydrateFromOffline(key, driverId, lastCompleted, nextStop, lastCompleted.delivery_date);
        if (ok) return;
        const d = Math.floor(Math.random() * 150);
        setTimeout(() => {
          getHerePolyline(driverId, { latitude: lastCompleted.latitude, longitude: lastCompleted.longitude }, { latitude: nextStop.latitude, longitude: nextStop.longitude }, lastCompleted.delivery_date).then((coords) => {
            if (Array.isArray(coords) && coords.length > 1) setCache((p) => ({ ...p, [key]: coords }));
          });
        }, d);
      })();
      });
  }, [isViewingCurrentDate, driverStops, refreshToken]);

  // Prefetch last-completed -> home (for completed routes)
  useEffect(() => {
    if (!isViewingCurrentDate || optimizing) return;
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
      const key = `here_${lastCompleted.latitude.toFixed(5)}_${lastCompleted.longitude.toFixed(5)}_${home.latitude.toFixed(5)}_${home.longitude.toFixed(5)}`;
      if (cache[key]) return;
      (async () => {
        const ok = await hydrateFromOffline(key, driverId, lastCompleted, home, lastCompleted.delivery_date);
        if (ok) return;
        const d2 = Math.floor(Math.random() * 150);
        setTimeout(() => {
          getHerePolyline(driverId, { latitude: lastCompleted.latitude, longitude: lastCompleted.longitude }, { latitude: home.latitude, longitude: home.longitude }, lastCompleted.delivery_date).then((coords) => {
            if (Array.isArray(coords) && coords.length > 1) setCache((p) => ({ ...p, [key]: coords }));
          });
        }, d2);
      })();
      });
  }, [isViewingCurrentDate, driversWithCompleteRoute, driverStops, driverHomeMarkers, refreshToken]);

  /* always render polylines on any date; previously gated by current date */

  const lines = [];

  // Pre-route fallback: draw home -> first stop (dashed grey) when route hasn't started yet
  driverStops.forEach((stops, driverId) => {
    const hasCompleted = (stops?.complete?.length || 0) > 0;
    const hasIncomplete = (stops?.incomplete?.length || 0) > 0;
    if (!hasCompleted && hasIncomplete) {
      const first = [...stops.incomplete].sort((a,b)=> (a.stop_order || 0) - (b.stop_order || 0))[0];
      const home = driverHomeMarkers.find((h) => h && h.driverId === driverId);
      if (
        first && home &&
        typeof first.latitude === 'number' && typeof first.longitude === 'number' &&
        typeof home.latitude === 'number' && typeof home.longitude === 'number'
      ) {
        lines.push(
          <Polyline
            key={`type1-pre-home-${driverId}`}
            positions={[[home.latitude, home.longitude], [first.latitude, first.longitude]]}
            pathOptions={{ color: '#94a3b8', weight: 5, opacity: 0.35, dashArray: '6,6', lineJoin: 'round', lineCap: 'round' }}
            pane="overlayPane"
          />
        );
      }
    }
  });

  // Render last-completed -> next-stop using HERE (fallback straight)
  driverStops.forEach((stops, driverId) => {
    if (stops.incomplete.length === 0 || stops.complete.length === 0) return;
    const completedSorted = [...stops.complete].sort((a, b) => {
      const at = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : (a.updated_date ? new Date(a.updated_date).getTime() : 0);
      const bt = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : (b.updated_date ? new Date(b.updated_date).getTime() : 0);
      return bt - at;
    });
    const lastCompleted = completedSorted[0];
    const nextStop =
      stops.incomplete.find((s) => s.isNextDelivery === true) ||
      [...stops.incomplete].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
    if (!lastCompleted || !nextStop) return;
    const key = `here_${lastCompleted.latitude.toFixed(5)}_${lastCompleted.longitude.toFixed(5)}_${nextStop.latitude.toFixed(5)}_${nextStop.longitude.toFixed(5)}`;
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
    // Grace period before dashed fallback on current date
    let allowFallback = true;
    if (!coords && isViewingCurrentDate) {
      const ts = requestTimesRef.current[key];
      if (!ts) {
        requestTimesRef.current[key] = Date.now();
        allowFallback = false;
        setTimeout(() => setRefreshToken((t) => t + 1), 900);
      } else if (Date.now() - ts < 900) {
        allowFallback = false;
      }
    }
    if (!coords && !allowFallback) {
      return;
    }
    lines.push(
      <Polyline
        key={`type1-next-${driverId}`}
        positions={coords || [
          [lastCompleted.latitude, lastCompleted.longitude],
          [nextStop.latitude, nextStop.longitude],
        ]}
        pathOptions={{ color: coords ? "#2563eb" : "#94a3b8", weight: 5, opacity: coords ? 0.9 : 0.35, dashArray: coords ? "" : "6,6", lineJoin: "round", lineCap: "round" }}
        pane="overlayPane"
      />
    );
  });

  // Render last-completed -> home for completed routes
  driversWithCompleteRoute.forEach((driverId) => {
    const all = driverStops.get(driverId) || { complete: [] };
    const lastCompleted = [...(all.complete || [])]
      .filter((s) => s.actual_delivery_time)
      .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time))[0];
    const home = driverHomeMarkers.find((h) => h.driverId === driverId);
    if (!lastCompleted || !home) return;
    const key = `here_${lastCompleted.latitude.toFixed(5)}_${lastCompleted.longitude.toFixed(5)}_${home.latitude.toFixed(5)}_${home.longitude.toFixed(5)}`;
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
    // Grace period before dashed fallback on current date
    let allowFallbackHome = true;
    if (!coords && isViewingCurrentDate) {
      const ts = requestTimesRef.current[key];
      if (!ts) {
        requestTimesRef.current[key] = Date.now();
        allowFallbackHome = false;
        setTimeout(() => setRefreshToken((t) => t + 1), 900);
      } else if (Date.now() - ts < 900) {
        allowFallbackHome = false;
      }
    }
    if (!coords && !allowFallbackHome) {
      return;
    }
    lines.push(
      <Polyline
        key={`type1-home-${driverId}`}
        positions={coords || [
          [lastCompleted.latitude, lastCompleted.longitude],
          [home.latitude, home.longitude],
        ]}
        pathOptions={{ color: coords ? "#2563eb" : "#94a3b8", weight: 5, opacity: coords ? 0.9 : 0.35, dashArray: coords ? "" : "6,6", lineJoin: "round", lineCap: "round" }}
        pane="overlayPane"
      />
    );
  });

  // Preserve last non-empty set to avoid flicker during data refresh/date toggles
  useEffect(() => { if (lines.length) setLastNonEmptyLines(lines); }, [lines.length, refreshToken, deliveryMarkers.length, pickupMarkers.length]);

  return lines.length ? <>{lines}</> : (lastNonEmptyLines.length ? <>{lastNonEmptyLines}</> : null);
}