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

    // Get user's AppUser record for user_name
    const userAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const userAppUser = userAppUsers?.[0];
    
    // Log API call
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Place Details',
      purpose: 'Fetching address details for place autocomplete',
      function_name: 'googlePlaceDetails',
      user_id: user.id,
      user_name: userAppUser?.user_name || user.full_name,
      metadata: {
        place_id: place_id
      }
    });

    // Call Google Places API (New) v1 to get full address details
    const url = `https://places.googleapis.com/v1/places/${place_id}?key=${apiKey}`;
    
    const response = await fetch(url, {
      headers: {
        'X-Goog-FieldMask': 'addressComponents,formattedAddress,location'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Google Places API error:', errorText);
      return Response.json({ error: 'Places API error: ' + errorText }, { status: 500 });
    }
    
    const result = await response.json();
    const addressComponents = result.addressComponents || [];

    // Extract relevant components (New API uses longText instead of long_name)
    let streetNumber = '';
    let route = '';
    let subpremise = '';

    addressComponents.forEach(component => {
      if (component.types?.includes('street_number')) {
        streetNumber = component.longText || component.shortText || '';
      } else if (component.types?.includes('route')) {
        route = component.longText || component.shortText || '';
      } else if (component.types?.includes('subpremise')) {
        subpremise = component.longText || component.shortText || '';
      }
    });

    // Build a robust street string: if route lacks suffix like Ave/Avenue, prefer formattedAddress first token
    const formattedFirst = (result.formattedAddress || '').split(',')[0]?.trim() || '';
    let parsedStreet = `${streetNumber} ${route}`.trim();
    if (!/^\d+\s/.test(parsedStreet) && /^\d+\s/.test(formattedFirst)) {
      parsedStreet = formattedFirst; // fallback keeps house number
    }

    const address = parsedStreet || formattedFirst;
    const unit = subpremise;

    return Response.json({
      address,
      unit,
      formatted_address: result.formattedAddress,
      latitude: result.location?.latitude,
      longitude: result.location?.longitude
    });

  } catch (error) {
    console.error('Error in googlePlaceDetails:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});