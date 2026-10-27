/**
 * serverOptimizationMode.js — owner-toggleable SERVER-SIDE route optimization
 * (owner plan, Oct 16 2026). The app owner can switch between the client-side
 * engine (default, battle-tested) and the server-side duplicate
 * (rxServerRouteOptimizer backend function) for testing, and fall back anytime.
 *
 * OWNER-ONLY PHASE: while `serverSideOptimization` is armed in the
 * 'route_optimization' AppSettings, ONLY the app owner's devices route through
 * the server engine. Once verified, the same flag will switch all users.
 *
 * UI contract (owner spec): when SERVER side is active the manual re-optimize
 * FAB turns BLUE and shows an 'S' corner badge (same corner as the map cycle
 * FAB's 1/2/3); CLIENT side keeps GREEN + 'C'. The stop-card Navigate button
 * and the immersive-mode Navigate FAB follow the same scheme.
 */

import { useEffect, useState } from 'react';
import { inheritPickupWindows as sharedInheritPickupWindows } from '../../../base44/functions/rxServerRouteOptimizer/routeRules.js';
import { getAppSettingRows, refreshAppSetting } from './appSettingsCache';
import { isAppOwner } from './userRoles';
import { getDeliveryCoords, getLatestFinishedDelivery } from './clientRouteEngine';

const MODE_CACHE_TTL_MS = 60 * 1000;
let _cachedMode = { mode: 'client', at: 0, checked: false };

/**
 * Resolve the ACTIVE engine ('server' | 'client') for THIS user's device.
 * Server mode requires BOTH the setting to be armed AND the user to be the app
 * owner (owner-only rollout phase).
 */
let _cachedAuthUser = null;

// Resolve the authenticated platform user when no explicit user object is
// handed in (the coordinator runs outside React tree). role === 'admin' is the
// App Owner check (userRoles.isAppOwner). Cached 5 min.
const resolveAuthUser = async () => {
  if (_cachedAuthUser) return _cachedAuthUser;
  try {
    const { base44 } = await import('@/api/base44Client');
    const me = await base44.auth.me();
    if (me?.id) {
      _cachedAuthUser = me;
      setTimeout(() => { _cachedAuthUser = null; }, 5 * 60 * 1000);
    }
    return me || null;
  } catch (_) {
    return null;
  }
};

export const getActiveOptimizationEngine = async (currentUser = null) => {
  const user = currentUser || (await resolveAuthUser());
  if (!user || !isAppOwner(user)) return 'client';
  if (_cachedMode.checked && Date.now() - _cachedMode.at < MODE_CACHE_TTL_MS) {
    return _cachedMode.mode;
  }
  try {
    const rows = await getAppSettingRows('route_optimization');
    const value = rows?.[0]?.setting_value || {};
    const armed = value?.serverSideOptimization === true;
    _cachedMode = { mode: armed ? 'server' : 'client', at: Date.now(), checked: true };
    return _cachedMode.mode;
  } catch (_) {
    return 'client';
  }
};

/** Invalidate the cached mode (called after the settings panel saves). */
export const invalidateOptimizationModeCache = () => {
  _cachedMode = { mode: 'client', at: 0, checked: false };
};

/**
 * Authoritative re-resolve: skips the shared settings cache (memory/IDB can
 * serve rows up to 10 min old — the Oct 16 badge bug: toggling the switch
 * didn't flip the S/C badges until an app restart because the 60s memory
 * cache kept returning the pre-toggle value). Also refreshes the shared
 * cache so every other consumer sees the new value immediately.
 */
export const forceResolveOptimizationMode = async (currentUser = null) => {
  const user = currentUser || (await resolveAuthUser());
  if (!user || !isAppOwner(user)) return 'client';
  try {
    const rows = await refreshAppSetting('route_optimization');
    const value = rows?.[0]?.setting_value || {};
    const armed = value?.serverSideOptimization === true;
    const mode = armed ? 'server' : 'client';
    _cachedMode = { mode, at: Date.now(), checked: true };
    return mode;
  } catch (_) {
    return 'client';
  }
};

