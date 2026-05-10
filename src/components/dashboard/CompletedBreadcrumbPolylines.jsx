import React, { useEffect, useMemo, useRef, useState } from "react";
import { Polyline } from "react-leaflet";
import { getHerePolyline } from "../utils/hereRouting";
import { getTravelModeLineStyle, normalizeTravelMode } from "./travelModeHelpers";
import RouteDirectionDecorator from "./RouteDirectionDecorator";
import { getPolylineColorForDriver } from "../utils/polylineColors";

const FINISHED = ["completed", "failed", "cancelled"];

// Alias for readability within this component
const getType3PolylineColor = getPolylineColorForDriver;
const hexToRgb = (hex) => {
  const normalized = String(hex || '').replace('#', '');
  if (normalized.length !== 6) return null;
  const value = parseInt(normalized, 16);
  if (Number.isNaN(value)) return null;
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
};

const rgbToHex = ({ r, g, b }) => `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;

const mixWithWhite = (hex, ratio) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  return rgbToHex({
    r: rgb.r + (255 - rgb.r) * clampedRatio,
    g: rgb.g + (255 - rgb.g) * clampedRatio,
    b: rgb.b + (255 - rgb.b) * clampedRatio
  });
};

const getRouteShadeColor = (driverId, shadeRatio = 0) => {
  const baseColor = getType3PolylineColor(driverId);
  return mixWithWhite(baseColor, shadeRatio);
};

const getFinishedLegRouteStyle = (driverId, deliveryTravelMode, opacityOverride, shadeRatio = 0) => {
  const mode = normalizeTravelMode(deliveryTravelMode || 'driving');
  const isCycling = mode === 'cycling';
  const shadedColor = isCycling ? mixWithWhite('#16A34A', shadeRatio) : getRouteShadeColor(driverId, shadeRatio);
  const base = getTravelModeLineStyle(mode, shadedColor);
  return {
    ...base,
    color: shadedColor,
    opacity: opacityOverride ?? base.opacity,
    lineJoin: 'round',
    lineCap: 'round'
  };
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

const getDistanceMeters = (from, to) => {
  if (!from || !to) return 0;

  const toRadians = (value) => (value * Math.PI) / 180;
  const lat1 = Number(from.latitude);
  const lon1 = Number(from.longitude);
  const lat2 = Number(to.latitude);
  const lon2 = Number(to.longitude);

  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;

  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

const decodePolyline = (encoded) => {
  if (!encoded || typeof encoded !== 'string') return null;
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates = [];

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0;
    result = 0;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([lat / 1e5, lng / 1e5]);
  }

  return coordinates.length > 1 ? coordinates : null;
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

const buildBreadcrumbRoutePoints = (start, breadcrumbPoints, end) => {
  const points = [start, ...breadcrumbPoints, end].filter(Boolean);
  return points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]));
};

export default function CompletedBreadcrumbPolylines({
  driverRoutes = [],
  deliveryMarkers = [],
  pickupMarkers = [],
  driverHomeMarkers = [],
  selectedDriverId = null,
  isAllDriversMode = false,
  highlightedDeliveryId = null,
  polylineRenderKey = 0,
  showStoredPolylines = true,
  showBreadcrumbPolylines = true,
  driverTravelModes = {},
}) {
  const [cache, setCache] = useState({});
  const requestTimesRef = useRef({});

  const storedFinishedSegments = useMemo(() => {
    if (!showStoredPolylines || showBreadcrumbPolylines) return [];
    const allFinishedStops = [...pickupMarkers, ...deliveryMarkers]
      .filter((stop) => stop && FINISHED.includes(stop.status))
      .filter((stop) => {
        const encoded = typeof stop.finished_leg_encoded_polyline === "string" && stop.finished_leg_encoded_polyline.trim().length > 0
          ? stop.finished_leg_encoded_polyline.trim()
          : (typeof stop.encoded_polyline === "string" && stop.encoded_polyline.trim().length > 0 ? stop.encoded_polyline.trim() : "");
        return encoded.length > 0;
      })
      .filter((stop) => isAllDriversMode || selectedDriverId === "all" || stop.driver_id === selectedDriverId);

    return allFinishedStops.map((stop) => ({
      finishedLegTransportMode: normalizeTravelMode(stop.finished_leg_transport_mode || stop.transport_mode),
      id: `stored-${stop.id}`,
      stopId: stop.id,
      driverId: stop.driver_id,
      encodedPolyline: (typeof stop.finished_leg_encoded_polyline === "string" && stop.finished_leg_encoded_polyline.trim().length > 0
        ? stop.finished_leg_encoded_polyline.trim()
        : stop.encoded_polyline.trim()),
      opacity: highlightedDeliveryId && stop.id === highlightedDeliveryId ? 0.85 : (selectedDriverId && selectedDriverId !== "all" ? 0.7 : 0.35)
    }));
  }, [pickupMarkers, deliveryMarkers, isAllDriversMode, selectedDriverId, highlightedDeliveryId]);

  const storedFinishedStopIds = useMemo(() => new Set(storedFinishedSegments.map((segment) => segment.stopId)), [storedFinishedSegments]);

  const driverHomeMap = useMemo(() => new Map((driverHomeMarkers || []).map((marker) => [marker.driverId, marker])), [driverHomeMarkers]);

  const completedSegments = useMemo(() => {
    if (!showBreadcrumbPolylines) return [];
    return (driverRoutes || []).flatMap((route) => {
      if (!route?.driverId) return [];

      const color = getType3PolylineColor(route.driverId);

      const stops = [
        ...pickupMarkers.filter((pickup) => pickup && pickup.driver_id === route.driverId),
        ...deliveryMarkers.filter((delivery) => delivery && delivery.driver_id === route.driverId),
      ].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

      const routeCompleted = route?.isCompleted || (stops.length > 0 && stops.every((stop) => FINISHED.includes(stop.status)));
      if (!stops.length || !routeCompleted) return [];

      const stopToStopSegments = stops.slice(0, -1).map((fromStop, index) => {
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
        const routePoints = buildBreadcrumbRoutePoints(start, breadcrumbPoints, end);
        const hasRealBreadcrumbPoints = breadcrumbPoints.length > 0;

        const totalSegmentCount = Math.max(stops.length, 1);
        const shadeRatio = Math.min(0.55, (index / Math.max(totalSegmentCount - 1, 1)) * 0.45);

        return {
          id: `${route.driverId}-${index}`,
          driverId: route.driverId,
          color: color || "#607D8B",
          shadeRatio,
          opacity,
          fallbackDashArray: toStop.ampm_deliveries === "AM" ? "10, 5" : "2, 8",
          deliveryDate: toStop.delivery_date || fromStop.delivery_date,
          start,
          end,
          destinationStopId: toStop.id,
          destinationPointKey: getPointKey(end),
          finishedLegTransportMode: normalizeTravelMode(toStop.finished_leg_transport_mode || toStop.transport_mode || 'driving'),
          storedEncodedPolyline: typeof toStop.finished_leg_encoded_polyline === "string" && toStop.finished_leg_encoded_polyline.trim().length > 0
            ? toStop.finished_leg_encoded_polyline.trim()
            : (typeof toStop.encoded_polyline === "string" ? toStop.encoded_polyline.trim() : ""),
          breadcrumbPoints,
          routePoints,
          hasAnyBreadcrumbs: hasRealBreadcrumbPoints,
          hasBreadcrumbs: hasRealBreadcrumbPoints && routePoints.length > 1,
        };
      }).filter(Boolean);

      const lastStop = stops[stops.length - 1];
      const homeMarker = driverHomeMap.get(route.driverId);
      const homeSegment = routeCompleted && lastStop && homeMarker && Number.isFinite(Number(homeMarker.latitude)) && Number.isFinite(Number(homeMarker.longitude))
        ? {
            id: `${route.driverId}-home-final`,
            driverId: route.driverId,
            color: color || "#607D8B",
            shadeRatio: 0.55,
            opacity: selectedDriverId && selectedDriverId !== "all" && route.driverId === selectedDriverId ? 0.7 : 0.35,
            fallbackDashArray: "6, 6",
            deliveryDate: lastStop.delivery_date,
            start: { latitude: Number(lastStop.latitude), longitude: Number(lastStop.longitude) },
            end: { latitude: Number(homeMarker.latitude), longitude: Number(homeMarker.longitude) },
            destinationStopId: `home-${route.driverId}`,
            destinationPointKey: getPointKey({ latitude: Number(homeMarker.latitude), longitude: Number(homeMarker.longitude) }),
            finishedLegTransportMode: normalizeTravelMode(lastStop.finished_leg_transport_mode || lastStop.transport_mode || 'driving'),
            storedEncodedPolyline: "",
            breadcrumbPoints: [],
            routePoints: [
              { latitude: Number(lastStop.latitude), longitude: Number(lastStop.longitude) },
              { latitude: Number(homeMarker.latitude), longitude: Number(homeMarker.longitude) }
            ],
            hasAnyBreadcrumbs: false,
            hasBreadcrumbs: false,
            isHomeFinalSegment: true,
          }
        : null;

      return homeSegment ? [...stopToStopSegments, homeSegment] : stopToStopSegments;
    });
  }, [driverRoutes, pickupMarkers, deliveryMarkers, selectedDriverId, isAllDriversMode, highlightedDeliveryId, driverHomeMap]);

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
    if (!showStoredPolylines || showBreadcrumbPolylines) return [];
    return completedSegments
      .filter(() => showStoredPolylines)
      .filter((segment) => !segment.hasAnyBreadcrumbs)
      .filter((segment) => !storedFinishedStopIds.has(segment.destinationStopId))
      .filter((segment) => !blockedStoredDestinationStopIds.has(segment.destinationStopId))
      .filter((segment) => !segment.destinationPointKey || !blockedStoredDestinationPointKeys.has(segment.destinationPointKey))
      .map((segment) => ({
        id: `${segment.id}-direct`,
        driverId: segment.driverId,
        color: segment.color,
        shadeRatio: segment.shadeRatio ?? 0,
        opacity: segment.opacity,
        deliveryDate: segment.deliveryDate,
        from: segment.start,
        to: segment.end,
        storedEncodedPolyline: segment.storedEncodedPolyline,
      }));
  }, [completedSegments, storedFinishedStopIds, blockedStoredDestinationStopIds, blockedStoredDestinationPointKeys, showStoredPolylines]);

  const breadcrumbRouteLegs = useMemo(() => {
    return completedSegments.flatMap((segment) => {
      if (!showBreadcrumbPolylines || !segment.hasBreadcrumbs) return [];

      return segment.routePoints.slice(0, -1).map((from, index) => {
        const to = segment.routePoints[index + 1];
        const distanceMeters = getDistanceMeters(from, to);

        return {
          id: `${segment.id}-breadcrumb-${index}`,
          driverId: segment.driverId,
          deliveryDate: segment.deliveryDate,
          shadeRatio: segment.shadeRatio ?? 0,
          opacity: segment.opacity,
          from,
          to,
          distanceMeters,
          useHere: distanceMeters > 500,
        };
      }).filter(Boolean);
    });
  }, [completedSegments, showBreadcrumbPolylines]);

  useEffect(() => {
    let cancelled = false;

    [...directSegmentLegs, ...breadcrumbRouteLegs.filter((leg) => leg.useHere)].forEach((leg) => {
      const key = getLegKey(leg.from, leg.to);
      if (!key || getCachedPolyline(key, cache)) return;

      if (leg.storedEncodedPolyline) {
        const decoded = decodePolyline(leg.storedEncodedPolyline);
        if (decoded) {
          setCache((previous) => ({ ...previous, [key]: decoded }));
          return;
        }
      }

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
  }, [directSegmentLegs, breadcrumbRouteLegs, cache, polylineRenderKey]);

  const renderedLines = [];

  storedFinishedSegments.forEach((segment) => {
    if (!showStoredPolylines) return;
    const coords = decodePolyline(segment.encodedPolyline);
    if (!coords) return;

    renderedLines.push(
      [
        <Polyline
          key={`stored-finished-${segment.id}-${polylineRenderKey}-${highlightedDeliveryId || "none"}`}
          positions={coords}
          pathOptions={getFinishedLegRouteStyle(segment.driverId, segment.finishedLegTransportMode, Math.max(segment.opacity, 0.35), 0)}
          pane="completedBreadcrumbPane"
        />,
        <RouteDirectionDecorator
          key={`stored-finished-arrow-${segment.id}-${polylineRenderKey}-${highlightedDeliveryId || "none"}`}
          positions={coords}
          color={getRouteShadeColor(segment.driverId, 0)}
        />
      ]
    );
  });

  completedSegments.forEach((segment) => {
    if (!segment.hasAnyBreadcrumbs) {
      if (!showStoredPolylines) return;
      if (storedFinishedStopIds.has(segment.destinationStopId)) return;
      if (blockedStoredDestinationStopIds.has(segment.destinationStopId)) return;
      if (segment.destinationPointKey && blockedStoredDestinationPointKeys.has(segment.destinationPointKey)) return;

      const key = getLegKey(segment.start, segment.end);
      const coords = getCachedPolyline(key, cache) || decodePolyline(segment.storedEncodedPolyline);
      if (!coords) return;

      renderedLines.push(
        <Polyline
          key={`completed-stored-${segment.id}-${polylineRenderKey}-${highlightedDeliveryId || "none"}`}
          positions={coords}
          pathOptions={{
            ...getFinishedLegRouteStyle(segment.driverId, segment.finishedLegTransportMode, Math.max(segment.opacity, 0.35), segment.shadeRatio ?? 0),
            dashArray: segment.isHomeFinalSegment ? '6 6' : undefined
          }}
          pane="completedBreadcrumbPane"
        />,
        <RouteDirectionDecorator
          key={`completed-stored-arrow-${segment.id}-${polylineRenderKey}-${highlightedDeliveryId || "none"}`}
          positions={coords}
          color={getRouteShadeColor(segment.driverId, 0)}
        />
      );
      return;
    }

    if (!showBreadcrumbPolylines || !segment.hasAnyBreadcrumbs) return;

    breadcrumbRouteLegs
      .filter((leg) => leg.id.startsWith(`${segment.id}-breadcrumb-`))
      .forEach((leg) => {
        const key = getLegKey(leg.from, leg.to);
        const positions = leg.useHere
          ? (getCachedPolyline(key, cache) || [[leg.from.latitude, leg.from.longitude], [leg.to.latitude, leg.to.longitude]])
          : [[leg.from.latitude, leg.from.longitude], [leg.to.latitude, leg.to.longitude]];

        if (!positions || positions.length < 2) return;

        renderedLines.push(
          <Polyline
            key={`completed-breadcrumb-line-${leg.id}-${polylineRenderKey}`}
            positions={positions}
            pathOptions={getFinishedLegRouteStyle(segment.driverId, segment.finishedLegTransportMode, Math.max(segment.opacity, 0.35), leg.shadeRatio ?? 0)}
            pane="completedBreadcrumbPane"
          />,
          <RouteDirectionDecorator
            key={`completed-breadcrumb-arrow-${leg.id}-${polylineRenderKey}`}
            positions={positions}
            color={getRouteShadeColor(segment.driverId, leg.shadeRatio ?? 0)}
          />
        );
      });
  });

  return renderedLines.length ? renderedLines.flat() : null;
}