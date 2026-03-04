import React, { useEffect, useMemo, useState } from "react";
import { Polyline } from "react-leaflet";
import { getHerePolyline } from "../utils/hereRouting";

const FINISHED = ["completed", "failed", "cancelled", "returned"];

export default function HereType2Polylines({
  isViewingCurrentDate,
  deliveryMarkers = [],
  pickupMarkers = [],
  driverRoutes = [],
  multiDriverMode = false,
}) {
  const [cache, setCache] = useState({});
  const [refreshToken, setRefreshToken] = useState(0);

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

    const grouped = new Map();
    all.forEach((s) => {
      if (!grouped.has(s.driver_id)) grouped.set(s.driver_id, []);
      grouped.get(s.driver_id).push(s);
    });

    grouped.forEach((stops, driverId) => {
      const incomplete = stops.filter((s) => !FINISHED.includes(s.status) && s.status !== "pending");
      if (incomplete.length === 0) return;
      const next = incomplete.find((s) => s.isNextDelivery) || incomplete[0];
      const startIdx = incomplete.indexOf(next);
      map.set(driverId, incomplete.slice(startIdx));
    });

    return map;
  }, [deliveryMarkers, pickupMarkers]);

  // Listen for route reorder events to refresh polylines
  useEffect(() => {
    const handler = (e) => {
      setCache({});
      setRefreshToken((t) => t + 1);
    };
    window.addEventListener('routeReordered', handler);
    return () => window.removeEventListener('routeReordered', handler);
  }, []);

  // Prefetch HERE polylines for all segments
  useEffect(() => {
    if (!isViewingCurrentDate) return;
    driverIncomplete.forEach((stops, driverId) => {
      const totalLegs = Math.max(0, stops.length - 1);
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        const key = `here_${a.latitude.toFixed(5)}_${a.longitude.toFixed(5)}_${b.latitude.toFixed(5)}_${b.longitude.toFixed(5)}`;
        if (cache[key]) continue;
        const jitter = Math.min(800, i * 75 + Math.floor(Math.random() * 120));
        setTimeout(() => {
          getHerePolyline(driverId, { latitude: a.latitude, longitude: a.longitude }, { latitude: b.latitude, longitude: b.longitude }, a.delivery_date).then((coords) => {
            if (Array.isArray(coords) && coords.length > 1) setCache((p) => ({ ...p, [key]: coords }));
          });
        }, jitter);
      }
    });
  }, [isViewingCurrentDate, driverIncomplete, refreshToken]);

  if (!isViewingCurrentDate) return null;

  const lines = [];
  driverIncomplete.forEach((stops, driverId) => {
    const totalLegs = Math.max(0, stops.length - 1);
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const key = `here_${a.latitude.toFixed(5)}_${a.longitude.toFixed(5)}_${b.latitude.toFixed(5)}_${b.longitude.toFixed(5)}`;
      const coords = cache[key];
      lines.push(
        <Polyline
          key={`type2-here-${driverId}-${i}`}
          positions={coords || [[a.latitude, a.longitude], [b.latitude, b.longitude]]}
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

  return lines.length ? <>{lines}</> : null;
}