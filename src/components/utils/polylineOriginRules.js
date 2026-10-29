// ── Polyline origin + leg geometry rules (owner report Oct 28 2026) ──────────
// The owner's report: "the route optimizer and/or the polyline generator are
// still neglecting to take into account the most recent completed stop's
// coordinates as the origin point for the polyline path. It is still
// considering the current stop as the origin point to the driver's current
// location including any deviation points for the current stop to the current
// stop a second time and then onward throughout the route."
//
// Live evidence (stop 23, Robert, Oct 28 2026): the stored leg decoded into a
// 7.27 km CLOSED LOOP that starts and ends at the Londonderry store (the
// stop's own location) while his most recent completed stop (Kyle Jennings)
// sat 3.9 km away and appeared nowhere in the path. So two rules are enforced
// here, in one testable place:
//
//   1. resolvePolylineOrigin — the current leg's origin is the most recent
//      finished stop, but NEVER a finished stop that sits at (or effectively
//      at) the FIRST active stop. A finished stop sharing coordinates with the
//      destination (same building, a pickup completed at the store we are
//      returning to, a coordinate-resolution failure that fell back to the
//      store record) collapses origin≈destination, and every via then paints a
//      round trip. Skip it and keep walking back.
//   2. guardLegGeometry — a freshly generated leg must actually TRAVEL from
//      its inbound anchor to its stop. A closed loop (start≈end, length far
//      greater than the direct distance) is never a real leg; it is replaced
//      with a straight anchor→stop line instead of being written, so a loop
//      can never be painted or persisted again.

const KM_PER_DEG_LAT = 111.32;

export const haversineKm = (aLat, aLon, bLat, bLon) => {
  const dLat = (bLat - aLat) * KM_PER_DEG_LAT;
  const dLon = (bLon - aLon) * KM_PER_DEG_LAT * Math.max(Math.cos(((aLat + bLat) / 2) * Math.PI / 180), 0.01);
  return Math.hypot(dLat, dLon);
};

const valid = (lat, lon) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));

/**
 * Pick the polyline origin for the CURRENT leg.
 *
 * @param {object}   p
 * @param {Array}    p.finishedDeliveries  finished stops, ANY order (newest wins)
 * @param {Function} p.resolveCoords       delivery -> {lat,lng}|null
 * @param {object}   p.homePosition        driver home {lat,lng}|null
 * @param {object}   p.firstTargetCoords   first active stop (the leg's destination)
 * @param {object}   p.gpsPosition         live GPS {lat,lng}|null
 * @param {Array}    [p.finishedStatuses]  statuses that count as FINISHED
 *                                         (default completed/failed/cancelled)
 * @param {number}   [p.minSeparationKm]   origin must be at least this far from
 *                                         the destination (default 0.15 = 150m)
 * @param {Function} [p.log]
 * @returns {{ origin:{lat:number,lon:number}|null, source:string }}
 */
