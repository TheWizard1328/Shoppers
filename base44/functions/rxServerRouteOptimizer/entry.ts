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
  hasTimeWindows as sharedHasTimeWindows,
  enforceIspBeforeIsd as sharedEnforceIspBeforeIsd,
  enforcePickupBeforePendingDeliveries as sharedEnforcePickupBeforePending,
  enforceInHandBeforeItsPickup as sharedEnforceInHandBeforePickup,
  enforcePickupWindowOrder as sharedEnforcePickupWindowOrder,
  enforceCyclingBlock as sharedEnforceCyclingBlock,
  isPolylineEligibleStop as sharedIsPolylineEligible,
  dwellMinutesForStop as sharedDwellMinutes,
  isSameAddressAnchor as sharedIsSameAddress,
  unitNumberMicroSort as sharedUnitNumberMicroSort,
  SAME_ADDRESS_TRAVEL_MINUTES as SHARED_SAME_ADDRESS_MINUTES,
  resolveSequenceSearch,
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

// ── WINDOW BAND GUARD (owner report Nov 4 2026, CLIENT PARITY) ──────────────
// "Regardless of route type (fastest / shortest / best) time windows must still
// be accounted for — a stop with a 5:00 start window was optimizing before the
// Beverly 2:00-3:30 pickup and even before Londonderry 4:00-5:00."
// HERE may ignore/degrade acc windows depending on search mode, so the FINAL
// order of every route type is verified: gated stops bucket into 90-minute
// bands from now and the list is stably re-sorted by band. In-band geography is
// untouched, so a properly windowed HERE result comes back unchanged.
const enforceWindowBands = (stops: any[], nowMin: number) => {
  if (!Array.isArray(stops) || stops.length < 2) return stops;
  const bandOf = (st: any) => {
    const m = parseTimeToMinutes(st?.windowStartRaw ?? st?.windowStart);
    if (!Number.isFinite(m)) return 0;
    const base = Number.isFinite(nowMin) ? nowMin : (m as number);
    return Math.max(0, Math.floor(((m as number) - base) / 90));
  };
  const keyed = stops.map((st, i) => ({ st, i, b: bandOf(st) }));
  const inverted = keyed.some((a, idx) => keyed.slice(idx + 1).some((b) => b.b < a.b));
  if (!inverted) return stops;
  return keyed.sort((a, b) => a.b - b.b || a.i - b.i).map((x) => x.st);
};

