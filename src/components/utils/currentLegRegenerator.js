/**
 * currentLegRegenerator — scoped deviation recovery for the CURRENT leg only.
 *
 * Built Sep 17 2026 at the owner's request: when route deviation is detected,
 * regenerate ONLY the current leg (origin → live GPS → next stop) instead of
 * re-running the full coordinator (which re-cut every remaining leg's polyline
 * with a multi-stop Directions call). One two-to-three point Directions call,
 * one single-delivery write — much quicker than the full-route re-render.
 *
 * What it mirrors from clientRouteEngine (single source of truth for both):
 *   - Polyline origin: most recent finished stop (time-based sort:
 *     actual_delivery_time || updated_date || created_date), else driver home.
 *     NEVER the live GPS as origin.
 *   - Live-GPS via-point: injected right after the origin when the driver is
 *     off the anchor (> 100m from origin) — the leg bends through the driver's
 *     actual position; the next stop's ETA/distance use the GPS→stop portion
 *     only (generateRoutePolylines handles the via split + stitch).
 *   - Winter-mode duration padding + provider resolution: both live inside
 *     generateRoutePolylines / the key stores — no duplication here.
 *
 * What it deliberately does NOT touch: stop_order, status, isNextDelivery, and
 * every OTHER stop's polyline/ETA. Those remain as the last full optimization
 * left them (still valid — the route sequence didn't change, the driver just
 * took a detour). The next full regen (completion, FAB, route finish) refreshes
 * everything as usual.
 *
 * Maps API usage log: passes logPurpose so the call shows up as
 * 'Route Deviation (Google Directions) — Current Route Leg' instead of the
 * generic 'Polyline generation' label.
 */
import { base44 } from '@/api/base44Client';
import { haversineKm } from './geoUtils';
import { generateRoutePolylines } from './routePolylineGenerator';
import { getDeliveryCoords, getLatestFinishedDelivery } from './clientRouteEngine';
import { getOrFetchRoutingKey } from './routingKeyStore';
import { getOrFetchHereApiKey } from './hereApiKeyStore';
import { getOrFetchPolylineConfig } from './polylineKeyStore';
import { updateDelivery } from './entityMutations';

const TIME_ZONE = 'America/Edmonton';
export const DEVIATION_REGEN_LOG_PURPOSE = 'Route Deviation (Google Directions) — Current Route Leg';

// ── Deviation waypoint persistence (Sep 17 2026) ────────────────────────────
// Each successful current-leg deviation regen records the driver's position at
// the deviation onto the stop's `deviation_waypoints`. Later polyline regenerations
// (manual re-optimization mid-route, admin regenerate on completed routes) insert
// these as via waypoints via generateRoutePolylines so the leg stays snapped to
// the path actually driven instead of reverting to the theoretical route.
const DEVIATION_WAYPOINT_CAP = 3;      // keep the 3 most recent points per leg
const DEVIATION_DEDUPE_KM = 0.1;       // skip points within 100m of an existing one

function buildUpdatedDeviationWaypoints(existingWaypoints, gps) {
  const existing = (Array.isArray(existingWaypoints) ? existingWaypoints : [])
    .filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
  // Dedupe: jitter near an already-recorded point is not a new deviation.
  const isNearExisting = existing.some((p) => haversineKm(Number(p.lat), Number(p.lng), gpsPointLat(gps), gpsPointLon(gps)) <= DEVIATION_DEDUPE_KM);
  if (isNearExisting) {
    return existing.length > 0 ? existing.slice(-DEVIATION_WAYPOINT_CAP) : [];
  }
  const next = [...existing, { lat: gpsPointLat(gps), lng: gpsPointLon(gps), timestamp: new Date().toISOString() }];
  return next.slice(-DEVIATION_WAYPOINT_CAP);
}

const gpsPointLat = (gps) => Number(gps.latitude);
const gpsPointLon = (gps) => Number(gps.longitude);

// ── Edmonton wall-clock helpers (mirror clientRouteEngine's parse/format) ──
const parseTimeToMinutes = (t) => {
  if (!t) return null;
  let s = String(t).trim();
  if (s.includes('T')) s = s.split('T')[1] || s; // ISO strings → wall-clock part
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
};

const formatMinutesToTime = (mins) => {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const edmontonNowMinutes = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return (g('hour') % 24) * 60 + g('minute');
};

/**
 * Regenerate the current leg only.
 *
 * @param {Object} params
 * @param {Object} params.nextStop       The in-flight stop being headed to (en_route/in_transit)
 * @param {Object} params.gps           { latitude, longitude } — the driver's live position
 * @param {Array}  params.deliveries     Today's driver+date deliveries (for the finished-stop origin)
 * @param {Array}  [params.patients=[]]  Patient records (coord resolution)
 * @param {Array}  [params.stores=[]]    Store records (coord resolution)
 * @param {Array}  [params.appUsers=[]]  AppUser records (driver home / travel mode / name)
 * @param {string} params.driverId
 * @returns {Promise<{success:boolean, reason?:string, updatedDelivery?:Object}>}
 */
