/**
 * liveMarkerInterpolator.js
 *
 * PREDICTIVE display positioning for the driver's OWN live blue-dot marker.
 *
 * CONTEXT (Sep 18 2026 battery work): native GPS runs at a 5s fix cadence
 * (minIntervalMs 5000) plus a 10m distance filter. The original v1 animated
 * BETWEEN the last two fixes — which replayed the PAST segment on a one-cycle
 * delay, leaving the dot ~5s behind the car (Sep 21 2026 driver report: "by
 * the time the turn comes up we're already past it"). v2 flips to prediction:
 *
 *   1. LEAD (steady driving): the dot starts AT the latest fix and glides
 *      FORWARD along the current-leg road geometry (path mode) or along the
 *      fix-pair bearing (line mode) at the speed measured from the last two
 *      fixes, for the expected next-fix gap. In steady state the dot sits at
 *      the driver's TRUE current position, and each new fix re-anchors the
 *      glide from wherever the dot is showing — corrections ease in, never
 *      snap or teleport.
 *
 *   2. POLYLINE-FOLLOW: lead rides the route geometry, so the dot rounds
 *      corners WITH the route — the driver sees the upcoming turn arriving
 *      under the dot in real time. If the driver goes off-route (or there is
 *      no leg geometry), lead falls back to straight-line bearing prediction.
 *
 *   3. SETTLE (fix gap runs over — slowing down / stopped at a light, where
 *      the 10m distance filter suppresses fixes): once the lead glide
 *      finishes and no new fix has arrived, the dot eases BACK to the last
 *      real fix over another gap. This bounds any overshoot from the last
 *      pre-stop speed and leaves the dot parked on the driver.
 *
 *   4. STALE fixes: if no fix arrives within STALE_FIX_MS, the caller falls
 *      back to declarative server-synced coordinates (unchanged).
 *
 * Display-only: nothing here feeds geofences, ETAs, breadcrumbs, or the DB —
 * those consume real GPS fixes. This exists solely so a 5s hardware cadence
 * renders as a live, zero-lag dot.
 */

const OFF_ROUTE_THRESHOLD_M = 45;   // >this far from the leg polyline → off-route
const TURN_SNAP_DEG = 60;           // implausible bearing flip at speed → hold, don't lead
const STALE_FIX_MS = 15000;         // caller falls back to declarative mode after this
const MAX_GAP_MS = 6000;            // lead/settle phases each span at most this
const MAX_INTERVAL_MS = 10000;      // clamp fix-pair interval (clock skew guard)
const SPEED_CAP_MPS = 40;           // ~144 km/h — clamp absurd GPS-derived speeds
const LEAD_CAP_M = 180;             // bound worst-case lead distance (highway x gap)
const MIN_LEAD_SPEED_MPS = 1.0;     // below ~3.6 km/h → stationary, dot holds on the fix
const TURN_LEAD_LIMIT_DEG = 25;     // lead stops AT an upcoming corner sharper than this
const RE_ANCHOR_MAX_M = 30;         // dot farther than this from a new fix → snap, don't arc

const toRad = (deg) => (deg * Math.PI) / 180;

