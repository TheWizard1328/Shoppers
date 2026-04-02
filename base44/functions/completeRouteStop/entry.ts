import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

const getCurrentLocalTimeString = () => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
};

const getNextActiveDelivery = (routeDeliveries, completedDeliveryId) =>
  (routeDeliveries || [])
    .filter((item) =>
      item &&
      item.id !== completedDeliveryId &&
      !FINISHED_STATUSES.includes(item.status) &&
      item.status !== 'pending'
    )
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0] || null;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const {
      deliveryId,
      completionData = {}
    } = await req.json();

    if (!deliveryId) {
      return Response.json({ error: 'Missing required field: deliveryId' }, { status: 400 });
    }

    const targetDelivery = await base44.asServiceRole.entities.Delivery.get(deliveryId);
    if (!targetDelivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    const routeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: targetDelivery.driver_id,
      delivery_date: targetDelivery.delivery_date
    }, 'stop_order', 5000);

    const nextStop = getNextActiveDelivery(routeDeliveries, deliveryId);

    const updatePromises = (routeDeliveries || []).map((delivery) => {
      if (!delivery) return Promise.resolve(null);

      if (delivery.id === deliveryId) {
        return base44.asServiceRole.entities.Delivery.update(delivery.id, {
          ...completionData,
          status: 'completed',
          isNextDelivery: false
        });
      }

      const shouldBeNext = !!nextStop && delivery.id === nextStop.id;
      if (delivery.isNextDelivery !== shouldBeNext) {
        return base44.asServiceRole.entities.Delivery.update(delivery.id, {
          isNextDelivery: shouldBeNext
        });
      }

      return Promise.resolve(delivery);
    });

    await Promise.all(updatePromises);

    let etaUpdates = [];
    Promise.resolve().then(async () => {
      try {
        await base44.asServiceRole.functions.invoke('calculateRealTimeETA', {
          driverId: targetDelivery.driver_id,
          deliveryDate: targetDelivery.delivery_date,
          currentLocalTime: getCurrentLocalTimeString(),
          deviceTime: getCurrentLocalTimeString()
        });
      } catch (_) {}
    });

    const refreshedRouteDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: targetDelivery.driver_id,
      delivery_date: targetDelivery.delivery_date
    }, 'stop_order', 5000);

    return Response.json({
      success: true,
      driverId: targetDelivery.driver_id,
      deliveryDate: targetDelivery.delivery_date,
      completedDeliveryId: deliveryId,
      nextDeliveryId: nextStop?.id || null,
      routeDeliveries: refreshedRouteDeliveries,
      etaUpdates: etaUpdates.map((item) => ({
        deliveryId: item.deliveryId || item.delivery_id,
        newEta: item.eta || item.newETA
      })).filter((item) => item.deliveryId && item.newEta)
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});