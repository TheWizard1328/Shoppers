import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const body = await req.json();

        const GOOGLE_MAPS_API_KEY = Deno.env.get("GOOGLE_MAPS_API_KEY");
        if (!GOOGLE_MAPS_API_KEY) {
            return Response.json({ error: 'Google Maps API Key not configured' }, { status: 500 });
        }

        // Build origin/destination strings — accept either lat/lng coords or address strings
        let origins, destinations;

        if (body.originLat && body.originLng && body.destLat && body.destLng) {
            origins = `${body.originLat},${body.originLng}`;
            destinations = `${body.destLat},${body.destLng}`;
        } else if (body.origin && body.destination) {
            origins = body.origin;
            destinations = body.destination;
        } else {
            return Response.json({ error: 'Provide either originLat/originLng/destLat/destLng or origin/destination address strings' }, { status: 400 });
        }

        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&origins=${encodeURIComponent(origins)}&destinations=${encodeURIComponent(destinations)}&key=${GOOGLE_MAPS_API_KEY}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.status !== 'OK') {
            console.error('Google Distance Matrix API error:', data.status, data.error_message);
            return Response.json({ error: `Google Distance Matrix API error: ${data.status}` }, { status: 500 });
        }

        const element = data.rows?.[0]?.elements?.[0];
        if (!element || element.status !== 'OK') {
            console.error('Google Distance Matrix element error:', element?.status);
            return Response.json({ error: `Distance Matrix element error: ${element?.status}` }, { status: 500 });
        }

        const distanceKm = parseFloat((element.distance.value / 1000).toFixed(2));
        const durationText = element.duration?.text || null;

        // Log the API call
        await base44.entities.GoogleAPILog.create({
            timestamp: new Date().toISOString(),
            api_type: 'Distance Matrix',
            purpose: 'calculating driving distance',
            function_name: 'getGoogleDrivingDistance',
            metadata: { origins, destinations, distance_km: distanceKm }
        }).catch(() => {});

        return Response.json({ distance_km: distanceKm, duration_text: durationText, source: 'Google Distance Matrix' });

    } catch (error) {
        console.error('Error in getGoogleDrivingDistance:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});