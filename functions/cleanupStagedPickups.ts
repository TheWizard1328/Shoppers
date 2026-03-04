import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// Per-invocation caches to minimize repeated DB reads
const deliveriesByDriverDateCache = new Map();
const storeCache = new Map();

async function computePickupTrackingNumber(base44, pickup, deliveryDate, allForDay, storeCache) {
  // Get store abbreviation with cache
  let store = storeCache.get(pickup.store_id);
  if (!store) {
    const stores = await base44.entities.Store.filter({ id: pickup.store_id });
    store = stores?.[0] || null;
    storeCache.set(pickup.store_id, store);
  }
  const abbrev = store?.abbreviation || '';

  const slot = pickup.ampm_deliveries || 'AM';
  const sameSlotPickups = (allForDay || []).filter((d) => d && !d.patient_id && (d.ampm_deliveries || 'AM') === slot);

  sameSlotPickups.sort((a, b) => {
    const ta = new Date(a.created_date || 0).getTime();
    const tb = new Date(b.created_date || 0).getTime();
    return ta - tb;
  });

  const uniqueStores = [];
  for (const p of sameSlotPickups) {
    if (p.store_id && !uniqueStores.includes(p.store_id)) uniqueStores.push(p.store_id);
  }

  const storeIndex = Math.max(0, uniqueStores.indexOf(pickup.store_id));
  const baseNumber = storeIndex * 20;
  return `${abbrev}${baseNumber}`;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driverId = null, deliveryDate, maxToProcess = 80 } = body || {};
    const deadline = Date.now() + 4500;

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
    let processed = 0;

    for (const p of pickups) {
      if (processed >= maxToProcess || Date.now() > deadline) break;
      processed++;
      if (!p || p.patient_id) continue; // Only pickups (no patient)
      const stopId = p.stop_id;
      if (!stopId) continue;

      // Check if any deliveries reference this pickup (same date) using per-driver cache
      const cacheKey = `${p.driver_id}|${deliveryDate}`;
      if (!deliveriesByDriverDateCache.has(cacheKey)) {
        const allForDriverDay = await base44.entities.Delivery.filter({ driver_id: p.driver_id, delivery_date: deliveryDate }, '-created_date', 800);
        deliveriesByDriverDateCache.set(cacheKey, allForDriverDay || []);
      }
      const allForDay = deliveriesByDriverDateCache.get(cacheKey);
      const hasChildren = (allForDay || []).some((d) => d && d.puid === stopId && d.patient_id);

      if (!hasChildren) {
        // Delete unattached staged pickups (cancel flow)
        try {
          await base44.entities.Delivery.delete(p.id);
          deleted++;
        } catch (_) { /* ignore */ }
        continue;
      }

      // Ensure correct TR# base and set status to en_route (done flow)
      const correctTR = await computePickupTrackingNumber(base44, p, deliveryDate, allForDay, storeCache);
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

    return Response.json({ success: true, transitioned, trFixed, deleted, processed, remaining: Math.max(0, (pickups?.length || 0) - processed), limited: processed < (pickups?.length || 0) || Date.now() > deadline });
  } catch (error) {
    return Response.json({ error: error.message || 'Cleanup failed' }, { status: 500 });
  }
});