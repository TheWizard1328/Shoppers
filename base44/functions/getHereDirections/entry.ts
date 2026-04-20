// Redeployed on 2026-04-09
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const logApiUsage = async ({
  base44,
  appUserId,
  appUserName,
  provider,
  apiType,
  purpose,
  functionName,
  metadata = {},
  success,
  durationMs,
  errorMessage,
  callCount = 1,
}) => {
  if (!base44) return;

  try {
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: apiType,
      purpose,
      function_name: functionName,
      user_id: appUserId || null,
      user_name: appUserName || null,
      metadata: {
        api_provider: provider,
        call_count: Number(callCount) || 1,
        success: success === true,
        duration_ms: durationMs,
        error_message: errorMessage || undefined,
        ...metadata,
      },
    });
  } catch (error) {
    console.warn('[IntegrationUsageLogger] Failed to persist API usage log:', error?.message || error);
  }
};

const buildFallbackSections = (origin, destination, waypoints = []) => {
  const points = [origin, ...waypoints, destination]
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

  return points.slice(0, -1).map((point, index) => ({
    polyline: null,
    estimated_distance_km: 0,
    estimated_duration_minutes: 0,
    coordinates: [point, points[index + 1]].filter(Boolean)
  }));
};

const buildFallback = (origin, destination, extra = {}, waypoints = []) => Response.json({
  coordinates: [
    { lat: Number(origin?.lat), lng: Number(origin?.lng) },
    { lat: Number(destination?.lat), lng: Number(destination?.lng) }
  ].filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)),
  sections: buildFallbackSections(origin, destination, waypoints),
  estimated_distance_km: 0,
  estimated_duration_minutes: 0,
  polyline_format: 'fallback',
  ...extra
});


Deno.serve(async (req) => {
  let origin = null;
  let destination = null;
  let base44 = null;
  let appUser = null;
  let routeCallCount = 0;
  const startedAt = Date.now();

  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    origin = body?.origin || null;
    destination = body?.destination || null;
    const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-updated_date', 1);
    appUser = appUsers?.[0] || null;
    const waypoints = Array.isArray(body?.waypoints) ? body.waypoints : [];
    const routeContext = Array.isArray(body?.routeContext) ? body.routeContext : [];
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
    routeCallCount += 1;
    const resp = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[HERE Routing] provider error', { status: resp.status, details: text?.slice(0, 500) });
      await logApiUsage({
        base44,
        appUserId: appUser?.id,
        appUserName: appUser?.user_name || user.full_name,
        provider: 'here',
        apiType: 'Directions',
        purpose: 'Calculate route directions',
        functionName: 'getHereDirections',
        success: false,
        durationMs: Date.now() - startedAt,
        errorMessage: text?.slice(0, 500) || `HTTP ${resp.status}`,
        callCount: routeCallCount,
        metadata: {
          status_code: resp.status,
          transport_mode: normalizedTransportMode,
          waypoint_count: waypoints.length,
          stops_count: Array.isArray(body?.routeContext) && body.routeContext.length > 0 ? body.routeContext.length : waypoints.length + 2,
        },
      });
      return buildFallback(origin, destination, { provider_status: resp.status }, waypoints);
    }

    const data = await resp.json();
    const route = Array.isArray(data?.routes) ? data.routes[0] : null;
    const sections = Array.isArray(route?.sections) ? route.sections : [];

    if (!route || !sections.length) {
      console.error('[HERE Routing] no route in payload', { payload: data });
      await logApiUsage({
        base44,
        appUserId: appUser?.id,
        appUserName: appUser?.user_name || user.full_name,
        provider: 'here',
        apiType: 'Directions',
        purpose: 'Calculate route directions',
        functionName: 'getHereDirections',
        success: false,
        durationMs: Date.now() - startedAt,
        errorMessage: 'No route returned',
        callCount: routeCallCount,
        metadata: {
          transport_mode: normalizedTransportMode,
          waypoint_count: waypoints.length,
          stops_count: Array.isArray(body?.routeContext) && body.routeContext.length > 0 ? body.routeContext.length : waypoints.length + 2,
        },
      });
      return buildFallback(origin, destination, {}, waypoints);
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
        sections: buildFallbackSections(origin, destination, waypoints),
        estimated_distance_km,
        estimated_duration_minutes,
        polyline_format: 'fallback'
      });
    }

    await logApiUsage({
      base44,
      appUserId: appUser?.id,
      appUserName: appUser?.user_name || user.full_name,
      provider: 'here',
      apiType: 'Directions',
      purpose: 'Calculate route directions',
      functionName: 'getHereDirections',
      success: true,
      durationMs: Date.now() - startedAt,
      callCount: routeCallCount,
      metadata: {
        transport_mode: normalizedTransportMode,
        waypoint_count: waypoints.length,
        stops_count: Array.isArray(body?.routeContext) && body.routeContext.length > 0 ? body.routeContext.length : waypoints.length + 2,
        estimated_distance_km,
        estimated_duration_minutes,
      },
    });

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
    await logApiUsage({
      base44,
      appUserId: appUser?.id,
      appUserName: appUser?.user_name || null,
      provider: 'here',
      apiType: 'Directions',
      purpose: 'Calculate route directions',
      functionName: 'getHereDirections',
      success: false,
      durationMs: Date.now() - startedAt,
      errorMessage: err?.message || 'Unknown error',
      callCount: routeCallCount || 1,
    });
    return buildFallback(origin, destination, { error: err?.message || 'Unknown error' }, waypoints);
  }
});