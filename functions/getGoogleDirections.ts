import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { origin, destination } = await req.json();

    if (!origin || !destination) {
      return Response.json({ 
        error: 'Missing required parameters: origin and destination' 
      }, { status: 400 });
    }

    const googleMapsKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
    if (!googleMapsKey) {
      return Response.json({ error: 'Google Maps API key not set' }, { status: 500 });
    }

    // Log API call
    await base44.asServiceRole.entities.GoogleAPILog.create({
      timestamp: new Date().toISOString(),
      api_type: 'Directions',
      purpose: 'Fetching route polyline for map display',
      function_name: 'getGoogleDirections',
      user_id: user.id,
      user_name: user.full_name,
      metadata: {
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

    return Response.json({ polyline });
  } catch (error) {
    console.error('❌ Error fetching Google Directions:', error);
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});