import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import { decode } from 'npm:@here/flexible-polyline@2.1.0';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { origin, destination } = body || {};
    if (!origin || !destination) {
      return Response.json({ error: 'Missing origin or destination' }, { status: 400 });
    }

    const apiKey = Deno.env.get('HERE_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'HERE_API_KEY secret is not set' }, { status: 500 });
    }

    const url = `https://router.hereapi.com/v8/routes?alternatives=0&transportMode=car&origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&return=polyline,summary&apikey=${apiKey}`;

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort('timeout'), 8000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(to);

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[HERE] routing error', { status: resp.status, details: text?.slice(0, 500) });
      return Response.json({ error: 'HERE routing error', status: resp.status, details: text?.slice(0, 500) }, { status: 502 });
    }

    const data = await resp.json();
    const sections = data?.routes?.[0]?.sections || [];
    if (!sections.length) {
      return Response.json({ error: 'No route found' }, { status: 404 });
    }

    const coordinates = [];
    for (const sec of sections) {
      const poly = sec?.polyline;
      if (!poly) continue;
      const decoded = decode(poly);
      let pts = [];
      if (Array.isArray(decoded?.polyline?.[0])) {
        pts = decoded.polyline.map((p) => ({ lat: p[0], lng: p[1] }));
      } else if (decoded?.polyline?.length) {
        pts = decoded.polyline.map((p) => ({ lat: p.lat ?? p.latitude, lng: p.lng ?? p.longitude }));
      }
      if (pts.length) {
        if (coordinates.length) {
          const a = coordinates[coordinates.length - 1];
          const b = pts[0];
          if (a.lat === b.lat && a.lng === b.lng) {
            pts = pts.slice(1);
          }
        }
        coordinates.push(...pts);
      }
    }

    if (coordinates.length < 2) {
      return Response.json({ error: 'Failed to decode polyline' }, { status: 500 });
    }

    const totalDistanceMeters = sections.reduce((sum, s) => sum + (s.summary?.length || 0), 0);
    const totalDurationSeconds = sections.reduce((sum, s) => sum + (s.summary?.duration || 0), 0);
    const estimated_distance_km = Math.round((totalDistanceMeters / 1000) * 10) / 10;
    const estimated_duration_minutes = Math.round(totalDurationSeconds / 60);

    return Response.json({ coordinates, estimated_distance_km, estimated_duration_minutes });
  } catch (err) {
    console.error('[HERE] unexpected error', err?.message || err);
    return Response.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
});