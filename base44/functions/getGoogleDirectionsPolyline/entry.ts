// Google Directions API multi-stop polyline generator (server-side).
//
// The Google Directions REST endpoint (maps.googleapis.com/maps/api/directions/json)
// does NOT support CORS, so the browser cannot call it directly. The client route
// engine (clientRouteGoogle.js) invokes this function instead, which calls Google
// server-side and returns the same { sections, usedFallbackPolyline } shape the
// engine expects from getMultiStopRouteHere / getMultiStopRouteGoogle.

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { encodeGooglePolyline, decodeGooglePolyline, calculateCrowFliesDistance } from '../../shared/polylineCodec.ts';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const transportMode = body?.transportMode || 'driving';
    const points = Array.isArray(body?.points) ? body.points : [];
    const validPoints = points.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
    if (validPoints.length < 2) {
      return Response.json({ sections: [], usedFallbackPolyline: false });
    }

    const googleApiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!googleApiKey) {
      return Response.json({ error: 'Google Maps API key not configured' }, { status: 500 });
    }

    const travelMode = transportMode === 'cycling' ? 'bicycling'
      : transportMode === 'pedestrian' ? 'walking' : 'driving';

    // Google Directions allows up to 25 points total (origin + 23 waypoints + destination).
    // Chunk overlapping at the boundary so legs stitch into a continuous polyline.
    const MAX_POINTS = 25;
    const chunks = [];
    if (validPoints.length <= MAX_POINTS) {
      chunks.push(validPoints);
    } else {
      let idx = 0;
      while (idx < validPoints.length - 1) {
        const end = Math.min(idx + MAX_POINTS, validPoints.length);
        chunks.push(validPoints.slice(idx, end));
        if (end >= validPoints.length) break;
        idx = end - 1; // overlap last point as next chunk origin
      }
    }

    const allSections = [];
    let anyFallback = false;

    for (const chunk of chunks) {
      if (chunk.length < 2) continue;
      const params = new URLSearchParams();
      params.set('origin', `${chunk[0].lat},${chunk[0].lon}`);
      params.set('destination', `${chunk[chunk.length - 1].lat},${chunk[chunk.length - 1].lon}`);
      params.set('key', googleApiKey);
      params.set('mode', travelMode);
      const wps = chunk.slice(1, -1).map((p) => `${p.lat},${p.lon}`);
      if (wps.length) params.set('waypoints', wps.join('|'));

      let routeData = null;
      let httpOk = false;
      try {
        const resp = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`, {
          signal: AbortSignal.timeout(20000),
          headers: { accept: 'application/json' },
        });
        httpOk = resp.ok;
        routeData = await resp.json().catch(() => null);
      } catch (err) {
        console.warn('[getGoogleDirectionsPolyline] Google Directions fetch threw', err?.message || err);
      }

      const legs = Array.isArray(routeData?.routes?.[0]?.legs) ? routeData.routes[0].legs : [];

      if (!httpOk || legs.length === 0) {
        // Crow-flies fallback for this chunk
        for (let i = 0; i < chunk.length - 1; i++) {
          const from = chunk[i], to = chunk[i + 1];
          const d = calculateCrowFliesDistance(from.lat, from.lon, to.lat, to.lon);
          allSections.push({
            encoded_polyline: encodeGooglePolyline([[from.lat, from.lon], [to.lat, to.lon]]),
            estimated_distance_km: Number(d.toFixed(3)),
            estimated_duration_minutes: Math.ceil((d / 40) * 60),
            transport_mode: transportMode || 'driving',
          });
          anyFallback = true;
        }
        continue;
      }

      for (const leg of legs) {
        const coords = [];
        for (const step of (leg.steps || [])) {
          const s = decodeGooglePolyline(step?.polyline?.points);
          if (!s.length) continue;
          if (coords.length && coords[coords.length - 1][0] === s[0][0] && coords[coords.length - 1][1] === s[0][1]) {
            coords.push(...s.slice(1));
          } else {
            coords.push(...s);
          }
        }
        allSections.push({
          encoded_polyline: coords.length > 1 ? encodeGooglePolyline(coords) : null,
          estimated_distance_km: Number(leg?.distance?.value) ? Number((Number(leg.distance.value) / 1000).toFixed(3)) : null,
          estimated_duration_minutes: Number(leg?.duration?.value) ? Math.ceil(Number(leg.duration.value) / 60) : null,
          transport_mode: transportMode || 'driving',
        });
      }
    }

    // Best-effort API usage log (matches the HERE client-path logging).
    try {
      await base44.asServiceRole.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Directions',
        purpose: `Polyline generation (Google Directions) — ${validPoints.length} points`,
        function_name: 'getGoogleDirectionsPolyline',
        user_id: user.id || null,
        user_name: user.full_name || user.email || null,
        metadata: { provider: 'google', source: 'backend', call_count: chunks.length },
      });
    } catch { /* non-critical */ }

    return Response.json({ sections: allSections, usedFallbackPolyline: anyFallback });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});