import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

/**
 * Recalculates correct stop_order for ALL deliveries (including cycling markers).
 * Sort: finished stops (by actual_delivery_time) → active stops (by ETA, then stop_order) → pending stops (by stop_order)
 * Writes only the stops whose stop_order actually changed. Returns repaired deliveries for client-side merge.
 */
function buildStopOrderRepairs(deliveries) {
  const getCompletionTime = (delivery) => {
    if (!delivery) return Number.MAX_SAFE_INTEGER;
    if (delivery.actual_delivery_time) {
      const t = new Date(delivery.actual_delivery_time).getTime();
      if (Number.isFinite(t)) return t;
    }
    const fallback = delivery.arrival_time || delivery.updated_date || delivery.created_date;
    if (fallback) {
      const t = new Date(fallback).getTime();
      if (Number.isFinite(t)) return t;
    }
    return Number.MAX_SAFE_INTEGER;
  };

  const getStopOrder = (delivery) => {
    const v = Number(delivery?.stop_order);
    return Number.isFinite(v) && v > 0 ? v : Number.MAX_SAFE_INTEGER;
  };

  const getEta = (delivery) => delivery?.delivery_time_eta || delivery?.delivery_time_start || '99:99';

  const sorted = [...(deliveries || [])].sort((a, b) => {
    const aFinished = FINISHED_STATUSES.has(a?.status);
    const bFinished = FINISHED_STATUSES.has(b?.status);

    if (aFinished && !bFinished) return -1;
    if (!aFinished && bFinished) return 1;

    if (aFinished && bFinished) {
      const timeDiff = getCompletionTime(a) - getCompletionTime(b);
      if (timeDiff !== 0) return timeDiff;
      return getStopOrder(a) - getStopOrder(b);
    }

    const aPending = a?.status === 'pending';
    const bPending = b?.status === 'pending';
    if (aPending && !bPending) return 1;
    if (!aPending && bPending) return -1;

    const aEta = getEta(a);
    const bEta = getEta(b);
    if (aEta !== bEta) return aEta.localeCompare(bEta);

    return getStopOrder(a) - getStopOrder(b);
  });

  return sorted
    .map((delivery, index) => ({ delivery, newOrder: index + 1 }))
    .filter(({ delivery, newOrder }) => Number(delivery?.stop_order) !== newOrder)
    .map(({ delivery, newOrder }) => ({ id: delivery.id, stop_order: newOrder }));
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Soft auth: proceed if no user context (for fire-and-forget calls), validate if present
    let user = null;
    try { user = await base44.auth.me(); } catch (_) {}

    const body = await req.json().catch(() => ({}));
    const { driverId, deliveryDate } = body;

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required fields: driverId, deliveryDate' }, { status: 400 });
    }

    // Fetch ALL deliveries for this driver/date (includes cycling markers)
    const routeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 5000);

    if (!routeDeliveries || routeDeliveries.length === 0) {
      return Response.json({ success: true, repairs: 0, repairedDeliveries: [] });
    }

    // Build and apply stop_order repairs
    const stopOrderRepairs = buildStopOrderRepairs(routeDeliveries);

    if (stopOrderRepairs.length > 0) {
      console.log(`[repairStopOrders] Repairing ${stopOrderRepairs.length} stop(s) | driver=${driverId} | date=${deliveryDate}`);
      await Promise.all(
        stopOrderRepairs.map(({ id, stop_order }) =>
          base44.asServiceRole.entities.Delivery.update(id, { stop_order }).catch((error) => {
            if (!isNotFoundError(error)) {
              console.warn(`[repairStopOrders] Repair failed for ${id}:`, error?.message || error);
            }
            return null;
          })
        )
      );
    }

    // Return the repaired deliveries (with new stop_orders applied) for client-side IDB merge
    const repairedDeliveries = routeDeliveries.map((d) => {
      const repair = stopOrderRepairs.find((r) => r.id === d.id);
      return repair ? { ...d, stop_order: repair.stop_order } : d;
    });

    return Response.json({
      success: true,
      repairs: stopOrderRepairs.length,
      repairedDeliveries
    });
  } catch (error) {
    console.error('[repairStopOrders] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
