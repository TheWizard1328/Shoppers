/**
 * routeDeepLinker.js
 *
 * Build a Google Maps deep-link URL that follows the app's optimized route path
 * by decoding each leg's `encoded_polyline` and sampling intermediate waypoints.
 *
 * Dynamic waypoint sampling:
 *   - Each leg gets a number of sampled intermediate points between MIN_PER_LEG
 *     and MAX_PER_LEG.
 *   - Sample count per leg is proportional to leg length (longer leg → more
 *     samples) AND scaled down as the total number of stops grows (more stops →
 *     less sampling budget per leg).
 *   - Final waypoint total respects Google Maps' 9-intermediate-waypoint cap.
 *
 * URL format (universal — works on Android, iOS, desktop):
 *   https://www.google.com/maps/dir/?api=1
 *     &origin=lat,lng
 *     &destination=lat,lng
 *     &waypoints=lat,lng|lat,lng|...
 *     &travelmode=driving|bicycling|walking|transit
 */

import { decodePolyline } from '@/components/utils/polylineUtils';
import { haversine } from '@/components/utils/geoUtils';
import { getDeliveryTypeFlags } from '@/components/utils/deliveryTypeUtils';
import { getInterStoreLocationSync } from '@/components/utils/interStoreDisplayName';

// Google Maps `waypoints` URL parameter accepts up to 9 entries (excluding
// origin & destination). We cap our full waypoint list to this number.
const MAX_WAYPOINTS = 9;
const MIN_PER_LEG = 1;
const MAX_PER_LEG = 10;

const TRAVEL_MODE_MAP = {
  driving: 'driving',
  cycling: 'bicycling',
  pedestrian: 'walking',
  walking: 'walking',
  transit: 'transit',
};

/**
 * Resolve the {lat,lng} of a single stop from loaded patients / stores /
 * inter-store cache. Returns null when coordinates are unavailable.
 */
export function resolveStopLatLng(delivery, { patients = [], stores = [] } = {}) {
  if (!delivery) return null;
  if (delivery.is_cycling_marker) {
    if (delivery.cycling_latitude && delivery.cycling_longitude) {
      return { lat: delivery.cycling_latitude, lng: delivery.cycling_longitude };
    }
    return null;
  }

  const { isPatientDelivery, isInterStore, isStorePickup } = getDeliveryTypeFlags(delivery);

  if (isPatientDelivery) {
    const patient = patients.find((p) => p && p.id === delivery.patient_id);
    if (patient?.latitude && patient?.longitude) {
      return { lat: patient.latitude, lng: patient.longitude };
    }
    return null;
  }
  if (isInterStore) {
    const loc = getInterStoreLocationSync(delivery.delivery_id);
    if (loc?.store_latitude && loc?.store_longitude) {
      return { lat: loc.store_latitude, lng: loc.store_longitude };
    }
    return null;
  }
  if (isStorePickup) {
    const store = stores.find((s) => s && s.id === delivery.store_id);
    if (store?.latitude && store?.longitude) {
      return { lat: store.latitude, lng: store.longitude };
    }
  }
  return null;
}

/**
 * Resolve a human-readable address label for a single stop, mirroring
 * resolveStopLatLng. Used as the stop-specific label in the Google Maps URL so
 * clustered units (e.g. multiple suites at the same street address) render as
 * distinct waypoints instead of collapsing into one entry.
 */
export function resolveStopAddress(delivery, { patients = [], stores = [] } = {}) {
  if (!delivery) return '';
  if (delivery.is_cycling_marker) return 'Cycling Marker';

  const { isPatientDelivery, isInterStore, isStorePickup } = getDeliveryTypeFlags(delivery);

  if (isPatientDelivery) {
    const patient = patients.find((p) => p && p.id === delivery.patient_id);
    if (!patient) return '';
    let addr = patient.address || '';
    if (patient.unit_number) addr = addr ? `${addr} #${patient.unit_number}` : `#${patient.unit_number}`;
    return patient.full_name ? (addr ? `${patient.full_name} — ${addr}` : patient.full_name) : addr;
  }
  if (isInterStore) {
    const loc = getInterStoreLocationSync(delivery.delivery_id);
    return loc?.store_address || loc?.store_name || delivery._interstore_dest_name || '';
  }
  if (isStorePickup) {
    const store = stores.find((s) => s && s.id === delivery.store_id);
    return store?.address || store?.name || '';
  }
  return '';
}

