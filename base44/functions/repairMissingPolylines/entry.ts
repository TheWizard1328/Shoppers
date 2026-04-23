// Redeployed on 2026-04-09
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { driverId, deliveryDate } = body || {};

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'driverId and deliveryDate are required' }, { status: 400 });
    }

    const result = await base44.functions.invoke('purgeAndRegeneratePolylines', {
      driverId,
      deliveryDate,
      scope: 'active_only',
      reason: 'manual'
    });

    return Response.json(result?.data || result || { success: true });
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});