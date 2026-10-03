import React, { useCallback, useEffect, useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { loadBreadcrumbsForDriver } from "@/components/utils/breadcrumbsManager";
import { getOrFetchHereApiKey } from "@/components/utils/hereApiKeyStore";
import { getInterStoreLocationSync, isInterStoreDelivery } from "@/components/utils/interStoreDisplayName";
import { Loader2, RotateCcw } from "lucide-react";

// ─── HERE Flexible Polyline decode ──────────────────────────────────────────
const HERE_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HERE_DECODER = HERE_ALPHA.split('').reduce((acc, c, i) => { acc[c] = i; return acc; }, {});

function decodeHereFlexiblePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  const values = [];
  let current = 0, shift = 0;
  for (const char of encoded) {
    const value = HERE_DECODER[char];
    if (value == null) return [];
    current |= (value & 0x1f) << shift;
    if (value & 0x20) { shift += 5; continue; }
    values.push(current); current = 0; shift = 0;
  }
  if (shift > 0 || values.length < 2 || values[0] !== 1) return [];
  const header = values[1];
  const precision = header & 15;
  const thirdDimension = (header >> 4) & 7;
  const factor = 10 ** precision;
  const dimension = thirdDimension ? 3 : 2;
  const toSigned = (v) => ((v & 1) ? ~(v >> 1) : (v >> 1));
  let lat = 0, lon = 0;
  const coords = [];
  for (let i = 2; i < values.length; i += dimension) {
    lat += toSigned(values[i]); lon += toSigned(values[i + 1]);
    coords.push([lat / factor, lon / factor]);
  }
  return coords;
}

function encodeGooglePolyline(points) {
  const encodeSigned = (v) => {
    let s = v << 1; if (v < 0) s = ~s;
    let out = '';
    while (s >= 0x20) { out += String.fromCharCode((0x20 | (s & 0x1f)) + 63); s >>= 5; }
    return out + String.fromCharCode(s + 63);
  };
  let lastLat = 0, lastLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5), lngE5 = Math.round(lng * 1e5);
    encoded += encodeSigned(latE5 - lastLat) + encodeSigned(lngE5 - lastLng);
    lastLat = latE5; lastLng = lngE5;
  }
  return encoded;
}

