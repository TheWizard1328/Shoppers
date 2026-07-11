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

  // ─── Route path classifier ───────────────────────────────────────────────
  // Path 1: Not started  — no finished stops, active/pending > 0
  //         off-duty → nothing shown; on-duty → blue leg from home → first stop
  // Path 2: Active       — ≥1 finished stop, active/pending > 0
  //         blue leg from most-recently-finished stop → isNextDelivery stop
  // Path 3: Complete     — ≥1 finished stop, active/pending = 0
  //         all legs rendered in driver colour, stop #1 leg hidden
  // ─────────────────────────────────────────────────────────────────────────

  // ── Section 1: Current leg (blue) ────────────────────────────────────────
  // Paths 1 & 2 only.
  // Origin fallback:
  //   Path 1 → home marker coords  (no finished stops yet)
  //   Path 2 → most recently finished stop's coords
  // The encoded_polyline on the isNextDelivery stop is always used first;
  // the origin fallback is only needed when that polyline is absent.
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
    if (offDutyDriverIds.has(driverId)) return;

    const hasFinished = (stops?.complete?.length  || 0) > 0;
    const activeCount = (stops?.incomplete?.length || 0) + (stops?.pending?.length || 0);
    const isComplete  = hasFinished && activeCount === 0; // Path 3

    if (isComplete || activeCount === 0) return; // Path 3 or no stops at all — skip

    // Find the current (next) active stop
    const orderedIncomplete = [...stops.incomplete]
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));
    const currentStop = orderedIncomplete.find((s) => s?.isNextDelivery === true) || orderedIncomplete[0];
    if (!currentStop) return;

    // Resolve origin fallback
    let originFallback = null;
    if (!hasFinished) {
      // Path 1: use home marker
      const home = driverHomeMarkers.find((h) => h && h.driverId === driverId);
      const lat  = home && !Number.isNaN(Number(home.latitude))  ? Number(home.latitude)  : undefined;
      const lon  = home && !Number.isNaN(Number(home.longitude)) ? Number(home.longitude) : undefined;
      if (lat !== undefined && lon !== undefined) originFallback = { latitude: lat, longitude: lon };
    } else {
      // Path 2: use most recently finished stop
      const lastFinished = [...stops.complete].sort((a, b) => {
        const at = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : (a.updated_date ? new Date(a.updated_date).getTime() : 0);
        const bt = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : (b.updated_date ? new Date(b.updated_date).getTime() : 0);
        return bt - at;
      })[0];
      if (lastFinished) originFallback = { latitude: Number(lastFinished.latitude), longitude: Number(lastFinished.longitude) };
    }

    // Decode the stored polyline on the current stop
    const encodedPoly = currentStop?.encoded_polyline;
    let coords = typeof encodedPoly === 'string' && encodedPoly.trim()
      ? (() => { try { return decodePolyline(encodedPoly); } catch (_) { return null; } })()
      : null;

    let shouldUseFallback = false;
    if ((!coords || coords.length < 2) && originFallback) {
      const dest = { latitude: Number(currentStop.latitude), longitude: Number(currentStop.longitude) };
      if (Number.isFinite(originFallback.latitude) && Number.isFinite(originFallback.longitude) &&
          Number.isFinite(dest.latitude) && Number.isFinite(dest.longitude)) {
        coords = makeFallback(originFallback, dest);
        shouldUseFallback = true;
      }
    }

    if (!coords || coords.length < 2) return;

    const key = `current-leg-${driverId}-${currentStop.id}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    lines.push(
      <Polyline
        key={`type1-current-line-${driverId}-${currentStop.id}`}
        positions={coords}
        renderer={rendererReady ? canvasRenderer.current : undefined}
        pathOptions={{
          ...getDriverRouteStyle(driverId, shouldUseFallback ? 0.75 : 0.95, currentStop),
          dashArray: shouldUseFallback ? '8,8' : getDriverRouteStyle(driverId, 0.95, currentStop).dashArray
        }}
        pane="currentLegPane"
      />,
      <RouteDirectionDecorator
        key={`type1-current-arrow-${driverId}-${currentStop.id}`}
        positions={coords}
        color={CURRENT_LEG_COLOR}
        pane="currentLegPane"
      />
    );
  });

  // ── Section C: Remaining / completed-route legs ───────────────────────────
  // Path 1 & 2: render pending legs after the current active stop.
  // Path 3:     render ALL stops' polylines, skipping stop #1 (lowest stop_order).
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;

    const hasFinished  = (stops?.complete?.length  || 0) > 0;
    const activeCount  = (stops?.incomplete?.length || 0) + (stops?.pending?.length || 0);
    const isComplete   = hasFinished && activeCount === 0; // Path 3

    if (isComplete) {
      // ── Path 3: show all stops ordered by stop_order, skip the very first ──
      const allSorted = [...stops.complete, ...stops.incomplete, ...(stops.pending || [])]
        .filter(s => s && Number.isFinite(Number(s.latitude)) && Number.isFinite(Number(s.longitude)))
        .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));

      // Find the minimum stop_order to identify stop #1
      const minOrder = allSorted.length > 0 ? (Number(allSorted[0]?.stop_order) || 0) : null;

      for (let i = 1; i < allSorted.length; i++) {
        const prevStop = allSorted[i - 1];
        const stop     = allSorted[i];
        if (!stop) continue;

        // Skip the polyline that leads INTO stop #1 (the first stop in the route)
        if (minOrder !== null && (Number(stop.stop_order) || 0) === minOrder) continue;

        const driverColor = getPolylineColorForDriver(driverId, stop.driver?.sort_order);
        const key = `complete-${driverId}-${stop.id}-${i}`;
        if (seenKeys.has(key)) continue;

        let coords = null;
        let shouldUseFallback = false;
        if (typeof stop?.encoded_polyline === 'string' && stop.encoded_polyline.trim()) {
          try { coords = decodePolyline(stop.encoded_polyline); } catch (_) {}
        }
        if ((!coords || coords.length < 2)) {
          const origin = { latitude: Number(prevStop.latitude), longitude: Number(prevStop.longitude) };
          const dest   = { latitude: Number(stop.latitude),     longitude: Number(stop.longitude)     };
          if (Number.isFinite(origin.latitude) && Number.isFinite(origin.longitude) &&
              Number.isFinite(dest.latitude)   && Number.isFinite(dest.longitude)) {
            coords = makeFallback(origin, dest);
            shouldUseFallback = true;
          }
        }
        if (!coords || coords.length < 2) continue;
        seenKeys.add(key);

        const mode = getDeliveryMode(stop, driverId);
        const driverStyle = getTravelModeLineStyle(mode, driverColor, isPM(stop));
        lines.push(
          <Polyline
            key={`type1-complete-line-${driverId}-${stop.id}-${i}`}
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
            key={`type1-complete-arrow-${driverId}-${stop.id}-${i}`}
            positions={coords}
            color={driverColor}
          />
        );
      }
      return; // Done for Path 3
    }

    // ── Path 1 & 2: render pending legs after the current active stop ────────
    const orderedStops = [...stops.incomplete]
      .sort((a, b) => (Number(a?.stop_order) || 0) - (Number(b?.stop_order) || 0));

    const flaggedIndex = orderedStops.findIndex((stop) => stop?.isNextDelivery === true);
    const currentIndex = flaggedIndex >= 0 ? flaggedIndex : (orderedStops.length > 0 ? 0 : -1);

    if (currentIndex >= 0 && currentIndex < orderedStops.length - 1) {
      for (let i = currentIndex + 1; i < orderedStops.length; i++) {
        const prevStop = orderedStops[i - 1];
        const stop     = orderedStops[i];
        if (!stop) continue;

        const driverColor = getPolylineColorForDriver(driverId, stop.driver?.sort_order);
        const key = `remaining-${driverId}-${stop.id}-${i}`;
        if (seenKeys.has(key)) continue;

        let coords = null;
        let shouldUseFallback = false;
        if (typeof stop?.encoded_polyline === 'string' && stop.encoded_polyline.trim()) {
          try { coords = decodePolyline(stop.encoded_polyline); } catch (_) {}
        }
        if ((!coords || coords.length < 2)) {
          const origin = { latitude: Number(prevStop.latitude), longitude: Number(prevStop.longitude) };
          const dest   = { latitude: Number(stop.latitude),     longitude: Number(stop.longitude)     };
          if (Number.isFinite(origin.latitude) && Number.isFinite(origin.longitude) &&
              Number.isFinite(dest.latitude)   && Number.isFinite(dest.longitude)) {
            coords = makeFallback(origin, dest);
            shouldUseFallback = true;
          }
        }
        if (!coords || coords.length < 2) continue;
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