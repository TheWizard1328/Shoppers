// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

async function computePickupTrackingNumber(base44, pickup, deliveryDate) {
  const slot = pickup.ampm_deliveries || 'AM';
  // Store abbreviation cache
  let abbrev = __storeAbbrevCache.get(pickup.store_id);
  if (!abbrev) {
    const stores = await base44.entities.Store.filter({ id: pickup.store_id });
    const store = stores?.[0];
    abbrev = store?.abbreviation || '';
    __storeAbbrevCache.set(pickup.store_id, abbrev);
  }
  // Per-day deliveries cache
  let allForDay = __deliveriesByDateCache.get(deliveryDate);
  if (!allForDay) {
    allForDay = await base44.entities.Delivery.filter({ delivery_date: deliveryDate }, '-created_date', 400);
    __deliveriesByDateCache.set(deliveryDate, allForDay || []);
  }
  const sameSlotPickups = (allForDay || []).filter(d => d && !d.patient_id && (d.ampm_deliveries || 'AM') === slot);
  sameSlotPickups.sort((a,b) => new Date(a.created_date||0).getTime() - new Date(b.created_date||0).getTime());
  const uniqueStores = [];
  for (const p of sameSlotPickups) { if (!uniqueStores.includes(p.store_id)) uniqueStores.push(p.store_id); }
  const storeIndex = Math.max(0, uniqueStores.indexOf(pickup.store_id));
  const baseNumber = storeIndex * 20;
  return `${abbrev}${baseNumber}`;
}

// Caches to reduce API calls per invocation
const __storeAbbrevCache = new Map();
const __deliveriesByDateCache = new Map();
const __cleanupInFlight = new Map();

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driverId = null, deliveryDate, maxToProcess = 100, timeBudgetMs = 4000 } = body || {};

    if (!deliveryDate) {
      return Response.json({ error: 'Missing deliveryDate' }, { status: 400 });
    }

    // Debounce per date/driver for 3s
    try {
      const key = `${deliveryDate}|${driverId || 'all'}`;
      const last = __cleanupInFlight.get(key);
      const nowTs = Date.now();
      if (last && (nowTs - last) < 3000) {
        return Response.json({ success: true, transitioned: 0, trFixed: 0, deleted: 0, debounced: true });
      }
      __cleanupInFlight.set(key, nowTs);
      setTimeout(() => { try { __cleanupInFlight.delete(key); } catch (_) {} }, 3200);
    } catch (_) {}

    // Find staged pickups for this date (optionally filter by driver)
    const filter = { delivery_date: deliveryDate, status: 'Staged' };
    if (driverId) filter['driver_id'] = driverId;

    const limit = Math.max(1, Math.min(Number(maxToProcess) || 100, 200));
    const pickups = await base44.entities.Delivery.filter(filter, '-updated_date', limit);

    let deleted = 0;
    let transitioned = 0;
    let trFixed = 0;

    const startTs = Date.now();
    const maxN = Math.max(1, Math.min(Number(maxToProcess) || 100, pickups.length));
    const toProcess = pickups.slice(0, maxN);

    for (const p of toProcess) { if ((Date.now() - startTs) > (Number(timeBudgetMs) || 4000)) break;
      if (!p || p.patient_id) continue; // Only pickups (no patient)
      const stopId = p.stop_id;
      if (!stopId) continue;

      // Check if any deliveries reference this pickup (same date)
      const children = await base44.entities.Delivery.filter({ puid: stopId, delivery_date: deliveryDate }, '-updated_date', 80);
      const hasChildren = (children || []).some((d) => d && d.patient_id);

      if (!hasChildren) {
        // Delete unattached staged pickups (cancel flow)
        try {
          await base44.entities.Delivery.delete(p.id).catch((error) => {
            if (isNotFoundError(error)) return null;
            throw error;
          });
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
        const updatedPickup = await base44.entities.Delivery.update(p.id, updatePayload).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
        if (!updatedPickup) continue;
        transitioned++;
        if (needsTrUpdate) trFixed++;
      } catch (_) { /* ignore */ }
    }

    return Response.json({ success: true, transitioned, trFixed, deleted });
  } catch (error) {
    return Response.json({ error: error.message || 'Cleanup failed' }, { status: 500 });
  }
});