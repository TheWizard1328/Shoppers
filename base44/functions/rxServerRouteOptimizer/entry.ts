// ─────────────────────────────────────────────────────────────────────────────
// rxServerRouteOptimizer — SERVER-SIDE duplicate of the client route optimizer
// + polyline generator (owner plan, Oct 16 2026).
//
// DATA-FRESHNESS SAFEGUARD (the reason the previous server-side attempt failed):
// this function uses ONLY the live data passed in the request body. It performs
// ZERO Delivery/Patient/Store reads. The client sends fully-resolved waypoints
// (coords, windows, service times) + origin/home anchors computed from its own
// fresh IDB/local state. If anything is missing the function fails fast and the
// client falls back to its own engine — no stale-data optimization can happen.
//
// Auth: requester must be authenticated; the OWNER-ONLY rollout is enforced on
// the client (the admin toggle only arms server mode on the app owner's
// devices). The only entity read here is the requester's own AppUser record
// (authorization, not route data).
//
// Scope (phase 1): standard driving routes. Cycling segments and unsupported
// shapes return { supported: false } and the client engine handles them.
// ─────────────────────────────────────────────────────────────────────────────

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { resolveFeatureSecretName } from '../../shared/apiKeyResolver.ts';
import { encodeGooglePolyline as codecEncodeGooglePolyline, decodeGooglePolyline as codecDecodeGooglePolyline, calculateCrowFliesDistance as codecCrowFliesKm } from '../../shared/polylineCodec.ts';

// ─── Time helpers (ported from clientRouteEngine.js) ────────────────────────
// SINGLE RULE BASE (owner directive Oct 21 2026: 'one set of rules, two
// engines') — ALL sequencing/window/polyline-eligibility/dwell rules live in
// routeRules.js, shared verbatim with the client engine. Never re-implement
// a rule here.
import {
  inheritPickupWindows as sharedInheritPickupWindows,
  windowBandSort as sharedWindowBandSort,
  hasTimeWindows as sharedHasTimeWindows,
  enforceIspBeforeIsd as sharedEnforceIspBeforeIsd,
  enforcePickupBeforePendingDeliveries as sharedEnforcePickupBeforePending,
  isPolylineEligibleStop as sharedIsPolylineEligible,
  dwellMinutesForStop as sharedDwellMinutes,
  isSameAddressAnchor as sharedIsSameAddress,
  SAME_ADDRESS_TRAVEL_MINUTES as SHARED_SAME_ADDRESS_MINUTES,
} from './routeRules.js';

const TIME_ZONE = 'America/Edmonton';

const edmontonTodayStr = () => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (_) { return ''; }
};
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return Infinity;
  const parts = timeStr.split(':');
  if (parts.length < 2) return Infinity;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return Infinity;
  return h * 60 + m;
};

const formatMinutesToTime = (minutes) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const normalizeTimeString = (timeStr, fallback = '00:00:00') => {
  if (!timeStr || typeof timeStr !== 'string') return fallback;
  const parts = timeStr.split(':');
  if (parts.length < 2) return fallback;
  return `${String(Number(parts[0]) || 0).padStart(2, '0')}:${String(Number(parts[1]) || 0).padStart(2, '0')}:${String(Number(parts[2]) || 0).padStart(2, '0')}`;
};

const getWeekdayCode = (dateStr) => {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  return WEEKDAY_CODES[utcDate.getUTCDay()];
};

const getTimeZoneOffset = (dateStr) => {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const sampleDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, timeZoneName: 'shortOffset', hour: '2-digit'
  }).formatToParts(sampleDate).find((part) => part.type === 'timeZoneName')?.value || 'GMT-07:00';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return '-07:00';
  return `${match[1]}${String(match[2]).padStart(2, '0')}:${String(match[3] || '00').padStart(2, '0')}`;
};

const buildLocalIso = (dateStr, timeStr) =>
  `${dateStr}T${normalizeTimeString(timeStr)}${getTimeZoneOffset(dateStr)}`;

const buildAccessConstraint = (dateStr, startTime, endTime) => {
  if (!startTime && !endTime) return null;
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  if (Number.isFinite(startMinutes) && Number.isFinite(endMinutes) && endMinutes <= startMinutes) return null;
  const weekday = getWeekdayCode(dateStr);
  const offset = getTimeZoneOffset(dateStr);
  const start = normalizeTimeString(startTime, '00:00:00');
  const end = normalizeTimeString(endTime, '23:59:59');
  return `acc:${weekday}${start}${offset}|${weekday}${end}${offset}`;
};

