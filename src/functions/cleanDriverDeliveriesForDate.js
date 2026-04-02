/* global Deno */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const OUTRAGEOUS_DRIVER_DAY_DELIVERY_COUNT = 100;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const { driverId, deliveryDate, threshold = OUTRAGEOUS_DRIVER_DAY_DELIVERY_COUNT } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'driverId and deliveryDate are required' }, { status: 400 });
    }

    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, '-created_date', 2000);

    if ((deliveries?.length || 0) <= threshold) {
      return Response.json({ success: true, cleaned: 0, total: deliveries?.length || 0 });
    }

    const groups = new Map();

    (deliveries || []).forEach((delivery) => {
      const sid = delivery?.stop_id?.toString?.().trim?.() || '';
      const date = delivery?.delivery_date?.trim?.() || '';
      if (!sid || !date) return;
      const key = `${sid}|${date}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(delivery);
    });

    const idsToDelete = [];

    groups.forEach((group) => {
      if (group.length <= 1) return;
      const sorted = [...group].sort((a, b) => new Date(a.created_date || 0) - new Date(b.created_date || 0));
      sorted.slice(1).forEach((delivery) => idsToDelete.push(delivery.id));
    });

    await Promise.all(
      idsToDelete.map((id) => base44.asServiceRole.entities.Delivery.delete(id))
    );

    return Response.json({
      success: true,
      cleaned: idsToDelete.length,
      total: deliveries.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});