// .repro/sdk-stub.js
var createClientFromRequest = () => ({
  auth: { me: async () => ({ id: "owner-test", email: "a@b.c" }) },
  asServiceRole: { entities: { AppUser: { filter: async () => [{ is_app_owner: true, app_roles: ["app_owner"] }] } } },
  entities: {},
  functions: { invoke: async () => ({}) }
});

// base44/functions/rxServerRouteOptimizer/routeRules.js
var TIME_BAND_MINUTES = 120;
var SAME_ADDRESS_TRAVEL_MINUTES = 2;
var PICKUP_DWELL_MINUTES = 15;
var DELIVERY_DWELL_MINUTES = 5;
var SAME_ADDRESS_KM = 0.05;
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return Infinity;
  const parts = timeStr.split(":");
  if (parts.length < 2) return Infinity;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return Infinity;
  return h * 60 + m;
}
function formatMinutesToTime(totalMinutes) {
  const m = Math.max(0, Math.round(Number(totalMinutes) || 0));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function crowFliesKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = ((b.lon ?? b.lng) - (a.lon ?? a.lng)) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function inheritedPickupWindowStart(pickupWindowStart) {
  const m = parseTimeToMinutes(pickupWindowStart);
  if (m === Infinity || m <= 0) return null;
  return formatMinutesToTime(m + 5);
}
function inheritPickupWindows(stops, adapters) {
  const {
    patientOf = (s) => s.patientId,
    puidOf = (s) => s.puid,
    windowOf = (s) => s.windowStart,
    setWindowOf = (s, w) => {
      s.windowStart = w;
    },
    isPickupOf = (s) => s.isPickup,
    pickupKeyOf = (s) => s.stopId,
    pickupWindowOf = null
  } = adapters || {};
  const pickupWindowByStopId = /* @__PURE__ */ new Map();
  for (const s of stops || []) {
    if (!isPickupOf(s)) continue;
    const w = pickupWindowOf ? pickupWindowOf(s) : windowOf(s);
    pickupWindowByStopId.set(pickupKeyOf(s), { start: w ?? null });
  }
  let inherited = 0;
  for (const s of stops || []) {
    if (!patientOf(s) || !puidOf(s)) continue;
    const own = windowOf(s);
    if (own && parseTimeToMinutes(own) !== Infinity) continue;
    const w = inheritedPickupWindowStart(pickupWindowByStopId.get(puidOf(s))?.start);
    if (w) {
      setWindowOf(s, w);
      inherited++;
    }
  }
  return inherited;
}
function windowBandOfStop(stop, { routeIsToday, currentMinutes, windowOf }) {
  const nowBand = Math.floor(currentMinutes / TIME_BAND_MINUTES);
  const m = parseTimeToMinutes(windowOf(stop) || "");
  if (!Number.isFinite(m) || m <= 0) return nowBand;
  if (routeIsToday && m <= currentMinutes) return nowBand;
  return Math.floor(m / TIME_BAND_MINUTES);
}
function windowBandSort(stops, { routeIsToday, currentMinutes, windowOf }) {
  const bandOf = (stop) => windowBandOfStop(stop, { routeIsToday, currentMinutes, windowOf });
  const inputOrder = new Map((stops || []).map((s, i) => [s, i]));
  return [...stops || []].sort((a, b) => {
    const bandDiff = bandOf(a) - bandOf(b);
    if (bandDiff !== 0) return bandDiff;
    return (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0);
  });
}
function hasTimeWindows(stops, windowOf) {
  return (stops || []).some((s) => {
    const m = parseTimeToMinutes(windowOf(s) || "");
    return Number.isFinite(m) && m > 0;
  });
}
function enforceIspBeforeIsd(stops, adapters) {
  const {
    idOf = (s) => s.id,
    deliveryIdOf = (s) => s.deliveryId,
    puidOf = (s) => s.puid,
    stopIdOf = (s) => s.stopId
  } = adapters || {};
  let ordered = [...stops || []];
  const ispByStopId = new Map(ordered.filter((s) => String(deliveryIdOf(s) || "").startsWith("ISP")).map((s) => [String(stopIdOf(s)), s]));
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let i = 0; i < ordered.length; i++) {
      const stop = ordered[i];
      if (String(deliveryIdOf(stop) || "").startsWith("ISD") && puidOf(stop)) {
        const linkedISP = ispByStopId.get(String(puidOf(stop)));
        if (!linkedISP) continue;
        const ispIdx = ordered.findIndex((s) => idOf(s) === idOf(linkedISP));
        if (ispIdx > i) {
          const tmp = ordered[i];
          ordered[i] = ordered[ispIdx];
          ordered[ispIdx] = tmp;
          swapped = true;
          break;
        }
      }
    }
  }
  return ordered;
}
function enforcePickupBeforePendingDeliveries(stops, adapters) {
  const {
    idOf = (s) => s.id,
    patientOf = (s) => s.patientId,
    puidOf = (s) => s.puid,
    statusOf = (s) => s.status,
    isPickupOf = (s) => s.isPickup,
    pickupKeyOf = (s) => s.stopId
  } = adapters || {};
  let ordered = [...stops || []];
  const pickupByKey = new Map(ordered.filter((s) => isPickupOf(s)).map((s) => [String(pickupKeyOf(s)), s]));
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let i = 0; i < ordered.length; i++) {
      const stop = ordered[i];
      const isPending = String(statusOf(stop) || "").toLowerCase() === "pending";
      if (!isPending || !patientOf(stop) || !puidOf(stop)) continue;
      const pickup = pickupByKey.get(String(puidOf(stop)));
      if (!pickup) continue;
      const pIdx = ordered.findIndex((s) => idOf(s) === idOf(pickup));
      if (pIdx > i) {
        const tmp = ordered[i];
        ordered[i] = ordered[pIdx];
        ordered[pIdx] = tmp;
        swapped = true;
        break;
      }
    }
  }
  return ordered;
}
function isPolylineEligibleStop({ status, isCyclingMarker, transportMode }) {
  const st = String(status || "").toLowerCase();
  if (st === "en_route" || st === "in_transit") return true;
  if (isCyclingMarker === true) return true;
  if (String(transportMode || "").toLowerCase() === "cycling") return true;
  return false;
}
function dwellMinutesForStop({ extraTime, isPickup }) {
  const extra = Number(extraTime);
  if (Number.isFinite(extra) && extra > 0) return extra;
  return isPickup ? PICKUP_DWELL_MINUTES : DELIVERY_DWELL_MINUTES;
}
function isSameAddressAnchor(a, b, km = SAME_ADDRESS_KM) {
  const d = crowFliesKm(a, b);
  return Number.isFinite(d) && d < km;
}

