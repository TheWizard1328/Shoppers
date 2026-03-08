import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// NOTE: We proxy to Google Directions to return a Google-encoded polyline that the client already knows how to decode.
// This avoids extra deps and fixes 404s by guaranteeing this function exists under the expected name.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { origin, destination } = body || {};
    if (!origin || !destination || origin.lat == null || origin.lng == null || destination.lat == null || destination.lng == null) {
      return Response.json({ error: 'Missing origin or destination' }, { status: 400 });
    }

    // Prefer HERE when available in the future. For now, use Google to provide a polyline the frontend already decodes.
    const googleKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!googleKey) {
      return Response.json({ error: 'GOOGLE_MAPS_API_KEY secret is not set' }, { status: 500 });
    }

    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&mode=driving&key=${googleKey}`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort('timeout'), 8000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(to);

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[Directions] provider error', { status: resp.status, details: text?.slice(0, 500) });
      return Response.json({ error: 'Directions provider error', status: resp.status }, { status: 502 });
    }

    const data = await resp.json();
    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    if (!route) {
      return Response.json({ error: 'No route found' }, { status: 404 });
    }

    // overview_polyline is Google-encoded; client handles decoding when `polyline` string is present
    const polyline = route?.overview_polyline?.points || null;

    // Aggregate distance/duration from legs (fallbacks to 0)
    const legs = Array.isArray(route?.legs) ? route.legs : [];
    const totalMeters = legs.reduce((s, l) => s + (l?.distance?.value || 0), 0);
    const totalSeconds = legs.reduce((s, l) => s + (l?.duration?.value || 0), 0);
    const estimated_distance_km = Math.round((totalMeters / 1000) * 10) / 10;
    const estimated_duration_minutes = Math.round(totalSeconds / 60);

    if (!polyline) {
      // As a fallback, return straight segment coordinates if polyline missing (rare)
      const coordinates = [ { lat: origin.lat, lng: origin.lng }, { lat: destination.lat, lng: destination.lng } ];
      return Response.json({ coordinates, estimated_distance_km, estimated_duration_minutes });
    }

    return Response.json({ polyline, estimated_distance_km, estimated_duration_minutes });
  } catch (err) {
    console.error('[getHereDirections] unexpected error', err?.message || err);
    return Response.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
});