// ─── Geometry helpers ────────────────────────────────────────────────────────
const EARTH_RADIUS_KM = 6371;
const crowFliesKm = (lat1, lng1, lat2, lng2) => {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Google polyline encode/decode (1e5) — pure arithmetic, no bitwise ops
// (32-bit overflow corrupts Edmonton longitudes — repo rule, commit 2959509ef).
const encodeGooglePolyline = (coords) => {
  let output = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const [lat, lng] of coords) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    let dLat = iLat - prevLat;
    let dLng = iLng - prevLng;
    prevLat = iLat;
    prevLng = iLng;
    for (const delta of [dLat, dLng]) {
      let v = delta < 0 ? ~(delta << 1) : (delta << 1);
      // NOTE: << here is safe — deltas are small (< 0.5deg legs ≈ 50000)
      while (v >= 0x20) {
        output += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
        v >>= 5;
      }
      output += String.fromCharCode(v + 63);
    }
  }
  return output;
};

const decodeGooglePolyline = (encoded) => {
  if (!encoded || typeof encoded !== 'string') return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  while (index < encoded.length) {
    let result = 0, multiplier = 1, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += (byte % 32) * multiplier;
      multiplier *= 32;
    } while (byte >= 0x20);
    lat += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    result = 0; multiplier = 1;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result += (byte % 32) * multiplier;
      multiplier *= 32;
    } while (byte >= 0x20);
    lng += (result % 2 !== 0) ? -((result + 1) / 2) : (result / 2);
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
};

// HERE flexible polyline decode (used by Router v8 `polyline` responses).
const decodeHereFlexiblePolyline = (encoded) => {
  // Reference implementation (HERE flexible polyline spec, 3rd-dimension off).
  const coords = [];
  if (!encoded || typeof encoded !== 'string') return coords;
  let index = 0;
  const decodeVarint = () => {
    let result = 0, shift = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >>> 1) : (result >>> 1);
  };
  let lat = 0, lng = 0;
  while (index < encoded.length) {
    lat += decodeVarint();
    lng += decodeVarint();
    coords.push([lat / 100000, lng / 100000]);
  }
  return coords;
};

