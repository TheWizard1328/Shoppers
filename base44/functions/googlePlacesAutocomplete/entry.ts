// Redeployed on 2026-03-28
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

Deno.serve(async (req) => {
  let base44 = null;
  let user = null;
  let userAppUser = null;
  let input = '';
  let latitude = null;
  let longitude = null;
  let googleApiCallCount = 0;
  const startedAt = Date.now();

  try {
    base44 = createClientFromRequest(req);

    user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    input = body?.input || '';
    latitude = body?.latitude;
    longitude = body?.longitude;

    if (!input || input.trim().length < 3) {
      return Response.json({ predictions: [] });
    }

    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }

    try {
      const userAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
      userAppUser = userAppUsers?.[0] || null;
    } catch (_) {}

    const url = 'https://places.googleapis.com/v1/places:autocomplete';
    const requestBody = {
      input,
      languageCode: 'en',
      includedRegionCodes: ['CA']
    };

    if (latitude && longitude) {
      requestBody.origin = {
        latitude,
        longitude
      };
      requestBody.locationBias = {
        circle: {
          center: {
            latitude,
            longitude
          },
          radius: 50000
        }
      };
    }

    googleApiCallCount += 1;
    let response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.distanceMeters'
      },
      body: JSON.stringify(requestBody)
    });

    let data = await response.json();

    if (!response.ok && latitude && longitude) {
      const fallbackBody = {
        input,
        languageCode: 'en',
        includedRegionCodes: ['CA']
      };
      googleApiCallCount += 1;
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.distanceMeters'
        },
        body: JSON.stringify(fallbackBody)
      });
      data = await response.json();
    }

    if (!response.ok) {
      const errorMsg = data.error?.message || 'Places API error';
      await logApiUsage({
        base44,
        appUserId: userAppUser?.id,
        appUserName: userAppUser?.user_name || user.full_name,
        provider: 'google',
        apiType: 'Places Autocomplete',
        purpose: 'Address autocomplete search',
        functionName: 'googlePlacesAutocomplete',
        success: false,
        durationMs: Date.now() - startedAt,
        errorMessage: errorMsg,
        callCount: googleApiCallCount,
        metadata: {
          input,
          has_location_bias: !!(latitude && longitude),
          status_code: response.status,
        },
      });
      return Response.json({ error: errorMsg, details: data }, { status: response.status });
    }

    const predictions = (data.suggestions || []).map((suggestion) => {
      const placePrediction = suggestion.placePrediction;
      if (!placePrediction) return null;

      return {
        description: placePrediction.text?.text || '',
        place_id: placePrediction.placeId || '',
        distance: Number.isFinite(placePrediction.distanceMeters)
          ? parseFloat((placePrediction.distanceMeters / 1000).toFixed(2))
          : null
      };
    }).filter((prediction) => prediction !== null);

    predictions.sort((a, b) => {
      if (a.distance === null && b.distance === null) return 0;
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });

    await logApiUsage({
      base44,
      appUserId: userAppUser?.id,
      appUserName: userAppUser?.user_name || user.full_name,
      provider: 'google',
      apiType: 'Places Autocomplete',
      purpose: 'Address autocomplete search',
      functionName: 'googlePlacesAutocomplete',
      success: true,
      durationMs: Date.now() - startedAt,
      callCount: googleApiCallCount,
      metadata: {
        input,
        has_location_bias: !!(latitude && longitude),
        suggestion_count: predictions.length,
      },
    });
    return Response.json({ predictions });
  } catch (error) {
    console.error('[googlePlacesAutocomplete] Error:', error.message);
    await logApiUsage({
      base44,
      appUserId: userAppUser?.id,
      appUserName: userAppUser?.user_name || null,
      provider: 'google',
      apiType: 'Places Autocomplete',
      purpose: 'Address autocomplete search',
      functionName: 'googlePlacesAutocomplete',
      success: false,
      durationMs: Date.now() - startedAt,
      errorMessage: error.message,
      callCount: googleApiCallCount || 1,
      metadata: {
        input,
        has_location_bias: !!(latitude && longitude),
      },
    });
    return Response.json({ error: error.message }, { status: 500 });
  }
});