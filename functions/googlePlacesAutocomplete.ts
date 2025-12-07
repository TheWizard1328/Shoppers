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
    console.log('[googlePlacesAutocomplete] Request body:', JSON.stringify(body));
    
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
      input: input
      // Removed includedPrimaryTypes to allow all address types
    };

    // Add location biasing if coordinates provided (prefers nearby but doesn't exclude)
    if (latitude && longitude) {
      requestBody.locationBias = {
        circle: {
          center: {
            latitude: latitude,
            longitude: longitude
          },
          radius: 75000.0 // 75km in meters
        }
      };
      console.log('[googlePlacesAutocomplete] Added location bias:', latitude, longitude, '75km radius');
    } else {
      console.log('[googlePlacesAutocomplete] No location bias (coordinates missing)');
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

    // Convert new API format to match old format
    const predictions = (data.suggestions || []).map(suggestion => {
      const placePrediction = suggestion.placePrediction;
      if (!placePrediction) return null;
      
      // The new API uses text.text for the full formatted address
      const description = placePrediction.text?.text || '';
      const place_id = placePrediction.placeId || '';
      
      console.log('[googlePlacesAutocomplete] Parsed prediction:', { description, place_id });
      
      return {
        description,
        place_id
      };
    }).filter(p => p !== null);

    console.log('[googlePlacesAutocomplete] Returning', predictions.length, 'predictions');
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