function polylineLengthMeters(points) {
  if (!points || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return total;
}

/**
 * Evenly sample `count` intermediate points along the polyline, EXCLUDING
 * the first and last points (those are the stops at each end).
 */
function sampleEvenly(points, count) {
  if (!points || points.length < 2 || count <= 0) return [];
  // Not enough interior points → take all interior points
  if (count >= points.length - 2) {
    const out = [];
    for (let i = 1; i < points.length - 1; i++) {
      out.push({ lat: points[i][0], lng: points[i][1] });
    }
    return out;
  }
  const out = [];
  for (let i = 1; i <= count; i++) {
    const idx = Math.floor((i * (points.length - 1)) / (count + 1));
    out.push({ lat: points[idx][0], lng: points[idx][1] });
  }
  return out;
}

/**
 * Compute per-leg sampling counts that fit inside the global waypoint cap.
 *
 *   1. Reserve 1 waypoint per intermediate stop (between origin and destination).
 *   2. Distribute the remaining sampling budget across legs proportional to
 *      each leg's length.
 *   3. Clamp each leg to [0, MAX_PER_LEG].
 *   4. If empty legs (no polyline) exist, skip them entirely (budget returns to
 *      the pool for other legs to claim more samples).
 *   5. Truncate any excess by progressively removing samples from the longest legs.
 */
function computePerLegSamples(legLengths, samplingBudget) {
  const numLegs = legLengths.length;
  const perLeg = new Array(numLegs).fill(0);
  if (samplingBudget <= 0 || numLegs === 0) return perLeg;

  const totalLength = legLengths.reduce((s, l) => s + l, 0) || 1;

  // First pass: proportional distribution
  for (let i = 0; i < numLegs; i++) {
    if (legLengths[i] <= 0) continue; // no polyline on this leg
    const share = legLengths[i] / totalLength;
    let n = Math.round(share * samplingBudget);
    n = Math.max(MIN_PER_LEG, Math.min(MAX_PER_LEG, n));
    perLeg[i] = n;
  }

  // Second pass: reduce until total fits the budget — take from the largest allocation
  let total = perLeg.reduce((s, n) => s + n, 0);
  while (total > samplingBudget) {
    let maxIdx = -1;
    let maxVal = 0;
    for (let i = 0; i < numLegs; i++) {
      if (perLeg[i] > maxVal) {
        maxVal = perLeg[i];
        maxIdx = i;
      }
    }
    if (maxIdx === -1 || perLeg[maxIdx] === 0) break;
    perLeg[maxIdx]--;
    total--;
  }

  return perLeg;
}

function formatCoord(c, label) {
  const base = `${Number(c.lat).toFixed(5)},${Number(c.lng).toFixed(5)}`;
  if (!label) return base;
  // Google Maps accepts lat,lng(Label); parens/spaces URL-encode via searchParams
  return `${base}(${label})`;
}

function buildGoogleMapsDirUrl(origin, destination, waypoints, travelMode = 'driving', originLabel = '', destLabel = '') {
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', formatCoord(origin, originLabel));
  url.searchParams.set('destination', formatCoord(destination, destLabel));
  if (waypoints.length > 0) {
    url.searchParams.set('waypoints', waypoints.map((w) => formatCoord(w.coord, w.label || '')).join('|'));
  }
  url.searchParams.set('travelmode', TRAVEL_MODE_MAP[travelMode] || 'driving');
  return url.href;
}

function buildSingleDestinationUrl(dest, label) {
  const url = new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  url.searchParams.set('query', formatCoord(dest));
  if (label) url.searchParams.set('query_place_id', label);
  return url.href;
}

/**
 * Build the final Google Maps deep-link URL for a set of selected, ordered stops.
 *
 * @param {Array<object>} orderedStops - selected deliveries, sorted by stop_order
 * @param {{ patients?: Array, stores?: Array }} ctx
 * @returns {string|null} - URL or null if no resolvable coordinates
 */
export function buildRouteDeepLink(orderedStops, ctx = {}) {
  if (!orderedStops || orderedStops.length === 0) return null;

  // Resolve coordinates + address labels for every stop (cycling markers
  // resolve via cycling_latitude/cycling_longitude inside resolveStopLatLng);
  // drop only those with no resolvable coordinates.
  const resolved = orderedStops
    .filter(Boolean)
    .map((s) => ({ stop: s, coord: resolveStopLatLng(s, ctx), label: resolveStopAddress(s, ctx) }))
    .filter((r) => r.coord);

  if (resolved.length === 0) return null;

  // Single stop → simple navigation
  if (resolved.length === 1) {
    return buildSingleDestinationUrl(resolved[0].coord);
  }

  const numStops = resolved.length;
  const numLegs = numStops - 1;
  const intermediateStopCount = numStops - 2;
  const samplingBudget = Math.max(0, MAX_WAYPOINTS - intermediateStopCount);

  // Decode each leg's polyline (delivery[i].encoded_polyline goes from
  // stop[i-1] to stop[i]). Each leg's first point IS the previous stop's
  // precise GPS coord, and its last point IS the destination stop's coord.
  const legs = [];
  for (let i = 1; i < numStops; i++) {
    const destStop = resolved[i].stop;
    const points = destStop?.encoded_polyline ? decodePolyline(destStop.encoded_polyline) : [];
    legs.push({ points, lengthMeters: polylineLengthMeters(points) });
  }

  // Per-leg sampling allocation (1–10 intermediates per leg, length-weighted)
  const perLegSamples = computePerLegSamples(
    legs.map((l) => l.lengthMeters),
    samplingBudget
  );

  // Helpers — prefer the polyline's precise endpoints over the stop's stored
  // coordinates, with a fallback to the stop's stored coord when no polyline
  // exists for that leg.
  const legStartCoord = (i) => {
    if (legs[i].points.length > 0) {
      return { lat: legs[i].points[0][0], lng: legs[i].points[0][1] };
    }
    return resolved[i].coord;
  };
  const legEndCoord = (i) => {
    if (legs[i].points.length > 0) {
      const last = legs[i].points[legs[i].points.length - 1];
      return { lat: last[0], lng: last[1] };
    }
    return resolved[i + 1].coord;
  };

  // Build the ordered waypoint list. Each leg contributes:
  //   1. 1–10 sampled intermediate points from its decoded polyline
  //      (forces navigation along our breadcrumb path, not Google's own route)
  //   2. The leg's destination stop's coord, labeled with the stop's address.
  //      The leg's START point is implicitly included because it equals the
  //      previous leg's END point (already pushed) OR, for leg 0, it becomes
  //      the URL `origin` param. This guarantees each intermediate stop is
  //      published as a labeled, distinct waypoint so clustered units don't
  //      collapse into a single address entry on the Maps UI.
  const waypoints = [];
  for (let i = 0; i < numLegs; i++) {
    const samples = sampleEvenly(legs[i].points, perLegSamples[i]);
    samples.forEach((c) => waypoints.push({ coord: c }));
    // Push the leg's destination stop as a labeled intermediate waypoint,
    // unless this leg ends at the final destination (which becomes the
    // `destination` URL param separately).
    if (i + 1 < numStops - 1) {
      waypoints.push({ coord: legEndCoord(i), label: resolved[i + 1].label });
    }
  }

  // Enforce Google Maps' 9-intermediate-waypoint hard cap
  while (waypoints.length > MAX_WAYPOINTS) waypoints.pop();

  // Origin = leg 0's start; Destination = last leg's end (precise GPS coords)
  const origin = legStartCoord(0);
  const destination = legEndCoord(numLegs - 1);
  const travelMode = resolved[0].stop?.transport_mode || 'driving';

  return buildGoogleMapsDirUrl(
    origin,
    destination,
    waypoints,
    travelMode,
    resolved[0].label,
    resolved[numStops - 1].label
  );
}

/**
 * Open the deep-link URL — uses window.open so the browser hands off to the
 * native app on mobile and a new tab on desktop.
 *
 * @returns {string|null} - the URL that was opened (or null on failure)
 */
export function openRouteInMaps(orderedStops, ctx) {
  const url = buildRouteDeepLink(orderedStops, ctx);
  if (!url) return null;
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return url;
}