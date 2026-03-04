import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

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
        const data = await response.json();

        if (data.routes && data.routes.length > 0 && data.routes[0].sections && data.routes[0].sections.length > 0) {
            const polyline = data.routes[0].sections[0].polyline;
            return Response.json({ polyline });
        } else {
            return Response.json({ error: 'No route found' }, { status: 404 });
        }
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
});