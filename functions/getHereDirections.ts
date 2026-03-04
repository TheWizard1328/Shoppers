import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { decode } from 'npm:here-flexible-polyline@2.0.0';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { origin, destination } = await req.json();

        if (!origin || !destination) {
            return Response.json({ error: 'Missing origin or destination' }, { status: 400 });
        }

        const apiKey = Deno.env.get("HERE_API_KEY");
        if (!apiKey) {
            return Response.json({ error: 'HERE_API_KEY secret is not set' }, { status: 500 });
        }

        const url = `https://router.hereapi.com/v8/routes?transportMode=car&origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&return=polyline&apikey=${apiKey}`;

        const response = await fetch(url);
        if (!response.ok) {
            const text = await response.text();
            return Response.json({ error: 'HERE routing error', status: response.status, details: text?.slice(0, 500) }, { status: 502 });
        }
        const data = await response.json();

        const sections = data?.routes?.[0]?.sections || [];
        if (sections.length === 0) {
            return Response.json({ error: 'No route found' }, { status: 404 });
        }

        // Concatenate all section polylines and normalize output shape
        const allCoords = [];
        for (const sec of sections) {
            const poly = sec?.polyline;
            if (!poly) continue;
            const decoded = decode(poly);

            let pts = [];
            if (Array.isArray(decoded?.polyline?.[0])) {
                // [[lat, lng, z?], ...]
                pts = decoded.polyline.map(p => ({ lat: p[0], lng: p[1] }));
            } else if (decoded?.polyline?.length) {
                // [{lat, lng} | {latitude, longitude}, ...]
                pts = decoded.polyline.map(p => ({ lat: p.lat ?? p.latitude, lng: p.lng ?? p.longitude }));
            }

            if (pts.length) {
                // Avoid duplicating the connecting point between sections
                if (
                    allCoords.length &&
                    allCoords[allCoords.length - 1].lat === pts[0].lat &&
                    allCoords[allCoords.length - 1].lng === pts[0].lng
                ) {
                    pts = pts.slice(1);
                }
                allCoords.push(...pts);
            }
        }

        if (allCoords.length < 2) {
            return Response.json({ error: 'Failed to decode polyline' }, { status: 500 });
        }

        return Response.json({ coordinates: allCoords });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});