/** React hook for badge/button rendering — 30s re-resolve, cache-bust aware. */
export const useOptimizationEngineMode = (currentUser) => {
  const [mode, setMode] = useState('client');
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const active = await getActiveOptimizationEngine(currentUser);
      if (!cancelled) setMode(active);
    };
    resolve();
    const interval = setInterval(resolve, 30 * 1000);
    const onSettingsSaved = async () => {
      // Authoritative read — the shared settings cache is the reason the
      // badges needed an app restart to flip (Oct 16 owner report).
      const freshMode = await forceResolveOptimizationMode(currentUser);
      if (!cancelled) setMode(freshMode);
    };
    // WS cross-device path: realtimeSync broadcasts 'appSettingsUpdated' when
    // the route_optimization AppSettings record changes (appSettingsCache
    // optimistically applies the fresh row), so OTHER owner devices flip their
    // badges + engine gate immediately too — no poll wait, no restart.
    const onAppSettingsUpdated = async (event) => {
      const updated = event?.detail?.data || event?.detail;
      if (updated?.setting_key !== 'route_optimization') return;
      invalidateOptimizationModeCache();
      const mode = await getActiveOptimizationEngine(currentUser);
      if (!cancelled) setMode(mode);
    };
    window.addEventListener('routeOptimizationSettingsSaved', onSettingsSaved);
    window.addEventListener('appSettingsUpdated', onAppSettingsUpdated);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('routeOptimizationSettingsSaved', onSettingsSaved);
      window.removeEventListener('appSettingsUpdated', onAppSettingsUpdated);
    };
  }, [currentUser?.id]);
  return mode;
};

// ─── Request builder ──────────────────────────────────────────────────────────
// Builds the rxServerRouteOptimizer request from the coordinator's resolved
// live data. ALL waypoint/origin resolution happens HERE on the client (fresh
// IDB/local state) — the server function performs ZERO route-data reads, which
// is the freshness safeguard for the previous server-side attempt's failure.


const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];
const isInterStoreDeliveryId = (deliveryId) =>
  String(deliveryId || '').startsWith('ISP') || String(deliveryId || '').startsWith('ISD');

const parseTimeToMinutesLocal = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
};

const edmontonNowMinutes = () => {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton', hour: '2-digit', minute: '2-digit', hour12: false
    });
    const parts = fmt.formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    return h * 60 + m;
  } catch (_) {
    return 0;
  }
};

const edmontonTodayStr = () => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (_) {
    return '';
  }
};

// Per-stop deviation vias (client routePolylineGenerator parity): valid GPS
// points recorded while the driver strayed off the planned leg, newest last,
// capped at 3. STALE GUARD (client dropStaleVias): points recorded BEFORE
// the current leg's origin completed belong to older legs — routing through
// them bends the leg backward.
const DEVIATION_WAYPOINT_CAP = 3;
const _stopDeviationVias = (delivery, latestFinished) => {
  const raw = Array.isArray(delivery?.deviation_waypoints) ? delivery.deviation_waypoints : [];
  const originMs = latestFinished?.actual_delivery_time ? new Date(latestFinished.actual_delivery_time).getTime() : null;
  return raw
    .filter((pt) => pt && Number.isFinite(Number(pt.lat)) && Number.isFinite(Number(pt.lng)))
    .filter((pt) => {
      if (!Number.isFinite(originMs)) return true;
      const t = pt?.timestamp ? new Date(pt.timestamp).getTime() : NaN;
      return !Number.isFinite(t) || t >= originMs;
    })
    .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
    .slice(-DEVIATION_WAYPOINT_CAP)
    .map((pt) => ({ lat: Number(pt.lat), lng: Number(pt.lng) }));
};