/** Decode a standard 1e5 Google-encoded polyline to [lat, lng] pairs. */
function decodeGooglePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, b;
    do { b = encoded.charCodeAt(index++) - 63; result += (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result += (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

/** Concatenate two encoded polylines into one (dropping the shared joint point). */
function mergeEncodedPolylines(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ca = decodeGooglePolyline(a);
  const cb = decodeGooglePolyline(b);
  if (!ca.length) return cb.length ? b : null;
  if (!cb.length) return a;
  const last = ca[ca.length - 1];
  const rest = (Math.abs(cb[0][0] - last[0]) < 1e-7 && Math.abs(cb[0][1] - last[1]) < 1e-7) ? cb.slice(1) : cb;
  return encodeGooglePolyline(ca.concat(rest));
}

// ── Deviation waypoints (parity with routePolylineGenerator) ────────────────
// Stops may carry `deviation_waypoints` — GPS points recorded by the
// current-leg deviation regen when the driver strayed off the planned leg.
// They are inserted as via waypoints on that stop's inbound leg so the
// Regenerate Polylines button keeps legs snapped to the path actually
// driven. Capped at the 3 most recent points per stop.
const DEVIATION_WAYPOINT_CAP = 3;
function getDeviationWaypoints(delivery) {
  const raw = Array.isArray(delivery?.deviation_waypoints) ? delivery.deviation_waypoints : [];
  return raw
    .filter(p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)))
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
    .map(p => ({ lat: Number(p.lat), lon: Number(p.lng) }))
    .slice(-DEVIATION_WAYPOINT_CAP);
}

/** Build a routing point list with per-stop deviation via chains. */
function buildPointChain(fromPoint, stops) {
  const points = [{ lat: fromPoint.lat, lon: fromPoint.lon }];
  const stopIdxs = [];
  const viaCounts = [];
  const deliveryIds = [];
  stops.forEach(sp => {
    const vias = getDeviationWaypoints(sp.delivery);
    vias.forEach(v => points.push(v));
    viaCounts.push(vias.length);
    stopIdxs.push(points.length);
    deliveryIds.push(sp.deliveryId);
    points.push({ lat: sp.lat, lon: sp.lon });
  });
  return { points, info: { stopIdxs, viaCounts, deliveryIds } };
}

/**
 * Single multi-waypoint HERE Router v8 call.
 * Returns an array of { encoded_polyline, estimated_distance_km, estimated_duration_minutes }
 * — one entry per leg (N points → N-1 legs).
 */
async function callHereMultiStop(points, transportMode, hereApiKey, logCtx = {}, chainInfo = null) {
  const { driverId = null, userName = null } = logCtx || {};
  const valid = (points || []).filter(p => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (valid.length < 2) return [];

  const hereMode = transportMode === 'cycling' ? 'bicycle'
    : transportMode === 'pedestrian' ? 'pedestrian' : 'car';

  const params = new URLSearchParams();
  params.set('apiKey', hereApiKey);
  params.set('transportMode', hereMode);
  params.set('origin', `${valid[0].lat},${valid[0].lon}`);
  params.set('destination', `${valid[valid.length - 1].lat},${valid[valid.length - 1].lon}`);
  params.set('return', 'polyline,summary');
  valid.slice(1, -1).forEach(p => params.append('via', `${p.lat},${p.lon}`));

  const resp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
    signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' }
  });
  const data = await resp.json().catch(() => null);
  const sections = data?.routes?.[0]?.sections || [];

  // Log the API call
  base44.entities.GoogleAPILog.create({
    timestamp: new Date().toISOString(),
    api_type: 'Directions (HERE)',
    purpose: `ResetPolylines — ${valid.length - 1} leg(s), mode=${hereMode}`,
    function_name: 'ResetPolylinesButton',
    user_id: driverId || null,
    user_name: userName || null,
    metadata: { provider: 'HERE', source: 'reset_polylines', call_count: 1 },
  }).catch(() => {});

  // Per-leg results: one entry per consecutive point pair, with fallbacks.
  const perLeg = valid.slice(0, -1).map((fromPt, i) => {
    const sec = sections[i] || {};
    let polyline = null;
    if (typeof sec.polyline === 'string') {
      const coords = decodeHereFlexiblePolyline(sec.polyline);
      if (coords.length > 1) polyline = encodeGooglePolyline(coords);
    }
    if (!polyline && typeof sec.encoded_polyline === 'string') polyline = sec.encoded_polyline;
    if (!polyline) {
      const toPt = valid[i + 1];
      polyline = encodeGooglePolyline([[fromPt.lat, fromPt.lon], [toPt.lat, toPt.lon]]);
    }
    const summary = sec.summary || {};
    return {
      encoded_polyline: polyline,
      estimated_distance_km: summary.length ? Number((summary.length / 1000).toFixed(3)) : null,
      estimated_duration_minutes: summary.duration ? Math.ceil(summary.duration / 60) : null,
    };
  });

  // Legacy mapping (no chain info): caller consumes per-leg entries directly.
  if (!chainInfo) return perLeg;

  // Chain mode: merge each stop's inbound via-chain (deviation waypoints) into
  // a single polyline with summed metrics, so regenerated legs on completed
  // routes respect the path actually driven.
  const { stopIdxs = [], viaCounts = [], deliveryIds = [] } = chainInfo;
  return stopIdxs.map((stopIdx, j) => {
    const viaCount = Number(viaCounts[j]) || 0;
    const chain = perLeg.slice(Math.max(0, stopIdx - 1 - viaCount), stopIdx).filter(Boolean);
    if (!chain.length) {
      return { deliveryId: deliveryIds[j], encoded_polyline: null, estimated_distance_km: null, estimated_duration_minutes: null };
    }
    const encoded = chain.length === 1
      ? (chain[0].encoded_polyline || null)
      : chain.reduce((acc, sec) => mergeEncodedPolylines(acc, sec?.encoded_polyline || null), null);
    const dist = chain.reduce((sum, sec) => sum + (Number(sec?.estimated_distance_km) || 0), 0);
    const dur = chain.reduce((sum, sec) => sum + (Number(sec?.estimated_duration_minutes) || 0), 0);
    return {
      deliveryId: deliveryIds[j],
      encoded_polyline: encoded,
      estimated_distance_km: chain.some(sec => sec?.estimated_distance_km != null) ? Number(dist.toFixed(3)) : null,
      estimated_duration_minutes: chain.some(sec => sec?.estimated_duration_minutes != null) ? Math.ceil(dur) : null,
    };
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Resolve the destination coords for a delivery record. */
async function resolveStopCoords(delivery, patientMap, storeMap) {
  if (!delivery) return null;

  // Cycling markers carry their own GPS fields
  if (delivery.is_cycling_marker) {
    const lat = Number(delivery.cycling_latitude);
    const lng = Number(delivery.cycling_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0)
      return { latitude: lat, longitude: lng };
    return null;
  }

  // InterStore stops (ISP/ISD) — resolve coords directly from the delivery_id.
  // The delivery_id encodes the phone number identifying the InterStoreLocation.
  // getInterStoreLocationSync handles ISP vs ISD prefix automatically.
  if (!delivery.patient_id && isInterStoreDelivery(delivery.delivery_id)) {
    const loc = getInterStoreLocationSync(delivery.delivery_id);
    if (loc) {
      const lat = Number(loc.store_latitude);
      const lng = Number(loc.store_longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0))
        return { latitude: lat, longitude: lng };
    }
  }

  // Patient stop
  if (delivery.patient_id) {
    const patient = patientMap.get(delivery.patient_id);
    if (patient?.latitude != null && patient?.longitude != null)
      return { latitude: Number(patient.latitude), longitude: Number(patient.longitude) };
    return null;
  }

  // Pickup / store stop
  const store = storeMap.get(delivery.store_id);
  if (store?.latitude != null && store?.longitude != null)
    return { latitude: Number(store.latitude), longitude: Number(store.longitude) };

  return null;
}

/** Small delay so the browser can paint between API calls. */
const tick = (ms = 250) => new Promise(r => setTimeout(r, ms));

// ─── component ────────────────────────────────────────────────────────────────

export default function ResetPolylinesButton({
  selectedDriverIds = [],
  selectedDate,
  selectedPolylineOption = 'polylines',
  mode = "inline",
  disabled = false,
  className = "",
  appUsers = [],
  onBreadcrumbsReloaded,
}) {
  const [isResetting, setIsResetting] = useState(false);

  const driverIds = useMemo(() => {
    return Array.from(new Set((selectedDriverIds || []).filter(Boolean).filter(id => id !== "all")));
  }, [selectedDriverIds]);

  // ── Breadcrumb coverage badge (sealed/total stops) ─────────────────────────
  // Shows "16/20" under the button — how many of the route's stops already have
  // a sealed breadcrumb path (saved_to_route = true) vs. the total stop count.
  // Full coverage means a regenerate run applies only breadcrumb paths.
  const [coverage, setCoverage] = useState(null); // { sealed, total }
  const driverIdsKey = driverIds.join(',');

  const loadCoverage = useCallback(async () => {
    if (selectedPolylineOption !== 'polylines' || !selectedDate || !driverIdsKey) {
      setCoverage(null);
      return;
    }
    let sealed = 0;
    let total = 0;
    for (const driverId of driverIdsKey.split(',').filter(Boolean)) {
      try {
        const [rawDeliveries, segments] = await Promise.all([
          base44.entities.Delivery.filter(
            { driver_id: driverId, delivery_date: selectedDate },
            'stop_order',
            5000
          ).catch(() => []),
          (async () => {
            // Offline DB first for speed, API fallback
            try {
              const offlineSegs = await offlineDB.getByCompoundIndex(
                offlineDB.STORES.DELIVERY_BREADCRUMBS,
                'date_driver',
                [selectedDate, driverId]
              );
              if (offlineSegs && offlineSegs.length) return offlineSegs;
            } catch (_) {}
            return await base44.entities.DeliveryBreadcrumbs.filter({
              driver_id: driverId,
              delivery_date: selectedDate,
            }).catch(() => []);
          })(),
        ]);
        const stops = (rawDeliveries || []).filter(d => d && d.status !== 'cancelled');
        total += stops.length;
        // Match by linked_delivery_id first (stable across stop_order renumbers,
        // Oct 2 2026 fix); legacy segments with no linked id fall back to stop_order.
        const sealedSegs = (segments || []).filter(seg => seg && seg.encoded_polyline && seg.stop_order !== -1 && seg.saved_to_route === true);
        const sealedDeliveryIds = new Set(sealedSegs.filter(seg => seg.linked_delivery_id).map(seg => seg.linked_delivery_id));
        const sealedOrders = new Set(sealedSegs.filter(seg => !seg.linked_delivery_id).map(seg => Number(seg.stop_order)));
        sealed += stops.filter(d => sealedDeliveryIds.has(d.id) || sealedOrders.has(Number(d.stop_order))).length;
      } catch (_) {}
    }
    setCoverage({ sealed, total });
  }, [selectedPolylineOption, selectedDate, driverIdsKey]);

  useEffect(() => { loadCoverage(); }, [loadCoverage]);

  // Live-refresh the coverage badge when a breadcrumb gets sealed to a stop
  // (PolylineViewer's "auto-save" / manual save actions) — only when the
  // saved crumb's driver + date match what this button is currently showing,
  // so an admin sealing a crumb on the Admin Utilities page immediately
  // bumps the dashboard's sealed/total count without a manual refresh.
  useEffect(() => {
    const handler = (e) => {
      const detail = e?.detail || {};
      if (!detail.driverId || !detail.deliveryDate) return;
      const driverMatch = driverIdsKey.split(',').filter(Boolean).includes(detail.driverId);
      const dateMatch = detail.deliveryDate === selectedDate;
      if (driverMatch && dateMatch) loadCoverage();
    };
    window.addEventListener('breadcrumbSavedToDelivery', handler);
    return () => window.removeEventListener('breadcrumbSavedToDelivery', handler);
  }, [driverIdsKey, selectedDate, loadCoverage]);

  // ── WebSocket-driven refresh (OTHER devices) ─────────────────────────────
  // realtimeSync subscribes to DeliveryBreadcrumbs and re-dispatches each WS
  // event as 'realtimeUpdate_DeliveryBreadcrumbs'. When a breadcrumb seal
  // (saved_to_route) lands from ANOTHER device, refresh the coverage badge
  // here too — debounced so a bulk seal pass (one event per stop) coalesces
  // into a single coverage reload.
  useEffect(() => {
    let timer = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; loadCoverage(); }, 750);
    };
    const handler = (e) => {
      const d = e?.detail?.data || {};
      const drivers = driverIdsKey.split(',').filter(Boolean);
      const driverMatch = d.driver_id && drivers.includes(d.driver_id);
      const dateMatch = d.delivery_date === selectedDate;
      if (driverMatch && dateMatch) schedule();
    };
    window.addEventListener('realtimeUpdate_DeliveryBreadcrumbs', handler);
    return () => {
      window.removeEventListener('realtimeUpdate_DeliveryBreadcrumbs', handler);
      if (timer) clearTimeout(timer);
    };
  }, [driverIdsKey, selectedDate, loadCoverage]);

  // ── MODE B: Breadcrumb slicing ────────────────────────────────────────────
  const runBreadcrumbMode = async (driverId) => {
    // 1. Pull fresh records so consolidateBreadcrumbs sees the latest master timeline
    const onlineBreadcrumbs = await base44.entities.DeliveryBreadcrumbs.filter({
      driver_id: driverId,
      delivery_date: selectedDate,
    });
    if (Array.isArray(onlineBreadcrumbs) && onlineBreadcrumbs.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERY_BREADCRUMBS, onlineBreadcrumbs);
    }

    // 2. Re-slice all stops from the master trail (does NOT touch delivery polylines)
    const response = await base44.functions.invoke('consolidateBreadcrumbs', {
      driver_id: driverId,
      delivery_date: selectedDate,
    });
    const result = response?.data || response || {};
    if (!result.success && !result.skipped) {
      throw new Error(result.error || 'Breadcrumb resegmentation failed');
    }

    // 3. Sync fresh slices back to offline DB
    const freshSegments = await base44.entities.DeliveryBreadcrumbs.filter({
      driver_id: driverId,
      delivery_date: selectedDate,
    });
    if (Array.isArray(freshSegments) && freshSegments.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERY_BREADCRUMBS, freshSegments);
    }

    // 4. Reload breadcrumbs into map state (UI-only, no DB write)
    try {
      const reloaded = await loadBreadcrumbsForDriver(driverId, selectedDate, appUsers);
      onBreadcrumbsReloaded?.(driverId, reloaded);
    } catch (_) {}

    return result;
  };

  // ── MODE A: Pure polyline regeneration (three passes) ────────────────────
  const runPolylineMode = async (driverId) => {
    // ── Fetch all data needed for coordinate resolution ──────────────────────
    const [rawDeliveries, driverAppUsers] = await Promise.all([
      base44.entities.Delivery.filter(
        { driver_id: driverId, delivery_date: selectedDate },
        'stop_order',
        5000
      ),
      base44.entities.AppUser.filter({ user_id: driverId }, '-updated_date', 1),
    ]);

    const deliveries = (rawDeliveries || []).filter(Boolean);
    if (deliveries.length === 0) {
      throw new Error('No route stops found for this driver and date');
    }

    // Sort deliveries by stop_order (already fetched sorted, but be explicit)
    const sorted = [...deliveries].sort((a, b) =>
      (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0)
    );

    // ── Breadcrumb coverage check ──────────────────────────────────────────
    // Fetch breadcrumb segments FIRST. If EVERY stop on this driver's route
    // already has a sealed breadcrumb segment (saved_to_route = true with a
    // polyline), the actual driven path IS the route — apply only the
    // breadcrumb polylines and skip HERE polyline regeneration entirely.
    let breadcrumbSegments = [];
    try {
      // Try offline DB first for speed
      const offlineSegs = await offlineDB.getByCompoundIndex(
        offlineDB.STORES.DELIVERY_BREADCRUMBS,
        'date_driver',
        [selectedDate, driverId]
      );
      breadcrumbSegments = offlineSegs || [];
    } catch (_) {
      // Fallback to API
      try {
        breadcrumbSegments = await base44.entities.DeliveryBreadcrumbs.filter({
          driver_id: driverId,
          delivery_date: selectedDate,
        });
      } catch (_2) {}
    }

    // Sealed = non-master-timeline segments confirmed as the authoritative
    // driven path for a stop (they override any regenerated polyline).
    const masterStopOrder = -1;
    const sealedBreadcrumbs = (breadcrumbSegments || []).filter(seg =>
      seg &&
      seg.encoded_polyline &&
      seg.stop_order !== masterStopOrder &&
      seg.saved_to_route === true
    );
    // OWNER BUG (Oct 2 2026): matching sealed breadcrumbs to deliveries by
    // stop_order alone breaks the moment stop_order gets renumbered after the
    // segment was sealed (repairStopOrders runs after ANY stop edit/delete/
    // create/optimization) — the saved path then either attaches to the WRONG
    // delivery now sitting at that number, or finds no match at all and the
    // full HERE regeneration below silently overwrote/cleared it. Match by
    // the stable linked_delivery_id first; only legacy pre-migration segments
    // (no linked_delivery_id) fall back to stop_order.
    const sealedByDeliveryId = new Map(sealedBreadcrumbs.filter(seg => seg.linked_delivery_id).map(seg => [seg.linked_delivery_id, seg]));
    const sealedByStopOrder = new Map(sealedBreadcrumbs.filter(seg => !seg.linked_delivery_id).map(seg => [Number(seg.stop_order), seg]));
    const findSealedFor = (delivery) => sealedByDeliveryId.get(delivery.id) || sealedByStopOrder.get(Number(delivery.stop_order)) || null;
    // Route stops needing a polyline: every non-cancelled stop on the route.
    const routeStops = sorted.filter(d => d.status !== 'cancelled');
    const allStopsSealed = routeStops.length > 0 && routeStops.every(d => !!findSealedFor(d));
    if (allStopsSealed) {
      console.log(`[ResetPolylinesButton] all ${routeStops.length} route stops have sealed breadcrumb segments — breadcrumb-only mode`);
    } else {
      const sealedCount = routeStops.filter(d => !!findSealedFor(d)).length;
      console.log(`[ResetPolylinesButton] breadcrumb coverage ${sealedCount}/${routeStops.length} stops — full polyline regeneration`);
    }

    // Gather all patient_ids and store_ids we need
    const patientIds = [...new Set(deliveries.map(d => d.patient_id).filter(Boolean))];
    const storeIds = [...new Set(deliveries.map(d => d.store_id).filter(Boolean))];

    const [patients, stores] = await Promise.all([
      patientIds.length > 0
        ? base44.entities.Patient.filter({ id: { $in: patientIds } }, undefined, 5000).catch(() => [])
        : Promise.resolve([]),
      storeIds.length > 0
        ? base44.entities.Store.filter({ id: { $in: storeIds } }, undefined, 500).catch(() => [])
        : Promise.resolve([]),
    ]);

    const patientMap = new Map((patients || []).filter(Boolean).map(p => [p.id, p]));
    const storeMap = new Map((stores || []).filter(Boolean).map(s => [s.id, s]));
    const driverAppUser = driverAppUsers?.[0] || null;
    const driverUserName = driverAppUser?.user_name || null;
    const polylineLogCtx = { driverId, userName: driverUserName };

    // Home position as route origin for pass 1
    const homePosition = (() => {
      const lat = Number(driverAppUser?.home_latitude);
      const lon = Number(driverAppUser?.home_longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0)
        return { latitude: lat, longitude: lon };
      return null;
    })();

    // Get HERE API key (skipped in breadcrumb-only mode)
    let hereApiKey = null;
    if (!allStopsSealed) {
      try { hereApiKey = await getOrFetchHereApiKey(); } catch (_) {}
    }

    // Collect updates — we'll batch-write at the end of each pass
    const pendingUpdates = new Map(); // deliveryId → partial update object

    const mergeUpdate = (id, fields) => {
      pendingUpdates.set(id, { ...(pendingUpdates.get(id) || {}), ...fields });
    };

    // Full breadcrumb coverage — apply ONLY the sealed driven paths.
    if (allStopsSealed) {
      for (const d of routeStops) {
        const seg = findSealedFor(d);
        if (!seg) continue;
        mergeUpdate(d.id, {
          encoded_polyline: seg.encoded_polyline,
          ...(seg.transport_mode ? { transport_mode: seg.transport_mode } : {}),
        });
      }
    }

    // ── PASS 1: Driving baseline — SINGLE multi-waypoint HERE call ──────────
    // Build ordered point list: home (if set) + all stops in stop_order.
    // One API call covers every leg. Cycling legs will be overwritten in Pass 2.
    // SKIPPED in breadcrumb-only mode (all stops already sealed).
    if (allStopsSealed) {
      console.log(`[ResetPolylinesButton] skipping PASS 1 — all stops sealed with breadcrumbs`);
    } else {
      console.log(`[ResetPolylinesButton] PASS 1 — driving baseline, ${sorted.length} stops (1 API call)`);
    }

    if (!allStopsSealed && hereApiKey) {
      // Build waypoint list: origin first, then each stop in order
      const originPoint = homePosition
        ? { lat: homePosition.latitude, lon: homePosition.longitude }
        : null;

      const stopPoints = (await Promise.all(sorted.map(async d => {
        const c = await resolveStopCoords(d, patientMap, storeMap);
        return c ? { lat: c.latitude, lon: c.longitude, deliveryId: d.id, delivery: d } : null;
      }))).filter(Boolean);

      if (stopPoints.length >= 2) {
        // Insert each stop's deviation_waypoints as vias on its inbound leg so
        // the regenerated polylines keep the path actually driven.
        const chain = originPoint
          ? buildPointChain(originPoint, stopPoints)
          : buildPointChain(stopPoints[0], stopPoints.slice(1));
        const deviaTotal = chain.info.viaCounts.reduce((sum, n) => sum + n, 0);
        console.log(`[ResetPolylinesButton] Pass 1 — ${chain.points.length} routing points (${deviaTotal} deviation via(s))`);
        try {
          const results = await callHereMultiStop(chain.points, 'driving', hereApiKey, polylineLogCtx, chain.info);
          results.forEach(r => {
            if (!r?.deliveryId || !r?.encoded_polyline) return;
            mergeUpdate(r.deliveryId, {
              encoded_polyline: r.encoded_polyline,
              transport_mode: 'driving',
              ...(r.estimated_distance_km != null ? { estimated_distance_km: r.estimated_distance_km } : {}),
              ...(r.estimated_duration_minutes != null ? { estimated_duration_minutes: r.estimated_duration_minutes } : {}),
            });
          });
        } catch (err) {
          console.warn(`[ResetPolylinesButton] Pass 1 multi-stop HERE call failed:`, err?.message || err);
        }
      }
    }

    // ── PASS 2: Cycling loop patching — ONE call per cycling loop ────────────
    // Find Start/End marker pairs and re-polyline each loop in a single HERE call (bicycle mode).
    const cyclingMarkers = sorted.filter(d => d.is_cycling_marker);

    if (!allStopsSealed && cyclingMarkers.length >= 2 && hereApiKey) {
      const startMarkers = cyclingMarkers.filter(m =>
        (m.delivery_notes || '').toLowerCase().includes('start')
      );
      const endMarkers = cyclingMarkers.filter(m =>
        (m.delivery_notes || '').toLowerCase().includes('end')
      );

      console.log(`[ResetPolylinesButton] PASS 2 — ${startMarkers.length} cycling loop(s), 1 API call each`);

      // Process each loop independently — each is ONE multi-waypoint cycling call
      for (const startMarker of startMarkers) {
        const matchingEnd = endMarkers.find(e =>
          Number(e.stop_order) > Number(startMarker.stop_order)
        );
        if (!matchingEnd) continue;

        const loopStops = sorted.filter(d =>
          Number(d.stop_order) >= Number(startMarker.stop_order) &&
          Number(d.stop_order) <= Number(matchingEnd.stop_order)
        );
        if (loopStops.length < 2) continue;

        console.log(`[ResetPolylinesButton] Pass 2 — cycling loop: ${loopStops.length} stops → 1 HERE call`);

        // Build waypoints for this loop: stop[0] → stop[1] → ... → stop[N-1]
        const loopPoints = (await Promise.all(loopStops.map(async d => {
          const c = await resolveStopCoords(d, patientMap, storeMap);
          return c ? { lat: c.latitude, lon: c.longitude, deliveryId: d.id, delivery: d } : null;
        }))).filter(Boolean);

        if (loopPoints.length < 2) continue;

        // Deviation-aware loop chain: stop[0] → (deviation vias) → stop[1] → ...
        const chain = buildPointChain(loopPoints[0], loopPoints.slice(1));
        try {
          const results = await callHereMultiStop(chain.points, 'cycling', hereApiKey, polylineLogCtx, chain.info);
          results.forEach(r => {
            if (!r?.deliveryId || !r?.encoded_polyline) return;
            mergeUpdate(r.deliveryId, {
              encoded_polyline: r.encoded_polyline,
              transport_mode: 'cycling',
            });
          });
        } catch (err) {
          console.warn(`[ResetPolylinesButton] Pass 2 cycling loop call failed:`, err?.message || err);
        }
      }
    } else {
      console.log(`[ResetPolylinesButton] PASS 2 — no cycling markers found, skipping`);
    }

    // ── PASS 3: Breadcrumb override ─────────────────────────────────────────
    // For any DeliveryBreadcrumbs record where saved_to_route is falsy,
    // overwrite the delivery's encoded_polyline with the actual breadcrumb path
    // and mark saved_to_route = true on the breadcrumb record.
    console.log(`[ResetPolylinesButton] PASS 3 — breadcrumb override`);

    // Breadcrumb segments were fetched up front for the coverage check — reuse.
    // pendingBreadcrumbs = sealed, non-master-timeline segments with a polyline.
    // These are breadcrumbs already confirmed as the authoritative path for a
    // stop — they override the driving baseline polyline written in Pass 1.
    const pendingBreadcrumbs = sealedBreadcrumbs;

    console.log(`[ResetPolylinesButton] Pass 3 — ${pendingBreadcrumbs.length} unsaved breadcrumb segments to apply`);

    const breadcrumbsToSeal = [];

    for (const d of sorted) {
      if (d.status === 'cancelled') continue;
      // Match by linked_delivery_id FIRST (stable across stop_order
      // renumbers) — stop_order fallback only for legacy un-migrated segments.
      const seg = sealedByDeliveryId.get(d.id) || sealedByStopOrder.get(Number(d.stop_order));
      if (!seg) continue;

      mergeUpdate(d.id, {
        encoded_polyline: seg.encoded_polyline,
        ...(seg.transport_mode ? { transport_mode: seg.transport_mode } : {}),
      });

      breadcrumbsToSeal.push(seg);
    }

    // ── WRITE BATCH: push all delivery updates ────────────────────────────
    const updateEntries = Array.from(pendingUpdates.entries());
    console.log(`[ResetPolylinesButton] Writing ${updateEntries.length} delivery updates`);

    if (updateEntries.length > 0) {
      // Write in chunks of 10 to avoid hammering the API
      const CHUNK = 10;
      for (let i = 0; i < updateEntries.length; i += CHUNK) {
        const chunk = updateEntries.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map(([id, data]) => base44.entities.Delivery.update(id, data).catch(err => {
            console.warn(`[ResetPolylinesButton] Delivery update failed for ${id}:`, err?.message || err);
          }))
        );
        await tick(100);
      }
    }

    // No sealing needed — Pass 3 only reads already-sealed (saved_to_route=true) records.

    // ── Sync fresh deliveries to offline DB and dispatch UI update ────────
    const freshDeliveries = await base44.entities.Delivery.filter(
      { driver_id: driverId, delivery_date: selectedDate },
      'stop_order',
      5000
    ).catch(() => []);

    if ((freshDeliveries || []).length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
    }

    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: {
        driverId,
        deliveryDate: selectedDate,
        triggeredBy: 'resetPolylines_complete',
        freshDeliveries: freshDeliveries || undefined,
        deliveries: freshDeliveries || undefined,
        fullReplacement: false,
        immediate: true,
        preserveLocalState: false,
      }
    }));

    return {
      deliveriesUpdated: updateEntries.length,
      breadcrumbsSealed: breadcrumbsToSeal.length,
    };
  };

  // ── Main handler ──────────────────────────────────────────────────────────
  const handleReset = async () => {
    if (isResetting || disabled || driverIds.length === 0 || !selectedDate) return;

    setIsResetting(true);
    smartRefreshManager.pause();
    window.dispatchEvent(new CustomEvent('polylineGenerationStarted', { detail: { isRegenerate: true } }));

    const isBreadcrumbMode = selectedPolylineOption === 'breadcrumbs';
    const breadcrumbResults = [];

    try {
      for (const driverId of driverIds) {
        try {
          if (isBreadcrumbMode) {
            // ── Mode B: Breadcrumb slicing only ─────────────────────────
            const result = await runBreadcrumbMode(driverId);
            breadcrumbResults.push({
              driverId,
              stopsSliced: Number(result?.stops_sliced || 0),
              stopsSkipped: Number(result?.stops_skipped || 0),
              skipped: !!result?.skipped,
              skipReason: result?.reason || null,
            });
          } else {
            // ── Mode A: Three-pass polyline regeneration ─────────────────
            const result = await runPolylineMode(driverId);
            console.log(`[ResetPolylinesButton] Mode A complete for ${driverId}:`, result);
          }
        } catch (err) {
          console.warn(`[ResetPolylinesButton] Failed for driver ${driverId}:`, err?.message || err);
          toast({
            title: 'Polyline regeneration failed',
            description: err?.message || 'An error occurred.',
            variant: 'destructive',
          });
        }

        // Brief pause between drivers
        if (driverIds.length > 1) await tick(500);
      }

      if (isBreadcrumbMode) {
        const totalSliced = breadcrumbResults.reduce((s, r) => s + r.stopsSliced, 0);
        const totalSkipped = breadcrumbResults.reduce((s, r) => s + r.stopsSkipped, 0);
        const allSkipped = breadcrumbResults.every(r => r.skipped);
        toast({
          title: allSkipped ? 'No master timeline found' : 'Breadcrumb resegmentation complete',
          description: allSkipped
            ? 'No master GPS timeline record exists for this driver/date.'
            : `${totalSliced} stop${totalSliced === 1 ? '' : 's'} resegmented • ${totalSkipped} skipped`,
        });
      } else {
        toast({
          title: 'Polylines regenerated',
          description: `Route polylines updated for ${driverIds.length} driver${driverIds.length === 1 ? '' : 's'}.`,
        });
      }
    } finally {
      smartRefreshManager.restart();
      setIsResetting(false);
      window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'reset_polylines' } }));
      loadCoverage(); // refresh the sealed/total badge
    }
  };

  if (mode === "fab") {
    return (
      <Button
        onClick={handleReset}
        disabled={disabled || isResetting || driverIds.length === 0}
        title="Reset and update all polylines"
        aria-label="Reset and update all polylines"
        className={`inline-flex items-center justify-center h-10 w-10 rounded-lg shadow-2xl p-0 transition-all duration-200 bg-slate-700 hover:bg-slate-800 ${className}`}
        style={{ pointerEvents: "auto", touchAction: "manipulation" }}
      >
        {isResetting
          ? <Loader2 className="w-5 h-5 text-white animate-spin" />
          : <RotateCcw className="w-5 h-5 text-white" />}
      </Button>
    );
  }

  const showCoverage = selectedPolylineOption === 'polylines' && coverage && coverage.total > 0;
  const coverageComplete = coverage && coverage.sealed === coverage.total;

  return (
    <div className="flex flex-col items-center select-none">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleReset}
        disabled={disabled || isResetting || driverIds.length === 0}
        className={`h-8 gap-2 ${className} text-body bg-surface`} style={{ borderColor: "var(--border-slate-300)" }}
        title={showCoverage
          ? `Refresh polylines — ${coverage.sealed}/${coverage.total} stops saved from breadcrumbs`
          : "Refresh polylines"}
      >
        {isResetting
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <RotateCcw className="w-3.5 h-3.5" />}
      </Button>
      {showCoverage && (
        <span
          className={`text-[9px] leading-none font-medium mt-0.5 whitespace-nowrap ${coverageComplete ? 'text-emerald-600' : 'text-slate-400'}`}
          title={`${coverage.sealed} of ${coverage.total} route stops saved from breadcrumbs`}
        >
          {coverage.sealed}/{coverage.total}
        </span>
      )}
    </div>
  );
}