export async function regenerateCurrentLegPolyline({
  nextStop,
  gps,
  deliveries,
  patients = [],
  stores = [],
  appUsers = [],
  driverId,
}) {
  if (!nextStop?.id || !gps || !Number.isFinite(Number(gps.latitude)) || !Number.isFinite(Number(gps.longitude))) {
    return { success: false, reason: 'missing_next_stop_or_gps' };
  }

  const patientMap = new Map((patients || []).filter(Boolean).map((p) => [p.id, p]));
  const storeMap = new Map((stores || []).filter(Boolean).map((s) => [s.id, s]));
  const driverAppUser = (appUsers || []).find((au) => au?.user_id === driverId) || null;

  // ── Resolve the next stop's coordinates ────────────────────────────────────
  const stopCoords = getDeliveryCoords(nextStop, patientMap, storeMap);
  if (!stopCoords) {
    console.warn('[currentLegRegenerator] could not resolve next stop coords — skipping');
    return { success: false, reason: 'unresolved_stop_coords' };
  }

  // ── Polyline origin: last finished stop → driver home (mirrors the engine) ──
  const latestFinished = getLatestFinishedDelivery(deliveries);
  const latestFinishedCoords = latestFinished ? getDeliveryCoords(latestFinished, patientMap, storeMap) : null;
  let origin = null;
  let originSource = null;
  if (latestFinishedCoords) {
    origin = { lat: latestFinishedCoords.lat, lon: latestFinishedCoords.lng };
    originSource = 'last_finished_stop';
  } else if (driverAppUser?.home_latitude != null && driverAppUser?.home_longitude != null) {
    origin = { lat: Number(driverAppUser.home_latitude), lon: Number(driverAppUser.home_longitude) };
    originSource = 'home';
  }
  if (!origin) {
    console.warn('[currentLegRegenerator] no polyline origin (no finished stop, no home) — skipping');
    return { success: false, reason: 'no_origin' };
  }

  // ── Live-GPS via-point (same gate as the engine: >100m from the anchor) ────
  const gpsPoint = { lat: Number(gps.latitude), lon: Number(gps.longitude) };
  const via = haversineKm(origin.lat, origin.lon, gpsPoint.lat, gpsPoint.lon) > 0.1 ? gpsPoint : null;

  // ── Resolve API keys + polyline provider (same resolution as the coordinator) ──
  let hereApiKey = null;
  try { hereApiKey = await getOrFetchRoutingKey(); } catch (_) {}
  if (!hereApiKey) {
    try { hereApiKey = await getOrFetchHereApiKey(); } catch (_) {}
  }
  if (!hereApiKey) {
    console.warn('[currentLegRegenerator] no HERE key resolved — skipping (generateRoutePolylines gate)');
    return { success: false, reason: 'no_here_key' };
  }
  let polylineProvider = 'here';
  let polylineApiKey = null;
  try {
    const polyConfig = await getOrFetchPolylineConfig();
    polylineProvider = polyConfig?.provider || 'here';
    polylineApiKey = polyConfig?.apiKey || null;
  } catch (_) {}

  // ── Regenerate the single leg: origin (→ GPS via) → next stop ───────────────
  const segMap = await generateRoutePolylines({
    stops: [{ delivery: nextStop, lat: stopCoords.lat, lng: stopCoords.lng }],
    originPoint: origin,
    hereApiKey,
    polylineProvider,
    polylineApiKey,
    driverId,
    userName: driverAppUser?.user_name || null,
    source: 'route_deviation_current_leg',
    fallbackTravelMode: 'driving',
    viaPointAfterOrigin: via,
    logPurpose: DEVIATION_REGEN_LOG_PURPOSE,
  });

  const seg = segMap.get(nextStop.id);
  if (!seg?.encodedPolyline) {
    console.warn('[currentLegRegenerator] no polyline returned for the current leg — skipping write');
    return { success: false, reason: 'no_polyline_returned' };
  }

  // ── ETA: now + GPS→stop travel, clamped up to the stop's window start ───────
  // Mirrors the engine's stage-1 ETA (currentMinutes + travel, window floor).
  let etaMinutes = edmontonNowMinutes();
  if (Number.isFinite(seg.estimatedDurationMinutes) && seg.estimatedDurationMinutes > 0) {
    etaMinutes += Math.ceil(seg.estimatedDurationMinutes);
  }
  const windowStartMin = parseTimeToMinutes(nextStop.delivery_time_start || nextStop.time_window_start);
  if (windowStartMin != null && etaMinutes < windowStartMin) etaMinutes = windowStartMin;
  const newEta = formatMinutesToTime(etaMinutes);

  // transport_mode: keep the stop's existing mode (never silently flip cycling stops)
  const existingMode = nextStop.transport_mode ? String(nextStop.transport_mode).toLowerCase() : null;
  const safeTransportMode = ['driving', 'cycling', 'pedestrian'].includes(existingMode) ? existingMode : 'driving';

  const updateData = {
    encoded_polyline: seg.encodedPolyline,
    transport_mode: safeTransportMode,
    // Record this deviation point on the stop so later regens (manual re-opt,
    // admin regenerate) keep the leg snapped to the driven path (Sep 17 2026).
    deviation_waypoints: buildUpdatedDeviationWaypoints(nextStop.deviation_waypoints, gps),
    delivery_time_eta: newEta,
    ...(Number.isFinite(seg.estimatedDistanceKm) ? { estimated_distance_km: seg.estimatedDistanceKm } : {}),
    ...(Number.isFinite(seg.estimatedDurationMinutes) ? { estimated_duration_minutes: seg.estimatedDurationMinutes } : {}),
    ...(Number.isFinite(seg.estimatedDistanceKm) ? { travel_dist: seg.estimatedDistanceKm } : {}),
  };

  console.log(`[currentLegRegenerator] leg regenerated: origin=${originSource}${via ? ' →GPS' : ''} → stop ${nextStop.stop_order}, dist=${seg.estimatedDistanceKm ?? 'n/a'}km, dur=${seg.estimatedDurationMinutes ?? 'n/a'}min, eta=${newEta}`);

  // ── Commit: entityMutations.updateDelivery = optimistic UI + IDB + user-scoped
  // server write (WS broadcast to other devices) + local-write echo suppression.
  const updated = await updateDelivery(nextStop.id, updateData);
  const updatedDelivery = updated || { ...nextStop, ...updateData };

  return { success: true, updatedDelivery, updateData, originSource, usedVia: !!via };
};
