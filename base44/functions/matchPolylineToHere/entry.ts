// HERE Route Matching API proxy (server-side).
//
// Re-snaps Google Directions encoded polylines onto HERE's road network so the
// drawn route aligns with the HERE map tiles the driver sees. Called from
// clientRouteGoogle.js when the polylines slot = Google AND map tiles = HERE
// (inferred client-side — map_tiles is the only tile provider).
//
// Google's Directions REST endpoint does not support CORS, and the HERE Route
// Matching endpoint likewise must be called server-side to protect the HERE key.
// This function mirrors getGoogleDirectionsPolyline's shape and reuse pattern.
//
// CALL-COUNT DESIGN (v2 — combined per-mode-run matching):
// The original implementation issued ONE HERE Route Matching call PER LEG,
// so an N-stop route made N HERE calls just to re-snap geometry that Google's
// Directions call had already computed in a single request — effectively
// doubling+ the HERE API usage for no routing benefit (HERE Route Matching is
// pure geometry snapping, not sequencing).
//
// This version concatenates all legs that share the same transport_mode into
// ONE combined GPS trace and issues a single Route Matching call for that run,
// then re-splits the matched geometry back into per-leg slices using
// nearest-point search against each leg's original boundary coordinates
// (monotonically advancing through the matched trace, mirroring the same
// proximity-matching approach used by consolidateBreadcrumbSegment elsewhere
// in this app). Runs are still separated at transport_mode boundaries so mixed
// cycling+driving routes (see clientRouteEngine's cycling architecture) are
// never matched with the wrong HERE mode.
//
// Result: a typical single-mode N-stop route now makes exactly 1 HERE Route
// Matching call (down from N). A cycling route with one mode switch makes 2.
// Per-leg numeric distance/duration are intentionally left null here — the
// caller (clientRouteGoogle.js) already falls back to Google's own accurate
// per-leg distance/duration when HERE's isn't provided, so there's no need to
// (imprecisely) apportion HERE's aggregate length/travelTime across legs.
//
// Input:  { legs: [{ encoded_polyline, transport_mode }] }
// Output: { sections: [{ encoded_polyline, estimated_distance_km, estimated_duration_minutes, transport_mode }], usedFallbackPolyline }
//
// Fallback granularity: if a run's combined match call fails or returns no
// usable geometry, every leg IN THAT RUN falls back to its original raw
// Google encoded_polyline unchanged (other runs are unaffected).

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { encodeGooglePolyline, decodeGooglePolyline } from '../../shared/polylineCodec.ts';

const MATCH_URL = 'https://routematching.hereapi.com/v8/match/routelinks';
const TOTAL_TRACE_POINT_BUDGET = 300; // combined-run budget, divided across the run's legs
const MIN_POINTS_PER_LEG = 12;
const HERE_MODE_BY_TRANSPORT = {
  driving: 'car',
  cycling: 'bicycle',
  pedestrian: 'pedestrian',
};

// HERE RouteLink shape is a string of space-separated "lat,lng lat,lng ..." pairs.
function parseHereLinkShape(shapeStr) {
  if (!shapeStr || typeof shapeStr !== 'string') return [];
  const coords = [];
  for (const pair of shapeStr.trim().split(/\s+/)) {
    const [latStr, lngStr] = pair.split(',');
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (Number.isFinite(lat) && Number.isFinite(lng)) coords.push([lat, lng]);
  }
  return coords;
}

