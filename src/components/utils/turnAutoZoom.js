// ── Turn Auto-Zoom for map cycle Phase 2 (owner request Oct 28 2026) ──────────
// While the map cycle FAB sits in PHASE 2 (follow the driver dot), the view is
// intentionally zoomed out enough to see the dot AND the next stop. That wide
// view is useless at the moment the driver actually has to turn: a left/right
// onto a crossing street, or a sharp bend in the road, is only a few pixels.
//
// This module watches the CURRENT LEG's stored polyline (the same
// `encoded_polyline` the map already draws), walks it ahead of the driver's GPS
// position, and finds the next place where the heading changes significantly.
// When that turn gets close AND the map is currently zoomed out past a
// threshold, the caller swaps the Phase 2 fit for a tight driver+turn view so
// the driver sees the maneuver coming. Once the driver is ~30 m past the turn
// the preview releases and the normal Phase 2 pan/zoom resumes on the very next
// GPS tick (ordinary Phase 2 fitting is unaffected — the caller only substitutes
// the bounds while the preview is active).
//
// Everything here is pure math on decoded [lat, lng] points, so it is fully
// unit-testable with synthetic legs (see /tmp/taz tests).

export const TURN_PREVIEW_DEFAULTS = {
  // Only START a preview when the map is zoomed out past this level. At or
  // beyond it the driver already has plenty of detail, so nothing is gained.
  entryZoomBelow: 16,

  // The tight view used while a preview is active (bound via maxZoom).
  previewMaxZoom: 18,

  // Distance ahead of the turn where the zoom-in begins (plus the driver dot is
  // always included, so both stay on screen).
  approachMeters: 150,

  // How far ahead the leg is scanned for the next significant heading change.
  lookAheadMeters: 400,

  // Smallest heading change (degrees) treated as a real turn or bend.
  minTurnDegrees: 35,

  // Ignore a "turn" this close to the driver — it is already being executed.
  minAheadMeters: 20,

  // Keep the view until the driver is this far BEYOND the turn point.
  releasePastMeters: 30,

  // Bearing windows either side of a vertex used to measure the heading change
  // (smooths out HERE polyline noise and gentle lane curvature).
  bearingWindowMeters: 25,

  // A vertex within this distance of the leg's end is arrival, not a turn.
  endBufferMeters: 20,
};

const R_EARTH_M = 6371000;

export const haversineMeters = (aLat, aLon, bLat, bLon) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const bearingDeg = (aLat, aLon, bLat, bLon) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const dLon = toRad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
};

/** Smallest absolute difference between two bearings, 0..180. */
export const bearingDeltaDeg = (b1, b2) => {
  const d = Math.abs(((b1 - b2 + 540) % 360) - 180);
  return d;
};

/**
 * Decoded points -> running distance table.
 * `points` are [lat, lng] pairs (Google 1e5 decode order, as used map-wide).
 */