// .repro/entry-harness.ts
var TIME_ZONE = "America/Edmonton";
var edmontonTodayStr = () => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(/* @__PURE__ */ new Date());
  } catch (_) {
    return "";
  }
};
var WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
var parseTimeToMinutes2 = (timeStr) => {
  if (!timeStr || typeof timeStr !== "string") return Infinity;
  const parts = timeStr.split(":");
  if (parts.length < 2) return Infinity;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return Infinity;
  return h * 60 + m;
};
var formatMinutesToTime2 = (minutes) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};
var normalizeTimeString = (timeStr, fallback = "00:00:00") => {
  if (!timeStr || typeof timeStr !== "string") return fallback;
  const parts = timeStr.split(":");
  if (parts.length < 2) return fallback;
  return `${String(Number(parts[0]) || 0).padStart(2, "0")}:${String(Number(parts[1]) || 0).padStart(2, "0")}:${String(Number(parts[2]) || 0).padStart(2, "0")}`;
};
var getWeekdayCode = (dateStr) => {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  return WEEKDAY_CODES[utcDate.getUTCDay()];
};
var getTimeZoneOffset = (dateStr) => {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const sampleDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  const tzName = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    timeZoneName: "shortOffset",
    hour: "2-digit"
  }).formatToParts(sampleDate).find((part) => part.type === "timeZoneName")?.value || "GMT-07:00";
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return "-07:00";
  return `${match[1]}${String(match[2]).padStart(2, "0")}:${String(match[3] || "00").padStart(2, "0")}`;
};
var buildLocalIso = (dateStr, timeStr) => `${dateStr}T${normalizeTimeString(timeStr)}${getTimeZoneOffset(dateStr)}`;
var buildAccessConstraint = (dateStr, startTime, endTime) => {
  if (!startTime && !endTime) return null;
  const startMinutes = parseTimeToMinutes2(startTime);
  const endMinutes = parseTimeToMinutes2(endTime);
  if (Number.isFinite(startMinutes) && Number.isFinite(endMinutes) && endMinutes <= startMinutes) return null;
  const weekday = getWeekdayCode(dateStr);
  const offset = getTimeZoneOffset(dateStr);
  const start = normalizeTimeString(startTime, "00:00:00");
  const end = normalizeTimeString(endTime, "23:59:59");
  return `acc:${weekday}${start}${offset}|${weekday}${end}${offset}`;
};
var EARTH_RADIUS_KM = 6371;
var crowFliesKm2 = (lat1, lng1, lat2, lng2) => {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
var encodeGooglePolyline = (coords) => {
  let output = "";
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
      let v = delta < 0 ? ~(delta << 1) : delta << 1;
      while (v >= 32) {
        output += String.fromCharCode((32 | v & 31) + 63);
        v >>= 5;
      }
      output += String.fromCharCode(v + 63);
    }
  }
  return output;
};
var decodeHereFlexiblePolyline = (encoded) => {
  const coords = [];
  if (!encoded || typeof encoded !== "string") return coords;
  let index = 0;
  const decodeVarint = () => {
    let result = 0, shift = 0, byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 31) << shift;
      shift += 5;
    } while (byte >= 32);
    return result & 1 ? ~(result >>> 1) : result >>> 1;
  };
  let lat = 0, lng = 0;
  while (index < encoded.length) {
    lat += decodeVarint();
    lng += decodeVarint();
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
};
async function callHereSequence({ origin, stops, home, destination, mode = "car", apiKey, deliveryDate, currentMinutes, includeTimeWindows }) {
  const params = new URLSearchParams();
  params.set("apiKey", apiKey);
  params.set("departure", buildLocalIso(deliveryDate, formatMinutesToTime2(currentMinutes)));
  params.set("mode", `fastest;${mode};traffic:disabled`);
  params.set("improveFor", "time");
  params.set("start", `driverStart;${origin.lat},${origin.lng}`);
  if (destination && Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
    params.set("end", `routeEnd;${destination.lat},${destination.lng}`);
  } else if (home && Number.isFinite(home.lat) && Number.isFinite(home.lng)) {
    params.set("end", `driverHome;${home.lat},${home.lng}`);
  }
  stops.forEach((stop, index) => {
    const segments = [`${stop.stopId || stop.id};${stop.lat},${stop.lng}`];
    if (includeTimeWindows) {
      const wsMin = parseTimeToMinutes2(stop.windowStart);
      const windowAlreadyOpen = Number.isFinite(wsMin) && wsMin > 0 && wsMin <= currentMinutes;
      const dropFromSide = windowAlreadyOpen || deliveryDate === edmontonTodayStr();
      const acc = buildAccessConstraint(deliveryDate, dropFromSide ? null : stop.windowStart, stop.windowEnd);
      if (acc) segments.push(acc);
    }
    segments.push(`st:${Math.round((stop.extraTime || (stop.isPickup ? 15 : 5)) * 60)}`);
    params.set(`destination${index + 1}`, segments.join(";"));
  });
  const response = await fetch(`https://wps.hereapi.com/v8/findsequence2?${params.toString()}`);
  if (!response.ok) throw new Error(`HERE findsequence2 failed with ${response.status}`);
  const data = await response.json().catch(() => null);
  const route = data?.results?.[0];
  if (!route?.waypoints?.length) throw new Error("HERE findsequence2 returned no waypoints");
  return route;
}
async function getMultiStopRouteSections(points, apiKey, transportMode = "car") {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return { sections: [], usedFallbackPolyline: false };
  const params = new URLSearchParams();
  params.set("apiKey", apiKey);
  params.set("transportMode", transportMode === "bicycle" ? "bicycle" : "car");
  params.set("origin", `${validPoints[0].lat},${validPoints[0].lon}`);
  params.set("destination", `${validPoints[validPoints.length - 1].lat},${validPoints[validPoints.length - 1].lon}`);
  params.set("return", "polyline,summary");
  validPoints.slice(1, -1).forEach((p) => params.append("via", `${p.lat},${p.lon}`));
  const routeResp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`);
  const routeData = await routeResp.json().catch(() => null);
  const routeSections = Array.isArray(routeData?.routes?.[0]?.sections) ? routeData.routes[0].sections : [];
  let anySegmentFellBack = false;
  const builtSections = validPoints.slice(0, -1).map((fromPoint, index) => {
    const section = routeSections[index] || {};
    let polyline = null;
    if (typeof section?.polyline === "string" && section.polyline) {
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
      estimated_distance_km: summary.length ? Number((Number(summary.length) / 1e3).toFixed(3)) : null,
      estimated_duration_minutes: summary.duration ? Math.ceil(Number(summary.duration) / 60) : null
    };
  });
  return { sections: builtSections, usedFallbackPolyline: anySegmentFellBack };
}
Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      const requesterAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, "-updated_date", 1);
      const requesterAppUser = requesterAppUsers?.[0] || null;
      const roles = Array.isArray(requesterAppUser?.app_roles) ? requesterAppUser.app_roles : [];
      const isOwner = requesterAppUser?.is_app_owner === true || roles.includes("app_owner");
      if (!isOwner && !roles.includes("admin")) {
        return Response.json({ success: true, supported: false, reason: "not_authorized_for_server_optimization" });
      }
    } catch (authErr) {
      return Response.json({ success: true, supported: false, reason: "authorization_check_failed" });
    }
    const payload = await req.json().catch(() => ({}));
    const apiKey = Deno.env.get("HERE_API_KEY") || (typeof payload?.hereApiKey === "string" && payload.hereApiKey.length > 10 ? payload.hereApiKey : "");
    if (!apiKey) {
      return Response.json({ success: true, supported: false, reason: "here_api_key_missing" });
    }
    const {
      driverId,
      driverName = null,
      deliveryDate,
      currentMinutes,
      origin,
      home = null,
      startOrder = 0,
      stops = [],
      options = {}
    } = payload || {};
    if (!driverId || !deliveryDate || !Number.isFinite(Number(currentMinutes))) {
      return Response.json({ success: true, supported: false, reason: "missing_driver_date_or_time" });
    }
    if (!origin || !Number.isFinite(Number(origin.lat)) || !Number.isFinite(Number(origin.lng))) {
      return Response.json({ success: true, supported: false, reason: "missing_origin" });
    }
    const routeStops = (Array.isArray(stops) ? stops : []).filter((s) => s && s.id && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)));
    if (routeStops.length === 0) {
      return Response.json({ success: true, supported: false, reason: "no_mappable_stops" });
    }
    if (routeStops.length > 40) {
      return Response.json({ success: true, supported: false, reason: "too_many_stops" });
    }
    const _cyclingMarkers = routeStops.filter((s) => s.isCyclingMarker);
    const _startMarker = _cyclingMarkers.find((s) => String(s.deliveryNotes || "").toLowerCase().includes("start")) || null;
    const _endMarker = _cyclingMarkers.find((s) => String(s.deliveryNotes || "").toLowerCase().includes("end")) || null;
    const _hasCyclingStops = routeStops.some((s) => !s.isCyclingMarker && String(s.transportMode || "").toLowerCase() === "cycling");
    if ((_cyclingMarkers.length > 0 || _hasCyclingStops) && !_endMarker) {
      return Response.json({ success: true, supported: false, reason: "cycling_route_without_end_marker" });
    }
    const mixedMode = !!_endMarker;
    const { preserveExistingOrder = false, explicitNextDeliveryId = null, clearNextDeliveryLock = false, routeInProgress = false } = options;
    const _edmontonToday = (() => {
      try {
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Edmonton",
          year: "numeric",
          month: "2-digit",
          day: "2-digit"
        }).format(/* @__PURE__ */ new Date());
      } catch (_) {
        return "";
      }
    })();
    const _routeIsToday = deliveryDate === _edmontonToday;
    const _isFutureRoute = _routeIsToday ? currentMinutes < 9 * 60 : String(deliveryDate) > _edmontonToday;
    const _hasCyclingMarkers = routeStops.some((s) => s.isCyclingMarker);
    if (_isFutureRoute && !routeInProgress && !preserveExistingOrder && !_hasCyclingMarkers) {
      console.log(`[rxServerRouteOptimizer] future-route parity: ${deliveryDate} (today=${_routeIsToday}) \u2192 falling back to client future fast-path`);
      return Response.json({ success: true, supported: false, reason: "future_route_client_fastpath" });
    }
    const includeTimeWindows = routeStops.some((s) => s.windowStart && parseTimeToMinutes2(s.windowStart) > 0);
    let orderedStops = routeStops;
    let usedFallbackOrdering = false;
    let hereCalls = 0;
    const resolveSequence = (seqResult, pool) => {
      const seqWaypoints = (seqResult.waypoints || []).filter((w) => w.id !== "driverStart" && w.id !== "driverHome" && w.id !== "routeEnd");
      const byId = new Map(pool.map((s) => [String(s.stopId || s.id), s]));
      const byFallbackId = new Map(pool.map((s) => [String(s.id), s]));
      const resolved = seqWaypoints.map((w) => byId.get(String(w.id)) || byFallbackId.get(String(w.id))).filter(Boolean);
      if (resolved.length !== pool.length) {
        throw new Error(`sequence resolution incomplete (${resolved.length}/${pool.length})`);
      }
      return resolved;
    };
    const nearestNeighborOrder = (pool, from) => {
      const remaining = [...pool];
      const nn = [];
      let cursor = { lat: from.lat, lng: from.lng };
      while (remaining.length > 0) {
        let bestIdx = 0, bestDist = Infinity;
        remaining.forEach((s, i) => {
          const d = crowFliesKm2(cursor.lat, cursor.lng, s.lat, s.lng);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        });
        const [picked] = remaining.splice(bestIdx, 1);
        nn.push(picked);
        cursor = { lat: picked.lat, lng: picked.lng };
      }
      return nn;
    };
    if (mixedMode) {
      const pool = routeStops.filter((s) => !s.isCyclingMarker);
      const drivingPool = pool.filter((s) => String(s.transportMode || "").toLowerCase() !== "cycling");
      const cyclingPool = pool.filter((s) => String(s.transportMode || "").toLowerCase() === "cycling");
      let orderedCycling = cyclingPool;
      let orderedDriving = drivingPool;
      if (cyclingPool.length > 0) {
        try {
          const seqResult = await callHereSequence({
            origin,
            stops: cyclingPool,
            destination: { lat: _endMarker.lat, lng: _endMarker.lng },
            mode: "bicycle",
            apiKey,
            deliveryDate,
            currentMinutes,
            includeTimeWindows
          });
          orderedCycling = resolveSequence(seqResult, cyclingPool);
          hereCalls++;
        } catch (seqErr) {
          usedFallbackOrdering = true;
          console.warn(`[rxServerRouteOptimizer] bicycle findsequence2 failed (${seqErr?.message || seqErr}) \u2014 nearest-neighbor fallback`);
          orderedCycling = nearestNeighborOrder(cyclingPool, origin);
        }
      }
      if (drivingPool.length > 0) {
        try {
          const seqResult = await callHereSequence({
            origin: { lat: _endMarker.lat, lng: _endMarker.lng },
            stops: drivingPool,
            home,
            mode: "car",
            apiKey,
            deliveryDate,
            currentMinutes,
            includeTimeWindows
          });
          orderedDriving = resolveSequence(seqResult, drivingPool);
          hereCalls++;
        } catch (seqErr) {
          usedFallbackOrdering = true;
          console.warn(`[rxServerRouteOptimizer] car findsequence2 failed (${seqErr?.message || seqErr}) \u2014 nearest-neighbor fallback`);
          orderedDriving = nearestNeighborOrder(drivingPool, { lat: _endMarker.lat, lng: _endMarker.lng });
        }
      }
      orderedDriving = enforceIspBeforeIsd(orderedDriving, {});
      orderedStops = [
        ..._startMarker ? [_startMarker] : [],
        ...orderedCycling,
        _endMarker,
        ...orderedDriving
      ];
      console.log(`[rxServerRouteOptimizer] mixed mode: ${cyclingPool.length} cycling + ${drivingPool.length} driving + ${_cyclingMarkers.length} marker(s)`);
    } else {
      try {
        const seqResult = await callHereSequence({
          origin,
          stops: routeStops,
          home,
          apiKey,
          deliveryDate,
          currentMinutes,
          includeTimeWindows
        });
        orderedStops = resolveSequence(seqResult, routeStops);
        hereCalls++;
      } catch (seqErr) {
        usedFallbackOrdering = true;
        console.warn(`[rxServerRouteOptimizer] findsequence2 failed (${seqErr?.message || seqErr}) \u2014 nearest-neighbor fallback`);
        orderedStops = nearestNeighborOrder(routeStops, origin);
      }
      if (hasTimeWindows(routeStops, (st) => st.windowStart) && orderedStops.length > 1) {
        orderedStops = windowBandSort(orderedStops, {
          routeIsToday: _routeIsToday,
          currentMinutes,
          windowOf: (st) => st.windowStart
        });
      }
      orderedStops = enforcePickupBeforePendingDeliveries(orderedStops, {});
      orderedStops = enforceIspBeforeIsd(orderedStops, {});
    }
    inheritPickupWindows(orderedStops, {
      pickupWindowOf: (st) => st.deliveryTimeStart || st.windowStart || null
    });
    const legModeFor = (stop) => stop.isCyclingMarker ? String(stop.deliveryNotes || "").toLowerCase().includes("start") ? "car" : "bicycle" : String(stop.transportMode || "").toLowerCase() === "cycling" ? "bicycle" : "car";
    const isPolylineEligible = (st) => isPolylineEligibleStop(st);
    const eligibleStops = orderedStops.filter(isPolylineEligible);
    const sectionByStopId = /* @__PURE__ */ new Map();
    let usedFallbackPolyline = false;
    {
      let gi = 0;
      while (gi < eligibleStops.length) {
        const mode = legModeFor(eligibleStops[gi]);
        let gj = gi;
        while (gj < eligibleStops.length && legModeFor(eligibleStops[gj]) === mode) gj++;
        const pts = [
          gi === 0 ? { lat: origin.lat, lon: origin.lng } : { lat: eligibleStops[gi - 1].lat, lon: eligibleStops[gi - 1].lng },
          ...eligibleStops.slice(gi, gj).map((st) => ({ lat: st.lat, lon: st.lng }))
        ];
        if (pts.length >= 2) {
          const r = await getMultiStopRouteSections(pts, apiKey, mode);
          usedFallbackPolyline = usedFallbackPolyline || r.usedFallbackPolyline;
          (r.sections || []).forEach((sec, k) => {
            sectionByStopId.set(eligibleStops[gi + k].id, sec);
          });
          hereCalls++;
        }
        gi = gj;
      }
    }
    const SAME_ADDRESS_TRAVEL_MINUTES2 = SAME_ADDRESS_TRAVEL_MINUTES;
    let cumulativeTime = currentMinutes;
    const stageEtaMap = /* @__PURE__ */ new Map();
    for (let i = 0; i < orderedStops.length; i++) {
      const stop = orderedStops[i];
      const seg = sectionByStopId.get(stop.id) || null;
      const prev = i > 0 ? orderedStops[i - 1] : null;
      const nearPreviousStop = prev && isSameAddressAnchor({ lat: prev.lat, lng: prev.lng }, { lat: stop.lat, lng: stop.lng });
      let travelMinutes;
      if (typeof seg?.estimated_duration_minutes === "number" && seg.estimated_duration_minutes > 0) {
        travelMinutes = Math.ceil(seg.estimated_duration_minutes);
      } else if (nearPreviousStop) {
        travelMinutes = SAME_ADDRESS_TRAVEL_MINUTES2;
      } else if (typeof stop.estimatedDurationMinutes === "number" && stop.estimatedDurationMinutes > 0) {
        travelMinutes = Math.ceil(stop.estimatedDurationMinutes);
      } else {
        const d = crowFliesKm2(prev ? prev.lat : origin.lat, prev ? prev.lng : origin.lng, stop.lat, stop.lng);
        travelMinutes = Math.max(2, Math.ceil(d / 35 * 60));
      }
      cumulativeTime += travelMinutes;
      const ws = parseTimeToMinutes2(stop.windowStart || stop.deliveryTimeStart || stop.windowStart);
      if (Number.isFinite(ws) && ws > 0 && cumulativeTime < ws) cumulativeTime = ws;
      stageEtaMap.set(stop.id, formatMinutesToTime2(cumulativeTime));
      cumulativeTime += dwellMinutesForStop({ extraTime: stop.extraTime, isPickup: stop.isPickup });
    }
    const originalOrderIds = routeStops.slice().sort((a, b) => (Number(a.currentStopOrder) || 99999) - (Number(b.currentStopOrder) || 99999)).map((s) => String(s.id));
    const optimizedOrderIds = orderedStops.map((s) => String(s.id));
    const routeOrderChanged = preserveExistingOrder ? false : originalOrderIds.length !== optimizedOrderIds.length || originalOrderIds.some((id, index) => id !== optimizedOrderIds[index]);
    const firstNonInterStoreActive = orderedStops.find((s) => !s.isInterStore) || null;
    const nextStopId = (explicitNextDeliveryId && !clearNextDeliveryLock ? explicitNextDeliveryId : null) || (clearNextDeliveryLock ? firstNonInterStoreActive?.id || orderedStops[0]?.id || null : !routeInProgress ? firstNonInterStoreActive?.id || orderedStops[0]?.id || null : null);
    const sameCoordsAdjacentIds = /* @__PURE__ */ new Set();
    for (let i = 1; i < orderedStops.length; i++) {
      const a = orderedStops[i - 1], b = orderedStops[i];
      if (crowFliesKm2(a.lat, a.lng, b.lat, b.lng) < 0.05) sameCoordsAdjacentIds.add(b.id);
    }
    const writeBatch = [];
    for (let i = 0; i < orderedStops.length; i++) {
      const stop = orderedStops[i];
      const newOrder = preserveExistingOrder ? Number(stop.currentStopOrder) || startOrder + i + 1 : startOrder + i + 1;
      const seg = sectionByStopId.get(stop.id) || null;
      const isNextStop = stop.id === nextStopId;
      const isPending = stop.status === "pending" && !stop.isCyclingMarker;
      const isPickupStop = stop.isPickup && !stop.isInterStore;
      const correctedStatus = isPickupStop && stop.status === "in_transit" ? "en_route" : void 0;
      const statusToWrite = correctedStatus || (stop.status === "in_transit" ? "in_transit" : void 0);
      const logicalDurationMinutes = typeof seg?.estimated_duration_minutes === "number" ? seg.estimated_duration_minutes : null;
      const logicalDistanceKm = typeof seg?.estimated_distance_km === "number" ? seg.estimated_distance_km : null;
      const updateData = {
        stop_order: newOrder,
        delivery_time_eta: stageEtaMap.get(stop.id) || null,
        ...isNextStop ? { isNextDelivery: true } : { isNextDelivery: false },
        transport_mode: legModeFor(stop) === "bicycle" ? "cycling" : "driving",
        ...statusToWrite ? { status: statusToWrite } : {},
        travel_dist: isPending ? null : logicalDistanceKm != null ? logicalDistanceKm : null,
        ...!isPending && logicalDurationMinutes != null ? { estimated_duration_minutes: logicalDurationMinutes } : {},
        ...!isPending && logicalDurationMinutes == null && sameCoordsAdjacentIds.has(stop.id) ? { estimated_duration_minutes: SAME_ADDRESS_TRAVEL_MINUTES2, estimated_distance_km: 0 } : {},
        ...!isPending && logicalDistanceKm != null ? { estimated_distance_km: logicalDistanceKm } : {},
        ...!isPending && seg?.encoded_polyline ? { encoded_polyline: seg.encoded_polyline, polyline_from_order: newOrder } : {},
        ...isPending ? { encoded_polyline: null, polyline_from_order: null, estimated_distance_km: null, estimated_duration_minutes: null } : {}
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
      mixed_mode: mixedMode,
      elapsed_ms: Date.now() - startedAt
    });
  } catch (error) {
    console.error("[rxServerRouteOptimizer] fatal:", error?.message || String(error));
    return Response.json({ success: true, supported: false, reason: `server_error: ${error?.message || "unknown"}` });
  }
});
