import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

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

    const hereApiKey = Deno.env.get('HERE_API_KEY');
    if (!hereApiKey) {
      return Response.json({ error: 'HERE_API_KEY secret is not set' }, { status: 500 });
    }

    const params = new URLSearchParams({
      transportMode: 'car',
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      return: 'polyline,summary',
      apikey: hereApiKey,
    });
    const url = `https://router.hereapi.com/v8/routes?${params.toString()}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[HERE Routing] provider error', { status: resp.status, details: text?.slice(0, 500) });
      return Response.json({ error: 'Directions provider error', status: resp.status, details: text?.slice(0, 500) }, { status: 502 });
    }

    const data = await resp.json();
    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    if (!route) {
      console.error('[HERE Routing] no route in payload', { payload: data });
      return Response.json({ error: 'No route found' }, { status: 404 });
    }

    const sections = Array.isArray(route?.sections) ? route.sections : [];
    const polylines = sections.map((section) => section?.polyline).filter(Boolean);
    const totalMeters = sections.reduce((sum, section) => sum + (section?.summary?.length || 0), 0);
    const totalSeconds = sections.reduce((sum, section) => sum + (section?.summary?.duration || 0), 0);
    const estimated_distance_km = Math.round((totalMeters / 1000) * 10) / 10;
    const estimated_duration_minutes = Math.round(totalSeconds / 60);

    if (!polylines.length) {
      const coordinates = [
        { lat: origin.lat, lng: origin.lng },
        { lat: destination.lat, lng: destination.lng }
      ];
      return Response.json({ coordinates, estimated_distance_km, estimated_duration_minutes, polyline_format: 'flexible' });
    }

    return Response.json({
      polyline_format: 'flexible',
      polyline: polylines[0],
      polylines,
      estimated_distance_km,
      estimated_duration_minutes
    });
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    console.error('[getHereDirections] unexpected error', err?.message || err);
    return Response.json({ error: err?.message || 'Server error' }, { status: isAbort ? 504 : 500 });
  }
});