const crowFliesKmLocal = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export const buildServerOptimizeRequest = ({
  deliveries, patients = [], stores = [], appUsers = [],
  driverId, deliveryDate, preserveExistingOrder = false,
  clearNextDeliveryLock = false, startingStopOrder = null,
  forceRegenerate = false,
}) => {
  const patientMap = new Map((patients || []).map(p => [p.id, p]));
  const storeMap = new Map((stores || []).map(s => [s.id, s]));
  const driverDeliveries = (deliveries || []).filter(d =>
    d && String(d.driver_id) === String(driverId) && d.delivery_date === deliveryDate);
  if (driverDeliveries.length === 0) return { supported: false, reason: 'no_deliveries' };

  const completed = driverDeliveries.filter(d => FINISHED_STATUSES.includes(String(d.status || '').toLowerCase()));
  const active = driverDeliveries.filter(d => !FINISHED_STATUSES.includes(String(d.status || '').toLowerCase()));
  if (active.length === 0) return { supported: false, reason: 'no_active_stops' };

  let driverAppUser = (appUsers || []).find(au => au?.user_id === driverId || au?.id === driverId) || {};
  // IDENTITY GUARD (Oct 22 2026, parity with clientRouteEngine): reject a
  // locally-found record whose user_id belongs to a different driver —
  // stale/foreign data must never set another driver's home as this route's
  // origin.
  if (driverAppUser && driverAppUser.user_id && String(driverAppUser.user_id) !== String(driverId)) {
    console.warn(`[serverOptimizationMode] AppUser match REJECTED (user_id=${driverAppUser.user_id} != driverId=${driverId}) — treating as not found`);
    driverAppUser = {};
  }
  const home = Number.isFinite(Number(driverAppUser.home_latitude)) && Number.isFinite(Number(driverAppUser.home_longitude))
    ? { lat: Number(driverAppUser.home_latitude), lng: Number(driverAppUser.home_longitude) }
    : null;

  // SEQUENCING-ORIGIN PARITY (owner report Oct 21 2026: server and client
  // produced completely different orders on the same route). The CLIENT
  // engine anchors HERE sequencing at the LOCKED next stop (routeOriginStop
  // — the stop the driver is currently driving to) and keeps that stop
  // pinned first, excluded from resequencing. The server previously
  // anchored at the LAST FINISHED stop — a different point on the map, so
  // HERE sequenced from there and produced a different order. Now BOTH
  // engines anchor identically: locked next stop → last finished → home →
  // first active.
  const explicitNext = active.find(d => d?.isNextDelivery === true) || null;
  // OWNER SPEC (Oct 26 2026): manual reorders / force-regenerate runs
  // repolyline ALL active stops in the caller's order, chained from the
  // most recent completed stop through the driver's live GPS — the dragged
  // stop is NOT a sequencing origin here (it was moved INTO the chain and
  // must get its own regenerated leg like every other stop). The pre-write
  // in the panel handler has already set isNextDelivery on it; we pass that
  // id so the server stamps the same flag.
  const quickReorder = preserveExistingOrder || forceRegenerate;
  let origin = null;
  if (quickReorder) {
    const latestFinished = getLatestFinishedDelivery(completed);
    if (latestFinished) {
      const c = getDeliveryCoords(latestFinished, patientMap, storeMap);
      if (c) origin = c;
    }
  }
  if (!origin && !quickReorder && explicitNext) {
    const c = getDeliveryCoords(explicitNext, patientMap, storeMap);
    if (c) origin = c;
  }
  if (!origin) {
    const latestFinished = getLatestFinishedDelivery(completed);
    if (latestFinished) {
      const c = getDeliveryCoords(latestFinished, patientMap, storeMap);
      if (c) origin = c;
    }
  }
  if (!origin && home) origin = home;
  if (!origin) {
    const firstActive = active.slice().sort((a, b) => (Number(a?.stop_order) || 99999) - (Number(b?.stop_order) || 99999))[0];
    const c = firstActive ? getDeliveryCoords(firstActive, patientMap, storeMap) : null;
    if (c) origin = c;
  }
  if (!origin) return { supported: false, reason: 'no_origin' };

  // ── POLYLINE ORIGIN (client polylineOrigin parity): the leg chain anchors
  // at the last completed stop -> home -> first active — NOT the sequencing
  // origin. Passed for every run; entry.ts falls back to `origin` if absent.
  const latestFinishedForOrigin = getLatestFinishedDelivery(completed);
  const polylineOrigin = (() => {
    if (latestFinishedForOrigin) {
      const c = getDeliveryCoords(latestFinishedForOrigin, patientMap, storeMap);
      if (c) return c;
    }
    if (home) return home;
    // OWNER DIRECTIVE (Oct 27 2026): NEVER fall back to the FIRST ACTIVE stop —
    // origin==destination made the server draw firstStop→GPS→firstStop. Null
    // is safe now: entry.ts anchors the current leg at the live-GPS via (or
    // synthesizes a degenerate 2-point first leg) when the anchor is missing.
    return null;
  })();

  // ── Live-GPS via (client viaPointAfterOrigin parity)
  // Gates mirror clientRouteEngine: driver on duty + an in-flight stop exists
  // + fresh finite GPS + GPS sits >0.1km from the polyline origin (driver has
  // left the anchor). Passed to the server; the polyline chain then runs
  // origin → GPS → new manual order.
  let viaPoint = null;
  {
    const _onDuty = ['on_duty', 'online'].includes(String(driverAppUser?.driver_status || '').toLowerCase());
    const _gpsLat = Number(driverAppUser?.current_latitude);
    const _gpsLng = Number(driverAppUser?.current_longitude);
    const _hasInFlight = active.some(d => ['en_route', 'in_transit'].includes(String(d.status || '').toLowerCase()));
    if (_onDuty && _hasInFlight && Number.isFinite(_gpsLat) && Number.isFinite(_gpsLng) && polylineOrigin
      && crowFliesKmLocal(polylineOrigin.lat, polylineOrigin.lng, _gpsLat, _gpsLng) > 0.1) {
      viaPoint = { lat: _gpsLat, lng: _gpsLng };
    }
  }

  const isToday = deliveryDate === edmontonTodayStr();
  const currentMinutes = isToday ? edmontonNowMinutes() : 8 * 60; // future routes anchor at 08:00
  const routeInProgress = completed.length > 0;

  // FUTURE-ROUTE PARITY (owner report Oct 20 2026): the client engine has a
  // dedicated future-route fast path (_handleFutureRoute: chronological
  // delivery_time_start sort, pickup-window inheritance, PUID grouping,
  // planned home polylines, NO HERE sequencing — also covering pre-9am today
  // routes that haven't started, owner rule Oct 1 2026). The server pipeline
  // is NOT that algorithm and on future routes produced owner-rejected orders
  // (windowless pending stops banded at the 08:00 anchor, sorting BEFORE
  // morning-window pickups). Skip the server round-trip entirely for these
  // shapes so the client fast-path owns future routes. Mirrors the identical
  // server-side gate in entry.ts (defense in depth).
  const _isFutureRoute = isToday
    ? edmontonNowMinutes() < 9 * 60
    : String(deliveryDate) > edmontonTodayStr();
  const _hasCyclingMarkers = active.some((d) => d.is_cycling_marker);
  if (_isFutureRoute && !routeInProgress && !preserveExistingOrder && !_hasCyclingMarkers) {
    return { supported: false, reason: 'future_route_client_fastpath' };
  }
  const startOrder = startingStopOrder != null ? startingStopOrder
    : quickReorder
      ? completed.reduce((max, d) => Math.max(max, Number(d?.stop_order) || 0), 0)
      : Math.max(
          completed.reduce((max, d) => Math.max(max, Number(d?.stop_order) || 0), 0),
          explicitNext ? (Number(explicitNext?.stop_order) || 0) : 0
        );

  const stops = [];
  for (const d of active) {
    // The locked next stop stays PINNED first (client engine parity): it is
    // the sequencing origin, never resequenced. Skipping it from the pool
    // and reserving its stop_order in startOrder keeps the final numbering
    // identical to the client engine's output.
    // OWNER FIX (Oct 26 2026): the locked next stop now SHIPS to the server
    // (it needs its inbound leg regenerated like every other stop — owner
    // report: current leg was only GPS->next, missing prev-stop->GPS, and no
    // deviation markers). entry.ts pins it first for sequencing. CYCLING
    // routes keep the old exclusion (entry's mixed-mode branch has no pin
    // step — the locked stop would get resequenced by the bicycle/car legs).
    if (explicitNext && d?.id === explicitNext.id && d?.is_cycling_marker !== true && active.some((x) => x?.is_cycling_marker)) continue;
    const coords = getDeliveryCoords(d, patientMap, storeMap);
    if (!coords) continue; // unmappable stops stay untouched server-side
    const patient = d.patient_id ? patientMap.get(d.patient_id) : null;
    // THE DELIVERY'S OWN WINDOW IS AUTHORITATIVE (repo rule Sep 30 2026).
    const windowStart = d.delivery_time_start || d.time_window_start || patient?.time_window_start || null;
    const windowEnd = d.delivery_time_end || d.time_window_end || patient?.time_window_end || null;
    const isInterStore = isInterStoreDeliveryId(d.delivery_id);
    const isPickup = !d.patient_id && !d.is_cycling_marker && !isInterStore;
    stops.push({
      id: d.id,
      deliveryId: d.delivery_id,
      stopId: d.stop_id || d.delivery_id || d.id,
      puid: d.puid || null,
      lat: coords.lat,
      lng: coords.lng,
      status: d.status,
      isPickup,
      isInterStore,
      isCyclingMarker: !!d.is_cycling_marker,
      deliveryNotes: d.delivery_notes || null,
      transportMode: d.transport_mode || 'driving',
      extraTime: d.extra_time || (isPickup ? 15 : 5),
      windowStart,
      windowEnd,
      deliveryTimeStart: d.delivery_time_start || null,
      currentStopOrder: Number(d.stop_order) || null,
      estimatedDurationMinutes: Number(d.estimated_duration_minutes) || null,
      patientId: d.patient_id || null,
      deviationWaypoints: _stopDeviationVias(d, latestFinishedForOrigin),
    });
  }
  if (stops.length === 0) return { supported: false, reason: 'no_mappable_stops' };

  // SHARED RULE (routeRules.js inheritPickupWindows — the single rule base,
  // Oct 21 2026 'one set of rules, two engines'): a patient delivery with NO
  // window of its own inherits its pickup's window START + 5 min. Without
  // this, windowless pending stops stay 'servable now' (nowBand) and sort
  // BEFORE morning-window pickups (owner report Oct 21 2026). The server
  // engine re-applies the same rule idempotently (defense in depth).
  sharedInheritPickupWindows(stops, {
    pickupWindowOf: (s) => s.deliveryTimeStart || s.windowStart || null,
  });

  return {
    supported: true,
    request: {
      driverId,
      driverName: driverAppUser?.user_name || null,
      deliveryDate,
      currentMinutes,
      origin: { lat: origin.lat, lng: origin.lng },
      ...(polylineOrigin ? { polylineOrigin: { lat: polylineOrigin.lat, lng: polylineOrigin.lng } } : {}),
      home,
      startOrder,
      stops,
      options: {
        ...(viaPoint ? { viaPoint } : {}),
        preserveExistingOrder,
        forceRegenerate,
        explicitNextDeliveryId: explicitNext?.id || null,
        clearNextDeliveryLock,
        routeInProgress,
      },
    },
  };
};

