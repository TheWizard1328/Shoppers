import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Auth
    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse body
    const bodyText = await req.text();
    let body = {};
    try { if (bodyText) body = JSON.parse(bodyText); } catch (_) {}

    const { driverId, deliveryDate, targetDeliveryId } = body || {};
    if (!driverId || !deliveryDate || !targetDeliveryId) {
      return Response.json({ error: 'Missing required fields: driverId, deliveryDate, targetDeliveryId' }, { status: 400 });
    }

    // Permission: allow platform admin or the driver themselves
    if (user.role !== 'admin' && user.id !== driverId) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Fetch all deliveries for the SAME DATE and DRIVER
    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, '', 50000);

    // Clear any other isNextDelivery flags
    const toClear = deliveries.filter(d => d && d.id !== targetDeliveryId && d.isNextDelivery === true);
    if (toClear.length > 0) {
      await Promise.all(toClear.map(d => base44.asServiceRole.entities.Delivery.update(d.id, { isNextDelivery: false })));
    }

    // Ensure target is set to true
    await base44.asServiceRole.entities.Delivery.update(targetDeliveryId, { isNextDelivery: true });

    // Safety check: verify only one true remains
    const after = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, '', 50000);

    const conflicts = after.filter(d => d && d.isNextDelivery === true && d.id !== targetDeliveryId);
    if (conflicts.length > 0) {
      await Promise.all(conflicts.map(d => base44.asServiceRole.entities.Delivery.update(d.id, { isNextDelivery: false })));
    }

    const totalTrue = (await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, '', 50000)).filter(d => d && d.isNextDelivery === true).length;

    return Response.json({
      success: true,
      cleared: toClear.length + conflicts.length,
      ensuredTarget: true,
      totalTrue
    });
  } catch (error) {
    console.error('setNextDeliveryFlag error:', error);
    return Response.json({ error: error.message || 'Internal error' }, { status: 500 });
  }
});