async function callHereSequence({ origin, stops, home, destination, mode = 'car', apiKey, deliveryDate, currentMinutes, includeTimeWindows, routePrefs = null, routeIsToday = false, windowSway = 0 }) {
  const params = new URLSearchParams();
  params.set('apiKey', apiKey);
  params.set('departure', buildLocalIso(deliveryDate, formatMinutesToTime(currentMinutes)));
  // FULL PARITY with the client engine (owner directive Oct 30 2026: "any
  // changes that I make to the route optimizer should be mirrored both client
  // and server side"). The Fastest / Shortest / Best preference now decides the
  // SEQUENCE SEARCH here too, through the same shared resolver — previously the
  // server hardcoded fastest + improveFor=time, so server runs produced a
  // different stop ORDER than the client for the same route.
  const _search = resolveSequenceSearch({
    routePreference: routePrefs?.routePreference,
    trafficAware: routePrefs?.trafficAware,
    transportMode: mode,
  });
  params.set('mode', _search.mode);
  params.set('improveFor', _search.improveFor);
  params.set('start', `driverStart;${origin.lat},${origin.lng}`);
  if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
    // Explicit destination anchor (mixed-mode: the cycling END marker is the
    // exit of the bicycle leg, mirroring the client engine's runHereSequence).
    params.set('end', `routeEnd;${destination.lat},${destination.lng}`);
  } else if (home && Number.isFinite(home.lat) && Number.isFinite(home.lng)) {
    params.set('end', `driverHome;${home.lat},${home.lng}`);
  }
  // ── EXPIRED WINDOW LADDER (owner report Nov 4 2026) ────────────────────
  // "It seems to be failing in such a way that it is not optimizing with time
  // windows, for example Robert's route: Beverly and Londonderry are in the
  // wrong order." Cause: retrying yesterday's failed stops runs them on today's
  // route with windows that are already over, so every start collapsed to "now"
  // and every end was dropped — the pharmacy's intended order (Beverly before
  // Londonderry) evaporated and HERE sequenced by pure road distance.
  // Fix: shift the whole expired group forward by ONE offset so the RELATIVE
  // ladder survives. The earliest expired window opens now; later ones keep
  // their original spacing. Real constraints (windows still open) are untouched.
  const _expiredStarts = routeIsToday
    ? stops
        .filter((s) => s.windowStartExpired === true)
        .map((s) => parseTimeToMinutes(s.windowStartRaw ?? s.windowStart))
        .filter((m) => Number.isFinite(m))
    : [];
  const _expiredShift = _expiredStarts.length > 0 ? currentMinutes - Math.min(..._expiredStarts) : 0;

  stops.forEach((stop, index) => {
    const segments = [`${stop.stopId || stop.id};${stop.lat},${stop.lng}`];
    if (includeTimeWindows) {
      // ── OWNER SPEC (Nov 3 2026), FULL PARITY with the client engine ──────
      // Windows are gates + deadlines handed to HERE: open = start, close =
      // end, BOTH sides, past starts clamped to the current time, each side
      // widened by WINDOW_SWAY_MINUTES ("most delivery and time windows can
      // sway about 30 minutes if need be to optimize better").
      // PICKUPS ARE NEVER GATED: a pickup window is written as "5 minutes
      // after the accept time", i.e. already open, and sending it made HERE
      // park the whole trip at the end of the route regardless of geography.
      const WINDOW_SWAY_MINUTES = windowSway;
      // OWNER REPORT (Nov 4 2026): the two engines ordered Beverly and
      // Londonderry pickups oppositely because NO pickup was gated — pickups
      // with genuine windows floated on a distance tie-break. A pickup with a
      // real window END is a scheduled collection and gates like a delivery.
      const _pickupHasRealWindow = stop.isPickup === true && parseTimeToMinutes(stop.windowEnd) > 0;
      if (stop.isPickup !== true || _pickupHasRealWindow) {
        let openMin = parseTimeToMinutes(stop.windowStartRaw ?? stop.windowStart);
        let closeMin = parseTimeToMinutes(stop.windowEnd);
        // EXPIRED WINDOWS ARE NOT CONSTRAINTS (client parity). On TODAY's route
        // the client collapses a past start to 'now' and DROPS an end that has
        // already passed; an expired end sent to HERE makes the whole request
        // infeasible, which is how a server run and a client run ended up
        // producing two different orders. Future dates keep their real windows.
        if (routeIsToday) {
          if (Number.isFinite(openMin) && openMin < currentMinutes) {
            // Time-wravel the expired window onto today instead of flattening
            // it to "now": the ladder between stops is the actual instruction.
            openMin = _expiredShift > 0 ? openMin + _expiredShift : currentMinutes;
            if (Number.isFinite(closeMin) && _expiredShift > 0) closeMin = closeMin + _expiredShift;
          }
          if (Number.isFinite(closeMin) && closeMin <= currentMinutes) closeMin = null;
        }
        if (Number.isFinite(openMin)) openMin = Math.max(0, openMin - WINDOW_SWAY_MINUTES);
        if (Number.isFinite(closeMin)) closeMin = Math.min(23 * 60 + 59, closeMin + WINDOW_SWAY_MINUTES);
        // PARITY: pickups gate on their START only (see clientRouteEngine) — a
        // close side on a pickup made Beverly/Londonderry overlap and let HERE
        // pick Londonderry first.
        if (stop.isPickup === true) closeMin = null;
        const acc = buildAccessConstraint(
          deliveryDate,
          Number.isFinite(openMin) ? formatMinutesToTime(openMin) : null,
          Number.isFinite(closeMin) ? formatMinutesToTime(closeMin) : null,
        );
        if (acc) segments.push(acc);
      }
    }
    segments.push(`st:${Math.round((stop.extraTime || (stop.isPickup ? 15 : 5)) * 60)}`);
    params.set(`destination${index + 1}`, segments.join(';'));
  });

  // OWNER REPORT (Oct 23 2026): deferred edit-form optimization hangs forever.
  // Deno fetch has NO default timeout — a stalled HERE connection left the whole
  // function hanging, so the client's functions.invoke never resolved (KITT bar
  // forever, no audit entry, no client fallback). Client engine parity: 25s cap.
  // PARITY DIAGNOSTIC (owner report Nov 3 2026: server and client produced two
  // different orders for the same stops). The client logs its full HERE payload;
  // the server logged nothing, so a divergence could not be diagnosed from the
  // function logs. Compact one-liner: departure + every waypoint as id|acc|st.
  try {
    const _dest = [];
    for (let _i = 1; params.has(`destination${_i}`); _i++) _dest.push(params.get(`destination${_i}`));
    console.log(`[rxServerRouteOptimizer] HERE payload: depart=${params.get('departure')} mode=${params.get('mode')} improveFor=${params.get('improveFor')} start=${params.get('start')} end=${params.get('end')} stops=[${_dest.join(' , ')}]`);
  } catch (_) { /* diagnostics must never break sequencing */ }

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
    // STOP CAP REMOVED (owner directive Nov 2 2026: "cap is not need"). The
    // old 40-stop refusal was my own safety margin, not a HERE limit, and real
    // routes peak at 8-16 live stops at once (measured Oct 22 / 26 / 28), so it
    // only ever risked a silent fallback. The bound that remains is HERE's own:
    // findsequence2 rejects an oversized waypoint list, that surfaces as a
    // normal server error, and the coordinator falls back to the client engine.
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
    // OWNER REPORT (Nov 4 2026): "server optimizer has failed a few times today
    // and they were always when retrying failed deliveries from yesterday."
    // Retried stops can still carry transport_mode 'cycling' from the day they
    // were created while today's route is a plain driving route with no cycling
    // markers at all. That is stale flag data, not a cycling shape, so it must
    // NOT trip the Sep 8 rule — only a route that actually has cycling markers
    // but is missing its END marker is unsupported.
    const _staleCyclingFlag = _cyclingMarkers.length === 0 && _hasCyclingStops;
    if ((_cyclingMarkers.length > 0 || _hasCyclingStops) && !_endMarker && !_staleCyclingFlag) {
      return Response.json({ success: true, supported: false, reason: 'cycling_route_without_end_marker' });
    }
    const mixedMode = !!_endMarker;

    const { preserveExistingOrder = false, explicitNextDeliveryId = null, clearNextDeliveryLock = false, routeInProgress = false, forceRegenerate = false, viaPoint = null, polylineOrigin = null } = options;

    // ── Route preference (Fastest / Shortest / Best + traffic) ────────────────
    // OWNER DIRECTIVE (Oct 30 2026): "any changes that I make to the route
    // optimizer should be mirrored both client and server side." The client
    // passes the values it already resolved (polylineRoutePrefs) so a server run
    // sequences EXACTLY like the client would. When they are absent (an older
    // client, or the eventual client-less future the owner is aiming for) the
    // shared AppSettings 'route_optimization' record is read here, so the search
    // still honours the owner's setting instead of silently defaulting to
    // fastest/time. Any read failure leaves it null → shared default (fastest).
    let routePrefs = (payload?.routePrefs && typeof payload.routePrefs === 'object')
      ? {
          routePreference: payload.routePrefs.routePreference,
          trafficAware: payload.routePrefs.trafficAware === true,
        }
      : null;
    if (!routePrefs) {
      try {
        const sRows = await base44.entities.AppSettings.filter({ setting_key: 'route_optimization' });
        const sVal = sRows?.[0]?.setting_value;
        if (sVal && typeof sVal === 'object') {
          routePrefs = {
            routePreference: sVal.polylineRoutePreference,
            trafficAware: sVal.polylineTrafficAware === true,
          };
        }
      } catch (_) { /* keep null → shared defaults */ }
    }
    // CLIENT PARITY (owner reports Oct 26 2026): the SEQUENCING anchor
    // (origin — locked next stop, Oct 21 calibration) and the POLYLINE
    // anchor are DIFFERENT points on the client: polylineOrigin =
    // last completed stop -> home -> first active (clientRouteEngine
    // polylineOrigin), with the driver's live GPS inserted as a via and
    // per-stop deviation_waypoints as vias on each stop's inbound chain.
    // The current leg renders origin -> GPS -> next stop (client
    // renderStart=0) with ETA/distance metrics from the GPS->stop section
    // only (client metricsStart).
    // OWNER SPEC (Oct 26 2026, quick-reorder report): manual reorders /
    // force-regenerate runs repolyline ALL active stops in the caller's
    // order, chained from the last completed stop through the driver's LIVE
    // GPS (passed by the client builder as viaPoint, gated onDuty/inFlight/
    // >0.1km — same gates as the client's viaPointAfterOrigin) into the new
    // order. The rendered first leg includes the origin→GPS pre-leg (client
    // renderStart=0 parity); its ETA/distance metrics use ONLY the GPS→stop
    // section (client metricsStart parity).

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
      // Window ladder guard: never let a 5:00 PM stop sit ahead of a 2:00 PM one.
      return enforceWindowBands(resolved, currentMinutes);
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

    if (preserveExistingOrder) {
      // MANUAL REORDER (owner spec Oct 26 2026): keep the CALLER's order.
      // Chain = currentStopOrder sort; NO HERE sequencing, NO window-band
      // resort (client engine parity: preserveExistingOrder builds
      // routeStops straight from the caller's stop_order). The shared
      // pickup-before-pending + ISP-before-ISD constraints still apply as
      // safety, exactly like the client's activeStops pipeline.
      orderedStops = routeStops.slice().sort((a, b) =>
        (Number(a.currentStopOrder) || 99999) - (Number(b.currentStopOrder) || 99999));
      orderedStops = sharedEnforcePickupBeforePending(orderedStops, {});
      orderedStops = sharedEnforceIspBeforeIsd(orderedStops, {});
      console.log(`[rxServerRouteOptimizer] manual reorder: preserving caller order for ${orderedStops.length} stop(s)`);
    } else if (mixedMode) {
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
            mode: 'bicycle', apiKey, deliveryDate, currentMinutes, includeTimeWindows, routePrefs,
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
            mode: 'car', apiKey, deliveryDate, currentMinutes, includeTimeWindows, routePrefs,
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
      // PIN THE LOCKED NEXT STOP (client engine parity: routeOriginStop is
      // excluded from stopsToSequence and stitched FIRST). The builder now
      // ships ALL active stops (locked stop included) so the polyline chain
      // can generate the leg INTO it; sequencing must never reorder it.
      const _lockedStop = explicitNextDeliveryId && !clearNextDeliveryLock
        ? routeStops.find((st) => String(st.id) === String(explicitNextDeliveryId)) || null
        : null;
      const _seqPool = _lockedStop ? routeStops.filter((st) => st.id !== _lockedStop.id) : routeStops;
      try {
        if (_seqPool.length === 0) {
          orderedStops = _lockedStop ? [_lockedStop] : [];
        } else {
          const seqResult = await callHereSequence({
            origin, stops: _seqPool, home, apiKey, deliveryDate, currentMinutes, includeTimeWindows, routePrefs, routeIsToday: _routeIsToday,
          });
          orderedStops = _lockedStop ? [_lockedStop, ...resolveSequence(seqResult, _seqPool)] : resolveSequence(seqResult, _seqPool);
        }
        hereCalls++;
      } catch (seqErr) {
        // Degraded: nearest-neighbor crow-flies ordering (client would retry on
        // its own engine anyway if we report unsupported; instead we still
        // produce a deterministic order + polylines so the route stays usable).
        usedFallbackOrdering = true;
        console.warn(`[rxServerRouteOptimizer] findsequence2 failed (${seqErr?.message || seqErr}) — nearest-neighbor fallback`);
        const _nnPool = _lockedStop ? routeStops.filter((st) => st.id !== _lockedStop.id) : routeStops;
        const _nnOrdered = nearestNeighborOrder(_nnPool, origin);
        orderedStops = _lockedStop ? [_lockedStop, ..._nnOrdered] : _nnOrdered;
      }

      // ── 2. Window-band chronology (Sep 10 2026 semantics, 2-hour bands) ────
      // ── ORDER (owner spec Nov 3 2026): HERE owns it ─────────────────────
      // The windows now travel WITH the waypoints (both sides, ±30 min sway,
      // past starts clamped to now, pickups never gated), so HERE sequences by
      // road while honouring them. The 2h band sort and the closes-first /
      // deadline hoists are gone from this engine too — parity with the client.
      // ── 2b. SHARED RULE: pending deliveries follow their pickup (Oct 21) ──
      orderedStops = sharedEnforcePickupBeforePending(orderedStops, {});
      // ── 3. ISP-before-ISD ordering constraint (SHARED RULE: routeRules.js) ─
      orderedStops = sharedEnforceIspBeforeIsd(orderedStops, {});

      // (No post-HERE window sorting: windows are enforced by HERE itself now.)
    }

    // ── 3d. UNIT-NUMBER MICRO-SORT (SHARED RULE: routeRules.js) ─────────────
    // OWNER SPEC (Nov 2 2026): stops that share the same address or GPS
    // coordinates are subsorted by unit number (210 -> 222 -> 312 -> 336) so
    // the driver walks one building in unit order. Runs LAST, after every
    // window/pickup/ISP pass, matching the client engine's position — and only
    // reorders stops inside a cluster, so route chronology is untouched.
    try {
      sharedUnitNumberMicroSort(orderedStops, {
        idOf: (st) => st?.id,
        unitOf: (st) => st?.unitNumber || null,
        addressOf: (st) => st?.address || null,
        coordsOf: (st) => (Number.isFinite(Number(st?.lat)) && Number.isFinite(Number(st?.lng))
          ? { lat: Number(st.lat), lng: Number(st.lng) } : null),
        puidOf: (st) => st?.puid || null,
        eligible: (st) => !!st && !st.isPickup && !st.isInterStore && !st.isCyclingMarker &&
          ['pending', 'en_route', 'in_transit'].includes(String(st?.status || '').toLowerCase()) &&
          String(st?.deliveryId || '').toUpperCase().startsWith('DID'),
      });
    } catch (unitErr) {
      console.warn(`[rxServerRouteOptimizer] unit micro-sort skipped: ${unitErr?.message || unitErr}`);
    }

    // ── 3d2. SHARED RULE: unfilled pickups in ascending window START order ──
    // OWNER DIRECTIVE Nov 4 2026: pickup windows only sequence pickups, start
    // side only, and that ordering must hold through every live re-sequence.
    try {
      orderedStops = sharedEnforcePickupWindowOrder(orderedStops, {
        isPickupOf: (st) => !!st?.isPickup,
        statusOf: (st) => st?.status,
        startOf: (st) => st?.deliveryTimeStart,
      });
    } catch (pickupSeqErr) {
      console.warn(`[rxServerRouteOptimizer] pickup window order skipped: ${pickupSeqErr?.message || pickupSeqErr}`);
    }

    // ── 3e. SHARED RULE: an IN-HAND stop is never dragged behind its pickup ──
    // OWNER DIRECTIVE Nov 3 2026: "it is the delivery must be after pickup rule
    // I think. even though this stop is already in transit. That status should
    // negate the pickup before delivery rule." Runs LAST (after bands, pickup
    // swaps, ISP-ISD and the unit micro-sort) so nothing can re-bury it.
    try {
      orderedStops = sharedEnforceInHandBeforePickup(orderedStops, {
        idOf: (st) => st?.id,
        patientOf: (st) => st?.patientId,
        puidOf: (st) => st?.puid,
        statusOf: (st) => st?.status,
        isPickupOf: (st) => !!st?.isPickup,
        pickupKeyOf: (st) => st?.stopId,
        // FIELD PARITY (owner report Nov 3 2026): the client passes the
        // delivery's OWN start (delivery_time_start), this passed the resolved
        // windowStart — which for a windowless stop is the INHERITED pickup
        // start + 5 min. The rule then read "this stop starts AFTER its
        // pickup" and refused to move it, while the client moved it: one rule,
        // two answers, different route. Same field on both engines now.
        startOf: (st) => st?.deliveryTimeStart,
      });
    } catch (inHandErr) {
      console.warn(`[rxServerRouteOptimizer] in-hand pickup bypass skipped: ${inHandErr?.message || inHandErr}`);
    }

    // ── 3f. CYCLING BLOCK STRUCTURE (owner report Nov 3 2026) ────────────────
    // The loop is ONE block: [start marker] → [cycling stops] → [end marker],
    // and every driving stop comes AFTER the end marker. Each pass above (bands,
    // pickup follow, ISP/ISD, unit micro-sort, in-hand) moves individual stops
    // and can drop a driving stop into the loop or leave a cycling stop outside
    // it — the owner's route came back with the end marker at 9 and its cycling
    // stops at 11-13. Runs LAST so no earlier pass can undo it. SHARED RULE:
    // routeRules.js enforceCyclingBlock (identical on the client engine).
    try {
      const _cycBefore = orderedStops.map((st) => String(st?.id)).join(',');
      orderedStops = sharedEnforceCyclingBlock(orderedStops, {
        idOf: (st) => st?.id,
        notesOf: (st) => st?.deliveryNotes,
        isMarkerOf: (st) => st?.isCyclingMarker === true,
        transportModeOf: (st) => st?.transportMode,
        statusOf: (st) => st?.status,
      });
      if (_cycBefore !== orderedStops.map((st) => String(st?.id)).join(',')) {
        console.log('[rxServerRouteOptimizer] cycling block restored: [start] cycling stops [end] then driving stops');
      }
    } catch (cycErr) {
      console.warn(`[rxServerRouteOptimizer] cycling block enforcement skipped: ${cycErr?.message || cycErr}`);
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
      // POLYLINE CHAIN (client-parity rewrite, Oct 26 2026): anchor the FIRST
      // mode run at polylineOrigin (last completed stop -> home -> first
      // active — NOT the sequencing origin), insert per-stop deviation vias
      // and the driver's live GPS on the current leg, then split each stop's
      // inbound sections into RENDER (whole chain merged, client renderStart)
      // and METRICS (GPS->stop only on the live-GPS leg — client metricsStart;
      // whole chain otherwise).
      // OWNER DIRECTIVE (Oct 27 2026): the current leg runs
      // lastFinished/home → [vias] → live GPS → first stop — NEVER
      // firstStop → GPS → firstStop. polylineOrigin comes from the client
      // (lastFinished → home → null); the old `origin` fallback was the
      // LOCKED NEXT STOP (the leg's own destination) → doubling. Anchoring
      // ladder now: polylineOrigin → live-GPS via (via insertion suppressed)
      // → first-stop degenerate anchor (same-address handler synthesizes a
      // 2-point, 0 km leg — never a loop).
      let _polyOrigin = (polylineOrigin && Number.isFinite(Number(polylineOrigin.lat)) && Number.isFinite(Number(polylineOrigin.lng)))
        ? { lat: Number(polylineOrigin.lat), lon: Number(polylineOrigin.lng) }
        : null;
      let _suppressLiveVia = false;
      const _liveViaValid = viaPoint && Number.isFinite(Number(viaPoint.lat)) && Number.isFinite(Number(viaPoint.lng));
      if (_polyOrigin && _liveViaValid && eligibleStops.length > 0) {
        const _okm = codecCrowFliesKm(_polyOrigin.lat, _polyOrigin.lon, Number(eligibleStops[0].lat), Number(eligibleStops[0].lng));
        if (Number.isFinite(_okm) && _okm < 0.15) {
          console.warn(`[rxServerRouteOptimizer] polyline origin ≈ first stop (${_okm.toFixed(3)}km) — re-anchored current leg at the live-GPS via (owner Oct 27)`);
          _polyOrigin = { lat: Number(viaPoint.lat), lon: Number(viaPoint.lng) };
          _suppressLiveVia = true;
        }
      }
      // OWNER DIRECTIVE (Oct 27 2026): the driver's LIVE GPS is NEVER a
      // polyline origin — anchoring there drew a parking-lot->stop stub and
      // deleted the home->stop leg when the home failed to resolve. A missing
      // anchor now falls to the degenerate first-stop anchor (no inbound leg
      // is drawn at all) while the client builder's DB fallback ensures home
      // resolves in the first place.
      if (!_polyOrigin && eligibleStops.length > 0) {
        console.warn('[rxServerRouteOptimizer] no polyline origin and no live via — degenerate first-leg anchor at the first stop (no loop, owner Oct 27)');
        _polyOrigin = { lat: Number(eligibleStops[0].lat), lon: Number(eligibleStops[0].lng) };
        _suppressLiveVia = true;
      }
      if (!_polyOrigin) { _polyOrigin = { lat: origin.lat, lon: origin.lng }; }
      const _liveVia = viaPoint && Number.isFinite(Number(viaPoint.lat)) && Number.isFinite(Number(viaPoint.lng))
        ? { lat: Number(viaPoint.lat), lon: Number(viaPoint.lng) } : null;
      const _decodeChain = (encList) => {
        let all = [];
        for (const e of encList) {
          const c = decodeGooglePolyline(e);
          if (!c.length) continue;
          all = all.length ? [...all, ...c.slice(1)] : c;
        }
        return all;
      };
      let gi = 0;
      while (gi < eligibleStops.length) {
        const mode = legModeFor(eligibleStops[gi]);
        let gj = gi;
        while (gj < eligibleStops.length && legModeFor(eligibleStops[gj]) === mode) gj++;
        const anchor = gi === 0
          ? _polyOrigin
          : { lat: eligibleStops[gi - 1].lat, lon: eligibleStops[gi - 1].lng };
        const pts = [{ lat: anchor.lat, lon: anchor.lon }];
        const stopIdxs = [];
        const viaCounts = [];
        let liveOnFirst = false;
        eligibleStops.slice(gi, gj).forEach((st, li) => {
          let dev = Array.isArray(st.deviationWaypoints) ? st.deviationWaypoints : [];
          // OWNER REPORT (Oct 27 2026): stale pre-leg deviation points outside
          // any sane detour drew a round-trip loop on a short current leg
          // (client-parity detour budget: max(3x direct, direct + 5km)).
          if (gi === 0 && li === 0 && dev.length > 0) {
            const _budgetKm = Math.max(
              codecCrowFliesKm(anchor.lat, anchor.lon, st.lat, st.lng) * 3,
              codecCrowFliesKm(anchor.lat, anchor.lon, st.lat, st.lng) + 5
            );
            const _kept = dev.filter((v) =>
              (codecCrowFliesKm(anchor.lat, anchor.lon, Number(v.lat), Number(v.lng))
                + codecCrowFliesKm(Number(v.lat), Number(v.lng), st.lat, st.lng)) <= _budgetKm);
            if (_kept.length !== dev.length) {
              console.warn(`[rxServerRouteOptimizer] dropped ${dev.length - _kept.length} stale deviation via(s) outside the ${_budgetKm.toFixed(1)}km detour budget (owner Oct 27)`);
            }
            dev = _kept;
          }
          dev.forEach((v) => pts.push({ lat: Number(v.lat), lon: Number(v.lng) }));
          viaCounts.push(dev.length);
          if (li === 0 && gi === 0 && _liveVia && !_suppressLiveVia) {
            pts.push({ lat: _liveVia.lat, lon: _liveVia.lon });
            liveOnFirst = true;
          }
          stopIdxs.push(pts.length);
          pts.push({ lat: st.lat, lon: st.lng });
        });
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
          const secs = (r.sections || []);
          eligibleStops.slice(gi, gj).forEach((st, li) => {
            const stopIdx = stopIdxs[li];
            const viaCount = viaCounts[li] || 0;
            const liveOnLeg = liveOnFirst && li === 0;
            // renderStart=0 with the live GPS on the leg (include the driven
            // origin->GPS pre-leg, client renderStart=0); else the chain from
            // its first via section.
            const renderStart = liveOnLeg ? 0 : Math.max(0, stopIdx - 1 - viaCount);
            const metricsStart = liveOnLeg ? Math.max(1, stopIdx - 1) : Math.max(0, stopIdx - 1 - viaCount);
            const renderSecs = secs.slice(renderStart, stopIdx).filter(Boolean);
            const metricSecs = secs.slice(metricsStart, stopIdx).filter(Boolean);
            let merged = _decodeChain(renderSecs.map((x) => x.encoded_polyline).filter(Boolean));
            let metricDuration = metricSecs.reduce((sum, x) => sum + (Number(x.estimated_duration_minutes) || 0), 0);
            let metricDistance = metricSecs.reduce((sum, x) => sum + (Number(x.estimated_distance_km) || 0), 0);
            let encoded = merged.length > 1 ? encodeGooglePolyline(merged) : (renderSecs[renderSecs.length - 1]?.encoded_polyline || null);

            // DUPLICATE-COORDINATE LEG (owner report Oct 26 2026: two stops at
            // the same location reordered in the adjust panel — the now-SECOND
            // stop kept the long polyline from when it was the FIRST stop at
            // that address). Client parity (routePolylineGenerator sameAnchorLeg,
            // Oct 15 2026): a stop whose inbound anchor sits at (nearly) the
            // same point gets a synthesized degenerate leg — 2-point polyline,
            // 2-minute travel, ~0 km — so the write NEVER omits the field and
            // the stale previous-route leg can't survive the re-optimization.
            const _anchorPt = pts[stopIdx - 1] || null;
            const _stopPt = { lat: Number(st.lat), lon: Number(st.lng) };
            // OWNER FIX (Oct 27 2026): never collapse the CURRENT LEG (live-GPS
            // leg) to a 2-point stub when the driver has arrived — the full
            // lastFinished/home -> driven path -> GPS -> stop chain must stay.
            if (_anchorPt && !liveOnLeg) {
              const _km = codecCrowFliesKm(_anchorPt.lat, _anchorPt.lon, _stopPt.lat, _stopPt.lon);
              if (Number.isFinite(_km) && _km < 0.05) {
                encoded = encodeGooglePolyline([[Number(_anchorPt.lat), Number(_anchorPt.lon)], [_stopPt.lat, _stopPt.lon]]);
                metricDuration = 2;
                metricDistance = Number(_km.toFixed(3));
              } else if (encoded == null) {
                // MISSING-SECTION FALLBACK (client Oct 23 2026 parity): a
                // partial provider response must leave every stop with a
                // painted leg — straight line from the inbound anchor. The
                // next healthy optimization replaces it with the road shape.
                encoded = encodeGooglePolyline([[Number(_anchorPt.lat), Number(_anchorPt.lon)], [_stopPt.lat, _stopPt.lon]]);
                if (metricDuration <= 0) metricDuration = Math.max(1, Math.ceil((_km / 40) * 60));
                if (metricDistance <= 0 && Number.isFinite(_km)) metricDistance = Number(_km.toFixed(3));
              }
            }

            sectionByStopId.set(st.id, {
              encoded_polyline: encoded,
              estimated_duration_minutes: metricDuration > 0 ? Math.ceil(metricDuration) : null,
              estimated_distance_km: metricDistance > 0 ? Number(metricDistance.toFixed(3)) : null,
              transport_mode: mode,
            });
          });
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
    // OWNER REPORT (Oct 30 2026, CLIENT PARITY): "many times today I've had to set
    // a stop as the next delivery again ... my isNextDelivery flag is gone." A
    // mid-route run with NO flag present resolved nextStopId to null, and the
    // writeBatch then stamped isNextDelivery:false on EVERY stop — the route ended
    // up with no next stop at all, and every later run reinforced it. Rule 3 is now
    // the same real fallback the client engine uses: promote the first ACCEPTED
    // active stop (non-pending preferred, inter-store last) so a route always keeps
    // exactly one next stop. An existing explicit flag still wins untouched.
    const _midRouteFallback = (() => {
      const nonInterStore = orderedStops.filter((st) => !st.isInterStore);
      const pool = nonInterStore.length > 0 ? nonInterStore : orderedStops;
      const accepted = pool.find((st) => String(st.status || '').toLowerCase() !== 'pending');
      return accepted?.id || pool[0]?.id || null;
    })();
    const nextStopId = (explicitNextDeliveryId && !clearNextDeliveryLock ? explicitNextDeliveryId : null)
      || (clearNextDeliveryLock
        ? (firstNonInterStoreActive?.id || orderedStops[0]?.id || null)
        : (!routeInProgress ? (firstNonInterStoreActive?.id || orderedStops[0]?.id || null) : _midRouteFallback));

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
      // OWNER DIRECTIVE (Oct 27 2026 evening): clear deviation_waypoints on
      // every ACTIVE non-next stop at polyline generation/commit time —
      // parity with the client engine's pre-generation clear. The next
      // stop keeps its waypoints (live driven path of the current leg).
      if (!isNextStop && !stop.isCyclingMarker
        && ['pending', 'in_transit', 'en_route'].includes(String(stop.status || ''))
        && Array.isArray(stop.deviationWaypoints) && stop.deviationWaypoints.length > 0) {
        updateData.deviation_waypoints = [];
      }
      writeBatch.push({ id: stop.id, data: updateData });
    }

    // ── API-usage badge parity (owner report Oct 24 2026) ──────────────────
    // With serverSideOptimization armed, drag-reorders and manual reopts run
    // HERE/Google ON THE SERVER — the admin Google API usage badge showed ZERO
    // hits while polylines were in fact regenerating, making a working flow
    // look dead. Log the server-side calls to GoogleAPILog (same shape the
    // client generator logs) so the badge reflects server work. Best-effort:
    // never blocks the response.
    try {
      if (googleCalls > 0) {
        await base44.entities.GoogleAPILog.create({
          timestamp: new Date().toISOString(),
          api_type: 'Directions',
          purpose: `Server-side route optimization (Google Directions) — ${orderedStops.length} stop(s)`,
          function_name: 'rxServerRouteOptimizer',
          user_id: driverId || null,
          user_name: driverName || null,
          metadata: { provider: 'GOOGLE', source: 'server_optimizer', call_count: googleCalls },
        });
      }
      if (hereCalls > 0) {
        await base44.entities.GoogleAPILog.create({
          timestamp: new Date().toISOString(),
          api_type: 'Route Optimization (HERE)',
          purpose: `Server-side route optimization — findsequence2/router — ${orderedStops.length} stop(s)`,
          function_name: 'rxServerRouteOptimizer',
          user_id: driverId || null,
          user_name: driverName || null,
          metadata: { provider: 'HERE', source: 'server_optimizer', call_count: hereCalls },
        });
      }
    } catch (_) { /* badge logging must never break the optimization */ }

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
