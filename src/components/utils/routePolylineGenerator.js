/**
 * routePolylineGenerator.js
 *
 * Shared polyline-generation primitives + the single generateRoutePolylines
 * helper used by BOTH the current-route (main) path and the future-route
 * (_handleFutureRoute) path in clientRouteEngine.js.
 *
 * Polyline generation is identical for current and future routes — only the
 * ordering algorithm and the leg origin differ between the two paths. Keeping
 * the HERE Router v8 call, the crow-flies fallback, the mode-grouping, and the
 * section→delivery-id mapping in ONE place means a future route renders planned
 * legs exactly like a current route, and regressions can no longer diverge
 * between the two paths.
 */

import { base44 } from '@/api/base44Client';
import { haversineKm } from './geoUtils';
import { getMultiStopRouteGoogle } from '@/components/utils/clientRouteGoogle';

// ─── HERE API Usage Logger ───────────────────────────────────────────────────
// Best-effort: logs each HERE API hit to GoogleAPILog so the admin badge stays accurate.
// Never throws — logging failure must never block routing.

export async function logHereApiCall({ apiType, purpose, source, driverId, userName, callCount = 1 }) {
  try {
    await base44.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: apiType,
      purpose: purpose || apiType,
      function_name: source || 'clientRouteEngine',
      user_id: driverId || null,
      user_name: userName || null,
      metadata: {
        provider: 'HERE',
        source: source || 'client',
        call_count: callCount,
      },
    });
  } catch { /* best-effort */ }
}

// ─── HERE Flexible Polyline decode ───────────────────────────────────────────

const HERE_POLYLINE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HERE_POLYLINE_DECODER = HERE_POLYLINE_ALPHABET.split('').reduce((acc, char, index) => {
  acc[char] = index;
  return acc;
}, {});

function decodeHereFlexiblePolyline(encoded) {
  if (!encoded || typeof encoded !== 'string') return [];
  const values = [];
  let current = 0;
  let shift = 0;
  for (const char of encoded) {
    const value = HERE_POLYLINE_DECODER[char];
    if (value == null) return [];
    current |= (value & 0x1f) << shift;
    if (value & 0x20) { shift += 5; continue; }
    values.push(current);
    current = 0;
    shift = 0;
  }
  if (shift > 0 || values.length < 2) return [];
  if (values[0] !== 1) return [];
  const header = values[1];
  const precision = header & 15;
  const thirdDimension = (header >> 4) & 7;
  const factor = 10 ** precision;
  const dimension = thirdDimension ? 3 : 2;
  const toSigned = (value) => ((value & 1) ? ~(value >> 1) : (value >> 1));
  let latitude = 0, longitude = 0, third = 0;
  const coordinates = [];
  for (let i = 2; i < values.length; i += dimension) {
    latitude += toSigned(values[i]);
    longitude += toSigned(values[i + 1]);
    if (thirdDimension) third += toSigned(values[i + 2]);
    coordinates.push([latitude / factor, longitude / factor]);
  }
  return coordinates;
}

// ─── Google Polyline encode/decode ───────────────────────────────────────────

function encodeSigned(value) {
  let signed = value << 1;
  if (value < 0) signed = ~signed;
  let encoded = '';
  while (signed >= 0x20) {
    encoded += String.fromCharCode((0x20 | (signed & 0x1f)) + 63);
    signed >>= 5;
  }
  encoded += String.fromCharCode(signed + 63);
  return encoded;
}

function encodeGooglePolyline(points) {
  let lastLat = 0, lastLng = 0, encoded = '';
  for (const [lat, lng] of points) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    encoded += encodeSigned(latE5 - lastLat);
    encoded += encodeSigned(lngE5 - lastLng);
    lastLat = latE5;
    lastLng = lngE5;
  }
  return encoded;
}

// ─── HERE API: multi-stop route ──────────────────────────────────────────────

