import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// NOTE: This function currently proxies to Google Directions and returns a Google-encoded polyline.
// We log it as GOOGLE so API counters stay accurate.

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

    const googleKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!googleKey) {
      return Response.json({ error: 'GOOGLE_MAPS_API_KEY secret is not set' }, { status: 500 });
    }

    const params = new URLSearchParams({
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
      mode: 'driving',
      key: googleKey,
    });
    const url = `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    try {
      const userAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
      const userAppUser = userAppUsers?.[0];
      await base44.asServiceRole.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Directions',
        purpose: 'Route polyline proxy via getHereDirections',
        function_name: 'getHereDirections',
        user_id: user.id,
        user_name: userAppUser?.user_name || user.full_name,
        metadata: {
          api_provider: 'google',
          call_count: 1,
          requested_provider: 'here',
          origin: `${origin.lat},${origin.lng}`,
          destination: `${destination.lat},${destination.lng}`
        }
      });
    } catch (logError) {
      console.warn('[getHereDirections] Non-fatal log error:', logError?.message || logError);
    }

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[Directions] provider error', { status: resp.status, details: text?.slice(0, 500) });
      return Response.json({ error: 'Directions provider error', status: resp.status }, { status: 502 });
    }

    const data = await resp.json();
    if (data?.status && data.status !== 'OK') {
      console.error('[Directions] provider payload error', { status: data.status, error_message: data.error_message || null });
      return Response.json({ error: data.error_message || data.status || 'Directions provider error' }, { status: 502 });
    }

    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    if (!route) {
      return Response.json({ error: 'No route found' }, { status: 404 });
    }

    const polyline = route?.overview_polyline?.points || null;
    const legs = Array.isArray(route?.legs) ? route.legs : [];
    const totalMeters = legs.reduce((sum, leg) => sum + (leg?.distance?.value || 0), 0);
    const totalSeconds = legs.reduce((sum, leg) => sum + (leg?.duration?.value || 0), 0);
    const estimated_distance_km = Math.round((totalMeters / 1000) * 10) / 10;
    const estimated_duration_minutes = Math.round(totalSeconds / 60);

    if (!polyline) {
      const coordinates = [
        { lat: origin.lat, lng: origin.lng },
        { lat: destination.lat, lng: destination.lng }
      ];
      return Response.json({ coordinates, estimated_distance_km, estimated_duration_minutes });
    }

    return Response.json({ polyline, estimated_distance_km, estimated_duration_minutes });
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    console.error('[getHereDirections] unexpected error', err?.message || err);
    return Response.json({ error: err?.message || 'Server error' }, { status: isAbort ? 504 : 500 });
  }
});