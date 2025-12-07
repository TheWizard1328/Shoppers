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
      languageCode: 'en'
    };

    // Add strict location restriction if coordinates provided (ONLY returns results within radius)
    if (latitude && longitude) {
      requestBody.locationRestriction = {
        circle: {
          center: {
            latitude: latitude,
            longitude: longitude
          },
          radius: 75000.0 // 75km in meters - STRICT limit
        }
      };
      console.log('[googlePlacesAutocomplete] ✅ Added STRICT location restriction:');
      console.log('[googlePlacesAutocomplete]    Center:', latitude, longitude);
      console.log('[googlePlacesAutocomplete]    Radius: 75km');
      console.log('[googlePlacesAutocomplete]    Full requestBody:', JSON.stringify(requestBody, null, 2));
    } else {
      // Fallback to Canada-wide if no coordinates
      requestBody.includedRegionCodes = ['CA'];
      console.warn('[googlePlacesAutocomplete] ⚠️ NO COORDINATES PROVIDED - using Canada-wide search');
      console.log('[googlePlacesAutocomplete]    Full requestBody:', JSON.stringify(requestBody, null, 2));
    }
    
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

    // Convert new API format to match old format and calculate distances
    const predictions = (data.suggestions || []).map(suggestion => {
      const placePrediction = suggestion.placePrediction;
      if (!placePrediction) return null;

      // The new API uses text.text for the full formatted address
      const description = placePrediction.text?.text || '';
      const place_id = placePrediction.placeId || '';

      // Extract coordinates if available for distance sorting
      let distance = null;
      if (latitude && longitude && placePrediction.structuredFormat?.mainText?.text) {
        // Try to estimate distance (we'll sort, but can't get exact distance without calling Place Details)
        // For now, we'll use the order from Google as it already biases by location
        distance = 0;
      }

      console.log('[googlePlacesAutocomplete] Parsed prediction:', { description, place_id, distance });

      return {
        description,
        place_id,
        distance
      };
    }).filter(p => p !== null);

    // Results are already sorted by relevance/proximity from Google's locationRestriction
    // No additional sorting needed - Google handles this based on the circle center
    console.log('[googlePlacesAutocomplete] Returning', predictions.length, 'predictions (sorted by Google)');
    return Response.json({ predictions });

  } catch (error) {
    console.error('[googlePlacesAutocomplete] Caught error:', error);
    console.error('[googlePlacesAutocomplete] Error stack:', error.stack);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});