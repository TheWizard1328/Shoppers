import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Format date to yyyy-MM-dd
const formatDate = (date) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { origin_lat, origin_lon, dest_lat, dest_lon, driver_id } = body;

    if (!origin_lat || !origin_lon || !dest_lat || !dest_lon) {
      return Response.json({ 
        error: 'Missing required parameters: origin_lat, origin_lon, dest_lat, dest_lon' 
      }, { status: 400 });
    }

    const googleApiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!googleApiKey) {
      return Response.json({ error: 'Google Maps API key not configured' }, { status: 500 });
    }

    const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
    url.searchParams.append('origin', `${origin_lat},${origin_lon}`);
    url.searchParams.append('destination', `${dest_lat},${dest_lon}`);
    url.searchParams.append('mode', 'driving');
    url.searchParams.append('key', googleApiKey);

    const response = await fetch(url.toString());
    const data = await response.json();

    if (data.status !== 'OK') {
      return Response.json({ 
        error: `Google Directions API error: ${data.status}`,
        details: data.error_message || 'Unknown error'
      }, { status: 500 });
    }

    if (!data.routes || data.routes.length === 0) {
      return Response.json({ error: 'No routes found' }, { status: 404 });
    }

    const route = data.routes[0];
    const leg = route.legs[0];

    const encodedPolyline = route.overview_polyline.points;
    const distanceKm = leg.distance.value / 1000;
    const durationSeconds = leg.duration.value;

    // Track API usage per driver per day (if driver_id provided)
    if (driver_id) {
      const today = formatDate(new Date());
      
      try {
        // Find existing entry for this driver and date
        const existingEntries = await base44.asServiceRole.entities.DriverRoutePolyline.filter({
          driver_id: driver_id,
          delivery_date: today
        });

        if (existingEntries && existingEntries.length > 0) {
          // Update existing entry
          const existing = existingEntries[0];
          await base44.asServiceRole.entities.DriverRoutePolyline.update(existing.id, {
            encoded_polyline: encodedPolyline,
            segment_origin_lat: origin_lat,
            segment_origin_lon: origin_lon,
            segment_dest_lat: dest_lat,
            segment_dest_lon: dest_lon,
            estimated_distance_km: distanceKm,
            estimated_duration_seconds: durationSeconds,
            daily_generation_count: (existing.daily_generation_count || 0) + 1,
            last_generated_at: new Date().toISOString()
          });
          console.log(`[getGoogleDirections] Updated DriverRoutePolyline for driver ${driver_id}, count: ${(existing.daily_generation_count || 0) + 1}`);
        } else {
          // Create new entry
          await base44.asServiceRole.entities.DriverRoutePolyline.create({
            driver_id: driver_id,
            delivery_date: today,
            encoded_polyline: encodedPolyline,
            segment_origin_lat: origin_lat,
            segment_origin_lon: origin_lon,
            segment_dest_lat: dest_lat,
            segment_dest_lon: dest_lon,
            estimated_distance_km: distanceKm,
            estimated_duration_seconds: durationSeconds,
            daily_generation_count: 1,
            last_generated_at: new Date().toISOString()
          });
          console.log(`[getGoogleDirections] Created DriverRoutePolyline for driver ${driver_id}, count: 1`);
        }
      } catch (trackingError) {
        // Don't fail the request if tracking fails, just log it
        console.error('[getGoogleDirections] Failed to track API usage:', trackingError.message);
      }
    }

    return Response.json({
      encoded_polyline: encodedPolyline,
      distance_km: distanceKm,
      duration_seconds: durationSeconds
    });

  } catch (error) {
    return Response.json({ 
      error: error.message,
      details: error.stack 
    }, { status: 500 });
  }
});