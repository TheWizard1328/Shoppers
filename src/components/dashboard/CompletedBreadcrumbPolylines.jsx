import React, { useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, Polyline } from "react-leaflet";
import { getHerePolyline } from "../utils/hereRouting";

const FINISHED = ["completed", "failed", "cancelled"];
const STORED_ROUTE_COLOR = "#16a34a";
const BREADCRUMB_ROUTE_COLOR = "#2563eb";

const isBlueHex = (hex) => {
  if (!hex || typeof hex !== "string" || !hex.startsWith("#") || hex.length < 7) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return false;
  let h;
  switch (max) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  h *= 60;
  return h >= 180 && h <= 250;
};

const hashId = (value) => Array.from(String(value || "x")).reduce((acc, char) => ((acc << 5) - acc) + char.charCodeAt(0) | 0, 0);

const mapBlueToNonBlue = (hex, id) => {
  if (!isBlueHex(hex)) return hex || "#607D8B";
  const palette = ["#8A2BE2", "#EC4899", "#F59E0B", "#A855F7", "#F43F5E", "#FF7F50", "#A0522D"];
  return palette[Math.abs(hashId(id)) % palette.length];
};

const samePoint = (a, b) => (
  Math.abs(Number(a?.latitude) - Number(b?.latitude)) < 1e-5 &&
  Math.abs(Number(a?.longitude) - Number(b?.longitude)) < 1e-5
);

const getLegKey = (from, to) => {
  if (!from || !to) return null;
  return `here_${Number(from.latitude).toFixed(5)}_${Number(from.longitude).toFixed(5)}_${Number(to.latitude).toFixed(5)}_${Number(to.longitude).toFixed(5)}`;
};

