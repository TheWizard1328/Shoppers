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

export const buildServerOptimizeRequest = ({
  deliveries, patients = [], stores = [], appUsers = [],
  driverId, deliveryDate, preserveExistingOrder = false,
  clearNextDeliveryLock = false, startingStopOrder = null,
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
  let origin = null;
  if (explicitNext) {
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
    if (explicitNext && d?.id === explicitNext.id) continue;
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
      home,
      startOrder,
      stops,
      options: {
        preserveExistingOrder,
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
  const rawResult = await base44.functions.invoke('rxServerRouteOptimizer', request);
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
