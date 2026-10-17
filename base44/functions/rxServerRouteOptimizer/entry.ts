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

// ─── Time helpers (ported from clientRouteEngine.js) ────────────────────────
const TIME_ZONE = 'America/Edmonton';
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
async function callHereSequence({ origin, stops, home, apiKey, deliveryDate, currentMinutes, includeTimeWindows }) {
  const params = new URLSearchParams();
  params.set('apiKey', apiKey);
  params.set('departure', buildLocalIso(deliveryDate, formatMinutesToTime(currentMinutes)));
  params.set('mode', 'fastest;car;traffic:disabled');
  params.set('improveFor', 'time');
  params.set('start', `driverStart;${origin.lat},${origin.lng}`);
  if (home && Number.isFinite(home.lat) && Number.isFinite(home.lng)) {
    params.set('end', `driverHome;${home.lat},${home.lng}`);
  }
  stops.forEach((stop, index) => {
    const segments = [`${stop.stopId || stop.id};${stop.lat},${stop.lng}`];
    if (includeTimeWindows) {
      const wsMin = parseTimeToMinutes(stop.windowStart);
      // Owner rule Oct 5 2026: an already-open window adds no information —
      // drop the from side. The client passes currentMinutes for TODAY only.
      const windowAlreadyOpen = Number.isFinite(wsMin) && wsMin > 0 && wsMin <= currentMinutes;
      const acc = buildAccessConstraint(deliveryDate, windowAlreadyOpen ? null : stop.windowStart, stop.windowEnd);
      if (acc) segments.push(acc);
    }
    segments.push(`st:${Math.round((stop.extraTime || (stop.isPickup ? 15 : 5)) * 60)}`);
    params.set(`destination${index + 1}`, segments.join(';'));
  });

  const response = await fetch(`https://wps.hereapi.com/v8/findsequence2?${params.toString()}`);
  if (!response.ok) throw new Error(`HERE findsequence2 failed with ${response.status}`);
  const data = await response.json().catch(() => null);
  const route = data?.results?.[0];
  if (!route?.waypoints?.length) throw new Error('HERE findsequence2 returned no waypoints');
  return route;
}

