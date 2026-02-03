import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    console.log('[googlePlacesAutocomplete] Request received');
    
    const base44 = createClientFromRequest(req);
    
    // Verify user is authenticated
    const user = await base44.auth.me();
    if (!user) {
      console.error('[googlePlacesAutocomplete] Unauthorized - no user');
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    console.log('[googlePlacesAutocomplete] User authenticated:', user.email);

    const body = await req.json();
    console.log('[googlePlacesAutocomplete] ===== REQUEST DETAILS =====');
    console.log('[googlePlacesAutocomplete] Request body:', JSON.stringify(body));
    console.log('[googlePlacesAutocomplete] Input:', body.input);
    console.log('[googlePlacesAutocomplete] Latitude:', body.latitude);
    console.log('[googlePlacesAutocomplete] Longitude:', body.longitude);

    const { input, latitude, longitude } = body;
    
    if (!input || input.trim().length < 3) {
      console.log('[googlePlacesAutocomplete] Input too short, returning empty');
      return Response.json({ predictions: [] });
    }

    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      console.error('[googlePlacesAutocomplete] API key not configured');
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }
    
    console.log('[googlePlacesAutocomplete] API key exists, length:', apiKey.length);

    // Use the NEW Google Places API
    const url = 'https://places.googleapis.com/v1/places:autocomplete';
    
    // Build request body for new API
    const requestBody = {
      input: input,
      languageCode: 'en',
      includedRegionCodes: ['CA']
    };

    // Add origin point for distance-based sorting (works with new API)
    if (latitude && longitude) {
      requestBody.origin = {
        latitude: latitude,
        longitude: longitude
      };
      console.log('[googlePlacesAutocomplete] ✅ Added origin point for sorting:');
      console.log('[googlePlacesAutocomplete]    Origin:', latitude, longitude);
      console.log('[googlePlacesAutocomplete]    Full requestBody:', JSON.stringify(requestBody, null, 2));
    } else {
      console.warn('[googlePlacesAutocomplete] ⚠️ NO COORDINATES PROVIDED - using Canada-wide search');
      console.log('[googlePlacesAutocomplete]    Full requestBody:', JSON.stringify(requestBody, null, 2));
    }
    
    // Get user's AppUser record for user_name
    const userAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const userAppUser = userAppUsers?.[0];
    
    // Log API call
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Places Autocomplete',
      purpose: 'Address autocomplete search',
      function_name: 'googlePlacesAutocomplete',
      user_id: user.id,
      user_name: userAppUser?.user_name || user.full_name,
      metadata: {
        input: input,
        has_location_bias: !!(latitude && longitude)
      }
    });

    console.log('[googlePlacesAutocomplete] Calling Google API (NEW)...');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey
      },
      body: JSON.stringify(requestBody)
    });
    
    console.log('[googlePlacesAutocomplete] Google API HTTP status:', response.status);
    
    const data = await response.json();
    console.log('[googlePlacesAutocomplete] Google API full response:', JSON.stringify(data));

    // New API returns suggestions array instead of predictions
    if (!response.ok) {
      const errorMsg = data.error?.message || 'Places API error';
      console.error('[googlePlacesAutocomplete] Google Places API error:', errorMsg);
      return Response.json({ 
        error: errorMsg,
        details: data 
      }, { status: 500 });
    }

    // Convert new API format - use Google's built-in distance if available
    const predictions = (data.suggestions || []).map(suggestion => {
      const placePrediction = suggestion.placePrediction;
      if (!placePrediction) return null;

      const description = placePrediction.text?.text || '';
      const place_id = placePrediction.placeId || '';
      
      // Google Places API v1 provides distanceMeters directly - convert to km
      const distance = placePrediction.distanceMeters 
        ? placePrediction.distanceMeters / 1000 
        : null;

      console.log('[googlePlacesAutocomplete] Suggestion:', description, 'Distance:', distance?.toFixed(2), 'km');

      return {
        description,
        place_id,
        distance
      };
    }).filter(p => p !== null);

    // Filter out nulls and sort by distance (closest first)
    const validPredictions = predictions.filter(p => p !== null);
    validPredictions.sort((a, b) => {
      // Predictions without distance go to the end
      if (a.distance === null && b.distance === null) return 0;
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });

    console.log('[googlePlacesAutocomplete] Returning', validPredictions.length, 'predictions (sorted by distance)');
    return Response.json({ predictions: validPredictions });

  } catch (error) {
    console.error('[googlePlacesAutocomplete] Caught error:', error);
    console.error('[googlePlacesAutocomplete] Error stack:', error.stack);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});