function haversineM(a, b) {
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearingRad(a, b) {
  const la1 = toRad(a[0]), la2 = toRad(b[0]);
  const dLng = toRad(b[1] - a[1]);
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return Math.atan2(y, x);
}

function lerpPt(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/** Build path data: { pts, cum, total } — cum[i] = meters from pts[0] to pts[i]. */
function buildPath(coords) {
  const pts = [];
  for (const c of coords) {
    const la = Number(Array.isArray(c) ? c[0] : c?.latitude);
    const ln = Number(Array.isArray(c) ? c[1] : c?.longitude);
    if (Number.isFinite(la) && Number.isFinite(ln)) pts.push([la, ln]);
  }
  if (pts.length < 2) return null;
  // Drop duplicate consecutive vertices (zero-length segments break projection)
  const clean = pts.filter((p, i) => i === 0 || haversineM(p, pts[i - 1]) > 0.25);
  if (clean.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < clean.length; i++) cum.push(cum[i - 1] + haversineM(clean[i - 1], clean[i]));
  const total = cum[cum.length - 1];
  if (!(total > 1)) return null;
  return { pts: clean, cum, total };
}

/** Project a point onto the polyline. Returns { pt, distAlong, offDist }. */
function projectOnPath(path, point) {
  const { pts, cum } = path;
  let best = { pt: pts[0], distAlong: 0, offDist: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 <= 1e-12) continue;
    // Linear projection in degree space — accurate for road-segment lengths
    let t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const proj = [a[0] + dx * t, a[1] + dy * t];
    const off = haversineM(proj, point);
    if (off < best.offDist) {
      best = { pt: proj, distAlong: cum[i] + (cum[i + 1] - cum[i]) * t, offDist: off };
    }
  }
  return best;
}

export function createLiveMarkerInterpolator() {
  let path = null;          // current road geometry (or null)
  let fixes = [];           // [[lat, lng, tsMs], ...] capped at 3, newest last
  let prevProj = null;      // projection of the previous fix (off-route guard)
  let anim = null;          // active lead/settle plan
  let lastFixTs = 0;

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  /** Walk the path geometry between two along-distances → [lat,lng][] waypoints. */
  function pathBetween(fromAlong, toAlong) {
    const wp = [];
    const fromPt = ptAtAlong(fromAlong);
    const toPt = ptAtAlong(toAlong);
    if (!fromPt || !toPt) return null;
    wp.push(fromPt);
    for (let i = 0; i < path.pts.length; i++) {
      const d = path.cum[i];
      if (d > fromAlong && d < toAlong) wp.push(path.pts[i]);
    }
    wp.push(toPt);
    const clean = wp.filter((p, i) => i === 0 || haversineM(p, wp[i - 1]) > 0.5);
    return clean.length > 1 ? clean : null;
  }

  /**
   * Cap the lead at the first significant corner in (fromAlong, toAlong).
   * A turn takes the driver ~2s while the next fix can be 5s out — leading
   * THROUGH an intersection before the driver turns reads as a wide arc.
   * The dot glides to the corner and waits for the next real fix (which lands
   * on the new street) to carry it around. Gentle bends (< limit per vertex)
   * are followed continuously — only sharp corners cap.
   */
  function capLeadAtTurn(fromAlong, toAlong) {
    const { pts, cum } = path;
    for (let i = 1; i < pts.length - 1; i++) {
      if (cum[i] <= fromAlong + 1 || cum[i] >= toAlong) continue;
      const bIn = bearingRad(pts[i - 1], pts[i]);
      const bOut = bearingRad(pts[i], pts[i + 1]);
      let diff = Math.abs(bOut - bIn);
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff > toRad(TURN_LEAD_LIMIT_DEG)) return cum[i];
    }
    return toAlong;
  }

  function ptAtAlong(along) {
    const { pts, cum } = path;
    if (!pts || !cum) return null;
    const a = clamp(along, 0, cum[cum.length - 1]);
    for (let i = 1; i < cum.length; i++) {
      if (a <= cum[i]) {
        const seg = cum[i] - cum[i - 1];
        const t = seg > 0 ? (a - cum[i - 1]) / seg : 0;
        return lerpPt(pts[i - 1], pts[i], t);
      }
    }
    return pts[pts.length - 1];
  }

  return {
    /** Feed the current-leg polyline (decoded [lat,lng][] or null). */
    setPath(coords) {
      path = (Array.isArray(coords) && coords.length > 1) ? buildPath(coords) : null;
      if (!path) prevProj = null;
    },

    /** Feed a raw GPS fix (degrees + epoch ms). */
    onFix(latitude, longitude, timestamp) {
      const la = Number(latitude);
      const ln = Number(longitude);
      if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
      const ts = Number(timestamp) > 0 ? Number(timestamp) : Date.now();
      const fix = [la, ln];
      const prev = fixes[fixes.length - 1] || null;
      fixes.push([la, ln, ts]);
      if (fixes.length > 3) fixes.shift();
      lastFixTs = ts;

      const now = Date.now();

      // First fix — nothing to predict from. Park the dot on it.
      if (!prev) {
        anim = { mode: "hold", endPos: fix, fixPos: fix, start: now, end: now };
        prevProj = null;
        return;
      }

      const rawInterval = clamp(ts - prev[2], 500, MAX_INTERVAL_MS);
      const gapMs = Math.min(rawInterval, MAX_GAP_MS);
      const distM = haversineM([prev[0], prev[1]], fix);
      const speedMps = clamp(distM / (rawInterval / 1000), 0, SPEED_CAP_MPS);

      // Current DISPLAYED point — the new glide re-anchors from it so
      // corrections ease in instead of snapping (no backward teleport).
      const cur = this.getDisplayPosition(now);
      const curPt = cur ? [cur.latitude, cur.longitude] : fix;

      // Implausible bearing flip at speed → GPS artifact or hairpin; don't
      // lead into the unknown — hold on the real fix this cycle.
      if (speedMps > 8 && fixes.length >= 3) {
        const older = fixes[fixes.length - 3];
        const bPrev = bearingRad([older[0], older[1]], [prev[0], prev[1]]);
        const bNew = bearingRad([prev[0], prev[1]], fix);
        let diff = Math.abs(bNew - bPrev);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff > toRad(TURN_SNAP_DEG)) {
          prevProj = path ? projectOnPath(path, fix) : null;
          anim = { mode: "hold", endPos: fix, fixPos: fix, start: now, end: now + gapMs };
          return;
        }
      }

      // Stationary / walking speed → no lead; the dot sits on the fix.
      if (speedMps < MIN_LEAD_SPEED_MPS) {
        prevProj = path ? projectOnPath(path, fix) : null;
        anim = { mode: "hold", endPos: fix, fixPos: fix, start: now, end: now + gapMs };
        return;
      }

      // Lead distance: one expected fix-gap of travel, capped.
      const leadM = Math.min(speedMps * (gapMs / 1000), LEAD_CAP_M);

      let mode = "line";
      let waypoints = null;
      let leadPt = null;
      let fromAlong = 0;
      let rawAlong = 0;
      let toAlong = 0;

      if (path) {
        const projNew = projectOnPath(path, fix);
        const projPrev = prevProj || projectOnPath(path, [prev[0], prev[1]]);
        prevProj = projNew;
        // Path mode only when both fixes are on-route and the driver is
        // moving FORWARD along the route (backwards → don't walk the path).
        if (
          projNew.offDist <= OFF_ROUTE_THRESHOLD_M &&
          projPrev.offDist <= OFF_ROUTE_THRESHOLD_M &&
          projNew.distAlong >= projPrev.distAlong - 2
        ) {
          const curProj = projectOnPath(path, curPt);
          fromAlong = curProj.offDist <= OFF_ROUTE_THRESHOLD_M ? curProj.distAlong : projNew.distAlong;
          rawAlong = Math.min(projNew.distAlong + leadM, path.cum[path.cum.length - 1]);
          // Only SPECULATIVE corners cap the lead: geometry between the last
          // fix and the new fix is road the driver already covered — a corner
          // there is confirmed. Corners ahead of the new fix are unproven
          // until the next fix lands, so the dot stops at them.
          toAlong = capLeadAtTurn(Math.max(fromAlong, projNew.distAlong), rawAlong);
          if (toAlong > fromAlong + 1) {
            waypoints = pathBetween(fromAlong, toAlong);
            if (waypoints) {
              mode = "path";
              leadPt = waypoints[waypoints.length - 1];
            }
          }
        }
      } else {
        prevProj = null;
      }

      if (mode === "line") {
        // Bearing 0 = north: dLat scales with cos(brg), dLng with sin(brg)
        // (adjusted by cos(lat) for longitude convergence).
        const brg = bearingRad([prev[0], prev[1]], fix);
        leadPt = [
          fix[0] + Math.cos(brg) * (leadM / 111111),
          fix[1] + Math.sin(brg) * (leadM / 111111) / Math.max(Math.cos(toRad(fix[0])), 0.01),
        ];
      }

      // Re-anchor from the displayed point ONLY when it's still near reality;
      // after a turn the old lead can be a block off — gliding from there
      // sweeps a wide arc across the corner. Snap to the real fix instead.
      const reAnchorOk = haversineM(curPt, fix) <= Math.max(RE_ANCHOR_MAX_M, leadM * 0.5);

      // Capped at a corner: glide to the corner over the ESTIMATED arrival
      // time, then HOLD there — never settle back (the fix is behind the
      // corner). The next fix (on the new street) re-anchors from the corner.
      const capped = mode === "path" && rawAlong > toAlong + 0.5;
      const spanM = Math.max(0, toAlong - fromAlong);
      const travelMs = speedMps > 0.5 ? (spanM / speedMps) * 1000 : gapMs;

      anim = {
        mode,
        waypoints,
        from: mode === "line" ? (reAnchorOk ? curPt : fix) : null,
        to: mode === "line" ? leadPt : null,
        fixPos: fix,
        endPos: leadPt,
        start: now,
        end: capped ? now + Math.min(Math.max(travelMs, 400), gapMs) : now + gapMs,
        holdEnd: capped,
        settleEnd: capped ? null : now + gapMs * 2,
      };
    },

    /** Predictive display position for the given wall-clock time (ms). */
    getDisplayPosition(nowMs = Date.now()) {
      if (!fixes.length) return null;
      const latest = fixes[fixes.length - 1];
      if (!anim) return { latitude: latest[0], longitude: latest[1] };

      const t = nowMs;

      // LEAD phase — glide fix → predicted position at constant (linear)
      // speed; matches the driver's true velocity instead of pulsing.
      if (t <= anim.end) {
        const span = Math.max(1, anim.end - anim.start);
        const k = clamp((t - anim.start) / span, 0, 1);
        if (anim.mode === "hold") return { latitude: anim.endPos[0], longitude: anim.endPos[1] };
        if (anim.mode === "path") {
          const wp = anim.waypoints;
          if (!anim.wpCum) {
            const cum = [0];
            for (let i = 1; i < wp.length; i++) cum.push(cum[i - 1] + haversineM(wp[i - 1], wp[i]));
            anim.wpCum = cum;
          }
          const total = anim.wpCum[anim.wpCum.length - 1];
          const d = total > 0 ? total * k : total;
          let i = 1;
          while (i < anim.wpCum.length - 1 && anim.wpCum[i] < d) i++;
          const seg = anim.wpCum[i] - anim.wpCum[i - 1];
          const st = seg > 0 ? (d - anim.wpCum[i - 1]) / seg : 0;
          const p = lerpPt(wp[i - 1], wp[i], st);
          return { latitude: p[0], longitude: p[1] };
        }
        const p = lerpPt(anim.from, anim.to, k);
        return { latitude: p[0], longitude: p[1] };
      }

      // SETTLE phase — expected fix never arrived (slowing/stopped): ease the
      // dot back from the predicted lead to the last REAL fix, then park.
      const leadErrM = anim.endPos && anim.fixPos ? haversineM(anim.endPos, anim.fixPos) : 0;
      if (anim.settleEnd && t < anim.settleEnd && leadErrM > 0.25) {
        const span = Math.max(1, anim.settleEnd - anim.end);
        const k = smoothstep(clamp((t - anim.end) / span, 0, 1));
        const p = lerpPt(anim.endPos, anim.fixPos, k);
        return { latitude: p[0], longitude: p[1] };
      }

      // Capped lead waiting at a corner for the next fix: hold the corner.
      if (anim.holdEnd) return { latitude: anim.endPos[0], longitude: anim.endPos[1] };

      return { latitude: anim.fixPos[0], longitude: anim.fixPos[1] };
    },

    /** Epoch ms of the most recent fix (0 if none). */
    getLastFixTime() {
      return lastFixTs;
    },

    hasFixes() {
      return fixes.length > 0;
    },

    /** Test/introspection hook. */
    _state() {
      return { mode: anim?.mode || "idle", pathLen: path ? path.pts.length : 0 };
    },
  };
}