// ─── HERE findsequence2 (ported from callHereSequence) ───────────────────────
async function callHereSequence({ origin, stops, home, destination, mode = 'car', apiKey, deliveryDate, currentMinutes, includeTimeWindows }) {
  const params = new URLSearchParams();
  params.set('apiKey', apiKey);
  params.set('departure', buildLocalIso(deliveryDate, formatMinutesToTime(currentMinutes)));
  params.set('mode', `fastest;${mode};traffic:disabled`);
  params.set('improveFor', 'time');
  params.set('start', `driverStart;${origin.lat},${origin.lng}`);
  if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
    // Explicit destination anchor (mixed-mode: the cycling END marker is the
    // exit of the bicycle leg, mirroring the client engine's runHereSequence).
    params.set('end', `routeEnd;${destination.lat},${destination.lng}`);
  } else if (home && Number.isFinite(home.lat) && Number.isFinite(home.lng)) {
    params.set('end', `driverHome;${home.lat},${home.lng}`);
  }
  stops.forEach((stop, index) => {
    const segments = [`${stop.stopId || stop.id};${stop.lat},${stop.lng}`];
    if (includeTimeWindows) {
      const wsMin = parseTimeToMinutes(stop.windowStart);
      // OWNER RULES (Oct 5 + Oct 21 2026): on TODAY's live route a start
      // window is NOT a HERE sequencing constraint — open windows (Oct 5)
      // AND future openings (Oct 21: from-side constraints made HERE
      // front-load open-window stops ahead of future-window stops instead
      // of placing them along the road). HERE sequences purely by
      // geography; the shared 2h band sort + ETA window floors enforce
      // chronology afterward. Window END stays a real constraint.
      const windowAlreadyOpen = Number.isFinite(wsMin) && wsMin > 0 && wsMin <= currentMinutes;
      const dropFromSide = windowAlreadyOpen || (deliveryDate === edmontonTodayStr());
      const acc = buildAccessConstraint(deliveryDate, dropFromSide ? null : stop.windowStart, stop.windowEnd);
      if (acc) segments.push(acc);
    }
    segments.push(`st:${Math.round((stop.extraTime || (stop.isPickup ? 15 : 5)) * 60)}`);
    params.set(`destination${index + 1}`, segments.join(';'));
  });

  // OWNER REPORT (Oct 23 2026): deferred edit-form optimization hangs forever.
  // Deno fetch has NO default timeout — a stalled HERE connection left the whole
  // function hanging, so the client's functions.invoke never resolved (KITT bar
  // forever, no audit entry, no client fallback). Client engine parity: 25s cap.
  const response = await fetch(`https://wps.hereapi.com/v8/findsequence2?${params.toString()}`, {
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(`HERE findsequence2 failed with ${response.status}`);
  const data = await response.json().catch(() => null);
  const route = data?.results?.[0];
  if (!route?.waypoints?.length) throw new Error('HERE findsequence2 returned no waypoints');
  return route;
}

// ─── Google Directions multi-stop polyline (CLIENT PARITY, Oct 21 2026) ──────
// The CLIENT's polyline generation (routePolylineGenerator.js → clientRouteGoogle.js
// → backend getGoogleDirectionsPolyline) draws polylines from Google Directions.
// The server previously called HERE Router v8 directly — a DIFFERENT provider
// with a custom decoder, and in production every section fell back to straight
// lines (owner report Oct 21: 'all I am getting are fallback straight lines').
// PARITY RULE (owner directive: 'one set of rules, two engines'): the server now
// uses the SAME Google Directions pipeline, section-for-section identical to
// getGoogleDirectionsPolyline (25-point chunking, legs→steps decode→encode,
// crow-flies fallback). HERE Router remains only as an emergency fallback when
// no Google key resolves.
async function getMultiStopRouteSectionsGoogle(points, transportMode, googleKey) {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return { sections: [], usedFallbackPolyline: false };

  const travelMode = transportMode === 'bicycle' || transportMode === 'cycling' ? 'bicycling'
    : transportMode === 'pedestrian' ? 'walking' : 'driving';

  const MAX_POINTS = 25;
  const chunks = [];
  if (validPoints.length <= MAX_POINTS) {
    chunks.push(validPoints);
  } else {
    let idx = 0;
    while (idx < validPoints.length - 1) {
      const end = Math.min(idx + MAX_POINTS, validPoints.length);
      chunks.push(validPoints.slice(idx, end));
      if (end >= validPoints.length) break;
      idx = end - 1; // overlap last point as next chunk origin
    }
  }

  const allSections = [];
  let anyFallback = false;
  for (const chunk of chunks) {
    if (chunk.length < 2) continue;
    const params = new URLSearchParams();
    params.set('origin', `${chunk[0].lat},${chunk[0].lon}`);
    params.set('destination', `${chunk[chunk.length - 1].lat},${chunk[chunk.length - 1].lon}`);
    params.set('key', googleKey);
    params.set('mode', travelMode);
    const wps = chunk.slice(1, -1).map((p) => `${p.lat},${p.lon}`);
    if (wps.length) params.set('waypoints', wps.join('|'));

    let routeData = null;
    let httpOk = false;
    try {
      const resp = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`, {
        signal: AbortSignal.timeout(20000),
        headers: { accept: 'application/json' },
      });
      httpOk = resp.ok;
      routeData = await resp.json().catch(() => null);
    } catch (err) {
      console.warn('[rxServerRouteOptimizer] Google Directions fetch threw', err?.message || err);
    }

    const legs = Array.isArray(routeData?.routes?.[0]?.legs) ? routeData.routes[0].legs : [];
    if (!httpOk || legs.length === 0) {
      for (let i = 0; i < chunk.length - 1; i++) {
        const from = chunk[i], to = chunk[i + 1];
        const d = codecCrowFliesKm(from.lat, from.lon, to.lat, to.lon);
        allSections.push({
          encoded_polyline: codecEncodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]),
          estimated_distance_km: Number(d.toFixed(3)),
          estimated_duration_minutes: Math.ceil((d / 40) * 60),
          transport_mode: transportMode || 'car',
        });
        anyFallback = true;
      }
      continue;
    }

    for (const leg of legs) {
      const coords = [];
      for (const step of (leg.steps || [])) {
        const st = codecDecodeGooglePolyline(step?.polyline?.points);
        if (!st.length) continue;
        if (coords.length && coords[coords.length - 1][0] === st[0][0] && coords[coords.length - 1][1] === st[0][1]) {
          coords.push(...st.slice(1));
        } else {
          coords.push(...st);
        }
      }
      allSections.push({
        encoded_polyline: coords.length > 1 ? codecEncodeGooglePolyline(coords) : null,
        estimated_distance_km: Number(leg?.distance?.value) ? Number((Number(leg.distance.value) / 1000).toFixed(3)) : null,
        estimated_duration_minutes: Number(leg?.duration?.value) ? Math.ceil(Number(leg.duration.value) / 60) : null,
        transport_mode: transportMode || 'car',
      });
    }
  }
  return { sections: allSections, usedFallbackPolyline: anyFallback };
}

// Google key resolution (mirrors getGoogleDirectionsPolyline): the
// 'polylines' feature slot resolver first, direct env fallback second.
async function resolveGoogleKey(base44) {
  try {
    const secretName = await resolveFeatureSecretName(base44, 'polylines');
    if (secretName === 'GOOGLE_MAPS_API_KEY') return Deno.env.get('GOOGLE_MAPS_API_KEY') || null;
  } catch (_) { /* config resolve failed — fall back below */ }
  return Deno.env.get('GOOGLE_MAPS_API_KEY') || null;
}

// ─── HERE Router v8 multi-stop polyline (ported from getMultiStopRouteHere) ──
async function getMultiStopRouteSections(points, apiKey, transportMode = 'car') {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return { sections: [], usedFallbackPolyline: false };

  const params = new URLSearchParams();
  params.set('apiKey', apiKey);
  params.set('transportMode', transportMode === 'bicycle' ? 'bicycle' : 'car');
  params.set('origin', `${validPoints[0].lat},${validPoints[0].lon}`);
  params.set('destination', `${validPoints[validPoints.length - 1].lat},${validPoints[validPoints.length - 1].lon}`);
  params.set('return', 'polyline,summary');
  validPoints.slice(1, -1).forEach((p) => params.append('via', `${p.lat},${p.lon}`));

  const routeResp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
    signal: AbortSignal.timeout(25000)
  });
  const routeData = await routeResp.json().catch(() => null);
  const routeSections = Array.isArray(routeData?.routes?.[0]?.sections) ? routeData.routes[0].sections : [];

  let anySegmentFellBack = false;
  const builtSections = validPoints.slice(0, -1).map((fromPoint, index) => {
    const section = routeSections[index] || {};
    let polyline = null;
    if (typeof section?.polyline === 'string' && section.polyline) {
      const coords = decodeHereFlexiblePolyline(section.polyline);
      if (coords.length > 1) polyline = encodeGooglePolyline(coords);
    }
    if (!polyline) {
      const toPoint = validPoints[index + 1];
      polyline = encodeGooglePolyline([[fromPoint.lat, fromPoint.lon], [toPoint.lat, toPoint.lon]]);
      anySegmentFellBack = true;
    }
    const summary = section?.summary || {};
    return {
      encoded_polyline: polyline,
      estimated_distance_km: summary.length ? Number((Number(summary.length) / 1000).toFixed(3)) : null,
      estimated_duration_minutes: summary.duration ? Math.ceil(Number(summary.duration) / 60) : null,
    };
  });
  return { sections: builtSections, usedFallbackPolyline: anySegmentFellBack };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Authorization (not route data): admin or app-owner only. The owner-only
    // rollout phase is enforced client-side; this is the server-side backstop.
    try {
      const requesterAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-updated_date', 1);
      const requesterAppUser = requesterAppUsers?.[0] || null;
      const roles = Array.isArray(requesterAppUser?.app_roles) ? requesterAppUser.app_roles : [];
      const isOwner = requesterAppUser?.is_app_owner === true || roles.includes('app_owner');
      if (!isOwner && !roles.includes('admin')) {
        return Response.json({ success: true, supported: false, reason: 'not_authorized_for_server_optimization' });
      }
    } catch (authErr) {
      return Response.json({ success: true, supported: false, reason: 'authorization_check_failed' });
    }

    // KEY RESOLUTION (Oct 20 2026): git-deployed functions get the app's
    // HERE_API_KEY env var, but tool-deployed ones do NOT (verified with an
    // env probe — the platform only attaches app secrets to git deploys).
    // The client already resolves the route-optimization key before invoking
    // (routingKeyStore) and passes it in the request body; prefer the env var
    // when present, otherwise use the request-provided key. Any authenticated
    // owner/admin can already obtain this key via getActiveHereApiKey, so
    // passing it adds no new exposure; the function never logs or returns it.
    const payload = await req.json().catch(() => ({}));
    const apiKey = Deno.env.get('HERE_API_KEY')
      || (typeof payload?.hereApiKey === 'string' && payload.hereApiKey.length > 10 ? payload.hereApiKey : '');
    if (!apiKey) {
      return Response.json({ success: true, supported: false, reason: 'here_api_key_missing' });
    }

    const {
      driverId, driverName = null, deliveryDate, currentMinutes,
      origin, home = null, startOrder = 0,
      stops = [],
      options = {},
    } = payload || {};

    if (!driverId || !deliveryDate || !Number.isFinite(Number(currentMinutes))) {
      return Response.json({ success: true, supported: false, reason: 'missing_driver_date_or_time' });
    }
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lng))) {
      return Response.json({ success: true, supported: false, reason: 'missing_origin' });
    }
    const routeStops = (Array.isArray(stops) ? stops : []).filter((s) =>
      s && s.id && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)));
    if (routeStops.length === 0) {
      return Response.json({ success: true, supported: false, reason: 'no_mappable_stops' });
    }
    if (routeStops.length > 40) {
      return Response.json({ success: true, supported: false, reason: 'too_many_stops' });
    }
    // ── Mixed-mode detection (owner directive Oct 16 2026): cycling routes now
    // follow the SAME client/server switch as driving routes. Mirrors the
    // client engine's split (clientRouteEngine.js): a route WITH an END cycling
    // marker runs two-leg sequencing — bicycle leg (origin → cycling stops →
    // END marker) + car leg (END marker → driving stops, home anchor) — then
    // stitches [start marker] → [cycling ordered] → [end marker] → [driving
    // ordered]. Cycling shape WITHOUT an END marker falls back to the client
    // engine (Robert's rule, Sep 8 2026).
    const _cyclingMarkers = routeStops.filter((s) => s.isCyclingMarker);
    const _startMarker = _cyclingMarkers.find((s) => String(s.deliveryNotes || '').toLowerCase().includes('start')) || null;
    const _endMarker = _cyclingMarkers.find((s) => String(s.deliveryNotes || '').toLowerCase().includes('end')) || null;
    const _hasCyclingStops = routeStops.some((s) => !s.isCyclingMarker &&
      String(s.transportMode || '').toLowerCase() === 'cycling');
    if ((_cyclingMarkers.length > 0 || _hasCyclingStops) && !_endMarker) {
      return Response.json({ success: true, supported: false, reason: 'cycling_route_without_end_marker' });
    }
    const mixedMode = !!_endMarker;

    const { preserveExistingOrder = false, explicitNextDeliveryId = null, clearNextDeliveryLock = false, routeInProgress = false } = options;

    // ── FUTURE-ROUTE PARITY (owner report Oct 20 2026) ─────────────────────
    // The CLIENT engine has a dedicated future-route fast path (_handleFutureRoute
    // in clientRouteEngine.js): chronological delivery_time_start sort, pickup-window
    // inheritance for windowless deliveries, PUID grouping, planned home-origin
    // polylines — NO HERE sequencing. It also covers pre-9am TODAY routes that
    // haven't started (owner rule Oct 1 2026: before 9am a today-route plans like
    // a future route). This server pipeline (findsequence2 + 2h window bands +
    // ETA ladder) is NOT that algorithm: on future routes the request's 08:00
    // future anchor put windowless stops in the "now" band (band 4), sorting
    // pending windowless stops BEFORE morning-window pickups — owner-rejected
    // ordering ("totally failing to optimize... pending stop before all
    // pickups"). Mirroring the client's own fast-path gate conditions, future
    // routes (not yet started, no order-preservation, no cycling markers) fall
    // back to the client engine, which owns the future-route planner. Active
    // and historical routes keep the server pipeline.
    const _edmontonToday = (() => {
      try {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date());
      } catch (_) { return ''; }
    })();
    const _routeIsToday = deliveryDate === _edmontonToday;
    const _isFutureRoute = _routeIsToday
      ? currentMinutes < 9 * 60
      : String(deliveryDate) > _edmontonToday;
    const _hasCyclingMarkers = routeStops.some((s) => s.isCyclingMarker);
    if (_isFutureRoute && !routeInProgress && !preserveExistingOrder && !_hasCyclingMarkers) {
      console.log(`[rxServerRouteOptimizer] future-route parity: ${deliveryDate} (today=${_routeIsToday}) → falling back to client future fast-path`);
      return Response.json({ success: true, supported: false, reason: 'future_route_client_fastpath' });
    }

    // ── 1. HERE sequencing (ONE call for the whole pool; TWO in mixed mode) ─
    const includeTimeWindows = routeStops.some((s) => s.windowStart && parseTimeToMinutes(s.windowStart) > 0);
    let orderedStops = routeStops;
    let usedFallbackOrdering = false;
    let googleCalls = 0;
    let googleKey = null;
    try { googleKey = await resolveGoogleKey(base44); } catch (_) { googleKey = null; }
    let hereCalls = 0;

    // Resolve findsequence2 waypoints back to request stops (shared by the
    // driving and bicycle legs).
    const resolveSequence = (seqResult, pool) => {
      const seqWaypoints = (seqResult.waypoints || []).filter((w) => w.id !== 'driverStart' && w.id !== 'driverHome' && w.id !== 'routeEnd');
      const byId = new Map(pool.map((s) => [String(s.stopId || s.id), s]));
      const byFallbackId = new Map(pool.map((s) => [String(s.id), s]));
      const resolved = seqWaypoints.map((w) => byId.get(String(w.id)) || byFallbackId.get(String(w.id))).filter(Boolean);
      if (resolved.length !== pool.length) {
        throw new Error(`sequence resolution incomplete (${resolved.length}/${pool.length})`);
      }
      return resolved;
    };

    // Nearest-neighbor crow-flies fallback ordering (shared by both legs).
    const nearestNeighborOrder = (pool, from) => {
      const remaining = [...pool];
      const nn = [];
      let cursor = { lat: from.lat, lng: from.lng };
      while (remaining.length > 0) {
        let bestIdx = 0, bestDist = Infinity;
        remaining.forEach((s, i) => {
          const d = crowFliesKm(cursor.lat, cursor.lng, s.lat, s.lng);
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        });
        const [picked] = remaining.splice(bestIdx, 1);
        nn.push(picked);
        cursor = { lat: picked.lat, lng: picked.lng };
      }
      return nn;
    };

    if (mixedMode) {
      // ── Mixed-mode two-leg sequencing (client engine parity) ─────────────
      // Leg 1 (bicycle): origin → cycling stops → END marker anchor.
      // Leg 2 (car): END marker → driving stops → home anchor.
      // Stitch: [start marker] → [cycling ordered] → [end marker] → [driving ordered].
      // The start marker is NOT a HERE waypoint — fixed positional anchor.
      const pool = routeStops.filter((s) => !s.isCyclingMarker);
      const drivingPool = pool.filter((s) => String(s.transportMode || '').toLowerCase() !== 'cycling');
      const cyclingPool = pool.filter((s) => String(s.transportMode || '').toLowerCase() === 'cycling');

      let orderedCycling = cyclingPool;
      let orderedDriving = drivingPool;

      if (cyclingPool.length > 0) {
        try {
          const seqResult = await callHereSequence({
            origin, stops: cyclingPool, destination: { lat: _endMarker.lat, lng: _endMarker.lng },
            mode: 'bicycle', apiKey, deliveryDate, currentMinutes, includeTimeWindows,
          });
          orderedCycling = resolveSequence(seqResult, cyclingPool);
          hereCalls++;
        } catch (seqErr) {
          usedFallbackOrdering = true;
          console.warn(`[rxServerRouteOptimizer] bicycle findsequence2 failed (${seqErr?.message || seqErr}) — nearest-neighbor fallback`);
          orderedCycling = nearestNeighborOrder(cyclingPool, origin);
        }
      }
      if (drivingPool.length > 0) {
        try {
          const seqResult = await callHereSequence({
            origin: { lat: _endMarker.lat, lng: _endMarker.lng }, stops: drivingPool, home,
            mode: 'car', apiKey, deliveryDate, currentMinutes, includeTimeWindows,
          });
          orderedDriving = resolveSequence(seqResult, drivingPool);
          hereCalls++;
        } catch (seqErr) {
          usedFallbackOrdering = true;
          console.warn(`[rxServerRouteOptimizer] car findsequence2 failed (${seqErr?.message || seqErr}) — nearest-neighbor fallback`);
          orderedDriving = nearestNeighborOrder(drivingPool, { lat: _endMarker.lat, lng: _endMarker.lng });
        }
      }

      // ISP-before-ISD ordering constraint (driving pool only — keeps the
      // cycling structure intact). SHARED RULE: routeRules.js.
      orderedDriving = sharedEnforceIspBeforeIsd(orderedDriving, {});

      orderedStops = [
        ...(_startMarker ? [_startMarker] : []),
        ...orderedCycling,
        _endMarker,
        ...orderedDriving,
      ];
      console.log(`[rxServerRouteOptimizer] mixed mode: ${cyclingPool.length} cycling + ${drivingPool.length} driving + ${_cyclingMarkers.length} marker(s)`);
    } else {
      try {
        const seqResult = await callHereSequence({
          origin, stops: routeStops, home, apiKey, deliveryDate, currentMinutes, includeTimeWindows,
        });
        orderedStops = resolveSequence(seqResult, routeStops);
        hereCalls++;
      } catch (seqErr) {
        // Degraded: nearest-neighbor crow-flies ordering (client would retry on
        // its own engine anyway if we report unsupported; instead we still
        // produce a deterministic order + polylines so the route stays usable).
        usedFallbackOrdering = true;
        console.warn(`[rxServerRouteOptimizer] findsequence2 failed (${seqErr?.message || seqErr}) — nearest-neighbor fallback`);
        orderedStops = nearestNeighborOrder(routeStops, origin);
      }

      // ── 2. Window-band chronology (Sep 10 2026 semantics, 2-hour bands) ────
      // SHARED RULE (routeRules.js windowBandSort): 2h band chronology.
      // routeIsToday guard added for client parity (historical routes keep
      // their window bands instead of clamping to the real clock).
      if (sharedHasTimeWindows(routeStops, (st) => st.windowStart) && orderedStops.length > 1) {
        orderedStops = sharedWindowBandSort(orderedStops, {
          routeIsToday: _routeIsToday,
          currentMinutes,
          windowOf: (st) => st.windowStart,
        });
      }

      // ── 2b. SHARED RULE: pending deliveries follow their pickup (Oct 21) ──
      orderedStops = sharedEnforcePickupBeforePending(orderedStops, {});
      // ── 3. ISP-before-ISD ordering constraint (SHARED RULE: routeRules.js) ─
      orderedStops = sharedEnforceIspBeforeIsd(orderedStops, {});
    }

    // ── 3b. CLIENT-PARITY backstop (Oct 21 2026): windowless patient stops
    // inherit their pickup's window START + 5 min (clientRouteEngine.js ~466).
    // buildServerWaypoints applies this client-side already; re-apply here so
    // the rule holds regardless of caller. Idempotent (skips stops with a
    // window). Fixes 'pending stops optimized ahead of their pickups'.
    // SHARED RULE (routeRules.js inheritPickupWindows): windowless patient
    // stops inherit pickup window START + 5. buildServerWaypoints applies it
    // client-side; re-applied here idempotently so the rule holds regardless
    // of caller. Fixes 'pending stops optimized ahead of their pickups'.
    sharedInheritPickupWindows(orderedStops, {
      pickupWindowOf: (st) => st.deliveryTimeStart || st.windowStart || null,
    });

    // ── 4. Polylines: mode-grouped multi-stop router calls ──────────────────
    // The leg INTO each stop uses that stop's transport mode (cycling engine
    // rule: leg INTO the START marker is driving; legs into cycling stops and
    // the END marker are bicycle; legs into driving stops are car). Consecutive
    // legs sharing a mode go through ONE Router call — a mixed route costs two
    // calls total, a pure driving route stays ONE (unchanged phase-1 behavior).
    const legModeFor = (stop) => stop.isCyclingMarker
      ? (String(stop.deliveryNotes || '').toLowerCase().includes('start') ? 'car' : 'bicycle')
      : (String(stop.transportMode || '').toLowerCase() === 'cycling' ? 'bicycle' : 'car');
    // CLIENT PARITY (routePolylineGenerator.js ~line 285): ONLY en_route /
    // in_transit stops (+ cycling markers + cycling-mode stops) receive
    // polylines. Pending stops are NOT part of the chain — legs bridge
    // ACROSS them (previous eligible stop → next eligible stop), never
    // THROUGH them. The old chain drew legs through pending stops,
    // corrupting downstream leg geometry (owner report Oct 21 2026).
    const isPolylineEligible = (st) => sharedIsPolylineEligible(st);
    const eligibleStops = orderedStops.filter(isPolylineEligible);
    const sectionByStopId = new Map();
    let usedFallbackPolyline = false;
    {
      let gi = 0;
      while (gi < eligibleStops.length) {
        const mode = legModeFor(eligibleStops[gi]);
        let gj = gi;
        while (gj < eligibleStops.length && legModeFor(eligibleStops[gj]) === mode) gj++;
        // Anchor each mode run at the previous point in the chain (origin for
        // the first run, the previous ELIGIBLE stop for later runs) so
        // sections[k] is always the leg INTO eligibleStops[gi+k].
        const pts = [
          gi === 0
            ? { lat: origin.lat, lon: origin.lng }
            : { lat: eligibleStops[gi - 1].lat, lon: eligibleStops[gi - 1].lng },
          ...eligibleStops.slice(gi, gj).map((st) => ({ lat: st.lat, lon: st.lng })),
        ];
        if (pts.length >= 2) {
          // CLIENT PARITY: Google Directions first (same source the client
          // generator uses); HERE Router only when no Google key resolves.
          let r = null;
          if (googleKey) {
            try {
              r = await getMultiStopRouteSectionsGoogle(pts, mode, googleKey);
              googleCalls++;
            } catch (gErr) {
              console.warn('[rxServerRouteOptimizer] Google polyline path failed, trying HERE Router fallback:', gErr?.message || gErr);
              r = null;
            }
          }
          if (!r) {
            r = await getMultiStopRouteSections(pts, apiKey, mode);
            hereCalls++;
          }
          usedFallbackPolyline = usedFallbackPolyline || r.usedFallbackPolyline;
          (r.sections || []).forEach((sec, k) => { sectionByStopId.set(eligibleStops[gi + k].id, sec); });
        }
        gi = gj;
      }
    }

    // ── 5. ETA ladder (owner rules: window floors, dwell, same-address cap) ─
    const SAME_ADDRESS_TRAVEL_MINUTES = SHARED_SAME_ADDRESS_MINUTES;
    let cumulativeTime = currentMinutes;
    const stageEtaMap = new Map();
    for (let i = 0; i < orderedStops.length; i++) {
      const stop = orderedStops[i];
      const seg = sectionByStopId.get(stop.id) || null;
      const prev = i > 0 ? orderedStops[i - 1] : null;
      const nearPreviousStop = prev && sharedIsSameAddress({ lat: prev.lat, lng: prev.lng }, { lat: stop.lat, lng: stop.lng });
      let travelMinutes;
      if (typeof seg?.estimated_duration_minutes === 'number' && seg.estimated_duration_minutes > 0) {
        travelMinutes = Math.ceil(seg.estimated_duration_minutes);
      } else if (nearPreviousStop) {
        travelMinutes = SAME_ADDRESS_TRAVEL_MINUTES;
      } else if (typeof stop.estimatedDurationMinutes === 'number' && stop.estimatedDurationMinutes > 0) {
        travelMinutes = Math.ceil(stop.estimatedDurationMinutes);
      } else {
        const d = crowFliesKm(prev ? prev.lat : origin.lat, prev ? prev.lng : origin.lng, stop.lat, stop.lng);
        travelMinutes = Math.max(2, Math.ceil((d / 35) * 60)); // 35 km/h convention
      }
      cumulativeTime += travelMinutes;
      const ws = parseTimeToMinutes(stop.windowStart || stop.deliveryTimeStart || stop.windowStart);
      if (Number.isFinite(ws) && ws > 0 && cumulativeTime < ws) cumulativeTime = ws;
      stageEtaMap.set(stop.id, formatMinutesToTime(cumulativeTime));
      cumulativeTime += sharedDwellMinutes({ extraTime: stop.extraTime, isPickup: stop.isPickup });
    }

    // ── 6. stop_order + isNextDelivery + writeBatch ─────────────────────────
    const originalOrderIds = routeStops
      .slice().sort((a, b) => (Number(a.currentStopOrder) || 99999) - (Number(b.currentStopOrder) || 99999))
      .map((s) => String(s.id));
    const optimizedOrderIds = orderedStops.map((s) => String(s.id));
    const routeOrderChanged = preserveExistingOrder
      ? false
      : originalOrderIds.length !== optimizedOrderIds.length ||
        originalOrderIds.some((id, index) => id !== optimizedOrderIds[index]);

    const firstNonInterStoreActive = orderedStops.find((s) => !s.isInterStore) || null;
    const nextStopId = (explicitNextDeliveryId && !clearNextDeliveryLock ? explicitNextDeliveryId : null)
      || (clearNextDeliveryLock
        ? (firstNonInterStoreActive?.id || orderedStops[0]?.id || null)
        : (!routeInProgress ? (firstNonInterStoreActive?.id || orderedStops[0]?.id || null) : null));

    const sameCoordsAdjacentIds = new Set();
    for (let i = 1; i < orderedStops.length; i++) {
      const a = orderedStops[i - 1], b = orderedStops[i];
      if (crowFliesKm(a.lat, a.lng, b.lat, b.lng) < 0.05) sameCoordsAdjacentIds.add(b.id);
    }

    const writeBatch = [];
    for (let i = 0; i < orderedStops.length; i++) {
      const stop = orderedStops[i];
      const newOrder = preserveExistingOrder ? (Number(stop.currentStopOrder) || (startOrder + i + 1)) : (startOrder + i + 1);
      const seg = sectionByStopId.get(stop.id) || null;
      const isNextStop = stop.id === nextStopId;
      // Cycling markers stay polyline-eligible even while pending (client
      // engine rule — markers are full route stops, never 'unaccepted').
      const isPending = stop.status === 'pending' && !stop.isCyclingMarker;
      const isPickupStop = stop.isPickup && !stop.isInterStore;
      const correctedStatus = isPickupStop && stop.status === 'in_transit' ? 'en_route' : undefined;
      const statusToWrite = correctedStatus || (stop.status === 'in_transit' ? 'in_transit' : undefined);
      const logicalDurationMinutes = typeof seg?.estimated_duration_minutes === 'number' ? seg.estimated_duration_minutes : null;
      const logicalDistanceKm = typeof seg?.estimated_distance_km === 'number' ? seg.estimated_distance_km : null;

      const updateData = {
        stop_order: newOrder,
        delivery_time_eta: stageEtaMap.get(stop.id) || null,
        ...(isNextStop ? { isNextDelivery: true } : { isNextDelivery: false }),
        transport_mode: legModeFor(stop) === 'bicycle' ? 'cycling' : 'driving',
        ...(statusToWrite ? { status: statusToWrite } : {}),
        travel_dist: isPending ? null : (logicalDistanceKm != null ? logicalDistanceKm : null),
        ...(!isPending && logicalDurationMinutes != null ? { estimated_duration_minutes: logicalDurationMinutes } : {}),
        ...(!isPending && logicalDurationMinutes == null && sameCoordsAdjacentIds.has(stop.id)
          ? { estimated_duration_minutes: SAME_ADDRESS_TRAVEL_MINUTES, estimated_distance_km: 0 } : {}),
        ...(!isPending && logicalDistanceKm != null ? { estimated_distance_km: logicalDistanceKm } : {}),
        ...(!isPending && seg?.encoded_polyline ? { encoded_polyline: seg.encoded_polyline, polyline_from_order: newOrder } : {}),
        ...(isPending ? { encoded_polyline: null, polyline_from_order: null, estimated_distance_km: null, estimated_duration_minutes: null } : {}),
      };
      writeBatch.push({ id: stop.id, data: updateData });
    }

    return Response.json({
      success: true,
      supported: true,
      driver_id: driverId,
      driver_name: driverName,
      delivery_date: deliveryDate,
      orderedDeliveryIds: optimizedOrderIds,
      optimizedCount: orderedStops.length,
      routeChanged: routeOrderChanged,
      usedFallbackOrdering,
      usedFallbackPolyline,
      writeBatch,
      here_calls: hereCalls,
      google_calls: googleCalls,
      mixed_mode: mixedMode,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (error) {
    console.error('[rxServerRouteOptimizer] fatal:', error?.message || String(error));
    return Response.json({ success: true, supported: false, reason: `server_error: ${error?.message || 'unknown'}` });
  }
});
