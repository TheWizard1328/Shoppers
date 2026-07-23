/**
 * UnifiedRoutePolylines
 *
 * Single polyline renderer implementing the consolidated route styling rules:
 *
 * ACTIVE ROUTE:
 *   - Finished stops  → no polyline (suppressed)
 *   - Pending stops   → no polyline (suppressed)
 *   - Current leg     → Blue (AM/PM dash pattern via getTravelModeLineStyle)
 *   - Incomplete/non-pending legs → Driver-specific color (or Green for cycling)
 *
 * COMPLETED ROUTE:
 *   - All segments    → Driver-specific color (or Green for cycling), AM/PM dash pattern
 *
 * Replaces: HereType1Polylines, HereType2Polylines, CompletedBreadcrumbPolylines
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import { getTravelModeLineStyle, normalizeTravelMode } from "./travelModeHelpers";
import RouteDirectionDecorator from "./RouteDirectionDecorator";
import { getPolylineColorForDriver } from "../utils/polylineColors";

const FINISHED = ["completed", "failed", "cancelled"];
const CURRENT_LEG_COLOR = "#2563EB";
const CYCLING_COLOR = "#16A34A";

// ── Geometry helpers ─────────────────────────────────────────────────────────
const decodePolyline = (str) => {
  if (!str || typeof str !== "string") return null;
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords.length > 1 ? coords : null;
};

const samePoint = (a, b) =>
  Math.abs(Number(a?.latitude) - Number(b?.latitude)) < 1e-5 &&
  Math.abs(Number(a?.longitude) - Number(b?.longitude)) < 1e-5;

const makeFallback = (a, b) => {
  if (!a || !b) return null;
  const A = [Number(a.latitude), Number(a.longitude)];
  const B = [Number(b.latitude), Number(b.longitude)];
  if (!A.every(isFinite) || !B.every(isFinite)) return null;
  if (samePoint(a, b)) return [A, [A[0] + 0.0003, A[1] + 0.0003]];
  return [A, B];
};

// ── Style helper ─────────────────────────────────────────────────────────────
const getLegStyle = (driverId, stop, legType) => {
  const mode = normalizeTravelMode(stop?.transport_mode);
  const isCycling = mode === "cycling";
  const isPM = stop?.ampm_deliveries === "PM";

  let color;
  if (legType === "current") {
    color = CURRENT_LEG_COLOR;
  } else {
    color = isCycling ? CYCLING_COLOR : getPolylineColorForDriver(driverId);
  }

  const base = getTravelModeLineStyle(mode, color, isPM);
  return {
    ...base,
    color,
    lineJoin: "round",
    lineCap: "round",
  };
};

// ── Component ────────────────────────────────────────────────────────────────
function UnifiedRoutePolylines({
  deliveryMarkers = [],
  pickupMarkers = [],
  allDriverDeliveries = [],
  driverHomeMarkers = [],
  selectedDriverId = null,
  showAll = false,
  appUsers = [],
  driverTravelModes = {},
  selectedDate = null,
}) {
  const map = useMap();
  const canvasRenderer = useRef(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [localDriverTravelModes, setLocalDriverTravelModes] = useState({});

  // Init canvas renderer
  useEffect(() => {
    if (!map || canvasRenderer.current) return;
    const init = () => {
      if (!canvasRenderer.current) {
        canvasRenderer.current = L.canvas({ padding: 0.5, tolerance: 5 });
        setRendererReady(true);
      }
    };
    if (map._loaded) init();
    else { map.once("load", init); return () => map.off("load", init); }
  }, [map]);

  // Event listeners for invalidation
  useEffect(() => {
    const invalidate = () => setRefreshToken((t) => t + 1);
    const onTravelModeChanged = (e) => {
      const { driverId, travelMode } = e?.detail || {};
      if (driverId && travelMode) {
        setLocalDriverTravelModes((prev) => ({ ...prev, [driverId]: travelMode }));
        invalidate();
      }
    };
    const onDeliveriesUpdated = (e) => {
      const detail = e?.detail || {};
      const deliveries = detail.freshDeliveries || detail.deliveries;
      if (
        (Array.isArray(deliveries) && deliveries.some((d) => d?.encoded_polyline || d?.polyline_saved_at)) ||
        detail.triggeredBy === "resetPolylines_chunk" ||
        detail.triggeredBy === "realtimeBufferedFullRefresh"
      ) invalidate();
    };

    const events = [
      ["routeReordered", invalidate],
      ["routeOptimizationComplete", invalidate],
      ["polylineUpdated", invalidate],
      ["polylineCacheCleared", invalidate],
      ["deliveryCompleted", invalidate],
      ["deliveryFailed", invalidate],
      ["driverTravelModeChanged", onTravelModeChanged],
      ["deliveriesUpdated", onDeliveriesUpdated],
    ];
    events.forEach(([ev, fn]) => window.addEventListener(ev, fn));
    return () => events.forEach(([ev, fn]) => window.removeEventListener(ev, fn));
  }, []);

  // Off-duty drivers: suppress their current-leg polyline
  const offDutyDriverIds = useMemo(() => {
    const out = new Set();
    (appUsers || []).forEach((u) => {
      const s = u?.driver_status;
      if (s && s !== "on_duty" && s !== "online") {
        if (u.id) out.add(u.id);
        if (u.user_id) out.add(u.user_id);
      }
    });
    return out;
  }, [appUsers]);

  // Resolve effective travel mode per stop.
  // Use per-stop transport_mode when set; fall back to driver-level preferred mode.
  const getStopMode = (stop, driverId) => {
    if (stop?.transport_mode) return normalizeTravelMode(stop.transport_mode);
    return normalizeTravelMode(localDriverTravelModes[driverId] ?? driverTravelModes[driverId]);
  };

  // ── Per-driver stop classification ───────────────────────────────────────
  const driverStops = useMemo(() => {
    const m = new Map();
    const allStops = [...deliveryMarkers, ...pickupMarkers];
    const scoped =
      !showAll && selectedDriverId && selectedDriverId !== "all"
        ? allStops.filter((s) => s?.driver_id === selectedDriverId)
        : allStops;
    const dated = selectedDate
      ? scoped.filter((s) => !s?.delivery_date || s.delivery_date === selectedDate)
      : scoped;

    dated.forEach((s) => {
      // Cycling markers are visual pins only — exclude them from polyline routing
      if (s?.is_cycling_marker) return;
      if (!s?.driver_id || !isFinite(Number(s.latitude)) || !isFinite(Number(s.longitude))) return;
      if (!m.has(s.driver_id)) m.set(s.driver_id, { complete: [], incomplete: [], pending: [] });
      const bucket = m.get(s.driver_id);
      if (FINISHED.includes(s.status)) bucket.complete.push(s);
      else if (s.status === "in_transit" || s.status === "en_route") bucket.incomplete.push(s);
      else bucket.pending.push(s);
    });
    m.forEach((stops) => {
      stops.incomplete.sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));
      stops.complete.sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));
    });
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliveryMarkers, pickupMarkers, selectedDriverId, showAll, selectedDate, refreshToken]);

  // ── Completed-route detection (authoritative — uses full daily dataset) ──
  const driversWithCompleteRoute = useMemo(() => {
    const out = new Set();
    const dated = selectedDate
      ? allDriverDeliveries.filter((d) => d?.delivery_date === selectedDate)
      : allDriverDeliveries;
    const byDriver = new Map();
    dated.forEach((d) => {
      if (!d?.driver_id) return;
      if (!byDriver.has(d.driver_id)) byDriver.set(d.driver_id, { hasCompleted: false, hasActive: false });
      const e = byDriver.get(d.driver_id);
      if (FINISHED.includes(d.status)) e.hasCompleted = true;
      else if (d.status === "in_transit" || d.status === "en_route" || d.status === "pending") e.hasActive = true;
    });
    byDriver.forEach(({ hasCompleted, hasActive }, id) => {
      if (hasCompleted && !hasActive) out.add(id);
    });
    return out;
  }, [allDriverDeliveries, selectedDate]);

  // ── Build all polyline elements ──────────────────────────────────────────
  const lines = [];
  const seenKeys = new Set();
  const renderer = rendererReady ? canvasRenderer.current : undefined;

  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== "all" && driverId !== selectedDriverId) return;

    const isComplete = driversWithCompleteRoute.has(driverId);

    // ── COMPLETED ROUTE: all stops → driver color or cycling green ───────
    if (isComplete) {
      const allOrdered = [...stops.complete, ...stops.incomplete]
        .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));

      // Skip the very first stop's polyline (encodes home→first-stop, not wanted)
      const minOrder = allOrdered.length > 0 ? (Number(allOrdered[0].stop_order) || 0) : -1;

      allOrdered.forEach((stop, i) => {
        if (i === 0) return; // skip first stop's polyline (home leg)
        if ((Number(stop.stop_order) || 0) === minOrder) return;

        const mode = getStopMode(stop, driverId);
        const isCycling = mode === "cycling";
        const color = isCycling ? CYCLING_COLOR : getPolylineColorForDriver(driverId);
        const isPM = stop.ampm_deliveries === "PM";
        const style = getTravelModeLineStyle(mode, color, isPM);

        let coords = decodePolyline(stop.encoded_polyline);
        let isFallback = false;
        if (!coords && i > 0) {
          const prev = allOrdered[i - 1];
          coords = makeFallback(prev, stop);
          isFallback = true;
        }
        if (!coords) return;

        const key = `completed-${driverId}-${stop.id}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);

        lines.push(
          <Polyline
            key={`unified-completed-line-${driverId}-${stop.id}`}
            positions={coords}
            renderer={renderer}
            pathOptions={{ ...style, color, opacity: isFallback ? 0.5 : 0.75, lineJoin: "round", lineCap: "round" }}
            pane="completedBreadcrumbPane"
          />,
          <RouteDirectionDecorator
            key={`unified-completed-arrow-${driverId}-${stop.id}`}
            positions={coords}
            color={color}
          />
        );
      });
      return;
    }

    // ── ACTIVE ROUTE ─────────────────────────────────────────────────────
    const hasFinished = stops.complete.length > 0;

    // Current leg (blue): from last-finished or home → isNextDelivery stop
    if (!offDutyDriverIds.has(driverId)) {
      const orderedIncomplete = [...stops.incomplete]
        .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));

      const currentStop =
        orderedIncomplete.find((s) => s?.isNextDelivery === true) || orderedIncomplete[0];

      if (currentStop) {
        let originFallback = null;
        if (!hasFinished) {
          const home = driverHomeMarkers.find((h) => h?.driverId === driverId);
          const lat = home && isFinite(Number(home.latitude)) ? Number(home.latitude) : undefined;
          const lon = home && isFinite(Number(home.longitude)) ? Number(home.longitude) : undefined;
          if (lat !== undefined && lon !== undefined) originFallback = { latitude: lat, longitude: lon };
        } else {
          const lastFinished = [...stops.complete].sort((a, b) => {
            const ta = a.actual_delivery_time
              ? new Date(a.actual_delivery_time).getTime()
              : a.updated_date ? new Date(a.updated_date).getTime() : 0;
            const tb = b.actual_delivery_time
              ? new Date(b.actual_delivery_time).getTime()
              : b.updated_date ? new Date(b.updated_date).getTime() : 0;
            return tb - ta;
          })[0];
          if (lastFinished)
            originFallback = {
              latitude: Number(lastFinished.latitude),
              longitude: Number(lastFinished.longitude),
            };
        }

        let coords = decodePolyline(currentStop.encoded_polyline);
        let isFallback = false;
        if (!coords && originFallback) {
          coords = makeFallback(originFallback, currentStop);
          isFallback = true;
        }

        if (coords) {
          const mode = getStopMode(currentStop, driverId);
          const isPM = currentStop.ampm_deliveries === "PM";
          const style = getTravelModeLineStyle(mode, CURRENT_LEG_COLOR, isPM);
          const key = `current-${driverId}-${currentStop.id}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            lines.push(
              <Polyline
                key={`unified-current-line-${driverId}-${currentStop.id}`}
                positions={coords}
                renderer={renderer}
                pathOptions={{
                  ...style,
                  color: CURRENT_LEG_COLOR,
                  opacity: isFallback ? 0.75 : 0.95,
                  dashArray: isFallback ? "8,8" : style.dashArray,
                  lineJoin: "round",
                  lineCap: "round",
                }}
                pane="currentLegPane"
              />,
              <RouteDirectionDecorator
                key={`unified-current-arrow-${driverId}-${currentStop.id}`}
                positions={coords}
                color={CURRENT_LEG_COLOR}
                pane="currentLegPane"
              />
            );
          }
        }
      }
    }

    // Remaining incomplete legs (non-pending, after current stop) → driver color or cycling green
    const orderedIncomplete = [...stops.incomplete]
      .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));
    const currentIdx = orderedIncomplete.findIndex((s) => s?.isNextDelivery === true);
    const startFrom = currentIdx >= 0 ? currentIdx + 1 : (orderedIncomplete.length > 0 ? 1 : 0);

    for (let i = startFrom; i < orderedIncomplete.length; i++) {
      const stop = orderedIncomplete[i];
      const prev = orderedIncomplete[i - 1] || orderedIncomplete[0];
      if (!stop || !prev) continue;

      const mode = getStopMode(stop, driverId);
      const isCycling = mode === "cycling";
      const color = isCycling ? CYCLING_COLOR : getPolylineColorForDriver(driverId);
      const isPM = stop.ampm_deliveries === "PM";
      const style = getTravelModeLineStyle(mode, color, isPM);

      let coords = decodePolyline(stop.encoded_polyline);
      let isFallback = false;
      if (!coords) {
        coords = makeFallback(prev, stop);
        isFallback = true;
      }
      if (!coords) continue;

      const key = `remaining-${driverId}-${stop.id}-${i}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      lines.push(
        <Polyline
          key={`unified-remaining-line-${driverId}-${stop.id}-${i}`}
          positions={coords}
          renderer={renderer}
          pathOptions={{ ...style, color, opacity: isFallback ? 0.5 : 0.75, lineJoin: "round", lineCap: "round" }}
          pane="routeBasePane"
        />,
        <RouteDirectionDecorator
          key={`unified-remaining-arrow-${driverId}-${stop.id}-${i}`}
          positions={coords}
          color={color}
        />
      );
    }
  });

  if (!rendererReady) return null;
  return lines.length ? <>{lines}</> : null;
}

export default React.memo(UnifiedRoutePolylines);