export const resolvePolylineOrigin = ({
  finishedDeliveries = [],
  resolveCoords,
  homePosition = null,
  firstTargetCoords = null,
  gpsPosition = null,
  finishedStatuses = ['completed', 'failed', 'cancelled'],
  minSeparationKm = 0.15,
  log = () => {},
} = {}) => {
  const dest = valid(firstTargetCoords?.lat, firstTargetCoords?.lon) ? firstTargetCoords : null;

  // OWNER REPORT (Oct 29 2026): "my current leg polyline originates from the
  // last stop which is still PENDING". Callers were handing over the day's raw
  // delivery list, and a pending stop that had been edited (fresh updated_date)
  // sorted as the newest "finished" stop, becoming the leg's origin — so the
  // blue line ran from an undelivered stop through home to the first active
  // stop. PENDING STOPS ARE NEVER POLYLINE ANCHORS: filter to terminal statuses
  // first, here, so no caller can reintroduce this.
  const onlyFinished = (finishedDeliveries || []).filter(
    (d) => d && finishedStatuses.includes(String(d?.status || ''))
  );
  const ignored = (finishedDeliveries || []).length - onlyFinished.length;

  // Newest finished stop first (actual_delivery_time → updated_date → created_date).
  const sorted = [...onlyFinished].sort((a, b) => {
    const at = new Date(a?.actual_delivery_time || a?.updated_date || a?.created_date || 0).getTime();
    const bt = new Date(b?.actual_delivery_time || b?.updated_date || b?.created_date || 0).getTime();
    return bt - at;
  });

  if (ignored > 0) {
    log(`ignored ${ignored} non-finished delivery record(s) when picking the origin — pending stops never anchor a leg`);
  }

  const collapsed = [];
  for (const d of sorted) {
    const c = resolveCoords ? resolveCoords(d) : null;
    if (!valid(c?.lat, c?.lng)) continue;
    const origin = { lat: Number(c.lat), lon: Number(c.lng) };
    if (dest && haversineKm(origin.lat, origin.lon, dest.lat, dest.lon) < minSeparationKm) {
      // Same place as the destination → using it as the origin paints
      // destination → vias → destination. Never do that.
      collapsed.push(`${d?.id || d?.delivery_id || 'stop'}@${origin.lat.toFixed(4)},${origin.lon.toFixed(4)}`);
      continue;
    }
    if (collapsed.length) {
      log(`skipped ${collapsed.length} finished stop(s) sitting at the destination (${collapsed.join(', ')}) — origin is the most recent finished stop that is NOT the current stop's location`);
    }
    return { origin, source: 'last_finished_stop' };
  }
  if (collapsed.length) {
    log(`ALL ${collapsed.length} finished stop(s) sit at the destination — cannot use a finished stop as the current-leg origin`);
  }

  if (valid(homePosition?.lat, homePosition?.lon)) {
    const home = { lat: Number(homePosition.lat), lon: Number(homePosition.lon) };
    if (!dest || haversineKm(home.lat, home.lon, dest.lat, dest.lon) >= minSeparationKm) {
      return { origin: home, source: 'home' };
    }
    log('home also sits at the destination — origin falls through to live GPS');
  }

  if (valid(gpsPosition?.lat, gpsPosition?.lon)) {
    const gps = { lat: Number(gpsPosition.lat), lon: Number(gpsPosition.lon) };
    // OWNER REPORT (Oct 29 2026, stop 13): pressing Start happens ON ARRIVAL, so
    // the live GPS sits at the stop itself. Falling back to it produced a
    // zero-length two-point leg that overwrote the stop's real inbound leg — the
    // newly started (now next) stop appeared to have no polyline at all. A GPS
    // that close to the destination is not a usable anchor; return none so the
    // generator keeps the stored leg instead of writing a dot.
    if (dest && haversineKm(gps.lat, gps.lon, dest.lat, dest.lon) < minSeparationKm) {
      log(`live GPS sits at the destination (${haversineKm(gps.lat, gps.lon, dest.lat, dest.lon).toFixed(3)}km) — no usable origin, keeping the stored leg`);
      return { origin: null, source: 'gps_at_destination' };
    }
    return { origin: gps, source: 'live_gps' };
  }

  return { origin: null, source: 'none' };
};

/**
 * Total length of a decoded polyline in km.
 */
export const polylineLengthKm = (points) => {
  let total = 0;
  for (let i = 1; i < (points || []).length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!valid(a?.[0], a?.[1]) || !valid(b?.[0], b?.[1])) continue;
    total += haversineKm(Number(a[0]), Number(a[1]), Number(b[0]), Number(b[1]));
  }
  return total;
};

/**
 * Is this generated leg a closed loop instead of a path from anchor → stop?
 *
 * A real leg starts at its anchor and ends at its stop. A loop starts and ends
 * at the same place while its length dwarfs the anchor→stop distance — the
 * exact shape the owner reported (destination → driver vias → destination).
 *
 * @returns {{ loop:boolean, closedKm:number, directKm:number, lengthKm:number, reason:string }}
 */
