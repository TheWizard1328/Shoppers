import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');

    if (!apiKey) {
      return Response.json({ error: 'API key not configured' }, { status: 500 });
    }

    return Response.json({ apiKey });

  } catch (error) {
    console.error('Error retrieving Google Maps API key:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});