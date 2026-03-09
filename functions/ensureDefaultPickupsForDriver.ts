import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const ACTIVE_DELIVERY_STATUSES = new Set(['pending', 'in_transit', 'en_route']);
const PICKUP_STATUSES = new Set(['pending', 'in_transit', 'en_route', 'completed']);

function getPrimarySlot(delivery) {
  if (delivery?.ampm_deliveries === 'AM' || delivery?.ampm_deliveries === 'PM') {
    return delivery.ampm_deliveries;
  }

  const timeValue = delivery?.delivery_time_start || delivery?.delivery_time_end || '';
  const hour = Number.parseInt(String(timeValue).split(':')[0], 10);
  if (Number.isFinite(hour)) {
    return hour >= 15 ? 'PM' : 'AM';
  }

  return 'AM';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();

    if (payload?.event?.type !== 'create' || payload?.event?.entity_name !== 'Delivery') {
      return Response.json({ skipped: true, reason: 'Not a Delivery create event' });
    }

    const delivery = payload?.payload_too_large
      ? await base44.asServiceRole.entities.Delivery.get(payload.event.entity_id)
      : payload?.data;

    if (!delivery?.driver_id || !delivery?.delivery_date || !delivery?.store_id) {
      return Response.json({ skipped: true, reason: 'Missing driver/date/store' });
    }

    if (!delivery?.patient_id) {
      return Response.json({ skipped: true, reason: 'Pickup record already' });
    }

    if (!ACTIVE_DELIVERY_STATUSES.has(delivery.status)) {
      return Response.json({ skipped: true, reason: `Status ${delivery.status} does not need pickup ensure` });
    }

    const primarySlot = getPrimarySlot(delivery);

    const sameStoreDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: delivery.driver_id,
      delivery_date: delivery.delivery_date,
      store_id: delivery.store_id,
    }, '-created_date', 100);

    const existingPickup = (sameStoreDeliveries || []).find((item) => {
      const itemSlot = getPrimarySlot(item);
      return !item?.patient_id && itemSlot === primarySlot && PICKUP_STATUSES.has(item?.status);
    });

    if (existingPickup) {
      return Response.json({
        skipped: true,
        reason: 'Pickup already exists for this store/date/slot',
        pickup_id: existingPickup.id,
      });
    }

    const ensureResponse = await base44.asServiceRole.functions.invoke('ensurePickupForDelivery', {
      storeId: delivery.store_id,
      deliveryDate: delivery.delivery_date,
      driverId: delivery.driver_id,
      primarySlot,
    });

    return Response.json({
      success: true,
      scoped_to_store: delivery.store_id,
      delivery_id: delivery.id,
      primarySlot,
      ensureResponse: ensureResponse?.data ?? null,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});