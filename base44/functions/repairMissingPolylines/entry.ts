// Redeployed on 2026-03-28
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

    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);

    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      return Response.json({ success: true, skipped: true, reason: 'no_deliveries' });
    }

    return Response.json({ success: true, skipped: false, message: 'Use purgeAndRegeneratePolylines directly for regeneration.' });
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});