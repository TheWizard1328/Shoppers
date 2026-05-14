import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

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

    // Fetch all deliveries for this driver/date and build orderedDeliveryIds sorted by stop_order
    const deliveries = await base44.asServiceRole.entities.Delivery.filter(
      { driver_id: driverId, delivery_date: deliveryDate },
      'stop_order',
      50000
    );

    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      return Response.json({ error: 'No deliveries found for this driver and date' }, { status: 404 });
    }

    const orderedDeliveryIds = deliveries
      .filter(d => d?.id)
      .sort((a, b) => Number(a.stop_order || 0) - Number(b.stop_order || 0))
      .map(d => d.id);

    const result = await base44.functions.invoke('purgeAndRegeneratePolylines', {
      driverId,
      deliveryDate,
      orderedDeliveryIds
    });

    return Response.json(result?.data || result || { success: true });
  } catch (error) {
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});