// Decimate to <= maxPoints keeping the first and last point (match endpoints must
// match the leg's actual origin/destination so legs stitch continuously).
function decimatePoints(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  const last = points[points.length - 1];
  if (out[out.length - 1][0] !== last[0] || out[out.length - 1][1] !== last[1]) out.push(last);
  return out;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Find the nearest point to `target` in `coords` at index >= searchStart, searching
// forward only (monotonic advance) so out-and-back road geometry doesn't cause
// boundaries to be assigned out of order.
function nearestIndexFrom(coords, searchStart, target) {
  let bestIdx = searchStart;
  let bestDist = Infinity;
  for (let i = searchStart; i < coords.length; i++) {
    const d = haversineMeters(coords[i][0], coords[i][1], target[0], target[1]);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

// Split one continuous matched trace back into per-leg slices using each leg's
// original boundary coordinate (start of leg 0, then each leg's end point).
function splitMatchedByBoundaries(matchedCoords, boundaryPoints) {
  const indices = [0];
  let searchStart = 0;
  for (let b = 1; b < boundaryPoints.length; b++) {
    const idx = nearestIndexFrom(matchedCoords, searchStart, boundaryPoints[b]);
    indices.push(idx);
    searchStart = idx;
  }
  const slices = [];
  for (let i = 0; i < indices.length - 1; i++) {
    const start = indices[i];
    const end = Math.max(indices[i + 1], start + 1);
    slices.push(matchedCoords.slice(start, end + 1));
  }
  return slices;
}

// Match one contiguous same-transport-mode run of legs with a SINGLE HERE call.
// Returns { slices: [[ [lat,lng], ... ], ...] } (one slice per leg, in order) or null.
async function matchRunToHere(runLegs, hereApiKey) {
  const legPointSets = runLegs.map((leg) => decodeGooglePolyline(leg?.encoded_polyline));
  if (legPointSets.some((pts) => pts.length < 2)) return null;

  const perLegCap = Math.max(MIN_POINTS_PER_LEG, Math.floor(TOTAL_TRACE_POINT_BUDGET / legPointSets.length));
  const decimatedLegs = legPointSets.map((pts) => decimatePoints(pts, perLegCap));

  // Concatenate, de-duping the shared boundary point between consecutive legs.
  const combinedTrace = [];
  const boundaryPoints = [decimatedLegs[0][0]];
  for (const legPts of decimatedLegs) {
    const start = (combinedTrace.length > 0 &&
      combinedTrace[combinedTrace.length - 1][0] === legPts[0][0] &&
      combinedTrace[combinedTrace.length - 1][1] === legPts[0][1]) ? 1 : 0;
    for (let i = start; i < legPts.length; i++) combinedTrace.push(legPts[i]);
    boundaryPoints.push(legPts[legPts.length - 1]);
  }

  const hereMode = HERE_MODE_BY_TRANSPORT[runLegs[0]?.transport_mode] || 'car';
  const url = new URL(MATCH_URL);
  url.searchParams.set('apiKey', hereApiKey);
  url.searchParams.set('routeMatch', '1');
  url.searchParams.set('mode', `fastest;${hereMode};traffic:disabled`);

  const csvLines = ['LATITUDE,LONGITUDE'];
  for (const [lat, lng] of combinedTrace) csvLines.push(`${lat},${lng}`);

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: csvLines.join('\n'),
    signal: AbortSignal.timeout(20000),
  });
  const data = await resp.json().catch(() => null);

  const route = data?.response?.route?.[0] || data?.Response?.Route?.[0];
  const hereLegs = Array.isArray(route?.leg) ? route.leg : Array.isArray(route?.Leg) ? route.Leg : [];
  const matchedCoords = [];
  for (const lg of hereLegs) {
    const links = Array.isArray(lg?.link) ? lg.link : Array.isArray(lg?.Link) ? lg.Link : [];
    for (const link of links) {
      const shape = link?.['-shape'] || link?.shape || link?.['-Shape'] || link?.Shape;
      const linkCoords = parseHereLinkShape(shape);
      for (const c of linkCoords) {
        if (matchedCoords.length) {
          const prev = matchedCoords[matchedCoords.length - 1];
          if (prev[0] === c[0] && prev[1] === c[1]) continue; // dedup shared boundary between links
        }
        matchedCoords.push(c);
      }
    }
  }

  if (matchedCoords.length < 2) return null;

  const slices = splitMatchedByBoundaries(matchedCoords, boundaryPoints);
  if (slices.length !== runLegs.length) return null; // defensive — keep run-level fallback simple

  return { slices };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const legs = Array.isArray(body?.legs) ? body.legs : [];
    if (legs.length === 0) return Response.json({ sections: [], usedFallbackPolyline: false });

    // Resolve the HERE key: prefer the route_optimization slot, fall back to map_tiles.
    const { resolveFeatureApiKey } = await import('../../shared/apiKeyResolver.ts');
    let hereApiKey = await resolveFeatureApiKey(base44, 'route_optimization').catch(() => null);
    if (!hereApiKey) hereApiKey = await resolveFeatureApiKey(base44, 'map_tiles').catch(() => null);
    if (!hereApiKey) {
      hereApiKey = Deno.env.get('HERE_API_KEY') || Deno.env.get('Here_API_Key_2') || Deno.env.get('Here_API_Key_3') || null;
    }
    if (!hereApiKey) {
      return Response.json({ error: 'HERE API key not available for route matching' }, { status: 500 });
    }

    // ── Group legs into contiguous same-transport_mode runs ──────────────────
    // Never merge across a mode change (e.g. cycling loop -> driving leg) into
    // one HERE call — each run keeps its own single mode for correct snapping.
    const runs = [];
    for (let i = 0; i < legs.length; i++) {
      const mode = String(legs[i]?.transport_mode || 'driving').toLowerCase();
      const current = runs[runs.length - 1];
      if (current && current.mode === mode) {
        current.legIndices.push(i);
      } else {
        runs.push({ mode, legIndices: [i] });
      }
    }

    // ── One HERE call per run, runs matched in parallel ───────────────────────
    const sections = new Array(legs.length).fill(null);
    let anyFallback = false;
    let fallbackCount = 0;
    let hereCallCount = 0;

    await Promise.all(runs.map(async (run) => {
      const runLegs = run.legIndices.map((i) => legs[i]);
      hereCallCount++;
      let matched = null;
      try {
        matched = await matchRunToHere(runLegs, hereApiKey);
      } catch (err) {
        console.warn('[matchPolylineToHere] run match failed, using raw Google for run:', err?.message || err);
        matched = null;
      }

      if (matched?.slices) {
        run.legIndices.forEach((legIdx, j) => {
          const slice = matched.slices[j];
          const leg = legs[legIdx];
          sections[legIdx] = {
            encoded_polyline: slice && slice.length > 1 ? encodeGooglePolyline(slice) : (leg?.encoded_polyline || null),
            estimated_distance_km: null,
            estimated_duration_minutes: null,
            transport_mode: leg?.transport_mode || 'driving',
          };
        });
      } else {
        anyFallback = true;
        fallbackCount += runLegs.length;
        run.legIndices.forEach((legIdx) => {
          const leg = legs[legIdx];
          sections[legIdx] = {
            encoded_polyline: leg?.encoded_polyline || null,
            estimated_distance_km: leg?.estimated_distance_km ?? null,
            estimated_duration_minutes: leg?.estimated_duration_minutes ?? null,
            transport_mode: leg?.transport_mode || 'driving',
          };
        });
      }
    }));

    // Best-effort usage log for the admin API-usage badge.
    try {
      await base44.asServiceRole.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Route Matching (HERE)',
        purpose: `HERE map-match of Google polylines — ${legs.length} leg(s) in ${runs.length} run(s)`,
        function_name: 'matchPolylineToHere',
        user_id: user.id || null,
        user_name: user.full_name || user.email || null,
        metadata: { provider: 'here', source: 'backend', call_count: hereCallCount, leg_count: legs.length, run_count: runs.length, fallback_legs: fallbackCount },
      });
    } catch { /* non-critical */ }

    return Response.json({ sections, usedFallbackPolyline: anyFallback });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
