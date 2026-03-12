import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  let base44 = null;
  let user = null;
  let userAppUser = null;
  let input = '';
  let latitude = null;
  let longitude = null;
  let googleApiCallCount = 0;
  let autocompleteCalls = 0;
  let placeDetailsCalls = 0;
  let directionsCalls = 0;

  const logUsage = async (extraMetadata = {}) => {
    if (!base44 || !user) return;
    try {
      await base44.asServiceRole.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Places Autocomplete',
        purpose: 'Address autocomplete search',
        function_name: 'googlePlacesAutocomplete',
        user_id: user.id,
        user_name: userAppUser?.user_name || user.full_name,
        metadata: {
          api_provider: 'google',
          call_count: googleApiCallCount,
          autocomplete_calls: autocompleteCalls,
          place_details_calls: placeDetailsCalls,
          directions_calls: directionsCalls,
          input,
          has_location_bias: !!(latitude && longitude),
          ...extraMetadata
        }
      });
    } catch (logError) {
      console.warn('[googlePlacesAutocomplete] Non-fatal log error:', logError?.message || logError);
    }
  };

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
    autocompleteCalls += 1;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text'
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMsg = data.error?.message || 'Places API error';
      await logUsage({ error: errorMsg, status_code: response.status });
      return Response.json({ error: errorMsg, details: data }, { status: response.status });
    }

    const predictions = (data.suggestions || []).map((suggestion) => {
      const placePrediction = suggestion.placePrediction;
      if (!placePrediction) return null;

      return {
        description: placePrediction.text?.text || '',
        place_id: placePrediction.placeId || '',
        distance: null
      };
    }).filter((prediction) => prediction !== null);

    predictions.sort((a, b) => {
      if (a.distance === null && b.distance === null) return 0;
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });

    await logUsage({ suggestion_count: predictions.length });
    return Response.json({ predictions });
  } catch (error) {
    console.error('[googlePlacesAutocomplete] Error:', error.message);
    await logUsage({ error: error.message });
    return Response.json({ error: error.message }, { status: 500 });
  }
});