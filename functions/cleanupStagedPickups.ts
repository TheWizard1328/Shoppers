import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const { driverId, deliveryDate } = await req.json();
    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing driverId or deliveryDate' }, { status: 400 });
    }

    // Find staged pickups for this driver/date
    const pickups = await base44.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
      status: 'Staged'
    }, '-updated_date', 200);

    let deleted = 0;
    for (const p of pickups) {
      if (p.patient_id) continue; // Only pickups (no patient)
      const stopId = p.stop_id;
      if (!stopId) continue;

      // Check if any deliveries reference this pickup
      const children = await base44.entities.Delivery.filter({ puid: stopId }, '-updated_date', 5);
      const hasChildren = (children || []).some(d => d && d.patient_id);
      if (!hasChildren) {
        try {
          await base44.entities.Delivery.delete(p.id);
          deleted++;
        } catch (_) { /* ignore */ }
      }
    }

    return Response.json({ success: true, deleted });
  } catch (error) {
    return Response.json({ error: error.message || 'Cleanup failed' }, { status: 500 });
  }
});