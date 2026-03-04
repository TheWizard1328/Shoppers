import React, { useEffect, useMemo, useState } from "react";
import { Polyline } from "react-leaflet";
import { getHerePolyline } from "../utils/hereRouting";

const FINISHED = ["completed", "failed", "cancelled", "returned"];

export default function HereType2Polylines({
  isViewingCurrentDate,
  deliveryMarkers = [],
  pickupMarkers = [],
}) {
  const [cache, setCache] = useState({});

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

  // Prefetch HERE polylines for all segments
  useEffect(() => {
    if (!isViewingCurrentDate) return;
    driverIncomplete.forEach((stops, driverId) => {
      for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        const key = `here_${a.latitude.toFixed(5)}_${a.longitude.toFixed(5)}_${b.latitude.toFixed(5)}_${b.longitude.toFixed(5)}`;
        if (cache[key]) continue;
        getHerePolyline(driverId, { latitude: a.latitude, longitude: a.longitude }, { latitude: b.latitude, longitude: b.longitude }).then((coords) => {
          if (Array.isArray(coords) && coords.length > 1) setCache((p) => ({ ...p, [key]: coords }));
        });
      }
    });
  }, [isViewingCurrentDate, driverIncomplete]);

  if (!isViewingCurrentDate) return null;

  const lines = [];
  driverIncomplete.forEach((stops, driverId) => {
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      const key = `here_${a.latitude.toFixed(5)}_${a.longitude.toFixed(5)}_${b.latitude.toFixed(5)}_${b.longitude.toFixed(5)}`;
      const coords = cache[key];
      lines.push(
        <Polyline
          key={`type2-here-${driverId}-${i}`}
          positions={coords || [[a.latitude, a.longitude], [b.latitude, b.longitude]]}
          pathOptions={{ color: "#2563eb", weight: 5, opacity: coords ? 0.9 : 0.4, dashArray: coords ? "" : "6,6", lineJoin: "round", lineCap: "round" }}
          pane="overlayPane"
        />
      );
    }
  });

  return lines.length ? <>{lines}</> : null;
}