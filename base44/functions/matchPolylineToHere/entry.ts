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
// Input:  { legs: [{ encoded_polyline, transport_mode }] }
// Output: { sections: [{ encoded_polyline, estimated_distance_km, estimated_duration_minutes, transport_mode }], usedFallbackPolyline }
//
// Per-leg fallback: if HERE matching fails or returns no matched geometry for a
// leg, that leg's original raw Google encoded_polyline is returned unchanged so
// the line still renders (following Google's roads). usedFallbackPolyline is set
// when any leg fell back.

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { encodeGooglePolyline, decodeGooglePolyline } from '../../shared/polylineCodec.ts';

const MATCH_URL = 'https://routematching.hereapi.com/v8/match/routelinks';
const MAX_TRACE_POINTS = 150; // keep requests fast; HERE has no hard waypoint cap but cost scales with km
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

// Match one leg. Returns a section object or null when no matched geometry.
async function matchLegToHere(leg, hereApiKey) {
  const rawPoints = decodeGooglePolyline(leg?.encoded_polyline);
  if (rawPoints.length < 2) return null;
  const points = decimatePoints(rawPoints, MAX_TRACE_POINTS);

  const transportMode = String(leg?.transport_mode || 'driving').toLowerCase();
  const hereMode = HERE_MODE_BY_TRANSPORT[transportMode] || 'car';

  const url = new URL(MATCH_URL);
  url.searchParams.set('apiKey', hereApiKey);
  url.searchParams.set('routeMatch', '1');
  url.searchParams.set('mode', `fastest;${hereMode};traffic:disabled`);

  // CSV body: LATITUDE,LONGITUDE header then one row per point.
  const csvLines = ['LATITUDE,LONGITUDE'];
  for (const [lat, lng] of points) csvLines.push(`${lat},${lng}`);

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: csvLines.join('\n'),
    signal: AbortSignal.timeout(20000),
  });
  const data = await resp.json().catch(() => null);

  // HERE v8 match returns { response: { route: [ { leg: [ { length, travelTime, link: [ { shape } ] } ] } ] } }
  // (some HERE JSON variants prefix XML-derived attributes with '-').
  const route = data?.response?.route?.[0] || data?.Response?.Route?.[0];
  const legs = Array.isArray(route?.leg) ? route.leg : Array.isArray(route?.Leg) ? route.Leg : [];
  const matchedCoords = [];
  let totalLengthM = 0;
  let totalTravelTimeS = 0;
  for (const lg of legs) {
    totalLengthM += Number(lg?.length || 0);
    totalTravelTimeS += Number(lg?.travelTime || 0);
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
  return {
    encoded_polyline: encodeGooglePolyline(matchedCoords),
    estimated_distance_km: totalLengthM ? Number((totalLengthM / 1000).toFixed(3)) : null,
    estimated_duration_minutes: totalTravelTimeS ? Math.ceil(totalTravelTimeS / 60) : null,
    transport_mode: transportMode,
  };
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

    let anyFallback = false;
    let fallbackCount = 0;
    const sections = [];

    for (const leg of legs) {
      try {
        const matched = await matchLegToHere(leg, hereApiKey);
        if (matched) {
          sections.push(matched);
        } else {
          anyFallback = true;
          fallbackCount++;
          sections.push({
            encoded_polyline: leg?.encoded_polyline || null,
            estimated_distance_km: leg?.estimated_distance_km ?? null,
            estimated_duration_minutes: leg?.estimated_duration_minutes ?? null,
            transport_mode: leg?.transport_mode || 'driving',
          });
        }
      } catch (err) {
        console.warn('[matchPolylineToHere] leg match failed, using raw Google:', err?.message || err);
        anyFallback = true;
        fallbackCount++;
        sections.push({
          encoded_polyline: leg?.encoded_polyline || null,
          estimated_distance_km: leg?.estimated_distance_km ?? null,
          estimated_duration_minutes: leg?.estimated_duration_minutes ?? null,
          transport_mode: leg?.transport_mode || 'driving',
        });
      }
    }

    // Best-effort usage log for the admin API-usage badge.
    try {
      await base44.asServiceRole.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Route Matching (HERE)',
        purpose: `HERE map-match of Google polylines — ${legs.length} leg(s)`,
        function_name: 'matchPolylineToHere',
        user_id: user.id || null,
        user_name: user.full_name || user.email || null,
        metadata: { provider: 'here', source: 'backend', call_count: legs.length, fallback_legs: fallbackCount },
      });
    } catch { /* non-critical */ }

    return Response.json({ sections, usedFallbackPolyline: anyFallback });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});