export const detectClosedLoopLeg = (points, { anchor = null, stop = null, closeKm = 0.06, factor = 2.5, minLoopKm = 0.5 } = {}) => {
  const pts = (points || []).filter((p) => valid(p?.[0], p?.[1]));
  if (pts.length < 3) return { loop: false, closedKm: 0, directKm: 0, lengthKm: 0, reason: 'too_short' };
  const first = pts[0];
  const last = pts[pts.length - 1];
  const closedKm = haversineKm(Number(first[0]), Number(first[1]), Number(last[0]), Number(last[1]));
  const lengthKm = polylineLengthKm(pts);
  const directKm = valid(anchor?.lat, anchor?.lon) && valid(stop?.lat, stop?.lon)
    ? haversineKm(Number(anchor.lat), Number(anchor.lon), Number(stop.lat), Number(stop.lon))
    : 0;
  if (closedKm > closeKm) return { loop: false, closedKm, directKm, lengthKm, reason: 'open_path' };
  if (lengthKm < minLoopKm) return { loop: false, closedKm, directKm, lengthKm, reason: 'short_stub' };

  // THE decisive signal: a leg that starts where it ENDS but does not start at
  // its inbound anchor. That is "destination -> vias -> destination" while the
  // real origin (last finished stop) sits elsewhere on the map. Length ratios
  // alone are useless here - the reported loop was 7.27km drawn for a 3.9km
  // leg (1.86x), well inside any sane detour.
  if (valid(anchor?.lat, anchor?.lon)) {
    const startToAnchorKm = haversineKm(Number(first[0]), Number(first[1]), Number(anchor.lat), Number(anchor.lon));
    if (startToAnchorKm > 0.25) {
      return { loop: true, closedKm, directKm, lengthKm, startToAnchorKm, reason: 'closed_away_from_anchor' };
    }
  }
  if (directKm > 0.15 && lengthKm > directKm * factor) {
    return { loop: true, closedKm, directKm, lengthKm, reason: 'closed_loop' };
  }
  return { loop: false, closedKm, directKm, lengthKm, reason: 'closed_at_anchor' };
};

/**
 * Final gate applied to every freshly generated leg before it is written.
 * Returns { encodedPolyline, replaced } — `replaced` true when the provider
 * shape was rejected as a loop and a straight anchor→stop line substituted.
 *
 * @param {object} p
 * @param {string} p.encoded        provider's encoded leg
 * @param {Function} p.decode       encoder-specific decoder
 * @param {Function} p.encode       encoder-specific encoder
 * @param {object} p.anchor         inbound anchor {lat,lon}
 * @param {object} p.stop           stop {lat,lng}
 */
export const guardLegGeometry = ({ encoded, decode, encode, anchor, stop, log = () => {} }) => {
  if (!encoded) return { encodedPolyline: encoded, replaced: false };
  let pts = [];
  try { pts = decode(encoded) || []; } catch (_) { return { encodedPolyline: encoded, replaced: false }; }
  const res = detectClosedLoopLeg(pts, { anchor, stop });
  if (!res.loop) return { encodedPolyline: encoded, replaced: false };
  const aLat = Number(anchor?.lat);
  const aLon = Number(anchor?.lon);
  const sLat = Number(stop?.lat);
  const sLon = Number(stop?.lng ?? stop?.lon);
  if (![aLat, aLon, sLat, sLon].every(Number.isFinite)) {
    log(`rejected closed-loop leg (${res.lengthKm.toFixed(2)}km loop, anchor→stop ${res.directKm.toFixed(2)}km) with no usable anchor — leg omitted`);
    return { encodedPolyline: null, replaced: true };
  }
  log(`rejected closed-loop leg: ${res.lengthKm.toFixed(2)}km drawn for a ${res.directKm.toFixed(2)}km anchor→stop leg (start≈end) — substituted straight leg. This is the "routes back to the current stop" shape.`);
  return { encodedPolyline: encode([[aLat, aLon], [sLat, sLon]]), replaced: true };
};
