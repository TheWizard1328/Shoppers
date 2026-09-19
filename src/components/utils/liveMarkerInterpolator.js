/**
 * liveMarkerInterpolator.js
 *
 * Polyline-following interpolation for the driver's OWN live blue-dot marker.
 *
 * CONTEXT (Sep 18 2026 battery work): native GPS was reduced from a 1s fix
 * cadence to a 5s cadence (minIntervalMs 5000) plus a 10m distance filter.
 * A raw 5s cadence makes the dot step instead of glide, so between fixes we
 * animate the marker position:
 *
 *   1. POLYLINE-FOLLOW (preferred): when the current-leg road geometry (the
 *      next stop's encoded leg polyline, decoded at 1e5) is available and the
 *      fix is on-route (< OFF_ROUTE_THRESHOLD_M from the path), the dot glides
 *      ALONG THE ROAD GEOMETRY between the previous fix's projection and the
 *      new fix's projection. Corners and curves are traced naturally — the
 *      marker never sails past a turn, which is the classic flaw of straight-
 *      line easing.
 *
 *   2. OFF-ROUTE / NO GEOMETRY fallback: straight eased glide between raw
 *      fixes, with a TURN SNAP — if the fix-to-fix bearing changes by more
 *      than TURN_SNAP_DEG, the marker snaps to the fix instantly instead of
 *      gliding through the intersection.
 *
 *   3. STALE fixes: if no fix arrives within STALE_FIX_MS, the marker holds
 *      the last fix (caller also uses this to fall back to server coords).
 *
 * Display-only: nothing here feeds geofences, ETAs, breadcrumbs, or the DB —
 * those consume real GPS fixes. The interpolated position exists solely so
 * the dot looks like it moves at 1s while the hardware only wakes at 5s.
 */

const OFF_ROUTE_THRESHOLD_M = 45;   // >this far from the leg polyline → off-route
const TURN_SNAP_DEG = 30;           // sharp direction change → snap instead of glide
const STALE_FIX_MS = 15000;         // caller falls back to declarative mode after this
const MIN_ANIM_MS = 700;            // don't teleport on very fast fix pairs
const MAX_ANIM_MS = 4500;           // just under the 5s fix interval
const MAX_INTERVAL_MS = 10000;      // clamp fix-pair interval (clock skew guard)

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
  let prevProj = null;      // projection of the previous fix (path-mode chaining)
  let anim = null;          // active animation plan
  let lastFixTs = 0;

  function planPathWalk(fromProj, toProj) {
    const wp = [fromProj.pt];
    for (let i = 0; i < path.pts.length; i++) {
      const d = path.cum[i];
      if (d > fromProj.distAlong && d < toProj.distAlong) wp.push(path.pts[i]);
    }
    wp.push(toProj.pt);
    const clean = wp.filter((p, i) => i === 0 || haversineM(p, wp[i - 1]) > 0.5);
    return clean.length > 1 ? clean : null;
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

      // First fix — just sit on it, nothing to interpolate from.
      if (!prev) {
        anim = null;
        prevProj = null;
        return;
      }

      const now = Date.now();
      const rawInterval = Math.min(Math.max(ts - prev[2], 500), MAX_INTERVAL_MS);
      const animMs = Math.min(Math.max(rawInterval * 0.9, MIN_ANIM_MS), MAX_ANIM_MS);
      const fromRaw = [prev[0], prev[1]];
      let mode = "line";
      let waypoints = null;

      // ── POLYLINE-FOLLOW: project both fixes onto the road geometry ──
      if (path) {
        const projNew = projectOnPath(path, fix);
        const projPrev = prevProj || projectOnPath(path, fromRaw);
        prevProj = projNew;
        if (
          projNew.offDist <= OFF_ROUTE_THRESHOLD_M &&
          projPrev.offDist <= OFF_ROUTE_THRESHOLD_M &&
          projNew.distAlong >= projPrev.distAlong - 2 // moving backward → don't walk the path backwards
        ) {
          waypoints = planPathWalk(projPrev, projNew);
          if (waypoints) mode = "path";
        }
      } else {
        prevProj = null;
      }

      // ── TURN SNAP (line mode only): sharp direction change → snap, don't glide ──
      if (mode === "line" && fixes.length >= 3) {
        const older = fixes[fixes.length - 3];
        const bPrev = bearingRad([older[0], older[1]], fromRaw);
        const bNew = bearingRad(fromRaw, fix);
        let diff = Math.abs(bNew - bPrev);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff > toRad(TURN_SNAP_DEG)) {
          anim = { mode: "hold", start: now, end: now, endPos: fix };
          return;
        }
      }

      anim = {
        mode,
        waypoints,
        from: mode === "path" ? null : fromRaw,
        to: mode === "path" ? null : fix,
        start: now,
        end: now + animMs,
        endPos: mode === "path" ? waypoints[waypoints.length - 1] : fix,
      };
    },

    /** Interpolated display position for the given wall-clock time (ms). */
    getDisplayPosition(nowMs = Date.now()) {
      if (!fixes.length) return null;
      const latest = fixes[fixes.length - 1];
      if (!anim) return { latitude: latest[0], longitude: latest[1] };
      if (nowMs >= anim.end) return { latitude: anim.endPos[0], longitude: anim.endPos[1] };
      const span = Math.max(1, anim.end - anim.start);
      const t = Math.min(Math.max((nowMs - anim.start) / span, 0), 1);

      if (anim.mode === "hold") return { latitude: anim.endPos[0], longitude: anim.endPos[1] };

      if (anim.mode === "path") {
        const wp = anim.waypoints;
        if (!anim.wpCum) {
          const cum = [0];
          for (let i = 1; i < wp.length; i++) cum.push(cum[i - 1] + haversineM(wp[i - 1], wp[i]));
          anim.wpCum = cum;
        }
        const total = anim.wpCum[anim.wpCum.length - 1];
        const d = total > 0 ? total * smoothstep(t) : total;
        let i = 1;
        while (i < anim.wpCum.length - 1 && anim.wpCum[i] < d) i++;
        const seg = anim.wpCum[i] - anim.wpCum[i - 1];
        const st = seg > 0 ? (d - anim.wpCum[i - 1]) / seg : 0;
        const p = lerpPt(wp[i - 1], wp[i], st);
        return { latitude: p[0], longitude: p[1] };
      }

      // line mode — eased straight glide
      const p = lerpPt(anim.from, anim.to, smoothstep(t));
      return { latitude: p[0], longitude: p[1] };
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
