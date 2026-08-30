import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { resolveFeatureSecretName } from '../../shared/apiKeyResolver.ts';

const logApiUsage = async ({ base44, appUserId, appUserName, provider, apiType, purpose, functionName, metadata = {}, success, durationMs, errorMessage }) => {
  if (!base44) return;
  try {
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: apiType,
      purpose,
      function_name: functionName,
      user_id: appUserId || null,
      user_name: appUserName || null,
      metadata: { api_provider: provider, success: success === true, duration_ms: durationMs, error_message: errorMessage || undefined, ...metadata },
    });
  } catch (e) { /* best-effort */ }
};

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();

    const secretName = await resolveFeatureSecretName(base44, 'eta_distance');
    const isGoogle = secretName === 'GOOGLE_MAPS_API_KEY';
    const apiKey = Deno.env.get(secretName);
    if (!apiKey) {
      return Response.json({ error: `${secretName} not configured` }, { status: 500 });
    }

    // Build origin/destination strings — accept either lat/lng coords or address strings
    let origins, destinations, originLat, originLng, destLat, destLng;
    if (body.originLat && body.originLng && body.destLat && body.destLng) {
      originLat = body.originLat; originLng = body.originLng;
      destLat = body.destLat; destLng = body.destLng;
      origins = `${originLat},${originLng}`;
      destinations = `${destLat},${destLng}`;
    } else if (body.origin && body.destination) {
      origins = body.origin;
      destinations = body.destination;
    } else {
      return Response.json({ error: 'Provide either originLat/originLng/destLat/destLng or origin/destination address strings' }, { status: 400 });
    }

    // Resolve caller identity for usage logging
    let logUserId = null;
    let logUserName = null;
    try {
      const caller = await base44.auth.me();
      if (caller?.id) {
        logUserName = caller.full_name || null;
        const appUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: caller.id }, '-updated_date', 1);
        if (appUsers?.[0]) {
          logUserId = appUsers[0].id;
          if (appUsers[0].user_name) logUserName = appUsers[0].user_name;
        } else {
          logUserId = caller.id;
        }
      }
    } catch (_) { /* non-critical */ }

    // ── HERE Routing v8 summary path ────────────────────────────────────
    if (!isGoogle) {
      if (originLat == null || destLat == null) {
        return Response.json({ error: 'HERE Routing requires lat/lng coordinates' }, { status: 400 });
      }
      const params = new URLSearchParams();
      params.set('apiKey', apiKey);
      params.set('transportMode', 'car');
      params.set('origin', `${originLat},${originLng}`);
      params.set('destination', `${destLat},${destLng}`);
      params.set('return', 'summary');
      const response = await fetch(`https://router.hereapi.com/v8/routes?${params.toString()}`, {
        signal: AbortSignal.timeout(20000),
        headers: { accept: 'application/json' },
      });
      const data = await response.json().catch(() => null);
      const summary = data?.routes?.[0]?.sections?.[0]?.summary;
      if (!response.ok || !summary) {
        await logApiUsage({ base44, appUserId: logUserId, appUserName: logUserName, provider: 'here', apiType: 'Distance Matrix', purpose: 'calculating driving distance', functionName: 'getGoogleDrivingDistance', success: false, durationMs: Date.now() - startedAt, errorMessage: data?.title || `HTTP ${response.status}`, metadata: { origins, destinations, status_code: response.status } });
        return Response.json({ error: `HERE Routing error: ${data?.title || response.status}` }, { status: 500 });
      }
      const distanceKm = parseFloat((Number(summary.length) / 1000).toFixed(2));
      const durationMin = Math.round(Number(summary.duration) / 60);
      const durationText = durationMin >= 60 ? `${Math.floor(durationMin / 60)} hour${durationMin >= 120 ? 's' : ''} ${durationMin % 60} min` : `${durationMin} min`;

      await base44.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Distance Matrix',
        purpose: 'calculating driving distance',
        function_name: 'getGoogleDrivingDistance',
        user_id: logUserId,
        user_name: logUserName,
        metadata: { api_provider: 'here', origins, destinations, distance_km: distanceKm },
      }).catch(() => {});

      return Response.json({ distance_km: distanceKm, duration_text: durationText, source: 'HERE Routing' });
    }

    // ── Google Distance Matrix path (unchanged) ─────────────────────────
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${encodeURIComponent(origins)}&destinations=${encodeURIComponent(destinations)}&key=${apiKey}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') {
      console.error('Google Distance Matrix API error:', data.status, data.error_message);
      return Response.json({ error: `Google Distance Matrix API error: ${data.status}` }, { status: 500 });
    }

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== 'OK') {
      console.error('Google Distance Matrix element error:', element?.status);
      return Response.json({ error: `Distance Matrix element error: ${element?.status}` }, { status: 500 });
    }

    const distanceKm = parseFloat((element.distance.value / 1000).toFixed(2));
    const durationText = element.duration?.text || null;

    await base44.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Distance Matrix',
      purpose: 'calculating driving distance',
      function_name: 'getGoogleDrivingDistance',
      user_id: logUserId,
      user_name: logUserName,
      metadata: { api_provider: 'google', origins, destinations, distance_km: distanceKm },
    }).catch(() => {});

    return Response.json({ distance_km: distanceKm, duration_text: durationText, source: 'Google Distance Matrix' });

  } catch (error) {
    console.error('Error in getGoogleDrivingDistance:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});