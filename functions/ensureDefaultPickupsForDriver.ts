import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

// Determine enabled slots and assigned driver for a specific date
function getAssignedSlotsForStoreOnDate(store, driverId, dateStr) {
  const d = new Date(dateStr.replace(/-/g, '/'));
  const dow = d.getDay(); // 0=Sun..6=Sat
  const slots = [];

  if (dow >= 1 && dow <= 5) {
    if (store?.weekday_am_enabled && store?.weekday_am_driver_id === driverId) slots.push('AM');
    if (store?.weekday_pm_enabled && store?.weekday_pm_driver_id === driverId) slots.push('PM');
  } else if (dow === 6) {
    if (store?.saturday_am_enabled && store?.saturday_am_driver_id === driverId) slots.push('AM');
    if (store?.saturday_pm_enabled && store?.saturday_pm_driver_id === driverId) slots.push('PM');
  } else {
    if (store?.sunday_am_enabled && store?.sunday_am_driver_id === driverId) slots.push('AM');
    if (store?.sunday_pm_enabled && store?.sunday_pm_driver_id === driverId) slots.push('PM');
  }

  return slots;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Read payload (supports both direct invocation and automation event payload)
    const body = await req.json().catch(() => ({}));

    // Detect if called by automation (entity event)
    const isAutomation = !!body?.event && !!body?.event?.entity_name;

    let driverId = body?.driverId || null;
    let deliveryDate = body?.deliveryDate || null;

    if (isAutomation) {
      const created = body?.data || null;
      driverId = driverId || created?.driver_id || null;
      deliveryDate = deliveryDate || created?.delivery_date || null;
    }

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing driverId or deliveryDate' }, { status: 400 });
    }

    // Prefer user-scoped if available; otherwise, use service role (automations run server-side)
    let api = base44;
    try {
      const user = await base44.auth.me();
      if (!user) api = base44.asServiceRole;
    } catch {
      api = base44.asServiceRole;
    }

    // Fetch stores (active preferred)
    const stores = await api.entities.Store.filter({}, '-updated_date', 1000);

    // Build list of (storeId, slot) where this driver is assigned for the date
    const targets = [];
    for (const store of stores) {
      if (!store || store.status === 'inactive') continue;
      const slots = getAssignedSlotsForStoreOnDate(store, driverId, deliveryDate);
      for (const slot of slots) {
        targets.push({ storeId: store.id, slot });
      }
    }

    if (targets.length === 0) {
      return Response.json({ ensured: 0, message: 'No default pickups required for this driver/date' });
    }

    // Ensure a pickup exists for each assigned (store, slot)
    const results = await Promise.all(
      targets.map(({ storeId, slot }) =>
        api.functions.invoke('ensurePickupForDelivery', {
          storeId,
          deliveryDate,
          driverId,
          ampmDeliveries: slot,
        }).then(r => r?.data || r).catch((e) => ({ error: String(e) }))
      )
    );

    const createdOrFound = results.filter(r => r && (r.pickupId || r.puid || r.skipAutoCreate)).length;

    return Response.json({ ensured: createdOrFound, details: results });
  } catch (error) {
    return Response.json({ error: error.message || 'Failed to ensure default pickups' }, { status: 500 });
  }
});