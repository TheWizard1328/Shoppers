import React, { useEffect, useMemo, useState } from "react";
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

  // Prefetch last-completed -> next-stop
  useEffect(() => {
    if (!isViewingCurrentDate) return;
    driverStops.forEach((stops, driverId) => {
      if (stops.incomplete.length === 0 || stops.complete.length === 0) return;
      const lastCompleted = [...stops.complete]
        .filter((s) => s.actual_delivery_time)
        .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time))[0];
      const nextStop =
        stops.incomplete.find((s) => s.isNextDelivery === true) ||
        [...stops.incomplete].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
      if (!lastCompleted || !nextStop) return;
      const key = `here_${lastCompleted.latitude.toFixed(5)}_${lastCompleted.longitude.toFixed(5)}_${nextStop.latitude.toFixed(5)}_${nextStop.longitude.toFixed(5)}`;
      if (cache[key]) return;
      getHerePolyline(driverId, { latitude: lastCompleted.latitude, longitude: lastCompleted.longitude }, { latitude: nextStop.latitude, longitude: nextStop.longitude }).then((coords) => {
        if (Array.isArray(coords) && coords.length > 1) setCache((p) => ({ ...p, [key]: coords }));
      });
    });
  }, [isViewingCurrentDate, driverStops, cache]);

  // Prefetch last-completed -> home (for completed routes)
  useEffect(() => {
    if (!isViewingCurrentDate) return;
    driversWithCompleteRoute.forEach((driverId) => {
      const all = driverStops.get(driverId) || { complete: [] };
      const lastCompleted = [...(all.complete || [])]
        .filter((s) => s.actual_delivery_time)
        .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time))[0];
      const home = driverHomeMarkers.find((h) => h.driverId === driverId);
      if (!lastCompleted || !home) return;
      const key = `here_${lastCompleted.latitude.toFixed(5)}_${lastCompleted.longitude.toFixed(5)}_${home.latitude.toFixed(5)}_${home.longitude.toFixed(5)}`;
      if (cache[key]) return;
      getHerePolyline(driverId, { latitude: lastCompleted.latitude, longitude: lastCompleted.longitude }, { latitude: home.latitude, longitude: home.longitude }).then((coords) => {
        if (Array.isArray(coords) && coords.length > 1) setCache((p) => ({ ...p, [key]: coords }));
      });
    });
  }, [isViewingCurrentDate, driversWithCompleteRoute, driverStops, driverHomeMarkers, cache]);

  if (!isViewingCurrentDate) return null;

  const lines = [];

  // Render last-completed -> next-stop using HERE (fallback straight)
  driverStops.forEach((stops, driverId) => {
    if (stops.incomplete.length === 0 || stops.complete.length === 0) return;
    const lastCompleted = [...stops.complete]
      .filter((s) => s.actual_delivery_time)
      .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time))[0];
    const nextStop =
      stops.incomplete.find((s) => s.isNextDelivery === true) ||
      [...stops.incomplete].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
    if (!lastCompleted || !nextStop) return;
    const key = `here_${lastCompleted.latitude.toFixed(5)}_${lastCompleted.longitude.toFixed(5)}_${nextStop.latitude.toFixed(5)}_${nextStop.longitude.toFixed(5)}`;
    const coords = cache[key];
    lines.push(
      <Polyline
        key={`type1-next-${driverId}`}
        positions={coords || [
          [lastCompleted.latitude, lastCompleted.longitude],
          [nextStop.latitude, nextStop.longitude],
        ]}
        pathOptions={{ color: "#3B82F6", weight: 4, opacity: 0.7, dashArray: "2, 8", lineJoin: "round", lineCap: "round" }}
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
    const coords = cache[key];
    lines.push(
      <Polyline
        key={`type1-home-${driverId}`}
        positions={coords || [
          [lastCompleted.latitude, lastCompleted.longitude],
          [home.latitude, home.longitude],
        ]}
        pathOptions={{ color: "#3B82F6", weight: 4, opacity: 0.7, dashArray: "2, 8", lineJoin: "round", lineCap: "round" }}
        pane="overlayPane"
      />
    );
  });

  return lines.length ? <>{lines}</> : null;
}