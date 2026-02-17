import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Verify user is authenticated
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { input, latitude, longitude } = body;
    
    if (!input || input.trim().length < 3) {
      return Response.json({ predictions: [] });
    }

    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }

    // Use the NEW Google Places API
    const url = 'https://places.googleapis.com/v1/places:autocomplete';
    
    // Build request body for new API
    const requestBody = {
      input: input,
      languageCode: 'en',
      includedRegionCodes: ['CA']
    };

    // Add location bias for better results (50km max allowed by API)
    if (latitude && longitude) {
      requestBody.locationBias = {
        circle: {
          center: {
            latitude: latitude,
            longitude: longitude
          },
          radius: 75000 // 75km radius (API maximum)
        }
      };
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

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey
      },
      body: JSON.stringify(requestBody)
    });
    
    const data = await response.json();

    // New API returns suggestions array instead of predictions
    if (!response.ok) {
      const errorMsg = data.error?.message || 'Places API error';
      return Response.json({ 
        error: errorMsg,
        details: data 
      }, { status: 500 });
    }

    // Convert new API format and fetch driving distances via Directions API
    const predictions = (await Promise.all(
      (data.suggestions || []).map(async suggestion => {
        const placePrediction = suggestion.placePrediction;
        if (!placePrediction) return null;

        const description = placePrediction.text?.text || '';
        const place_id = placePrediction.placeId || '';
        let distance = null;

        // Fetch place details to get coordinates for Directions API
        if (latitude && longitude) {
          try {
            const detailsUrl = `https://places.googleapis.com/v1/places/${place_id}`;
            const detailsResponse = await fetch(detailsUrl, {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'location'
              }
            });

            if (detailsResponse.ok) {
              const detailsData = await detailsResponse.json();
              const placeLocation = detailsData.location;
              
              if (placeLocation?.latitude && placeLocation?.longitude) {
                // Use Directions API for actual driving distance
                const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?origin=${latitude},${longitude}&destination=${placeLocation.latitude},${placeLocation.longitude}&key=${apiKey}`;
                const directionsResponse = await fetch(directionsUrl);
                
                if (directionsResponse.ok) {
                  const directionsData = await directionsResponse.json();
                  if (directionsData.routes?.[0]?.legs?.[0]?.distance?.value) {
                    distance = directionsData.routes[0].legs[0].distance.value / 1000; // Convert meters to km
                  }
                }
              }
            }
          } catch (error) {
            // Silently fail distance calculation
          }
        }

        return {
          description,
          place_id,
          distance
        };
      })
    )).filter(p => p !== null);

    // Sort by distance (closest first)
    predictions.sort((a, b) => {
      // Predictions without distance go to the end
      if (a.distance === null && b.distance === null) return 0;
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });

    // Results should already be within 75km radius due to locationRestriction
    return Response.json({ predictions });

  } catch (error) {
    console.error('[googlePlacesAutocomplete] Error:', error.message);
    return Response.json({ 
      error: error.message
    }, { status: 500 });
  }
});