export async function getMultiStopRouteHere(points, transportMode, hereApiKey, { driverId = null, userName = null } = {}) {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return { sections: [], usedFallbackPolyline: false };

  const hereTransportMode = transportMode === 'cycling' ? 'bicycle' : transportMode === 'pedestrian' ? 'pedestrian' : 'car';

  const params = new URLSearchParams();
  params.set('apiKey', hereApiKey);
  params.set('transportMode', hereTransportMode);
  params.set('origin', `${validPoints[0].lat},${validPoints[0].lon}`);
  params.set('destination', `${validPoints[validPoints.length - 1].lat},${validPoints[validPoints.length - 1].lon}`);
  params.set('return', 'polyline,summary');

  const viaPoints = validPoints.slice(1, -1);
  viaPoints.forEach((p) => params.append('via', `${p.lat},${p.lon}`));

  const routeResp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
    signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' }
  });
  logHereApiCall({ apiType: 'Routes (HERE)', purpose: `Polyline generation — ${validPoints.length - 1} leg(s), mode=${hereTransportMode}`, source: 'getMultiStopRouteHere', driverId, userName }).catch(() => {});
  const routeData = await routeResp.json().catch(() => null);
  const routeSections = Array.isArray(routeData?.routes?.[0]?.sections) ? routeData.routes[0].sections : [];

  if (!routeResp.ok || routeSections.length === 0) {
    console.warn('[routePolylineGenerator] HERE Router returned no sections', {
      httpStatus: routeResp.status, sectionsCount: routeSections.length,
      notice: routeData?.notices ?? routeData?.title ?? null
    });
  }

  let anySegmentFellBack = false;
  const builtSections = validPoints.slice(0, -1).map((fromPoint, index) => {
    const section = routeSections[index] || {};
    let polyline = null;
    if (typeof section?.polyline === 'string' && section.polyline) {
      const coords = decodeHereFlexiblePolyline(section.polyline);
      if (coords.length > 1) polyline = encodeGooglePolyline(coords);
    }
    if (!polyline && typeof section?.encoded_polyline === 'string' && section.encoded_polyline) {
      polyline = section.encoded_polyline;
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
      transport_mode: transportMode || 'driving'
    };
  });

  return { sections: builtSections, usedFallbackPolyline: anySegmentFellBack };
}

// Crow-flies straight-line sections — used when the HERE Router v8 fetch THROWS
// (AbortSignal timeout, network/DNS error). getMultiStopRouteHere already builds
// these for the "responded but empty sections" case; this mirrors that behavior
// for the throw case so a degraded/unreachable HERE endpoint degrades to straight
// lines instead of producing NO polylines.
// Returns one section per leg (points.length - 1), matching the HERE shape.
export function crowFliesSections(points, transportMode) {
  const validPoints = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (validPoints.length < 2) return [];
  const mode = transportMode || 'driving';
  return validPoints.slice(0, -1).map((from, i) => {
    const to = validPoints[i + 1];
    const km = haversineKm(from.lat, from.lon, to.lat, to.lon);
    return {
      encoded_polyline: encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]),
      estimated_distance_km: Number(km.toFixed(3)),
      estimated_duration_minutes: Math.ceil((km / 40) * 60),
      transport_mode: mode,
    };
  });
}

// ─── Shared polyline-generation helper ───────────────────────────────────────
//
// Called by BOTH the main route path and _handleFutureRoute so current/future
// polyline generation is identical. Differences between the paths:
//   • ORDERING — computed by the caller before this helper (HERE sequencing for
//     current routes; puid-chain sort for future routes).
//   • ORIGIN — passed in as `originPoint` by the caller (last finished stop /
//     GPS for current routes; driver home for future routes). When null, the
//     first eligible stop becomes the origin (no inbound leg into it).
//
// Eligible stops = en_route + in_transit (+ cycling markers + cycling-segment
// cycling stops). Pending stops receive NO polylines on either path — a pending
// stop hasn't been picked up yet, so there's no driving path to render.
//
// @returns Map<deliveryId, { encodedPolyline, estimatedDistanceKm, estimatedDurationMinutes, transportMode }>

