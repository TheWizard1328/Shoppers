import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const origin = body.origin || { lat: body.origin_lat, lon: body.origin_lon };
    const destination = body.destination || { lat: body.dest_lat, lon: body.dest_lon };

    if (!origin || !destination || origin.lat == null || origin.lon == null || destination.lat == null || destination.lon == null) {
      return Response.json({ 
        error: 'Missing required parameters: origin and destination' 
      }, { status: 400 });
    }

    const googleMapsKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
    if (!googleMapsKey) {
      return Response.json({ error: 'Google Maps API key not set' }, { status: 500 });
    }

    // Get user's AppUser record for user_name
    const userAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id });
    const userAppUser = userAppUsers?.[0];
    
    // Log API call
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Directions',
      purpose: 'Fetching route polyline for map display',
      function_name: 'getGoogleDirections',
      user_id: user.id,
      user_name: userAppUser?.user_name || user.id,
      metadata: {
        api_provider: 'google',
        call_count: 1,
        origin: `${origin.lat},${origin.lon}`,
        destination: `${destination.lat},${destination.lon}`
      }
    });

    const directionsUrl = `https://maps.googleapis.com/maps/api/directions/json?` +
      `origin=${origin.lat},${origin.lon}&` +
      `destination=${destination.lat},${destination.lon}&` +
      `key=${googleMapsKey}`;

    const directionsResponse = await fetch(directionsUrl);
    const directionsData = await directionsResponse.json();

    if (directionsData.status !== 'OK' || directionsData.routes.length === 0) {
      return Response.json({ 
        error: 'Failed to get directions',
        status: directionsData.status,
        details: directionsData.error_message 
      }, { status: 500 });
    }

    const polyline = directionsData.routes[0].overview_polyline.points;

    return Response.json({ encoded_polyline: polyline, polyline });
  } catch (error) {
    console.error('❌ Error fetching Google Directions:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});