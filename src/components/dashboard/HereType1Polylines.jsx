import React, { useEffect, useMemo, useState, useRef } from "react";
import { Polyline } from "react-leaflet";
import { getHerePolyline, ensurePolylineSubscription } from "../utils/hereRouting";

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

export default function HereType1Polylines({
  isViewingCurrentDate,
  deliveryMarkers = [],
  pickupMarkers = [],
  driverHomeMarkers = [],
  currentDriverMarker = null,
  selectedDriverId = null,
  showAll = false,
  driverLocations = [],
}) {
  const [cache, setCache] = useState({});
  const [refreshToken, setRefreshToken] = useState(0);

  // Ensure DriverRoutePolyline subscription is active to hydrate offline DB immediately
  useEffect(() => {
    ensurePolylineSubscription();
  }, []);

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
  const [optimizing, setOptimizing] = useState(false);
  const [lastNonEmptyLines, setLastNonEmptyLines] = useState([]);
  // Clear stale polylines when driver, showAll, or the underlying markers change (e.g. date switch)
  const markerFingerprint = useMemo(() => `${deliveryMarkers.length}_${pickupMarkers.length}_${deliveryMarkers.map(m => m.id).join(',')}`, [deliveryMarkers, pickupMarkers]);
  useEffect(() => { setLastNonEmptyLines([]); setCache({}); }, [selectedDriverId, showAll, markerFingerprint]);
  const requestTimesRef = useRef({});
  const mountTimeRef = useRef(Date.now());

  const driverStops = useMemo(() => {
    const map = new Map();
    const allStops = [...deliveryMarkers, ...pickupMarkers];
    const scopedStops = (!showAll && selectedDriverId && selectedDriverId !== 'all')
      ? allStops.filter(m => m && m.driver_id === selectedDriverId)
      : allStops;

    scopedStops.forEach((m) => {
      if (!m || !m.driver_id || Number.isNaN(Number(m.latitude)) || Number.isNaN(Number(m.longitude))) return;
      if (!map.has(m.driver_id)) map.set(m.driver_id, { complete: [], incomplete: [], pending: [] });
      if (FINISHED.includes(m.status)) map.get(m.driver_id).complete.push(m);
      else if (m.status === "in_transit" || m.status === "en_route") map.get(m.driver_id).incomplete.push(m);
      else if (m.status === "pending") map.get(m.driver_id).pending.push(m);
    });
    
    // Sort incomplete stops by stop_order to ensure we find the true "next" stop
    map.forEach((stops) => {
      stops.incomplete.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
    });
    
    return map;
  }, [deliveryMarkers, pickupMarkers, selectedDriverId, showAll]);

  const driversWithCompleteRoute = useMemo(() => {
    const out = new Set();
    driverStops.forEach((stops, driverId) => {
      const pendingCount = (stops.pending?.length || 0);
      if (stops.incomplete.length === 0 && pendingCount === 0 && stops.complete.length > 0) out.add(driverId);
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
      // Fallback to first incomplete stop if isNextDelivery is not set
      const nextStop = stops.incomplete.find((s) => s.isNextDelivery === true) || stops.incomplete[0];
      if (!lastCompleted || !nextStop) return;

      const originLat = Number(lastCompleted.latitude);
      const originLon = Number(lastCompleted.longitude);

      const key = `here_${Number(originLat).toFixed(5)}_${Number(originLon).toFixed(5)}_${Number(nextStop.latitude).toFixed(5)}_${Number(nextStop.longitude).toFixed(5)}`;
      if (cache[key]) return;
      (async () => {
        const ok = await hydrateFromOffline(key, driverId, { latitude: Number(originLat), longitude: Number(originLon) }, { latitude: Number(nextStop.latitude), longitude: Number(nextStop.longitude) }, lastCompleted.delivery_date);
        if (ok) return;
        const d = Math.floor(Math.random() * 150);
        setTimeout(() => {
          getHerePolyline(
            driverId,
            { latitude: Number(originLat), longitude: Number(originLon) },
            { latitude: Number(nextStop.latitude), longitude: Number(nextStop.longitude) },
            lastCompleted.delivery_date
          ).then((coords) => {
            if (Array.isArray(coords) && coords.length > 1) setCache((p) => ({ ...p, [key]: coords }));
          });
        }, d);
      })();
      });
  }, [isViewingCurrentDate, driverStops, refreshToken]);

  // Prefetch last-completed -> home (for completed routes)
  useEffect(() => {
     if (!isViewingCurrentDate || (Date.now() - mountTimeRef.current < 1200)) return;
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
      const key = `here_${Number(lastCompleted.latitude).toFixed(5)}_${Number(lastCompleted.longitude).toFixed(5)}_${Number(home.latitude).toFixed(5)}_${Number(home.longitude).toFixed(5)}`;
      if (cache[key]) return;
      (async () => {
        const ok = await hydrateFromOffline(key, driverId, { latitude: Number(lastCompleted.latitude), longitude: Number(lastCompleted.longitude) }, { latitude: Number(home.latitude), longitude: Number(home.longitude) }, lastCompleted.delivery_date);
        if (ok) return;
        const d2 = Math.floor(Math.random() * 150);
        setTimeout(() => {
          getHerePolyline(driverId, { latitude: Number(lastCompleted.latitude), longitude: Number(lastCompleted.longitude) }, { latitude: Number(home.latitude), longitude: Number(home.longitude) }, lastCompleted.delivery_date).then((coords) => {
            if (Array.isArray(coords) && coords.length > 1) setCache((p) => ({ ...p, [key]: coords }));
          });
        }, d2);
      })();
      });
  }, [isViewingCurrentDate, driversWithCompleteRoute, driverStops, driverHomeMarkers, refreshToken]);

  // Prefetch home -> first stop for not-yet-started routes (Type 1 pre-route)
  useEffect(() => {
    if (!isViewingCurrentDate || optimizing) return;
    driverStops.forEach((stops, driverId) => {
      const hasCompleted = (stops?.complete?.length || 0) > 0;
      const hasIncomplete = ((stops?.incomplete?.length || 0) > 0);
      if (hasCompleted || !hasIncomplete) return;
      // Pick next from active only
      const next = stops.incomplete.find((s) => s.isNextDelivery === true) || stops.incomplete[0];
      
      const home = driverHomeMarkers.find((h) => h && h.driverId === driverId);
      const live = (currentDriverMarker && (currentDriverMarker.driverId === driverId || currentDriverMarker.driver_id === driverId))
        ? currentDriverMarker
        : (driverLocations || []).find((d) => d && (d.driverId === driverId || d.driver_id === driverId));
      const origin = live || home;
      const originLat = origin && !Number.isNaN(Number(origin.latitude)) ? Number(origin.latitude) : undefined;
      const originLon = origin && !Number.isNaN(Number(origin.longitude)) ? Number(origin.longitude) : undefined;

      if (!next || originLat === undefined || originLon === undefined) return;
      
      const key = `here_${originLat.toFixed(5)}_${originLon.toFixed(5)}_${next.latitude.toFixed(5)}_${next.longitude.toFixed(5)}`;
      if (cache[key]) return;
      (async () => {
        const ok = await hydrateFromOffline(key, driverId, { latitude: originLat, longitude: originLon }, next, next.delivery_date);
        if (ok) return;
        const d = Math.floor(Math.random() * 150);
        setTimeout(() => {
          getHerePolyline(driverId, { latitude: originLat, longitude: originLon }, { latitude: next.latitude, longitude: next.longitude }, next.delivery_date).then((coords) => {
            if (Array.isArray(coords) && coords.length > 1) setCache((p) => ({ ...p, [key]: coords }));
          });
        }, d);
      })();
    });
  }, [isViewingCurrentDate, driverStops, driverHomeMarkers, currentDriverMarker, optimizing, refreshToken]);

  /* always render polylines on any date; previously gated by current date */

  const lines = [];

  // Pre-route: prefer real HERE polyline (home -> first); only show dashed after a short grace period
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
    const hasCompleted = (stops?.complete?.length || 0) > 0;
    const hasIncomplete = (stops?.incomplete?.length || 0) > 0;
    
    // Determine if we should draw the pre-route line (home -> first stop)
    // We draw it if there are NO completed stops AND we have incomplete stops
    // AND the route hasn't "started" in a way that gives us a live GPS location to draw from instead.
    // Wait, if ALL stops are in_transit, hasCompleted is false.
    // We should draw the line from the driver's current live location to the next stop if they are on duty,
    // but Type 1 handles "home -> first" or "last completed -> next".
    // If they are in_transit but have NO completed stops, they are on their way to the first stop.
    // Let's check if we have a current driver marker. If so, we should draw from there instead of home!
    
    if (!hasCompleted && hasIncomplete) {
      // Pick next from active only
      const next = stops.incomplete.find((s) => s.isNextDelivery === true) || stops.incomplete[0];
      
      const home = driverHomeMarkers.find((h) => h && h.driverId === driverId);
      const live = (currentDriverMarker && (currentDriverMarker.driverId === driverId || currentDriverMarker.driver_id === driverId))
        ? currentDriverMarker
        : (driverLocations || []).find((d) => d && (d.driverId === driverId || d.driver_id === driverId));
      const origin = live || home;
      const originLat = origin && !Number.isNaN(Number(origin.latitude)) ? Number(origin.latitude) : undefined;
      const originLon = origin && !Number.isNaN(Number(origin.longitude)) ? Number(origin.longitude) : undefined;

      if (
        next && originLat !== undefined && originLon !== undefined &&
        next.latitude !== undefined && next.longitude !== undefined
      ) {
        const key = `here_${Number(originLat).toFixed(5)}_${Number(originLon).toFixed(5)}_${Number(next.latitude).toFixed(5)}_${Number(next.longitude).toFixed(5)}`;
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
        
        // If it's a live GPS location, we might not want to wait for HERE API and just draw a straight dashed line
        // because the GPS updates frequently. But we'll try to use the cached HERE line if available.
        lines.push(
          <Polyline
            key={`type1-pre-home-${driverId}`}
            positions={coords || makeFallback({ latitude: originLat, longitude: originLon }, next)}
            pathOptions={{ color: coords ? "#2563eb" : '#3b82f6', weight: 5, opacity: coords ? 0.9 : 0.7, dashArray: coords ? '' : '8,8', lineJoin: 'round', lineCap: 'round' }}
            pane="overlayPane"
          />
        );
      }
    }
  });

  // Render last-completed -> next-stop using HERE (fallback straight)
  driverStops.forEach((stops, driverId) => {
    if (!showAll && selectedDriverId && selectedDriverId !== 'all' && driverId !== selectedDriverId) return;
    if (stops.incomplete.length === 0 || stops.complete.length === 0) return;
    const completedSorted = [...stops.complete].sort((a, b) => {
      const at = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : (a.updated_date ? new Date(a.updated_date).getTime() : 0);
      const bt = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : (b.updated_date ? new Date(b.updated_date).getTime() : 0);
      return bt - at;
    });
    const lastCompleted = completedSorted[0];
    // Fallback to first incomplete stop if isNextDelivery is not set
    const nextStop = stops.incomplete.find((s) => s.isNextDelivery === true) || stops.incomplete[0];
    if (!lastCompleted || !nextStop) return;
    const originLat = Number(lastCompleted.latitude);
    const originLon = Number(lastCompleted.longitude);

    const key = `here_${Number(originLat).toFixed(5)}_${Number(originLon).toFixed(5)}_${Number(nextStop.latitude).toFixed(5)}_${Number(nextStop.longitude).toFixed(5)}`;
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

    // If still missing, trigger a fetch once (debounced) to hydrate HERE polyline
    if (!coords && !optimizing) {
      if (Date.now() - mountTimeRef.current < 1200) return;
      const lastReq = requestTimesRef.current[key] || 0;
      const now = Date.now();
      if (now - lastReq > 4000) {
        requestTimesRef.current[key] = now;
        getHerePolyline(
          driverId,
          { latitude: originLat, longitude: originLon },
          { latitude: Number(nextStop.latitude), longitude: Number(nextStop.longitude) },
          nextStop.delivery_date
        ).then((fetched) => {
          if (Array.isArray(fetched) && fetched.length > 1) {
            setCache((p) => ({ ...p, [key]: fetched }));
          }
        }).catch(() => {});
      }
    }
    
    // Always use static last-completed stop as origin for Type 1 segment
    const fallbackLat = originLat;
    const fallbackLon = originLon;

    // Show dashed fallback immediately; HERE polyline will hydrate when ready
    lines.push(
      <Polyline
        key={`type1-next-${driverId}`}
        positions={coords || makeFallback({ latitude: fallbackLat, longitude: fallbackLon }, nextStop)}
        pathOptions={{ color: coords ? "#2563eb" : "#3b82f6", weight: 5, opacity: coords ? 0.9 : 0.7, dashArray: coords ? "" : "8,8", lineJoin: "round", lineCap: "round" }}
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
    const key = `here_${Number(lastCompleted.latitude).toFixed(5)}_${Number(lastCompleted.longitude).toFixed(5)}_${Number(home.latitude).toFixed(5)}_${Number(home.longitude).toFixed(5)}`;
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
        key={`type1-home-${driverId}`}
        positions={coords || makeFallback(lastCompleted, home)}
        pathOptions={{ color: coords ? "#2563eb" : "#3b82f6", weight: 5, opacity: coords ? 0.9 : 0.7, dashArray: coords ? "" : "8,8", lineJoin: "round", lineCap: "round" }}
        pane="overlayPane"
      />
    );
  });

  // Preserve last non-empty set only in multi-driver showAll mode to prevent ghost lines on driver switch
  useEffect(() => { if (lines.length && showAll) setLastNonEmptyLines(lines); }, [lines.length, showAll, refreshToken, deliveryMarkers.length, pickupMarkers.length]);

  return lines.length ? <>{lines}</> : ((showAll && lastNonEmptyLines.length) ? <>{lastNonEmptyLines}</> : null);
}