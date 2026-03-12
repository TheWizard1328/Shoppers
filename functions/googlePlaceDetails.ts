import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
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

    try {
      const userAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
      const userAppUser = userAppUsers?.[0];
      await base44.asServiceRole.entities.GoogleAPILog.create({
        timestamp: new Date().toISOString(),
        api_type: 'Place Details',
        purpose: 'Fetching address details for place autocomplete',
        function_name: 'googlePlaceDetails',
        user_id: user.id,
        user_name: userAppUser?.user_name || user.full_name,
        metadata: {
          api_provider: 'google',
          call_count: 1,
          place_id
        }
      });
    } catch (logError) {
      console.warn('[googlePlaceDetails] Non-fatal log error:', logError?.message || logError);
    }

    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(place_id)}`;

    const response = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'addressComponents,formattedAddress,location'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Google Places API error:', errorText);
      return Response.json({ error: 'Places API error: ' + errorText }, { status: response.status });
    }

    const result = await response.json();
    const addressComponents = result.addressComponents || [];

    let streetNumber = '';
    let route = '';
    let subpremise = '';

    addressComponents.forEach((component) => {
      if (component.types?.includes('street_number')) {
        streetNumber = component.longText || component.shortText || '';
      } else if (component.types?.includes('route')) {
        route = component.longText || component.shortText || '';
      } else if (component.types?.includes('subpremise')) {
        subpremise = component.longText || component.shortText || '';
      }
    });

    const formattedFirst = (result.formattedAddress || '').split(',')[0]?.trim() || '';
    let parsedStreet = `${streetNumber} ${route}`.trim();
    if (!/^\d+\s/.test(parsedStreet) && /^\d+\s/.test(formattedFirst)) {
      parsedStreet = formattedFirst;
    }

    return Response.json({
      address: parsedStreet || formattedFirst,
      unit: subpremise || null,
      street_number: streetNumber || null,
      route: route || null,
      formatted_address: result.formattedAddress || '',
      latitude: result.location?.latitude ?? null,
      longitude: result.location?.longitude ?? null
    });
  } catch (error) {
    console.error('Error in googlePlaceDetails:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});