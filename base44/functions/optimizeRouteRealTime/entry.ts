import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return Response.json({
      success: true,
      skipped: true,
      reason: 'deprecated_optimizer',
      message: 'optimizeRemainingStops is the sole route optimizer. Use calculateRealTimeETA for lightweight ETA updates and purgeAndRegeneratePolylines for standalone polyline regeneration.'
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});