import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Verify user is authenticated
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { place_id } = await req.json();
    
    if (!place_id) {
      return Response.json({ error: 'place_id is required' }, { status: 400 });
    }

    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }

    // Call Google Places Details API to get full address components
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=address_components,formatted_address,geometry&key=${apiKey}`;
    
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') {
      return Response.json({ error: data.error_message || 'Places Details API error' }, { status: 500 });
    }

    const result = data.result;
    const addressComponents = result.address_components || [];

    // Extract relevant components
    let streetNumber = '';
    let route = '';
    let subpremise = '';

    addressComponents.forEach(component => {
      if (component.types.includes('street_number')) {
        streetNumber = component.long_name;
      } else if (component.types.includes('route')) {
        route = component.long_name;
      } else if (component.types.includes('subpremise')) {
        subpremise = component.long_name;
      }
    });

    const address = `${streetNumber} ${route}`.trim();
    const unit = subpremise;

    return Response.json({
      address,
      unit,
      formatted_address: result.formatted_address,
      latitude: result.geometry?.location?.lat,
      longitude: result.geometry?.location?.lng
    });

  } catch (error) {
    console.error('Error in googlePlaceDetails:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});