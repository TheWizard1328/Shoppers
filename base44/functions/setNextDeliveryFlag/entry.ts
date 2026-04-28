import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const getSortedActiveDeliveries = (deliveries) =>
  (deliveries || [])
    .filter((delivery) => delivery && !FINISHED_STATUSES.includes(delivery.status))
    .sort((a, b) => {
      const stopOrderDiff = (a.stop_order || 0) - (b.stop_order || 0);
      if (stopOrderDiff !== 0) return stopOrderDiff;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });

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

    const activeDeliveries = getSortedActiveDeliveries(routeDeliveries);

    let nextDelivery = null;
    if (targetDeliveryId) {
      nextDelivery = activeDeliveries.find((delivery) => delivery.id === targetDeliveryId) || null;
    }
    if (!nextDelivery) {
      nextDelivery = activeDeliveries[0] || null;
    }

    const deliveriesToUpdate = activeDeliveries
      .filter((delivery) => Boolean(delivery?.isNextDelivery) !== Boolean(nextDelivery && delivery.id === nextDelivery.id))
      .map((delivery) => ({
        id: delivery.id,
        isNextDelivery: !!nextDelivery && delivery.id === nextDelivery.id
      }));

    const updates = deliveriesToUpdate.map((delivery) =>
      base44.asServiceRole.entities.Delivery.update(delivery.id, {
        isNextDelivery: delivery.isNextDelivery
      }).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      })
    );

    if (updates.length > 0) {
      await Promise.all(updates);
    }

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      targetDeliveryId: targetDeliveryId || null,
      resolvedNextDeliveryId: nextDelivery?.id || null,
      updatedCount: updates.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});