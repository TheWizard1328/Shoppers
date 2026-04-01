import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

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
    }, '-created_date', 5000);

    const deliveryIds = (deliveries || []).map((delivery) => delivery?.id).filter(Boolean);

    if (deliveryIds.length === 0) {
      return Response.json({ success: true, deleted: 0, ids: [] });
    }

    await Promise.all(
      deliveryIds.map((id) =>
        base44.asServiceRole.entities.Delivery.delete(id).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        })
      )
    );

    return Response.json({ success: true, deleted: deliveryIds.length, ids: deliveryIds });
  } catch (error) {
    return Response.json({ error: error.message || 'Failed to delete route' }, { status: 500 });
  }
});