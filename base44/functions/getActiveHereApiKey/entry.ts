import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';
import { resolveFeatureSecretName } from '../../shared/apiKeyResolver.ts';

// Returns the active HERE/Google API key for a given feature.
// The feature is read from the request body (defaults to 'map_tiles' so the
// legacy tile-seeding path keeps working unchanged). The secret name is
// resolved via the shared per-feature resolver with a 5-min in-process cache.

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    let body: any = {};
    try { body = await req.json(); } catch (_) {}
    const feature = String(body?.feature || 'map_tiles');

    const secretName = await resolveFeatureSecretName(base44, feature);
    const apiKey = Deno.env.get(secretName);

    if (!apiKey) {
      return Response.json({ error: `Missing API key secret: ${secretName}` }, { status: 500 });
    }

    return Response.json({ secretName, apiKey, feature });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});