export async function generateRoutePolylines({
  stops,                 // [{ delivery, lat, lng }] — ordered stops with coords already resolved
  originPoint,           // { lat, lon } or null (null → first eligible stop is origin, no inbound leg)
  cyclingSegmentOnly = false,
  hereApiKey,
  polylineProvider = 'here',
  polylineApiKey = null,
  driverId = null,
  userName = null,
  source = 'client_engine',
  fallbackTravelMode = 'driving',
  directionsLegs = null, // optional: array to sync durations into (main path only)
  routeStops = null,     // optional: full routeStops for directionsLegs index lookup (main path only)
}) {
  const polylineByDeliveryId = new Map();
  if (!hereApiKey) return polylineByDeliveryId;

  const resolveMode = (delivery) => {
    const raw = String(delivery?.transport_mode || fallbackTravelMode).toLowerCase();
    if (raw === 'cycling') return 'cycling';
    if (raw === 'pedestrian') return 'pedestrian';
    return 'driving';
  };

  // Eligible stops: en_route + in_transit, plus cycling markers (even if pending),
  // plus cycling-segment cycling stops. Pending non-marker stops get NO polylines.
  const eligibleStops = stops.filter(s => {
    const status = String(s.delivery?.status || '');
    const isCyclingMarker = !!s.delivery?.is_cycling_marker;
    const isCyclingSegmentStop = cyclingSegmentOnly && resolveMode(s.delivery) === 'cycling';
    return status === 'en_route' || status === 'in_transit' || isCyclingMarker || isCyclingSegmentStop;
  });

  if (eligibleStops.length === 0) {
    console.log(`[routePolylineGenerator] ${source} — no eligible stops (en_route/in_transit) for polylines`);
    return polylineByDeliveryId;
  }

  // Effective origin. If originPoint is provided, every eligible stop gets an
  // inbound leg from it. If null, the first eligible stop IS the origin (no
  // inbound leg into it) — legacy fallback for routes with no home/anchor.
  const hasOrigin = originPoint && Number.isFinite(originPoint.lat) && Number.isFinite(originPoint.lon);
  const firstEligible = eligibleStops[0];
  const effectiveOrigin = hasOrigin
    ? { lat: originPoint.lat, lon: originPoint.lon }
    : { lat: firstEligible.lat, lon: firstEligible.lng };
  const stopsToPolyline = hasOrigin ? eligibleStops : eligibleStops.slice(1);

  if (stopsToPolyline.length === 0) {
    console.log(`[routePolylineGenerator] ${source} — no coord-resolvable inbound legs, skipping polylines`);
    return polylineByDeliveryId;
  }

  // Build transport-mode groups (consecutive runs of the same mode).
  // Each group's fromPoint = effectiveOrigin for group[0], else the last stop of
  // the previous group. HERE/Google accept one transport mode per call.
  const modeGroups = [];
  for (let i = 0; i < stopsToPolyline.length; i++) {
    const stop = stopsToPolyline[i];
    const mode = resolveMode(stop.delivery);
    const prev = (i === 0)
      ? effectiveOrigin
      : { lat: stopsToPolyline[i - 1].lat, lon: stopsToPolyline[i - 1].lng };
    const last = modeGroups[modeGroups.length - 1];
    if (last && last.mode === mode) {
      last.stops.push(stop);
    } else {
      modeGroups.push({ mode, fromPoint: { lat: prev.lat, lon: prev.lon }, stops: [stop] });
    }
  }

  console.log(`[routePolylineGenerator] ${source} — polyline mode groups: ${modeGroups.map(g => `${g.mode}×${g.stops.length}`).join(', ')}, origin=${hasOrigin ? 'provided' : 'first_stop'}`);

  const useGooglePoly = polylineProvider === 'google' && polylineApiKey;

  const groupResults = await Promise.all(modeGroups.map(async (group) => {
    const points = [group.fromPoint, ...group.stops.map(s => ({ lat: s.lat, lon: s.lng }))];
    const result = useGooglePoly
      ? await getMultiStopRouteGoogle(points, group.mode, polylineApiKey, { driverId, userName }).catch((err) => {
          console.error(`[routePolylineGenerator] ${source} — Google Directions THREW (mode=${group.mode}), degrading to crow-flies:`, err?.message || err);
          return { sections: crowFliesSections(points, group.mode), usedFallbackPolyline: true };
        })
      : await getMultiStopRouteHere(points, group.mode, hereApiKey, { driverId, userName }).catch((err) => {
          console.error(`[routePolylineGenerator] ${source} — HERE Router v8 THREW (mode=${group.mode}), degrading to crow-flies:`, err?.message || err);
          return { sections: crowFliesSections(points, group.mode), usedFallbackPolyline: true };
        });
    console.log(`[routePolylineGenerator] ${source} — ${useGooglePoly ? 'Google' : 'HERE'} ${group.mode} returned ${result.sections.length} sections for ${points.length} points`);
    return { group, sections: result.sections || [] };
  }));

  for (const { group, sections } of groupResults) {
    group.stops.forEach((stop, groupLocalIndex) => {
      const section = sections[groupLocalIndex] || null;
      polylineByDeliveryId.set(stop.delivery.id, {
        encodedPolyline: section?.encoded_polyline || null,
        estimatedDistanceKm: section?.estimated_distance_km ?? null,
        estimatedDurationMinutes: section?.estimated_duration_minutes ?? null,
        transportMode: group.mode,
      });
      // Sync directionsLegs (main path only) using the stop's index in routeStops.
      if (directionsLegs && routeStops && section?.estimated_duration_minutes && Number(section.estimated_duration_minutes) > 0) {
        const routeStopIdx = routeStops.findIndex(s => s.delivery.id === stop.delivery.id);
        if (routeStopIdx !== -1) {
          directionsLegs[routeStopIdx] = {
            ...directionsLegs[routeStopIdx],
            duration: Number(section.estimated_duration_minutes) * 60,
            distance: section.estimated_distance_km
              ? Number(section.estimated_distance_km) * 1000
              : directionsLegs[routeStopIdx]?.distance,
          };
        }
      }
    });
  }

  const _polyCount = [...polylineByDeliveryId.values()].filter(s => s?.encodedPolyline != null).length;
  if (_polyCount === 0) {
    console.warn(`[routePolylineGenerator] ${source} — produced 0 polylines despite ${eligibleStops.length} eligible stop(s) and ${stopsToPolyline.length} leg(s) — investigate origin/coords/HERE response`);
  } else {
    console.log(`[routePolylineGenerator] ${source} — polylines generated: ${_polyCount}/${stopsToPolyline.length} legs`);
  }

  return polylineByDeliveryId;
}