export const buildLegProfile = (points) => {
  const pts = (points || []).filter(
    (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  const cum = new Array(pts.length);
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      cum[0] = 0;
      continue;
    }
    total += haversineMeters(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    cum[i] = total;
  }
  return { points: pts, cum, total };
};

/** Index of the leg vertex nearest the driver (coarse scan, then refine). */
export const nearestVertexIndex = (profile, lat, lon) => {
  const { points } = profile;
  if (!points.length) return -1;
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = haversineMeters(lat, lon, points[i][0], points[i][1]);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
};

/** First index at/after `index` whose running distance reaches targetM. */
const indexAtDistance = (profile, index, targetM) => {
  const { cum } = profile;
  let i = index;
  while (i < cum.length - 1 && cum[i] < targetM) i++;
  return i;
};

/** Walking backwards, first index at/before `index` at or under targetM. */
const indexBackAtDistance = (profile, index, targetM) => {
  const { cum } = profile;
  let i = index;
  while (i > 0 && cum[i] > targetM) i--;
  return i;
};

/**
 * Heading change (degrees) at vertex `i`, measured with a bearing window on
 * each side so single noisy vertices don't register as turns.
 */
export const turnAngleAt = (profile, i, windowMeters = TURN_PREVIEW_DEFAULTS.bearingWindowMeters) => {
  const { points, cum } = profile;
  if (!points.length || i <= 0 || i >= points.length - 1) return 0;
  const backI = indexBackAtDistance(profile, i, cum[i] - windowMeters);
  const fwdI = indexAtDistance(profile, i, cum[i] + windowMeters);
  if (backI === i || fwdI === i) return 0;
  const inBearing = bearingDeg(points[backI][0], points[backI][1], points[i][0], points[i][1]);
  const outBearing = bearingDeg(points[i][0], points[i][1], points[fwdI][0], points[fwdI][1]);
  return bearingDeltaDeg(inBearing, outBearing);
};

/**
 * Analyse the leg relative to the driver.
 *
 * Returns:
 *   { progressM, totalM, upcoming, passed }
 * where `upcoming` is the next significant turn ahead of the driver (within
 * lookAheadMeters) and `passed` is a significant turn just behind (within
 * releasePastMeters) — the latter lets the preview stay open while the driver
 * is physically making the turn.
 *
 * A turn is { index, cumM, aheadM, lat, lon, angleDeg }.
 */
export const analyzeLegTurns = ({ points, driverLat, driverLng, options } = {}) => {
  const opt = { ...TURN_PREVIEW_DEFAULTS, ...(options || {}) };
  const profile = buildLegProfile(points);
  const empty = { progressM: 0, totalM: profile.total, upcoming: null, passed: null, profile };
  if (profile.points.length < 3 || !Number.isFinite(driverLat) || !Number.isFinite(driverLng)) return empty;

  const nearI = nearestVertexIndex(profile, driverLat, driverLng);
  if (nearI < 0) return { ...empty, profile };
  const progressM = profile.cum[nearI];

  const legTurnLimit = Math.max(0, profile.total - opt.endBufferMeters);

  const scan = (fromIdx, toIdx) => {
    let best = null;
    for (let i = fromIdx; i <= toIdx; i++) {
      if (i <= 0 || i >= profile.points.length - 1) continue;
      if (profile.cum[i] > legTurnLimit) continue; // arrival, not a turn
      const angle = turnAngleAt(profile, i, opt.bearingWindowMeters);
      if (angle < opt.minTurnDegrees) continue;
      if (!best || angle > best.angleDeg) {
        best = {
          index: i,
          cumM: profile.cum[i],
          aheadM: profile.cum[i] - progressM,
          lat: profile.points[i][0],
          lon: profile.points[i][1],
          angleDeg: angle,
        };
      }
    }
    return best;
  };

  // Ahead: from the driver's vertex to lookAheadMeters down the leg.
  //
  // A corner spans several vertices (the vertex just before a 90° turn already
  // measures ~45° because its forward window crosses the corner, and the vertex
  // just after does the same), so vertices are clustered: consecutive candidates
  // within 2 bearing windows belong to the same manoeuvre, and the cluster's
  // HIGHEST-angle vertex is the real corner. That keeps the reported distance
  // accurate and stops a soft pre-corner vertex from masking the true turn.
  const aheadEnd = indexAtDistance(profile, nearI, progressM + opt.lookAheadMeters);
  let upcoming = null;
  const clusterGapM = opt.bearingWindowMeters * 2;
  for (let i = nearI + 1; i <= aheadEnd; i++) {
    if (i <= 0 || i >= profile.points.length - 1) continue;
    if (profile.cum[i] > legTurnLimit) continue;
    const aheadM = profile.cum[i] - progressM;
    if (aheadM < opt.minAheadMeters) continue;
    const angle = turnAngleAt(profile, i, opt.bearingWindowMeters);
    if (angle < opt.minTurnDegrees) continue;
    if (!upcoming) {
      upcoming = { index: i, cumM: profile.cum[i], aheadM, lat: profile.points[i][0], lon: profile.points[i][1], angleDeg: angle };
      continue;
    }
    // Same manoeuvre cluster -> keep the sharpest vertex.
    if (profile.cum[i] - upcoming.cumM <= clusterGapM) {
      if (angle > upcoming.angleDeg) {
        upcoming = { index: i, cumM: profile.cum[i], aheadM, lat: profile.points[i][0], lon: profile.points[i][1], angleDeg: angle };
      }
      continue;
    }
    break; // first cluster is the next manoeuvre — later ones are further turns
  }

  // Behind: only look back releasePastMeters, so a just-completed turn keeps
  // the tight view while the driver is still inside the intersection.
  const backStart = indexBackAtDistance(profile, nearI, progressM - opt.releasePastMeters);
  const passed = scan(backStart, nearI - 1);

  if (upcoming && upcoming.aheadM > opt.lookAheadMeters) upcoming = null;
  return { progressM, totalM: profile.total, upcoming, passed, profile };
};

/**
 * Preview decision for one GPS/fit tick. Pure: give it the current leg points,
 * the driver position and the live map zoom, and it says whether the caller
 * should draw the tight turn view instead of the normal Phase 2 view.
 *
 * The "already zoomed in" gate applies ONLY at entry — once the preview is
 * running the map is deliberately at previewMaxZoom, so re-testing the gate
 * would immediately cancel it (and oscillate every tick).
 */
export const evaluateTurnPreview = ({
  points,
  driverLat,
  driverLng,
  currentZoom,
  activeTurn = null,
  options,
} = {}) => {
  const opt = { ...TURN_PREVIEW_DEFAULTS, ...(options || {}) };
  const zoom = Number(currentZoom);
  const a = analyzeLegTurns({ points, driverLat, driverLng, options: opt });
  // Every active tick re-issues the tight driver+turn view: Phase 2 re-fits on
  // each GPS tick anyway, so the dot keeps tracking while the corner stays big.
  const boundsFor = (t) =>
    t ? [[driverLat, driverLng], [t.lat, t.lon]] : null;

  const turnOk = (t) =>
    !!t && t.aheadM >= opt.minAheadMeters && t.aheadM <= opt.approachMeters;

  // 1. Already previewing this turn? Keep it until the driver is past it.
  //    Matching is by PROGRESS along the leg, not by "is this vertex in the
  //    upcoming/passed list": while the driver sits ON the turn vertex it is
  //    neither ahead (the scan starts one vertex later) nor behind (the
  //    backward scan stops one vertex earlier), and a vertex-index match would
  //    drop the preview exactly at the moment it matters most.
  if (activeTurn && activeTurn.cumM != null) {
    const delta = a.progressM - activeTurn.cumM; // negative = still before the turn
    const insideWindow = delta <= opt.releasePastMeters && delta >= -(opt.approachMeters + 50);
    const heldLat = Number.isFinite(activeTurn.lat) ? activeTurn.lat : (a.upcoming?.lat ?? a.passed?.lat);
    const heldLon = Number.isFinite(activeTurn.lon) ? activeTurn.lon : (a.upcoming?.lon ?? a.passed?.lon);
    if (insideWindow && Number.isFinite(heldLat) && Number.isFinite(heldLon)) {
      const heldTurn = { ...activeTurn, lat: heldLat, lon: heldLon, aheadM: -delta };
      return {
        active: true,
        turn: heldTurn,
        aheadM: -delta,
        progressM: a.progressM,
        bounds: boundsFor(heldTurn),
        reason: 'holding',
      };
    }
    // Fall through with activeTurn cleared below (released).
  }

  // 2. Start a new preview — only from a zoomed-out map.
  if (!Number.isFinite(zoom) || zoom >= opt.entryZoomBelow) {
    return { active: false, turn: null, bounds: null, reason: 'zoom_too_close' };
  }
  if (!turnOk(a.upcoming)) {
    // A turn just passed and no new one is close yet: stay tight for the
    // release window so the exit from the corner is visible too.
    if (a.passed && Math.abs(a.passed.aheadM) <= opt.releasePastMeters) {
      return { active: true, turn: a.passed, aheadM: a.passed.aheadM, progressM: a.progressM, bounds: boundsFor(a.passed), reason: 'holding_past' };
    }
    return { active: false, turn: null, bounds: null, reason: 'no_turn_in_range' };
  }

  const t = a.upcoming;
  return {
    active: true,
    turn: t,
    aheadM: t.aheadM,
    progressM: a.progressM,
    bounds: boundsFor(t),
    reason: 'starting',
  };
};

/**
 * Stateful wrapper used by the dashboard fit path. Remembers the active turn
 * and the decoded polyline (decoding a long leg on every GPS tick would be
 * wasteful), and returns the bounds to draw — or null for normal Phase 2.
 */
export const createTurnPreviewController = (options) => {
  const opt = { ...TURN_PREVIEW_DEFAULTS, ...(options || {}) };
  let cacheKey = null;
  let cachePoints = null;
  let activeTurn = null;

  return {
    get activeTurn() {
      return activeTurn;
    },
    reset() {
      activeTurn = null;
    },
    /**
     * @returns {{ bounds: number[][]|null, reason: string, turn: object|null }}
     */
    evaluate({ legKey, encodedPoints, driverLat, driverLng, currentZoom, phase, userControlling }) {
      if (phase !== 2) {
        activeTurn = null;
        return { bounds: null, reason: 'not_phase_2', turn: null };
      }
      if (!Array.isArray(encodedPoints) || encodedPoints.length < 3) {
        activeTurn = null;
        return { bounds: null, reason: 'no_leg', turn: null };
      }
      if (userControlling) {
        // Never fight the driver's own pan/pinch; drop the preview so the map
        // is not re-zoomed the moment they let go mid-turn.
        activeTurn = null;
        return { bounds: null, reason: 'user_controlling', turn: null };
      }
      if (cacheKey !== legKey) {
        cacheKey = legKey;
        cachePoints = encodedPoints;
        activeTurn = null;
      }

      const res = evaluateTurnPreview({
        points: cachePoints,
        driverLat,
        driverLng,
        currentZoom,
        activeTurn,
        options: opt,
      });

      if (res.active) {
        activeTurn = { cumM: res.turn?.cumM ?? null, lat: res.turn?.lat, lon: res.turn?.lon };
      } else {
        activeTurn = null;
      }

      // Bounds come back on every active tick (entry and hold) so the caller
      // simply substitutes them for the Phase 2 bounds; null means "normal".
      return { bounds: res.bounds, reason: res.reason, turn: res.turn };
    },
  };
};
