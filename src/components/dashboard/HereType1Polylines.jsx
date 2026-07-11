import React, { useEffect, useMemo, useRef, useState } from "react";
import { Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import { getTravelModeLineStyle, normalizeTravelMode } from "./travelModeHelpers";
import RouteDirectionDecorator from "./RouteDirectionDecorator";
import { getPolylineColorForDriver } from "../utils/polylineColors";

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


function HereType1Polylines({
  isViewingCurrentDate,
  deliveryMarkers = [],
  pickupMarkers = [],
  allDriverDeliveries = [],
  driverHomeMarkers = [],
  currentDriverMarker = null,
  selectedDriverId = null,
  showAll = false,
  driverLocations = [],
  appUsers = [],
  driverTravelModes = {},
  selectedDate = null,
  isDispatcher = false,
}) {
  const map = useMap();
  // Canvas renderer — lazily initialized after map is ready to avoid pane errors.
  const canvasRenderer = useRef(null);
  const [rendererReady, setRendererReady] = useState(false);
  useEffect(() => {
    if (!map || canvasRenderer.current) return;
    const init = () => {
      if (!canvasRenderer.current) {
        canvasRenderer.current = L.canvas({ padding: 0.5, tolerance: 5 });
        setRendererReady(true);
      }
    };
    if (map._loaded) {
      init();
    } else {
      map.once('load', init);
      return () => map.off('load', init);
    }
  }, [map]);

  const [driverStopsReady, setDriverStopsReady] = useState(false);
  const [localDriverTravelModes, setLocalDriverTravelModes] = useState({});
  const [refreshToken, setRefreshToken] = useState(0);

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

    // Filter to selected date only — prevents stops from other dates contaminating
    // the incomplete/complete counts used for route-completeness detection.
    const dateFilteredStops = selectedDate
      ? scopedStops.filter(m => !m?.delivery_date || m.delivery_date === selectedDate)
      : scopedStops;

    dateFilteredStops.forEach((m) => {
      if (!m || !m.driver_id || Number.isNaN(Number(m.latitude)) || Number.isNaN(Number(m.longitude))) return;
      if (!map.has(m.driver_id)) map.set(m.driver_id, { complete: [], incomplete: [], pending: [] });
      if (FINISHED.includes(m.status)) map.get(m.driver_id).complete.push(m);
      else if (m.status === "in_transit" || m.status === "en_route") map.get(m.driver_id).incomplete.push(m);
      else map.get(m.driver_id).pending.push(m); // treat any unknown/pending status as pending
    });
    
    // Sort incomplete stops by stop_order to ensure we find the true "next" stop
    map.forEach((stops) => {
      stops.incomplete.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
    });
    
    return map;
  }, [deliveryMarkers, pickupMarkers, selectedDriverId, showAll, selectedDate]);

  // Route completeness: a driver's route is complete if they have ZERO stops
  // with status pending, in_transit, or en_route — checked against the full
  // unfiltered daily dataset (allDriverDeliveries), ignoring any store filter.
  const ACTIVE_STATUSES = new Set(['pending', 'in_transit', 'en_route']);
  const driversWithCompleteRoute = useMemo(() => {
    const out = new Set();
    if (!allDriverDeliveries.length) return out;

    const dateFiltered = selectedDate
      ? allDriverDeliveries.filter(d => d?.delivery_date === selectedDate)
      : allDriverDeliveries;

    // Track which drivers have at least one completed stop and zero active stops
    const byDriver = new Map(); // driverId -> { hasCompleted, hasActive }
    dateFiltered.forEach((d) => {
      if (!d?.driver_id || !d?.status) return;
      if (!byDriver.has(d.driver_id)) byDriver.set(d.driver_id, { hasCompleted: false, hasActive: false });
      const entry = byDriver.get(d.driver_id);
      if (ACTIVE_STATUSES.has(d.status)) entry.hasActive = true;
      else if (FINISHED.includes(d.status)) entry.hasCompleted = true;
    });

    byDriver.forEach(({ hasCompleted, hasActive }, driverId) => {
      if (hasCompleted && !hasActive) out.add(driverId);
    });

    return out;
  }, [allDriverDeliveries, selectedDate]);

  // Drivers who are off_duty — their first-stop polyline should not be rendered.
  // Uses the full appUsers list so drivers with null/cleared location data are still caught.
  const offDutyDriverIds = useMemo(() => {
    const out = new Set();
    (appUsers || []).forEach((u) => {
      const status = u?.driver_status;
      if (status && status !== 'on_duty' && status !== 'online') {
        if (u.id) out.add(u.id);
        if (u.user_id) out.add(u.user_id);
      }
    });
    return out;
  }, [appUsers]);

  useEffect(() => {
    const invalidate = () => setRefreshToken((t) => t + 1);
    const onDriverTravelModeChanged = (event) => {
      const driverId = event?.detail?.driverId;
      const travelMode = event?.detail?.travelMode;
      if (!driverId || !travelMode) return;
      setLocalDriverTravelModes((prev) => ({ ...prev, [driverId]: travelMode }));
      invalidate();
    };

    const onDeliveriesUpdated = (event) => {
      // Only invalidate when the update carries polyline data to avoid unnecessary re-renders
      const detail = event?.detail || {};
      const deliveries = detail.freshDeliveries || detail.deliveries;
      if (Array.isArray(deliveries) && deliveries.some(d => d?.encoded_polyline)) {
        invalidate();
      } else if (detail.triggeredBy === 'resetPolylines_chunk' || detail.triggeredBy === 'realtimeBufferedFullRefresh') {
        invalidate();
      }
    };

    window.addEventListener('routeReordered', invalidate);
    window.addEventListener('routeOptimizationComplete', invalidate);
    window.addEventListener('driverTravelModeChanged', onDriverTravelModeChanged);
    window.addEventListener('polylineUpdated', invalidate);
    window.addEventListener('polylineCacheCleared', invalidate);
    window.addEventListener('deliveryCompleted', invalidate);
    window.addEventListener('deliveryFailed', invalidate);
    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);

    return () => {
      window.removeEventListener('routeReordered', invalidate);
      window.removeEventListener('routeOptimizationComplete', invalidate);
      window.removeEventListener('driverTravelModeChanged', onDriverTravelModeChanged);
      window.removeEventListener('polylineUpdated', invalidate);
      window.removeEventListener('polylineCacheCleared', invalidate);
      window.removeEventListener('deliveryCompleted', invalidate);
      window.removeEventListener('deliveryFailed', invalidate);
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
    };
  }, []);

  /* always render polylines on any date; previously gated by current date */

  const lines = [];
  const CURRENT_LEG_COLOR = '#2563EB'; // Blue — always used for Type 1 legs
  const getDriverMode = (driverId) => normalizeTravelMode(localDriverTravelModes[driverId] ?? driverTravelModes[driverId]);
  // Get mode for a specific delivery: use delivery.transport_mode if set, otherwise fall back to driver mode
  const getDeliveryMode = (delivery, driverId) => {
    if (delivery?.transport_mode) return normalizeTravelMode(delivery.transport_mode);
    return getDriverMode(driverId);
  };
  const isCurrentLeg = (stop) => stop?.isNextDelivery === true;
  const isPM = (delivery) => delivery?.ampm_deliveries === 'PM';
  const getDriverRouteStyle = (driverId, opacityOverride, delivery) => {
    const mode = getDeliveryMode(delivery, driverId);
    const base = getTravelModeLineStyle(mode, CURRENT_LEG_COLOR, isPM(delivery));
    return {
      ...base,
      color: isPM(delivery) ? base.color : CURRENT_LEG_COLOR,
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
    if (driversWithCompleteRoute.has(driverId)) return; // Route finished — hide pre-home leg
    if (offDutyDriverIds.has(driverId)) return; // Driver off duty — hide first-stop polyline
    // Route started but no active leg — hide pre-home leg (e.g. driver is between stops)
    if (hasCompleted && !hasIncomplete) return;
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
          if (!segmentPositions || segmentPositions.length < 2) return;
          lines.push(
            <Polyline
              key={`type1-pre-home-line-${driverId}-${getDeliveryMode(next, driverId)}`}
              positions={segmentPositions}
              renderer={rendererReady ? canvasRenderer.current : undefined}
              pathOptions={{
                ...getDriverRouteStyle(driverId, coords ? 0.95 : 0.75, next),
                dashArray: coords ? getDriverRouteStyle(driverId, 0.95, next).dashArray : '8,8'
              }}
              pane="currentLegPane"
            />,
            <RouteDirectionDecorator key={`type1-pre-home-arrow-${driverId}-${getDeliveryMode(next, driverId)}`} positions={segmentPositions} color={CURRENT_LEG_COLOR} pane="currentLegPane" />
          );
        }
      }
    }
  });

  // Render the first active leg in blue using the stored polyline on the next stop
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
    if (driversWithCompleteRoute.has(driverId)) return; // Route finished — hide active leg

    const hasCompleted2 = (stops?.complete?.length || 0) > 0;
    const hasIncomplete2 = (stops?.incomplete?.length || 0) > 0;
    if (hasCompleted2 && !hasIncomplete2) return; // Route finished (dispatcher view) — hide active leg

    const currentStop = [...stops.incomplete]
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0))
      .find((stop) => stop?.isNextDelivery === true) || [...stops.incomplete]
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0))[0];

    if (!currentStop) return;

    // For an off-duty driver, skip the first-stop polyline
    if (offDutyDriverIds.has(driverId)) return;

    // Route complete or no active leg — hide entirely
    if (driversWithCompleteRoute.has(driverId)) return;

    // Route started but driver is no longer in-transit — hide active leg
    const hasCompleted = (stops?.complete?.length || 0) > 0;
    const hasIncomplete = (stops?.incomplete?.length || 0) > 0;
    if (hasCompleted && !hasIncomplete) return;

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
    
    // Determine origin: use previous stop's coordinates, or if no previous, use last completed delivery, then home
    let origin = null;
    if (previousStop) {
      origin = { latitude: Number(previousStop.latitude), longitude: Number(previousStop.longitude) };
    } else if (previousCompleted) {
      origin = { latitude: Number(previousCompleted.latitude), longitude: Number(previousCompleted.longitude) };
    } else if (home) {
      origin = { latitude: Number(home.latitude), longitude: Number(home.longitude) };
    }
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
        renderer={rendererReady ? canvasRenderer.current : undefined}
        pathOptions={{
          ...getDriverRouteStyle(driverId, shouldUseFallback ? 0.75 : 0.95, currentStop),
          dashArray: shouldUseFallback ? '8,8' : getDriverRouteStyle(driverId, 0.95, currentStop).dashArray
        }}
        pane="currentLegPane"
      />,
      <RouteDirectionDecorator
        key={`type1-active-arrow-${driverId}-${currentStop.id}`}
        positions={coords}
        color={CURRENT_LEG_COLOR}
        pane="currentLegPane"
      />
    );
  });

  // Render remaining incomplete legs (after current) in driver's color
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
    if (driversWithCompleteRoute.has(driverId)) return; // Route finished — hide remaining legs

    const hasCompletedR = (stops?.complete?.length || 0) > 0;
    const hasIncompleteR = (stops?.incomplete?.length || 0) > 0;
    if (hasCompletedR && !hasIncompleteR) return; // Route finished (dispatcher view) — hide remaining legs

    const orderedStops = [...stops.incomplete]
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));

    // For a completed route, compute the minimum stop_order across all stops so we can skip stop #1
    const isComplete = driversWithCompleteRoute.has(driverId);
    const allStopsForDriver = isComplete
      ? [...stops.complete, ...stops.incomplete, ...(stops.pending || [])]
      : [];
    const minOrderForDriver = isComplete
      ? Math.min(...allStopsForDriver.map(s => Number(s?.stop_order) || Infinity))
      : Infinity;
    
    // Use isNextDelivery index, but fall back to index 0 if none is flagged yet
    const flaggedIndex = orderedStops.findIndex((stop) => stop?.isNextDelivery === true);
    const currentIndex = flaggedIndex >= 0 ? flaggedIndex : (orderedStops.length > 0 ? 0 : -1);
    
    // Render all legs from isNextDelivery+1 onwards in driver's color
    if (currentIndex >= 0 && currentIndex < orderedStops.length - 1) {
      for (let i = currentIndex + 1; i < orderedStops.length; i++) {
        const prevStop = orderedStops[i - 1];
        const stop = orderedStops[i];
        
        if (!stop) continue;
        // For a completed route, skip the polyline for the first stop
        if (isComplete && (Number(stop.stop_order) || 0) === minOrderForDriver) continue;

        const origin = { latitude: Number(prevStop.latitude), longitude: Number(prevStop.longitude) };
        const destination = { latitude: Number(stop.latitude), longitude: Number(stop.longitude) };
        const driverColor = getPolylineColorForDriver(driverId, stop.driver?.sort_order);
        const key = `remaining-${driverId}-${stop.id}-${i}`;

        let coords = null;
        let shouldUseFallback = false;
        if (typeof stop?.encoded_polyline === 'string' && stop.encoded_polyline.trim()) {
          try {
            coords = decodePolyline(stop.encoded_polyline);
          } catch (_) {}
        }

        if ((!coords || coords.length < 2) && Number.isFinite(origin.latitude) && Number.isFinite(origin.longitude) && Number.isFinite(destination.latitude) && Number.isFinite(destination.longitude)) {
          coords = makeFallback(origin, destination);
          shouldUseFallback = true;
        }

        if (!coords || coords.length < 2 || seenKeys.has(key)) continue;
        seenKeys.add(key);

        const mode = getDeliveryMode(stop, driverId);
        const driverStyle = getTravelModeLineStyle(mode, driverColor, isPM(stop));
        lines.push(
          <Polyline
            key={`type1-remaining-line-${driverId}-${stop.id}-${i}`}
            positions={coords}
            renderer={rendererReady ? canvasRenderer.current : undefined}
            pathOptions={{
              ...driverStyle,
              color: driverColor,
              opacity: shouldUseFallback ? 0.6 : 0.75,
              lineJoin: 'round',
              lineCap: 'round'
            }}
            pane="routeBasePane"
          />,
          <RouteDirectionDecorator
            key={`type1-remaining-arrow-${driverId}-${stop.id}-${i}`}
            positions={coords}
            color={driverColor}
          />
        );
      }
    }
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


  if (!rendererReady) return null;
  return uniqueLines.length ? <>{uniqueLines}</> : null;
}

export default React.memo(HereType1Polylines);