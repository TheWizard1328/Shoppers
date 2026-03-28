import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { driverId, deliveryDate, targetDeliveryId } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required fields: driverId, deliveryDate' }, { status: 400 });
    }

    const routeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 5000);

    const activeDeliveries = (routeDeliveries || []).filter((delivery) =>
      delivery && !FINISHED_STATUSES.includes(delivery.status)
    );

    const updates = activeDeliveries
      .map((delivery) => {
        const shouldBeNext = !!targetDeliveryId && delivery.id === targetDeliveryId;
        if (delivery.isNextDelivery === shouldBeNext) return null;
        return base44.asServiceRole.entities.Delivery.update(delivery.id, {
          isNextDelivery: shouldBeNext
        }).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
      })
      .filter(Boolean);

    if (updates.length > 0) {
      await Promise.all(updates);
    }

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      targetDeliveryId: targetDeliveryId || null,
      updatedCount: updates.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});