/**
 * Run the server-side optimization. Returns an ENGINE-RESULT-shaped object
 * ({ success, supported, orderedDeliveryIds, optimizedCount, routeChanged,
 * writeBatch: [{id, data}] }) so the coordinator's downstream commit pipeline
 * (TR# recalc → single silent bulk → route_commit marker) is unchanged.
 * Any failure returns { supported: false, reason } — caller falls back to the
 * client engine.
 */
// CIRCUIT BREAKER (owner report Oct 20 2026): the function was missing from
// the platform's function registry, so EVERY optimization burned a failed
// invoke + client fallback. After SERVER_BACKOFF_AFTER consecutive failed
// attempts, stop trying for SERVER_BACKOFF_MS so normal flows stop paying the
// wasted round-trip; the next attempt after the window re-probes, and any
// success resets the breaker. The skip is visible in the coordinator's log as
// 'server-side engine skipped (server_engine_backoff)'.
let _consecutiveServerFailures = 0;
let _serverBackoffUntil = 0;
const SERVER_BACKOFF_AFTER = 3;
const SERVER_BACKOFF_MS = 30 * 60 * 1000;

export const runServerSideOptimization = async (buildArgs) => {
  if (Date.now() < _serverBackoffUntil) {
    try {
      window.dispatchEvent(new CustomEvent('optimizationEngineFallback', {
        detail: { reason: 'server_engine_backoff', source: buildArgs?.source || 'coordinator', at: Date.now() }
      }));
    } catch (_) {}
    return { supported: false, reason: 'server_engine_backoff' };
  }
  const { supported, reason, request } = buildServerOptimizeRequest(buildArgs);
  if (!supported) return { supported: false, reason };

  // HERE key (Oct 20 2026): tool-deployed functions don't get the app's
  // HERE_API_KEY env var, so the client passes its already-resolved
  // route-optimization key in the request; the server prefers its own env var.
  try {
    const { getOrFetchRoutingKey } = await import('@/components/utils/routingKeyStore');
    const key = await getOrFetchRoutingKey();
    if (key) request.hereApiKey = key;
  } catch (_) {}

  const { base44 } = await import('@/api/base44Client');
  // OWNER REPORT (Oct 23 2026): edit-form deferred optimization hangs forever.
  // functions.invoke has NO client-side timeout — when the server function
  // stalls (e.g. an unbounded HERE fetch hanging), the coordinator awaits it
  // indefinitely: KITT bar forever, no audit entry, and NO fallback because
  // the fallback paths only trigger on a THROW. Cap the wait: on timeout,
  // count into the circuit breaker and return not-supported so the
  // coordinator falls back to the CLIENT engine. Abandoning the late result
  // is safe: the server function performs ZERO route-data writes (returns a
  // writeBatch that only THIS client commits — never received, never applied).
  const SERVER_INVOKE_TIMEOUT_MS = 45000; // > server's own 25s HERE caps
  const invokePromise = Promise.resolve().then(() => base44.functions.invoke('rxServerRouteOptimizer', request));
  invokePromise.catch(() => {}); // suppress the late rejection when the race already timed out
  let rawResult;
  try {
    rawResult = await Promise.race([
      invokePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('server_invoke_timeout')), SERVER_INVOKE_TIMEOUT_MS))
    ]);
  } catch (timeoutErr) {
    const _isTimeout = /timeout/i.test(String(timeoutErr?.message || timeoutErr));
    if (_isTimeout) {
      _consecutiveServerFailures++;
      if (_consecutiveServerFailures >= SERVER_BACKOFF_AFTER) _serverBackoffUntil = Date.now() + SERVER_BACKOFF_MS;
      try {
        window.dispatchEvent(new CustomEvent('optimizationEngineFallback', {
          detail: { reason: 'server_invoke_timeout', source: buildArgs?.source || 'coordinator', at: Date.now() }
        }));
      } catch (_) {}
      console.warn(`[serverOptimizationMode] server optimizer invoke timed out after ${SERVER_INVOKE_TIMEOUT_MS}ms — falling back to client engine`);
      return { supported: false, reason: 'server_invoke_timeout' };
    }
    throw timeoutErr; // real invoke error — coordinator's catch handles it
  }
  // SDK WRAPPER FIX (owner report Oct 20 2026: 'bad response' balloon while the
  // server function actually SUCCEEDS — verified live via a direct probe): the
  // client SDK returns the function's JSON body nested under `.data`. The old
  // validation read the WRAPPER object (supported===undefined passed the first
  // gate, success!==true then always failed with no reason → 'server_bad_response').
  // Unwrap first; tolerate both shapes.
  const result = rawResult?.data ?? rawResult;
  if (!result || result.supported === false) {
    _consecutiveServerFailures++;
    if (_consecutiveServerFailures >= SERVER_BACKOFF_AFTER) _serverBackoffUntil = Date.now() + SERVER_BACKOFF_MS;
    return { supported: false, reason: result?.reason || 'server_not_supported' };
  }
  if (result.success !== true || !Array.isArray(result.writeBatch)) {
    _consecutiveServerFailures++;
    if (_consecutiveServerFailures >= SERVER_BACKOFF_AFTER) _serverBackoffUntil = Date.now() + SERVER_BACKOFF_MS;
    // Pass the server's own failure detail through (e.g. 'server_error: ...')
    // so the coordinator's log names the real cause instead of a generic label.
    return { supported: false, reason: result?.reason || 'server_bad_response' };
  }
  _consecutiveServerFailures = 0;
  _serverBackoffUntil = 0;
  return {
    supported: true,
    success: true,
    serverSide: true,
    orderedDeliveryIds: result.orderedDeliveryIds || [],
    optimizedCount: result.optimizedCount || 0,
    routeChanged: !!result.routeChanged,
    usedFallbackOrdering: !!result.usedFallbackOrdering,
    usedFallbackPolyline: !!result.usedFallbackPolyline,
    writeBatch: result.writeBatch,
  };
};