const getPointKey = (point) => {
  if (!point) return null;
  const lat = Number(point.latitude);
  const lng = Number(point.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return `${lat.toFixed(5)}_${lng.toFixed(5)}`;
};

const getCachedPolyline = (key, cache) => {
  if (!key) return null;
  const inMemory = cache[key];
  if (Array.isArray(inMemory) && inMemory.length > 1) return inMemory;
  try {
    const local = localStorage.getItem(key);
    if (!local) return null;
    const parsed = JSON.parse(local);
    return Array.isArray(parsed) && parsed.length > 1 ? parsed : null;
  } catch (_) {
    return null;
  }
};

const parseBreadcrumbPoints = (breadcrumbsValue) => {
  try {
    const parsed = typeof breadcrumbsValue === "string" ? JSON.parse(breadcrumbsValue) : breadcrumbsValue;
    return (Array.isArray(parsed) ? parsed : [])
      .map((point) => ({ latitude: Number(point?.[0]), longitude: Number(point?.[1]) }))
      .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
  } catch (_) {
    return [];
  }
};

const parseBreadcrumbWaypoints = (breadcrumbsValue, start, end, sampleEvery = 10) => {
  if (!start || !end) return [];

  const sampled = parseBreadcrumbPoints(breadcrumbsValue)
    .filter((_, index) => index % sampleEvery === 0);

  const combined = [start, ...sampled, end];
  return combined.filter((point, index) => {
    if (index === 0) return true;
    const previous = combined[index - 1];
    return !samePoint(previous, point);
  });
};

export default function CompletedBreadcrumbPolylines({
  driverRoutes = [],
  deliveryMarkers = [],
  pickupMarkers = [],
  selectedDriverId = null,
  isAllDriversMode = false,
  highlightedDeliveryId = null,
  polylineRenderKey = 0,
}) {
  const [cache, setCache] = useState({});
  const requestTimesRef = useRef({});

  const completedSegments = useMemo(() => {
    return (driverRoutes || []).flatMap((route) => {
      if (!route?.driverId) return [];

      const color = (isAllDriversMode || selectedDriverId === "all")
        ? mapBlueToNonBlue(route.color, route.driverId)
        : route.color;

      const stops = [
        ...pickupMarkers.filter((pickup) => pickup && pickup.driver_id === route.driverId),
        ...deliveryMarkers.filter((delivery) => delivery && delivery.driver_id === route.driverId),
      ].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

      if (stops.length < 2 || !stops.every((stop) => FINISHED.includes(stop.status))) return [];

      return stops.slice(0, -1).map((fromStop, index) => {
        const toStop = stops[index + 1];
        if (!fromStop || !toStop) return null;
        if ([fromStop.latitude, fromStop.longitude, toStop.latitude, toStop.longitude].some((value) => typeof value !== "number" || Number.isNaN(value))) return null;

        const fromTime = fromStop.actual_delivery_time ? new Date(fromStop.actual_delivery_time) : fromStop.delivery_time_eta ? new Date(`2000-01-01T${fromStop.delivery_time_eta}:00`) : fromStop.delivery_time_start ? new Date(`2000-01-01T${fromStop.delivery_time_start}:00`) : null;
        const toTime = toStop.actual_delivery_time ? new Date(toStop.actual_delivery_time) : toStop.delivery_time_eta ? new Date(`2000-01-01T${toStop.delivery_time_eta}:00`) : toStop.delivery_time_start ? new Date(`2000-01-01T${toStop.delivery_time_start}:00`) : null;
        if (fromTime && toTime && Math.abs(toTime - fromTime) / 60000 > 90) return null;

        const opacity = selectedDriverId && selectedDriverId !== "all" && route.driverId === selectedDriverId
          ? 0.7
          : highlightedDeliveryId && (fromStop.id === highlightedDeliveryId || toStop.id === highlightedDeliveryId)
            ? 0.85
            : 0.2;

        const start = { latitude: Number(fromStop.latitude), longitude: Number(fromStop.longitude) };
        const end = { latitude: Number(toStop.latitude), longitude: Number(toStop.longitude) };
        const breadcrumbPoints = parseBreadcrumbPoints(toStop.delivery_route_breadcrumbs);
        const breadcrumbWaypoints = parseBreadcrumbWaypoints(toStop.delivery_route_breadcrumbs, start, end, 10);

        return {
          id: `${route.driverId}-${index}`,
          driverId: route.driverId,
          color: color || "#607D8B",
          opacity,
          fallbackDashArray: toStop.ampm_deliveries === "AM" ? "10, 5" : "2, 8",
          deliveryDate: toStop.delivery_date || fromStop.delivery_date,
          start,
          end,
          destinationStopId: toStop.id,
          destinationPointKey: getPointKey(end),
          breadcrumbWaypoints,
          hasAnyBreadcrumbs: breadcrumbPoints.length > 0,
          hasBreadcrumbs: breadcrumbWaypoints.length > 2,
        };
      }).filter(Boolean);
    });
  }, [driverRoutes, pickupMarkers, deliveryMarkers, selectedDriverId, isAllDriversMode, highlightedDeliveryId]);

  const breadcrumbLegs = useMemo(() => {
    return completedSegments.flatMap((segment) => {
      if (!segment.hasBreadcrumbs) return [];
      return segment.breadcrumbWaypoints.slice(0, -1).map((from, index) => ({
        id: `${segment.id}-${index}`,
        driverId: segment.driverId,
        color: segment.color,
        opacity: segment.opacity,
        deliveryDate: segment.deliveryDate,
        from,
        to: segment.breadcrumbWaypoints[index + 1],
      }));
    });
  }, [completedSegments]);

  const blockedStoredDestinationStopIds = useMemo(() => new Set(
    completedSegments
      .filter((segment) => segment.hasAnyBreadcrumbs && segment.destinationStopId)
      .map((segment) => segment.destinationStopId)
  ), [completedSegments]);

  const blockedStoredDestinationPointKeys = useMemo(() => new Set(
    completedSegments
      .filter((segment) => segment.hasAnyBreadcrumbs && segment.destinationPointKey)
      .map((segment) => segment.destinationPointKey)
  ), [completedSegments]);

  const directSegmentLegs = useMemo(() => {
    return completedSegments
      .filter((segment) => !segment.hasAnyBreadcrumbs)
      .filter((segment) => !blockedStoredDestinationStopIds.has(segment.destinationStopId))
      .filter((segment) => !segment.destinationPointKey || !blockedStoredDestinationPointKeys.has(segment.destinationPointKey))
      .map((segment) => ({
        id: `${segment.id}-direct`,
        driverId: segment.driverId,
        color: segment.color,
        opacity: segment.opacity,
        deliveryDate: segment.deliveryDate,
        from: segment.start,
        to: segment.end,
      }));
  }, [completedSegments, blockedStoredDestinationStopIds, blockedStoredDestinationPointKeys]);

  useEffect(() => {
    let cancelled = false;

    [...breadcrumbLegs, ...directSegmentLegs].forEach((leg) => {
      const key = getLegKey(leg.from, leg.to);
      if (!key || getCachedPolyline(key, cache)) return;

      const now = Date.now();
      if (now - (requestTimesRef.current[key] || 0) < 4000) return;
      requestTimesRef.current[key] = now;

      getHerePolyline(leg.driverId, leg.from, leg.to, leg.deliveryDate).then((coords) => {
        if (cancelled) return;
        if (Array.isArray(coords) && coords.length > 1) {
          setCache((previous) => ({ ...previous, [key]: coords }));
        }
      }).catch(() => {});
    });

    return () => {
      cancelled = true;
    };
  }, [breadcrumbLegs, directSegmentLegs, cache, polylineRenderKey]);

  const renderedLines = [];
  const renderedDots = [];

  completedSegments.forEach((segment) => {
    if (!segment.hasAnyBreadcrumbs) {
      if (blockedStoredDestinationStopIds.has(segment.destinationStopId)) return;
      if (segment.destinationPointKey && blockedStoredDestinationPointKeys.has(segment.destinationPointKey)) return;

      const key = getLegKey(segment.start, segment.end);
      const coords = getCachedPolyline(key, cache);
      if (!coords) return;

      renderedLines.push(
        <Polyline
          key={`completed-stored-${segment.id}-${polylineRenderKey}-${highlightedDeliveryId || "none"}`}
          positions={coords}
          pathOptions={{
            color: STORED_ROUTE_COLOR,
            weight: 4,
            opacity: Math.max(segment.opacity, 0.35),
            lineJoin: "round",
            lineCap: "round",
          }}
          pane="overlayPane"
        />
      );
      return;
    }

    if (!segment.hasBreadcrumbs) return;

    segment.breadcrumbWaypoints.slice(0, -1).forEach((from, index) => {
      const to = segment.breadcrumbWaypoints[index + 1];
      const key = getLegKey(from, to);
      const coords = getCachedPolyline(key, cache);
      if (!coords) return;

      renderedLines.push(
        <Polyline
          key={`completed-breadcrumb-line-${segment.id}-${index}-${polylineRenderKey}`}
          positions={coords}
          pathOptions={{
            color: BREADCRUMB_ROUTE_COLOR,
            weight: 4,
            opacity: Math.max(segment.opacity, 0.35),
            lineJoin: "round",
            lineCap: "round",
          }}
          pane="overlayPane"
        />
      );
    });

    segment.breadcrumbWaypoints.slice(1, -1).forEach((point, index) => {
      renderedDots.push(
        <CircleMarker
          key={`completed-breadcrumb-dot-${segment.id}-${index}-${polylineRenderKey}`}
          center={[point.latitude, point.longitude]}
          radius={3}
          pathOptions={{
            color: BREADCRUMB_ROUTE_COLOR,
            fillColor: BREADCRUMB_ROUTE_COLOR,
            fillOpacity: Math.min(1, segment.opacity + 0.3),
            opacity: Math.max(segment.opacity, 0.5),
            weight: 1,
          }}
          pane="overlayPane"
        />
      );
    });
  });

  return renderedLines.length || renderedDots.length ? <>{renderedLines}{renderedDots}</> : null;
}