// Redeployed on 2026-04-09
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const buildFallback = (origin, destination, extra = {}) => Response.json({
  coordinates: [
    { lat: Number(origin?.lat), lng: Number(origin?.lng) },
    { lat: Number(destination?.lat), lng: Number(destination?.lng) }
  ].filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)),
  sections: [],
  estimated_distance_km: 0,
  estimated_duration_minutes: 0,
  polyline_format: 'fallback',
  ...extra
});


Deno.serve(async (req) => {
  let origin = null;
  let destination = null;

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    origin = body?.origin || null;
    destination = body?.destination || null;
    const waypoints = Array.isArray(body?.waypoints) ? body.waypoints : [];
    const requestedTransportMode = String(body?.transportMode || body?.transport_mode || 'driving').toLowerCase();
    const hereTransportMode = requestedTransportMode === 'cycling'
      ? 'bicycle'
      : requestedTransportMode === 'pedestrian'
        ? 'pedestrian'
        : 'car';
    const normalizedTransportMode = requestedTransportMode === 'cycling' || requestedTransportMode === 'pedestrian'
      ? requestedTransportMode
      : 'driving';

    const originLat = Number(origin?.lat);
    const originLng = Number(origin?.lng);
    const destinationLat = Number(destination?.lat);
    const destinationLng = Number(destination?.lng);

    if (![originLat, originLng, destinationLat, destinationLng].every(Number.isFinite)) {
      return Response.json({ error: 'Missing origin or destination' }, { status: 400 });
    }

    const appSettings = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }, '-updated_date', 1);
    const activeApiKeyName = appSettings?.[0]?.setting_value?.selected_api_key || 'HERE_API_KEY';
    const hereApiKey = activeApiKeyName.startsWith('HERE') || activeApiKeyName.startsWith('Here')
      ? Deno.env.get(activeApiKeyName)
      : Deno.env.get('HERE_API_KEY');
    if (!hereApiKey) {
      return Response.json({ error: `${activeApiKeyName} secret is not set` }, { status: 500 });
    }

    const params = new URLSearchParams({
      transportMode: hereTransportMode,
      routingMode: normalizedTransportMode === 'cycling' ? 'fast' : 'short',
      origin: `${originLat},${originLng}`,
      destination: `${destinationLat},${destinationLng}`,
      return: 'polyline,summary',
      apikey: hereApiKey,
    });

    waypoints.forEach((point) => {
      const lat = Number(point?.lat);
      const lng = Number(point?.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        params.append('via', `${lat},${lng}`);
      }
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[HERE Routing] provider error', { status: resp.status, details: text?.slice(0, 500) });
      return buildFallback(origin, destination, { provider_status: resp.status });
    }

    const data = await resp.json();
    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    const sections = Array.isArray(route?.sections) ? route.sections : [];

    if (!route || !sections.length) {
      console.error('[HERE Routing] no route in payload', { payload: data });
      return buildFallback(origin, destination);
    }

    const polylines = sections.map((section) => section?.polyline).filter(Boolean);
    const normalizedSections = sections.map((section) => ({
      polyline: section?.polyline || null,
      estimated_distance_km: Number.isFinite(section?.summary?.length) ? Math.round((section.summary.length / 1000) * 10) / 10 : null,
      estimated_duration_minutes: Number.isFinite(section?.summary?.duration) ? Math.round(section.summary.duration / 60) : null
    }));
    const totalMeters = sections.reduce((sum, section) => sum + (section?.summary?.length || 0), 0);
    const totalSeconds = sections.reduce((sum, section) => sum + (section?.summary?.duration || 0), 0);
    const estimated_distance_km = Math.round((totalMeters / 1000) * 10) / 10;
    const estimated_duration_minutes = Math.round(totalSeconds / 60);

    if (!polylines.length) {
      return Response.json({
        coordinates: [
          { lat: originLat, lng: originLng },
          { lat: destinationLat, lng: destinationLng }
        ],
        estimated_distance_km,
        estimated_duration_minutes,
        polyline_format: 'fallback'
      });
    }

    return Response.json({
      polyline_format: 'flexible',
      polyline: polylines[0],
      polylines,
      sections: normalizedSections,
      estimated_distance_km,
      estimated_duration_minutes,
      transport_mode: normalizedTransportMode
    });
  } catch (err) {
    console.error('[getHereDirections] unexpected error', err?.message || err);
    return buildFallback(origin, destination, { error: err?.message || 'Unknown error' });
  }
});