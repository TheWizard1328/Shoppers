import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

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

const TIME_ZONE = 'America/Edmonton';
const WEEKDAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

const buildFallbackSections = (origin, destination, waypoints = []) => {
  const points = [origin, ...waypoints, destination]
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

  return points.slice(0, -1).map((point, index) => ({
    polyline: null,
    encoded_polyline: null,
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

const parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return (hours * 60) + minutes;
};

const normalizeTimeString = (timeStr, fallback = '00:00:00') => {
  if (!timeStr || typeof timeStr !== 'string') return fallback;
  const parts = timeStr.split(':');
  if (parts.length < 2) return fallback;
  const hours = String(Number(parts[0]) || 0).padStart(2, '0');
  const minutes = String(Number(parts[1]) || 0).padStart(2, '0');
  const seconds = String(Number(parts[2]) || 0).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const getWeekdayCode = (dateStr) => {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  return WEEKDAY_CODES[utcDate.getUTCDay()];
};

const getTimeZoneOffset = (dateStr) => {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  const sampleDate = new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0));
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    timeZoneName: 'shortOffset',
    hour: '2-digit'
  }).formatToParts(sampleDate).find((part) => part.type === 'timeZoneName')?.value || 'GMT-07:00';
  const match = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return '-07:00';
  const sign = match[1];
  const hours = String(match[2]).padStart(2, '0');
  const minutes = String(match[3] || '00').padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
};

const buildLocalIso = (dateStr, timeStr) => `${dateStr}T${normalizeTimeString(timeStr)}${getTimeZoneOffset(dateStr)}`;

const buildAccessConstraint = (dateStr, startTime, endTime) => {
  if (!startTime && !endTime) return null;
  const startMinutes = parseTimeToMinutes(startTime);
  const endMinutes = parseTimeToMinutes(endTime);
  if (Number.isFinite(startMinutes) && Number.isFinite(endMinutes) && endMinutes <= startMinutes) return null;
  const weekday = getWeekdayCode(dateStr);
  const offset = getTimeZoneOffset(dateStr);
  const start = normalizeTimeString(startTime, '00:00:00');
  const end = normalizeTimeString(endTime, '23:59:59');
  return `acc:${weekday}${start}${offset}|${weekday}${end}${offset}`;
};

const calculateCrowFliesDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

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
    const preserveWaypointOrder = body?.preserveWaypointOrder === true;
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

    const dateStr = String(body?.deliveryDate || body?.date || new Date().toISOString().slice(0, 10));
    const departureTime = String(body?.departureTime || body?.currentLocalTime || '08:00');
    const allStops = [
      { lat: originLat, lng: originLng, id: 'origin', sequenceIndex: -1 },
      ...waypoints.map((point, index) => ({
        lat: Number(point?.lat),
        lng: Number(point?.lng),
        id: String(routeContext[index]?.id || routeContext[index]?.stop_id || routeContext[index]?.delivery_id || `waypoint_${index + 1}`),
        sequenceIndex: index
      })),
      { lat: destinationLat, lng: destinationLng, id: String(routeContext[waypoints.length]?.id || routeContext[waypoints.length]?.stop_id || routeContext[waypoints.length]?.delivery_id || 'destination'), sequenceIndex: waypoints.length }
    ].filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

    const sequenceStops = allStops.slice(1);
    let resp = { ok: true, status: 200 };
    let data = null;
    let result = null;
    let returnedWaypoints = [];
    let interconnections = [];

    if (preserveWaypointOrder) {
      returnedWaypoints = sequenceStops.map((stop, index) => ({
        id: stop.id,
        sequence: index + 1
      }));
      interconnections = sequenceStops.map((stop, index) => {
        const fromPoint = index === 0 ? { lat: originLat, lng: originLng } : { lat: sequenceStops[index - 1].lat, lng: sequenceStops[index - 1].lng };
        const fallbackDistanceKm = calculateCrowFliesDistance(fromPoint.lat, fromPoint.lng, stop.lat, stop.lng);
        return {
          toWaypoint: stop.id,
          distance: Math.round(fallbackDistanceKm * 1000),
          time: Math.round((fallbackDistanceKm / 40) * 3600)
        };
      });
    } else {
      const params = new URLSearchParams();
      params.set('apiKey', hereApiKey);
      params.set('departure', buildLocalIso(dateStr, departureTime));
      params.set('mode', `shortest;${hereTransportMode};traffic:disabled`);
      params.set('improveFor', 'distance');
      params.set('start', `driverStart;${originLat},${originLng}`);

      sequenceStops.forEach((stop, index) => {
        const routeItem = routeContext[stop.sequenceIndex] || {};
        const segments = [`${stop.id};${stop.lat},${stop.lng}`];
        const accessConstraint = buildAccessConstraint(dateStr, routeItem?.time_window_start, routeItem?.time_window_end);
        if (accessConstraint) segments.push(accessConstraint);
        params.set(`destination${index + 1}`, segments.join(';'));
      });

      routeCallCount += 1;
      resp = await fetch(`https://wps.hereapi.com/v8/findsequence2?${params.toString()}`, {
        signal: AbortSignal.timeout(20000),
        headers: { accept: 'application/json' }
      });
      data = await resp.json().catch(() => null);

      result = Array.isArray(data?.results) ? data.results[0] : null;
      returnedWaypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
      interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];

      if ((!resp.ok || !result || returnedWaypoints.length === 0) && sequenceStops.length > 0) {
        const retryParams = new URLSearchParams();
        retryParams.set('apiKey', hereApiKey);
        retryParams.set('departure', buildLocalIso(dateStr, departureTime));
        retryParams.set('mode', `shortest;${hereTransportMode};traffic:disabled`);
        retryParams.set('improveFor', 'distance');
        retryParams.set('start', `driverStart;${originLat},${originLng}`);
        sequenceStops.forEach((stop, index) => {
          retryParams.set(`destination${index + 1}`, `${stop.id};${stop.lat},${stop.lng}`);
        });
        routeCallCount += 1;
        resp = await fetch(`https://wps.hereapi.com/v8/findsequence2?${retryParams.toString()}`, {
          signal: AbortSignal.timeout(20000),
          headers: { accept: 'application/json' }
        });
        data = await resp.json().catch(() => null);
        result = Array.isArray(data?.results) ? data.results[0] : null;
        returnedWaypoints = Array.isArray(result?.waypoints) ? result.waypoints : [];
        interconnections = Array.isArray(result?.interconnections) ? result.interconnections : [];
      }
    }

    if (!resp.ok) {
      const details = JSON.stringify(data || {}).slice(0, 500);
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
        errorMessage: details || `HTTP ${resp.status}`,
        callCount: routeCallCount,
        metadata: {
          status_code: resp.status,
          transport_mode: normalizedTransportMode,
          waypoint_count: waypoints.length,
          stops_count: sequenceStops.length + 1,
        },
      });
      return buildFallback(origin, destination, { provider_status: resp.status }, waypoints);
    }

    if (!result || returnedWaypoints.length === 0) {
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
        errorMessage: 'No sequence returned',
        callCount: routeCallCount,
        metadata: {
          transport_mode: normalizedTransportMode,
          waypoint_count: waypoints.length,
          stops_count: sequenceStops.length + 1,
        },
      });
      return buildFallback(origin, destination, {}, waypoints);
    }

    const stopLookup = new Map(sequenceStops.map((stop) => [stop.id, stop]));
    const orderedWaypoints = returnedWaypoints
      .filter((waypoint) => waypoint.id !== 'driverStart' && waypoint.id !== 'driverEnd')
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    const orderedStops = orderedWaypoints
      .map((waypoint) => stopLookup.get(waypoint.id) || null)
      .filter(Boolean);

    const interconnectionByToWaypoint = new Map(interconnections.map((item) => [item.toWaypoint, item]));

    const orderedPoints = [{ lat: originLat, lng: originLng }, ...orderedStops.map((stop) => ({ lat: stop.lat, lng: stop.lng }))];
    const normalizedSections = orderedStops.map((stop, index) => {
      const leg = interconnectionByToWaypoint.get(stop.id);
      const fromPoint = orderedPoints[index];
      const toPoint = orderedPoints[index + 1];
      const fallbackDistanceKm = calculateCrowFliesDistance(fromPoint.lat, fromPoint.lng, toPoint.lat, toPoint.lng);
      const estimatedDistanceKm = Number.isFinite(Number(leg?.distance)) ? Math.round((Number(leg.distance) / 1000) * 10) / 10 : Math.round(fallbackDistanceKm * 10) / 10;
      const estimatedDurationMinutes = Number.isFinite(Number(leg?.time)) ? Math.round(Number(leg.time) / 60) : Math.round((fallbackDistanceKm / 40) * 60);
      return {
        polyline: null,
        encoded_polyline: null,
        estimated_distance_km: estimatedDistanceKm,
        estimated_duration_minutes: estimatedDurationMinutes,
        sequence: index + 1,
        waypoint_id: stop.id,
        coordinates: [fromPoint, toPoint]
      };
    });

    const totalMeters = interconnections.reduce((sum, item) => sum + Number(item?.distance || 0), 0);
    const totalSeconds = interconnections.reduce((sum, item) => sum + Number(item?.time || 0), 0);
    const estimated_distance_km = totalMeters > 0
      ? Math.round((totalMeters / 1000) * 10) / 10
      : normalizedSections.reduce((sum, section) => sum + Number(section.estimated_distance_km || 0), 0);
    const estimated_duration_minutes = totalSeconds > 0
      ? Math.round(totalSeconds / 60)
      : normalizedSections.reduce((sum, section) => sum + Number(section.estimated_duration_minutes || 0), 0);

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
        stops_count: sequenceStops.length + 1,
        estimated_distance_km,
        estimated_duration_minutes,
        optimized_sequence: orderedWaypoints.map((waypoint) => waypoint.id)
      },
    });

    return Response.json({
      polyline_format: 'sequence',
      polyline: null,
      polylines: [],
      sections: normalizedSections,
      estimated_distance_km,
      estimated_duration_minutes,
      transport_mode: normalizedTransportMode,
      optimized_waypoint_ids: orderedWaypoints.map((waypoint) => waypoint.id),
      used_time_windows: preserveWaypointOrder ? false : true,
      api_call_count: routeCallCount
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
    return buildFallback(origin, destination, { error: err?.message || 'Unknown error' }, []);
  }
});