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
        console.info('[HERE] getHereDirections input', { origin, destination });

        if (!origin || !destination) {
            return Response.json({ error: 'Missing origin or destination' }, { status: 400 });
        }

        const apiKey = Deno.env.get("HERE_API_KEY");
        if (!apiKey) {
            return Response.json({ error: 'HERE_API_KEY secret is not set' }, { status: 500 });
        }

        const url = `https://router.hereapi.com/v8/routes?alternatives=0&transportMode=car&origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&return=polyline&apikey=${apiKey}`;

        const controller = new AbortController();
        const to = setTimeout(() => controller.abort('timeout'), 8000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(to);
        if (!response.ok) {
            const text = await response.text();
            console.error('[HERE] routing error', { status: response.status, details: text?.slice(0, 500) });
            return Response.json({ error: 'HERE routing error', status: response.status, details: text?.slice(0, 500) }, { status: 502 });
        }
        const data = await response.json();

        const sections = data?.routes?.[0]?.sections || [];
        if (sections.length === 0) {
            console.warn('[HERE] no route found');
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
            console.error('[HERE] decode failed or too few points', { points: allCoords.length });
            return Response.json({ error: 'Failed to decode polyline' }, { status: 500 });
        }

        console.info('[HERE] route OK', { points: allCoords.length, sections: sections.length });
        const totalDistanceMeters = sections.reduce((sum, s) => sum + (s.summary?.distance || 0), 0);
        const totalDurationSeconds = sections.reduce((sum, s) => sum + (s.summary?.duration || 0), 0);
        const estimated_distance_km = Math.round((totalDistanceMeters / 1000) * 10) / 10;
        const estimated_duration_minutes = Math.round(totalDurationSeconds / 60);
        return Response.json({ coordinates: allCoords, estimated_distance_km, estimated_duration_minutes });
    } catch (error) {
        console.error('[HERE] unexpected error', error?.message || error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});