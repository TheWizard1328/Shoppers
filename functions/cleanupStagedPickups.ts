import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

async function computePickupTrackingNumber(base44, pickup, deliveryDate) {
  // Get store for abbreviation
  const stores = await base44.entities.Store.filter({ id: pickup.store_id });
  const store = stores?.[0];
  const abbrev = store?.abbreviation || '';

  const slot = pickup.ampm_deliveries || 'AM';

  // Get ALL pickups for this driver/date/slot
  const allForDay = await base44.entities.Delivery.filter({
    driver_id: pickup.driver_id,
    delivery_date: deliveryDate
  }, '-created_date', 400);

  const sameSlotPickups = (allForDay || [])
    .filter((d) => d && !d.patient_id && (d.ampm_deliveries || 'AM') === slot);

  // Sort by created_date ASC so the earliest pickup gets base 0, next 20, etc.
  sameSlotPickups.sort((a, b) => {
    const ta = new Date(a.created_date || 0).getTime();
    const tb = new Date(b.created_date || 0).getTime();
    return ta - tb;
  });

  // Unique stores order (first occurrence determines the 20× index)
  const uniqueStores = [];
  for (const p of sameSlotPickups) {
    if (!uniqueStores.includes(p.store_id)) uniqueStores.push(p.store_id);
  }

  const storeIndex = Math.max(0, uniqueStores.indexOf(pickup.store_id));
  const baseNumber = storeIndex * 20; // 0, 20, 40, ...

  return `${abbrev}${baseNumber}`;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driverId = null, deliveryDate } = body || {};

    if (!deliveryDate) {
      return Response.json({ error: 'Missing deliveryDate' }, { status: 400 });
    }

    // Find staged pickups for this date (optionally filter by driver)
    const filter = { delivery_date: deliveryDate, status: 'Staged' };
    if (driverId) filter['driver_id'] = driverId;

    const pickups = await base44.entities.Delivery.filter(filter, '-updated_date', 400);

    let deleted = 0;
    let transitioned = 0;
    let trFixed = 0;

    for (const p of pickups) {
      if (!p || p.patient_id) continue; // Only pickups (no patient)
      const stopId = p.stop_id;
      if (!stopId) continue;

      // Check if any deliveries reference this pickup (same date)
      const children = await base44.entities.Delivery.filter({ puid: stopId, delivery_date: deliveryDate }, '-updated_date', 200);
      const hasChildren = (children || []).some((d) => d && d.patient_id);

      if (!hasChildren) {
        // Delete unattached staged pickups (cancel flow)
        try {
          await base44.entities.Delivery.delete(p.id);
          deleted++;
        } catch (_) { /* ignore */ }
        continue;
      }

      // Ensure correct TR# base and set status to en_route (done flow)
      const correctTR = await computePickupTrackingNumber(base44, p, deliveryDate);
      const needsTrUpdate = !p.tracking_number || String(p.tracking_number) !== String(correctTR);

      const updatePayload = { status: 'en_route' };
      if (needsTrUpdate) {
        updatePayload['tracking_number'] = correctTR;
      }

      try {
        await base44.entities.Delivery.update(p.id, updatePayload);
        transitioned++;
        if (needsTrUpdate) trFixed++;
      } catch (_) { /* ignore */ }
    }

    return Response.json({ success: true, transitioned, trFixed, deleted });
  } catch (error) {
    return Response.json({ error: error.message || 'Cleanup failed' }, { status: 500 });
  }
});