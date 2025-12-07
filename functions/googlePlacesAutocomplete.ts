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

    // Build URL with location biasing if coordinates provided
    let url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=address&key=${apiKey}`;
    
    // Add location and radius (150km = 150000 meters) to bias results
    if (latitude && longitude) {
      url += `&location=${latitude},${longitude}&radius=150000&strictbounds=true`;
      console.log('[googlePlacesAutocomplete] Added location biasing:', latitude, longitude);
    } else {
      console.log('[googlePlacesAutocomplete] No location biasing (coordinates missing)');
    }
    
    console.log('[googlePlacesAutocomplete] Calling Google API...');
    const response = await fetch(url);
    console.log('[googlePlacesAutocomplete] Google API HTTP status:', response.status);
    
    const data = await response.json();
    console.log('[googlePlacesAutocomplete] Google API response status:', data.status);
    console.log('[googlePlacesAutocomplete] Google API full response:', JSON.stringify(data));

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      const errorMsg = data.error_message || data.status || 'Places API error';
      console.error('[googlePlacesAutocomplete] Google Places API error:', errorMsg);
      return Response.json({ 
        error: errorMsg,
        details: data 
      }, { status: 500 });
    }

    // Return simplified predictions
    const predictions = (data.predictions || []).map(p => ({
      description: p.description,
      place_id: p.place_id
    }));

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