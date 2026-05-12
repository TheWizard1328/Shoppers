import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const formatMinutesToTime = (minutes) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const parseTimeToMinutes = (timeStr) => {
  if (!timeStr || typeof timeStr !== 'string') return Infinity;
  const parts = timeStr.split(':');
  if (parts.length < 2) return Infinity;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return Infinity;
  return h * 60 + m;
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { driverId, deliveryDate, completionTime } = body;

    if (!driverId || !deliveryDate || !completionTime) {
      return Response.json({
        error: 'Missing required parameters: driverId, deliveryDate, completionTime'
      }, { status: 400 });
    }

    // Parse completion time
    const completionMinutes = parseTimeToMinutes(completionTime);
    if (!Number.isFinite(completionMinutes)) {
      return Response.json({
        error: 'Invalid completionTime format. Expected HH:mm'
      }, { status: 400 });
    }

    const allDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order');

    if (!allDeliveries || allDeliveries.length === 0) {
      return Response.json({ message: 'No deliveries found', updated: [] });
    }

    // Find active/pending deliveries (not completed/failed/cancelled/returned)
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const remainingDeliveries = allDeliveries.filter(
      (d) => d && !finishedStatuses.includes(d.status)
    );

    if (remainingDeliveries.length === 0) {
      return Response.json({ message: 'No remaining deliveries to update', updated: [] });
    }

    // Sort by stop_order to cascade ETAs in sequence
    remainingDeliveries.sort((a, b) => (Number(a.stop_order) || 999999) - (Number(b.stop_order) || 999999));

    const updates = [];
    let cumulativeMinutes = completionMinutes;

    for (const delivery of remainingDeliveries) {
      // Add estimated travel/service time for this stop
      const estimatedDuration = Number(delivery.estimated_duration_minutes) || 5;
      cumulativeMinutes += estimatedDuration;

      // Snap to window start if applicable
      const windowStart = delivery.delivery_time_start || delivery.time_window_start;
      const windowStartMinutes = parseTimeToMinutes(windowStart);
      if (Number.isFinite(windowStartMinutes) && cumulativeMinutes < windowStartMinutes) {
        cumulativeMinutes = windowStartMinutes;
      }

      const newETA = formatMinutesToTime(cumulativeMinutes);

      updates.push({
        id: delivery.id,
        delivery_time_eta: newETA
      });

      console.log(`  ✅ [recalculateRemainingETAs] ${delivery.patient_name || 'Pickup'} - Updated ETA: ${newETA}`);

      // Add service time before moving to next stop
      cumulativeMinutes += delivery.extra_time || (delivery.patient_id ? 5 : 15);
    }

    // Batch update all deliveries
    await Promise.all(
      updates.map(({ id, delivery_time_eta }) =>
        base44.asServiceRole.entities.Delivery.update(id, { delivery_time_eta }).catch(() => {})
      )
    );

    console.log(`✅ [recalculateRemainingETAs] Updated ${updates.length} remaining stops with cascading ETAs`);

    return Response.json({
      success: true,
      driverId,
      deliveryDate,
      updated: updates.length,
      updates
    });

  } catch (error) {
    console.error('❌ [recalculateRemainingETAs] ERROR:', error.message);
    return Response.json({
      error: error.message,
      stack: error.stack
    }, { status: 500 });
  }
});