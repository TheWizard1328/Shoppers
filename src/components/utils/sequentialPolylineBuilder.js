/**
 * SEQUENTIAL POLYLINE BUILDER (owner instruction, Nov 27 2026)
 *
 * "The polyline generator has to do is receive the stop order and generate all
 * polylines in one swoop. None of this if-this-do-this-else-do-this. Just build
 * the polylines from the origin to the destination with all the waypoints in
 * between. Don't look at other variables and say oh should I generate this or
 * should this start from this. There is only one order the polylines should be
 * generated in and that is the stop order number for each stop."
 *
 * So this module makes NO decisions about anchors:
 *   - sort the stops by stop_order (that IS the route)
 *   - chain origin -> stop1 -> stop2 -> ... -> stopN as one ordered point list
 *   - one provider call per run of identical transport mode (HERE allows a
 *     single mode per request, which is an API rule, not a routing choice)
 *   - hand section k back to the stop at position k, by position only
 *
 * No co-located skips, no pending-stop rules, no anchor scanning, no staleness
 * checks, no reuse. Position in, position out.
 */

import { getMultiStopRouteHere } from './routePolylineGenerator';

/**
 * @param {object}   params
 * @param {Array}    params.stops        - [{ id, lat, lng, stopOrder, transportMode }]
 * @param {object}   [params.origin]     - { lat, lon } the driver's real position, else null
 * @param {string}   params.hereApiKey
 * @returns {Promise<{ legs: Map<string, object> }>} legs keyed by stop id, in stop order
 */
export async function buildSequentialLegs({
  stops = [],
  origin = null,
  hereApiKey = null,
  driverId = null,
  userName = null,
  source = 'optimizer',
} = {}) {
  const legs = new Map();
  if (!hereApiKey) return { legs };

  const ordered = (stops || [])
    .filter((s) => s && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)))
    .sort((a, b) => (Number(a.stopOrder) || 0) - (Number(b.stopOrder) || 0));
  if (ordered.length === 0) return { legs };

  // The one and only chain: origin, then every stop in stop_order.
  const chain = [];
  const oLat = Number(origin?.lat);
  const oLon = Number(origin?.lon ?? origin?.lng);
  if (Number.isFinite(oLat) && Number.isFinite(oLon)) {
    chain.push({ lat: oLat, lon: oLon, stop: null });
  }
  ordered.forEach((s) => chain.push({ lat: Number(s.lat), lon: Number(s.lng), stop: s }));

  const modeOf = (p) => String(p?.stop?.transportMode || 'driving');

  let i = chain[0].stop ? 0 : 1; // a stop with no origin before it gets no inbound leg
  while (i < chain.length) {
    const mode = modeOf(chain[i]);
    let end = i;
    while (end + 1 < chain.length && modeOf(chain[end + 1]) === mode) end += 1;

    // The group is anchored on the point immediately before its first stop.
    const groupPoints = chain.slice(Math.max(0, i - 1), end + 1)
      .map((p) => ({ lat: p.lat, lon: p.lon }));

    let sections = [];
    try {
      const res = await getMultiStopRouteHere(groupPoints, mode, hereApiKey, {
        driverId,
        userName,
        logPurpose: `Sequential legs ${i}-${end} (${source})`,
      });
      sections = Array.isArray(res?.sections) ? res.sections : [];
    } catch (_) {
      sections = [];
    }

    // Section j is the pair groupPoints[j] -> groupPoints[j+1]. When the chain
    // has no origin the first stop has no inbound pair at all.
    const hasAnchor = i > 0;
    for (let k = i; k <= end; k += 1) {
      const stop = chain[k].stop;
      if (!stop) continue;
      const secIdx = hasAnchor ? (k - i) : (k - i - 1);
      const sec = secIdx >= 0 ? (sections[secIdx] || null) : null;
      if (secIdx < 0) continue;
      legs.set(stop.id, {
        encodedPolyline: sec?.encoded_polyline || null,
        estimatedDistanceKm: sec?.estimated_distance_km ?? null,
        estimatedDurationMinutes: sec?.estimated_duration_minutes ?? null,
        transportMode: mode,
      });
    }

    i = end + 1;
  }

  return { legs };
}
