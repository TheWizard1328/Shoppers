import React, { useEffect, useMemo, useState, useRef } from "react";
import { Polyline } from "react-leaflet";
import { getHerePolyline } from "../utils/hereRouting";

const FINISHED = ["completed", "failed", "cancelled"];

export default function HereType2Polylines({
  isViewingCurrentDate,
  deliveryMarkers = [],
  pickupMarkers = [],
  driverRoutes = [],
  multiDriverMode = false,
  selectedDriverId = null,
}) {
  const [cache, setCache] = useState({});
  const [refreshToken, setRefreshToken] = useState(0);
  const [optimizing, setOptimizing] = useState(false);
  const [lastNonEmptyLines, setLastNonEmptyLines] = useState([]);
  const requestTimesRef = useRef({});

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

    // Map driverId -> color from parent-provided driverRoutes (keeps colors consistent with Type 3)
  const driverColorMap = useMemo(() => {
    const map = new Map();
    (driverRoutes || []).forEach((r) => {
      if (r && r.driverId) map.set(r.driverId, r.color || '#607D8B');
    });
    return map;
  }, [driverRoutes]);

  // Helpers to ensure non-blue colors in multi-driver mode
  const isBlueHex = (hex) => {
    if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length < 7) return false;
    const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    const d = max - min;
    if (d === 0) return false;
    let h;
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h = h * 60; // 0..360
    return h >= 180 && h <= 250; // blue-cyan range
  };
  const hashId = (s) => Array.from(String(s)).reduce((a,c)=>((a<<5)-a)+c.charCodeAt(0)|0,0);
  const mapBlueToNonBlue = (hex, id) => {
    if (!multiDriverMode) return hex;
    if (!isBlueHex(hex)) return hex;
    const palette = ['#8A2BE2', '#EC4899', '#F59E0B', '#A855F7', '#F43F5E', '#FF7F50', '#A0522D']; // no blues
    const idx = Math.abs(hashId(id || 'x')) % palette.length;
    return palette[idx];
  };

  // Build per-driver incomplete stop sequences starting from next stop
  const driverIncomplete = useMemo(() => {
    const map = new Map();
    const all = [...pickupMarkers, ...deliveryMarkers]
      .filter((s) => s && typeof s.latitude === "number" && typeof s.longitude === "number")
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
      const incomplete = stops.filter((s) => !FINISHED.includes(s.status));
      if (incomplete.length === 0) return;
      // Ensure they are sorted by stop_order so the sequence is correct
      incomplete.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      
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

    window.addEventListener('routeReordered', onReorder);
    window.addEventListener('polylineUpdated', onPolyline);
    window.addEventListener('routeOptimizationComplete', onOptimizationComplete);
    window.addEventListener('routeOptimizationStarted', onOptimizationStarted);
    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    window.addEventListener('deliveriesImported', onDeliveriesImported);
    // New triggers for HERE refresh
    window.addEventListener('driverStatusChanged', onDriverStatusChanged);
    window.addEventListener('deliveryStarted', onDeliveryStarted);
    window.addEventListener('deliveryCompleted', onDeliveryCompleted);
    window.addEventListener('deliveryFailed', onDeliveryFailed);
    window.addEventListener('deliveryAction', onDeliveryAction);

    return () => {
      window.removeEventListener('routeReordered', onReorder);
      window.removeEventListener('polylineUpdated', onPolyline);
      window.removeEventListener('routeOptimizationComplete', onOptimizationComplete);
      window.removeEventListener('routeOptimizationStarted', onOptimizationStarted);
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
      window.removeEventListener('deliveriesImported', onDeliveriesImported);
      window.removeEventListener('driverStatusChanged', onDriverStatusChanged);
      window.removeEventListener('deliveryStarted', onDeliveryStarted);
      window.removeEventListener('deliveryCompleted', onDeliveryCompleted);
      window.removeEventListener('deliveryFailed', onDeliveryFailed);
      window.removeEventListener('deliveryAction', onDeliveryAction);
    };
  }, []);

  // Prefetch HERE polylines for all segments
  useEffect(() => {
    if (!isViewingCurrentDate || optimizing) return;
    driverIncomplete.forEach((stops, driverId) => {
      const totalLegs = Math.max(0, stops.length - 1);
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        const key = `here_${Number(a.latitude).toFixed(5)}_${Number(a.longitude).toFixed(5)}_${Number(b.latitude).toFixed(5)}_${Number(b.longitude).toFixed(5)}`;
        if (cache[key]) continue;
        const jitter = Math.min(800, i * 75 + Math.floor(Math.random() * 120));
        (async () => {
          const ok = await hydrateFromOffline(key, driverId, { latitude: Number(a.latitude), longitude: Number(a.longitude) }, { latitude: Number(b.latitude), longitude: Number(b.longitude) }, a.delivery_date);
          if (ok) return;
          setTimeout(() => {
            getHerePolyline(driverId, { latitude: Number(a.latitude), longitude: Number(a.longitude) }, { latitude: Number(b.latitude), longitude: Number(b.longitude) }, a.delivery_date).then((coords) => {
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
      const key = `here_${Number(a.latitude).toFixed(5)}_${Number(a.longitude).toFixed(5)}_${Number(b.latitude).toFixed(5)}_${Number(b.longitude).toFixed(5)}`;
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
          key={`type2-here-${driverId}-${i}`}
          positions={coords || [[Number(a.latitude), Number(a.longitude)], [Number(b.latitude), Number(b.longitude)]]}
          pathOptions={{
            color: coords ? mapBlueToNonBlue((driverColorMap.get(driverId) || "#6366F1"), driverId) : "#94a3b8",
            weight: 5,
            opacity: coords ? (() => {
              if (totalLegs <= 1) return 0.85; // single leg
              const t = i / (totalLegs - 1);
              const start = 0.95, end = 0.25;
              return Math.max(end, start + (end - start) * t);
            })() : 0.35,
            dashArray: coords ? "" : "6,6",
            lineJoin: "round",
            lineCap: "round"
          }}
          pane="overlayPane"
        />
      );
    }
  });

  // Fallback: if a driver has only pending stops (no in_transit/en_route), draw dashed grey between stops
  try {
    const byDriverAll = new Map();
    const allStops = [...pickupMarkers, ...deliveryMarkers]
      .filter(s => s && typeof s.latitude === 'number' && typeof s.longitude === 'number')
      .sort((a,b)=> (a.stop_order || 0) - (b.stop_order || 0));
    const scopedAllStops = (!multiDriverMode && selectedDriverId && selectedDriverId !== 'all')
      ? allStops.filter(s => s.driver_id === selectedDriverId)
      : allStops;
    scopedAllStops.forEach(s => {
      if (!byDriverAll.has(s.driver_id)) byDriverAll.set(s.driver_id, []);
      byDriverAll.get(s.driver_id).push(s);
    });
    byDriverAll.forEach((stops, driverId) => {
      const active = driverIncomplete.get(driverId);
      if (active && active.length) return; // already handled above
      const nonFinished = stops.filter(s => !FINISHED.includes(s.status));
      if (nonFinished.length < 2) return;
      
      // If we have no active stops in driverIncomplete, but we DO have nonFinished stops,
      // it means they are ALL pending OR we somehow missed them.
      // Let's draw the dashed lines for them so the route is visible!
      for (let i = 0; i < nonFinished.length - 1; i++) {
        const a = nonFinished[i];
        const b = nonFinished[i+1];
        const key = `here_${Number(a.latitude).toFixed(5)}_${Number(a.longitude).toFixed(5)}_${Number(b.latitude).toFixed(5)}_${Number(b.longitude).toFixed(5)}`;
        
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
        
        // Always show dashed fallback immediately
        lines.push(
          <Polyline
            key={`type2-pending-fallback-${driverId}-${i}`}
            positions={coords || [[Number(a.latitude), Number(a.longitude)], [Number(b.latitude), Number(b.longitude)]]}
            pathOptions={{ 
              color: coords ? mapBlueToNonBlue((driverColorMap.get(driverId) || "#6366F1"), driverId) : '#94a3b8', 
              weight: 5, 
              opacity: coords ? 0.6 : 0.35, 
              dashArray: '6,6', 
              lineJoin: 'round', 
              lineCap: 'round' 
            }}
            pane="overlayPane"
          />
        );
      }
    });
  } catch (_) {}

  // Preserve last non-empty set to prevent blanking on date flips/loading
  useEffect(() => { if (lines.length) setLastNonEmptyLines(lines); }, [lines.length, refreshToken, deliveryMarkers.length, pickupMarkers.length]);
  return lines.length ? <>{lines}</> : (lastNonEmptyLines.length ? <>{lastNonEmptyLines}</> : null);
}