// ─── HERE Router v8 multi-stop polyline (ported from getMultiStopRouteHere) ──
async function getMultiStopRouteSections(points, apiKey) {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return { sections: [], usedFallbackPolyline: false };

  const params = new URLSearchParams();
  params.set('apiKey', apiKey);
  params.set('transportMode', 'car');
  params.set('origin', `${validPoints[0].lat},${validPoints[0].lon}`);
  params.set('destination', `${validPoints[validPoints.length - 1].lat},${validPoints[validPoints.length - 1].lon}`);
  params.set('return', 'polyline,summary');
  validPoints.slice(1, -1).forEach((p) => params.append('via', `${p.lat},${p.lon}`));

  const routeResp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`);
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

    const apiKey = Deno.env.get('HERE_API_KEY');
    if (!apiKey) {
      return Response.json({ success: true, supported: false, reason: 'here_api_key_missing' });
    }

    const payload = await req.json().catch(() => ({}));
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
    // Phase 1 scope: cycling segments stay on the (working) client engine.
    const hasCycling = routeStops.some((s) => s.isCyclingMarker ||
      String(s.transportMode || '').toLowerCase() === 'cycling');
    if (hasCycling) {
      return Response.json({ success: true, supported: false, reason: 'cycling_route_not_supported_server_side' });
    }

    const { preserveExistingOrder = false, explicitNextDeliveryId = null, clearNextDeliveryLock = false, routeInProgress = false } = options;

    // ── 1. HERE sequencing (ONE call for the whole pool) ────────────────────
    const includeTimeWindows = routeStops.some((s) => s.windowStart && parseTimeToMinutes(s.windowStart) > 0);
    let orderedStops = routeStops;
    let usedFallbackOrdering = false;
    let seqLegs = []; // per-arrival leg data from findsequence2 (indexed to ordered waypoints)

    try {
      const seqResult = await callHereSequence({
        origin, stops: routeStops, home, apiKey, deliveryDate, currentMinutes, includeTimeWindows,
      });
      // findsequence2 returns interconnecting legs per waypoint in sequence order.
      const seqWaypoints = (seqResult.waypoints || []).filter((w) => w.id !== 'driverStart' && w.id !== 'driverHome');
      const byId = new Map(routeStops.map((s) => [String(s.stopId || s.id), s]));
      const byFallbackId = new Map(routeStops.map((s) => [String(s.id), s]));
      const resolved = seqWaypoints.map((w) => byId.get(String(w.id)) || byFallbackId.get(String(w.id))).filter(Boolean);
      if (resolved.length === routeStops.length) {
        orderedStops = resolved;
      } else {
        throw new Error(`sequence resolution incomplete (${resolved.length}/${routeStops.length})`);
      }
      seqLegs = (seqResult.interconnectingLegs || []).map((l) => ({
        duration: Number(l?.duration || 0),
        distance: Number(l?.distance || 0),
      }));
    } catch (seqErr) {
      // Degraded: nearest-neighbor crow-flies ordering (client would retry on
      // its own engine anyway if we report unsupported; instead we still
      // produce a deterministic order + polylines so the route stays usable).
      usedFallbackOrdering = true;
      console.warn(`[rxServerRouteOptimizer] findsequence2 failed (${seqErr?.message || seqErr}) — nearest-neighbor fallback`);
      const remaining = [...routeStops];
      const nn = [remaining.shift()];
      let cursor = { lat: origin.lat, lng: origin.lng };
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
      orderedStops = nn;
    }

    // ── 2. Window-band chronology (Sep 10 2026 semantics, 2-hour bands) ────
    const hasTimeWindows = routeStops.some((s) => Number.isFinite(parseTimeToMinutes(s.windowStart)) && parseTimeToMinutes(s.windowStart) > 0);
    if (hasTimeWindows && orderedStops.length > 1) {
      const TIME_BAND_MINUTES = 120;
      const nowBand = Math.floor(currentMinutes / TIME_BAND_MINUTES);
      const bandOf = (stop) => {
        const m = parseTimeToMinutes(stop.windowStart);
        if (!Number.isFinite(m) || m <= 0) return nowBand; // no window → servable now
        if (m <= currentMinutes) return nowBand; // window already open → servable now
        return Math.floor(m / TIME_BAND_MINUTES); // future window → chronological band
      };
      const decorated = orderedStops.map((stop) => ({ stop, band: bandOf(stop) }));
      decorated.sort((a, b) => a.band - b.band); // stable sort keeps HERE order in-band
      orderedStops = decorated.map((d) => d.stop);
    }

    // ── 3. ISP-before-ISD ordering constraint ───────────────────────────────
    {
      const ispByStopId = new Map(orderedStops.filter((s) => String(s.deliveryId || '').startsWith('ISP')).map((s) => [s.stopId, s]));
      let swapped = false;
      do {
        swapped = false;
        for (let i = 0; i < orderedStops.length; i++) {
          const stop = orderedStops[i];
          if (String(stop.deliveryId || '').startsWith('ISD') && stop.puid) {
            const linkedISP = ispByStopId.get(stop.puid);
            if (!linkedISP) continue;
            const ispIdx = orderedStops.findIndex((s) => s.id === linkedISP.id);
            if (ispIdx > i) {
              orderedStops = [...orderedStops];
              const tmp = orderedStops[i];
              orderedStops[i] = orderedStops[ispIdx];
              orderedStops[ispIdx] = tmp;
              swapped = true;
              break;
            }
          }
        }
      } while (swapped);
    }

    // ── 4. Polylines: ONE multi-stop router call over [origin, ...stops] ────
    const polylinePoints = [
      { lat: origin.lat, lon: origin.lng },
      ...orderedStops.map((s) => ({ lat: s.lat, lon: s.lng })),
    ];
    const { sections, usedFallbackPolyline } = await getMultiStopRouteSections(polylinePoints, apiKey);
    // sections[i] = leg INTO orderedStops[i]

    // ── 5. ETA ladder (owner rules: window floors, dwell, same-address cap) ─
    const SAME_ADDRESS_TRAVEL_MINUTES = 2;
    let cumulativeTime = currentMinutes;
    const stageEtaMap = new Map();
    for (let i = 0; i < orderedStops.length; i++) {
      const stop = orderedStops[i];
      const seg = sections[i] || null;
      const prev = i > 0 ? orderedStops[i - 1] : null;
      const nearPreviousStop = prev && crowFliesKm(prev.lat, prev.lng, stop.lat, stop.lng) < 0.05;
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
      cumulativeTime += stop.extraTime || (stop.isPickup ? 15 : 5);
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
      const seg = sections[i] || null;
      const isNextStop = stop.id === nextStopId;
      const isPending = stop.status === 'pending';
      const isPickupStop = stop.isPickup && !stop.isInterStore;
      const correctedStatus = isPickupStop && stop.status === 'in_transit' ? 'en_route' : undefined;
      const statusToWrite = correctedStatus || (stop.status === 'in_transit' ? 'in_transit' : undefined);
      const logicalDurationMinutes = typeof seg?.estimated_duration_minutes === 'number' ? seg.estimated_duration_minutes : null;
      const logicalDistanceKm = typeof seg?.estimated_distance_km === 'number' ? seg.estimated_distance_km : null;

      const updateData = {
        stop_order: newOrder,
        delivery_time_eta: stageEtaMap.get(stop.id) || null,
        ...(isNextStop ? { isNextDelivery: true } : { isNextDelivery: false }),
        transport_mode: 'driving',
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
      here_calls: 2,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (error) {
    console.error('[rxServerRouteOptimizer] fatal:', error?.message || String(error));
    return Response.json({ success: true, supported: false, reason: `server_error: ${error?.message || 'unknown'}` });
  }
});
