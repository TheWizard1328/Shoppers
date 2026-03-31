import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

function parseTrackingNumber(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/\d+/);
  if (!match) return null;
  const parsed = parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

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
      return Response.json({ success: true, updated: 0 });
    }

    const storeIds = [...new Set(deliveries.map((delivery) => delivery?.store_id).filter(Boolean))];
    const stores = storeIds.length > 0
      ? await base44.asServiceRole.entities.Store.filter({ id: { $in: storeIds } }, undefined, 50000)
      : [];
    const storeMap = new Map((stores || []).map((store) => [store.id, store]));

    const pickups = deliveries
      .filter((delivery) => delivery && !delivery.patient_id && delivery.stop_id)
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    const updates = [];
    const pickupBaseMap = new Map();
    const usedPickupBases = new Set(
      pickups
        .map((pickup) => parseTrackingNumber(pickup.tracking_number))
        .filter((value) => value !== null)
    );

    const assignNextPickupBase = (store) => {
      const storeBase = Number(store?.base_tracking_number || 0);
      let candidate = storeBase > 0 ? storeBase : 20;
      while (usedPickupBases.has(candidate)) {
        candidate += 20;
      }
      usedPickupBases.add(candidate);
      return candidate;
    };

    for (const pickup of pickups) {
      let pickupBase = parseTrackingNumber(pickup.tracking_number);
      if (pickupBase === null) {
        pickupBase = assignNextPickupBase(storeMap.get(pickup.store_id));
        updates.push({ id: pickup.id, tracking_number: String(pickupBase) });
      }
      pickupBaseMap.set(pickup.stop_id, pickupBase);
    }

    for (const pickup of pickups) {
      const pickupBase = pickupBaseMap.get(pickup.stop_id);
      if (pickupBase === null || pickupBase === undefined) continue;

      const linkedDeliveries = deliveries
        .filter((delivery) => delivery && delivery.patient_id && delivery.puid === pickup.stop_id)
        .sort((a, b) => {
          const stopDelta = (a.stop_order || 999999) - (b.stop_order || 999999);
          if (stopDelta !== 0) return stopDelta;
          const etaA = String(a.delivery_time_eta || a.delivery_time_start || '99:99');
          const etaB = String(b.delivery_time_eta || b.delivery_time_start || '99:99');
          if (etaA !== etaB) return etaA.localeCompare(etaB);
          return String(a.patient_name || '').localeCompare(String(b.patient_name || ''));
        });

      const reservedTrackingNumbers = new Set([
        pickupBase,
        ...linkedDeliveries
          .filter((delivery) => FINISHED_STATUSES.includes(delivery.status))
          .map((delivery) => parseTrackingNumber(delivery.tracking_number))
          .filter((value) => value !== null)
      ]);

      const activeLinkedDeliveries = linkedDeliveries.filter(
        (delivery) => !FINISHED_STATUSES.includes(delivery.status)
      );

      let nextTrackingNumber = pickupBase + 1;

      activeLinkedDeliveries.forEach((delivery) => {
        while (reservedTrackingNumbers.has(nextTrackingNumber)) {
          nextTrackingNumber += 1;
        }

        const expectedTrackingNumber = String(nextTrackingNumber);
        if (delivery.tracking_number !== expectedTrackingNumber) {
          updates.push({ id: delivery.id, tracking_number: expectedTrackingNumber });
        }

        nextTrackingNumber += 1;
      });
    }

    if (updates.length > 0) {
      await Promise.all(
        updates.map((update) =>
          base44.asServiceRole.entities.Delivery.update(update.id, { tracking_number: update.tracking_number }).catch((error) => {
            if (isNotFoundError(error)) return null;
            throw error;
          })
        )
      );
    }

    return Response.json({ success: true, updated: updates.length, updates });
  } catch (error) {
    console.error('[recalculateTrackingNumbers] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});