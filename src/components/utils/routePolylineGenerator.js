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
import { getWinterModeSettings } from '@/components/utils/winterModeSettings';

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

// Google 1e5 polyline decode — arithmetic (no bitwise), matching the standard
// decoder in breadcrumbsManager.jsx. Used to merge consecutive legs when a live-GPS
// via point splits the current leg into origin→GPS + GPS→firstStop sections.
// EXPORTED Sep 14 2026 for the route deviation detector (routeDeviationDetector.js).
export function decodeGooglePolyline(encoded) {
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
}

// Merge two CONSECUTIVE legs' polylines into one continuous polyline
// (drops the duplicated junction coordinate). Returns null if both inputs are null.
function mergeGooglePolylines(first, second) {
  if (!first) return second || null;
  if (!second) return first || null;
  const a = decodeGooglePolyline(first);
  const b = decodeGooglePolyline(second);
  if (a.length === 0) return second;
  if (b.length === 0) return first;
  return encodeGooglePolyline([...a, ...b.slice(1)]);
}

// ─── HERE API: multi-stop route ──────────────────────────────────────────────

export async function getMultiStopRouteHere(points, transportMode, hereApiKey, { driverId = null, userName = null, logPurpose = null } = {}) {
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
  logHereApiCall({ apiType: 'Routes (HERE)', purpose: logPurpose || `Polyline generation — ${validPoints.length - 1} leg(s), mode=${hereTransportMode}`, source: 'getMultiStopRouteHere', driverId, userName }).catch(() => {});
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
  viaPointAfterOrigin = null, // { lat, lon } live driver GPS — inserted as a via waypoint
                              // right after the origin (first mode group only). Current-leg
                              // polyline bends through the driver's position; the first
                              // stop's ETA/distance metrics use the GPS→stop leg only.
  logPurpose = null,          // Optional override for the Maps API usage-log purpose
                              // (e.g. 'Route Deviation (Google Directions) — Current Route Leg').
                              // Null → default 'Polyline generation' labels, unchanged.
}) {
  const polylineByDeliveryId = new Map();
  if (!hereApiKey) return polylineByDeliveryId;

  // Winter Mode: pad fresh leg durations by the admin-configured factor.
  // Applied ONLY to freshly-computed durations (HERE/Google/crow-flies) —
  // never to stored values, so repeated regenerations never compound the pad.
  // Cycling-mode legs are untouched (winter mode does not alter cycling logic).
  const winter = await getWinterModeSettings().catch(() => null);
  const _winterPad = (minutes, mode) => {
    if (!winter?.enabled || !minutes || Number(minutes) <= 0) return minutes ? Number(minutes) : null;
    if (mode === 'cycling') return Number(minutes);
    return Math.ceil(Number(minutes) * winter.eta_factor);
  };

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
  const viaValid = !!(viaPointAfterOrigin && hasOrigin
    && Number.isFinite(Number(viaPointAfterOrigin.lat)) && Number.isFinite(Number(viaPointAfterOrigin.lon)));

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

  // ── Deviation waypoints (Sep 17 2026) ──────────────────────────────────────
  // Stops may carry `deviation_waypoints` — GPS points recorded by the
  // current-leg deviation regen when the driver strayed off the planned leg
  // (see currentLegRegenerator.js). They are inserted as via waypoints on that
  // stop's inbound leg so ANY polyline regeneration (manual re-optimization
  // mid-route, admin regenerate on completed routes, coordinator refreshes)
  // keeps the leg snapped to the path actually driven instead of reverting to
  // the theoretical route. Capped at the 3 most recent points per stop.
  const DEVIATION_WAYPOINT_CAP = 3;
  const getDeviationWaypoints = (delivery) => {
    const raw = Array.isArray(delivery?.deviation_waypoints) ? delivery.deviation_waypoints : [];
    return raw
      .filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)))
      .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
      .map((p) => ({ lat: Number(p.lat), lon: Number(p.lng) }))
      .slice(-DEVIATION_WAYPOINT_CAP);
  };

  const groupResults = await Promise.all(modeGroups.map(async (group, groupIdx) => {
    const useVia = groupIdx === 0 && viaValid;
    // Build the group's point list with per-stop deviation via chains:
    //   [fromPoint, (stop0's deviation vias, chronological), (live GPS), stop0,
    //    (stop1's deviation vias), stop1, ...]
    // Deviation points were recorded BEFORE the driver's current position, so
    // they precede the live-GPS via on the current leg — the leg then renders
    // the actual driven path (origin → detour points → GPS) followed by the
    // remaining path to the stop, with no backtracking.
    const points = [{ lat: group.fromPoint.lat, lon: group.fromPoint.lon }];
    let liveViaIdx = -1;
    const stopIdxs = [];       // index of each stop's own coordinate in `points`
    const stopViaCounts = [];  // deviation via count on each stop's inbound chain
    group.stops.forEach((stop) => {
      const vias = getDeviationWaypoints(stop.delivery);
      vias.forEach((v) => points.push(v));
      stopViaCounts.push(vias.length);
      if (useVia && liveViaIdx === -1) {
        liveViaIdx = points.length;
        points.push({ lat: Number(viaPointAfterOrigin.lat), lon: Number(viaPointAfterOrigin.lon) });
      }
      stopIdxs.push(points.length);
      points.push({ lat: stop.lat, lon: stop.lng });
    });
    const viaTotal = stopViaCounts.reduce((s, n) => s + n, 0) + (liveViaIdx !== -1 ? 1 : 0);
    const result = useGooglePoly
      ? await getMultiStopRouteGoogle(points, group.mode, polylineApiKey, { driverId, userName, purpose: logPurpose }).catch((err) => {
          console.error(`[routePolylineGenerator] ${source} — Google Directions THREW (mode=${group.mode}), degrading to crow-flies:`, err?.message || err);
          return { sections: crowFliesSections(points, group.mode), usedFallbackPolyline: true };
        })
      : await getMultiStopRouteHere(points, group.mode, hereApiKey, { driverId, userName, logPurpose }).catch((err) => {
          console.error(`[routePolylineGenerator] ${source} — HERE Router v8 THREW (mode=${group.mode}), degrading to crow-flies:`, err?.message || err);
          return { sections: crowFliesSections(points, group.mode), usedFallbackPolyline: true };
        });
    console.log(`[routePolylineGenerator] ${source} — ${useGooglePoly ? 'Google' : 'HERE'} ${group.mode} returned ${result.sections.length} sections for ${points.length} points${useVia ? ' (incl. live-GPS via)' : ''}${viaTotal ? ` (incl. ${viaTotal} via point(s))` : ''}`);
    return { group, sections: result.sections || [], useVia, liveViaIdx, stopIdxs, stopViaCounts };
  }));

  for (const { group, sections, useVia, liveViaIdx, stopIdxs, stopViaCounts } of groupResults) {
    group.stops.forEach((stop, groupLocalIndex) => {
      const stopIdx = stopIdxs[groupLocalIndex];
      const viaCount = stopViaCounts[groupLocalIndex] || 0;
      // The live-GPS via sits on the current leg only (group 0, first stop).
      const liveViaOnThisLeg = useVia && liveViaIdx !== -1 && groupLocalIndex === 0;

      // Section range for this stop's inbound chain (chain of origin/vias → stop):
      //   renderStart — 0 on the live-GPS current leg (include the driven
      //     origin→GPS pre-leg, per the Sep 11 spec), else the first
      //     deviation-via section of the chain.
      //   metricsStart — when the live-GPS via is on this leg, ONLY the final
      //     GPS→stop section counts (ETA/distance = what's still ahead of the
      //     driver). Otherwise the whole inbound chain (including deviation
      //     vias) sums into the leg's travel time/distance.
      const renderStart = liveViaOnThisLeg ? 0 : Math.max(0, stopIdx - 1 - viaCount);
      const metricsStart = liveViaOnThisLeg ? Math.max(1, stopIdx - 1) : Math.max(0, stopIdx - 1 - viaCount);

      const chainSections = sections.slice(renderStart, stopIdx).filter(Boolean);
      let encoded = null;
      if (chainSections.length === 1) {
        encoded = chainSections[0].encoded_polyline || null;
      } else if (chainSections.length > 1) {
        encoded = chainSections.reduce((acc, sec) => mergeGooglePolylines(acc, sec?.encoded_polyline || null), null);
      }

      const metricSections = sections.slice(metricsStart, stopIdx).filter(Boolean);
      let metricDuration = null;
      let metricDistance = null;
      if (metricSections.length === 1) {
        // No vias on the inbound chain — the single section IS the leg
        // (identical to the pre-deviation-waypoint behavior).
        metricDuration = metricSections[0].estimated_duration_minutes ?? null;
        metricDistance = metricSections[0].estimated_distance_km ?? null;
      } else if (metricSections.length > 1) {
        // Multi-section chain (deviation vias and/or pre-leg): sum the chain
        // so the leg's ETA/distance reflect the true path through the vias.
        metricDuration = metricSections.reduce((s, sec) => s + (Number(sec?.estimated_duration_minutes) || 0), 0);
        metricDistance = Number(metricSections.reduce((s, sec) => s + (Number(sec?.estimated_distance_km) || 0), 0).toFixed(3));
      }

      const _winterDurationMinutes = _winterPad(metricDuration, group.mode);
      polylineByDeliveryId.set(stop.delivery.id, {
        encodedPolyline: encoded,
        estimatedDistanceKm: metricDistance,
        estimatedDurationMinutes: _winterDurationMinutes,
        transportMode: group.mode,
      });
      // Sync directionsLegs (main path only) using the stop's index in routeStops.
      if (directionsLegs && routeStops && _winterDurationMinutes && Number(_winterDurationMinutes) > 0) {
        const routeStopIdx = routeStops.findIndex(s => s.delivery.id === stop.delivery.id);
        if (routeStopIdx !== -1) {
          directionsLegs[routeStopIdx] = {
            ...directionsLegs[routeStopIdx],
            duration: Number(_winterDurationMinutes) * 60,
            distance: metricDistance != null
              ? Number(metricDistance) * 1000
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