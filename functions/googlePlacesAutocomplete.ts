import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Verify user is authenticated
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { input, latitude, longitude } = await req.json();
    
    if (!input || input.trim().length < 3) {
      return Response.json({ predictions: [] });
    }

    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }

    // Build URL with location biasing if coordinates provided
    let url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=address&key=${apiKey}`;
    
    // Add location and radius (150km = 150000 meters) to bias results
    if (latitude && longitude) {
      url += `&location=${latitude},${longitude}&radius=150000&strictbounds=true`;
    }
    
    const response = await fetch(url);
    const data = await response.json();

    console.log('Google API response status:', data.status);
    console.log('Google API full response:', JSON.stringify(data));

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      const errorMsg = data.error_message || data.status || 'Places API error';
      console.error('Google Places API error:', errorMsg);
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

    return Response.json({ predictions });

  } catch (error) {
    console.error('Error in googlePlacesAutocomplete:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});